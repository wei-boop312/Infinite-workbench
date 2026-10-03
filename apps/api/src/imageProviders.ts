import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { CreateImagePreparationSchema, ImageExecutionRequestSchema, ImagePreparationRecordSchema, ImageProviderConnectionSchema, ImageProviderRevisionSchema, ImageRequestTemplateSchema, LocalImageQuoteSchema,
  type CreateImagePreparation, type ImagePreparationRecord, type ImageProviderConnection, type LocalImageQuote } from "@canvas/contracts";
import { ImageProviderContractError, imageProviderPublicView, imageSnapshotFingerprint, validateImageProviderRequest } from "./imageProviderContract";
import { constraintContentChecksum, validateLocalImageAssetPolicy } from "./imageAssetPolicy";
import { assetMetadataFingerprint } from "./verifiedAssets";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import { RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import { SqliteRunKernelStateStore, SqliteStateStoreError } from "./sqliteRunKernelStore";

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

// Local-only directory and PRE-confirmation snapshots. No execute/confirm method,
// credentials resolution, network transport or auto-seeded provider/model.
export class LocalImageProviders {
  constructor(private readonly options: {
    tenantId: string; stateStore: SqliteRunKernelStateStore;
    authorizer: ImageProviderAuthorizer; runAuthorizer: RunAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
    estimate: (connection: ImageProviderConnection, selection: CreateImagePreparation, now: string) => LocalImageQuote;
    maxMetadataBytes?: number; clock?: () => number;
  }) {
    const quota = options.maxMetadataBytes ?? 16 * 1024 * 1024;
    if (!options.tenantId.trim() || options.tenantId !== options.tenantId.trim() || options.tenantId.length > 160
      || !Number.isSafeInteger(quota) || quota < 0 || quota > 16 * 1024 * 1024) throw new Error("供应商目录的租户或容量配置无效");
  }
  authenticate(request: IncomingMessage): RunPrincipal | null { return this.options.authorizer.authenticate(request); }
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
    if (size > 512 * 1024 || this.options.stateStore.imageMetadataBytes(tenantId, projectId) + size > (this.options.maxMetadataBytes ?? 16 * 1024 * 1024)) reject("image_metadata_quota", 413);
  }
  private database<T>(action: () => T): T {
    try { return this.options.stateStore.transaction(action); }
    catch (error) {
      if (error instanceof RunKernelError) throw error;
      if (error instanceof ImageProviderContractError) throw new RunKernelError(422, error.code, "供应商图片合同拒绝当前准备单");
      throw new RunKernelError(503, error instanceof SqliteStateStoreError ? error.code : "run_state_unavailable", "图片供应商目录数据库不可用，未启动生成或修改预算");
    }
  }
}
