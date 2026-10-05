import type { ConfirmedLockedProductionImageExecution } from "@canvas/contracts";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import type { LockedImagePriceContext } from "./lockedProductionImagePreparations";
import { assertLockedConfirmation, assertLockedConfirmationState } from "./lockedProductionImageProtocol";
import { validateLockedProtocolRequest } from "./lockedProductionImageRequest";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { validateLockedProductionImagePreparationAssetPolicy } from "./imageAssetPolicy";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";
import { RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";

export type LockedLeasePurpose = "claim" | "inspect" | "history" | "reconcile" | "cancel";
export interface LockedProductionImageLeasePolicy {
  readonly timeoutMs?: number;
  usesStateStore(store: SqliteRunKernelStateStore): boolean;
  authorizeScope(p: RunPrincipal, project: string, purpose: LockedLeasePurpose): boolean;
  validate(p: RunPrincipal, execution: ConfirmedLockedProductionImageExecution, purpose: LockedLeasePurpose, extraBytes: number): boolean;
}
type PricePort = { kind: "server-pricing" | "contract-fixture"; realExecutionEnabled?: false; verify(context: LockedImagePriceContext, pricing: unknown): boolean };
type Options = { lockedLeaseEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore; pricePort: PricePort;
  runAuthorizer: RunAuthorizer; providerAuthorizer: ImageProviderAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
  lockedLeasePolicy(scope: { principal: RunPrincipal; projectId: string; purpose: LockedLeasePurpose }): boolean;
  clock?: () => number; maxMetadataBytes?: number; timeoutMs?: number };
function reject(code: string, status = 409): never { throw new RunKernelError(status, code, "保护租约核验失败，请保留原编号核对；不授权发送"); }
function strict(read: () => unknown) { const v = read(); if (v && (typeof v === "object" || typeof v === "function") && "then" in v) void Promise.resolve(v).catch(() => undefined);
  if (v !== true) reject("locked_lease_permission_denied", 403); }
function create(mode: ConfirmedLockedProductionImageExecution["mode"], options?: Options): LockedProductionImageLeasePolicy {
  if (!options || options.lockedLeaseEnabled !== true || !options.tenantId || options.tenantId !== options.tenantId.trim()
    || options.tenantId.length > 160 || typeof options.lockedLeasePolicy !== "function" || !options.pricePort
    || (mode === "production" ? options.pricePort.kind !== "server-pricing" : options.pricePort.kind !== "contract-fixture" || options.pricePort.realExecutionEnabled !== false)) reject("locked_lease_not_configured", 503);
  // Capture the actual store and all trusted port identities. No caller-owned mutable configuration is retained.
  const o = { ...options, runAuthorizer: { allows: options.runAuthorizer.allows.bind(options.runAuthorizer) },
    providerAuthorizer: { allows: options.providerAuthorizer.allows.bind(options.providerAuthorizer) }, assetAuthorizer: { allows: options.assetAuthorizer.allows.bind(options.assetAuthorizer) },
    pricePort: { ...options.pricePort, verify: options.pricePort.verify.bind(options.pricePort) } };
  const quota = o.maxMetadataBytes ?? 16 * 1024 * 1024, timeout = o.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(quota) || quota < 0 || quota > 16 * 1024 * 1024 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) reject("locked_lease_configuration_invalid");
  const scope = (p: RunPrincipal, project: string, purpose: LockedLeasePurpose) => {
    if (p.tenantId !== o.tenantId || !p.actorId || p.actorId !== p.actorId.trim() || !["claim", "inspect", "history", "reconcile", "cancel"].includes(purpose)) reject("locked_lease_permission_denied", 403);
    strict(() => o.lockedLeasePolicy(structuredClone({ principal: p, projectId: project, purpose })));
    strict(() => o.runAuthorizer.allows(structuredClone(p), project, "run:read"));
    if (["claim", "inspect", "reconcile"].includes(purpose)) strict(() => o.runAuthorizer.allows(structuredClone(p), project, "run:execute"));
    if (purpose === "cancel") strict(() => o.runAuthorizer.allows(structuredClone(p), project, "run:cancel"));
    strict(() => o.providerAuthorizer.allows(structuredClone(p), project, "provider:read")); strict(() => o.assetAuthorizer.allows(structuredClone(p), project, "asset:read")); return true;
  };
  return { timeoutMs: timeout, usesStateStore: s => s === o.stateStore, authorizeScope: scope, validate: (p, incoming, purpose, extraBytes) => {
    try {
      scope(p, incoming.preparation.projectId, purpose);
      if (!o.stateStore.supportsProductionImageResponses() || !o.stateStore.supportsProductionImageArtifacts()) reject("locked_lease_storage_closed", 503);
      let last = o.clock?.() ?? Date.now();
      if (!Number.isSafeInteger(last) || last < 0 || last > 8_640_000_000_000_000 - 30000) reject("locked_lease_clock_invalid"); const deadline = last + timeout;
      const e = assertLockedConfirmation(incoming), r = e.protocol.request, record = e.preparation, historic = ["history", "reconcile", "cancel"].includes(purpose);
      const guard = () => { scope(p, r.projectId, purpose); const t = o.clock?.() ?? Date.now();
        if (!Number.isSafeInteger(t) || t < 0 || t < last || t < Date.parse(e.confirmedAt) || t >= deadline || t > 8_640_000_000_000_000 - 30000) reject("locked_lease_clock_invalid"); last = t;
        if (!historic && t >= Date.parse(r.quote.expiresAt)) reject("locked_lease_price_expired");
        if (purpose === "inspect") { const s = o.stateStore.load()?.batches.find(b => b.aggregate.batch.id === e.batchId), j = s?.aggregate.jobs[0], l = s?.lockedProductionImageLeases?.at(-1);
          if (!j || j.status !== "leased" || !l || l.actorId !== p.actorId || l.leaseId !== j.leaseId || l.workerId !== j.leaseOwnerId
            || t < Date.parse(l.leasedAt) || t >= Date.parse(l.expiresAt)) reject("locked_lease_expired"); }
      };
      return o.stateStore.transaction(() => {
        let originalSnapshot: string | undefined, originalCatalog: string | undefined;
        const check = () => {
          guard(); if (e.mode !== mode || r.tenantId !== p.tenantId) reject("locked_lease_mode_mismatch");
          const saved = o.stateStore.loadLockedProductionImagePreparation(p.tenantId, r.projectId, mode, record.id);
          if (!saved || fp(saved) !== fp(record)) reject("locked_lease_preparation_changed");
          const revision = o.stateStore.loadImageProviderHistory(p.tenantId, r.projectId).filter(v => v.connection.id === r.connectionId);
          if (!revision.some(v => fp(v.connection) === fp(record.connection)) || (!historic && fp(revision.at(-1)?.connection) !== fp(record.connection))) reject("locked_lease_connection_changed");
          validateLockedProtocolRequest(record.connection, r, historic ? e.confirmedAt : new Date(last).toISOString());
          const snapshot = o.stateStore.load(), s = snapshot?.batches.find(b => b.aggregate.batch.id === e.batchId);
          if (!s || fp(s.lockedProductionImageExecution) !== fp(e)) reject("locked_lease_task_missing"); assertLockedConfirmationState(s);
          if (originalSnapshot !== undefined && fp(snapshot) !== originalSnapshot) reject("locked_lease_task_changed"); originalSnapshot = fp(snapshot);
          const catalog = o.stateStore.loadCatalog(), project = catalog?.projects.find(p => p.projectId === r.projectId);
          if (originalCatalog !== undefined && fp(catalog) !== originalCatalog) reject("locked_lease_catalog_changed"); originalCatalog = fp(catalog);
          const constraint = project?.constraints.find(c => c.id === r.constraintSnapshotId), ids = [...r.inputs.map(i => i.assetId), r.mask!.assetId], assets = ids.map(id => project?.assets.find(a => a.id === id));
          if (!constraint || fp(constraint) !== fp(record.constraint) || assets.some(a => !a)) reject("locked_lease_input_changed");
          // Authoritative declarations, not only frozen request declarations, before any receipt/BLOB getter.
          if (assets.some(a => !a!.byteSize || a!.byteSize > 30 * 1024 * 1024 || !a!.width || !a!.height || Math.max(a!.width, a!.height) > 8192 || a!.width! * a!.height! > 16_000_000)
            || assets.reduce((n, a) => n + a!.byteSize!, 0) > 64 * 1024 * 1024) reject("locked_lease_inputs_too_large", 413);
          const budget = snapshot!.budgets.find(b => b.tenantId === p.tenantId && b.projectId === r.projectId);
          if (!budget || budget.currency !== r.quote.currency || !Number.isSafeInteger(extraBytes) || extraBytes < 0 || extraBytes > 512 * 1024
            || o.stateStore.imageMetadataBytes(p.tenantId, r.projectId) + imageTaskMetadataBytes(snapshot, p.tenantId, r.projectId) + extraBytes > quota) reject("locked_lease_capacity_or_budget", 413);
          // Existing locked asset policy enforces declarations before BLOB getters and original constraints/bytes.
          const { schemaVersion: _version, protectionPolicy: _policy, ...fields } = r;
          validateLockedProductionImagePreparationAssetPolicy(o.stateStore, { schemaVersion: 1, ...fields }, guard);
          for (const receipt of [record.protectionPolicy.source, record.protectionPolicy.mask]) {
            guard(); const actual = o.stateStore.loadVerifiedImage(p.tenantId, r.projectId, receipt.asset.id); guard(); if (!actual || fp(actual) !== fp(receipt)) reject("locked_lease_input_changed");
          }
          guard();
        };
        check();
        if (!historic) { const context: LockedImagePriceContext = { scope: record.pricing.scope, connection: record.connection, selection: record.selection,
          requestDraft: record.requestDraft, constraint: record.constraint, protectionPolicy: record.protectionPolicy, requestedAt: record.createdAt,
          validationAt: new Date(last).toISOString(), purpose: "lease" };
          strict(() => o.pricePort.verify(structuredClone(context), structuredClone(record.pricing))); }
        check(); return true;
      });
    } catch (e) { if (e instanceof RunKernelError) throw e; reject("locked_lease_unavailable", 503); }
  } };
}
export function createLockedProductionImageLeasePolicy(options?: Options & { pricePort: PricePort & { kind: "server-pricing" } }) { return create("production", options); }
export function createLockedProductionImageLeaseFixturePolicy(options?: Options & { pricePort: PricePort & { kind: "contract-fixture"; realExecutionEnabled: false } }) { return create("production-contract-fixture", options); }
