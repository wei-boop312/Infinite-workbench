import { randomUUID } from "node:crypto";
import { ConfirmProductionImagePreparationSchema, ConfirmedProductionImageExecutionSchema, CreateImagePreparationSchema, FixtureProductionImagePricingSchema, ProductionImageExecutionRequestSchema, ProductionImagePreparationRecordSchema, ProductionImageRequestDraftSchema,
  type ConfirmedProductionImageExecution, type ConfirmProductionImagePreparation,
  ProductionImagePricingSchema, type CreateImagePreparation, type ProductionImagePreparationRecord, type ProductionImagePriceScope,
  type ProductionImageRequestDraft, type ConstraintSnapshot, type ImageProviderConnection } from "@canvas/contracts";
import { imageProviderPublicView, imageSnapshotFingerprint, validateProductionImageProviderRequest } from "./imageProviderContract";
import { constraintContentChecksum, validateProductionImageAssetPolicy } from "./imageAssetPolicy";
import { assetMetadataFingerprint } from "./verifiedAssets";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import { InMemoryRunKernel, RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import { prepareProductionImageProtocol, validateProductionImageConfirmationExpectations } from "./productionImageProtocol";
import { assertProductionConfirmation } from "./productionImageConfirmationIntegrity";
import { createHash } from "node:crypto";

export interface ImagePriceContext {
  scope: ProductionImagePriceScope; connection: ImageProviderConnection;
  selection: CreateImagePreparation; requestDraft: ProductionImageRequestDraft; constraint: ConstraintSnapshot;
  requestedAt: string; validationAt?: string; purpose?: "prepare" | "confirm" | "lease";
}
interface PricePort {
  // Trusted server ports, not caller-supplied scripts or a sandbox.
  read(context: ImagePriceContext): unknown;
  verify(context: ImagePriceContext, pricing: unknown): boolean;
}
export interface ProductionImagePricePort extends PricePort { kind: "server-pricing" }
export interface FixtureProductionImagePricePort extends PricePort { kind: "contract-fixture"; realExecutionEnabled: false }
interface BaseOptions {
  preparationEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore;
  authorizer: ImageProviderAuthorizer; runAuthorizer: RunAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
  clock?: () => number; maxMetadataBytes?: number;
  runKernel?: Pick<SqliteRunKernel, "usesStateStore" | "stageConfirmedProductionImageBatch">;
}
type Options = BaseOptions & { pricePort: ProductionImagePricePort | FixtureProductionImagePricePort };
type Mode = ProductionImagePreparationRecord["mode"];
function reject(code: string, status = 422): never { throw new RunKernelError(status, code, "生产图片准备未获执行授权，未发送或修改预算"); }
function sync<T>(callback: () => T): T {
  const value = callback();
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) {
    // Reject async policies, also consume a possible rejected promise.
    void Promise.resolve(value).catch(() => undefined);
    reject("production_image_async_port_rejected");
  }
  return value;
}
const basis = (r: Pick<ProductionImagePreparationRecord, "connection" | "selection" | "requestDraft" | "constraint">) => ({
  connection: r.connection, selection: r.selection, requestDraft: r.requestDraft, constraint: r.constraint,
});
const frozen = (r: ProductionImagePreparationRecord) => { const { snapshotFingerprint: _hash, ...rest } = r; return rest; };
function view(r: ProductionImagePreparationRecord) {
  return { id: r.id, tenantId: r.tenantId, projectId: r.projectId, mode: r.mode, status: r.status,
    executionAuthorized: r.executionAuthorized, realExecutionEnabled: r.realExecutionEnabled, protocolPreparation: r.protocolPreparation,
    snapshotFingerprint: r.snapshotFingerprint, basisFingerprint: r.basisFingerprint, createdAt: r.createdAt,
    connection: imageProviderPublicView(r.connection), requestDraft: r.requestDraft, constraint: r.constraint, pricing: r.pricing };
}

let activeConfirmations = 0;
// No HTTP route, live inquiry, credential port, network or executor.
class PreparationCore {
  private readonly pending = new Map<string, string>();
  usesStateStore(store: SqliteRunKernelStateStore): boolean { return this.options?.stateStore === store; }
  constructor(private readonly mode: Mode, private readonly options?: Options) {
    if (options) {
      const limit = options.maxMetadataBytes ?? 16 * 1024 * 1024;
      if (!options.tenantId.trim() || options.tenantId !== options.tenantId.trim() || options.tenantId.length > 160
        || !Number.isSafeInteger(limit) || limit < 0 || limit > 16 * 1024 * 1024) reject("production_image_configuration_invalid");
      this.config();
      if (options.runKernel && !options.runKernel.usesStateStore(options.stateStore)) reject("production_image_shared_store_required", 503);
    }
  }
  private config(): Options {
    const o = this.options;
    if (!o || o.preparationEnabled !== true || !o.pricePort
      || (this.mode === "production" ? o.pricePort.kind !== "server-pricing"
        : o.pricePort.kind !== "contract-fixture" || o.pricePort.realExecutionEnabled !== false)) reject("production_image_preparation_not_configured", 503);
    return o;
  }
  private now(): string {
    const time = this.config().clock?.() ?? Date.now();
    if (!Number.isSafeInteger(time) || time < 0 || time > 8_640_000_000_000_000) reject("production_image_clock_invalid");
    return new Date(time).toISOString();
  }
  private permit(p: RunPrincipal, project: string, write: boolean, edit = false): void {
    const o = this.config();
    if (p.tenantId !== o.tenantId
      || sync(() => o.authorizer.allows(p, project, "provider:read")) !== true
      || sync(() => o.runAuthorizer.allows(p, project, write ? "run:create" : "run:read")) !== true
      || (edit && sync(() => o.assetAuthorizer.allows(p, project, "asset:read")) !== true)) reject("production_image_permission_denied", 403);
  }
  private database<T>(operation: () => T): T {
    const o = this.config();
    try { return o.stateStore.transaction(operation); }
    catch (error) {
      if (error instanceof RunKernelError) throw error;
      reject("production_image_preparation_unavailable", 503); // No private port/SQL details.
    }
  }
  private current(tenant: string, project: string, id: string): ImageProviderConnection {
    const connection = this.config().stateStore.loadImageProviderHistory(tenant, project).filter((r) => r.connection.id === id).at(-1)?.connection;
    if (!connection) reject("production_image_connection_not_found", 404);
    return connection;
  }
  private validationRequest(draft: ProductionImageRequestDraft, now: string) {
    // Static-only validity marker, never a task, price source or execution key.
    // Production validation no longer fabricates an estimate, even in memory.
    return ProductionImageExecutionRequestSchema.parse({ ...draft, jobId: "production-static-validation-only", idempotencyKey: "not-an-execution",
      quote: { id: "validation-only", version: "not-a-price", source: "manual-budget", currency: "CNY", maxCostMinor: 0,
        expiresAt: new Date(Date.parse(now) + 1_000).toISOString() } });
  }
  private assertHistory(r: ProductionImagePreparationRecord): void {
    const o = this.config();
    const historical = o.stateStore.loadImageProviderHistory(r.tenantId, r.projectId).find((item) => item.connection.id === r.connection.id && item.connection.revision === r.connection.revision);
    if (r.mode !== this.mode || !historical || imageSnapshotFingerprint(historical.connection) !== imageSnapshotFingerprint(r.connection)
      || imageSnapshotFingerprint(r.selection) !== r.selectionFingerprint || imageSnapshotFingerprint(basis(r)) !== r.basisFingerprint
      || imageSnapshotFingerprint(frozen(r)) !== r.snapshotFingerprint || constraintContentChecksum(r.constraint) !== r.requestDraft.constraintChecksumSha256) reject("production_image_history_corrupt", 503);
  }
  createPreparation(principal: RunPrincipal, input: unknown) {
    // Default closed before parsing caller data or consulting any private store.
    const o = this.config();
    let selection: CreateImagePreparation;
    try { selection = CreateImagePreparationSchema.parse(input); } catch { reject("production_image_selection_invalid"); }
    return this.database(() => {
      const edit = selection.operation === "edit";
      this.permit(principal, selection.projectId, true, edit);
      const previous = o.stateStore.loadProductionImagePreparationByAction(principal.tenantId, selection.projectId, this.mode, selection.idempotencyKey);
      if (previous) {
        this.assertHistory(previous);
        if (previous.selectionFingerprint !== imageSnapshotFingerprint(selection)) reject("production_image_idempotency_conflict", 409);
        this.permit(principal, selection.projectId, true, edit);
        return view(previous); // Historical only, including expiration; no reprice.
      }
      const connection = this.current(principal.tenantId, selection.projectId, selection.connectionId);
      if (connection.protocol === "custom" || !connection.enabled || connection.revision !== selection.connectionRevision) reject("production_image_connection_changed");
      const project = o.stateStore.loadCatalog()?.projects.find((p) => p.projectId === selection.projectId);
      const constraint = project?.constraints.find((c) => c.id === selection.constraintSnapshotId);
      if (!constraint || selection.parameters.size === "auto") reject("production_image_explicit_output_required");
      const ids = selection.operation === "edit" ? [...selection.inputAssetIds, ...(selection.maskAssetId ? [selection.maskAssetId] : [])] : [];
      const refs = ids.map((id) => {
        const receipt = o.stateStore.loadVerifiedImage(principal.tenantId, selection.projectId, id);
        const asset = project!.assets.find((a) => a.id === id);
        if (!receipt || !asset || receipt.registeredMetadataSha256 !== assetMetadataFingerprint(asset)) reject("production_image_input_not_verified");
        return { assetId: id, checksumSha256: receipt.checksumSha256, mimeType: receipt.asset.mimeType,
          width: receipt.asset.width, height: receipt.asset.height, byteSize: receipt.asset.byteSize };
      });
      const requestedAt = this.now();
      const draft = ProductionImageRequestDraftSchema.parse({ schemaVersion: 1, tenantId: principal.tenantId, projectId: selection.projectId,
        connectionId: connection.id, connectionRevision: connection.revision, adapterId: connection.adapterId,
        model: selection.model, capabilityVersion: selection.capabilityVersion, constraintSnapshotId: constraint.id,
        constraintChecksumSha256: constraintContentChecksum(constraint), protection: selection.protection, parameters: selection.parameters,
        providerParameters: selection.providerParameters,
        ...(selection.operation === "edit" ? { operation: "edit", inputs: refs.slice(0, selection.inputAssetIds.length), mask: selection.maskAssetId ? refs.at(-1) : undefined }
          : { operation: "generate", inputs: [] }) });
      const validateCurrent = () => {
        this.permit(principal, selection.projectId, true, edit);
        if (imageSnapshotFingerprint(this.current(principal.tenantId, selection.projectId, connection.id)) !== imageSnapshotFingerprint(connection)) reject("production_image_connection_changed");
        const now = this.now(), request = this.validationRequest(draft, now);
        validateProductionImageProviderRequest(connection, request, now);
        validateProductionImageAssetPolicy(o.stateStore, request);
      };
      validateCurrent(); // Capacity/constraints before price port.
      if (Buffer.byteLength(JSON.stringify(basis({ connection, selection, requestDraft: draft, constraint }))) > 512 * 1024) reject("production_image_metadata_full", 413);
      const context: ImagePriceContext = { scope: { tenantId: principal.tenantId, projectId: selection.projectId, actorId: principal.actorId,
        connectionId: connection.id, connectionRevision: connection.revision, model: selection.model, capabilityVersion: selection.capabilityVersion,
        operation: selection.operation, selectionFingerprint: imageSnapshotFingerprint(selection),
        basisFingerprint: imageSnapshotFingerprint(basis({ connection, selection, requestDraft: draft, constraint })) },
        connection, selection, requestDraft: draft, constraint, requestedAt };
      const raw = sync(() => o.pricePort.read(structuredClone(context)));
      const pricing = this.mode === "production" ? ProductionImagePricingSchema.parse(raw) : FixtureProductionImagePricingSchema.parse(raw);
      const now = this.now();
      if (imageSnapshotFingerprint(pricing.scope) !== imageSnapshotFingerprint(context.scope)
        || Date.parse(pricing.evidence.checkedAt) < Date.parse(requestedAt) || Date.parse(pricing.evidence.checkedAt) > Date.parse(now)
        || Date.parse(now) < Date.parse(requestedAt) || Date.parse(now) >= Date.parse(pricing.quote.expiresAt)
        || sync(() => o.pricePort.verify(structuredClone(context), structuredClone(pricing))) !== true) reject("production_image_price_not_verified");
      validateCurrent();
      // Verification ports may revoke policies or advance time too.
      const createdAt = this.now();
      if (Date.parse(createdAt) < Date.parse(now) || Date.parse(createdAt) >= Date.parse(pricing.quote.expiresAt)) reject("production_image_price_expired");
      const budget = o.stateStore.load()?.budgets.find((b) => b.tenantId === principal.tenantId && b.projectId === selection.projectId);
      if (!budget || budget.currency !== pricing.quote.currency) reject("production_image_budget_currency_mismatch");
      if (o.stateStore.productionImagePreparationCount(principal.tenantId, selection.projectId) >= 1_000) reject("production_image_preparation_catalog_full", 413);
      const unsealed = { schemaVersion: 1, mode: this.mode, id: `production-image-preparation-${randomUUID()}`,
        tenantId: principal.tenantId, projectId: selection.projectId, status: "unconfirmed", executionAuthorized: false,
        realExecutionEnabled: false, protocolPreparation: "not-run", connection, selection, requestDraft: draft, constraint, pricing,
        selectionFingerprint: context.scope.selectionFingerprint, basisFingerprint: context.scope.basisFingerprint, createdBy: principal.actorId, createdAt };
      const record = ProductionImagePreparationRecordSchema.parse({ ...unsealed, snapshotFingerprint: imageSnapshotFingerprint(unsealed) });
      const bytes = Buffer.byteLength(JSON.stringify(record)), used = o.stateStore.imageMetadataBytes(principal.tenantId, selection.projectId)
        + imageTaskMetadataBytes(o.stateStore.load(), principal.tenantId, selection.projectId);
      if (bytes > 512 * 1024 || used + bytes > (o.maxMetadataBytes ?? 16 * 1024 * 1024)) reject("production_image_metadata_full", 413);
      o.stateStore.saveProductionImagePreparation(record);
      validateCurrent(); // Write + final-policy/drift failure rolls both rows back.
      const finalTime = Date.parse(this.now());
      if (finalTime < Date.parse(createdAt) || finalTime >= Date.parse(pricing.quote.expiresAt)) reject("production_image_price_expired");
      if (o.stateStore.load()?.budgets.find((b) => b.tenantId === principal.tenantId && b.projectId === selection.projectId)?.currency !== pricing.quote.currency) reject("production_image_budget_currency_mismatch");
      return view(record);
    });
  }
  getPreparation(principal: RunPrincipal, projectId: string, id: string) {
    return this.database(() => {
      this.permit(principal, projectId, false);
      const record = this.config().stateStore.loadProductionImagePreparation(principal.tenantId, projectId, this.mode, id);
      if (!record) reject("production_image_preparation_not_found", 404);
      this.permit(principal, projectId, false, record.requestDraft.operation === "edit");
      this.assertHistory(record);
      this.permit(principal, projectId, false, record.requestDraft.operation === "edit");
      return view(record);
    });
  }

  private confirmationPermit(p: RunPrincipal, project: string, write: boolean): void {
    const o = this.config();
    this.permit(p, project, write, true);
    if (sync(() => o.runAuthorizer.allows(p, project, "run:read")) !== true
      || (write && sync(() => o.runAuthorizer.allows(p, project, "run:confirm")) !== true)) reject("production_image_permission_denied", 403);
  }
  private loadConfirmation(p: RunPrincipal, record: ProductionImagePreparationRecord) {
    const o = this.config(), snapshot = o.stateStore.load();
    if (!snapshot) reject("production_image_task_snapshot_missing", 503);
    InMemoryRunKernel.assertSnapshot(snapshot); // No task recovery/save or lease mutation.
    for (const item of snapshot.batches) {
      const e = item.productionImageExecution;
      if (e && e.preparation.tenantId === record.tenantId && e.preparation.projectId === record.projectId) {
        const original = o.stateStore.loadProductionImagePreparation(e.preparation.tenantId, e.preparation.projectId, e.mode, e.preparation.id);
        if (!original || imageSnapshotFingerprint(original) !== imageSnapshotFingerprint(e.preparation)) reject("production_image_confirmation_corrupt", 503);
      }
    }
    const stored = snapshot.batches.find((item) => item.productionImageExecution?.mode === record.mode && item.productionImageExecution.preparation.id === record.id);
    if (!stored) return null;
    const e = assertProductionConfirmation(stored.productionImageExecution);
    if (imageSnapshotFingerprint(e.preparation) !== imageSnapshotFingerprint(record)) reject("production_image_confirmation_corrupt", 503);
    this.confirmationPermit(p, record.projectId, false);
    return { mode: e.mode, executionState: e.executionState, executionAuthorized: false as const, realExecutionEnabled: false as const,
      protocolPreparation: "prepared" as const, preparationId: record.id, preparationFingerprint: record.snapshotFingerprint,
      pricingFingerprint: e.protocol.pricingFingerprint, executionFingerprint: stored.requestFingerprint,
      requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256,
      payloadByteSize: e.protocol.payloadByteSize, contentType: e.protocol.contentType, transformedInputs: structuredClone(e.protocol.transformedInputs),
      confirmedBy: e.confirmedBy, confirmedAt: e.confirmedAt, pricing: structuredClone(record.pricing), aggregate: structuredClone(stored.aggregate) };
  }
  private currentConfirmation(p: RunPrincipal, record: ProductionImagePreparationRecord, extraBytes = 0): void {
    const o = this.config();
    const check = () => {
      this.confirmationPermit(p, record.projectId, true);
      const fresh = o.stateStore.loadProductionImagePreparation(p.tenantId, record.projectId, this.mode, record.id);
      if (!fresh || imageSnapshotFingerprint(fresh) !== imageSnapshotFingerprint(record)) reject("production_image_preparation_changed");
      if (p.actorId !== record.createdBy || imageSnapshotFingerprint(this.current(p.tenantId, record.projectId, record.connection.id)) !== imageSnapshotFingerprint(record.connection)) reject("production_image_connection_changed");
      const now = this.now();
      if (Date.parse(now) < Date.parse(record.createdAt) || Date.parse(now) >= Date.parse(record.pricing.quote.expiresAt)) reject("production_image_price_expired");
      const request = ProductionImageExecutionRequestSchema.parse({ ...record.requestDraft, jobId: "production-static-validation-only", idempotencyKey: "not-an-execution", quote: record.pricing.quote });
      validateProductionImageProviderRequest(record.connection, request, now);
      validateProductionImageAssetPolicy(o.stateStore, request);
      const budget = o.stateStore.load()?.budgets.find((b) => b.tenantId === p.tenantId && b.projectId === record.projectId);
      if (!budget || budget.currency !== record.pricing.quote.currency) reject("production_image_budget_currency_mismatch");
      const used = o.stateStore.imageMetadataBytes(p.tenantId, record.projectId) + imageTaskMetadataBytes(o.stateStore.load(), p.tenantId, record.projectId);
      if (used + extraBytes > (o.maxMetadataBytes ?? 16 * 1024 * 1024)) reject("production_image_metadata_full", 413);
    };
    check();
    const context: ImagePriceContext = { scope: record.pricing.scope, connection: record.connection, selection: record.selection,
      requestDraft: record.requestDraft, constraint: record.constraint, requestedAt: record.createdAt, validationAt: this.now(), purpose: "confirm" };
    if (sync(() => o.pricePort.verify(structuredClone(context), structuredClone(record.pricing))) !== true) reject("production_image_price_not_verified");
    check(); // A trusted oracle may change time, permissions or state.
  }
  // Only the live service continuation can supply this ephemeral proof. A
  // persisted "confirmed" label is never a new creation or send authorization.
  readonly authorizeConfirmation = (p: RunPrincipal, e: ConfirmedProductionImageExecution): boolean => {
    const hash = imageSnapshotFingerprint(e);
    if (this.pending.get(hash) !== `${p.tenantId}\u0000${p.actorId}` || e.mode !== this.mode || e.confirmedBy !== p.actorId) return false;
    assertProductionConfirmation(e);
    this.currentConfirmation(p, e.preparation);
    if (Date.parse(this.now()) < Date.parse(e.confirmedAt)) reject("production_image_clock_invalid");
    return true;
  };
  getConfirmation(p: RunPrincipal, projectId: string, id: string) {
    return this.database(() => {
      this.confirmationPermit(p, projectId, false);
      const record = this.config().stateStore.loadProductionImagePreparation(p.tenantId, projectId, this.mode, id);
      if (!record) reject("production_image_preparation_not_found", 404);
      this.assertHistory(record);
      return this.loadConfirmation(p, record);
    });
  }
  async confirmPreparation(p: RunPrincipal, projectId: string, id: string, input: unknown) {
    const o = this.config();
    if (!o.runKernel || !o.runKernel.usesStateStore(o.stateStore)) reject("production_image_confirmation_not_configured", 503);
    let expected: ConfirmProductionImagePreparation;
    try { expected = ConfirmProductionImagePreparationSchema.parse(input); } catch { reject("production_image_confirmation_invalid"); }
    const initial = this.database(() => {
      this.confirmationPermit(p, projectId, true);
      const record = o.stateStore.loadProductionImagePreparation(p.tenantId, projectId, this.mode, id);
      if (!record) reject("production_image_preparation_not_found", 404);
      this.assertHistory(record);
      if (record.createdBy !== p.actorId) reject("production_image_permission_denied", 403);
      validateProductionImageConfirmationExpectations(record, expected);
      const history = this.loadConfirmation(p, record);
      if (!history) this.currentConfirmation(p, record);
      return { record, history };
    });
    if (initial.history) return initial.history;
    if (activeConfirmations >= 2) reject("production_image_confirmation_busy", 429);
    activeConfirmations += 1;
    const images: NonNullable<ReturnType<SqliteRunKernelStateStore["loadVerifiedImageBytes"]>>[] = [];
    let wireBody: Buffer | undefined;
    try {
      const { record } = initial;
      // Explicit permissions and authoritative checks before touching originals.
      this.database(() => {
        this.currentConfirmation(p, record);
        const refs = record.requestDraft.operation === "edit" ? [...record.requestDraft.inputs, ...(record.requestDraft.mask ? [record.requestDraft.mask] : [])] : [];
        if (refs.reduce((total, ref) => total + ref.byteSize, 0) > 64 * 1024 * 1024) reject("production_image_inputs_too_large", 413);
        for (const ref of refs) {
          const image = o.stateStore.loadVerifiedImageBytes(p.tenantId, projectId, ref.assetId);
          if (!image) reject("production_image_input_not_verified");
          images.push(image);
        }
        this.currentConfirmation(p, record);
      });
      const prepared = await prepareProductionImageProtocol(record, expected, {
        jobId: `production-image-job-${randomUUID()}`, idempotencyKey: `production-image-execution-${randomUUID()}` }, images, this.now());
      wireBody = prepared.wire.body;
      return this.database(() => {
        this.confirmationPermit(p, projectId, true);
        const history = this.loadConfirmation(p, record);
        if (history) return history; // Concurrent winner, never a second reservation.
        this.currentConfirmation(p, record);
        const e = ConfirmedProductionImageExecutionSchema.parse({ schemaVersion: 1, mode: this.mode,
          batchId: `production-image-batch-${randomUUID()}`, executionState: "confirmed-not-dispatchable", executionAuthorized: false,
          realExecutionEnabled: false, preparation: record, protocol: prepared.snapshot, confirmedBy: p.actorId, confirmedAt: this.now() });
        assertProductionConfirmation(e);
        if (createHash("sha256").update(wireBody!).digest("hex") !== e.protocol.payloadChecksumSha256
          || wireBody!.byteLength !== e.protocol.payloadByteSize || prepared.wire.contentType !== e.protocol.contentType) reject("production_image_payload_changed");
        const bytes = Buffer.byteLength(JSON.stringify(e));
        if (bytes > 512 * 1024) reject("production_image_metadata_full", 413);
        this.currentConfirmation(p, record, bytes);
        const hash = imageSnapshotFingerprint(e);
        this.pending.set(hash, `${p.tenantId}\u0000${p.actorId}`);
        try { o.runKernel!.stageConfirmedProductionImageBatch(p, e); }
        finally { this.pending.delete(hash); }
        this.currentConfirmation(p, record); // Outer transaction also rolls back saved kernel state.
        if (Date.parse(this.now()) < Date.parse(e.confirmedAt)) reject("production_image_clock_invalid");
        const result = this.loadConfirmation(p, record);
        if (!result) reject("production_image_confirmation_corrupt", 503);
        return result;
      });
    } catch (error) {
      if (error instanceof RunKernelError) throw error;
      reject("production_image_confirmation_unavailable", 503);
    } finally {
      for (const image of images) image.body.fill(0);
      wireBody?.fill(0); activeConfirmations -= 1;
    }
  }
}

export class ProductionImagePreparations extends PreparationCore {
  constructor(options?: BaseOptions & { pricePort: ProductionImagePricePort }) { super("production", options); }
}
export class ImageProductionPreparationHarness extends PreparationCore {
  readonly realExecutionEnabled = false;
  constructor(options?: BaseOptions & { pricePort: FixtureProductionImagePricePort }) { super("production-contract-fixture", options); }
}
