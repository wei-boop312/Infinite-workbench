import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ConfirmImagePreparationSchema, ConfirmedImageExecutionSchema, CreateImagePreparationSchema, ImageExecutionRequestSchema, ImagePreparationRecordSchema, ImageProviderConnectionSchema, ImageProviderRevisionSchema, ImageRequestTemplateSchema, LocalImageQuoteSchema,
  type ConfirmImagePreparation, type ConfirmedImageExecution, type CreateImagePreparation, type ImagePreparationRecord, type ImageProviderConnection, type LocalImageQuote } from "@canvas/contracts";
import { ImageProviderContractError, imageProviderPublicView, imageSnapshotFingerprint, validateImageProviderRequest } from "./imageProviderContract";
import { constraintContentChecksum, validateLocalImageAssetPolicy } from "./imageAssetPolicy";
import { assetMetadataFingerprint } from "./verifiedAssets";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import { RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import { SqliteRunKernelStateStore, SqliteStateStoreError } from "./sqliteRunKernelStore";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import { prepareOpenAiImageRequest } from "./openaiImageProtocol";
import { prepareCompatibleImageRequest } from "./compatibleImageProtocol";
import { prepareGoogleImageRequest } from "./googleImageProtocol";
import type { TrustedImageBytes } from "./imageRequestPayload";

// Fail fast instead of accumulating unbounded decoded inputs in this process.
// This is not a cross-process resource limit or an untrusted-code sandbox.
let activeImageConfirmations = 0;

export interface ImageProviderAuthorizer {
  authenticate(request: IncomingMessage): RunPrincipal | null;
  allows(principal: RunPrincipal, projectId: string, permission: "provider:read" | "provider:manage"): boolean;
}
function reject(code: string, status = 422): never { throw new RunKernelError(status, code, "图片供应商目录或准备单不可用，未启动生成或修改预算"); }
const frozenPayload = (record: Pick<ImagePreparationRecord, "connection" | "requestTemplate" | "constraint" | "pricing">) => ({
  connection: record.connection, requestTemplate: record.requestTemplate, constraint: record.constraint, pricing: record.pricing,
});
function preparationView(record: ImagePreparationRecord) {
  return { id: record.id, projectId: record.projectId, status: record.status, executionAuthorized: record.executionAuthorized,
    protocolPreparation: record.protocolPreparation, mode: "local-fixture" as const, createdAt: record.createdAt,
    snapshotFingerprint: record.snapshotFingerprint, connection: imageProviderPublicView(record.connection),
    requestTemplate: record.requestTemplate, pricing: record.pricing };
}

// Local-only directory, preparations and staged confirmations. No executor,
// credentials resolution, network transport or auto-seeded provider/model.
export class LocalImageProviders {
  constructor(private readonly options: {
    tenantId: string; stateStore: SqliteRunKernelStateStore;
    authorizer: ImageProviderAuthorizer; runAuthorizer: RunAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
    estimate: (connection: ImageProviderConnection, selection: CreateImagePreparation, now: string) => LocalImageQuote;
    runKernel?: Pick<SqliteRunKernel, "stageConfirmedImageBatch" | "getBatch" | "usesStateStore">;
    maxMetadataBytes?: number; clock?: () => number;
  }) {
    const quota = options.maxMetadataBytes ?? 16 * 1024 * 1024;
    if (!options.tenantId.trim() || options.tenantId !== options.tenantId.trim() || options.tenantId.length > 160
      || !Number.isSafeInteger(quota) || quota < 0 || quota > 16 * 1024 * 1024) throw new Error("供应商目录的租户或容量配置无效");
    if (options.runKernel && !options.runKernel.usesStateStore(options.stateStore)) throw new Error("图片确认必须与任务内核共用同一事务存储实例");
  }
  authenticate(request: IncomingMessage): RunPrincipal | null { return this.options.authorizer.authenticate(request); }
  get confirmationsEnabled(): boolean { return Boolean(this.options.runKernel); }
  list(principal: RunPrincipal, projectId: string) {
    return this.database(() => {
      this.allow(principal, projectId, "provider:read");
      const latest = new Map<string, ImageProviderConnection>();
      for (const record of this.options.stateStore.loadImageProviderHistory(principal.tenantId, projectId)) latest.set(record.connection.id, record.connection);
      return [...latest.values()].map(imageProviderPublicView);
    });
  }
  get(principal: RunPrincipal, projectId: string, connectionId: string) {
    return this.database(() => {
      this.allow(principal, projectId, "provider:read");
      return imageProviderPublicView(this.current(principal.tenantId, projectId, connectionId));
    });
  }
  // Trusted server administrative entry only; there is deliberately no HTTP write route.
  registerRevision(principal: RunPrincipal, input: unknown, expectedRevision: number) {
    const connection = ImageProviderConnectionSchema.parse(input);
    return this.database(() => {
      this.allow(principal, connection.projectId, "provider:manage");
      if (connection.tenantId !== principal.tenantId) reject("image_connection_not_found", 404);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || connection.revision !== expectedRevision + 1) reject("image_connection_revision_conflict", 409);
      const history = this.options.stateStore.loadImageProviderHistory(connection.tenantId, connection.projectId);
      const versions = history.filter((item) => item.connection.id === connection.id);
      const current = versions.at(-1);
      if (current?.connection.revision === connection.revision && imageSnapshotFingerprint(current.connection) === imageSnapshotFingerprint(connection)) return imageProviderPublicView(current.connection);
      if ((current?.connection.revision ?? 0) !== expectedRevision) reject("image_connection_revision_conflict", 409);
      if ((!current && new Set(history.map((record) => record.connection.id)).size >= 64) || connection.revision > 32) reject("image_connection_catalog_full", 413);
      const record = ImageProviderRevisionSchema.parse({ schemaVersion: 1, connection, registeredBy: principal.actorId, registeredAt: this.now() });
      this.checkMetadataQuota(connection.tenantId, connection.projectId, record);
      this.options.stateStore.saveImageProviderRevision(record);
      return imageProviderPublicView(record.connection);
    });
  }

  createPreparation(principal: RunPrincipal, input: unknown) {
    const selection = CreateImagePreparationSchema.parse(input);
    return this.database(() => {
      this.allow(principal, selection.projectId, "provider:read");
      if (!this.options.runAuthorizer.allows(principal, selection.projectId, "run:create")) reject("image_preparation_permission_denied", 403);
      const previous = this.options.stateStore.loadImagePreparationByAction(principal.tenantId, selection.projectId, selection.idempotencyKey);
      if (previous) {
        this.assertPreparation(previous);
        if (previous.selectionFingerprint !== imageSnapshotFingerprint(selection)) reject("image_preparation_idempotency_conflict", 409);
        return preparationView(previous); // Recover history, not refresh price/authorize execution.
      }
      const connection = this.current(principal.tenantId, selection.projectId, selection.connectionId);
      if (connection.protocol === "custom") reject("image_protocol_not_implemented");
      if (selection.connectionRevision !== connection.revision) reject("image_connection_changed");
      const project = this.options.stateStore.loadCatalog()?.projects.find((item) => item.projectId === selection.projectId);
      const constraint = project?.constraints.find((item) => item.id === selection.constraintSnapshotId);
      if (!constraint) reject("image_output_constraint_changed");
      const references = selection.operation === "edit" ? [...selection.inputAssetIds, ...(selection.maskAssetId ? [selection.maskAssetId] : [])] : [];
      if (references.length && !this.options.assetAuthorizer.allows(principal, selection.projectId, "asset:read")) reject("image_preparation_permission_denied", 403);
      const refs = references.map((id) => {
        const receipt = this.options.stateStore.loadVerifiedImage(principal.tenantId, selection.projectId, id);
        const asset = project!.assets.find((item) => item.id === id);
        if (!receipt || !asset || receipt.registeredMetadataSha256 !== assetMetadataFingerprint(asset)) reject("image_input_not_verified");
        return { assetId: id, checksumSha256: receipt.checksumSha256, mimeType: receipt.asset.mimeType, width: receipt.asset.width, height: receipt.asset.height, byteSize: receipt.asset.byteSize };
      });
      const at = this.now();
      const request = ImageExecutionRequestSchema.parse({ schemaVersion: 1, tenantId: principal.tenantId, projectId: selection.projectId,
        jobId: "preparation-validation-only", idempotencyKey: "not-an-execution", connectionId: connection.id, connectionRevision: selection.connectionRevision,
        adapterId: connection.adapterId, model: selection.model, capabilityVersion: selection.capabilityVersion, constraintSnapshotId: constraint.id,
        constraintChecksumSha256: constraintContentChecksum(constraint), protection: selection.protection, parameters: selection.parameters,
        providerParameters: selection.providerParameters,
        ...(selection.operation === "edit" ? { operation: "edit", inputs: refs.slice(0, selection.inputAssetIds.length), mask: selection.maskAssetId ? refs.at(-1) : undefined } : { operation: "generate", inputs: [] }),
        quote: { id: "validation-only", version: "not-a-price", source: "manual-budget", currency: "CNY", estimatedCostMinor: 0, maxCostMinor: 0, expiresAt: new Date(Date.parse(at) + 1_000).toISOString() },
      });
      // Static policy runs BEFORE even the fake estimate. Input normalization and
      // actual protocol payload are deliberately pending until task binding.
      validateImageProviderRequest(connection, request, at);
      validateLocalImageAssetPolicy(this.options.stateStore, request);
      const pricing = LocalImageQuoteSchema.parse(this.options.estimate(ImageProviderConnectionSchema.parse(connection), CreateImagePreparationSchema.parse(selection), at));
      request.quote = pricing.quote;
      // The price port is synchronous/trusted but not allowed to change the
      // current selection, permissions, constraints or authoritative inputs.
      this.allow(principal, selection.projectId, "provider:read");
      if (!this.options.runAuthorizer.allows(principal, selection.projectId, "run:create")
        || (references.length && !this.options.assetAuthorizer.allows(principal, selection.projectId, "asset:read"))) reject("image_preparation_permission_denied", 403);
      if (imageSnapshotFingerprint(this.current(principal.tenantId, selection.projectId, connection.id)) !== imageSnapshotFingerprint(connection)) reject("image_connection_changed");
      validateImageProviderRequest(connection, request, this.now());
      validateLocalImageAssetPolicy(this.options.stateStore, request);
      const budget = this.options.stateStore.load()?.budgets.find((item) => item.tenantId === principal.tenantId && item.projectId === selection.projectId);
      if (!budget || budget.currency !== pricing.quote.currency) reject("image_preparation_budget_currency_mismatch");
      if (this.options.stateStore.imagePreparationCount(principal.tenantId, selection.projectId) >= 1_000) reject("image_preparation_catalog_full", 413);
      const { jobId: _job, idempotencyKey: _executionKey, ...template } = request;
      const frozen = { connection, requestTemplate: ImageRequestTemplateSchema.parse(template), constraint, pricing };
      const record = ImagePreparationRecordSchema.parse({ schemaVersion: 1, id: `image-preparation-${randomUUID()}`, tenantId: principal.tenantId, projectId: selection.projectId,
        status: "unconfirmed", executionAuthorized: false, protocolPreparation: "not-run", selection, selectionFingerprint: imageSnapshotFingerprint(selection),
        snapshotFingerprint: imageSnapshotFingerprint(frozenPayload(frozen)), ...frozen, createdBy: principal.actorId, createdAt: at });
      this.checkMetadataQuota(record.tenantId, record.projectId, record);
      this.options.stateStore.saveImagePreparation(record);
      return preparationView(record);
    });
  }
  getPreparation(principal: RunPrincipal, projectId: string, id: string) {
    return this.database(() => {
      this.allow(principal, projectId, "provider:read");
      if (!this.options.runAuthorizer.allows(principal, projectId, "run:read")) reject("image_preparation_not_found", 404);
      const record = this.options.stateStore.loadImagePreparation(principal.tenantId, projectId, id);
      if (!record) reject("image_preparation_not_found", 404);
      this.assertPreparation(record);
      return preparationView(record);
    });
  }

  async confirmPreparation(principal: RunPrincipal, projectId: string, id: string, input: unknown) {
    const confirmation = ConfirmImagePreparationSchema.parse(input);
    try {
      const initial = this.database(() => {
        const record = this.confirmationRecord(principal, projectId, id, confirmation);
        const previous = this.confirmedView(principal, record);
        if (previous) return { previous };
        if (activeImageConfirmations >= 2) reject("image_confirmation_capacity", 429);
        const request = ImageExecutionRequestSchema.parse({ ...record.requestTemplate, jobId: `job-${randomUUID()}`, idempotencyKey: `image-job-key-${randomUUID()}` });
        this.validateConfirmationCurrent(principal, record, request);
        const refs = request.operation === "edit" ? [...request.inputs, ...(request.mask ? [request.mask] : [])] : [];
        const images: TrustedImageBytes[] = refs.map((ref) => {
          const verified = this.options.stateStore.loadVerifiedImageBytes(principal.tenantId, projectId, ref.assetId);
          if (!verified) reject("image_input_not_verified");
          return verified;
        });
        return { record, request, images };
      });
      if (initial.previous) return initial.previous;
      if (activeImageConfirmations >= 2) reject("image_confirmation_capacity", 429);
      activeImageConfirmations++;
      try {
        // No SQLite writer lock is held across asynchronous decoding. The actual
        // server job/key already participates in protocol fingerprints/boundaries.
        const { record, request, images } = initial;
        const prepare = record!.connection.protocol === "openai" ? prepareOpenAiImageRequest
          : record!.connection.protocol === "openai-compatible" ? prepareCompatibleImageRequest : prepareGoogleImageRequest;
        const prepared = await prepare(record!.connection, request!, images!, this.now());
        return this.database(() => {
          const latest = this.confirmationRecord(principal, projectId, id, confirmation);
          const previous = this.confirmedView(principal, latest);
          if (previous) return previous; // A competing connection already committed.
          this.validateConfirmationCurrent(principal, latest, request!);
          const execution = ConfirmedImageExecutionSchema.parse({ schemaVersion: 1, mode: "local-fixture", realExecutionEnabled: false,
            batchId: `batch-${randomUUID()}`, preparation: latest, request, requestFingerprint: prepared.requestFingerprint,
            payloadChecksumSha256: prepared.payloadChecksumSha256, payloadByteSize: prepared.body.byteLength, contentType: prepared.contentType,
            protocolVersion: "pure-image-protocol-v1", transformedInputs: prepared.transformedInputs, confirmedBy: principal.actorId, confirmedAt: this.now() });
          this.checkMetadataQuota(principal.tenantId, projectId, execution);
          this.options.runKernel!.stageConfirmedImageBatch(principal, execution);
          const committed = this.confirmedView(principal, latest);
          if (!committed) throw new Error("图片确认提交后缺少任务证据");
          return committed;
        });
      } finally { activeImageConfirmations--; }
    } catch (error) { throw this.databaseFailure(error); }
  }

  private confirmationRecord(principal: RunPrincipal, projectId: string, id: string, confirmation: ConfirmImagePreparation): ImagePreparationRecord {
    this.allow(principal, projectId, "provider:read");
    if (!["run:create", "run:confirm", "run:read"].every((permission) => this.options.runAuthorizer.allows(principal, projectId, permission as "run:create" | "run:confirm" | "run:read"))) reject("image_confirmation_permission_denied", 403);
    if (!this.options.runKernel) reject("image_confirmation_not_configured", 503);
    const record = this.options.stateStore.loadImagePreparation(principal.tenantId, projectId, id);
    if (!record) reject("image_preparation_not_found", 404);
    this.assertPreparation(record);
    const quote = record.pricing.quote;
    if (confirmation.expectedSnapshotFingerprint !== record.snapshotFingerprint || confirmation.expectedEstimatedCostMinor !== quote.estimatedCostMinor
      || confirmation.expectedMaxCostMinor !== quote.maxCostMinor || confirmation.expectedCurrency !== quote.currency) reject("image_confirmation_snapshot_mismatch", 409);
    return record;
  }
  private validateConfirmationCurrent(principal: RunPrincipal, record: ImagePreparationRecord, request: ConfirmedImageExecution["request"]) {
    if (imageSnapshotFingerprint(this.current(principal.tenantId, record.projectId, record.connection.id)) !== imageSnapshotFingerprint(record.connection)) reject("image_connection_changed", 409);
    if (request.operation === "edit" && !this.options.assetAuthorizer.allows(principal, record.projectId, "asset:read")) reject("image_confirmation_permission_denied", 403);
    validateImageProviderRequest(record.connection, request, this.now());
    validateLocalImageAssetPolicy(this.options.stateStore, request);
  }
  private confirmedView(principal: RunPrincipal, record: ImagePreparationRecord) {
    const batches = this.options.stateStore.load()?.batches ?? [];
    const saved = batches.find((item) => item.aggregate.batch.tenantId === principal.tenantId && item.aggregate.batch.projectId === record.projectId
      && item.aggregate.batch.idempotencyKey === `image-confirm:${record.id}`);
    if (!saved) return undefined;
    const execution = saved.imageExecution;
    if (!execution || imageSnapshotFingerprint(execution.preparation) !== imageSnapshotFingerprint(record)) throw new Error("图片确认缺少原始准备单证据");
    const aggregate = this.options.runKernel!.getBatch(principal, execution.batchId); // Recheck full kernel conservation/frozen evidence.
    return { mode: "local-fixture" as const, realExecutionEnabled: false as const, executionAuthorized: false as const,
      executionState: "confirmed-not-dispatchable" as const, protocolPreparation: "prepared" as const,
      preparationId: record.id, preparationFingerprint: record.snapshotFingerprint, executionFingerprint: saved.requestFingerprint,
      confirmedBy: execution.confirmedBy, confirmedAt: execution.confirmedAt, requestFingerprint: execution.requestFingerprint,
      payloadChecksumSha256: execution.payloadChecksumSha256, transformedInputs: execution.transformedInputs, aggregate };
  }

  private current(tenantId: string, projectId: string, id: string): ImageProviderConnection {
    const connection = this.options.stateStore.loadImageProviderHistory(tenantId, projectId).filter((item) => item.connection.id === id).at(-1)?.connection;
    if (!connection) reject("image_connection_not_found", 404);
    return connection;
  }
  private assertPreparation(record: ImagePreparationRecord) {
    const historical = this.options.stateStore.loadImageProviderHistory(record.tenantId, record.projectId).find((item) => item.connection.id === record.connection.id && item.connection.revision === record.connection.revision);
    if (!historical || imageSnapshotFingerprint(historical.connection) !== imageSnapshotFingerprint(record.connection)
      || record.selectionFingerprint !== imageSnapshotFingerprint(record.selection)
      || record.snapshotFingerprint !== imageSnapshotFingerprint(frozenPayload(record)) || record.requestTemplate.constraintChecksumSha256 !== constraintContentChecksum(record.constraint)) throw new Error("图片准备单冻结内容已损坏");
  }
  private allow(principal: RunPrincipal, projectId: string, permission: "provider:read" | "provider:manage") {
    if (principal.tenantId !== this.options.tenantId || !this.options.authorizer.allows(principal, projectId, permission)) reject("image_connection_not_found", 404);
  }
  private now(): string { return new Date((this.options.clock ?? Date.now)()).toISOString(); }
  private checkMetadataQuota(tenantId: string, projectId: string, record: unknown) {
    const size = Buffer.byteLength(JSON.stringify(record), "utf8");
    const executionBytes = (this.options.stateStore.load()?.batches ?? []).filter((item) => item.aggregate.batch.tenantId === tenantId && item.aggregate.batch.projectId === projectId)
      .reduce((total, item) => total + (item.imageExecution ? Buffer.byteLength(JSON.stringify(item.imageExecution), "utf8") : 0)
        + (item.imageDispatchIntent ? Buffer.byteLength(JSON.stringify(item.imageDispatchIntent), "utf8") : 0), 0);
    if (size > 512 * 1024 || this.options.stateStore.imageMetadataBytes(tenantId, projectId) + executionBytes + size > (this.options.maxMetadataBytes ?? 16 * 1024 * 1024)) reject("image_metadata_quota", 413);
  }
  private database<T>(action: () => T): T {
    try { return this.options.stateStore.transaction(action); }
    catch (error) {
      throw this.databaseFailure(error);
    }
  }
  private databaseFailure(error: unknown): RunKernelError {
    if (error instanceof RunKernelError) return error;
    if (error instanceof ImageProviderContractError) return new RunKernelError(422, error.code, "供应商图片合同拒绝当前准备单");
    return new RunKernelError(503, error instanceof SqliteStateStoreError ? error.code : "run_state_unavailable", "图片供应商数据库不可用，保持原确认动作编号恢复");
  }
}
