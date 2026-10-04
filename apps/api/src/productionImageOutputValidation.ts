import { ProductionImageOutputDraftSchema } from "@canvas/contracts";
export { ProductionImageOutputDraftSchema, type ProductionImageOutputDraft } from "@canvas/contracts";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { assertProductionImageAttempt, assertProductionImageRawResponse } from "./productionImageResponse";
import { constraintContentChecksum } from "./imageAssetPolicy";
import { imagePayloadSha256 } from "./imageRequestPayload";
import { MAX_IMAGE_PROTOCOL_OUTPUT_BYTES, MAX_IMAGE_PROTOCOL_RESPONSE_BYTES } from "./imageProtocolResponse";
import { decodeStaticImage, MAX_STATIC_IMAGE_EDGE, MAX_STATIC_IMAGE_PIXELS } from "./staticImageDecoder";
import { RunKernelError } from "./runKernel";

let activeValidations = 0;
function reject(code: string, status = 422): never {
  throw new RunKernelError(status, code, "生产图片未通过完整校验，未提交资产或更改原响应与费用");
}
// Internal validation primitive, NOT a SQLite task/permission service. The
// future atomic ingestion service must load actual evidence, authorize private
// reads and repeat current SQL policy checks before and AFTER every write.
export async function validateProductionImageOutput(confirmation: unknown, originalLease: unknown, intent: unknown,
  attempt: unknown, responseRecord: unknown, rawBody: Buffer, validatedAt: string) {
  if (!Buffer.isBuffer(rawBody) || rawBody.byteLength > MAX_IMAGE_PROTOCOL_RESPONSE_BYTES) reject("production_image_output_raw_too_large", 413);
  if (activeValidations >= 2) reject("production_image_output_busy", 429);
  activeValidations++;
  let body: Buffer | undefined, raw: Buffer | undefined;
  try {
    // All caller-owned evidence/bytes are frozen before the first await.
    const { execution: e, attempt: a, intent: i } = assertProductionImageAttempt(attempt, fp(attempt), confirmation, originalLease, intent);
    const r = e.protocol.request, c = e.preparation.constraint;
    if (constraintContentChecksum(c) !== r.constraintChecksumSha256 || r.protection !== "none" || c.lockedPaths.includes("product.pixels")) reject("production_image_output_protection_not_configured");
    if (r.parameters.size === "auto" || r.parameters.size.width !== c.outputSpec.width || r.parameters.size.height !== c.outputSpec.height
      || r.parameters.outputFormat !== c.outputSpec.format || c.outputSpec.width > MAX_STATIC_IMAGE_EDGE || c.outputSpec.height > MAX_STATIC_IMAGE_EDGE
      || c.outputSpec.width * c.outputSpec.height > MAX_STATIC_IMAGE_PIXELS) reject("production_image_output_spec_invalid");
    raw = Buffer.from(rawBody);
    const parsed = assertProductionImageRawResponse(responseRecord, e, originalLease, i, a, raw);
    body = parsed.candidate?.body;
    // Original raw is no longer needed while decoding; never wipe caller data.
    raw.fill(0); raw = undefined;
    const record = parsed.record, outcome = record.outcome;
    ProductionImageOutputDraftSchema.shape.validatedAt.parse(validatedAt);
    if (Date.parse(validatedAt) < Date.parse(record.receivedAt)) reject("production_image_output_time_invalid");
    if (!body || outcome.providerStatus !== "returned" || outcome.artifactStatus !== "pending-validation" || outcome.failureCode !== undefined
      || outcome.billing.state !== "unknown") reject("production_image_output_candidate_missing");
    if (body.byteLength < 1 || body.byteLength > MAX_IMAGE_PROTOCOL_OUTPUT_BYTES) reject("production_image_output_too_large", 413);
    const checksum = imagePayloadSha256(body), mime = parsed.candidate!.mimeType;
    if (checksum !== parsed.candidate!.checksumSha256 || mime !== `image/${r.parameters.outputFormat}`) reject("production_image_output_candidate_changed");
    let decoded: Awaited<ReturnType<typeof decodeStaticImage>>;
    try { decoded = await decodeStaticImage(body, mime); }
    catch (error) {
      if (error instanceof RunKernelError) reject(error.code.replace(/^verified_asset_/, "production_image_output_"), error.status);
      reject("production_image_output_decode_failed");
    }
    if (decoded.width !== c.outputSpec.width || decoded.height !== c.outputSpec.height) reject("production_image_output_dimensions_mismatch");
    if ((r.parameters.background === "transparent" && !decoded.hasTransparency)
      || (r.parameters.background === "opaque" && decoded.hasTransparency)) reject("production_image_output_background_mismatch");
    const quote = r.quote;
    const draft = ProductionImageOutputDraftSchema.parse({ schemaVersion: 1, mode: e.mode, validation: "decoded-uncommitted", artifactCommitted: false,
      executionAuthorized: false, realExecutionEnabled: false, protectionApplied: "none", jobId: r.jobId, batchId: e.batchId,
      executionFingerprint: fp(e), leaseFingerprint: a.leaseFingerprint, intentFingerprint: fp(i), attemptFingerprint: fp(a), responseFingerprint: fp(record),
      requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256,
      transformedInputsFingerprint: fp(e.protocol.transformedInputs), constraintChecksumSha256: r.constraintChecksumSha256, decoder: "sharp-full-decode-v1",
      image: { mimeType: mime, byteSize: body.byteLength, checksumSha256: checksum, ...decoded },
      money: { currency: quote.currency, maxCostMinor: quote.maxCostMinor, estimate: quote.source === "manual-budget" ? { state: "unknown" }
        : { state: "known", estimatedCostMinor: quote.estimatedCostMinor }, billing: "unknown" }, validatedAt });
    const result = { draft, draftFingerprint: fp(draft), body };
    body = undefined; // Ownership passes only on success; no re-encoding/resize.
    return result;
  } finally { raw?.fill(0); body?.fill(0); activeValidations--; }
}
