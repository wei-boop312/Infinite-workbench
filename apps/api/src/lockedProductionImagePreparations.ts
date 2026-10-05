import { createHash, randomUUID } from "node:crypto";
import { CreateImagePreparationSchema, FixtureProductionImagePricingSchema, LockedImagePreparationPolicySchema, LockedProductionImagePreparationRecordSchema,
  ConfirmLockedProductionImagePreparationSchema, ConfirmedLockedProductionImageExecutionSchema, type ConfirmedLockedProductionImageExecution,
  ProductionImageExecutionRequestSchema, ProductionImagePricingSchema, ProductionImageRequestDraftSchema,
  type CreateImagePreparation, type LockedProductionImagePreparationRecord, type LockedImagePreparationPolicy, type VerifiedImage } from "@canvas/contracts";
import { imageSnapshotFingerprint, validateLockedProductionImagePreparationRequest } from "./imageProviderContract";
import { constraintContentChecksum, validateLockedProductionImagePreparationAssetPolicy } from "./imageAssetPolicy";
import { assetMetadataFingerprint } from "./assetMetadata";
import { decodeStaticImagePixels } from "./staticImageDecoder";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";
import { RunKernelError, type RunPrincipal } from "./runKernel";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import type { RunAuthorizer } from "./runKernel";
import type { ImagePriceContext, ProductionImagePricePort, FixtureProductionImagePricePort } from "./productionImagePreparations";
import { assertLockedConfirmation, assertLockedExpectations, lockedConfirmationKey, prepareLockedProductionImageProtocol } from "./lockedProductionImageProtocol";
import type { TrustedImageBytes } from "./imageRequestPayload";

export interface LockedImagePriceContext extends ImagePriceContext { protectionPolicy: LockedImagePreparationPolicy }
interface BaseOptions {
  preparationEnabled: true; lockedPreparationEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore;
  runKernel: Pick<SqliteRunKernel, "usesStateStore" | "validateProductionBillingSnapshot"> & Partial<Pick<SqliteRunKernel, "stageConfirmedLockedProductionImageBatch">>;
  lockedConfirmationEnabled?: true;
  lockedConfirmationPolicy?(scope: { principal: RunPrincipal; projectId: string; write: boolean }): boolean;
  authorizer: ImageProviderAuthorizer; runAuthorizer: RunAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
  lockedPreparationPolicy(scope: { principal: RunPrincipal; projectId: string; write: boolean }): boolean;
  clock?: () => number; timeoutMs?: number; maxMetadataBytes?: number;
}
type PricePort<P> = Omit<P, "read" | "verify"> & { read(context: LockedImagePriceContext): unknown; verify(context: LockedImagePriceContext, pricing: unknown): boolean };
type Options = BaseOptions & { pricePort: PricePort<ProductionImagePricePort> | PricePort<FixtureProductionImagePricePort> };
type Mode = LockedProductionImagePreparationRecord["mode"];
type FrozenInputs = Pick<LockedProductionImagePreparationRecord, "connection" | "selection" | "requestDraft" | "constraint">;
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const basis = (r: FrozenInputs & { protectionPolicy: LockedImagePreparationPolicy }) => ({ connection: r.connection, selection: r.selection, requestDraft: r.requestDraft, constraint: r.constraint, protectionPolicy: r.protectionPolicy });
const unsealed = (r: LockedProductionImagePreparationRecord) => { const { snapshotFingerprint: _sha, ...rest } = r; return rest; };
const view = (r: LockedProductionImagePreparationRecord) => ({ schemaVersion: 2 as const, id: r.id, tenantId: r.tenantId, projectId: r.projectId, mode: r.mode,
  status: r.status, protocolPreparation: r.protocolPreparation, executionAuthorized: false as const, realExecutionEnabled: false as const,
  snapshotFingerprint: r.snapshotFingerprint, basisFingerprint: r.basisFingerprint, protectionPolicyFingerprint: imageSnapshotFingerprint(r.protectionPolicy) });
function reject(code: string, status = 422): never { throw new RunKernelError(status, code, "锁区流程校验失败，请保留原准备编号只读核对；不授权发送"); }
function sync<T>(read: () => T): T {
  const value = read();
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) { void Promise.resolve(value).catch(() => undefined); reject("locked_preparation_async_policy"); }
  return value;
}
let activePreparations = 0;
let activeConfirmations = 0;

// Actual authority-backed v2 preparation and separately enabled confirmation.
// No lease, credentials, network, output, billing or public HTTP entry point.
class LockedPreparationCore {
  private readonly options?: Options;
  private readonly pending = new Map<string, { principal: RunPrincipal; check: () => void }>();
  constructor(private readonly mode: Mode, options?: Options) {
    // Capture configuration identities/functions; mutable callers cannot swap
    // a store/port/policy across the native await.
    this.options = options && { ...options, runKernel: { usesStateStore: options.runKernel.usesStateStore.bind(options.runKernel),
      validateProductionBillingSnapshot: options.runKernel.validateProductionBillingSnapshot.bind(options.runKernel),
      stageConfirmedLockedProductionImageBatch: options.runKernel.stageConfirmedLockedProductionImageBatch?.bind(options.runKernel) },
      authorizer: { ...options.authorizer, allows: options.authorizer.allows.bind(options.authorizer) },
      runAuthorizer: { ...options.runAuthorizer, allows: options.runAuthorizer.allows.bind(options.runAuthorizer) },
      assetAuthorizer: { ...options.assetAuthorizer, allows: options.assetAuthorizer.allows.bind(options.assetAuthorizer) },
      pricePort: { ...options.pricePort, read: options.pricePort.read.bind(options.pricePort), verify: options.pricePort.verify.bind(options.pricePort) } };
    if (options) this.config();
  }
  usesStateStore(store: SqliteRunKernelStateStore) { return this.options?.stateStore === store; }
  private config(): Options {
    const o = this.options, limit = o?.maxMetadataBytes ?? 16 * 1024 * 1024, timeout = o?.timeoutMs ?? 5000;
    if (!o || o.preparationEnabled !== true || o.lockedPreparationEnabled !== true || typeof o.lockedPreparationPolicy !== "function"
      || !o.runKernel || sync(() => o.runKernel.usesStateStore(o.stateStore)) !== true
      || (this.mode === "production" ? o.pricePort.kind !== "server-pricing" : o.pricePort.kind !== "contract-fixture" || o.pricePort.realExecutionEnabled !== false)) reject("locked_preparation_not_configured", 503);
    if (!o.tenantId || o.tenantId !== o.tenantId.trim() || o.tenantId.length > 160 || !Number.isSafeInteger(limit) || limit < 0 || limit > 16 * 1024 * 1024
      || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) reject("locked_preparation_configuration_invalid");
    return o;
  }
  private now() { const t = this.config().clock?.() ?? Date.now(); if (!Number.isSafeInteger(t) || t < 0 || t > 8_640_000_000_000_000 - 1000) reject("locked_preparation_clock_invalid"); return t; }
  private permit(p: RunPrincipal, project: string, write: boolean) {
    const o = this.config();
    if (p.tenantId !== o.tenantId || !p.actorId || p.actorId !== p.actorId.trim()
      || sync(() => o.lockedPreparationPolicy(structuredClone({ principal: p, projectId: project, write }))) !== true
      || sync(() => o.authorizer.allows(p, project, "provider:read")) !== true
      || sync(() => o.runAuthorizer.allows(p, project, "run:read")) !== true
      || (write && sync(() => o.runAuthorizer.allows(p, project, "run:create")) !== true)
      || sync(() => o.assetAuthorizer.allows(p, project, "asset:read")) !== true) reject("locked_preparation_permission_denied", 403);
  }
  private database<T>(action: () => T): T {
    try { return this.config().stateStore.transaction(action); }
    catch (e) { if (e instanceof RunKernelError) throw e; reject("locked_preparation_unavailable", 503); }
  }
  private snapshot() {
    const o = this.config(), snapshot = o.stateStore.load();
    if (!snapshot) reject("locked_preparation_budget_unavailable", 503);
    sync(() => o.runKernel.validateProductionBillingSnapshot(snapshot)); // pure actual-config validation, never task recovery/save
    return snapshot;
  }
  private request(d: FrozenInputs["requestDraft"], time: number) {
    return ProductionImageExecutionRequestSchema.parse({ ...d, jobId: "locked-static-validation-only", idempotencyKey: "not-an-execution",
      quote: { id: "validation-only", version: "not-a-price", source: "manual-budget", currency: "CNY", maxCostMinor: 0, expiresAt: new Date(time + 1000).toISOString() } });
  }
  private currentConnection(p: RunPrincipal, project: string, id: string) {
    const c = this.config().stateStore.loadImageProviderHistory(p.tenantId, project).filter(r => r.connection.id === id).at(-1)?.connection;
    if (!c) reject("locked_preparation_connection_missing", 404); return c;
  }
  private readInputs(p: RunPrincipal, s: CreateImagePreparation, guard: () => void) {
    const store = this.config().stateStore; guard();
    if (s.operation !== "edit" || s.protection !== "pixel-exact" || !s.maskAssetId || s.parameters.size === "auto") reject("locked_preparation_edit_required");
    const project = store.loadCatalog()?.projects.find(r => r.projectId === s.projectId), constraint = project?.constraints.find(c => c.id === s.constraintSnapshotId);
    const ids = [...s.inputAssetIds, s.maskAssetId], assets = ids.map(id => project?.assets.find(a => a.id === id));
    // Catalog declarations BEFORE any receipt getter (which also reads BLOBs).
    if (!constraint || assets.some(a => !a)) reject("locked_preparation_input_missing");
    if (assets.some(a => !a!.byteSize || a!.byteSize > 30 * 1024 * 1024 || !a!.width || !a!.height || Math.max(a!.width, a!.height) > 8192 || a!.width! * a!.height! > 16_000_000)
      || assets.reduce((n, a) => n + a!.byteSize!, 0) > 64 * 1024 * 1024) reject("locked_preparation_inputs_too_large", 413);
    if (!constraint.lockedPaths.includes("product.pixels") || !constraint.editableRegions.length || constraint.editableRegions.some(r => r.maskAssetId !== s.maskAssetId)
      || new Set(constraint.editableRegions.map(r => r.id)).size !== constraint.editableRegions.length || constraint.outputSpec.format === "mp4"
      || constraint.outputSpec.format !== s.parameters.outputFormat || constraint.outputSpec.width !== s.parameters.size.width || constraint.outputSpec.height !== s.parameters.size.height
      || Math.max(constraint.outputSpec.width, constraint.outputSpec.height) > 8192 || constraint.outputSpec.width * constraint.outputSpec.height > 16_000_000) reject("locked_preparation_constraint_mismatch");
    const receipts = ids.map((id, index) => { guard(); const r = store.loadVerifiedImage(p.tenantId, s.projectId, id); guard();
      if (!r || r.registeredMetadataSha256 !== assetMetadataFingerprint(assets[index]!) || r.registeredMetadataSha256 !== assetMetadataFingerprint(r.asset)) reject("locked_preparation_input_changed"); return r; });
    const source = receipts[0], mask = receipts.at(-1)!;
    if (source.asset.purpose !== "source" || source.sourceChecksumSha256 !== undefined || mask.asset.purpose !== "mask" || mask.asset.mimeType !== "image/png"
      || mask.asset.sourceAssetId !== source.asset.id || mask.sourceChecksumSha256 !== source.checksumSha256 || mask.asset.id === source.asset.id
      || source.asset.width !== constraint.outputSpec.width || source.asset.height !== constraint.outputSpec.height || mask.asset.width !== source.asset.width || mask.asset.height !== source.asset.height) reject("locked_preparation_mask_mismatch");
    guard(); return { constraint, receipts };
  }
  private validate(p: RunPrincipal, frozen: FrozenInputs, guard: () => void, history = false) {
    guard(); const o = this.config(), { selection: s } = frozen;
    if (!history && imageSnapshotFingerprint(this.currentConnection(p, s.projectId, s.connectionId)) !== imageSnapshotFingerprint(frozen.connection)) reject("locked_preparation_connection_changed");
    const inputs = this.readInputs(p, s, guard);
    if (imageSnapshotFingerprint(inputs.constraint) !== imageSnapshotFingerprint(frozen.constraint)) reject("locked_preparation_constraint_changed");
    const request = this.request(frozen.requestDraft, this.now());
    validateLockedProductionImagePreparationRequest(frozen.connection, request, new Date(this.now()).toISOString());
    validateLockedProductionImagePreparationAssetPolicy(o.stateStore, request, guard);
    guard(); this.snapshot(); guard(); return inputs.receipts;
  }
  private history(p: RunPrincipal, r: LockedProductionImagePreparationRecord, guard: () => void) {
    const o = this.config(); guard();
    const historic = o.stateStore.loadImageProviderHistory(r.tenantId, r.projectId).find(h => h.connection.id === r.connection.id && h.connection.revision === r.connection.revision);
    if (!historic || r.mode !== this.mode || imageSnapshotFingerprint(historic.connection) !== imageSnapshotFingerprint(r.connection)
      || r.selectionFingerprint !== imageSnapshotFingerprint(r.selection) || r.basisFingerprint !== imageSnapshotFingerprint(basis(r))
      || r.snapshotFingerprint !== imageSnapshotFingerprint(unsealed(r)) || r.requestDraft.constraintChecksumSha256 !== constraintContentChecksum(r.constraint)) reject("locked_preparation_history_corrupt", 503);
    const receipts = this.validate(p, r, guard, true);
    if (imageSnapshotFingerprint(receipts[0]) !== imageSnapshotFingerprint(r.protectionPolicy.source) || imageSnapshotFingerprint(receipts.at(-1)) !== imageSnapshotFingerprint(r.protectionPolicy.mask)) reject("locked_preparation_history_corrupt", 503);
    guard(); return view(r);
  }
  getPreparation(principal: RunPrincipal, project: string, id: string) {
    const p = structuredClone(principal), timeout = this.config().timeoutMs ?? 5000; let last = this.now(); const deadline = last + timeout;
    const guard = () => { const time = this.now(); if (time < last) reject("locked_preparation_clock_invalid"); last = time;
      if (time >= deadline) reject("locked_preparation_expired", 408); this.permit(p, project, false); }; guard();
    return this.database(() => { guard(); const r = this.config().stateStore.loadLockedProductionImagePreparation(p.tenantId, project, this.mode, id);
      if (!r) reject("locked_preparation_not_found", 404); return this.history(p, r, guard); });
  }
  private confirmationPermit(p: RunPrincipal, project: string, write: boolean) {
    const o = this.config();
    if (o.lockedConfirmationEnabled !== true || typeof o.lockedConfirmationPolicy !== "function"
      || typeof o.runKernel.stageConfirmedLockedProductionImageBatch !== "function"
      || sync(() => o.stateStore.supportsProductionImageResponses()) !== true || sync(() => o.stateStore.supportsProductionImageArtifacts()) !== true) reject("locked_confirmation_not_configured", 503);
    this.permit(p, project, write);
    if (sync(() => o.lockedConfirmationPolicy!(structuredClone({ principal: p, projectId: project, write }))) !== true
      || (write && sync(() => o.runAuthorizer.allows(p, project, "run:confirm")) !== true)) reject("locked_confirmation_permission_denied", 403);
  }
  private confirmationHistory(p: RunPrincipal, r: LockedProductionImagePreparationRecord, guard: () => void) {
    this.history(p, r, guard);
    const snapshot = this.snapshot();
    const rows = snapshot.batches.filter(s => s.aggregate.batch.tenantId === p.tenantId && s.aggregate.batch.projectId === r.projectId
      && s.aggregate.batch.idempotencyKey === lockedConfirmationKey({ mode: r.mode, preparation: r }));
    if (!rows.length) return null;
    if (rows.length !== 1 || !rows[0].lockedProductionImageExecution) reject("locked_confirmation_history_corrupt", 503);
    const e = assertLockedConfirmation(rows[0].lockedProductionImageExecution);
    if (imageSnapshotFingerprint(e.preparation) !== imageSnapshotFingerprint(r)) reject("locked_confirmation_history_corrupt", 503);
    const raw = this.config().stateStore.supportsProductionImageResponses()
      ? this.config().stateStore.loadProductionImageResponse(p.tenantId, r.projectId, r.mode, e.protocol.request.jobId) : null;
    try { if (raw || (this.config().stateStore.supportsProductionImageArtifacts()
      && this.config().stateStore.loadProductionImageArtifact(p.tenantId, r.projectId, r.mode, e.protocol.request.jobId))) reject("locked_confirmation_history_corrupt", 503); }
    finally { raw?.body.fill(0); }
    guard(); const latest = this.config().stateStore.loadLockedProductionImagePreparation(p.tenantId, r.projectId, this.mode, r.id);
    if (!latest || imageSnapshotFingerprint(latest) !== imageSnapshotFingerprint(r)) reject("locked_confirmation_history_corrupt", 503);
    const j = rows[0].aggregate.jobs[0], b = rows[0].aggregate.batch;
    guard(); if (imageSnapshotFingerprint(this.snapshot()) !== imageSnapshotFingerprint(snapshot)) reject("locked_confirmation_history_corrupt", 503);
    return { schemaVersion: 2 as const, tenantId: p.tenantId, projectId: r.projectId, mode: this.mode, preparationId: r.id,
      preparationFingerprint: r.snapshotFingerprint, protectionPolicyFingerprint: imageSnapshotFingerprint(r.protectionPolicy),
      pricingFingerprint: e.protocol.pricingFingerprint, requestFingerprint: e.protocol.requestFingerprint, batchId: b.id, jobId: j.id,
      executionState: e.executionState, executionAuthorized: false as const, realExecutionEnabled: false as const,
      confirmedBy: e.confirmedBy, confirmedAt: e.confirmedAt, status: b.status, currency: b.currency, estimatedCostMinor: b.estimatedCostMinor,
      maxCostMinor: b.maxCostMinor, reservedMinor: rows[0].reservedMinor };
  }
  getConfirmation(principal: RunPrincipal, project: string, id: string) {
    const p = structuredClone(principal); this.confirmationPermit(p, project, false);
    let last = this.now(); const deadline = last + (this.config().timeoutMs ?? 5000);
    const guard = () => { const t = this.now(); if (t < last || t >= deadline) reject("locked_confirmation_expired", 408); last = t; this.confirmationPermit(p, project, false); };
    return this.database(() => { guard(); const r = this.config().stateStore.loadLockedProductionImagePreparation(p.tenantId, project, this.mode, id);
      if (!r) reject("locked_preparation_not_found", 404); return this.confirmationHistory(p, r, guard); });
  }
  authorizeConfirmation(principal: RunPrincipal, incoming: ConfirmedLockedProductionImageExecution): boolean {
    const live = this.pending.get(imageSnapshotFingerprint(incoming));
    if (!live || imageSnapshotFingerprint(live.principal) !== imageSnapshotFingerprint(principal)) return false;
    live.check(); assertLockedConfirmation(incoming); return true;
  }
  async confirmPreparation(principal: RunPrincipal, project: string, id: string, expectedInput: unknown, options: { signal?: AbortSignal } = {}) {
    const p = structuredClone(principal); this.confirmationPermit(p, project, true);
    const o = this.config(), expected = ConfirmLockedProductionImagePreparationSchema.parse(expectedInput), signal = options.signal;
    let last = this.now(), closed = false; const timeout = o.timeoutMs ?? 5000, deadline = last + timeout;
    const guard = () => { if (closed || signal?.aborted) reject("locked_confirmation_cancelled", 408); const t = this.now();
      if (t < last) reject("locked_preparation_clock_invalid"); last = t; if (t >= deadline) reject("locked_confirmation_expired", 408); this.confirmationPermit(p, project, true); };
    const capacity = () => { if (o.stateStore.imageMetadataBytes(p.tenantId, project) + imageTaskMetadataBytes(o.stateStore.load(), p.tenantId, project) > (o.maxMetadataBytes ?? 16 * 1024 * 1024)) reject("locked_preparation_metadata_full", 413); };
    const current = (r: LockedProductionImagePreparationRecord) => {
      guard(); const stored = o.stateStore.loadLockedProductionImagePreparation(p.tenantId, project, this.mode, id);
      if (!stored || stored.createdBy !== p.actorId || imageSnapshotFingerprint(stored) !== imageSnapshotFingerprint(r)) reject("locked_confirmation_original_changed");
      assertLockedExpectations(stored, expected); this.history(p, stored, guard); this.validate(p, stored, guard);
      if (last >= Date.parse(stored.pricing.quote.expiresAt)) reject("locked_preparation_price_expired");
      const budget = this.snapshot().budgets.find(b => b.tenantId === p.tenantId && b.projectId === project);
      if (!budget || budget.currency !== stored.pricing.quote.currency) reject("locked_preparation_budget_currency_mismatch");
      const context: LockedImagePriceContext = { ...basis(stored), scope: stored.pricing.scope, requestedAt: stored.createdAt, validationAt: new Date(last).toISOString(), purpose: "confirm" };
      if (sync(() => o.pricePort.verify(structuredClone(context), structuredClone(stored.pricing))) !== true) reject("locked_preparation_price_not_verified");
      guard(); this.validate(p, stored, guard); if (last >= Date.parse(stored.pricing.quote.expiresAt)) reject("locked_preparation_price_expired"); capacity(); guard();
    };
    guard(); const first = this.database(() => { guard(); const r = o.stateStore.loadLockedProductionImagePreparation(p.tenantId, project, this.mode, id);
      if (!r || r.createdBy !== p.actorId) reject("locked_confirmation_original_changed"); assertLockedExpectations(r, expected);
      const old = this.confirmationHistory(p, r, guard); if (old) return { r, old }; current(r); return { r, old: null }; });
    if (first.old) return first.old;
    if (activeConfirmations >= 2) reject("locked_confirmation_busy", 429); activeConfirmations++;
    const images: TrustedImageBytes[] = []; let wire: Buffer | undefined;
    const work = (async () => { try {
      this.database(() => { current(first.r); const receipts = this.readInputs(p, first.r.selection, guard).receipts;
        for (const receipt of receipts) { guard(); const raw = o.stateStore.loadVerifiedImageBytes(p.tenantId, project, receipt.asset.id);
          if (raw) images.push(raw); guard(); if (!raw || imageSnapshotFingerprint(raw.receipt) !== imageSnapshotFingerprint(receipt)) reject("locked_preparation_input_changed"); }
        current(first.r); });
      guard(); const prepared = await prepareLockedProductionImageProtocol(first.r, expected, { jobId: `production-image-job-${randomUUID()}`,
        idempotencyKey: `production-image-execution-${randomUUID()}` }, images, new Date(last).toISOString()); wire = prepared.wire.body; guard();
      return this.database(() => {
        guard(); const old = this.confirmationHistory(p, first.r, guard); if (old) return old; current(first.r);
        const e = ConfirmedLockedProductionImageExecutionSchema.parse({ schemaVersion: 2, mode: this.mode, batchId: `production-image-batch-${randomUUID()}`,
          executionState: "confirmed-not-dispatchable", executionAuthorized: false, realExecutionEnabled: false, preparation: first.r,
          protocol: prepared.snapshot, confirmedBy: p.actorId, confirmedAt: new Date(last).toISOString() });
        assertLockedConfirmation(e);
        const live = () => { current(first.r); if (!wire || hash(wire) !== e.protocol.payloadChecksumSha256 || wire.length !== e.protocol.payloadByteSize
          || prepared.wire.contentType !== e.protocol.contentType) reject("locked_confirmation_protocol_changed");
          if (Buffer.byteLength(JSON.stringify(e)) > 512 * 1024) reject("locked_preparation_metadata_full", 413); };
        live(); const fingerprint = imageSnapshotFingerprint(e);
        this.pending.set(fingerprint, { principal: p, check: live });
        try { o.runKernel.stageConfirmedLockedProductionImageBatch!(p, e); live(); capacity();
          const result = this.confirmationHistory(p, first.r, guard); if (!result) reject("locked_confirmation_history_corrupt", 503); return result; }
        finally { this.pending.delete(fingerprint); }
      });
    } finally { wire?.fill(0); images.forEach(i => i.body.fill(0)); activeConfirmations--; } })();
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, fail) => { timer = setTimeout(() => { closed = true; fail(new RunKernelError(408, "locked_confirmation_expired", "锁区确认期限耗尽")); }, timeout);
      abort = () => { closed = true; fail(new RunKernelError(408, "locked_confirmation_cancelled", "锁区确认取消")); }; signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); });
    try { return await Promise.race([work, interrupted]); } finally { closed = true; clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
  }
  async createPreparation(principal: RunPrincipal, input: unknown, options: { signal?: AbortSignal } = {}) {
    const o = this.config(), p = structuredClone(principal);
    let s: CreateImagePreparation; try { s = CreateImagePreparationSchema.parse(input); } catch { reject("locked_preparation_selection_invalid"); }
    const signal = options.signal, timeout = o.timeoutMs ?? 5000; let last = this.now(), closed = false;
    const deadline = last + timeout;
    const guard = () => { if (closed || signal?.aborted) reject("locked_preparation_cancelled", 408); const now = this.now();
      if (now < last) reject("locked_preparation_clock_invalid"); last = now; if (last >= deadline) reject("locked_preparation_expired", 408); this.permit(p, s.projectId, true); };
    guard(); const existing = this.database(() => { guard(); const r = o.stateStore.loadLockedProductionImagePreparationByAction(p.tenantId, s.projectId, this.mode, s.idempotencyKey);
      if (!r) return null; if (r.selectionFingerprint !== imageSnapshotFingerprint(s)) reject("locked_preparation_idempotency_conflict", 409); return this.history(p, r, guard); });
    if (existing) return existing;
    if (activePreparations >= 2) reject("locked_preparation_busy", 429);
    activePreparations++;
    const bodies: Buffer[] = [], pixels: Buffer[] = [];
    const work = (async () => { try {
      const frozen = this.database(() => {
        guard(); const connection = this.currentConnection(p, s.projectId, s.connectionId);
        if (!connection.enabled || connection.protocol === "custom" || connection.revision !== s.connectionRevision) reject("locked_preparation_connection_changed");
        const { constraint, receipts } = this.readInputs(p, s, guard), refs = receipts.map(r => ({ assetId: r.asset.id, checksumSha256: r.checksumSha256,
          mimeType: r.asset.mimeType, width: r.asset.width, height: r.asset.height, byteSize: r.asset.byteSize }));
        const requestDraft = ProductionImageRequestDraftSchema.parse({ schemaVersion: 1, tenantId: p.tenantId, projectId: s.projectId, connectionId: connection.id,
          connectionRevision: connection.revision, adapterId: connection.adapterId, model: s.model, capabilityVersion: s.capabilityVersion, constraintSnapshotId: constraint.id,
          constraintChecksumSha256: constraintContentChecksum(constraint), protection: s.protection, parameters: s.parameters, providerParameters: s.providerParameters,
          operation: "edit", inputs: refs.slice(0, -1), mask: refs.at(-1) });
        const value = { connection, selection: s, constraint, requestDraft }; this.validate(p, value, guard);
        if (Buffer.byteLength(JSON.stringify({ ...value, receipts })) > 512 * 1024) reject("locked_preparation_metadata_full", 413);
        for (const receipt of [receipts[0], receipts.at(-1)!]) { guard(); const loaded = o.stateStore.loadVerifiedImageBytes(p.tenantId, s.projectId, receipt.asset.id);
          if (loaded) bodies.push(loaded.body); guard(); if (!loaded || imageSnapshotFingerprint(loaded.receipt) !== imageSnapshotFingerprint(receipt)) reject("locked_preparation_input_changed"); }
        this.validate(p, value, guard); return structuredClone({ ...value, source: receipts[0], mask: receipts.at(-1)! });
      });
      for (let index = 0; index < 2; index++) { guard(); const receipt = index ? frozen.mask : frozen.source;
        const decoded = await decodeStaticImagePixels(bodies[index], receipt.asset.mimeType); pixels.push(decoded.pixels); guard();
        if (decoded.width !== frozen.constraint.outputSpec.width || decoded.height !== frozen.constraint.outputSpec.height) reject("locked_preparation_dimensions_changed"); }
      let lockedPixels = 0, editablePixels = 0;
      for (let offset = 0; offset < pixels[1].length; offset += 4) { if (offset % 16384 === 0) guard(); const alpha = pixels[1][offset + 3];
        if (alpha > 0 && (pixels[1][offset] !== 255 || pixels[1][offset + 1] !== 255 || pixels[1][offset + 2] !== 255)) reject("locked_preparation_mask_invalid");
        if (alpha === 255) editablePixels++; else lockedPixels++; }
      if (!lockedPixels || !editablePixels) reject("locked_preparation_mask_vacuous");
      guard(); const protectionPolicy = LockedImagePreparationPolicySchema.parse({ schemaVersion: 1, policyVersion: "locked-image-input-policy-v1",
        normalizationVersion: "auto-orient-srgb-rgba8-v1", maskPolicy: "white-alpha255-edit-otherwise-locked-v1", executionAuthorized: false, realExecutionEnabled: false,
        tenantId: p.tenantId, projectId: s.projectId, constraintSnapshotId: frozen.constraint.id, constraintChecksumSha256: frozen.requestDraft.constraintChecksumSha256,
        source: frozen.source, mask: frozen.mask, inputAssetIds: s.operation === "edit" ? s.inputAssetIds : [], outputSpec: frozen.constraint.outputSpec,
        sourcePixelsSha256: hash(pixels[0]), maskPixelsSha256: hash(pixels[1]), lockedPixels, editablePixels, verifiedAt: new Date(last).toISOString() });
      return this.database(() => {
        guard(); const winner = o.stateStore.loadLockedProductionImagePreparationByAction(p.tenantId, s.projectId, this.mode, s.idempotencyKey);
        if (winner) { if (winner.selectionFingerprint !== imageSnapshotFingerprint(s)) reject("locked_preparation_idempotency_conflict", 409); return this.history(p, winner, guard); }
        const validate = () => { const receipts = this.validate(p, frozen, guard);
          if (imageSnapshotFingerprint(receipts[0]) !== imageSnapshotFingerprint(protectionPolicy.source) || imageSnapshotFingerprint(receipts.at(-1)) !== imageSnapshotFingerprint(protectionPolicy.mask)) reject("locked_preparation_input_changed"); };
        validate(); const requestedAt = new Date(last).toISOString(), fullBasis = basis({ ...frozen, protectionPolicy });
        if (Buffer.byteLength(JSON.stringify(fullBasis)) > 512 * 1024) reject("locked_preparation_metadata_full", 413);
        const context: LockedImagePriceContext = { ...fullBasis, scope: { tenantId: p.tenantId, projectId: s.projectId, actorId: p.actorId, connectionId: frozen.connection.id,
          connectionRevision: frozen.connection.revision, model: s.model, capabilityVersion: s.capabilityVersion, operation: "edit", selectionFingerprint: imageSnapshotFingerprint(s),
          basisFingerprint: imageSnapshotFingerprint(fullBasis) }, requestedAt, purpose: "prepare" };
        const raw = sync(() => o.pricePort.read(structuredClone(context))); guard();
        const pricing = (this.mode === "production" ? ProductionImagePricingSchema : FixtureProductionImagePricingSchema).parse(raw);
        if (imageSnapshotFingerprint(pricing.scope) !== imageSnapshotFingerprint(context.scope) || Date.parse(pricing.evidence.checkedAt) < Date.parse(requestedAt)
          || Date.parse(pricing.evidence.checkedAt) > last || Date.parse(pricing.quote.expiresAt) <= last
          || sync(() => o.pricePort.verify(structuredClone(context), structuredClone(pricing))) !== true) reject("locked_preparation_price_not_verified");
        const final = () => { validate(); guard(); if (last >= Date.parse(pricing.quote.expiresAt)) reject("locked_preparation_price_expired");
          const budget = this.snapshot().budgets.find(b => b.tenantId === p.tenantId && b.projectId === s.projectId);
          if (!budget || budget.currency !== pricing.quote.currency) reject("locked_preparation_budget_currency_mismatch"); guard(); };
        final(); if (o.stateStore.productionImagePreparationCount(p.tenantId, s.projectId) >= 1000) reject("locked_preparation_catalog_full", 413);
        const unsigned = { ...fullBasis, schemaVersion: 2, mode: this.mode, id: `locked-production-image-preparation-${randomUUID()}`, tenantId: p.tenantId, projectId: s.projectId,
          status: "unconfirmed", executionAuthorized: false, realExecutionEnabled: false, protocolPreparation: "not-run", pricing,
          selectionFingerprint: context.scope.selectionFingerprint, basisFingerprint: context.scope.basisFingerprint, createdBy: p.actorId, createdAt: new Date(last).toISOString() };
        const record = LockedProductionImagePreparationRecordSchema.parse({ ...unsigned, snapshotFingerprint: imageSnapshotFingerprint(unsigned) }), bytes = Buffer.byteLength(JSON.stringify(record));
        const capacity = () => { if (bytes > 512 * 1024 || o.stateStore.imageMetadataBytes(p.tenantId, s.projectId) + imageTaskMetadataBytes(o.stateStore.load(), p.tenantId, s.projectId) > (o.maxMetadataBytes ?? 16 * 1024 * 1024)) reject("locked_preparation_metadata_full", 413); };
        if (o.stateStore.imageMetadataBytes(p.tenantId, s.projectId) + imageTaskMetadataBytes(o.stateStore.load(), p.tenantId, s.projectId) + bytes > (o.maxMetadataBytes ?? 16 * 1024 * 1024)) reject("locked_preparation_metadata_full", 413);
        o.stateStore.saveLockedProductionImagePreparation(record, () => { final(); capacity(); }); final(); capacity();
        return this.history(p, o.stateStore.loadLockedProductionImagePreparation(p.tenantId, s.projectId, this.mode, record.id)!, guard);
      });
    } finally { bodies.forEach(b => b.fill(0)); pixels.forEach(b => b.fill(0)); activePreparations--; } })();
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, fail) => { timer = setTimeout(() => { closed = true; fail(new RunKernelError(408, "locked_preparation_expired", "锁区准备期限耗尽")); }, timeout);
      abort = () => { closed = true; fail(new RunKernelError(408, "locked_preparation_cancelled", "锁区准备取消")); }; signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); });
    try { return await Promise.race([work, interrupted]); }
    finally { closed = true; clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
  }
}
export class LockedProductionImagePreparations extends LockedPreparationCore { constructor(options?: BaseOptions & { pricePort: PricePort<ProductionImagePricePort> }) { super("production", options); } }
export class LockedImageProductionPreparationHarness extends LockedPreparationCore { constructor(options?: BaseOptions & { pricePort: PricePort<FixtureProductionImagePricePort> }) { super("production-contract-fixture", options); } }
