import type { IncomingMessage } from "node:http";
import type { ObjectStorageAuthorizer, StoragePrincipal } from "./objectStorageGateway";
import { assertImageArtifactRecord } from "./imageArtifactIntegrity";
import { parseStoredImageResponse } from "./imageArtifactPolicy";
import { imageSnapshotFingerprint } from "./imageProviderContract";
import { MAX_IMAGE_PROTOCOL_OUTPUT_BYTES } from "./imageProtocolResponse";
import { assetMetadataFingerprint } from "./verifiedAssets";
import { imageMagicMime, MAX_STATIC_IMAGE_PIXELS, MAX_STATIC_IMAGE_EDGE } from "./staticImageDecoder";
import { InMemoryRunKernel, RunKernelError } from "./runKernel";
import { SqliteRunKernelStateStore, SqliteStateStoreError } from "./sqliteRunKernelStore";

export type GeneratedAssetContent = { body: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp"; checksumSha256: string };
export interface GeneratedAssetReadPort {
  authenticate(request: IncomingMessage): StoragePrincipal | null;
  read(principal: StoragePrincipal, projectId: string, assetId: string): GeneratedAssetContent;
}
function validId(id: string) { return id.length > 0 && id.length <= 160 && id.trim() === id && !/[\x00-\x1f\x7f]/.test(id); }
function notFound(): never { throw new RunKernelError(404, "generated_asset_not_found", "生成资产不可用"); }

// Only immutable, task-bound generated images. This reader has NO send, write,
// quote, accounting or execution-authority port, and exposes no private receipt.
export class LocalGeneratedAssetReads implements GeneratedAssetReadPort {
  constructor(private readonly options: { tenantId: string; stateStore: SqliteRunKernelStateStore; authorizer: ObjectStorageAuthorizer }) {
    if (!validId(options.tenantId)) throw new Error("生成资产读取租户配置无效");
  }
  authenticate(request: IncomingMessage) { return this.options.authorizer.authenticate(request); }
  read(principal: StoragePrincipal, projectId: string, assetId: string): GeneratedAssetContent {
    const actor = { ...principal };
    const allowed = () => actor.tenantId === this.options.tenantId && validId(projectId) && validId(assetId)
      && this.options.authorizer.allows(actor, projectId, "asset:read") === true;
    // Before touching the private snapshot, catalog, raw packet or image bytes.
    if (!allowed()) notFound();
    try {
      return this.options.stateStore.transaction(() => {
        const snapshot = this.options.stateStore.load();
        if (!snapshot) notFound();
        // Reuse all task/lease/audit/billing consistency checks WITHOUT recovering
        // expired leases or rewriting another project's running job on a read.
        InMemoryRunKernel.assertSnapshot(snapshot);
        const matches = snapshot.batches.filter((stored) => stored.aggregate.batch.tenantId === actor.tenantId && stored.aggregate.batch.projectId === projectId
          && (stored.imageTaskArtifact?.assetId === assetId || stored.aggregate.jobs.some((job) => job.outputAssetIds.includes(assetId))));
        if (!matches.length) notFound();
        if (matches.length !== 1) throw new Error("生成资产对应多个任务");
        const stored = matches[0], artifact = stored.imageTaskArtifact, execution = stored.imageExecution;
        if (!artifact || !execution || stored.imageFixtureResult?.kind !== "returned") throw new Error("生成资产缺少持久化任务绑定");
        const record = this.options.stateStore.loadGeneratedImage(actor.tenantId, projectId, artifact.jobId);
        assertImageArtifactRecord(stored, record);
        const registered = this.options.stateStore.loadCatalog()?.projects.find((project) => project.projectId === projectId)?.assets.find((asset) => asset.id === assetId);
        const preparation = this.options.stateStore.loadImagePreparation(actor.tenantId, projectId, execution.preparation.id);
        const raw = this.options.stateStore.loadImageFixtureResponse(actor.tenantId, projectId, artifact.jobId);
        if (!registered || assetMetadataFingerprint(registered) !== record.image.registeredMetadataSha256
          || !preparation || imageSnapshotFingerprint(preparation) !== imageSnapshotFingerprint(execution.preparation)
          || !raw || imageSnapshotFingerprint(raw.record) !== stored.imageFixtureResultFingerprint) throw new Error("生成资产目录、确认或原响应损坏");
        const parsed = parseStoredImageResponse(execution, raw), candidate = parsed.candidate;
        const image = this.options.stateStore.loadVerifiedImageBytes(actor.tenantId, projectId, assetId);
        if (!image || !candidate || candidate.checksumSha256 !== record.image.checksumSha256 || candidate.body.byteLength !== image.body.byteLength
          || candidate.mimeType !== image.receipt.asset.mimeType || image.body.byteLength > MAX_IMAGE_PROTOCOL_OUTPUT_BYTES
          || image.receipt.asset.width * image.receipt.asset.height > MAX_STATIC_IMAGE_PIXELS
          || Math.max(image.receipt.asset.width, image.receipt.asset.height) > MAX_STATIC_IMAGE_EDGE
          || !["image/png", "image/jpeg", "image/webp"].includes(image.receipt.asset.mimeType)
          || imageMagicMime(image.body) !== image.receipt.asset.mimeType) throw new Error("生成资产正文或实际候选错配");
        if (!allowed()) notFound();
        return { body: image.body, mimeType: candidate.mimeType, checksumSha256: image.receipt.checksumSha256 };
      });
    } catch (error) {
      if (error instanceof RunKernelError && error.code === "generated_asset_not_found") throw error;
      throw new RunKernelError(503, error instanceof SqliteStateStoreError ? error.code : "generated_asset_unavailable", "生成资产无法完整读取，未重新生成或更改费用");
    }
  }
}
