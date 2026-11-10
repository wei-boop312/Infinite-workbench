import { LockedProductionGeneratedReadScopeSchema, type Asset, type LockedProductionGeneratedAssetLineage, type LockedProductionGeneratedReadScope } from "@canvas/contracts";
import { localStudioFetch } from "./runClient";
import { assetRepository } from "../assets/assetRepository";
import { blobSha256 } from "../assets/generatedAssetPolicy";
import { assertLockedProductionLineage, lockedProductionCacheIdentity } from "../assets/lockedProductionGeneratedAssetPolicy";
import { productionReadId, ProductionReadLifetime } from "../assets/productionGeneratedAssetPolicy";
export type LockedProductionCachePort = { cacheLockedProductionGenerated(view: LockedProductionGeneratedAssetLineage, original: Blob, signal: AbortSignal,
  reauthorize: () => Promise<LockedProductionGeneratedAssetLineage>): Promise<Asset> };
export class LockedProductionGeneratedAssetClient {
  readonly scope: LockedProductionGeneratedReadScope;
  constructor(scope: LockedProductionGeneratedReadScope, private readonly signal: AbortSignal) { this.scope = Object.freeze(LockedProductionGeneratedReadScopeSchema.parse(scope)); }
  private async body(project: string, asset: string, kind: "lineage" | "content", life: ProductionReadLifetime, view?: LockedProductionGeneratedAssetLineage) {
    productionReadId(project); productionReadId(asset); life.check();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, complete = false;
    const chunks: Uint8Array<ArrayBuffer>[] = [], cancel = (r: Response) => { void r.body?.cancel().catch(() => undefined); };
    try {
      const r = await life.wait(localStudioFetch(`/v1/projects/${encodeURIComponent(project)}/locked-production-generated-assets/${encodeURIComponent(asset)}/${kind}`, {
        method: "GET", headers: { "x-canvas-local": "1" }, credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: life.signal,
      }), cancel);
      const length = r.headers.get("content-length"), limit = view ? view.image.asset.byteSize : 512 * 1024;
      if (r.status !== 200 || r.redirected || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(r.headers.get("cache-control") ?? "") || r.headers.get("content-encoding")
        || length === null || !/^\d+$/.test(length) || Number(length) <= 0 || Number(length) > limit
        || (kind === "lineage" ? !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(r.headers.get("content-type") ?? "")
          : !view || length !== String(view.image.asset.byteSize) || r.headers.get("content-type") !== view.image.asset.mimeType
            || r.headers.get("x-content-sha256") !== view.image.checksumSha256 || r.headers.get("x-canvas-binary-version") !== "locked-production-generated-image-v2"
            || r.headers.get("x-canvas-image-mode") !== view.mode || r.headers.get("x-canvas-artifact-sha256") !== view.artifactFingerprint
            || r.headers.get("x-canvas-protection-policy-sha256") !== view.protection.policyFingerprint || r.headers.get("x-canvas-pixel-proof-sha256") !== view.protection.pixelProofFingerprint)) { cancel(r); throw new Error(); }
      reader = r.body?.getReader(); if (!reader) throw new Error(); let count = 0;
      for (;;) { const item = await life.wait(reader.read()); if (item.done) { complete = true; break; }
        if (!item.value.length || chunks.length >= 4096 || (count += item.value.length) > limit) throw new Error(); chunks.push(Uint8Array.from(item.value)); }
      life.check(); if (count !== Number(length)) throw new Error();
      return new Blob(chunks, { type: view?.image.asset.mimeType ?? "application/json" });
    } catch { throw new Error("保护原图读取被拒绝、已取消或响应不完整；未生成、重试或更改费用。"); }
    finally { if (reader && !complete) void life.wait(reader.cancel()).catch(() => undefined);
      try { reader?.releaseLock(); } catch { /* Pending native/stream work retains its existing lifetime slot. */ }
      for (const chunk of chunks) chunk.fill(0); }
  }
  private async readLineage(project: string, asset: string, life: ProductionReadLifetime) {
    const blob = await this.body(project, asset, "lineage", life), bytes = await life.wait(blob.arrayBuffer());
    try { const view = await life.wait(assertLockedProductionLineage(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), this.scope, project, asset)); life.check(); return view; }
    finally { new Uint8Array(bytes).fill(0); }
  }
  async lineage(project: string, asset: string) {
    const life = new ProductionReadLifetime(this.signal, "production-lineage");
    try { return await this.readLineage(project, asset, life); } finally { life.close(); }
  }
  async cache(project: string, asset: string, repository: LockedProductionCachePort = assetRepository) {
    const life = new ProductionReadLifetime(this.signal, "production-cache");
    try { const view = await this.readLineage(project, asset, life), original = await this.body(project, asset, "content", life, view);
      if (await life.wait(blobSha256(original)) !== view.image.checksumSha256) throw new Error("保护原图 SHA 错配。");
      const result = await life.wait(repository.cacheLockedProductionGenerated(view, original, life.signal, async () => {
        const latest = await this.readLineage(project, asset, life);
        if (lockedProductionCacheIdentity(latest) !== lockedProductionCacheIdentity(view)) throw new Error("保护原图完整冻结关系漂移。"); return latest;
      })); life.check(); return result;
    } finally { life.close(); }
  }
  async verifyCached(project: string, asset: string, repository: Pick<typeof assetRepository, "readLockedProductionGenerated"> = assetRepository) {
    const life = new ProductionReadLifetime(this.signal, "production-cache");
    try { const view = await this.readLineage(project, asset, life), result = await life.wait(repository.readLockedProductionGenerated(view, life.signal));
      const latest = await this.readLineage(project, asset, life);
      if (lockedProductionCacheIdentity(latest) !== lockedProductionCacheIdentity(view)) throw new Error("保护原图完整冻结关系漂移.");
      life.check(); return { asset: result, view: latest };
    } finally { life.close(); }
  }
  async result(project: string, asset: string, repository: Pick<typeof assetRepository, "readLockedProductionResult"> = assetRepository) {
    const life = new ProductionReadLifetime(this.signal, "production-cache");
    try { const view = await this.readLineage(project, asset, life), snapshot = await life.wait(repository.readLockedProductionResult(view, life.signal));
      const latest = await this.readLineage(project, asset, life);
      if (lockedProductionCacheIdentity(latest) !== lockedProductionCacheIdentity(view)) throw new Error("保护回流完整冻结关系漂移。");
      life.check(); return { ...snapshot, view: latest };
    } finally { life.close(); }
  }
}
