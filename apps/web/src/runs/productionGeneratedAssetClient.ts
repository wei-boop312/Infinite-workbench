import { ProductionGeneratedReadScopeSchema, type Asset, type ProductionGeneratedAssetLineage, type ProductionGeneratedReadScope } from "@canvas/contracts";
import { localStudioFetch } from "./runClient";
import { assetRepository } from "../assets/assetRepository";
import { blobSha256 } from "../assets/generatedAssetPolicy";
import { assertProductionLineage, productionCacheIdentity, productionReadId, ProductionReadLifetime } from "../assets/productionGeneratedAssetPolicy";

export type ProductionCachePort = { cacheProductionGenerated(view: ProductionGeneratedAssetLineage, original: Blob, signal: AbortSignal,
  reauthorize: () => Promise<ProductionGeneratedAssetLineage>): Promise<Asset> };
export class ProductionGeneratedAssetClient {
  readonly scope: ProductionGeneratedReadScope;
  constructor(scope: ProductionGeneratedReadScope, private readonly signal: AbortSignal) { this.scope = Object.freeze(ProductionGeneratedReadScopeSchema.parse(scope)); }
  private async body(projectId: string, assetId: string, kind: "lineage" | "content", life: ProductionReadLifetime, view?: ProductionGeneratedAssetLineage) {
    productionReadId(projectId); productionReadId(assetId); life.check();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, complete = false;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const cancel = (response: Response) => { void response.body?.cancel().catch(() => undefined); };
    try {
      const response = await life.wait(localStudioFetch(`/v1/projects/${encodeURIComponent(projectId)}/production-generated-assets/${encodeURIComponent(assetId)}/${kind}`, {
        method: "GET", headers: { "x-canvas-local": "1" }, credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: life.signal,
      }), cancel);
      const size = response.headers.get("content-length"), limit = view ? view.image.asset.byteSize : 512 * 1024;
      if (response.status !== 200 || response.redirected || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "")
        || response.headers.get("content-encoding") || size === null || !/^\d+$/.test(size) || Number(size) <= 0 || Number(size) > limit
        || (kind === "lineage" ? !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")
          : !view || size !== String(view.image.asset.byteSize) || response.headers.get("content-type") !== view.image.asset.mimeType
            || response.headers.get("x-content-sha256") !== view.image.checksumSha256 || response.headers.get("x-canvas-binary-version") !== "production-generated-image-v1"
            || response.headers.get("x-canvas-image-mode") !== view.mode || response.headers.get("x-canvas-artifact-sha256") !== view.artifactFingerprint)) { cancel(response); throw new Error(); }
      reader = response.body?.getReader(); if (!reader) throw new Error();
      let count = 0;
      for (;;) {
        const item = await life.wait(reader.read()); if (item.done) { complete = true; break; }
        if (!item.value.length || chunks.length >= 4096 || (count += item.value.length) > limit) throw new Error();
        chunks.push(Uint8Array.from(item.value));
      }
      life.check(); if (count !== Number(size)) throw new Error();
      return new Blob(chunks, { type: view?.image.asset.mimeType ?? "application/json" });
    } catch { throw new Error("生产原图读取被拒绝、已取消或响应不完整；未生成、重试或更改费用。"); }
    finally {
      if (reader && !complete) void life.wait(reader.cancel()).catch(() => undefined);
      try { reader?.releaseLock(); } catch { /* A non-cooperative pending read still owns its lifetime slot. */ }
      for (const chunk of chunks) chunk.fill(0);
    }
  }
  private async readLineage(projectId: string, assetId: string, life: ProductionReadLifetime) {
    const blob = await this.body(projectId, assetId, "lineage", life);
    const bytes = await life.wait(blob.arrayBuffer());
    try { const view = await life.wait(assertProductionLineage(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), this.scope, projectId, assetId)); life.check(); return view; }
    finally { new Uint8Array(bytes).fill(0); }
  }
  async lineage(projectId: string, assetId: string) {
    const life = new ProductionReadLifetime(this.signal, "production-lineage");
    try { return await this.readLineage(projectId, assetId, life); } finally { life.close(); }
  }
  async cache(projectId: string, assetId: string, repository: ProductionCachePort = assetRepository) {
    const life = new ProductionReadLifetime(this.signal, "production-cache");
    try {
      const view = await this.readLineage(projectId, assetId, life), original = await this.body(projectId, assetId, "content", life, view);
      if (await life.wait(blobSha256(original)) !== view.image.checksumSha256) throw new Error("生产原图 SHA 错配。");
      const asset = await life.wait(repository.cacheProductionGenerated(view, original, life.signal, async () => {
        const latest = await this.readLineage(projectId, assetId, life);
        if (productionCacheIdentity(latest) !== productionCacheIdentity(view)) throw new Error("生产原图完整冻结关系漂移。");
        return latest;
      }));
      life.check(); return asset;
    } finally { life.close(); }
  }
  async verifyCached(projectId: string, assetId: string, repository: Pick<typeof assetRepository, "readProductionGenerated"> = assetRepository) {
    const life = new ProductionReadLifetime(this.signal, "production-cache");
    try {
      const view = await this.readLineage(projectId, assetId, life), asset = await life.wait(repository.readProductionGenerated(view, life.signal));
      const latest = await this.readLineage(projectId, assetId, life);
      if (productionCacheIdentity(latest) !== productionCacheIdentity(view)) throw new Error("生产原图完整冻结关系漂移。");
      life.check(); return { asset, view: latest };
    } finally { life.close(); }
  }
}
