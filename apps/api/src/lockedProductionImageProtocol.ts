import { ConfirmLockedProductionImagePreparationSchema, ConfirmedLockedProductionImageExecutionSchema, LockedProductionImageExecutionRequestSchema,
  LockedProductionImagePreparationRecordSchema, ProductionImageTaskIdentitySchema, type LockedProductionImagePreparationRecord, type RunKernelStoredBatch } from "@canvas/contracts";
import { ImageProviderContractError, imageSnapshotFingerprint } from "./imageProviderContract";
import { validateLockedProtocolRequest } from "./lockedProductionImageRequest";
import { constraintContentChecksum } from "./imageAssetPolicy";
import { prepareLockedProductionOpenAiImageRequest } from "./openaiImageProtocol";
import { prepareLockedProductionCompatibleImageRequest } from "./compatibleImageProtocol";
import type { TrustedImageBytes } from "./imageRequestPayload";

const hash = imageSnapshotFingerprint;
function reject(): never { throw new ImageProviderContractError("locked_image_confirmation_corrupt"); }
export function lockedExpected(p: LockedProductionImagePreparationRecord) {
  const q = p.pricing.quote;
  return { schemaVersion: 2 as const, expectedSnapshotFingerprint: p.snapshotFingerprint, expectedPricingFingerprint: hash(p.pricing),
    expectedProtectionPolicyFingerprint: hash(p.protectionPolicy), expectedCurrency: q.currency, expectedMaxCostMinor: q.maxCostMinor,
    estimate: q.source === "manual-budget" ? { state: "unknown" as const } : { state: "known" as const, expectedEstimatedCostMinor: q.estimatedCostMinor } };
}
export function assertLockedExpectations(input: unknown, expected: unknown) {
  const p = LockedProductionImagePreparationRecordSchema.parse(input), x = ConfirmLockedProductionImagePreparationSchema.parse(expected);
  const { snapshotFingerprint: sha, ...unsigned } = p;
  if (sha !== hash(unsigned) || p.selectionFingerprint !== hash(p.selection) || p.basisFingerprint !== hash({ connection: p.connection,
    selection: p.selection, requestDraft: p.requestDraft, constraint: p.constraint, protectionPolicy: p.protectionPolicy })
    || p.requestDraft.constraintChecksumSha256 !== constraintContentChecksum(p.constraint) || hash(x) !== hash(lockedExpected(p))) reject();
  return p;
}
export async function prepareLockedProductionImageProtocol(input: unknown, expected: unknown, identity: { jobId: string; idempotencyKey: string }, images: readonly TrustedImageBytes[], now: string) {
  const p = assertLockedExpectations(input, expected);
  const request = LockedProductionImageExecutionRequestSchema.parse({ ...p.requestDraft, schemaVersion: 2, ...ProductionImageTaskIdentitySchema.parse(identity),
    quote: p.pricing.quote, protectionPolicy: p.protectionPolicy });
  if (Date.parse(now) < Date.parse(p.createdAt)) reject();
  const wire = p.connection.protocol === "openai" ? await prepareLockedProductionOpenAiImageRequest(p.connection, request, images, now)
    : p.connection.protocol === "openai-compatible" ? await prepareLockedProductionCompatibleImageRequest(p.connection, request, images, now) : reject();
  const unsigned = { schemaVersion: 2 as const, mode: p.mode, preparationId: p.id, preparationFingerprint: p.snapshotFingerprint, pricingFingerprint: hash(p.pricing),
    protocolVersion: "locked-production-image-protocol-v2" as const, protocolPreparation: "prepared" as const, confirmationState: "unconfirmed" as const,
    executionAuthorized: false as const, realExecutionEnabled: false as const, request, requestFingerprint: wire.requestFingerprint,
    payloadChecksumSha256: wire.payloadChecksumSha256, payloadByteSize: wire.body.length, contentType: wire.contentType, transformedInputs: wire.transformedInputs, preparedAt: now };
  return { wire, snapshot: { ...unsigned, snapshotFingerprint: hash(unsigned) } };
}
export function lockedConfirmationKey(e: { mode: string; preparation: { id: string } }) { return `locked-production-image-confirm:${e.mode}:${e.preparation.id}`; }
export function assertLockedConfirmation(input: unknown) {
  const e = ConfirmedLockedProductionImageExecutionSchema.parse(input), p = assertLockedExpectations(e.preparation, lockedExpected(e.preparation)), s = e.protocol;
  const { snapshotFingerprint: sha, ...unsigned } = s;
  const validated = validateLockedProtocolRequest(p.connection, s.request, e.confirmedAt);
  if (sha !== hash(unsigned) || s.pricingFingerprint !== hash(p.pricing) || s.requestFingerprint !== validated.fingerprint) reject();
  const transform = p.connection.models.find(m => m.model === s.request.model)?.mask.polarity === "transparent-edit"
    ? "internal-white-to-transparent-mask-v1" : "internal-white-mask-v1";
  if (s.transformedInputs.at(-1)?.transform !== transform) reject();
  return e;
}
// B2 deliberately permits only queued tasks. No future lease/raw/artifact or
// billing field may be grafted onto a confirmed protected task at this stage.
export function assertLockedConfirmationState(s: RunKernelStoredBatch) {
  const e = assertLockedConfirmation(s.lockedProductionImageExecution), r = e.protocol.request, q = r.quote;
  const a = s.aggregate, b = a.batch, j = a.jobs[0], estimate = q.source === "manual-budget" ? null : q.estimatedCostMinor;
  const ids = [...r.inputs.map(i => i.assetId), r.mask!.assetId];
  const allowed = new Set(["aggregate", "lockedProductionImageExecution", "requestFingerprint", "reservedMinor", "actualMinor", "jobReservations", "jobScenarios"]);
  if (Object.entries(s).some(([k, v]) => v !== undefined && !allowed.has(k)) || s.requestFingerprint !== hash(e) || s.actualMinor !== 0
    || s.reservedMinor !== q.maxCostMinor || s.jobScenarios.length || s.jobReservations.length !== 1 || s.jobReservations[0][0] !== r.jobId || s.jobReservations[0][1] !== q.maxCostMinor
    || b.id !== e.batchId || b.imageMode !== e.mode || b.tenantId !== r.tenantId || b.projectId !== r.projectId || b.constraintSnapshotId !== r.constraintSnapshotId
    || b.adapterId !== r.adapterId || b.tool !== "image-edit" || b.idempotencyKey !== lockedConfirmationKey(e) || b.status !== "queued" || b.expectedOutputs !== 1
    || b.estimatedCostMinor !== estimate || b.maxCostMinor !== q.maxCostMinor || b.currency !== q.currency || b.createdAt !== e.confirmedAt || b.confirmedAt !== e.confirmedAt || b.confirmedBy !== e.confirmedBy
    || a.jobs.length !== 1 || !j || j.id !== r.jobId || j.batchId !== b.id || j.imageMode !== e.mode || j.executorKind !== "provider" || j.adapterId !== r.adapterId
    || j.idempotencyKey !== r.idempotencyKey || j.status !== "queued" || j.attempt !== 1 || j.outputIndex !== 0 || j.estimatedCostMinor !== estimate || j.createdAt !== e.confirmedAt
    || hash(b.inputAssetIds) !== hash(ids) || hash(j.inputAssetIds) !== hash(ids) || j.outputAssetIds.length || a.billingOverages.length || a.productionBilling
    || [j.leaseId, j.leaseOwnerId, j.leasedAt, j.leaseExpiresAt, j.startedAt, j.finishedAt, j.providerRequestId, j.retryOf, j.actualCostMinor, j.failureCode,
      j.billingResolutionId, j.billingResolvedAt, j.billingResolvedBy, j.billingEvidenceRef].some(v => v !== undefined)) reject();
  const l = a.ledger[0];
  if (a.ledger.length !== 1 || !l || l.tenantId !== b.tenantId || l.projectId !== b.projectId || l.batchId !== b.id || l.jobId !== j.id || l.imageMode !== e.mode
    || l.currency !== q.currency || l.estimatedMinor !== estimate || l.reservedMinor !== q.maxCostMinor || l.actualMinor !== undefined || l.settlement !== "reserved" || l.createdAt !== e.confirmedAt) reject();
  const expected = { "batch-created": { mode: e.mode, preparationId: e.preparation.id }, "batch-confirmed": { mode: e.mode,
    preparationFingerprint: e.preparation.snapshotFingerprint, pricingFingerprint: e.protocol.pricingFingerprint, executionFingerprint: s.requestFingerprint,
    requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256 }, "budget-reserved": { reservedMinor: String(q.maxCostMinor) }, "jobs-created": { count: "1" } };
  if (a.audit.length !== 4 || new Set(a.audit.map(a => a.id)).size !== 4) reject();
  for (const [type, metadata] of Object.entries(expected)) { const events = a.audit.filter(a => a.eventType === type);
    if (events.length !== 1 || events[0].actorId !== e.confirmedBy || events[0].tenantId !== b.tenantId || events[0].projectId !== b.projectId || events[0].batchId !== b.id
      || hash(events[0].metadata) !== hash(metadata) || Date.parse(events[0].createdAt) < Date.parse(e.confirmedAt) || Date.parse(events[0].createdAt) >= Date.parse(q.expiresAt)) reject(); }
}
