import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import sharp from "sharp";
import {
  ImageExecutionRequestSchema, ImageProviderOutcomeSchema, ImageUsageSchema,
  type ImageExecutionRequest, type ImageProviderConnection, type ImageProviderOutcome, type VerifiedImage,
} from "@canvas/contracts";
import { ImageProviderContractError, validateImageProviderInputs, validateImageProviderRequest } from "./imageProviderContract";

export const MAX_IMAGE_PROTOCOL_REQUEST_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_PROTOCOL_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PROTOCOL_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_REFERENCE_CHARACTERS = 20 * 1024 * 1024;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function reject(code: string): never { throw new ImageProviderContractError(code); }

export type TrustedImageBytes = { receipt: VerifiedImage; body: Buffer };
export type PreparedImageProtocolRequest = {
  method: "POST";
  path: "/images/generations" | "/images/edits";
  contentType: "application/json";
  body: Buffer;
  requestFingerprint: string;
  payloadChecksumSha256: string;
  transformedInputs: Array<{ assetId: string; originalChecksumSha256: string; transmittedChecksumSha256: string; transform: "exif-srgb-png-v1" | "internal-white-to-transparent-mask-v1" }>;
};

async function normalizedPixels(body: Buffer, width: number, height: number) {
  try {
    const decoded = await sharp(body, { failOn: "warning", limitInputPixels: 16_000_000 })
      .timeout({ seconds: 5 }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== width || decoded.info.height !== height || decoded.info.channels !== 4) reject("image_normalized_dimensions_changed");
    return decoded;
  } catch (error) {
    if (error instanceof ImageProviderContractError) throw error;
    return reject("image_input_decode_failed");
  }
}
function reference(body: Buffer): { image_url: string } {
  if (body.byteLength > MAX_IMAGE_PROTOCOL_OUTPUT_BYTES || 4 * Math.ceil(body.byteLength / 3) + 22 > MAX_IMAGE_REFERENCE_CHARACTERS) reject("image_reference_too_large");
  return { image_url: `data:image/png;base64,${body.toString("base64")}` };
}

// Pure preparation: no endpoint lookup, authorization header, secret or transport.
// Bytes and receipts must be loaded by the trusted server asset service.
export async function prepareOpenAiImageRequest(connection: ImageProviderConnection, input: ImageExecutionRequest, trustedImages: readonly TrustedImageBytes[], now: string): Promise<PreparedImageProtocolRequest> {
  const validated = validateImageProviderRequest(connection, input, now);
  const request = validated.request;
  if (validated.connection.protocol !== "openai") reject("image_protocol_mismatch");
  const capability = validated.connection.models.find((model) => model.model === request.model)!;
  if (request.operation === "edit" && request.inputs.length > 16) reject("image_input_count_exceeded");
  validateImageProviderInputs(request, trustedImages.map((image) => image.receipt));
  const params = request.parameters;
  const wire: Record<string, unknown> = {
    model: request.model, prompt: params.prompt, n: 1,
    size: params.size === "auto" ? "auto" : `${params.size.width}x${params.size.height}`,
    quality: params.quality, output_format: params.outputFormat, background: params.background,
  };
  if (params.inputFidelity !== undefined) wire.input_fidelity = params.inputFidelity;
  if (params.outputCompression !== undefined) wire.output_compression = params.outputCompression;
  const transformedInputs: PreparedImageProtocolRequest["transformedInputs"] = [];
  if (request.operation === "edit") {
    if (!capability.inputMimeTypes.includes("image/png")) reject("image_normalization_format_unsupported");
    let transformedBytes = 0;
    let referenceCharacters = Buffer.byteLength(JSON.stringify(wire), "utf8") + 4096;
    async function normalize(assetId: string, mask = false) {
      const image = trustedImages.find((item) => item.receipt.tenantId === request.tenantId && item.receipt.asset.projectId === request.projectId && item.receipt.asset.id === assetId);
      if (!image) return reject("image_input_not_verified");
      const originalChecksumSha256 = sha256(image.body);
      if (image.body.byteLength !== image.receipt.asset.byteSize || originalChecksumSha256 !== image.receipt.checksumSha256) reject("image_input_bytes_changed");
      const pixels = await normalizedPixels(image.body, image.receipt.asset.width, image.receipt.asset.height);
      if (mask) {
        if (capability.mask.polarity !== "transparent-edit") reject("image_mask_conversion_unsupported");
        // Canvas: white with alpha>0 means editable. Preserve antialiased coverage
        // by inverting alpha; locked transparent pixels become fully opaque.
        for (let index = 0; index < pixels.data.length; index += 4) {
          if (pixels.data[index + 3] > 0 && (pixels.data[index] !== 255 || pixels.data[index + 1] !== 255 || pixels.data[index + 2] !== 255)) reject("image_internal_mask_invalid");
          pixels.data[index] = 0; pixels.data[index + 1] = 0; pixels.data[index + 2] = 0;
          pixels.data[index + 3] = 255 - pixels.data[index + 3];
        }
      }
      const body = await sharp(pixels.data, { raw: { width: pixels.info.width, height: pixels.info.height, channels: 4 } }).timeout({ seconds: 5 }).png().toBuffer();
      if (body.byteLength > capability.maxInputBytes) reject("image_transformed_bytes_exceeded");
      transformedBytes += body.byteLength;
      if (transformedBytes > capability.maxTotalInputBytes) reject("image_transformed_total_bytes_exceeded");
      referenceCharacters += 4 * Math.ceil(body.byteLength / 3) + 128;
      if (referenceCharacters > MAX_IMAGE_PROTOCOL_REQUEST_BYTES) reject("image_request_too_large");
      transformedInputs.push({ assetId, originalChecksumSha256, transmittedChecksumSha256: sha256(body), transform: mask ? "internal-white-to-transparent-mask-v1" : "exif-srgb-png-v1" });
      return reference(body);
    }
    const normalized: Awaited<ReturnType<typeof normalize>>[] = [];
    // Sequential decoding bounds per-request native memory; worker-level limits
    // must still be added before actual dispatch is enabled.
    for (const image of request.inputs) normalized.push(await normalize(image.assetId));
    wire.images = normalized;
    if (request.mask) {
      wire.mask = await normalize(request.mask.assetId, true);
    }
  }
  const body = Buffer.from(JSON.stringify(wire), "utf8");
  if (body.byteLength > MAX_IMAGE_PROTOCOL_REQUEST_BYTES) reject("image_request_too_large");
  return { method: "POST", path: request.operation === "generate" ? "/images/generations" : "/images/edits", contentType: "application/json", body,
    requestFingerprint: validated.fingerprint, payloadChecksumSha256: sha256(body), transformedInputs };
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
