import { LockedProductionImageBillingReviewSchema, ReviewLockedProductionImageBillingSchema,
  type LockedProductionImageBillingSnapshot, type ReviewLockedProductionImageBilling } from "@canvas/contracts";
import { RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { readLockedProductionBillingEvidence } from "./lockedProductionImageBillingRead";

export type LockedBillingSourceContext = { principal: RunPrincipal; snapshot: LockedProductionImageBillingSnapshot; snapshotFingerprint: string;
  request: ReviewLockedProductionImageBilling; validationAt: string };
export interface LockedBillingSourcePort { kind: "server-billing"; verify(c: LockedBillingSourceContext): boolean }
export interface FixtureLockedBillingSourcePort { kind: "contract-fixture"; realExecutionEnabled: false; verify(c: LockedBillingSourceContext): boolean }
type Base = { lockedBillingReviewEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel;
  lockedBillingReviewPolicy(c: { principal: RunPrincipal; projectId: string; mode: LockedProductionImageBillingSnapshot["mode"] }): boolean;
  runAuthorizer: RunAuthorizer; providerAuthorizer: ImageProviderAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
  clock?: () => number; timeoutMs?: number; maxMetadataBytes?: number };
type Options = Base & { billingSource: LockedBillingSourcePort | FixtureLockedBillingSourcePort };
function reject(code: string, status = 409): never { throw new RunKernelError(status, code, "保护费用未结算，请保留原任务与未知预留"); }
function strict(v: unknown) {
  if (v && (typeof v === "object" || typeof v === "function") && "then" in v) void Promise.resolve(v).catch(() => undefined);
  if (v !== true) reject("locked_billing_permission_denied", 403);
}
class LockedReviewCore {
  private readonly options?: Options;
  constructor(private readonly mode: LockedProductionImageBillingSnapshot["mode"], options?: Options) {
    this.options = options && { ...options,
      runAuthorizer: { ...options.runAuthorizer, allows: options.runAuthorizer.allows.bind(options.runAuthorizer) },
      providerAuthorizer: { ...options.providerAuthorizer, allows: options.providerAuthorizer.allows.bind(options.providerAuthorizer) },
      assetAuthorizer: { ...options.assetAuthorizer, allows: options.assetAuthorizer.allows.bind(options.assetAuthorizer) },
      billingSource: { ...options.billingSource, verify: options.billingSource.verify.bind(options.billingSource) } };
  }
  private scope(p: RunPrincipal, project: string) {
    const o = this.options;
    if (!o || o.lockedBillingReviewEnabled !== true || typeof o.lockedBillingReviewPolicy !== "function" || !o.billingSource
      || !o.stateStore.supportsProductionImageResponses() || !o.stateStore.supportsProductionImageArtifacts()
      || (this.mode === "production" ? o.billingSource.kind !== "server-billing" : o.billingSource.kind !== "contract-fixture" || o.billingSource.realExecutionEnabled !== false)) reject("locked_billing_not_configured", 503);
    if (!o.tenantId || o.tenantId !== o.tenantId.trim() || o.tenantId.length > 160 || p.tenantId !== o.tenantId || !p.actorId || p.actorId !== p.actorId.trim() || p.actorId.length > 160) reject("locked_billing_permission_denied", 403);
    strict(o.runKernel.usesStateStore(o.stateStore)); strict(o.lockedBillingReviewPolicy(structuredClone({ principal: p, projectId: project, mode: this.mode })));
    strict(o.runAuthorizer.allows(structuredClone(p), project, "run:read")); strict(o.runAuthorizer.allows(structuredClone(p), project, "run:reconcile-billing"));
    strict(o.providerAuthorizer.allows(structuredClone(p), project, "provider:read")); strict(o.assetAuthorizer.allows(structuredClone(p), project, "asset:read"));
  }
  private operate<T>(principal: RunPrincipal, project: string, batch: string, job: string,
    action: (read: () => ReturnType<typeof readLockedProductionBillingEvidence>, guard: () => number, pure: () => number) => T, signal?: AbortSignal): T {
    try {
      const p = structuredClone(principal); this.scope(p, project); const o = this.options!, max = o.maxMetadataBytes ?? 16 * 1024 * 1024, timeout = o.timeoutMs ?? 5000;
      if (!Number.isSafeInteger(max) || max < 0 || max > 16 * 1024 * 1024 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) reject("locked_billing_configuration_invalid");
      const clock = o.clock ?? Date.now, wall = performance.now(), start = clock(); let last = start;
      const methods = [o.runKernel.usesStateStore, o.runKernel.validateProductionBillingSnapshot, o.runKernel.captureLockedProductionBillingReadConfiguration];
      const fixed = o.runKernel.captureLockedProductionBillingReadConfiguration(o.stateStore);
      const kernel = { validateProductionBillingSnapshot: o.runKernel.validateProductionBillingSnapshot.bind(o.runKernel) };
      const pure = () => {
        if (signal?.aborted) reject("locked_billing_cancelled", 499);
        if (o.runKernel.usesStateStore !== methods[0] || o.runKernel.validateProductionBillingSnapshot !== methods[1]
          || o.runKernel.captureLockedProductionBillingReadConfiguration !== methods[2]) reject("locked_billing_configuration_changed");
        fixed(); const now = clock();
        if (!Number.isSafeInteger(start) || start < 0 || start > 8_640_000_000_000_000 - 30000 || !Number.isSafeInteger(now) || now < last
          || now - start >= timeout || performance.now() - wall >= timeout) reject("locked_billing_clock_invalid"); last = now; return now;
      };
      const guard = () => { this.scope(p, project); return pure(); };
      return o.stateStore.transaction(() => {
        const read = () => {
          guard(); const first = readLockedProductionBillingEvidence(o.stateStore, kernel, p, project, batch, job, this.mode, guard, max);
          // Last permission callback can mutate authority. Afterwards only pure
          // evidence/time checks, including actual raw/output byte reads.
          guard(); const final = readLockedProductionBillingEvidence(o.stateStore, kernel, p, project, batch, job, this.mode, pure, max); pure();
          if (fp(first) !== fp(final)) reject("locked_billing_evidence_changed"); return final;
        };
        const value = action(read, guard, pure); pure(); return value;
      });
    } catch (e) { if (e instanceof RunKernelError) throw e; reject("locked_billing_unavailable", 503); }
  }
  inspect(p: RunPrincipal, project: string, batch: string, job: string, signal?: AbortSignal): LockedProductionImageBillingSnapshot {
    return this.operate(p, project, batch, job, read => read().view, signal);
  }
  verify(p: RunPrincipal, project: string, batch: string, job: string, incoming: ReviewLockedProductionImageBilling, signal?: AbortSignal) {
    const actor = structuredClone(p);
    return this.operate(actor, project, batch, job, (read, guard, pure) => {
      const request = ReviewLockedProductionImageBillingSchema.parse(incoming), first = read(), snapshot = first.view, hash = fp(snapshot);
      if (request.expectedSnapshotFingerprint !== hash || request.expectedProtectionPolicyFingerprint !== snapshot.protectionPolicyFingerprint
        || request.expectedCurrency !== snapshot.currency || request.expectedReservedMinor !== snapshot.reservedMinor || request.expectedMaxCostMinor !== snapshot.maxCostMinor) reject("locked_billing_expectation_mismatch");
      const now = guard(); if (Date.parse(request.evidence.observedAt) < Date.parse(snapshot.unknownAt) || Date.parse(request.evidence.observedAt) > now) reject("locked_billing_evidence_time_invalid");
      strict(this.options!.billingSource.verify(structuredClone({ principal: actor, snapshot, snapshotFingerprint: hash, request, validationAt: new Date(now).toISOString() }))); guard();
      if (fp(read()) !== fp(first)) reject("locked_billing_evidence_changed");
      const review = LockedProductionImageBillingReviewSchema.parse({ schemaVersion: 2, mode: this.mode, validation: "verified-uncommitted",
        settlementCommitted: false, settlementAuthorized: false, executionAuthorized: false, realExecutionEnabled: false, snapshot, snapshotFingerprint: hash,
        request, reviewedBy: actor.actorId, reviewedAt: new Date(pure()).toISOString(), sourceKind: this.options!.billingSource.kind,
        requiresIndependentOverageApproval: request.actualCostMinor > snapshot.reservedMinor });
      if (Buffer.byteLength(JSON.stringify(review)) > 512 * 1024) reject("locked_billing_metadata_full", 413); pure(); return review;
    }, signal);
  }
}
export class LockedProductionImageBillingReviewService extends LockedReviewCore { constructor(options?: Base & { billingSource: LockedBillingSourcePort }) { super("production", options); } }
export class LockedImageProductionBillingReviewHarness extends LockedReviewCore { constructor(options?: Base & { billingSource: FixtureLockedBillingSourcePort }) { super("production-contract-fixture", options); } }
