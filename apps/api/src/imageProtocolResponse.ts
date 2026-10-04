import { createHash } from "node:crypto";
import { ImageExecutionRequestSchema, ImageProviderOutcomeSchema, type ImageExecutionRequest, type ProductionImageExecutionRequest, type ImageProviderOutcome } from "@canvas/contracts";

export const MAX_IMAGE_PROTOCOL_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PROTOCOL_OUTPUT_BYTES = 20 * 1024 * 1024;
export type ImageProtocolResponse = { status: number; contentType: string; requestId?: string; body: Buffer };
export type ImageCandidate = { body: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp"; checksumSha256: string };
export type ParsedImageProtocolResponse = { outcome: ImageProviderOutcome; candidate?: ImageCandidate };

export function imageProtocolOutcome(request: ImageExecutionRequest | ProductionImageExecutionRequest, fingerprint: string, extra: Partial<ImageProviderOutcome>): ImageProviderOutcome {
  return ImageProviderOutcomeSchema.parse({ schemaVersion: 1, tenantId: request.tenantId, projectId: request.projectId, jobId: request.jobId,
    connectionId: request.connectionId, requestFingerprint: fingerprint, providerStatus: "unknown", artifactStatus: "absent", usage: { source: "unavailable" }, billing: { state: "unknown" }, ...extra });
}
export function unknownImageResponse(request: ImageExecutionRequest, fingerprint: string, failureCode: string): ParsedImageProtocolResponse {
  return { outcome: imageProtocolOutcome(ImageExecutionRequestSchema.parse(request), fingerprint, { failureCode }) };
}

// Only candidate bytes. Full bounded decoding / dimensions / asset registration
// must still succeed in the authoritative asset layer, not in a protocol parser.
export function decodeImageCandidate(encoded: string, format: ImageExecutionRequest["parameters"]["outputFormat"]): { candidate: ImageCandidate } | { failureCode: string } {
  if (encoded.length > 4 * Math.ceil(MAX_IMAGE_PROTOCOL_OUTPUT_BYTES / 3)) return { failureCode: "image_output_too_large" };
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return { failureCode: "image_base64_invalid" };
  const body = Buffer.from(encoded, "base64");
  if (body.byteLength > MAX_IMAGE_PROTOCOL_OUTPUT_BYTES || body.toString("base64") !== encoded) return { failureCode: "image_base64_invalid" };
  const magic = format === "png" ? body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : format === "jpeg" ? body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
      : body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP";
  if (!magic) return { failureCode: "image_output_magic_invalid" };
  return { candidate: { body, mimeType: `image/${format}`, checksumSha256: createHash("sha256").update(body).digest("hex") } };
}
