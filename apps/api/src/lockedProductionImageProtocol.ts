import { ConfirmLockedProductionImagePreparationSchema, ConfirmedLockedProductionImageExecutionSchema, LockedProductionImageExecutionRequestSchema,
  LockedProductionImagePreparationRecordSchema, ProductionImageTaskIdentitySchema, type LockedProductionImagePreparationRecord, type RunKernelStoredBatch } from "@canvas/contracts";
import { ImageProviderContractError, imageSnapshotFingerprint } from "./imageProviderContract";
import { validateLockedProtocolRequest } from "./lockedProductionImageRequest";
import { constraintContentChecksum } from "./imageAssetPolicy";
import { prepareLockedProductionOpenAiImageRequest } from "./openaiImageProtocol";
import { prepareLockedProductionCompatibleImageRequest } from "./compatibleImageProtocol";
import type { TrustedImageBytes } from "./imageRequestPayload";
import { assertLockedDispatchIntent } from "./lockedProductionImageDispatchIntentIntegrity";
import { assertLockedImageAttempt, assertLockedImageResult } from "./lockedProductionImageResponse";
import { assertLockedProductionImageArtifact } from "./lockedProductionImageArtifactIntegrity";

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
// Closed v2 states; raw is independently re-parsed by the actual SQLite wrapper.
export function assertLockedConfirmationState(s: RunKernelStoredBatch, leaseDurationMs?: number, jobTimeoutMs?: number) {
  const e = assertLockedConfirmation(s.lockedProductionImageExecution), r = e.protocol.request, q = r.quote;
  const a = s.aggregate, b = a.batch, j = a.jobs[0], estimate = q.source === "manual-budget" ? null : q.estimatedCostMinor;
  const ids = [...r.inputs.map(i => i.assetId), r.mask!.assetId];
  const cancelled = b.status === "cancelled", history = s.lockedProductionImageLeases ?? [], intent = s.lockedProductionImageDispatchIntent;
  const started = ["running", "billing_unknown"].includes(b.status), unknown = b.status === "billing_unknown";
  const attempt = s.lockedProductionImageAttempt, result = s.lockedProductionImageResult, artifact = s.lockedProductionImageArtifact;
  const allowed = new Set(["aggregate", "lockedProductionImageExecution", "lockedProductionImageLeases", "lockedProductionImageDispatchIntent", "lockedProductionImageDispatchIntentFingerprint", "lockedProductionImageAttempt", "lockedProductionImageAttemptFingerprint", "lockedProductionImageResult", "lockedProductionImageResultFingerprint", "lockedProductionImageArtifact", "lockedProductionImageArtifactFingerprint", "requestFingerprint", "reservedMinor", "actualMinor", "jobReservations", "jobScenarios"]);
  if (Object.entries(s).some(([k, v]) => v !== undefined && !allowed.has(k)) || s.requestFingerprint !== hash(e) || s.actualMinor !== 0
    || s.reservedMinor !== (cancelled ? 0 : q.maxCostMinor) || s.jobScenarios.length
    || (cancelled ? s.jobReservations.length !== 0 : s.jobReservations.length !== 1 || s.jobReservations[0][0] !== r.jobId || s.jobReservations[0][1] !== q.maxCostMinor)
    || b.id !== e.batchId || b.imageMode !== e.mode || b.tenantId !== r.tenantId || b.projectId !== r.projectId || b.constraintSnapshotId !== r.constraintSnapshotId
    || b.adapterId !== r.adapterId || b.tool !== "image-edit" || b.idempotencyKey !== lockedConfirmationKey(e) || !["queued", "cancelled", "running", "billing_unknown"].includes(b.status) || b.expectedOutputs !== 1
    || b.estimatedCostMinor !== estimate || b.maxCostMinor !== q.maxCostMinor || b.currency !== q.currency || b.createdAt !== e.confirmedAt || b.confirmedAt !== e.confirmedAt || b.confirmedBy !== e.confirmedBy
    || a.jobs.length !== 1 || !j || j.id !== r.jobId || j.batchId !== b.id || j.imageMode !== e.mode || j.executorKind !== "provider" || j.adapterId !== r.adapterId
    || j.idempotencyKey !== r.idempotencyKey || !(started || cancelled ? j.status === b.status : ["queued", "leased"].includes(j.status)) || j.attempt !== 1 || j.outputIndex !== 0 || j.estimatedCostMinor !== estimate || j.createdAt !== e.confirmedAt
    || hash(b.inputAssetIds) !== hash(ids) || hash(j.inputAssetIds) !== hash(ids) || hash(j.outputAssetIds) !== hash(artifact ? [artifact.image.asset.id] : []) || a.billingOverages.length || a.productionBilling
    || [j.providerRequestId, j.retryOf, j.actualCostMinor,
      j.billingResolutionId, j.billingResolvedAt, j.billingResolvedBy, j.billingEvidenceRef].some(v => v !== undefined)) reject();
  if (started ? !intent || !s.lockedProductionImageDispatchIntentFingerprint || j.startedAt !== intent.recordedAt
    : intent || s.lockedProductionImageDispatchIntentFingerprint || j.startedAt) reject();
  const responseReasons = ["locked-response-returned", "production-timeout", "production-transport-error", "production-response-invalid", "production-response-save-failed"];
  if (unknown ? !["locked-lease-expired-after-intent", "locked-job-timeout-after-intent", "locked-recovered-after-restart", ...responseReasons].includes(j.failureCode ?? "") || !j.finishedAt : j.failureCode !== undefined) reject();
  if (responseReasons.includes(j.failureCode ?? "") && !result) reject();
  if (attempt ? !started || !s.lockedProductionImageAttemptFingerprint : s.lockedProductionImageAttemptFingerprint !== undefined) reject();
  if (result ? !unknown || !attempt || !s.lockedProductionImageResultFingerprint : s.lockedProductionImageResultFingerprint !== undefined) reject();
  const l = a.ledger[0];
  if (a.ledger.length !== (unknown || cancelled && q.maxCostMinor > 0 ? 2 : 1) || !l || l.tenantId !== b.tenantId || l.projectId !== b.projectId || l.batchId !== b.id || l.jobId !== j.id || l.imageMode !== e.mode
    || l.currency !== q.currency || l.estimatedMinor !== estimate || l.reservedMinor !== q.maxCostMinor || l.actualMinor !== undefined || l.settlement !== "reserved" || l.createdAt !== e.confirmedAt) reject();
  const expected = { "batch-created": { mode: e.mode, preparationId: e.preparation.id }, "batch-confirmed": { mode: e.mode,
    preparationFingerprint: e.preparation.snapshotFingerprint, pricingFingerprint: e.protocol.pricingFingerprint, executionFingerprint: s.requestFingerprint,
    requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256 }, "budget-reserved": { reservedMinor: String(q.maxCostMinor) }, "jobs-created": { count: "1" } };
  if (new Set(a.audit.map(a => a.id)).size !== a.audit.length || a.audit.some(x => x.tenantId !== b.tenantId || x.projectId !== b.projectId || x.batchId !== b.id)) reject();
  for (const [type, metadata] of Object.entries(expected)) { const events = a.audit.filter(a => a.eventType === type);
    if (events.length !== 1 || events[0].actorId !== e.confirmedBy || events[0].tenantId !== b.tenantId || events[0].projectId !== b.projectId || events[0].batchId !== b.id
      || hash(events[0].metadata) !== hash(metadata) || Date.parse(events[0].createdAt) < Date.parse(e.confirmedAt) || Date.parse(events[0].createdAt) >= Date.parse(q.expiresAt)) reject(); }
  const leaseEvents = a.audit.filter(x => x.eventType === "job-leased"), expiries = a.audit.filter(x => x.eventType === "job-lease-expired");
  const cancellations = a.audit.filter(x => x.eventType === "batch-cancelled"), releases = a.audit.filter(x => x.eventType === "budget-released");
  if (a.audit.length !== 4 + history.length + expiries.length + (started ? 1 + (unknown ? 1 : 0) : 0) + (cancelled ? 1 + (q.maxCostMinor > 0 ? 1 : 0) : 0)
    + (attempt ? 1 : 0) + (result ? 1 : 0) + (artifact ? 1 : 0) || leaseEvents.length !== history.length || history.length > 512 || Buffer.byteLength(JSON.stringify(history)) > 512 * 1024
    || new Set(history.map(x => x.leaseId)).size !== history.length) reject();
  let end = Date.parse(e.confirmedAt), expiryCount = 0;
  for (const [i, lease] of history.entries()) {
    const event = leaseEvents[i], expired = expiries.filter(x => x.metadata.leaseId === lease.leaseId);
    if (lease.mode !== e.mode || lease.executionFingerprint !== s.requestFingerprint || lease.protectionPolicyFingerprint !== hash(e.preparation.protectionPolicy)
      || lease.batchId !== b.id || lease.jobId !== j.id || Date.parse(lease.leasedAt) < end || Date.parse(lease.leasedAt) >= Date.parse(q.expiresAt)
      || Date.parse(lease.expiresAt) - Date.parse(lease.leasedAt) < 1000 || (leaseDurationMs !== undefined && Date.parse(lease.expiresAt) - Date.parse(lease.leasedAt) !== leaseDurationMs)
      || event.actorId !== lease.actorId || event.createdAt !== lease.leasedAt || hash(event.metadata) !== hash({ jobId: j.id, leaseId: lease.leaseId,
        workerId: lease.workerId, adapterId: j.adapterId, mode: e.mode, executionFingerprint: s.requestFingerprint, protectionPolicyFingerprint: lease.protectionPolicyFingerprint, expiresAt: lease.expiresAt })) reject();
    if (expired.length) { expiryCount++; if (expired.length !== 1 || Date.parse(expired[0].createdAt) < Date.parse(lease.expiresAt)
      || hash(expired[0].metadata) !== hash({ jobId: j.id, leaseId: lease.leaseId, action: "requeued-before-start" })) reject(); end = Date.parse(expired[0].createdAt); }
    else { if (i !== history.length - 1 || !["leased", "cancelled", "running", "billing_unknown"].includes(j.status) || j.leaseId !== lease.leaseId || j.leaseOwnerId !== lease.workerId
      || j.leasedAt !== lease.leasedAt || j.leaseExpiresAt !== lease.expiresAt) reject(); end = Date.parse(lease.leasedAt); }
  }
  if (expiryCount !== expiries.length || (j.status === "leased" && (!history.length || expiries.some(x => x.metadata.leaseId === j.leaseId)))
    || ((j.status === "queued" || !history.length || expiries.some(x => x.metadata.leaseId === history.at(-1)?.leaseId))
      && [j.leaseId, j.leaseOwnerId, j.leasedAt, j.leaseExpiresAt].some(v => v !== undefined))) reject();
  const starts = a.audit.filter(x => x.eventType === "job-started"), unknowns = a.audit.filter(x => x.eventType === "billing-unknown");
  if (starts.length !== (started ? 1 : 0) || unknowns.length !== (unknown ? 1 : 0)) reject();
  const attempts = a.audit.filter(x => x.eventType === "production-image-attempted"), returns = a.audit.filter(x => ["production-image-returned", "production-image-interrupted"].includes(x.eventType));
  if (attempts.length !== (attempt ? 1 : 0) || returns.length !== (result ? 1 : 0)) reject();
  const artifacts = a.audit.filter(x => x.eventType === "production-image-artifact-verified");
  if (artifacts.length !== (artifact ? 1 : 0) || !!artifact !== !!s.lockedProductionImageArtifactFingerprint) reject();
  if (artifact) {
    assertLockedProductionImageArtifact(s, artifact); const event = artifacts[0];
    if (!unknown || hash(artifact) !== s.lockedProductionImageArtifactFingerprint || event.actorId !== artifact.committedBy || event.createdAt !== artifact.committedAt
      || hash(event.metadata) !== hash({ jobId: j.id, artifactFingerprint: hash(artifact), assetId: artifact.image.asset.id,
        checksumSha256: artifact.image.checksumSha256, protectionPolicyFingerprint: artifact.draft.protectionPolicyFingerprint })) reject();
  }
  if (attempt) { const x = assertLockedImageAttempt(attempt, s.lockedProductionImageAttemptFingerprint!, e, history.at(-1), intent).attempt, event = attempts[0];
    if (event.actorId !== x.actorId || event.createdAt !== x.attemptedAt || hash(event.metadata) !== hash({ jobId: j.id, attemptId: x.id,
      attemptFingerprint: hash(x), intentFingerprint: x.intentFingerprint, transport: x.transport, protectionPolicyFingerprint: x.protectionPolicyFingerprint })) reject(); }
  if (result) { const x = assertLockedImageResult(result, s.lockedProductionImageResultFingerprint!, e, attempt), event = returns[0], at = x.kind === "returned" ? x.receivedAt : x.interruptedAt;
    if (event.actorId !== attempt!.actorId || event.createdAt !== at || event.eventType !== (x.kind === "returned" ? "production-image-returned" : "production-image-interrupted")
      || hash(event.metadata) !== hash({ jobId: j.id, attemptId: x.attemptId, resultFingerprint: hash(x), kind: x.kind, protectionPolicyFingerprint: x.protectionPolicyFingerprint })
      || (responseReasons.includes(j.failureCode ?? "") && (j.finishedAt !== at || j.failureCode !== (x.kind === "returned" ? "locked-response-returned" : x.outcome.failureCode)))) reject(); }
  if (started) {
    const i = assertLockedDispatchIntent(intent, s.lockedProductionImageDispatchIntentFingerprint!, e, history.at(-1)), event = starts[0];
    if (expiries.some(x => x.metadata.leaseId === i.leaseId) || event.actorId !== i.actorId || event.createdAt !== i.recordedAt
      || hash(event.metadata) !== hash({ jobId: j.id, leaseId: i.leaseId, workerId: i.workerId, lockedProductionImageDispatchIntentId: i.id,
        intentFingerprint: s.lockedProductionImageDispatchIntentFingerprint, payloadChecksumSha256: i.payloadChecksumSha256, transport: "not-connected" })) reject();
    if (unknown) { const u = unknowns[0], entry = a.ledger[1];
      if (u.createdAt !== j.finishedAt || Date.parse(u.createdAt) < Date.parse(i.recordedAt)
        || hash(u.metadata) !== hash({ jobId: j.id, lockedProductionImageDispatchIntentId: i.id, intentFingerprint: s.lockedProductionImageDispatchIntentFingerprint, reason: j.failureCode })
        || entry.tenantId !== b.tenantId || entry.projectId !== b.projectId || entry.batchId !== b.id || entry.jobId !== j.id || entry.imageMode !== e.mode
        || entry.currency !== q.currency || entry.estimatedMinor !== estimate || entry.reservedMinor !== q.maxCostMinor || entry.actualMinor !== undefined || entry.settlement !== "unknown" || entry.createdAt !== j.finishedAt
        || (j.failureCode === "locked-lease-expired-after-intent" && Date.parse(j.finishedAt!) < Date.parse(history.at(-1)!.expiresAt))
        || (j.failureCode === "locked-job-timeout-after-intent" && (Date.parse(j.finishedAt!) <= Date.parse(i.recordedAt)
          || jobTimeoutMs !== undefined && Date.parse(j.finishedAt!) < Date.parse(i.recordedAt) + jobTimeoutMs))) reject(); }
  }
  if (!cancelled) { if ((!unknown && j.finishedAt !== undefined) || cancellations.length || releases.length) reject(); }
  else {
    const c = cancellations[0];
    if (cancellations.length !== 1 || !j.finishedAt || c.createdAt !== j.finishedAt || Date.parse(c.createdAt) < end
      || hash(c.metadata) !== hash({ previousStatus: "queued", protectionPolicyFingerprint: hash(e.preparation.protectionPolicy) })
      || releases.length !== (q.maxCostMinor > 0 ? 1 : 0)) reject();
    if (q.maxCostMinor > 0) { const release = releases[0], entry = a.ledger[1];
      if (release.actorId !== c.actorId || release.createdAt !== c.createdAt || hash(release.metadata) !== hash({ releasedMinor: String(q.maxCostMinor) })
        || entry.tenantId !== b.tenantId || entry.projectId !== b.projectId || entry.batchId !== b.id || entry.jobId !== undefined || entry.imageMode !== e.mode
        || entry.currency !== q.currency || entry.estimatedMinor !== estimate || entry.reservedMinor !== 0 || entry.actualMinor !== 0 || entry.settlement !== "released" || entry.createdAt !== c.createdAt) reject(); }
  }
}
