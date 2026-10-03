import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  ImageExecutionRequestSchema, ImageProviderOutcomeSchema, ImageUsageSchema,
  type ImageExecutionRequest, type ImageProviderConnection, type ImageProviderOutcome,
} from "@canvas/contracts";
import { ImageProviderContractError, validateImageProviderRequest } from "./imageProviderContract";
import { encodeImageJson, imagePayloadSha256, prepareImagePayloadParts, type ImageInputTransform, type TrustedImageBytes } from "./imageRequestPayload";
export { MAX_IMAGE_PROTOCOL_REQUEST_BYTES } from "./imageRequestPayload";
export type { TrustedImageBytes } from "./imageRequestPayload";

export const MAX_IMAGE_PROTOCOL_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PROTOCOL_OUTPUT_BYTES = 20 * 1024 * 1024;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
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
  const request = validated.request;
  if (validated.connection.protocol !== "openai") reject("image_protocol_mismatch");
  const capability = validated.connection.models.find((model) => model.model === request.model)!;
  if (request.operation === "edit" && request.inputs.length > 16) reject("image_input_count_exceeded");
  const parts = await prepareImagePayloadParts(request, capability, trustedImages, "transparent-edit");
  const body = encodeImageJson(parts);
  return { method: "POST", path: request.operation === "generate" ? "/images/generations" : "/images/edits", contentType: "application/json", body,
    requestFingerprint: validated.fingerprint, payloadChecksumSha256: imagePayloadSha256(body), transformedInputs: parts.transformedInputs };
}

export type ImageProtocolResponse = { status: number; contentType: string; requestId?: string; body: Buffer };
export type ParsedImageProtocolResponse = { outcome: ImageProviderOutcome; candidate?: { body: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp"; checksumSha256: string } };

function outcome(request: ImageExecutionRequest, fingerprint: string, extra: Partial<ImageProviderOutcome>): ImageProviderOutcome {
  return ImageProviderOutcomeSchema.parse({ schemaVersion: 1, tenantId: request.tenantId, projectId: request.projectId, jobId: request.jobId,
    connectionId: request.connectionId, requestFingerprint: fingerprint, providerStatus: "unknown", artifactStatus: "absent", usage: { source: "unavailable" }, billing: { state: "unknown" }, ...extra });
}
export function unknownImageResponse(request: ImageExecutionRequest, fingerprint: string, failureCode: string): ParsedImageProtocolResponse {
  return { outcome: outcome(ImageExecutionRequestSchema.parse(request), fingerprint, { failureCode }) };
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const safeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// The response is untrusted. Unknown additive metadata is ignored, but known
// image/usage fields are checked. URLs are never fetched or treated as artifacts.
export function parseOpenAiImageResponse(input: ImageExecutionRequest, fingerprint: string, response: ImageProtocolResponse): ParsedImageProtocolResponse {
  const request = ImageExecutionRequestSchema.parse(input);
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
  if (encoded.length > 4 * Math.ceil(MAX_IMAGE_PROTOCOL_OUTPUT_BYTES / 3)) return failed("image_output_too_large", "returned", "invalid");
  // No nested repeating regexp over multi-megabyte untrusted strings.
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return failed("image_base64_invalid", "returned", "invalid");
  const body = Buffer.from(encoded, "base64");
  if (body.byteLength > MAX_IMAGE_PROTOCOL_OUTPUT_BYTES || body.toString("base64") !== encoded) return failed("image_base64_invalid", "returned", "invalid");
  const format = request.parameters.outputFormat;
  if (json.output_format !== undefined && json.output_format !== format) return failed("image_output_format_changed", "returned", "invalid");
  const magic = format === "png" ? body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : format === "jpeg" ? body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
      : body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP";
  if (!magic) return failed("image_output_magic_invalid", "returned", "invalid");
  return { outcome: outcome(request, fingerprint, { ...extra, providerStatus: "returned", artifactStatus: "pending-validation" }),
    candidate: { body, mimeType: `image/${format}`, checksumSha256: sha256(body) } };
}
