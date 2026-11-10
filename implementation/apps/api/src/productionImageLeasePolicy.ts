import type { ConfirmedProductionImageExecution } from "@canvas/contracts";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import type { ProductionImagePricePort, FixtureProductionImagePricePort, ImagePriceContext } from "./productionImagePreparations";
import { assertProductionConfirmation } from "./productionImageConfirmationIntegrity";
import { imageSnapshotFingerprint, validateProductionImageProviderRequest } from "./imageProviderContract";
import { validateProductionImageAssetPolicy } from "./imageAssetPolicy";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";
import { RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";

export type ProductionImageLeasePurpose = "claim" | "inspect" | "start" | "history" | "reconcile";
export interface ProductionImageLeasePolicy {
  usesStateStore(store: SqliteRunKernelStateStore): boolean;
  authorizeScope(principal: RunPrincipal, projectId: string): boolean;
  validate(principal: RunPrincipal, execution: ConfirmedProductionImageExecution, purpose: ProductionImageLeasePurpose, extraBytes: number): boolean;
}
type Base = { leasePreparationEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore;
  runAuthorizer: RunAuthorizer; providerAuthorizer: ImageProviderAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
  clock?: () => number; maxMetadataBytes?: number };
function reject(code: string, status = 409): never { throw new RunKernelError(status, code, "生产租约未通过服务端核验，未发送请求"); }
function strict(check: () => unknown): void {
  const value = check();
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => undefined);
  if (value !== true) reject("production_image_lease_permission_denied", 403);
}
function create(mode: ConfirmedProductionImageExecution["mode"], options?: Base & { pricePort: ProductionImagePricePort | FixtureProductionImagePricePort }): ProductionImageLeasePolicy {
  if (!options || options.leasePreparationEnabled !== true || !options.tenantId.trim() || options.tenantId !== options.tenantId.trim()
    || !options.pricePort || (mode === "production" ? options.pricePort.kind !== "server-pricing"
      : options.pricePort.kind !== "contract-fixture" || options.pricePort.realExecutionEnabled !== false)) reject("production_image_lease_not_configured", 503);
  const o = options, quota = o.maxMetadataBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(quota) || quota < 0 || quota > 16 * 1024 * 1024) reject("production_image_lease_configuration_invalid");
  const scope = (p: RunPrincipal, project: string): boolean => {
    try {
      if (p.tenantId !== o.tenantId) reject("production_image_lease_permission_denied", 403);
      strict(() => o.runAuthorizer.allows(p, project, "run:read")); strict(() => o.runAuthorizer.allows(p, project, "run:execute"));
      strict(() => o.providerAuthorizer.allows(p, project, "provider:read")); strict(() => o.assetAuthorizer.allows(p, project, "asset:read"));
      return true;
    } catch (error) { if (error instanceof RunKernelError) throw error; reject("production_image_lease_policy_unavailable", 503); }
  };
  return { usesStateStore: (store) => store === o.stateStore, authorizeScope: scope,
    validate: (p, incoming, purpose, extraBytes) => {
      try {
        // Scope is checked before any private preparation, catalog or BLOB read.
        scope(p, incoming.preparation.projectId);
        return o.stateStore.transaction(() => {
          const e = assertProductionConfirmation(incoming), record = e.preparation, request = e.protocol.request;
          const historic = purpose === "reconcile" || purpose === "history";
          if (e.mode !== mode || request.tenantId !== p.tenantId) reject("production_image_lease_mode_mismatch");
          const readGuard = () => {
            scope(p, request.projectId);
            const now = o.clock?.() ?? Date.now();
            if (!Number.isSafeInteger(now) || now < Date.parse(e.confirmedAt)) reject("production_image_lease_clock_invalid");
            if (!historic && now >= Date.parse(request.quote.expiresAt)) reject("production_image_lease_price_expired");
            if (purpose === "inspect" || purpose === "start") {
              const actual = o.stateStore.load()?.batches.find((b) => b.aggregate.batch.id === e.batchId), job = actual?.aggregate.jobs[0], lease = actual?.productionImageLeases?.at(-1);
              if (!actual || actual.requestFingerprint !== imageSnapshotFingerprint(e) || !job || job.id !== request.jobId || !(purpose === "start" ? ["leased", "running"].includes(job.status) : job.status === "leased")
                || !lease || lease.actorId !== p.actorId || lease.jobId !== job.id || lease.leaseId !== job.leaseId || lease.workerId !== job.leaseOwnerId
                || lease.leasedAt !== job.leasedAt || lease.expiresAt !== job.leaseExpiresAt || now < Date.parse(lease.leasedAt) || now >= Date.parse(lease.expiresAt)) reject("production_image_lease_expired");
            }
          };
          const check = () => {
            readGuard();
            const saved = o.stateStore.loadProductionImagePreparation(p.tenantId, request.projectId, mode, record.id);
            if (!saved || imageSnapshotFingerprint(saved) !== imageSnapshotFingerprint(record)) reject("production_image_lease_preparation_changed");
            const now = o.clock?.() ?? Date.now();
            if (!Number.isSafeInteger(now) || now < Date.parse(e.confirmedAt)) reject("production_image_lease_clock_invalid");
            if (!historic) {
              const current = o.stateStore.loadImageProviderHistory(p.tenantId, request.projectId).filter((v) => v.connection.id === request.connectionId).at(-1)?.connection;
              if (!current || imageSnapshotFingerprint(current) !== imageSnapshotFingerprint(record.connection)) reject("production_image_lease_connection_changed");
              validateProductionImageProviderRequest(current, request, new Date(now).toISOString());
            }
            const snapshot = o.stateStore.load(), stored = snapshot?.batches.find((b) => b.aggregate.batch.id === e.batchId);
            if (!stored || stored.requestFingerprint !== imageSnapshotFingerprint(e) || imageSnapshotFingerprint(stored.productionImageExecution) !== imageSnapshotFingerprint(e)
              || stored.aggregate.batch.tenantId !== p.tenantId || stored.aggregate.batch.projectId !== request.projectId
              || stored.aggregate.jobs[0]?.id !== request.jobId) reject("production_image_lease_task_missing");
            const budget = snapshot!.budgets.find((b) => b.tenantId === p.tenantId && b.projectId === request.projectId);
            if (!budget || budget.currency !== request.quote.currency || (stored.aggregate.batch.status !== "cancelled"
              && (stored.reservedMinor !== request.quote.maxCostMinor || stored.jobReservations.length !== 1
                || stored.jobReservations[0][0] !== request.jobId || stored.jobReservations[0][1] !== request.quote.maxCostMinor))) reject("production_image_lease_budget_mismatch");
            if (!Number.isSafeInteger(extraBytes) || extraBytes < 0 || extraBytes > 512 * 1024
              || o.stateStore.imageMetadataBytes(p.tenantId, request.projectId) + imageTaskMetadataBytes(snapshot, p.tenantId, request.projectId) + extraBytes > quota) reject("production_image_lease_metadata_full", 413);
            // The actual task/budget is checked before any BLOB; each BLOB read
            // then checks scope and (for inspect) the actual live lease again.
            validateProductionImageAssetPolicy(o.stateStore, request, readGuard);
          };
          check();
          if (!historic) {
            // The original price scope keeps the original creator, not the worker.
            const context: ImagePriceContext = { scope: record.pricing.scope, connection: record.connection, selection: record.selection,
              requestDraft: record.requestDraft, constraint: record.constraint, requestedAt: record.createdAt,
              validationAt: new Date(o.clock?.() ?? Date.now()).toISOString(), purpose: "lease" };
            const verified = o.pricePort.verify(structuredClone(context), structuredClone(record.pricing));
            if (verified && (typeof verified === "object" || typeof verified === "function") && "then" in verified) void Promise.resolve(verified).catch(() => undefined);
            if (verified !== true) reject("production_image_lease_price_not_verified");
          }
          check(); return true;
        });
      } catch (error) { if (error instanceof RunKernelError) throw error; reject("production_image_lease_policy_unavailable", 503); }
    } };
}
// Both are internal, default closed and have no HTTP/network/secret reader.
export function createProductionImageLeasePolicy(options?: Base & { pricePort: ProductionImagePricePort }): ProductionImageLeasePolicy { return create("production", options); }
export function createProductionImageLeaseFixturePolicy(options?: Base & { pricePort: FixtureProductionImagePricePort }): ProductionImageLeasePolicy { return create("production-contract-fixture", options); }
