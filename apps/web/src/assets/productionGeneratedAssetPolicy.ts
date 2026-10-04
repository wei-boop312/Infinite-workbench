import { ProductionGeneratedAssetLineageSchema, ProductionGeneratedReadScopeSchema, type ProductionGeneratedAssetLineage, type ProductionGeneratedReadScope } from "@canvas/contracts";
import { blobSha256 } from "./generatedAssetPolicy";
export type ProductionCacheRecord = { version: 1; assetId: string; tenantId: string; projectId: string; mode: ProductionGeneratedAssetLineage["mode"]; identity: string; lineage: ProductionGeneratedAssetLineage };

export function productionMarkerMatches(marker: ProductionCacheRecord | undefined, view: ProductionGeneratedAssetLineage): boolean {
  try {
    return !!marker && Object.keys(marker).sort().join() === ["version", "assetId", "tenantId", "projectId", "mode", "identity", "lineage"].sort().join()
      && marker.version === 1 && marker.assetId === view.image.asset.id && marker.tenantId === view.tenantId && marker.projectId === view.projectId && marker.mode === view.mode
      && new TextEncoder().encode(JSON.stringify(marker)).length <= 512 * 1024 && marker.identity === productionCacheIdentity(view)
      && productionCacheIdentity(marker.lineage) === marker.identity;
  } catch { return false; }
}

// Frozen identity excludes only the current financial projection. Settlement
// cannot turn the same immutable artifact into a new image or send permission.
export function productionCacheIdentity(value: ProductionGeneratedAssetLineage): string {
  const { billing: _billing, jobStatus: _status, ...frozen } = ProductionGeneratedAssetLineageSchema.parse(value);
  return JSON.stringify(frozen);
}
export async function assertProductionLineage(value: unknown, scope: ProductionGeneratedReadScope, projectId: string, assetId: string) {
  ProductionGeneratedReadScopeSchema.parse(scope);
  const view = ProductionGeneratedAssetLineageSchema.parse(value);
  if (view.mode !== scope.mode || view.tenantId !== scope.tenantId || view.projectId !== projectId || view.image.asset.id !== assetId
    || view.image.asset.contentFingerprint !== `sha256:${view.image.checksumSha256}`) throw new Error("生产原图范围或原指纹错配。");
  if (await blobSha256(new Blob([JSON.stringify(view.constraint)])) !== view.requestDraft.constraintChecksumSha256) throw new Error("生产原完整约束 SHA 错配。");
  return view;
}
export function productionReadId(id: string) {
  if (typeof id !== "string" || !id.length || id.length > 160 || id.trim() !== id || /[\x00-\x1f\x7f]/.test(id)) throw new Error("生产原图编号无效。");
}

const slots = new Map<string, number>();
export class ProductionReadLifetime {
  readonly signal: AbortSignal;
  private timeout = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  private previous = performance.now();
  private deadline = this.previous + 30_000;
  private pending = 0;
  private closed = false;
  private released = false;
  constructor(signal: AbortSignal, private readonly pool: string) {
    signal.throwIfAborted();
    if ((slots.get(pool) ?? 0) >= 2) throw new Error("生产原图读取正在进行，请稍后再操作。");
    slots.set(pool, (slots.get(pool) ?? 0) + 1);
    this.signal = AbortSignal.any([signal, this.timeout.signal]);
    this.timer = setTimeout(() => this.timeout.abort(), 30_000);
    try { this.check(); } catch (e) { this.close(); throw e; }
  }
  check() {
    this.signal.throwIfAborted();
    const now = performance.now();
    if (!Number.isFinite(now) || !Number.isFinite(this.previous) || now < this.previous || now >= this.deadline || this.closed) throw new Error("生产原图读取已取消或超时。");
    this.previous = now;
  }
  wait<T>(promise: Promise<T>, discard?: (value: T) => void): Promise<T> {
    this.pending++;
    return new Promise((resolve, reject) => {
      let ended = false;
      const stop = () => { ended = true; reject(new Error("生产原图读取已取消或超时。")); };
      this.signal.addEventListener("abort", stop, { once: true });
      if (this.signal.aborted) stop();
      promise.then(value => {
        try { this.check(); if (ended) throw new Error(); resolve(value); }
        catch (e) { discard?.(value); reject(e); }
      }, reject).finally(() => {
        this.signal.removeEventListener("abort", stop); this.pending--; this.release();
      });
    });
  }
  private release() {
    if (this.closed && !this.pending && !this.released) { this.released = true; slots.set(this.pool, (slots.get(this.pool) ?? 1) - 1); }
  }
  close() { this.closed = true; clearTimeout(this.timer); this.timeout.abort(); this.release(); }
}
