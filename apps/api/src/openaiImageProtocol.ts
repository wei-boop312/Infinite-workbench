import { TextDecoder } from "node:util";
import { validateLockedProtocolRequest } from "./lockedProductionImageRequest";
import {
  ImageExecutionRequestSchema, ProductionImageExecutionRequestSchema, ProductionImageTaskIdentitySchema, ImageProviderConnectionSchema, ImageUsageSchema,
  type ImageExecutionRequest, type ProductionImageExecutionRequest, type ImageProviderConnection, type ImageProviderOutcome,
} from "@canvas/contracts";
import { ImageProviderContractError, imageSnapshotFingerprint, validateImageProviderRequest, validateProductionImageProviderRequest } from "./imageProviderContract";
import { encodeImageJson, imagePayloadSha256, prepareImagePayloadParts, type ImageInputTransform, type TrustedImageBytes } from "./imageRequestPayload";
export { MAX_IMAGE_PROTOCOL_REQUEST_BYTES } from "./imageRequestPayload";
export type { TrustedImageBytes } from "./imageRequestPayload";
import { decodeImageCandidate, imageProtocolOutcome as outcome, MAX_IMAGE_PROTOCOL_RESPONSE_BYTES, type ImageProtocolResponse, type ParsedImageProtocolResponse } from "./imageProtocolResponse";
export { MAX_IMAGE_PROTOCOL_RESPONSE_BYTES, MAX_IMAGE_PROTOCOL_OUTPUT_BYTES, unknownImageResponse } from "./imageProtocolResponse";
export type { ImageProtocolResponse, ParsedImageProtocolResponse } from "./imageProtocolResponse";
function reject(code: string): never { throw new ImageProviderContractError(code); }

export type PreparedImageProtocolRequest = {
  method: "POST";
  path: "/images/generations" | "/images/edits";
  contentType: "application/json";
  body: Buffer;
  requestFingerprint: string;
  payloadChecksumSha256: string;
  transformedInputs: ImageInputTransform[];
};

// Pure preparation: no endpoint lookup, authorization header, secret or transport.
// Bytes and receipts must be loaded by the trusted server asset service.
export async function prepareOpenAiImageRequest(connection: ImageProviderConnection, input: ImageExecutionRequest, trustedImages: readonly TrustedImageBytes[], now: string): Promise<PreparedImageProtocolRequest> {
  const validated = validateImageProviderRequest(connection, input, now);
  return buildOpenAiImageRequest(validated, trustedImages);
}
export async function prepareProductionOpenAiImageRequest(connection: ImageProviderConnection, input: ProductionImageExecutionRequest, trustedImages: readonly TrustedImageBytes[], now: string): Promise<PreparedImageProtocolRequest> {
  return buildOpenAiImageRequest(validateProductionImageProviderRequest(connection, input, now), trustedImages);
}
export async function prepareLockedProductionOpenAiImageRequest(connection: ImageProviderConnection, input: unknown, trustedImages: readonly TrustedImageBytes[], now: string): Promise<PreparedImageProtocolRequest> {
  return buildOpenAiImageRequest(validateLockedProtocolRequest(connection, input, now), trustedImages);
}
async function buildOpenAiImageRequest(validated: { connection: ImageProviderConnection; request: ImageExecutionRequest | ProductionImageExecutionRequest; fingerprint: string }, trustedImages: readonly TrustedImageBytes[]): Promise<PreparedImageProtocolRequest> {
  const request = validated.request;
  if (validated.connection.protocol !== "openai") reject("image_protocol_mismatch");
  const capability = validated.connection.models.find((model) => model.model === request.model)!;
  if (request.operation === "edit" && request.inputs.length > 16) reject("image_input_count_exceeded");
  const parts = await prepareImagePayloadParts(request, capability, trustedImages, "transparent-edit");
  const body = encodeImageJson(parts);
  return { method: "POST", path: request.operation === "generate" ? "/images/generations" : "/images/edits", contentType: "application/json", body,
    requestFingerprint: validated.fingerprint, payloadChecksumSha256: imagePayloadSha256(body), transformedInputs: parts.transformedInputs };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const safeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// The response is untrusted. Unknown additive metadata is ignored, but known
// image/usage fields are checked. URLs are never fetched or treated as artifacts.
export function parseOpenAiImageResponse(input: ImageExecutionRequest, fingerprint: string, response: ImageProtocolResponse): ParsedImageProtocolResponse {
  return parseResponse(ImageExecutionRequestSchema.parse(input), fingerprint, response);
}
// Separate validation entrance; never fabricate an estimate for legacy parsing.
// Syntax and a matching digest are not actual task/send authorization.
export function parseProductionOpenAiImageResponse(input: ProductionImageExecutionRequest, fingerprint: string, response: ImageProtocolResponse, connection: ImageProviderConnection): ParsedImageProtocolResponse {
  const request = ProductionImageExecutionRequestSchema.parse(input);
  ProductionImageTaskIdentitySchema.parse({ jobId: request.jobId, idempotencyKey: request.idempotencyKey });
  if (imageSnapshotFingerprint({ connection: ImageProviderConnectionSchema.parse(connection), request }) !== fingerprint) reject("production_image_response_request_changed");
  return parseResponse(request, fingerprint, response);
}
function parseResponse(request: ImageExecutionRequest | ProductionImageExecutionRequest, fingerprint: string, response: ImageProtocolResponse): ParsedImageProtocolResponse {
  const extra: Partial<ImageProviderOutcome> = {};
  if (response.requestId && /^[A-Za-z0-9_.:-]{1,160}$/.test(response.requestId)) extra.providerRequestId = response.requestId;
  const failed = (failureCode: string, providerStatus: ImageProviderOutcome["providerStatus"] = "unknown", artifactStatus: ImageProviderOutcome["artifactStatus"] = "absent") => ({ outcome: outcome(request, fingerprint, { ...extra, failureCode, providerStatus, artifactStatus }) });
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) return failed("image_http_status_invalid");
  if (response.body.byteLength > MAX_IMAGE_PROTOCOL_RESPONSE_BYTES) return failed("image_response_too_large");
  if (response.status >= 300) return failed("image_provider_http_error", "rejected");
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.contentType)) return failed("image_response_content_type_invalid");
  let json: unknown;
  try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)); }
  catch { return failed("image_response_json_invalid"); }
  if (!record(json) || !safeInt(json.created) || !Array.isArray(json.data) || json.data.length !== 1 || !record(json.data[0])) return failed("image_response_shape_invalid");
  let usage: ImageProviderOutcome["usage"] = { source: "unavailable" };
  if (json.usage !== undefined) {
    if (!record(json.usage) || !safeInt(json.usage.input_tokens) || !safeInt(json.usage.output_tokens) || !safeInt(json.usage.total_tokens)
      || json.usage.input_tokens + json.usage.output_tokens !== json.usage.total_tokens) return failed("image_usage_invalid", "returned");
    for (const field of ["input_tokens_details", "output_tokens_details"] as const) {
      const details = json.usage[field];
      if (details !== undefined && (!record(details) || !safeInt(details.image_tokens) || !safeInt(details.text_tokens)
        || details.image_tokens + details.text_tokens !== json.usage[field === "input_tokens_details" ? "input_tokens" : "output_tokens"])) return failed("image_usage_invalid", "returned");
    }
    usage = ImageUsageSchema.parse({ source: "provider-reported", metrics: { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens, totalTokens: json.usage.total_tokens } });
  }
  extra.usage = usage;
  const encoded = json.data[0].b64_json;
  if (typeof encoded !== "string" || !encoded.length) return failed("image_base64_required", "returned");
  const format = request.parameters.outputFormat;
  if (json.output_format !== undefined && json.output_format !== format) return failed("image_output_format_changed", "returned", "invalid");
  const decoded = decodeImageCandidate(encoded, format);
  if ("failureCode" in decoded) return failed(decoded.failureCode, "returned", "invalid");
  return { outcome: outcome(request, fingerprint, { ...extra, providerStatus: "returned", artifactStatus: "pending-validation" }),
    candidate: decoded.candidate };
}
