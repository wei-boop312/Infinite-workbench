import {
  ConfirmProductionImagePreparationSchema, ProductionImageExecutionRequestSchema, ProductionImagePreparationRecordSchema,
  type ProductionImagePreparationRecord,
} from "@canvas/contracts";
import { ImageProviderContractError, imageSnapshotFingerprint, validateProductionImageProviderInputs } from "./imageProviderContract";
import { constraintContentChecksum } from "./imageAssetPolicy";
import { prepareProductionOpenAiImageRequest } from "./openaiImageProtocol";
import { prepareProductionCompatibleImageRequest } from "./compatibleImageProtocol";
import { prepareProductionGoogleImageRequest } from "./googleImageProtocol";
import { MAX_IMAGE_PROTOCOL_REQUEST_BYTES, type TrustedImageBytes } from "./imageRequestPayload";

function reject(code: string): never { throw new ImageProviderContractError(code); }

// Amount/hash comparison is NOT a human-confirmation or current-price oracle.
// The future confirmation transaction must load this record from the server,
// verify the actual price port and permissions again, and reserve maxCostMinor.
export function validateProductionImageConfirmationExpectations(input: unknown, expectedInput: unknown) {
  const preparation = ProductionImagePreparationRecordSchema.parse(input);
  const expected = ConfirmProductionImagePreparationSchema.parse(expectedInput);
  const { snapshotFingerprint, ...unsealed } = preparation;
  const basis = { connection: preparation.connection, selection: preparation.selection,
    requestDraft: preparation.requestDraft, constraint: preparation.constraint };
  const pricingFingerprint = imageSnapshotFingerprint(preparation.pricing);
  const quote = preparation.pricing.quote;
  if (imageSnapshotFingerprint(unsealed) !== snapshotFingerprint
    || imageSnapshotFingerprint(preparation.selection) !== preparation.selectionFingerprint
    || imageSnapshotFingerprint(basis) !== preparation.basisFingerprint
    || constraintContentChecksum(preparation.constraint) !== preparation.requestDraft.constraintChecksumSha256) reject("production_image_preparation_corrupt");
  const masks = [...new Set(preparation.constraint.editableRegions.flatMap((region) => region.maskAssetId ? [region.maskAssetId] : []))];
  const draft = preparation.requestDraft;
  if (masks.length > 1 || (masks.length && (draft.operation !== "edit" || draft.mask?.assetId !== masks[0]))
    || (draft.operation === "edit" && draft.mask && !masks.includes(draft.mask.assetId))) reject("image_output_constraint_mask_changed");
  if (expected.expectedSnapshotFingerprint !== snapshotFingerprint || expected.expectedPricingFingerprint !== pricingFingerprint
    || expected.expectedCurrency !== quote.currency || expected.expectedMaxCostMinor !== quote.maxCostMinor
    || (quote.source === "manual-budget" ? expected.estimate.state !== "unknown"
      : expected.estimate.state !== "known" || expected.estimate.expectedEstimatedCostMinor !== quote.estimatedCostMinor)) reject("production_image_confirmation_changed");
  return { preparation, pricingFingerprint };
}

function identity(input: { jobId: string; idempotencyKey: string }) {
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  if (!input || Object.keys(input).length !== 2 || !new RegExp(`^production-image-job-${uuid}$`).test(input.jobId)
    || !new RegExp(`^production-image-execution-${uuid}$`).test(input.idempotencyKey)) reject("production_image_identity_namespace_invalid");
  return { jobId: input.jobId, idempotencyKey: input.idempotencyKey };
}

// Pure internal preparation, never persisted here. Independent server-proposed
// identities are syntactic candidates until the SAME task transaction confirms
// and reserves them. No credential/network/SQLite/task/ledger port exists here.
export async function prepareProductionImageProtocol(input: unknown, expectedInput: unknown,
  proposedIdentity: { jobId: string; idempotencyKey: string }, trustedImages: readonly TrustedImageBytes[], now: string) {
  const { preparation: p, pricingFingerprint } = validateProductionImageConfirmationExpectations(input, expectedInput);
  if (!Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(p.createdAt) || Date.parse(now) >= Date.parse(p.pricing.quote.expiresAt)) reject("production_image_price_expired");
  const request = ProductionImageExecutionRequestSchema.parse({ ...p.requestDraft, ...identity(proposedIdentity), quote: p.pricing.quote });
  validateProductionImageProviderInputs(request, trustedImages.map((image) => image.receipt));
  const refs = request.operation === "edit" ? [...request.inputs, ...(request.mask ? [request.mask] : [])] : [];
  let bytes = 0;
  // Freeze only the required authoritative files before the first await. Extra
  // caller files never become inputs, and original caller buffers are untouched.
  const images: TrustedImageBytes[] = [];
  try {
    for (const ref of refs) {
      const original = trustedImages.filter((image) => image.receipt.tenantId === request.tenantId
        && image.receipt.asset.projectId === request.projectId && image.receipt.asset.id === ref.assetId);
      if (original.length !== 1 || !Buffer.isBuffer(original[0].body)) reject("production_image_input_ambiguous");
      bytes += original[0].body.byteLength;
      if (bytes > MAX_IMAGE_PROTOCOL_REQUEST_BYTES) reject("image_request_too_large");
      images.push({ receipt: structuredClone(original[0].receipt), body: Buffer.from(original[0].body) });
    }
    const wire = p.connection.protocol === "openai" ? await prepareProductionOpenAiImageRequest(p.connection, request, images, now)
      : p.connection.protocol === "openai-compatible" ? await prepareProductionCompatibleImageRequest(p.connection, request, images, now)
      : p.connection.protocol === "google" ? await prepareProductionGoogleImageRequest(p.connection, request, images, now)
      : reject("image_protocol_mismatch");
    const snapshot = {
      schemaVersion: 1 as const, mode: p.mode, preparationId: p.id, preparationFingerprint: p.snapshotFingerprint, pricingFingerprint,
      protocolVersion: "production-image-protocol-v1" as const, protocolPreparation: "prepared" as const,
      confirmationState: "unconfirmed" as const, executionAuthorized: false as const, realExecutionEnabled: false as const,
      request, requestFingerprint: wire.requestFingerprint, payloadChecksumSha256: wire.payloadChecksumSha256,
      payloadByteSize: wire.body.byteLength, contentType: wire.contentType, transformedInputs: wire.transformedInputs, preparedAt: now,
    };
    return { snapshot: { ...snapshot, snapshotFingerprint: imageSnapshotFingerprint(snapshot) }, wire };
  } finally {
    // Best effort for owned copies only; not a claim that native/JS strings or
    // external trusted callbacks are reliably erased or sandboxed.
    for (const image of images) image.body.fill(0);
  }
}

export type PreparedProductionImageProtocol = Awaited<ReturnType<typeof prepareProductionImageProtocol>>;
export type ProductionImagePreparationMode = ProductionImagePreparationRecord["mode"];
