import { ProductionImageBillingSnapshotSchema, ProductionImageBillingReviewSchema, ReviewProductionImageBillingSchema,
  type ProductionImageBillingSnapshot, type ProductionImageBillingReview, type ReviewProductionImageBilling } from "@canvas/contracts";
import { RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { assertProductionConfirmation } from "./productionImageConfirmationIntegrity";
import { assertProductionImageRawResponse } from "./productionImageResponse";
import { assertProductionImageArtifact } from "./productionImageArtifactIntegrity";
import { assetMetadataFingerprint } from "./assetMetadata";
import { validateProductionImageAssetPolicy } from "./imageAssetPolicy";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";

export type ProductionBillingSourceContext = {
  principal: RunPrincipal; snapshot: ProductionImageBillingSnapshot; snapshotFingerprint: string;
  request: ReviewProductionImageBilling; validationAt: string;
};
// Trusted source implements real human bill verification in future deployment.
// A label, digest, schema, response usage or a caller's draft is not that proof.
export interface ProductionBillingSourcePort { kind: "server-billing"; verify(context: ProductionBillingSourceContext): boolean }
export interface FixtureProductionBillingSourcePort { kind: "contract-fixture"; realExecutionEnabled: false; verify(context: ProductionBillingSourceContext): boolean }
type Base = { billingReviewEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel;
  runAuthorizer: RunAuthorizer; providerAuthorizer: ImageProviderAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
  clock?: () => number; maxMetadataBytes?: number };
type Options = Base & { billingSource: ProductionBillingSourcePort | FixtureProductionBillingSourcePort };
function reject(code: string, status = 409): never { throw new RunKernelError(status, code, "生产费用未结算，原任务和未知预留保持"); }
function strict(value: unknown): void {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => undefined);
  if (value !== true) reject("production_image_billing_review_permission_denied", 403);
}
class ReviewCore {
  constructor(private readonly mode: ProductionImageBillingSnapshot["mode"], private readonly options?: Options) {}
  private scope(p: RunPrincipal, project: string): void {
    const o = this.options;
    if (!o || o.billingReviewEnabled !== true || !o.stateStore.supportsProductionImageResponses() || !o.stateStore.supportsProductionImageArtifacts()
      || !o.billingSource || (this.mode === "production" ? o.billingSource.kind !== "server-billing"
        : o.billingSource.kind !== "contract-fixture" || o.billingSource.realExecutionEnabled !== false)) reject("production_image_billing_review_not_configured", 503);
    if (!o.tenantId.trim() || o.tenantId !== o.tenantId.trim() || p.tenantId !== o.tenantId || !p.actorId.trim() || p.actorId !== p.actorId.trim()) reject("production_image_billing_review_permission_denied", 403);
    strict(o.runKernel.usesStateStore(o.stateStore));
    strict(o.runAuthorizer.allows(p, project, "run:read")); strict(o.runAuthorizer.allows(p, project, "run:reconcile-billing"));
    strict(o.providerAuthorizer.allows(p, project, "provider:read")); strict(o.assetAuthorizer.allows(p, project, "asset:read"));
  }
  private safe<T>(action: () => T): T {
    try { return action(); } catch (error) { if (error instanceof RunKernelError) throw error; reject("production_image_billing_review_unavailable", 503); }
  }
  private guard(p: RunPrincipal, project: string) {
    let latest = -Infinity;
    return () => {
      this.scope(p, project); const now = (this.options!.clock ?? Date.now)();
      if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime()) || now < latest) reject("production_image_billing_review_clock_invalid");
      latest = now; return now;
    };
  }
  // Purely read-only and current. No run:execute or borrowed original actor:
  // the reviewer may be a different independently authorized person.
  inspect(p: RunPrincipal, project: string, batch: string, job: string): ProductionImageBillingSnapshot {
    return this.safe(() => { this.scope(p, project); const guard = this.guard({ ...p }, project);
      return this.options!.stateStore.transaction(() => this.read(p, project, batch, job, guard)); });
  }
  private read(p: RunPrincipal, project: string, batch: string, job: string, guard: () => number): ProductionImageBillingSnapshot {
    const o = this.options!; guard(); const snapshot = o.stateStore.load(); guard();
    if (!snapshot) reject("production_image_billing_review_task_missing");
    o.runKernel.validateProductionBillingSnapshot(snapshot);
    const stored = snapshot.batches.find(s => s.aggregate.batch.id === batch && s.aggregate.batch.tenantId === p.tenantId && s.aggregate.batch.projectId === project);
    const e = stored?.productionImageExecution, j = stored?.aggregate.jobs[0], lease = stored?.productionImageLeases?.at(-1), intent = stored?.productionImageDispatchIntent;
    if (!stored || !e || e.mode !== this.mode || !j || j.id !== job || j.status !== "billing_unknown" || !lease || !intent
      || !j.finishedAt || !j.failureCode) reject("production_image_billing_review_task_not_unknown");
    assertProductionConfirmation(e);
    const budget = snapshot.budgets.find(b => b.tenantId === p.tenantId && b.projectId === project);
    if (!budget || budget.currency !== e.protocol.request.quote.currency || budget.reservedMinor + budget.spentMinor > budget.limitMinor) reject("production_image_billing_review_budget_mismatch");
    const max = o.maxMetadataBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(max) || max < 0 || max > 16 * 1024 * 1024
      || o.stateStore.imageMetadataBytes(p.tenantId, project) + imageTaskMetadataBytes(snapshot, p.tenantId, project) > max) reject("production_image_billing_review_metadata_full", 413);
    guard(); const preparation = o.stateStore.loadProductionImagePreparation(p.tenantId, project, this.mode, e.preparation.id); guard();
    if (!preparation || fp(preparation) !== fp(e.preparation)) reject("production_image_billing_review_preparation_changed");
    // No current price read/verify or enabled-directory dependency for history.
    // Guard before/after each original file, preserving order and full receipts.
    validateProductionImageAssetPolicy(o.stateStore, e.protocol.request, () => { guard(); }); guard();
    const artifact = o.stateStore.loadProductionImageArtifact(p.tenantId, project, this.mode, job); guard();
    let raw: ReturnType<SqliteRunKernelStateStore["loadProductionImageResponse"]> = null;
    try {
      guard(); raw = o.stateStore.loadProductionImageResponse(p.tenantId, project, this.mode, job); guard();
      if (stored.productionImageResult?.kind === "returned") {
        if (!raw || fp(raw.record) !== stored.productionImageResultFingerprint || fp(raw.record) !== fp(stored.productionImageResult)) reject("production_image_billing_review_response_changed");
        const parsed = assertProductionImageRawResponse(raw.record, e, lease, intent, stored.productionImageAttempt, raw.body);
        try {
          if (stored.productionImageArtifact) {
            if (!artifact || fp(artifact) !== stored.productionImageArtifactFingerprint || fp(artifact) !== fp(stored.productionImageArtifact)) reject("production_image_billing_review_artifact_changed");
            assertProductionImageArtifact(stored, artifact); guard();
            const asset = o.stateStore.loadCatalog()?.projects.find(v => v.projectId === project)?.assets.find(a => a.id === artifact.image.asset.id); guard();
            if (!asset || assetMetadataFingerprint(asset) !== artifact.image.registeredMetadataSha256 || !parsed.candidate
              || parsed.candidate.checksumSha256 !== artifact.image.checksumSha256 || parsed.candidate.mimeType !== asset.mimeType
              || parsed.candidate.body.length !== asset.byteSize) reject("production_image_billing_review_artifact_changed");
          } else if (artifact) reject("production_image_billing_review_orphan_artifact");
        } finally { parsed.candidate?.body.fill(0); }
      } else if (raw || artifact || stored.productionImageArtifact) reject("production_image_billing_review_orphan_response");
    } finally { raw?.body.fill(0); }
    // The later response/artifact reads may invoke trusted hooks. Do not return
    // a view based only on the catalog captured before those reads.
    guard(); validateProductionImageAssetPolicy(o.stateStore, e.protocol.request, () => { guard(); }); guard();
    const last = stored.productionImageArtifact?.committedAt ?? (stored.productionImageResult?.kind === "returned" ? stored.productionImageResult.receivedAt
      : stored.productionImageResult?.kind === "interrupted" ? stored.productionImageResult.interruptedAt : j.finishedAt);
    if (guard() < Math.max(Date.parse(last), Date.parse(j.finishedAt))) reject("production_image_billing_review_clock_invalid");
    const view = ProductionImageBillingSnapshotSchema.parse({ schemaVersion: 1, mode: this.mode, billing: "unknown", settlementAuthorized: false,
      executionAuthorized: false, realExecutionEnabled: false, tenantId: p.tenantId, projectId: project, batchId: batch, jobId: job,
      taskEvidenceFingerprint: fp(stored), executionFingerprint: fp(e), preparationFingerprint: e.preparation.snapshotFingerprint,
      requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256,
      transformedInputsFingerprint: fp(e.protocol.transformedInputs), constraintChecksumSha256: e.protocol.request.constraintChecksumSha256,
      leaseFingerprint: fp(lease), leaseId: lease.leaseId, workerId: lease.workerId, originalActorId: lease.actorId,
      intentFingerprint: fp(intent), attemptFingerprint: stored.productionImageAttemptFingerprint ?? null,
      resultFingerprint: stored.productionImageResultFingerprint ?? null, artifactFingerprint: stored.productionImageArtifactFingerprint ?? null,
      outputAssetIds: j.outputAssetIds, unknownAt: j.finishedAt, unknownReason: j.failureCode,
      currency: j.imageMode ? stored.aggregate.batch.currency : "", reservedMinor: stored.reservedMinor, maxCostMinor: e.protocol.request.quote.maxCostMinor,
      estimate: j.estimatedCostMinor === null ? { state: "unknown" } : { state: "known", estimatedCostMinor: j.estimatedCostMinor } });
    if (Buffer.byteLength(JSON.stringify(view)) > 512 * 1024) reject("production_image_billing_review_metadata_full", 413);
    guard(); if (fp(o.stateStore.load()?.batches.find(s => s.aggregate.batch.id === batch)) !== fp(stored)) reject("production_image_billing_review_task_changed"); guard();
    return view;
  }
  verify(p: RunPrincipal, project: string, batch: string, job: string, incoming: ReviewProductionImageBilling): ProductionImageBillingReview {
    return this.safe(() => {
      this.scope(p, project); const actor = { ...p }, request = ReviewProductionImageBillingSchema.parse(incoming), o = this.options!, guard = this.guard(actor, project);
      return o.stateStore.transaction(() => {
        const snapshot = this.read(actor, project, batch, job, guard), hash = fp(snapshot);
        if (request.expectedSnapshotFingerprint !== hash || request.expectedCurrency !== snapshot.currency || request.expectedReservedMinor !== snapshot.reservedMinor
          || request.expectedMaxCostMinor !== snapshot.maxCostMinor) reject("production_image_billing_review_expectation_mismatch");
        const now = guard();
        if (Date.parse(request.evidence.observedAt) > now || Date.parse(request.evidence.observedAt) < Date.parse(snapshot.unknownAt)) reject("production_image_billing_review_evidence_time_invalid");
        const context: ProductionBillingSourceContext = { principal: actor, snapshot, snapshotFingerprint: hash, request, validationAt: new Date(now).toISOString() };
        strict(o.billingSource.verify(structuredClone(context))); guard();
        // Verify receives copies and cannot authorize mutation of the original
        // task/inputs. Re-read all current evidence after the trusted callback.
        if (fp(this.read(actor, project, batch, job, guard)) !== hash) reject("production_image_billing_review_task_changed");
        const review = ProductionImageBillingReviewSchema.parse({ schemaVersion: 1, mode: this.mode, validation: "verified-uncommitted",
          settlementCommitted: false, settlementAuthorized: false, executionAuthorized: false, realExecutionEnabled: false,
          snapshot, snapshotFingerprint: hash, request, reviewedBy: actor.actorId, reviewedAt: new Date(guard()).toISOString(),
          sourceKind: o.billingSource.kind, requiresIndependentOverageApproval: request.actualCostMinor > snapshot.reservedMinor });
        if (Buffer.byteLength(JSON.stringify(review)) > 512 * 1024) reject("production_image_billing_review_metadata_full", 413);
        guard(); return review;
      });
    });
  }
}
export class ProductionImageBillingReviewService extends ReviewCore { constructor(options?: Base & { billingSource: ProductionBillingSourcePort }) { super("production", options); } }
export class ImageProductionBillingReviewHarness extends ReviewCore { constructor(options?: Base & { billingSource: FixtureProductionBillingSourcePort }) { super("production-contract-fixture", options); } }
