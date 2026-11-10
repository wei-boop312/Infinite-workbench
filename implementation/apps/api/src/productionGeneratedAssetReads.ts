import type { IncomingMessage } from "node:http";
import { ProductionGeneratedAssetMetadataSchema, ProductionGeneratedAssetLineageSchema, type ProductionGeneratedAssetMetadata,
  type ProductionGeneratedAssetLineage } from "@canvas/contracts";
import { RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import { validateProductionImageReadSnapshot } from "./productionImageReadIntegrity";
import { imageProviderPublicView, imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { imageMagicMime } from "./staticImageDecoder";

type Mode = ProductionGeneratedAssetMetadata["mode"];
type Options = { generatedReadEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel;
  assetAuthorizer: ObjectStorageAuthorizer; runAuthorizer?: RunAuthorizer };
export type ProductionGeneratedAssetContent = { metadata: ProductionGeneratedAssetMetadata; body: Buffer };
function valid(id: unknown): id is string { return typeof id === "string" && id.trim() === id && id.length > 0 && id.length <= 160 && !/[\x00-\x1f\x7f]/.test(id); }
function reject(code = "production_generated_asset_unavailable", status = 503): never { throw new RunKernelError(status, code, "生产产物读取失败关闭，未重新生成或更改费用"); }
function strict(value: unknown) {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => undefined);
  if (value !== true) reject("production_generated_asset_not_found", 404);
}
class ReadCore {
  private readonly options?: Options;
  constructor(private readonly mode: Mode, options?: Options) { this.options = options ? { ...options } : undefined; if (this.options) this.config(); }
  private config(): Options {
    const o = this.options;
    if (!o || o.generatedReadEnabled !== true) reject("production_generated_asset_not_configured");
    if (!valid(o.tenantId) || !o.runKernel?.usesStateStore(o.stateStore) || !o.stateStore.supportsProductionImageResponses()
      || !o.stateStore.supportsProductionImageArtifacts() || !o.assetAuthorizer) reject("production_generated_asset_configuration_invalid");
    return o;
  }
  private safe<T>(action: () => T): T { try { return action(); } catch (e) {
    if (e instanceof RunKernelError && ["production_generated_asset_not_found", "production_generated_asset_not_configured", "production_generated_asset_configuration_invalid", "production_generated_asset_lineage_not_configured"].includes(e.code)) throw e;
    reject();
  } }
  authenticate(request: IncomingMessage): RunPrincipal | null {
    return this.safe(() => { const o = this.config(), p = o.assetAuthorizer.authenticate(request);
      if (p && (typeof p !== "object" || "then" in p)) { void Promise.resolve(p).catch(() => undefined); reject(); }
      return p && p.tenantId === o.tenantId && valid(p.actorId) ? { tenantId: p.tenantId, actorId: p.actorId } : null; });
  }
  private scope(p: RunPrincipal, project: string, asset: string, lineage: boolean) {
    const o = this.config();
    if (lineage && !o.runAuthorizer) reject("production_generated_asset_lineage_not_configured");
    if (!valid(p?.actorId) || p.tenantId !== o.tenantId || !valid(project) || !valid(asset)) reject("production_generated_asset_not_found", 404);
    strict(o.assetAuthorizer.allows({ ...p }, project, "asset:read"));
    if (lineage) strict(o.runAuthorizer!.allows({ ...p }, project, "run:read"));
  }
  read(p: RunPrincipal, project: string, asset: string): ProductionGeneratedAssetContent { return this.verified(p, project, asset, false) as ProductionGeneratedAssetContent; }
  lineage(p: RunPrincipal, project: string, asset: string): ProductionGeneratedAssetLineage { return this.verified(p, project, asset, true) as ProductionGeneratedAssetLineage; }
  private verified(p: RunPrincipal, project: string, asset: string, lineage: boolean) {
    return this.safe(() => { const actor = { ...p }, guard = () => this.scope(actor, project, asset, lineage); guard(); const o = this.config();
      return o.stateStore.transaction(() => {
        guard(); const snapshot = o.stateStore.load(); guard(); if (!snapshot) reject("production_generated_asset_not_found", 404);
        guard(); const catalogHash = fp(o.stateStore.loadCatalog()); guard();
        validateProductionImageReadSnapshot(o.stateStore, o.runKernel, actor.tenantId, project, snapshot, guard);
        const matches = snapshot.batches.filter(s => s.aggregate.batch.tenantId === actor.tenantId && s.aggregate.batch.projectId === project
          && (s.productionImageArtifact?.image.asset.id === asset || s.aggregate.jobs.some(j => j.outputAssetIds.includes(asset))));
        if (!matches.length) reject("production_generated_asset_not_found", 404);
        if (matches.length !== 1) reject(); const s = matches[0], e = s.productionImageExecution, a = s.productionImageArtifact, j = s.aggregate.jobs[0];
        if (!e || e.mode !== this.mode || !a || a.mode !== this.mode || !s.productionImageArtifactFingerprint || !["billing_unknown", "succeeded"].includes(j.status)) reject();
        guard(); const image = o.stateStore.loadVerifiedImageBytes(actor.tenantId, project, asset);
        let outgoing: Buffer | undefined;
        try { guard();
          if (!image || fp(image.receipt) !== fp(a.image) || imageMagicMime(image.body) !== a.image.asset.mimeType) reject();
          const metadata = ProductionGeneratedAssetMetadataSchema.parse({ schemaVersion: 1, mode: this.mode, tenantId: actor.tenantId, projectId: project,
            executionAuthorized: false, realExecutionEnabled: false, image: a.image, artifactFingerprint: s.productionImageArtifactFingerprint });
          const result = lineage ? ProductionGeneratedAssetLineageSchema.parse({ ...metadata, batchId: s.aggregate.batch.id, jobId: j.id, jobStatus: j.status,
            connection: imageProviderPublicView(e.preparation.connection), requestDraft: e.preparation.requestDraft, constraint: a.constraint,
            pricing: { schemaVersion: e.preparation.pricing.schemaVersion, quote: e.preparation.pricing.quote, evidence: e.preparation.pricing.evidence },
            preparationId: e.preparation.id, preparationFingerprint: e.preparation.snapshotFingerprint, pricingFingerprint: e.protocol.pricingFingerprint,
            executionFingerprint: fp(e), requestFingerprint: e.protocol.requestFingerprint,
            payloadChecksumSha256: e.protocol.payloadChecksumSha256, transformedInputs: a.transformedInputs, confirmedBy: e.confirmedBy, confirmedAt: e.confirmedAt,
            billing: { state: j.status === "succeeded" ? "settled" : "unknown", currency: s.aggregate.batch.currency, estimatedMinor: j.estimatedCostMinor,
              maxCostMinor: e.protocol.request.quote.maxCostMinor, currentMaxCostMinor: s.aggregate.batch.maxCostMinor,
              reservedMinor: s.jobReservations.find(([id]) => id === j.id)?.[1] ?? 0, ...(j.actualCostMinor === undefined ? {} : { actualMinor: j.actualCostMinor }) } }) : metadata;
          if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) reject();
          validateProductionImageReadSnapshot(o.stateStore, o.runKernel, actor.tenantId, project, snapshot, guard);
          guard(); if (fp(o.stateStore.load()) !== fp(snapshot) || fp(o.stateStore.loadCatalog()) !== catalogHash) reject(); guard();
          if (lineage) return result;
          outgoing = Buffer.from(image.body); return { metadata, body: outgoing };
        } catch (error) { outgoing?.fill(0); throw error; }
        finally { image?.body.fill(0); }
      });
    });
  }
}
export class ProductionGeneratedAssetReads extends ReadCore { constructor(options?: Options) { super("production", options); } }
export class ImageProductionGeneratedAssetReadHarness extends ReadCore { constructor(options?: Options) { super("production-contract-fixture", options); } }
export type ProductionGeneratedAssetReadPort = ProductionGeneratedAssetReads | ImageProductionGeneratedAssetReadHarness;
