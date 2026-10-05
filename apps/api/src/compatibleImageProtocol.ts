import type { ImageExecutionRequest, ProductionImageExecutionRequest, ImageProviderConnection } from "@canvas/contracts";
import { validateLockedProtocolRequest } from "./lockedProductionImageRequest";
import { ImageProviderContractError, validateImageProviderRequest, validateProductionImageProviderRequest } from "./imageProviderContract";
import { MAX_IMAGE_PROTOCOL_REQUEST_BYTES, encodeImageJson, imagePayloadSha256, prepareImagePayloadParts,
  type ImageInputTransform, type ImagePayloadParts, type TrustedImageBytes } from "./imageRequestPayload";
import { parseOpenAiImageResponse, parseProductionOpenAiImageResponse, type ImageProtocolResponse } from "./openaiImageProtocol";

function reject(code: string): never { throw new ImageProviderContractError(code); }
export type CompatibleImagePreparedRequest = {
  method: "POST"; endpointUrl: string; contentType: string; body: Buffer;
  requestFingerprint: string; payloadChecksumSha256: string; transformedInputs: ImageInputTransform[];
  // This is an opaque plan, NOT an authorization header or resolved credential.
  authPlan: { scheme: "bearer"; credentialRef: string } | { scheme: "header"; headerName: "x-api-key" | "api-key" | "x-access-token"; credentialRef: string };
};
function compatibleImageEndpoint(baseUrl: string, path: string): string {
  // Called after schema validation. URL assembly preserves the API root instead
  // of treating a leading slash as a replacement path or appending after '?'/'#'.
  const url = new URL(baseUrl);
  url.search = ""; url.hash = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  return url.toString();
}

function encodeMultipart(parts: ImagePayloadParts, encoding: "multipart-image-array" | "multipart-image-single", extra: Record<string, string | number | boolean>, fingerprint: string) {
  if (encoding === "multipart-image-single" && parts.images.length !== 1) reject("image_single_input_required");
  const boundary = `canvas-${fingerprint.slice(0, 40)}`;
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const chunks: Buffer[] = []; let total = 0;
  function append(value: Buffer | string) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    total += bytes.byteLength;
    if (total > MAX_IMAGE_PROTOCOL_REQUEST_BYTES) reject("image_request_too_large");
    chunks.push(bytes);
  }
  for (const [name, value] of Object.entries({ ...parts.fields, ...extra })) {
    const text = String(value);
    if (text.includes(`\r\n--${boundary}`)) reject("image_multipart_boundary_collision");
    append(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${text}\r\n`);
  }
  function file(name: string, body: Buffer, filename: string) {
    if (body.includes(delimiter)) reject("image_multipart_boundary_collision");
    append(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`);
    append(body); append("\r\n");
  }
  parts.images.forEach((image, index) => file(encoding === "multipart-image-array" ? "image[]" : "image", image.body, `input-${index + 1}.png`));
  if (parts.mask) file("mask", parts.mask.body, "mask.png");
  append(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks, total), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Pure preparation: no fetch/SDK/secret lookup, and never relaxes the real gate.
export async function prepareCompatibleImageRequest(connection: ImageProviderConnection, input: ImageExecutionRequest, trustedImages: readonly TrustedImageBytes[], now: string): Promise<CompatibleImagePreparedRequest> {
  const validated = validateImageProviderRequest(connection, input, now);
  return buildCompatibleImageRequest(validated, trustedImages);
}
export async function prepareProductionCompatibleImageRequest(connection: ImageProviderConnection, input: ProductionImageExecutionRequest, trustedImages: readonly TrustedImageBytes[], now: string): Promise<CompatibleImagePreparedRequest> {
  return buildCompatibleImageRequest(validateProductionImageProviderRequest(connection, input, now), trustedImages);
}
export async function prepareLockedProductionCompatibleImageRequest(connection: ImageProviderConnection, input: unknown, trustedImages: readonly TrustedImageBytes[], now: string): Promise<CompatibleImagePreparedRequest> {
  return buildCompatibleImageRequest(validateLockedProtocolRequest(connection, input, now), trustedImages);
}
async function buildCompatibleImageRequest(validated: { connection: ImageProviderConnection; request: ImageExecutionRequest | ProductionImageExecutionRequest; fingerprint: string }, trustedImages: readonly TrustedImageBytes[]): Promise<CompatibleImagePreparedRequest> {
  const config = validated.connection; const request = validated.request;
  if (config.protocol !== "openai-compatible") reject("image_protocol_mismatch");
  const profile = config.compatibility;
  if (!profile) reject("image_compatibility_not_configured");
  if (request.operation === "edit" && profile.editEncoding === "multipart-image-single" && request.inputs.length !== 1) reject("image_single_input_required");
  const capability = config.models.find((model) => model.model === request.model)!;
  const parts = await prepareImagePayloadParts(request, capability, trustedImages, "declared");
  const extra = request.providerParameters ?? {};
  const encoded = request.operation === "generate" || profile.editEncoding === "json-images"
    ? { body: encodeImageJson(parts, extra), contentType: "application/json" }
    : encodeMultipart(parts, profile.editEncoding, extra, validated.fingerprint);
  return { method: "POST", endpointUrl: compatibleImageEndpoint(config.baseUrl, profile.endpoints[request.operation]), ...encoded,
    requestFingerprint: validated.fingerprint, payloadChecksumSha256: imagePayloadSha256(encoded.body), transformedInputs: parts.transformedInputs,
    authPlan: { ...profile.auth, credentialRef: config.credentialRef } };
}

export function parseCompatibleImageResponse(input: ImageExecutionRequest, fingerprint: string, response: ImageProtocolResponse) {
  // Exactly one declared response shape in this milestone. Non-compatible async
  // task/URL/custom billing envelopes need a separate adapter, never a best guess.
  return parseOpenAiImageResponse(input, fingerprint, response);
}
export function parseProductionCompatibleImageResponse(input: ProductionImageExecutionRequest, fingerprint: string, response: ImageProtocolResponse, connection: ImageProviderConnection) {
  return parseProductionOpenAiImageResponse(input, fingerprint, response, connection);
}
