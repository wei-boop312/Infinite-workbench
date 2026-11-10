import { ProductionImageBillingSnapshotSchema, ProductionImageBillingRecordSchema, type ProductionImageBillingRecord, type RunKernelSnapshot } from "@canvas/contracts";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";

type Stored = RunKernelSnapshot["batches"][number];
export function productionBillingSummary(records: ProductionImageBillingRecord[]) {
  return records.map(r => ({ reviewId: r.request.reviewId, status: r.status, currency: r.snapshot.currency,
    originalMaxCostMinor: r.snapshot.maxCostMinor, actualCostMinor: r.request.actualCostMinor, reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt,
    ...(r.decision ? { decisionId: r.decision.request.decisionId, decidedBy: r.decision.decidedBy, decidedAt: r.decision.decidedAt } : {}) }));
}

// Historical projection only, never task authority. The actual state must first
// validate its immutable fees, settlement and budget. Reconstruct the exact
// pre-billing evidence to verify its original whole-task fingerprint.
export function productionBillingBaseline(stored: Stored): Stored {
  const base = structuredClone(stored), records = base.productionImageBilling;
  if (!records) return base;
  const snapshot = records[0].snapshot, job = base.aggregate.jobs[0];
  delete base.productionImageBilling; delete base.productionImageBillingFingerprint; delete base.aggregate.productionBilling;
  base.aggregate.audit = base.aggregate.audit.filter(a => !a.eventType.startsWith("production-billing-"));
  base.aggregate.ledger = base.aggregate.ledger.filter(l => l.settlement === "reserved" || l.settlement === "unknown");
  base.aggregate.batch.status = "billing_unknown"; base.aggregate.batch.maxCostMinor = snapshot.maxCostMinor;
  job.status = "billing_unknown"; job.finishedAt = snapshot.unknownAt; job.failureCode = snapshot.unknownReason;
  delete job.actualCostMinor; delete job.billingResolutionId; delete job.billingResolvedAt; delete job.billingResolvedBy; delete job.billingEvidenceRef;
  base.reservedMinor = snapshot.reservedMinor; base.actualMinor = 0; base.jobReservations = [[job.id, snapshot.reservedMinor]];
  return base;
}
export function productionBillingSnapshot(stored: Stored) {
  const e = stored.productionImageExecution!, j = stored.aggregate.jobs[0], l = stored.productionImageLeases!.at(-1)!;
  return ProductionImageBillingSnapshotSchema.parse({ schemaVersion: 1, mode: e.mode, billing: "unknown", settlementAuthorized: false,
    executionAuthorized: false, realExecutionEnabled: false, tenantId: stored.aggregate.batch.tenantId, projectId: stored.aggregate.batch.projectId,
    batchId: e.batchId, jobId: j.id, taskEvidenceFingerprint: fp(stored), executionFingerprint: fp(e), preparationFingerprint: e.preparation.snapshotFingerprint,
    requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256,
    transformedInputsFingerprint: fp(e.protocol.transformedInputs), constraintChecksumSha256: e.protocol.request.constraintChecksumSha256,
    leaseFingerprint: fp(l), leaseId: l.leaseId, workerId: l.workerId, originalActorId: l.actorId,
    intentFingerprint: fp(stored.productionImageDispatchIntent), attemptFingerprint: stored.productionImageAttemptFingerprint ?? null,
    resultFingerprint: stored.productionImageResultFingerprint ?? null, artifactFingerprint: stored.productionImageArtifactFingerprint ?? null,
    outputAssetIds: j.outputAssetIds, unknownAt: j.finishedAt, unknownReason: j.failureCode,
    currency: stored.aggregate.batch.currency, reservedMinor: stored.reservedMinor, maxCostMinor: e.protocol.request.quote.maxCostMinor,
    estimate: j.estimatedCostMinor === null ? { state: "unknown" } : { state: "known", estimatedCostMinor: j.estimatedCostMinor } });
}
export function pendingProductionBillingRecord(record: ProductionImageBillingRecord): ProductionImageBillingRecord {
  const pending = structuredClone(record); delete pending.decision; pending.status = "pending"; return pending;
}
export function assertProductionBillingState(stored: Stored): Stored {
  const records = stored.productionImageBilling;
  if (!records || !records.length || fp(records) !== stored.productionImageBillingFingerprint) throw new Error("生产费用记录缺少完整指纹");
  const base = productionBillingBaseline(stored), snapshot = productionBillingSnapshot(base), hash = fp(snapshot);
  const events = stored.aggregate.audit.filter(a => a.eventType.startsWith("production-billing-"));
  const settled = records.find(r => r.status === "settled"), j = stored.aggregate.jobs[0], b = stored.aggregate.batch;
  let previous = Math.max(Date.parse(snapshot.unknownAt), Date.parse(base.productionImageArtifact?.committedAt ?? snapshot.unknownAt)), eventIndex = 0;
  const reviewIds = new Set<string>(), decisionIds = new Set<string>();
  for (const [index, incoming] of records.entries()) {
    const r = ProductionImageBillingRecordSchema.parse(incoming), at = r.decision?.decidedAt ?? r.reviewedAt;
    if (fp(r.snapshot) !== hash || r.snapshotFingerprint !== hash || r.mode !== snapshot.mode || reviewIds.has(r.request.reviewId)
      || Date.parse(r.reviewedAt) < previous || (index !== records.length - 1 && r.status !== "rejected")) throw new Error("生产费用历史关系损坏");
    reviewIds.add(r.request.reviewId); previous = Date.parse(at);
    const reviewed = events[eventIndex++], initial = r.decision ? pendingProductionBillingRecord(r) : r;
    if (!reviewed || reviewed.eventType !== "production-billing-reviewed" || reviewed.actorId !== r.reviewedBy || reviewed.createdAt !== r.reviewedAt
      || fp(reviewed.metadata) !== fp({ jobId: j.id, reviewId: r.request.reviewId, recordFingerprint: fp(initial) })) throw new Error("生产核账审计损坏");
    if (r.decision) {
      const d = r.decision, event = events[eventIndex++];
      if (decisionIds.has(d.request.decisionId) || d.request.expectedRecordFingerprint !== fp(pendingProductionBillingRecord(r))
        || !event || event.eventType !== `production-billing-${d.request.decision === "approve" ? "approved" : "rejected"}`
        || event.actorId !== d.decidedBy || event.createdAt !== d.decidedAt
        || fp(event.metadata) !== fp({ jobId: j.id, reviewId: r.request.reviewId, decisionId: d.request.decisionId, recordFingerprint: fp(r) })) throw new Error("生产第二人审批审计损坏");
      decisionIds.add(d.request.decisionId);
    }
    if (r.status === "settled") {
      const event = events[eventIndex++];
      if (!event || event.eventType !== "production-billing-settled" || event.actorId !== (r.decision?.decidedBy ?? r.reviewedBy) || event.createdAt !== at
        || fp(event.metadata) !== fp({ jobId: j.id, resolutionId: r.decision?.request.decisionId ?? r.request.reviewId, recordFingerprint: fp(r),
          actualMinor: String(r.request.actualCostMinor), releasedMinor: String(Math.max(0, snapshot.reservedMinor - r.request.actualCostMinor)),
          additionalMinor: String(Math.max(0, r.request.actualCostMinor - snapshot.reservedMinor)) })) throw new Error("生产费用结算审计损坏");
    }
  }
  if (events.length !== eventIndex || fp(stored.aggregate.productionBilling) !== fp(productionBillingSummary(records)) || !stored.productionImageExecution
    || j.finishedAt !== snapshot.unknownAt || b.currency !== snapshot.currency) throw new Error("生产费用聚合损坏");
  if (settled) {
    const at = settled.decision?.decidedAt ?? settled.reviewedAt, amount = settled.request.actualCostMinor, last = stored.aggregate.ledger.at(-1)!;
    if (b.status !== (stored.productionImageArtifact ? "succeeded" : "failed") || j.status !== b.status || stored.reservedMinor !== 0
      || stored.jobReservations.length || stored.actualMinor !== amount || j.actualCostMinor !== amount
      || b.maxCostMinor !== Math.max(snapshot.maxCostMinor, amount) || j.billingResolutionId !== (settled.decision?.request.decisionId ?? settled.request.reviewId)
      || j.billingResolvedBy !== (settled.decision?.decidedBy ?? settled.reviewedBy) || j.billingResolvedAt !== at || j.billingEvidenceRef !== settled.request.evidence.evidenceRef
      || j.failureCode !== (stored.productionImageArtifact ? undefined : "production-billing-settled-no-artifact")
      || stored.aggregate.ledger.length !== base.aggregate.ledger.length + 1 || !last || last.jobId !== j.id || last.actualMinor !== amount
      || last.reservedMinor !== 0 || last.estimatedMinor !== j.estimatedCostMinor || last.createdAt !== at
      || last.settlement !== (amount ? "settled" : "released") || last.imageMode !== snapshot.mode || last.currency !== b.currency
      || last.tenantId !== b.tenantId || last.projectId !== b.projectId || last.batchId !== b.id
      || new Set(stored.aggregate.ledger.map(l => l.id)).size !== stored.aggregate.ledger.length) throw new Error("生产结算与账本/任务不守恒");
  } else if (fp({ ...stored, productionImageBilling: undefined, productionImageBillingFingerprint: undefined,
    aggregate: { ...stored.aggregate, productionBilling: undefined, audit: base.aggregate.audit } }) !== fp({ ...base, productionImageBilling: undefined,
      productionImageBillingFingerprint: undefined, aggregate: { ...base.aggregate, productionBilling: undefined } })) throw new Error("待审批不能修改任务或释放预留");
  return base;
}
