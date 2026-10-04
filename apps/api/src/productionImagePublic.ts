import type { IncomingMessage } from "node:http";
import { ConfirmProductionImagePreparationSchema, CreateImagePreparationSchema, ProductionImagePreparationPublicSchema, ProductionImageConfirmationPublicSchema,
  ProductionImageConfirmationHistorySchema, type ProductionImagePreparationRecord, type RunKernelSnapshot } from "@canvas/contracts";
import { ImageProductionPreparationHarness, ProductionImagePreparations } from "./productionImagePreparations";
import { imageProviderPublicView, imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { validateProductionImageAssetPolicy } from "./imageAssetPolicy";
import { assertProductionImageRawResponse } from "./productionImageResponse";
import { assertProductionImageArtifact } from "./productionImageArtifactIntegrity";
import { assetMetadataFingerprint } from "./verifiedAssets";
import { RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";

type Mode = ProductionImagePreparationRecord["mode"];
interface Base { publicPreparationEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel;
  runAuthorizer: RunAuthorizer; providerAuthorizer: ImageProviderAuthorizer; assetAuthorizer: ObjectStorageAuthorizer }
type Options = Base & { preparations: ProductionImagePreparations | ImageProductionPreparationHarness };
function reject(code = "production_image_public_unavailable", status = 503): never { throw new RunKernelError(status, code, "生产准备/确认入口失败关闭，未获真实执行许可"); }
function strict(check: () => unknown) {
  const value = check();
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => undefined);
  if (value !== true) reject("production_image_public_permission_denied", 403);
}
const publicPricing = (r: ProductionImagePreparationRecord) => ({ quote: structuredClone(r.pricing.quote), schemaVersion: r.pricing.schemaVersion, evidence: structuredClone(r.pricing.evidence) });

// Trusted, explicit server injection only. No daily bridge, credential/network,
// billing or executor capability. This wrapper never accepts a confirmed object.
class PublicCore {
  constructor(readonly mode: Mode, private readonly options?: Options) {
    if (options) this.config();
  }
  private config(): Options {
    const o = this.options;
    if (!o || o.publicPreparationEnabled !== true) reject("production_image_public_not_configured");
    if (!o.tenantId || o.tenantId.trim() !== o.tenantId || o.tenantId.length > 160 || !o.preparations?.usesStateStore(o.stateStore) || !o.runKernel?.usesStateStore(o.stateStore)
      || !o.stateStore.supportsProductionImageResponses() || !o.stateStore.supportsProductionImageArtifacts()
      || (this.mode === "production" ? !(o.preparations instanceof ProductionImagePreparations) : !(o.preparations instanceof ImageProductionPreparationHarness))) reject("production_image_public_configuration_invalid");
    return o;
  }
  private safe<T>(operation: () => T): T { try { return operation(); } catch (e) { if (e instanceof RunKernelError) throw e; reject(); } }
  authenticate(request: IncomingMessage): RunPrincipal | null {
    return this.safe(() => { const o = this.config(), p = o.runAuthorizer.authenticate(request);
      if (p && (typeof p !== "object" || "then" in p)) { void Promise.resolve(p).catch(() => undefined); reject("production_image_public_authentication_invalid", 401); }
      return p && p.tenantId === o.tenantId && typeof p.actorId === "string" && p.actorId.trim() === p.actorId && p.actorId.length > 0 && p.actorId.length <= 160 ? { tenantId: p.tenantId, actorId: p.actorId } : null;
    });
  }
  private scope(p: RunPrincipal, project: string, action: "read" | "prepare" | "confirm") {
    const o = this.config();
    if (p.tenantId !== o.tenantId) reject("production_image_public_permission_denied", 403);
    strict(() => o.runAuthorizer.allows(p, project, "run:read")); strict(() => o.providerAuthorizer.allows(p, project, "provider:read"));
    strict(() => o.assetAuthorizer.allows(p, project, "asset:read"));
    if (action !== "read") strict(() => o.runAuthorizer.allows(p, project, "run:create"));
    if (action === "confirm") strict(() => o.runAuthorizer.allows(p, project, "run:confirm"));
  }
  private record(p: RunPrincipal, project: string, id: string) {
    this.scope(p, project, "read"); const o = this.config();
    o.preparations.getPreparation(p, project, id); // Complete immutable history SHA and original directory relation.
    const r = o.stateStore.loadProductionImagePreparation(p.tenantId, project, this.mode, id);
    this.scope(p, project, "read"); if (!r) reject("production_image_public_preparation_missing"); return r;
  }
  private view(r: ProductionImagePreparationRecord) {
    const { selection: _selection, selectionFingerprint: _selectionHash, connection, pricing: _pricing, ...rest } = r;
    const result = ProductionImagePreparationPublicSchema.parse({ ...rest, connection: imageProviderPublicView(connection), pricing: publicPricing(r), pricingFingerprint: fp(r.pricing) });
    if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) reject("production_image_public_response_too_large", 413); return result;
  }
  createPreparation(p: RunPrincipal, project: string, incoming: unknown) {
    return this.safe(() => { this.scope(p, project, "prepare"); const input = CreateImagePreparationSchema.parse(incoming);
      if (input.projectId !== project) reject("production_image_public_project_mismatch", 422);
      return this.config().stateStore.transaction(() => { this.scope(p, project, "prepare");
        const created = this.config().preparations.createPreparation(p, input), result = this.view(this.record(p, project, created.id)); this.scope(p, project, "prepare"); return result; }); });
  }
  getPreparation(p: RunPrincipal, project: string, id: string) {
    return this.safe(() => { this.scope(p, project, "read"); return this.config().stateStore.transaction(() => {
      const result = this.view(this.record(p, project, id)); this.scope(p, project, "read"); return result; }); });
  }
  private evidence(p: RunPrincipal, project: string, snapshot: RunKernelSnapshot) {
    const o = this.config(), guard = () => this.scope(p, project, "read"); guard(); o.runKernel.validateProductionBillingSnapshot(snapshot);
    // Check every original production task in this readable project, including
    // orphan rows when ALL task response/artifact fields have been removed.
    for (const s of snapshot.batches.filter(b => b.aggregate.batch.tenantId === p.tenantId && b.aggregate.batch.projectId === project && b.productionImageExecution)) {
      const e = s.productionImageExecution!, job = e.protocol.request.jobId; guard();
      const original = o.stateStore.loadProductionImagePreparation(p.tenantId, project, e.mode, e.preparation.id); guard();
      if (!original || fp(original) !== fp(e.preparation)) reject();
      validateProductionImageAssetPolicy(o.stateStore, e.protocol.request, guard); guard();
      const artifact = o.stateStore.supportsProductionImageArtifacts() || s.productionImageArtifact ? o.stateStore.loadProductionImageArtifact(p.tenantId, project, e.mode, job) : null; guard();
      const raw = o.stateStore.supportsProductionImageResponses() || s.productionImageAttempt || s.productionImageResult ? o.stateStore.loadProductionImageResponse(p.tenantId, project, e.mode, job) : null;
      try { guard();
        if (s.productionImageResult?.kind === "returned") {
          if (!raw || fp(raw.record) !== s.productionImageResultFingerprint || fp(raw.record) !== fp(s.productionImageResult)) reject();
          const parsed = assertProductionImageRawResponse(raw.record, e, s.productionImageLeases?.at(-1), s.productionImageDispatchIntent, s.productionImageAttempt, raw.body);
          try {
            if (s.productionImageArtifact) {
              if (!artifact || fp(artifact) !== s.productionImageArtifactFingerprint || fp(artifact) !== fp(s.productionImageArtifact)) reject();
              assertProductionImageArtifact(s, artifact); guard();
              const asset = o.stateStore.loadCatalog()?.projects.find(v => v.projectId === project)?.assets.find(a => a.id === artifact.image.asset.id); guard();
              if (!asset || assetMetadataFingerprint(asset) !== artifact.image.registeredMetadataSha256 || !parsed.candidate
                || parsed.candidate.checksumSha256 !== artifact.image.checksumSha256 || parsed.candidate.mimeType !== asset.mimeType || parsed.candidate.body.length !== asset.byteSize) reject();
            } else if (artifact) reject();
          } finally { parsed.candidate?.body.fill(0); }
        } else if (raw || artifact || s.productionImageArtifact) reject();
      } finally { raw?.body.fill(0); }
      validateProductionImageAssetPolicy(o.stateStore, e.protocol.request, guard); guard();
    }
    guard(); if (fp(o.stateStore.load()) !== fp(snapshot)) reject("production_image_public_history_changed"); guard();
  }
  getConfirmation(p: RunPrincipal, project: string, id: string) {
    return this.safe(() => { this.scope(p, project, "read"); const o = this.config(); return o.stateStore.transaction(() => {
      const r = this.record(p, project, id), snapshot = o.stateStore.load(); if (!snapshot) reject();
      this.evidence(p, project, snapshot);
      const history = o.preparations.getConfirmation(p, project, id); this.scope(p, project, "read");
      let confirmation = null;
      if (history) {
        const { batch, jobs } = history.aggregate, j = jobs[0];
        confirmation = ProductionImageConfirmationPublicSchema.parse({ schemaVersion: 1, tenantId: p.tenantId, projectId: project, mode: history.mode,
          executionState: history.executionState, executionAuthorized: false, realExecutionEnabled: false, protocolPreparation: history.protocolPreparation,
          preparationId: id, preparationFingerprint: history.preparationFingerprint, pricingFingerprint: history.pricingFingerprint,
          executionFingerprint: history.executionFingerprint, requestFingerprint: history.requestFingerprint, payloadChecksumSha256: history.payloadChecksumSha256,
          payloadByteSize: history.payloadByteSize, contentType: history.contentType, transformedInputs: history.transformedInputs, confirmedBy: history.confirmedBy, confirmedAt: history.confirmedAt,
          pricing: publicPricing(r), task: { batchId: batch.id, jobId: j.id, tool: batch.tool, adapterId: batch.adapterId, constraintSnapshotId: batch.constraintSnapshotId,
            inputAssetIds: j.inputAssetIds, outputAssetIds: j.outputAssetIds, batchStatus: batch.status, jobStatus: j.status, estimatedCostMinor: j.estimatedCostMinor,
            currentMaxCostMinor: batch.maxCostMinor, ...(j.actualCostMinor === undefined ? {} : { actualCostMinor: j.actualCostMinor }) } });
      }
      const result = ProductionImageConfirmationHistorySchema.parse({ schemaVersion: 1, mode: this.mode, tenantId: p.tenantId, projectId: project, preparationId: id,
        preparationFingerprint: r.snapshotFingerprint, pricingFingerprint: fp(r.pricing), confirmation });
      if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) reject("production_image_public_response_too_large", 413);
      this.evidence(p, project, snapshot); this.scope(p, project, "read"); return result;
    }); });
  }
  async confirmPreparation(p: RunPrincipal, project: string, id: string, incoming: unknown) {
    p = { ...p };
    try { this.scope(p, project, "confirm"); const input = ConfirmProductionImagePreparationSchema.parse(incoming);
      await this.config().preparations.confirmPreparation(p, project, id, input); this.scope(p, project, "confirm");
      const result = this.getConfirmation(p, project, id).confirmation; if (!result) reject(); return result;
    } catch (e) { if (e instanceof RunKernelError) throw e; reject(); }
  }
}
export class ProductionImagePublicService extends PublicCore { constructor(o?: Base & { preparations: ProductionImagePreparations }) { super("production", o); } }
export class ImageProductionPublicHarness extends PublicCore { constructor(o?: Base & { preparations: ImageProductionPreparationHarness }) { super("production-contract-fixture", o); } }
export type ProductionImagePublicPort = ProductionImagePublicService | ImageProductionPublicHarness;
