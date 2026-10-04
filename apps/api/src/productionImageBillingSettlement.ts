import { ReviewProductionImageBillingSchema, DecideProductionImageBillingSchema, ProductionImageBillingRecordSchema,
  type ReviewProductionImageBilling, type DecideProductionImageBilling, type ProductionImageBillingRecord } from "@canvas/contracts";
import { RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import { ProductionImageBillingReviewService, ImageProductionBillingReviewHarness, type ProductionBillingSourcePort, type FixtureProductionBillingSourcePort } from "./productionImageBillingReview";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";

type Base = { billingSettlementEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel;
  runAuthorizer: RunAuthorizer; providerAuthorizer: ImageProviderAuthorizer; assetAuthorizer: ObjectStorageAuthorizer; clock?: () => number; maxMetadataBytes?: number };
type Options = Base & { billingSource: ProductionBillingSourcePort | FixtureProductionBillingSourcePort };
function reject(code: string, status = 409): never { throw new RunKernelError(status, code, "生产费用未改变，保持原结论与预留"); }
function strict(v: unknown) {
  if (v && (typeof v === "object" || typeof v === "function") && "then" in v) void Promise.resolve(v).catch(() => undefined);
  if (v !== true) reject("production_image_billing_permission_denied", 403);
}
class SettlementCore {
  private pending?: { principal: RunPrincipal; record: ProductionImageBillingRecord; guard: () => number };
  private active = false;
  constructor(private readonly mode: "production" | "production-contract-fixture", private readonly options?: Options) {}
  readonly billingPolicy = {
    usesStateStore: (store: unknown) => !!this.options && this.options.stateStore === store,
    authorizeScope: (p: RunPrincipal, project: string, approval: boolean) => { this.scope(p, project, approval); return true; },
    validateCommit: (p: RunPrincipal, record: ProductionImageBillingRecord) => {
      const live = this.pending;
      if (!live || fp(p) !== fp(live.principal) || fp(record) !== fp(live.record)) return false;
      live.guard(); return true;
    },
  };
  private scope(p: RunPrincipal, project: string, approval = false) {
    const o = this.options;
    if (!o || o.billingSettlementEnabled !== true || !o.billingSource || !o.stateStore.supportsProductionImageResponses() || !o.stateStore.supportsProductionImageArtifacts()
      || (this.mode === "production" ? o.billingSource.kind !== "server-billing" : o.billingSource.kind !== "contract-fixture" || o.billingSource.realExecutionEnabled !== false)) reject("production_image_billing_not_configured", 503);
    if (!o.tenantId.trim() || o.tenantId !== o.tenantId.trim() || p.tenantId !== o.tenantId || !p.actorId.trim() || p.actorId !== p.actorId.trim()) reject("production_image_billing_permission_denied", 403);
    strict(o.runKernel.usesStateStore(o.stateStore)); strict(o.runAuthorizer.allows(p, project, "run:read"));
    strict(o.runAuthorizer.allows(p, project, "run:reconcile-billing"));
    if (approval) strict(o.runAuthorizer.allows(p, project, "run:approve-billing-overage"));
    strict(o.providerAuthorizer.allows(p, project, "provider:read")); strict(o.assetAuthorizer.allows(p, project, "asset:read"));
  }
  private reviewer() {
    const o = this.options!, config = { ...o, billingReviewEnabled: true as const };
    return this.mode === "production" ? new ProductionImageBillingReviewService({ ...config, billingSource: o.billingSource as ProductionBillingSourcePort })
      : new ImageProductionBillingReviewHarness({ ...config, billingSource: o.billingSource as FixtureProductionBillingSourcePort });
  }
  private guarded<T>(p: RunPrincipal, project: string, approval: boolean, action: (guard: () => number) => T): T {
    try {
      this.scope(p, project, approval); if (this.active) reject("production_image_billing_busy"); this.active = true;
      let latest = -Infinity;
      const guard = () => { this.scope(p, project, approval); const now = (this.options!.clock ?? Date.now)();
        if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime()) || now < latest) reject("production_image_billing_clock_invalid"); latest = now; return now; };
      try { guard(); return this.options!.stateStore.transaction(() => action(guard)); } finally { this.pending = undefined; this.active = false; }
    } catch (e) { if (e instanceof RunKernelError) throw e; reject("production_image_billing_unavailable", 503); }
  }
  private records(p: RunPrincipal, project: string, batch: string, job: string, guard: () => number) {
    guard(); this.reviewer().inspect(p, project, batch, job); guard();
    const stored = this.options!.stateStore.load()!.batches.find(b => b.aggregate.batch.id === batch)!; guard();
    return { stored, records: stored.productionImageBilling ?? [] };
  }
  inspect(p: RunPrincipal, project: string, batch: string, job: string) {
    return this.guarded({ ...p }, project, false, guard => structuredClone(this.records(p, project, batch, job, guard).records));
  }
  settle(p: RunPrincipal, project: string, batch: string, job: string, incoming: ReviewProductionImageBilling) {
    const actor = { ...p };
    return this.guarded(actor, project, false, guard => {
      const request = ReviewProductionImageBillingSchema.parse(incoming), { records } = this.records(actor, project, batch, job, guard);
      const old = records.find(r => r.request.reviewId === request.reviewId);
      if (old) { if (fp(old.request) !== fp(request) || old.reviewedBy !== actor.actorId) reject("production_image_billing_conflict"); return structuredClone(old); }
      if (records.length >= 16 || (records.length && records.at(-1)!.status !== "rejected")) reject("production_image_billing_conflict");
      const frozen = fp(this.options!.stateStore.load());
      // This is an internal fresh verification, not acceptance of an A draft.
      const review = this.reviewer().verify(actor, project, batch, job, request); guard();
      if (fp(this.options!.stateStore.load()) !== frozen) reject("production_image_billing_task_changed");
      const record = ProductionImageBillingRecordSchema.parse({ schemaVersion: 1, mode: this.mode, snapshot: review.snapshot, snapshotFingerprint: review.snapshotFingerprint,
        request, reviewedBy: actor.actorId, reviewedAt: new Date(guard()).toISOString(), sourceKind: review.sourceKind,
        status: review.requiresIndependentOverageApproval ? "pending" : "settled", executionAuthorized: false, realExecutionEnabled: false });
      return this.commit(actor, project, batch, job, record, guard);
    });
  }
  decide(p: RunPrincipal, project: string, batch: string, job: string, reviewId: string, incoming: DecideProductionImageBilling) {
    const actor = { ...p };
    return this.guarded(actor, project, true, guard => {
      const request = DecideProductionImageBillingSchema.parse(incoming), { records } = this.records(actor, project, batch, job, guard), old = records.find(r => r.request.reviewId === reviewId);
      if (!old || old.reviewedBy === actor.actorId) reject("production_image_billing_independent_approval_required", 403);
      if (old.decision) { if (fp(old.decision.request) !== fp(request) || old.decision.decidedBy !== actor.actorId) reject("production_image_billing_conflict"); return structuredClone(old); }
      if (old.status !== "pending" || request.expectedRecordFingerprint !== fp(old) || request.expectedSnapshotFingerprint !== old.snapshotFingerprint
        || request.expectedCurrency !== old.snapshot.currency || request.expectedReservedMinor !== old.snapshot.reservedMinor
        || request.expectedActualCostMinor !== old.request.actualCostMinor || records.some(r => r.decision?.request.decisionId === request.decisionId)) reject("production_image_billing_expectation_mismatch");
      const frozen = fp(this.options!.stateStore.load());
      this.reviewer().verify(actor, project, batch, job, old.request); guard();
      if (fp(this.options!.stateStore.load()) !== frozen) reject("production_image_billing_task_changed");
      const record = ProductionImageBillingRecordSchema.parse({ ...old, status: request.decision === "approve" ? "settled" : "rejected",
        decision: { request, decidedBy: actor.actorId, decidedAt: new Date(guard()).toISOString() } });
      return this.commit(actor, project, batch, job, record, guard);
    });
  }
  private commit(p: RunPrincipal, project: string, batch: string, job: string, record: ProductionImageBillingRecord, guard: () => number) {
    if (Buffer.byteLength(JSON.stringify(record)) > 512 * 1024) reject("production_image_billing_metadata_full", 413);
    this.pending = { principal: { ...p }, record: structuredClone(record), guard }; guard();
    this.options!.runKernel.commitProductionImageBilling(p, record); guard();
    const written = fp(this.options!.stateStore.load());
    strict(this.options!.billingSource.verify(structuredClone({ principal: p, snapshot: record.snapshot, snapshotFingerprint: record.snapshotFingerprint,
      request: record.request, validationAt: new Date(guard()).toISOString() }))); guard();
    const { records } = this.records(p, project, batch, job, guard);
    if (fp(this.options!.stateStore.load()) !== written) reject("production_image_billing_task_changed");
    if (fp(records.find(r => r.request.reviewId === record.request.reviewId)) !== fp(record)) reject("production_image_billing_task_changed");
    const o = this.options!, max = o.maxMetadataBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(max) || max < 0 || max > 16 * 1024 * 1024 || o.stateStore.imageMetadataBytes(p.tenantId, project)
      + imageTaskMetadataBytes(o.stateStore.load(), p.tenantId, project) > max) reject("production_image_billing_metadata_full", 413);
    guard(); return structuredClone(record);
  }
}
export class ProductionImageBillingSettlementService extends SettlementCore { constructor(options?: Base & { billingSource: ProductionBillingSourcePort }) { super("production", options); } }
export class ImageProductionBillingSettlementHarness extends SettlementCore { constructor(options?: Base & { billingSource: FixtureProductionBillingSourcePort }) { super("production-contract-fixture", options); } }
