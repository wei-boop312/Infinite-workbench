import { TextDecoder } from "node:util";
import { ImageExecutionRequestSchema, ImageUsageSchema, type GoogleImageProfile, type ImageExecutionRequest, type ProductionImageExecutionRequest, type ImageProviderConnection, type ImageProviderOutcome } from "@canvas/contracts";
import { ImageProviderContractError, validateImageProviderRequest, validateProductionImageProviderRequest } from "./imageProviderContract";
import { imagePayloadSha256, prepareImagePayloadParts, type ImageInputTransform, type ImagePayloadParts, type TrustedImageBytes } from "./imageRequestPayload";
import { decodeImageCandidate, imageProtocolOutcome, MAX_IMAGE_PROTOCOL_RESPONSE_BYTES, type ImageProtocolResponse, type ParsedImageProtocolResponse } from "./imageProtocolResponse";

// Conservative inline-only ceiling (including text / base64 / JSON overhead).
// File uploads, Interactions, tools, multi-turn history and remote URIs are absent.
export const MAX_GOOGLE_IMAGE_REQUEST_BYTES = 20_000_000;
const aspectRatio = { "1:1": "ONE_BY_ONE", "2:3": "TWO_BY_THREE", "3:2": "THREE_BY_TWO", "3:4": "THREE_BY_FOUR", "4:3": "FOUR_BY_THREE",
  "4:5": "FOUR_BY_FIVE", "5:4": "FIVE_BY_FOUR", "9:16": "NINE_BY_SIXTEEN", "16:9": "SIXTEEN_BY_NINE", "21:9": "TWENTY_ONE_BY_NINE",
  "1:4": "ONE_BY_FOUR", "4:1": "FOUR_BY_ONE", "1:8": "ONE_BY_EIGHT", "8:1": "EIGHT_BY_ONE" } as const;
const imageSize = { "512": "FIVE_TWELVE", "1K": "ONE_K", "2K": "TWO_K", "4K": "FOUR_K" } as const;
function reject(code: string): never { throw new ImageProviderContractError(code); }
type SizeMapping = GoogleImageProfile["modelMappings"][number]["sizes"][number];
export type GoogleImagePreparedRequest = {
  method: "POST"; endpointUrl: string; contentType: "application/json"; body: Buffer;
  authPlan: { scheme: "header"; headerName: "x-goog-api-key"; credentialRef: string };
  requestFingerprint: string; payloadChecksumSha256: string; transformedInputs: ImageInputTransform[];
};

export function encodeGoogleImageJson(prompt: string, images: ImagePayloadParts["images"], size?: SizeMapping): Buffer {
  const image: Record<string, string> = { mimeType: "IMAGE_JPEG", delivery: "INLINE" };
  if (size) { image.aspectRatio = `ASPECT_RATIO_${aspectRatio[size.aspectRatio]}`; image.imageSize = `IMAGE_SIZE_${imageSize[size.imageSize]}`; }
  const wire = { contents: [{ role: "user", parts: [{ text: prompt }] as Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], candidateCount: 1, responseFormat: { image } } };
  let bytes = Buffer.byteLength(JSON.stringify(wire), "utf8") + 128;
  if (bytes > MAX_GOOGLE_IMAGE_REQUEST_BYTES) reject("image_request_too_large");
  for (const input of images) {
    bytes += 4 * Math.ceil(input.body.byteLength / 3) + 128;
    if (bytes > MAX_GOOGLE_IMAGE_REQUEST_BYTES) reject("image_request_too_large");
    wire.contents[0].parts.push({ inlineData: { mimeType: "image/png", data: input.body.toString("base64") } });
  }
  const body = Buffer.from(JSON.stringify(wire), "utf8");
  if (body.byteLength > MAX_GOOGLE_IMAGE_REQUEST_BYTES) reject("image_request_too_large");
  return body;
}

// Pure preparation. This does not look up credentials, fetch an endpoint,
// mutate a task/ledger, accept a client's receipt, or enable the real gate.
export async function prepareGoogleImageRequest(connection: ImageProviderConnection, input: ImageExecutionRequest, trustedImages: readonly TrustedImageBytes[], now: string): Promise<GoogleImagePreparedRequest> {
  const validated = validateImageProviderRequest(connection, input, now);
  return buildGoogleImageRequest(validated, trustedImages);
}
export async function prepareProductionGoogleImageRequest(connection: ImageProviderConnection, input: ProductionImageExecutionRequest, trustedImages: readonly TrustedImageBytes[], now: string): Promise<GoogleImagePreparedRequest> {
  return buildGoogleImageRequest(validateProductionImageProviderRequest(connection, input, now), trustedImages);
}
async function buildGoogleImageRequest(validated: { connection: ImageProviderConnection; request: ImageExecutionRequest | ProductionImageExecutionRequest; fingerprint: string }, trustedImages: readonly TrustedImageBytes[]): Promise<GoogleImagePreparedRequest> {
  const request = validated.request;
  if (validated.connection.protocol !== "google") reject("image_protocol_mismatch");
  const profile = validated.connection.googleNative;
  if (!profile) reject("google_image_profile_not_configured");
  // This adapter is Google AI's documented origin, not Vertex or a guessed relay.
  const url = new URL(validated.connection.baseUrl);
  if (url.origin !== "https://generativelanguage.googleapis.com" || url.pathname !== "/") reject("google_image_endpoint_unsupported");
  const mapping = profile.modelMappings.find((model) => model.model === request.model);
  if (!mapping) reject("google_image_model_mapping_missing");
  const capability = validated.connection.models.find((model) => model.model === request.model)!;
  if (capability.mask.mode !== "none") reject("google_image_mask_not_supported");
  // Never discard unsupported fields even if a stale/incorrect capability says yes.
  if (capability.outputFormats.some((format) => format !== "jpeg") || capability.qualities.some((quality) => quality !== "auto")
    || capability.backgrounds.some((background) => background !== "auto") || capability.inputFidelities.length || capability.supportsOutputCompression
    || capability.maxInputImages > 14 || capability.sizes.custom) reject("google_image_capability_not_supported");
  if (capability.sizes.presets.length !== mapping.sizes.length || capability.sizes.presets.some((size) => !mapping.sizes.some((item) => item.width === size.width && item.height === size.height))) reject("google_image_size_mapping_inconsistent");
  const size = request.parameters.size;
  const mapped = size === "auto" ? undefined : mapping.sizes.find((item) => item.width === size.width && item.height === size.height);
  if (size !== "auto" && !mapped) reject("google_image_size_unmapped");
  const parts = await prepareImagePayloadParts(request, capability, trustedImages, "declared");
  const body = encodeGoogleImageJson(request.parameters.prompt, parts.images, mapped);
  return { method: "POST", endpointUrl: `${url.origin}/${profile.apiVersion}/models/${mapping.model}:generateContent`, contentType: "application/json", body,
    authPlan: { scheme: "header", headerName: "x-goog-api-key", credentialRef: validated.connection.credentialRef },
    requestFingerprint: validated.fingerprint, payloadChecksumSha256: imagePayloadSha256(body), transformedInputs: parts.transformedInputs };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const safeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const requestId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
function googleUsage(raw: unknown): ImageProviderOutcome["usage"] | undefined {
  if (raw === undefined) return { source: "unavailable" };
  if (!record(raw)) return undefined;
  const fields = { promptTokenCount: "inputTokens", candidatesTokenCount: "outputTokens", thoughtsTokenCount: "reasoningTokens",
    cachedContentTokenCount: "cachedInputTokens", toolUsePromptTokenCount: "toolInputTokens", totalTokenCount: "totalTokens" } as const;
  const metrics: Record<string, number> = {};
  for (const [field, normalized] of Object.entries(fields)) {
    const value = raw[field];
    if (value !== undefined) { if (!safeInt(value)) return undefined; metrics[normalized] = value; }
  }
  if (!Object.keys(metrics).length) return undefined;
  // Missing fields remain missing; no fabricated zero, no token-price conversion.
  const sum = (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0) + (metrics.reasoningTokens ?? 0);
  if (!Number.isSafeInteger(sum) || (metrics.totalTokens !== undefined && sum > metrics.totalTokens)
    || (metrics.cachedInputTokens !== undefined && metrics.inputTokens !== undefined && metrics.cachedInputTokens > metrics.inputTokens)
    || (metrics.totalTokens !== undefined && metrics.inputTokens !== undefined && metrics.outputTokens !== undefined && metrics.reasoningTokens !== undefined
      && (metrics.toolInputTokens ?? 0) === 0 && sum !== metrics.totalTokens)) return undefined;
  return ImageUsageSchema.parse({ source: "provider-reported", metrics });
}

// Native envelope: candidates/content/parts, NOT a synthetic OpenAI data[].
// Text, thoughts, signatures, errors and URLs never enter an asset or audit body.
export function parseGoogleImageResponse(input: ImageExecutionRequest, fingerprint: string, response: ImageProtocolResponse): ParsedImageProtocolResponse {
  const request = ImageExecutionRequestSchema.parse(input);
  const extra: Partial<ImageProviderOutcome> = {};
  if (requestId(response.requestId)) extra.providerRequestId = response.requestId;
  const failed = (failureCode: string, providerStatus: ImageProviderOutcome["providerStatus"] = "unknown", artifactStatus: ImageProviderOutcome["artifactStatus"] = "absent") => ({ outcome: imageProtocolOutcome(request, fingerprint, { ...extra, failureCode, providerStatus, artifactStatus }) });
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) return failed("image_http_status_invalid");
  if (response.body.byteLength > MAX_IMAGE_PROTOCOL_RESPONSE_BYTES) return failed("image_response_too_large");
  if (response.status >= 300) return failed("image_provider_http_error", "rejected");
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.contentType)) return failed("image_response_content_type_invalid");
  let json: unknown;
  try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)); }
  catch { return failed("image_response_json_invalid"); }
  if (!record(json)) return failed("image_response_shape_invalid");
  if (requestId(json.responseId)) extra.providerRequestId = json.responseId;
  const usage = googleUsage(json.usageMetadata);
  if (!usage) return failed("image_usage_invalid", "returned");
  extra.usage = usage;
  if (json.promptFeedback !== undefined) {
    if (!record(json.promptFeedback)) return failed("image_response_shape_invalid");
    const reason = json.promptFeedback.blockReason;
    if (reason !== undefined && reason !== "BLOCK_REASON_UNSPECIFIED") return failed("google_image_prompt_blocked", "rejected");
  }
  if (!Array.isArray(json.candidates) || json.candidates.length !== 1 || !record(json.candidates[0])) return failed("image_response_shape_invalid", "returned");
  const candidate = json.candidates[0];
  if (candidate.finishReason !== "STOP") return failed("google_image_finish_not_complete", "returned");
  if (candidate.safetyRatings !== undefined) {
    if (!Array.isArray(candidate.safetyRatings) || candidate.safetyRatings.length > 32
      || candidate.safetyRatings.some((rating) => !record(rating) || (rating.blocked !== undefined && typeof rating.blocked !== "boolean"))) return failed("image_response_shape_invalid", "returned");
    if (candidate.safetyRatings.some((rating) => rating.blocked === true)) return failed("google_image_candidate_blocked", "rejected");
  }
  if (!record(candidate.content) || (candidate.content.role !== undefined && candidate.content.role !== "model")
    || !Array.isArray(candidate.content.parts) || !candidate.content.parts.length || candidate.content.parts.length > 64) return failed("image_response_shape_invalid", "returned");
  const images: Record<string, unknown>[] = [];
  for (const part of candidate.content.parts) {
    if (!record(part) || (part.thought !== undefined && typeof part.thought !== "boolean")) return failed("google_image_part_invalid", "returned");
    if (part.thought === true) continue;
    const unions = ["text", "inlineData", "fileData", "functionCall", "functionResponse", "executableCode", "codeExecutionResult", "toolCall", "toolResponse"].filter((field) => part[field] !== undefined);
    if (unions.length !== 1) return failed("google_image_part_invalid", "returned");
    if (unions[0] === "text") { if (typeof part.text !== "string") return failed("google_image_part_invalid", "returned"); continue; }
    if (unions[0] !== "inlineData" || !record(part.inlineData)) return failed("google_image_inline_data_required", "returned");
    images.push(part.inlineData);
  }
  // candidateCount=1 is not a guarantee of exactly one image; do not pick a draw.
  if (images.length !== 1) return failed("google_image_output_count_invalid", "returned");
  if (request.parameters.outputFormat !== "jpeg" || images[0].mimeType !== "image/jpeg") return failed("image_output_format_changed", "returned", "invalid");
  const encoded = images[0].data;
  if (typeof encoded !== "string" || !encoded.length) return failed("image_base64_required", "returned");
  const decoded = decodeImageCandidate(encoded, "jpeg");
  if ("failureCode" in decoded) return failed(decoded.failureCode, "returned", "invalid");
  return { outcome: imageProtocolOutcome(request, fingerprint, { ...extra, providerStatus: "returned", artifactStatus: "pending-validation" }), candidate: decoded.candidate };
}
