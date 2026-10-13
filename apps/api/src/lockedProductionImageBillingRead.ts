import { LockedProductionImageBillingSnapshotSchema, type LockedProductionImageBillingSnapshot } from "@canvas/contracts";
import { RunKernelError, type RunPrincipal } from "./runKernel";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { assertLockedConfirmation } from "./lockedProductionImageProtocol";
import { assertLockedImageRawResponse } from "./lockedProductionImageResponse";
import { assertLockedProductionImageArtifact } from "./lockedProductionImageArtifactIntegrity";
import { assetMetadataFingerprint } from "./assetMetadata";
import { validateLockedProductionImagePreparationAssetPolicy } from "./imageAssetPolicy";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";

function reject(): never { throw new RunKernelError(409, "locked_billing_evidence_changed", "保护核账证据不一致，原预留保持"); }
// Internal actual SQL read. Caller supplies independent current permissions and
// an outer transaction. No lease policy, borrowed sender, decode or price port.
export function readLockedProductionBillingEvidence(store: SqliteRunKernelStateStore,
  kernel: Pick<SqliteRunKernel, "validateProductionBillingSnapshot">, p: RunPrincipal, project: string, batch: string, job: string,
  mode: LockedProductionImageBillingSnapshot["mode"], check: () => number, metadataLimit: number) {
  check(); const snapshot = store.load(); check(); if (!snapshot) reject(); kernel.validateProductionBillingSnapshot(snapshot);
  const catalog = store.loadCatalog(); check();
  const s = snapshot.batches.find(s => s.aggregate.batch.id === batch && s.aggregate.batch.tenantId === p.tenantId && s.aggregate.batch.projectId === project),
    e = s?.lockedProductionImageExecution, j = s?.aggregate.jobs[0], l = s?.lockedProductionImageLeases?.at(-1), i = s?.lockedProductionImageDispatchIntent;
  if (!s || !e || e.mode !== mode || !j || j.id !== job || j.status !== "billing_unknown" || !j.finishedAt || !j.failureCode || !l || !i) reject();
  assertLockedConfirmation(e);
  if (store.imageMetadataBytes(p.tenantId, project) + imageTaskMetadataBytes(snapshot, p.tenantId, project) > metadataLimit)
    throw new RunKernelError(413, "locked_billing_metadata_full", "保护核账元数据容量不足");
  const r = e.protocol.request, q = r.quote, originalProject = catalog?.projects.find(p => p.projectId === project);
  const history = store.loadImageProviderHistory(p.tenantId, project); check();
  if (!history.some(h => fp(h.connection) === fp(e.preparation.connection))) reject();
  const validateInputs = () => {
    check(); const current = store.loadCatalog()?.projects.find(p => p.projectId === project), ids = [...r.inputs.map(i => i.assetId), r.mask!.assetId],
      assets = ids.map(id => current?.assets.find(a => a.id === id));
    if (!current || !originalProject || fp(current.constraints.find(c => c.id === r.constraintSnapshotId)) !== fp(e.preparation.constraint) || assets.some(a => !a)) reject();
    // Current authority declarations, BEFORE any receipt/BLOB getter.
    if (assets.some(a => !a!.byteSize || a!.byteSize > 30 * 1024 * 1024 || !a!.width || !a!.height || Math.max(a!.width, a!.height) > 8192 || a!.width! * a!.height! > 16_000_000)
      || assets.reduce((n, a) => n + a!.byteSize!, 0) > 64 * 1024 * 1024) throw new RunKernelError(413, "locked_billing_inputs_too_large", "保护原图超过原读取界限");
    const { schemaVersion: _version, protectionPolicy: _policy, ...fields } = r;
    validateLockedProductionImagePreparationAssetPolicy(store, { schemaVersion: 1, ...fields }, () => { check(); }); check();
    for (const receipt of [e.preparation.protectionPolicy.source, e.preparation.protectionPolicy.mask]) {
      check(); const actual = store.loadVerifiedImage(p.tenantId, project, receipt.asset.id); check(); if (fp(actual) !== fp(receipt)) reject();
    }
  };
  check(); const prep = store.loadLockedProductionImagePreparation(p.tenantId, project, mode, e.preparation.id); check();
  if (fp(prep) !== fp(e.preparation)) reject(); validateInputs();
  const raw = store.loadLockedProductionImageResponse(p.tenantId, project, mode, job);
  try {
    check(); const artifact = store.loadLockedProductionImageArtifact(p.tenantId, project, mode, job); check();
    if (s.lockedProductionImageResult?.kind === "returned") {
      if (!raw || fp(raw.record) !== s.lockedProductionImageResultFingerprint || fp(raw.record) !== fp(s.lockedProductionImageResult)) reject();
      const parsed = assertLockedImageRawResponse(raw.record, e, l, i, s.lockedProductionImageAttempt, raw.body);
      try {
        if (!!artifact !== !!s.lockedProductionImageArtifact || (artifact && (fp(artifact) !== s.lockedProductionImageArtifactFingerprint || fp(artifact) !== fp(s.lockedProductionImageArtifact)))) reject();
        if (artifact) {
          assertLockedProductionImageArtifact(s, artifact);
          const asset = store.loadCatalog()?.projects.find(p => p.projectId === project)?.assets.find(a => a.id === artifact.image.asset.id); check();
          if (!asset || assetMetadataFingerprint(asset) !== artifact.image.registeredMetadataSha256 || !parsed.candidate
            || parsed.candidate.checksumSha256 !== artifact.image.checksumSha256 || parsed.candidate.mimeType !== asset.mimeType || parsed.candidate.body.length !== asset.byteSize) reject();
        }
      } finally { parsed.candidate?.body.fill(0); }
    } else if (raw || artifact || s.lockedProductionImageArtifact) reject();
  } finally { raw?.body.fill(0); }
  validateInputs();
  const budget = snapshot.budgets.find(b => b.tenantId === p.tenantId && b.projectId === project);
  if (!budget || budget.currency !== q.currency || budget.reservedMinor + budget.spentMinor > budget.limitMinor) reject();
  if (store.imageMetadataBytes(p.tenantId, project) + imageTaskMetadataBytes(snapshot, p.tenantId, project) > metadataLimit)
    throw new RunKernelError(413, "locked_billing_metadata_full", "保护核账元数据容量不足");
  const last = s.lockedProductionImageArtifact?.committedAt ?? (s.lockedProductionImageResult?.kind === "returned" ? s.lockedProductionImageResult.receivedAt
    : s.lockedProductionImageResult?.kind === "interrupted" ? s.lockedProductionImageResult.interruptedAt : j.finishedAt);
  if (check() < Math.max(Date.parse(last), Date.parse(j.finishedAt))) reject();
  const view = LockedProductionImageBillingSnapshotSchema.parse({ schemaVersion: 2, mode, billing: "unknown", settlementAuthorized: false,
    executionAuthorized: false, realExecutionEnabled: false, tenantId: p.tenantId, projectId: project, batchId: batch, jobId: job,
    taskEvidenceFingerprint: fp(s), executionFingerprint: fp(e), preparationFingerprint: fp(e.preparation), requestFingerprint: e.protocol.requestFingerprint,
    payloadChecksumSha256: e.protocol.payloadChecksumSha256, transformedInputsFingerprint: fp(e.protocol.transformedInputs), constraintChecksumSha256: r.constraintChecksumSha256,
    protectionPolicyFingerprint: fp(e.preparation.protectionPolicy), pixelProofFingerprint: s.lockedProductionImageArtifact ? fp(s.lockedProductionImageArtifact.draft.pixelProof) : null,
    leaseFingerprint: fp(l), leaseId: l.leaseId, workerId: l.workerId, originalActorId: l.actorId, intentFingerprint: fp(i),
    attemptFingerprint: s.lockedProductionImageAttemptFingerprint ?? null, resultFingerprint: s.lockedProductionImageResultFingerprint ?? null,
    artifactFingerprint: s.lockedProductionImageArtifactFingerprint ?? null, outputAssetIds: j.outputAssetIds, unknownAt: j.finishedAt, unknownReason: j.failureCode,
    currency: q.currency, reservedMinor: s.reservedMinor, maxCostMinor: q.maxCostMinor,
    estimate: q.source === "manual-budget" ? { state: "unknown" } : { state: "known", estimatedCostMinor: q.estimatedCostMinor } });
  if (Buffer.byteLength(JSON.stringify(view)) > 512 * 1024) reject();
  const snapshotFingerprint = fp(snapshot), catalogFingerprint = fp(catalog);
  if (fp(store.load()) !== snapshotFingerprint || fp(store.loadCatalog()) !== catalogFingerprint) reject(); check();
  return { view, snapshotFingerprint, catalogFingerprint };
}
