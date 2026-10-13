import { LockedProductionImageBillingSnapshotSchema, LockedProductionImageBillingRecordSchema, type LockedProductionImageBillingRecord, type RunKernelSnapshot } from "@canvas/contracts";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";

type Stored = RunKernelSnapshot["batches"][number];
export function lockedProductionBillingSummary(records: LockedProductionImageBillingRecord[]) {
  return records.map(r => ({ schemaVersion: 2 as const, protectionPolicyFingerprint: r.snapshot.protectionPolicyFingerprint, reviewId: r.request.reviewId, status: r.status, currency: r.snapshot.currency,
    originalMaxCostMinor: r.snapshot.maxCostMinor, actualCostMinor: r.request.actualCostMinor, reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt,
    ...(r.decision ? { decisionId: r.decision.request.decisionId, decidedBy: r.decision.decidedBy, decidedAt: r.decision.decidedAt } : {}) }));
}

// Historical projection only, never task authority. The actual state must first
// validate its immutable fees, settlement and budget. Reconstruct the exact
// pre-billing evidence to verify its original whole-task fingerprint.
export function lockedProductionBillingBaseline(stored: Stored): Stored {
  const base = structuredClone(stored), records = base.lockedProductionImageBilling;
  if (!records) return base;
  const snapshot = records[0].snapshot, job = base.aggregate.jobs[0];
  delete base.lockedProductionImageBilling; delete base.lockedProductionImageBillingFingerprint; delete base.aggregate.lockedProductionBilling;
  base.aggregate.audit = base.aggregate.audit.filter(a => !a.eventType.startsWith("locked-billing-"));
  base.aggregate.ledger = base.aggregate.ledger.filter(l => l.settlement === "reserved" || l.settlement === "unknown");
  base.aggregate.batch.status = "billing_unknown"; base.aggregate.batch.maxCostMinor = snapshot.maxCostMinor;
  job.status = "billing_unknown"; job.finishedAt = snapshot.unknownAt; job.failureCode = snapshot.unknownReason;
  delete job.actualCostMinor; delete job.billingResolutionId; delete job.billingResolvedAt; delete job.billingResolvedBy; delete job.billingEvidenceRef;
  base.reservedMinor = snapshot.reservedMinor; base.actualMinor = 0; base.jobReservations = [[job.id, snapshot.reservedMinor]];
  return base;
}
export function lockedProductionBillingSnapshot(stored: Stored) {
  const e = stored.lockedProductionImageExecution!, j = stored.aggregate.jobs[0], l = stored.lockedProductionImageLeases!.at(-1)!;
  return LockedProductionImageBillingSnapshotSchema.parse({ schemaVersion: 2, mode: e.mode, billing: "unknown", settlementAuthorized: false,
    executionAuthorized: false, realExecutionEnabled: false, tenantId: stored.aggregate.batch.tenantId, projectId: stored.aggregate.batch.projectId,
    batchId: e.batchId, jobId: j.id, taskEvidenceFingerprint: fp(stored), executionFingerprint: fp(e), preparationFingerprint: fp(e.preparation),
    requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256,
    transformedInputsFingerprint: fp(e.protocol.transformedInputs), constraintChecksumSha256: e.protocol.request.constraintChecksumSha256,
    protectionPolicyFingerprint: fp(e.preparation.protectionPolicy), pixelProofFingerprint: stored.lockedProductionImageArtifact ? fp(stored.lockedProductionImageArtifact.draft.pixelProof) : null,
    leaseFingerprint: fp(l), leaseId: l.leaseId, workerId: l.workerId, originalActorId: l.actorId,
    intentFingerprint: fp(stored.lockedProductionImageDispatchIntent), attemptFingerprint: stored.lockedProductionImageAttemptFingerprint ?? null,
    resultFingerprint: stored.lockedProductionImageResultFingerprint ?? null, artifactFingerprint: stored.lockedProductionImageArtifactFingerprint ?? null,
    outputAssetIds: j.outputAssetIds, unknownAt: j.finishedAt, unknownReason: j.failureCode,
    currency: stored.aggregate.batch.currency, reservedMinor: stored.reservedMinor, maxCostMinor: e.protocol.request.quote.maxCostMinor,
    estimate: j.estimatedCostMinor === null ? { state: "unknown" } : { state: "known", estimatedCostMinor: j.estimatedCostMinor } });
}
export function pendingLockedProductionBillingRecord(record: LockedProductionImageBillingRecord): LockedProductionImageBillingRecord {
  const pending = structuredClone(record); delete pending.decision; pending.status = "pending"; return pending;
}
export function assertLockedProductionBillingState(stored: Stored): Stored {
  const records = stored.lockedProductionImageBilling;
  if (!records || !records.length || fp(records) !== stored.lockedProductionImageBillingFingerprint) throw new Error("生产费用记录缺少完整指纹");
  const base = lockedProductionBillingBaseline(stored), snapshot = lockedProductionBillingSnapshot(base), hash = fp(snapshot);
  const events = stored.aggregate.audit.filter(a => a.eventType.startsWith("locked-billing-"));
  const settled = records.find(r => r.status === "settled"), j = stored.aggregate.jobs[0], b = stored.aggregate.batch;
  const result = base.lockedProductionImageResult;
  let previous = Math.max(Date.parse(snapshot.unknownAt), Date.parse(base.lockedProductionImageArtifact?.committedAt
    ?? (result?.kind === "returned" ? result.receivedAt : result?.kind === "interrupted" ? result.interruptedAt : snapshot.unknownAt))), eventIndex = 0;
  const reviewIds = new Set<string>(), decisionIds = new Set<string>();
  for (const [index, incoming] of records.entries()) {
    const r = LockedProductionImageBillingRecordSchema.parse(incoming), at = r.decision?.decidedAt ?? r.reviewedAt;
    if (fp(r.snapshot) !== hash || r.snapshotFingerprint !== hash || r.mode !== snapshot.mode || reviewIds.has(r.request.reviewId)
      || Date.parse(r.reviewedAt) < previous || (index !== records.length - 1 && r.status !== "rejected")) throw new Error("生产费用历史关系损坏");
    reviewIds.add(r.request.reviewId); previous = Date.parse(at);
    const reviewed = events[eventIndex++], initial = r.decision ? pendingLockedProductionBillingRecord(r) : r;
    if (!reviewed || reviewed.eventType !== "locked-billing-reviewed" || reviewed.actorId !== r.reviewedBy || reviewed.createdAt !== r.reviewedAt
      || fp(reviewed.metadata) !== fp({ jobId: j.id, reviewId: r.request.reviewId, recordFingerprint: fp(initial) })) throw new Error("生产核账审计损坏");
    if (r.decision) {
      const d = r.decision, event = events[eventIndex++];
      if (decisionIds.has(d.request.decisionId) || d.request.expectedRecordFingerprint !== fp(pendingLockedProductionBillingRecord(r))
        || !event || event.eventType !== `locked-billing-${d.request.decision === "approve" ? "approved" : "rejected"}`
        || event.actorId !== d.decidedBy || event.createdAt !== d.decidedAt
        || fp(event.metadata) !== fp({ jobId: j.id, reviewId: r.request.reviewId, decisionId: d.request.decisionId, recordFingerprint: fp(r) })) throw new Error("生产第二人审批审计损坏");
      decisionIds.add(d.request.decisionId);
    }
    if (r.status === "settled") {
      const event = events[eventIndex++];
      if (!event || event.eventType !== "locked-billing-settled" || event.actorId !== (r.decision?.decidedBy ?? r.reviewedBy) || event.createdAt !== at
        || fp(event.metadata) !== fp({ jobId: j.id, resolutionId: r.decision?.request.decisionId ?? r.request.reviewId, recordFingerprint: fp(r),
          actualMinor: String(r.request.actualCostMinor), releasedMinor: String(Math.max(0, snapshot.reservedMinor - r.request.actualCostMinor)),
          additionalMinor: String(Math.max(0, r.request.actualCostMinor - snapshot.reservedMinor)) })) throw new Error("生产费用结算审计损坏");
    }
  }
  if (events.length !== eventIndex || fp(stored.aggregate.lockedProductionBilling) !== fp(lockedProductionBillingSummary(records)) || !stored.lockedProductionImageExecution
    || j.finishedAt !== snapshot.unknownAt || b.currency !== snapshot.currency) throw new Error("生产费用聚合损坏");
  if (settled) {
    const at = settled.decision?.decidedAt ?? settled.reviewedAt, amount = settled.request.actualCostMinor, last = stored.aggregate.ledger.at(-1)!;
    if (b.status !== (stored.lockedProductionImageArtifact ? "succeeded" : "failed") || j.status !== b.status || stored.reservedMinor !== 0
      || stored.jobReservations.length || stored.actualMinor !== amount || j.actualCostMinor !== amount
      || b.maxCostMinor !== Math.max(snapshot.maxCostMinor, amount) || j.billingResolutionId !== (settled.decision?.request.decisionId ?? settled.request.reviewId)
      || j.billingResolvedBy !== (settled.decision?.decidedBy ?? settled.reviewedBy) || j.billingResolvedAt !== at || j.billingEvidenceRef !== settled.request.evidence.evidenceRef
      || j.failureCode !== (stored.lockedProductionImageArtifact ? undefined : "locked-billing-settled-no-artifact")
      || stored.aggregate.ledger.length !== base.aggregate.ledger.length + 1 || !last || last.jobId !== j.id || last.actualMinor !== amount
      || last.reservedMinor !== 0 || last.estimatedMinor !== j.estimatedCostMinor || last.createdAt !== at
      || last.settlement !== (amount ? "settled" : "released") || last.imageMode !== snapshot.mode || last.currency !== b.currency
      || last.tenantId !== b.tenantId || last.projectId !== b.projectId || last.batchId !== b.id
      || new Set(stored.aggregate.ledger.map(l => l.id)).size !== stored.aggregate.ledger.length) throw new Error("生产结算与账本/任务不守恒");
  } else if (fp({ ...stored, lockedProductionImageBilling: undefined, lockedProductionImageBillingFingerprint: undefined,
    aggregate: { ...stored.aggregate, lockedProductionBilling: undefined, audit: base.aggregate.audit } }) !== fp({ ...base, lockedProductionImageBilling: undefined,
      lockedProductionImageBillingFingerprint: undefined, aggregate: { ...base.aggregate, lockedProductionBilling: undefined } })) throw new Error("待审批不能修改任务或释放预留");
  return base;
}
