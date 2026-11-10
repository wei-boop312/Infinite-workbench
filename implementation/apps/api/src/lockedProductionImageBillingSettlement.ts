import { LockedProductionImageBillingRecordSchema, ReviewLockedProductionImageBillingSchema, DecideLockedProductionImageBillingSchema,
  type LockedProductionImageBillingRecord, type LockedProductionImageBillingSnapshot, type ReviewLockedProductionImageBilling, type DecideLockedProductionImageBilling } from "@canvas/contracts";
import { RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { readLockedProductionBillingEvidence } from "./lockedProductionImageBillingRead";
import type { LockedBillingSourcePort, FixtureLockedBillingSourcePort } from "./lockedProductionImageBillingReview";

type Base = { lockedBillingSettlementEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel;
  lockedBillingSettlementPolicy(c: { principal: RunPrincipal; projectId: string; mode: LockedProductionImageBillingSnapshot["mode"]; approval: boolean }): boolean;
  runAuthorizer: RunAuthorizer; providerAuthorizer: ImageProviderAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
  clock?: () => number; timeoutMs?: number; maxMetadataBytes?: number };
type Options = Base & { billingSource: LockedBillingSourcePort | FixtureLockedBillingSourcePort };
function reject(code: string, status = 409): never { throw new RunKernelError(status, code, "保护费用未改变，请保留原任务结论和预留"); }
function strict(v: unknown) {
  if (v && (typeof v === "object" || typeof v === "function") && "then" in v) void Promise.resolve(v).catch(() => undefined);
  if (v !== true) reject("locked_billing_permission_denied", 403);
}
function port(action: () => unknown): unknown { try { return action(); } catch { reject("locked_billing_policy_unavailable", 503); } }
class LockedSettlementCore {
  private readonly options?: Options;
  private pending?: { principal: RunPrincipal; record: LockedProductionImageBillingRecord; guard: () => number; originalSnapshot: string; originalCatalog: string };
  private active = false;
  constructor(private readonly mode: LockedProductionImageBillingSnapshot["mode"], options?: Options) {
    this.options = options && { ...options,
      runAuthorizer: { ...options.runAuthorizer, allows: options.runAuthorizer.allows.bind(options.runAuthorizer) },
      providerAuthorizer: { ...options.providerAuthorizer, allows: options.providerAuthorizer.allows.bind(options.providerAuthorizer) },
      assetAuthorizer: { ...options.assetAuthorizer, allows: options.assetAuthorizer.allows.bind(options.assetAuthorizer) },
      billingSource: { ...options.billingSource, verify: options.billingSource.verify.bind(options.billingSource) } };
  }
  readonly billingPolicy = {
    usesStateStore: (store: unknown) => !!this.options && this.options.stateStore === store,
    authorizeScope: (p: RunPrincipal, project: string, approval: boolean) => { this.scope(p, project, approval); return true; },
    validateCommit: (p: RunPrincipal, record: LockedProductionImageBillingRecord) => {
      const live = this.pending;
      if (!live || fp(p) !== fp(live.principal) || fp(record) !== fp(live.record)) return false;
      live.guard(); return true;
    },
    validateOriginal: (p: RunPrincipal, record: LockedProductionImageBillingRecord) => {
      const live = this.pending;
      if (!live || fp(p) !== fp(live.principal) || fp(record) !== fp(live.record)) return false;
      live.guard(); return fp(this.options!.stateStore.load()) === live.originalSnapshot && fp(this.options!.stateStore.loadCatalog()) === live.originalCatalog;
    },
  };
  private scope(p: RunPrincipal, project: string, approval: boolean) {
    const o = this.options;
    if (!o || o.lockedBillingSettlementEnabled !== true || typeof o.lockedBillingSettlementPolicy !== "function" || !o.billingSource
      || !o.stateStore.supportsProductionImageResponses() || !o.stateStore.supportsProductionImageArtifacts()
      || (this.mode === "production" ? o.billingSource.kind !== "server-billing" : o.billingSource.kind !== "contract-fixture" || o.billingSource.realExecutionEnabled !== false)) reject("locked_billing_not_configured", 503);
    if (!o.tenantId || o.tenantId !== o.tenantId.trim() || o.tenantId.length > 160 || p.tenantId !== o.tenantId || !p.actorId || p.actorId !== p.actorId.trim() || p.actorId.length > 160) reject("locked_billing_permission_denied", 403);
    strict(port(() => o.runKernel.usesStateStore(o.stateStore))); strict(port(() => o.lockedBillingSettlementPolicy(structuredClone({ principal: p, projectId: project, mode: this.mode, approval }))));
    strict(port(() => o.runAuthorizer.allows(structuredClone(p), project, "run:read"))); strict(port(() => o.runAuthorizer.allows(structuredClone(p), project, "run:reconcile-billing")));
    if (approval) strict(port(() => o.runAuthorizer.allows(structuredClone(p), project, "run:approve-billing-overage")));
    strict(port(() => o.providerAuthorizer.allows(structuredClone(p), project, "provider:read"))); strict(port(() => o.assetAuthorizer.allows(structuredClone(p), project, "asset:read")));
  }
  private operate<T>(principal: RunPrincipal, project: string, batch: string, job: string, approval: boolean,
    action: (read: () => ReturnType<typeof readLockedProductionBillingEvidence>, guard: () => number, pure: () => number) => T, signal?: AbortSignal): T {
    try {
      const p = structuredClone(principal); this.scope(p, project, approval); if (this.active) reject("locked_billing_busy");
      const o = this.options!, max = o.maxMetadataBytes ?? 16 * 1024 * 1024, timeout = o.timeoutMs ?? 5000;
      if (!Number.isSafeInteger(max) || max < 0 || max > 16 * 1024 * 1024 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) reject("locked_billing_configuration_invalid");
      const clock = o.clock ?? Date.now, wall = performance.now(), start = clock(); let last = start;
      const methods = [o.runKernel.usesStateStore, o.runKernel.validateProductionBillingSnapshot, o.runKernel.captureLockedProductionBillingReadConfiguration, o.runKernel.commitLockedProductionImageBilling];
      const fixed = o.runKernel.captureLockedProductionBillingReadConfiguration(o.stateStore), kernel = { validateProductionBillingSnapshot: o.runKernel.validateProductionBillingSnapshot.bind(o.runKernel) };
      const pure = () => {
        if (signal?.aborted) reject("locked_billing_cancelled", 499);
        if (methods.some((f,i) => f !== [o.runKernel.usesStateStore,o.runKernel.validateProductionBillingSnapshot,o.runKernel.captureLockedProductionBillingReadConfiguration,o.runKernel.commitLockedProductionImageBilling][i])) reject("locked_billing_configuration_changed");
        fixed(); const now = clock();
        if (!Number.isSafeInteger(start) || start < 0 || start > 8_640_000_000_000_000 - 30000 || !Number.isSafeInteger(now) || now < last
          || now - start >= timeout || performance.now() - wall >= timeout) reject("locked_billing_clock_invalid"); last = now; return now;
      };
      const guard = () => { this.scope(p, project, approval); return pure(); };
      this.active = true;
      try { return o.stateStore.transaction(() => {
        const read = () => {
          guard(); const first = readLockedProductionBillingEvidence(o.stateStore, kernel, p, project, batch, job, this.mode, guard, max);
          guard(); const final = readLockedProductionBillingEvidence(o.stateStore, kernel, p, project, batch, job, this.mode, pure, max); pure();
          if (fp(first) !== fp(final)) reject("locked_billing_evidence_changed"); return final;
        };
        const value = action(read, guard, pure); pure(); return value;
      }); } finally { this.pending = undefined; this.active = false; }
    } catch (e) { if (e instanceof RunKernelError) throw e; reject("locked_billing_unavailable", 503); }
  }
  inspect(p: RunPrincipal, project: string, batch: string, job: string, signal?: AbortSignal) {
    return this.operate(p, project, batch, job, false, read => read().records, signal);
  }
  private verify(p: RunPrincipal, request: ReviewLockedProductionImageBilling, evidence: ReturnType<typeof readLockedProductionBillingEvidence>, guard: () => number) {
    const snapshot = evidence.view, hash = fp(snapshot), now = guard();
    if (request.expectedSnapshotFingerprint !== hash || request.expectedProtectionPolicyFingerprint !== snapshot.protectionPolicyFingerprint
      || request.expectedCurrency !== snapshot.currency || request.expectedReservedMinor !== snapshot.reservedMinor || request.expectedMaxCostMinor !== snapshot.maxCostMinor) reject("locked_billing_expectation_mismatch");
    if (Date.parse(request.evidence.observedAt) < Date.parse(snapshot.unknownAt) || Date.parse(request.evidence.observedAt) > now) reject("locked_billing_evidence_time_invalid");
    strict(port(() => this.options!.billingSource.verify(structuredClone({ principal: p, snapshot, snapshotFingerprint: hash, request, validationAt: new Date(now).toISOString() })))); guard();
  }
  settle(p: RunPrincipal, project: string, batch: string, job: string, incoming: ReviewLockedProductionImageBilling, signal?: AbortSignal) {
    const actor = structuredClone(p);
    return this.operate(actor, project, batch, job, false, (read, guard, pure) => {
      const request = ReviewLockedProductionImageBillingSchema.parse(incoming), first = read(), records = first.records, old = records.find(r => r.request.reviewId === request.reviewId);
      if (old) { if (fp(old.request) !== fp(request) || old.reviewedBy !== actor.actorId) reject("locked_billing_conflict"); return structuredClone(old); }
      if (records.length >= 16 || (records.length && records.at(-1)!.status !== "rejected")) reject("locked_billing_conflict");
      this.verify(actor, request, first, guard); if (fp(read()) !== fp(first)) reject("locked_billing_evidence_changed");
      const record = LockedProductionImageBillingRecordSchema.parse({ schemaVersion: 2, mode: this.mode, snapshot: first.view, snapshotFingerprint: fp(first.view),
        request, reviewedBy: actor.actorId, reviewedAt: new Date(pure()).toISOString(), sourceKind: this.options!.billingSource.kind,
        status: request.actualCostMinor > first.view.reservedMinor ? "pending" : "settled", executionAuthorized: false, realExecutionEnabled: false });
      return this.commit(actor, batch, record, first, read, guard, pure);
    }, signal);
  }
  decide(p: RunPrincipal, project: string, batch: string, job: string, reviewId: string, incoming: DecideLockedProductionImageBilling, signal?: AbortSignal) {
    const actor = structuredClone(p);
    return this.operate(actor, project, batch, job, true, (read, guard, pure) => {
      const request = DecideLockedProductionImageBillingSchema.parse(incoming), first = read(), records = first.records, old = records.find(r => r.request.reviewId === reviewId);
      if (!old || old.reviewedBy === actor.actorId) reject("locked_billing_independent_approval_required", 403);
      if (old.decision) { if (fp(old.decision.request) !== fp(request) || old.decision.decidedBy !== actor.actorId) reject("locked_billing_conflict"); return structuredClone(old); }
      if (old.status !== "pending" || request.expectedRecordFingerprint !== fp(old) || request.expectedSnapshotFingerprint !== old.snapshotFingerprint
        || request.expectedProtectionPolicyFingerprint !== old.snapshot.protectionPolicyFingerprint || request.expectedCurrency !== old.snapshot.currency
        || request.expectedReservedMinor !== old.snapshot.reservedMinor || request.expectedActualCostMinor !== old.request.actualCostMinor
        || records.some(r => r.decision?.request.decisionId === request.decisionId)) reject("locked_billing_expectation_mismatch");
      this.verify(actor, old.request, first, guard); if (fp(read()) !== fp(first)) reject("locked_billing_evidence_changed");
      const record = LockedProductionImageBillingRecordSchema.parse({ ...old, status: request.decision === "approve" ? "settled" : "rejected",
        decision: { request, decidedBy: actor.actorId, decidedAt: new Date(pure()).toISOString() } });
      return this.commit(actor, batch, record, first, read, guard, pure);
    }, signal);
  }
  private commit(p: RunPrincipal, batch: string, record: LockedProductionImageBillingRecord, first: ReturnType<typeof readLockedProductionBillingEvidence>, read: () => ReturnType<typeof readLockedProductionBillingEvidence>, guard: () => number, pure: () => number) {
    if (Buffer.byteLength(JSON.stringify(record)) > 512 * 1024) reject("locked_billing_metadata_full", 413);
    this.pending = { principal: structuredClone(p), record: structuredClone(record), guard, originalSnapshot: first.snapshotFingerprint, originalCatalog: first.catalogFingerprint }; guard();
    if (this.billingPolicy.validateOriginal(p, record) !== true) reject("locked_billing_evidence_changed");
    this.options!.runKernel.commitLockedProductionImageBilling(p, record);
    const written = fp(this.options!.stateStore.load()), catalog = fp(this.options!.stateStore.loadCatalog());
    const current = read(); this.verify(p, record.request, current, guard);
    const final = read(); pure();
    if (final.snapshotFingerprint !== written || final.catalogFingerprint !== catalog
      || fp(final.records.find(r => r.request.reviewId === record.request.reviewId)) !== fp(record)) reject("locked_billing_evidence_changed");
    pure(); return structuredClone(record);
  }
}
export class LockedProductionImageBillingSettlementService extends LockedSettlementCore { constructor(options?: Base & { billingSource: LockedBillingSourcePort }) { super("production", options); } }
export class LockedImageProductionBillingSettlementHarness extends LockedSettlementCore { constructor(options?: Base & { billingSource: FixtureLockedBillingSourcePort }) { super("production-contract-fixture", options); } }
