import type { Asset, VerifiedImage, ProductionGeneratedAssetLineage, LockedProductionGeneratedAssetLineage } from "@canvas/contracts";
import type { LockedProductionCacheRecord } from "./lockedProductionGeneratedAssetPolicy";
import { assertGeneratedReceipt, blobSha256 } from "./generatedAssetPolicy";
import type { ProductionCacheRecord } from "./productionGeneratedAssetPolicy";

const DATABASE_NAME = "ai-commerce-canvas-assets";
const DATABASE_VERSION = 5;
const ASSET_STORE = "assets";
const BLOB_STORE = "blobs";
const GENERATED_CACHE_STORE = "generatedCaches";
const PRODUCTION_CACHE_STORE = "productionGeneratedCaches";
const LOCKED_CACHE_STORE = "lockedProductionGeneratedCaches";
let generatedReads = 0;
type GeneratedCacheRecord = { assetId: string; projectId: string; tenantId: string; metadata: string; checksum: string };
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const ACCEPTED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

type AssetKind = "image" | "video";
export type BlobRole = "original" | "proxy";
type BlobRecord = { key: string; assetId: string; role: BlobRole; blob: Blob };

export type AssetFileDescriptor = Pick<File, "name" | "type" | "size">;
export type AssetImportResult = { assets: Asset[]; errors: string[] };
export type AssetUsage = { count: number; originalBytes: number; proxyBytes: number; totalBytes: number };
export type RestoredAsset = { asset: Asset; original: Blob; proxy?: Blob };
export interface AssetRepositoryPort {
  list(projectId: string): Promise<Asset[]>;
  getBlob(assetId: string, role: BlobRole): Promise<Blob | null>;
  importFiles(projectId: string, files: File[]): Promise<AssetImportResult>;
  saveMask(projectId: string, sourceAssetId: string, blob: Blob, width: number, height: number): Promise<Asset>;
  restore(projectId: string, records: RestoredAsset[]): Promise<void>;
  restoreOriginal(projectId: string, assetId: string, blob: Blob): Promise<Asset>;
  cacheGenerated(receipt: VerifiedImage, original: Blob, signal: AbortSignal): Promise<Asset>;
  readGenerated(receipt: VerifiedImage, signal: AbortSignal): Promise<Asset>;
  remove(projectId: string, assetId: string): Promise<boolean>;
  usage(projectId: string): Promise<AssetUsage>;
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function createFileFingerprint(file: File): Promise<string | undefined> {
  if (file.size > 32 * 1024 * 1024) return undefined;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function validateAssetFile(file: AssetFileDescriptor): AssetKind {
  const kind = ACCEPTED_IMAGE_TYPES.has(file.type)
    ? "image"
    : ACCEPTED_VIDEO_TYPES.has(file.type)
      ? "video"
      : null;
  if (!kind) throw new Error(`不支持的文件类型：${file.type || file.name}`);
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (file.size <= 0) throw new Error(`${file.name} 是空文件`);
  if (file.size > limit) throw new Error(`${file.name} 超过 ${kind === "image" ? "30 MB" : "250 MB"} 限制`);
  return kind;
}

export function formatAssetBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("浏览器资产存储请求失败"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("浏览器资产存储事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("浏览器资产存储事务已中止"));
  });
}

function openDatabase(signal?: AbortSignal): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) return Promise.reject(new Error("当前浏览器不支持本地资产库"));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    const abort = () => reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    request.onupgradeneeded = () => {
      if (signal?.aborted) { request.transaction!.abort(); return; }
      const database = request.result;
      let assets: IDBObjectStore;
      if (!database.objectStoreNames.contains(ASSET_STORE)) {
        assets = database.createObjectStore(ASSET_STORE, { keyPath: "id" });
        assets.createIndex("projectId", "projectId", { unique: false });
      } else {
        assets = request.transaction!.objectStore(ASSET_STORE);
      }
      if (!assets.indexNames.contains("projectFingerprint")) assets.createIndex("projectFingerprint", ["projectId", "contentFingerprint"], { unique: false });
      if (!database.objectStoreNames.contains(BLOB_STORE)) {
        const blobs = database.createObjectStore(BLOB_STORE, { keyPath: "key" });
        blobs.createIndex("assetId", "assetId", { unique: false });
      }
      if (!database.objectStoreNames.contains(GENERATED_CACHE_STORE)) database.createObjectStore(GENERATED_CACHE_STORE, { keyPath: "assetId" });
      if (!database.objectStoreNames.contains(PRODUCTION_CACHE_STORE)) database.createObjectStore(PRODUCTION_CACHE_STORE, { keyPath: "assetId" });
      if (!database.objectStoreNames.contains(LOCKED_CACHE_STORE)) database.createObjectStore(LOCKED_CACHE_STORE, { keyPath: "assetId" });
    };
    request.onsuccess = () => { signal?.removeEventListener("abort", abort); if (signal?.aborted) request.result.close(); else resolve(request.result); };
    request.onerror = () => { signal?.removeEventListener("abort", abort); reject(request.error ?? new Error("无法打开浏览器资产库")); };
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("无法生成资产缩略图")),
    type,
    quality,
  ));
}

async function inspectImage(file: Blob): Promise<{ width: number; height: number; proxy: Blob }> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建图片缩略图");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const proxy = await canvasToBlob(canvas, "image/webp", 0.82);
    return { width: bitmap.width, height: bitmap.height, proxy };
  } finally {
    bitmap.close();
  }
}

async function inspectVideo(file: Blob, fileName: string): Promise<{ width: number; height: number; durationMs: number; proxy?: Blob }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(`读取视频元数据超时：${fileName}`)), 8_000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error(`无法读取视频元数据：${fileName}`));
      };
    });
    let proxy: Blob | undefined;
    try {
      const seekTime = Number.isFinite(video.duration) ? Math.min(0.1, Math.max(0, video.duration / 2)) : 0;
      if (seekTime > 0) {
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 1_500);
          video.onseeked = () => {
            window.clearTimeout(timer);
            resolve();
          };
          video.currentTime = seekTime;
        });
      }
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (context) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        proxy = await canvasToBlob(canvas, "image/webp", 0.78);
      }
    } catch {
      proxy = undefined;
    }
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      durationMs: Math.max(0, Math.round(video.duration * 1000)),
      proxy,
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

export class IndexedDbAssetRepository implements AssetRepositoryPort {
  async list(projectId: string): Promise<Asset[]> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(ASSET_STORE, "readonly");
      const assets = await requestResult(transaction.objectStore(ASSET_STORE).index("projectId").getAll(projectId) as IDBRequest<Asset[]>);
      return assets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } finally {
      database.close();
    }
  }

  async getBlob(assetId: string, role: BlobRole): Promise<Blob | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(BLOB_STORE, "readonly");
      const record = await requestResult(transaction.objectStore(BLOB_STORE).get(`${assetId}:${role}`) as IDBRequest<BlobRecord | undefined>);
      return record?.blob ?? null;
    } finally {
      database.close();
    }
  }

  async usage(projectId: string): Promise<AssetUsage> {
    const assets = await this.list(projectId);
    let proxyBytes = 0;
    for (const asset of assets) {
      if (!asset.proxyStorageKey && asset.purpose !== "generated") continue;
      proxyBytes += (await this.getBlob(asset.id, "proxy"))?.size ?? 0;
    }
    const originalBytes = assets.reduce((total, asset) => total + asset.byteSize, 0);
    return { count: assets.length, originalBytes, proxyBytes, totalBytes: originalBytes + proxyBytes };
  }

  async readGenerated(input: VerifiedImage, abortSignal: AbortSignal): Promise<Asset> {
    if (generatedReads >= 2) throw new Error("生成原图校验正在进行，请稍后再操作。");
    generatedReads++;
    try {
      const signal = AbortSignal.any([abortSignal, AbortSignal.timeout(30_000)]);
      const { VerifiedImageSchema } = await import("@canvas/contracts");
      const receipt = VerifiedImageSchema.parse(structuredClone(input)), expected = receipt.asset;
      assertGeneratedReceipt(receipt, expected.projectId, expected.id); signal.throwIfAborted();
      const database = await openDatabase(signal);
      let asset: Asset | undefined, marker: GeneratedCacheRecord | undefined, original: BlobRecord | undefined;
      try {
        const transaction = database.transaction([ASSET_STORE, BLOB_STORE, GENERATED_CACHE_STORE], "readonly"), done = transactionComplete(transaction);
        void done.catch(() => undefined);
        const abort = () => { try { transaction.abort(); } catch { /* The read snapshot has completed. */ } };
        signal.addEventListener("abort", abort, { once: true });
        try {
          [asset, marker, original] = await Promise.all([
            requestResult(transaction.objectStore(ASSET_STORE).get(expected.id) as IDBRequest<Asset | undefined>),
            requestResult(transaction.objectStore(GENERATED_CACHE_STORE).get(expected.id) as IDBRequest<GeneratedCacheRecord | undefined>),
            requestResult(transaction.objectStore(BLOB_STORE).get(`${expected.id}:original`) as IDBRequest<BlobRecord | undefined>),
          ]);
          await done; signal.throwIfAborted();
        } catch (failure) { abort(); await done.catch(() => undefined); throw failure; }
        finally { signal.removeEventListener("abort", abort); }
      } finally { database.close(); }
      const expectedMarker: GeneratedCacheRecord = { assetId: expected.id, projectId: expected.projectId, tenantId: receipt.tenantId,
        metadata: JSON.stringify(expected), checksum: receipt.checksumSha256 };
      if (!asset || !marker || !original) throw new Error("请先完整缓存当前任务的生成原图；普通资产或导入副本不能替代缓存证据。");
      if (JSON.stringify(asset) !== JSON.stringify(expected) || JSON.stringify(marker) !== JSON.stringify(expectedMarker)
        || original.key !== `${expected.id}:original` || original.assetId !== expected.id || original.role !== "original"
        || !(original.blob instanceof Blob) || original.blob.size !== expected.byteSize || original.blob.type !== expected.mimeType) throw new Error("生成原图缓存编号、项目、元数据或标记错配。");
      if (await blobSha256(original.blob) !== receipt.checksumSha256) throw new Error("生成原图缓存内容 SHA-256 不匹配。");
      signal.throwIfAborted();
      const bitmap = await createImageBitmap(original.blob);
      try { if (bitmap.width !== expected.width || bitmap.height !== expected.height) throw new Error("生成原图缓存实际尺寸错配。"); }
      finally { bitmap.close(); }
      signal.throwIfAborted();
      return structuredClone(asset);
    } finally { generatedReads--; }
  }

  async saveMask(projectId: string, sourceAssetId: string, blob: Blob, width: number, height: number): Promise<Asset> {
    if (blob.type !== "image/png" || blob.size <= 0) throw new Error("蒙版必须是有效的 PNG 文件");
    const source = (await this.list(projectId)).find((asset) => asset.id === sourceAssetId);
    if (!source || source.kind !== "image" || source.purpose === "mask") throw new Error("蒙版源图片不存在或不可用");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    const contentFingerprint = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const id = createId("mask");
    const asset: Asset = {
      id,
      projectId,
      kind: "image",
      purpose: "mask",
      sourceAssetId,
      originalName: `mask-${new Date().toISOString().replaceAll(":", "-")}.png`,
      contentFingerprint,
      storageKey: `indexeddb://assets/${id}/original`,
      mimeType: "image/png",
      byteSize: blob.size,
      width,
      height,
      createdAt: new Date().toISOString(),
    };
    const database = await openDatabase();
    try {
      const transaction = database.transaction([ASSET_STORE, BLOB_STORE], "readwrite");
      transaction.objectStore(ASSET_STORE).put(asset);
      transaction.objectStore(BLOB_STORE).put({ key: `${id}:original`, assetId: id, role: "original", blob } satisfies BlobRecord);
      await transactionComplete(transaction);
      return asset;
    } finally {
      database.close();
    }
  }

  // Independent production marker, never synthesized by ordinary restore or
  // legacy cacheGenerated. Original metadata remains exactly the server receipt.
  async cacheProductionGenerated(input: ProductionGeneratedAssetLineage, original: Blob, abortSignal: AbortSignal,
    reauthorize: () => Promise<ProductionGeneratedAssetLineage>): Promise<Asset> {
    const frozen = structuredClone(input); abortSignal.throwIfAborted();
    const { assertProductionLineage, productionCacheIdentity, ProductionReadLifetime, productionMarkerMatches } = await import("./productionGeneratedAssetPolicy");
    const life = new ProductionReadLifetime(abortSignal, "production-local-validation");
    try {
      const view = await life.wait(assertProductionLineage(frozen, { generatedReadUiEnabled: true, tenantId: frozen.tenantId, mode: frozen.mode }, frozen.projectId, frozen.image.asset.id));
      const asset = view.image.asset;
      if (original.size !== asset.byteSize || original.type !== asset.mimeType || await life.wait(blobSha256(original)) !== view.image.checksumSha256) throw new Error("生产原图缓存字节错配。");
      const { width, height, proxy } = await life.wait(inspectImage(original));
      if (width !== asset.width || height !== asset.height) throw new Error("生产原图缓存实际尺寸错配。");
      // Fresh permission/full-chain server read after native decoding, before IDB.
      const latest = await life.wait(reauthorize());
      await life.wait(assertProductionLineage(latest, { generatedReadUiEnabled: true, tenantId: view.tenantId, mode: view.mode }, view.projectId, asset.id));
      if (productionCacheIdentity(latest) !== productionCacheIdentity(view)) throw new Error("生产原图完整冻结关系漂移。");
      const marker: ProductionCacheRecord = { version: 1, assetId: asset.id, tenantId: view.tenantId, projectId: view.projectId, mode: view.mode, identity: productionCacheIdentity(view), lineage: view };
      if (new TextEncoder().encode(JSON.stringify(marker)).length > 512 * 1024) throw new Error("生产原图缓存谱系过大。");
      const database = await life.wait(openDatabase(life.signal), db => db.close());
      try {
        life.check();
        const transaction = database.transaction([ASSET_STORE, BLOB_STORE, GENERATED_CACHE_STORE, PRODUCTION_CACHE_STORE], "readwrite"), done = transactionComplete(transaction);
        void done.catch(() => undefined);
        const abort = () => { try { transaction.abort(); } catch { /* A committed authorized local copy is retained. */ } };
        life.signal.addEventListener("abort", abort, { once: true });
        try {
          const assets = transaction.objectStore(ASSET_STORE), markers = transaction.objectStore(PRODUCTION_CACHE_STORE), blobs = transaction.objectStore(BLOB_STORE);
          const [existing, previous, local, oldOriginal, oldProxy] = await life.wait(Promise.all([
            requestResult(assets.get(asset.id) as IDBRequest<Asset | undefined>), requestResult(markers.get(asset.id) as IDBRequest<ProductionCacheRecord | undefined>),
            requestResult(transaction.objectStore(GENERATED_CACHE_STORE).get(asset.id)), requestResult(blobs.get(`${asset.id}:original`)), requestResult(blobs.get(`${asset.id}:proxy`)),
          ]));
          life.check();
          if (local || (!!existing !== !!previous) || (!existing && (oldOriginal || oldProxy))
            || (existing && (JSON.stringify(existing) !== JSON.stringify(asset) || !productionMarkerMatches(previous, view)))) throw new Error("生产原图缓存编号、范围或独立标记冲突。");
          if (!existing) assets.add(asset);
          blobs.put({ key: `${asset.id}:original`, assetId: asset.id, role: "original", blob: original } satisfies BlobRecord);
          blobs.put({ key: `${asset.id}:proxy`, assetId: asset.id, role: "proxy", blob: proxy } satisfies BlobRecord);
          if (!previous) markers.add(marker);
          life.check(); await life.wait(done); return structuredClone(asset);
        } catch (e) { abort(); await done.catch(() => undefined); throw e; }
        finally { life.signal.removeEventListener("abort", abort); }
      } finally { database.close(); }
    } finally { life.close(); }
  }

  // V2 protected copies are isolated from both none-production and local marks.
  // Calling this repository directly is not a server authorization proof.
  async cacheLockedProductionGenerated(input: LockedProductionGeneratedAssetLineage, original: Blob, abortSignal: AbortSignal,
    reauthorize: () => Promise<LockedProductionGeneratedAssetLineage>): Promise<Asset> {
    const frozen = structuredClone(input); abortSignal.throwIfAborted();
    const { assertLockedProductionLineage, lockedProductionCacheIdentity, lockedProductionMarkerMatches } = await import("./lockedProductionGeneratedAssetPolicy");
    const { ProductionReadLifetime } = await import("./productionGeneratedAssetPolicy"), life = new ProductionReadLifetime(abortSignal, "production-local-validation");
    try {
      const scope = { lockedGeneratedReadUiEnabled: true as const, tenantId: frozen.tenantId, mode: frozen.mode };
      const view = await life.wait(assertLockedProductionLineage(frozen, scope, frozen.projectId, frozen.image.asset.id)), asset = view.image.asset;
      if (original.size !== asset.byteSize || original.type !== asset.mimeType || await life.wait(blobSha256(original)) !== view.image.checksumSha256) throw new Error("保护原图缓存字节错配。");
      const inspected = await life.wait(inspectImage(original));
      if (inspected.width !== asset.width || inspected.height !== asset.height || inspected.proxy.type !== "image/webp" || !inspected.proxy.size || inspected.proxy.size > 20 * 1024 * 1024) throw new Error("保护原图缓存实际尺寸或代理错配。");
      const scale = Math.min(1, 480 / Math.max(asset.width, asset.height)), proxy = { checksumSha256: await life.wait(blobSha256(inspected.proxy)),
        byteSize: inspected.proxy.size, mimeType: "image/webp" as const, width: Math.max(1, Math.round(asset.width * scale)), height: Math.max(1, Math.round(asset.height * scale)) };
      const marker: LockedProductionCacheRecord = { version: 2, namespace: "locked-production-generated-image-v2", assetId: asset.id, tenantId: view.tenantId,
        projectId: view.projectId, mode: view.mode, identity: lockedProductionCacheIdentity(view), lineage: view, proxy };
      if (!lockedProductionMarkerMatches(marker, view)) throw new Error("保护原图完整标记或谱系容量无效。");
      const latest = structuredClone(await life.wait(reauthorize()));
      await life.wait(assertLockedProductionLineage(latest, scope, view.projectId, asset.id));
      if (lockedProductionCacheIdentity(latest) !== marker.identity) throw new Error("保护原图完整冻结关系漂移。");
      const database = await life.wait(openDatabase(life.signal), db => db.close());
      try {
        life.check(); const tx = database.transaction([ASSET_STORE, BLOB_STORE, GENERATED_CACHE_STORE, PRODUCTION_CACHE_STORE, LOCKED_CACHE_STORE], "readwrite"), done = transactionComplete(tx);
        void done.catch(() => undefined); const abort = () => { try { tx.abort(); } catch { /* Keep an already committed lawful offline copy. */ } };
        life.signal.addEventListener("abort", abort, { once: true });
        try {
          const assets = tx.objectStore(ASSET_STORE), blobs = tx.objectStore(BLOB_STORE), markers = tx.objectStore(LOCKED_CACHE_STORE);
          const [existing, previous, local, none, oldOriginal, oldProxy] = await life.wait(Promise.all([
            requestResult(assets.get(asset.id) as IDBRequest<Asset | undefined>), requestResult(markers.get(asset.id) as IDBRequest<LockedProductionCacheRecord | undefined>),
            requestResult(tx.objectStore(GENERATED_CACHE_STORE).get(asset.id)), requestResult(tx.objectStore(PRODUCTION_CACHE_STORE).get(asset.id)),
            requestResult(blobs.get(`${asset.id}:original`)), requestResult(blobs.get(`${asset.id}:proxy`)),
          ])); life.check();
          if (local || none || (!!existing !== !!previous) || (!existing && (oldOriginal || oldProxy))
            || (existing && (JSON.stringify(existing) !== JSON.stringify(asset) || !lockedProductionMarkerMatches(previous, view)
              || JSON.stringify(previous!.proxy) !== JSON.stringify(proxy)))) throw new Error("保护原图缓存编号、范围或独立标记冲突。");
          if (!existing) assets.add(asset);
          blobs.put({ key: `${asset.id}:original`, assetId: asset.id, role: "original", blob: original } satisfies BlobRecord);
          blobs.put({ key: `${asset.id}:proxy`, assetId: asset.id, role: "proxy", blob: inspected.proxy } satisfies BlobRecord);
          if (!previous) markers.add(marker);
          life.check(); await life.wait(done); return structuredClone(asset);
        } catch (e) { abort(); await done.catch(() => undefined); throw e; }
        finally { life.signal.removeEventListener("abort", abort); }
      } finally { database.close(); }
    } finally { life.close(); }
  }

  async readLockedProductionGenerated(input: LockedProductionGeneratedAssetLineage, abortSignal: AbortSignal): Promise<Asset> {
    const frozen = structuredClone(input); abortSignal.throwIfAborted();
    const { assertLockedProductionLineage, lockedProductionMarkerMatches } = await import("./lockedProductionGeneratedAssetPolicy");
    const { ProductionReadLifetime } = await import("./productionGeneratedAssetPolicy"), life = new ProductionReadLifetime(abortSignal, "production-local-validation");
    try {
      const view = await life.wait(assertLockedProductionLineage(frozen, { lockedGeneratedReadUiEnabled: true, tenantId: frozen.tenantId, mode: frozen.mode }, frozen.projectId, frozen.image.asset.id)), expected = view.image.asset;
      const db = await life.wait(openDatabase(life.signal), value => value.close());
      let asset: Asset | undefined, marker: LockedProductionCacheRecord | undefined, original: BlobRecord | undefined, proxy: BlobRecord | undefined, local: unknown, none: unknown;
      try {
        life.check(); const tx = db.transaction([ASSET_STORE, BLOB_STORE, GENERATED_CACHE_STORE, PRODUCTION_CACHE_STORE, LOCKED_CACHE_STORE], "readonly"), done = transactionComplete(tx);
        void done.catch(() => undefined); const abort = () => { try { tx.abort(); } catch { /* Read snapshot completed. */ } };
        life.signal.addEventListener("abort", abort, { once: true });
        try {
          [asset, marker, original, proxy, local, none] = await life.wait(Promise.all([
            requestResult(tx.objectStore(ASSET_STORE).get(expected.id) as IDBRequest<Asset | undefined>),
            requestResult(tx.objectStore(LOCKED_CACHE_STORE).get(expected.id) as IDBRequest<LockedProductionCacheRecord | undefined>),
            requestResult(tx.objectStore(BLOB_STORE).get(`${expected.id}:original`) as IDBRequest<BlobRecord | undefined>),
            requestResult(tx.objectStore(BLOB_STORE).get(`${expected.id}:proxy`) as IDBRequest<BlobRecord | undefined>),
            requestResult(tx.objectStore(GENERATED_CACHE_STORE).get(expected.id)), requestResult(tx.objectStore(PRODUCTION_CACHE_STORE).get(expected.id)),
          ])); await life.wait(done);
        } catch (e) { abort(); await done.catch(() => undefined); throw e; }
        finally { life.signal.removeEventListener("abort", abort); }
      } finally { db.close(); }
      if (local || none || !asset || JSON.stringify(asset) !== JSON.stringify(expected) || !lockedProductionMarkerMatches(marker, view)
        || !original || original.key !== `${expected.id}:original` || original.assetId !== expected.id || original.role !== "original"
        || !(original.blob instanceof Blob) || original.blob.size !== expected.byteSize || original.blob.type !== expected.mimeType
        || !proxy || proxy.key !== `${expected.id}:proxy` || proxy.assetId !== expected.id || proxy.role !== "proxy" || !(proxy.blob instanceof Blob)
        || proxy.blob.size !== marker!.proxy.byteSize || proxy.blob.type !== marker!.proxy.mimeType) throw new Error("保护原图缓存不完整或独立标记错配；普通恢复/旧标记/副本不能替代。");
      if (await life.wait(blobSha256(original.blob)) !== view.image.checksumSha256 || await life.wait(blobSha256(proxy.blob)) !== marker!.proxy.checksumSha256) throw new Error("保护原图或本地代理实际 SHA 错配。");
      for (const [blob, width, height] of [[original.blob, expected.width, expected.height], [proxy.blob, marker!.proxy.width, marker!.proxy.height]] as const) {
        const bitmap = await life.wait(createImageBitmap(blob), late => late.close());
        try { if (bitmap.width !== width || bitmap.height !== height) throw new Error("保护原图缓存实际尺寸错配。"); } finally { bitmap.close(); }
      }
      life.check(); return structuredClone(asset);
    } finally { life.close(); }
  }

  async readProductionGenerated(input: ProductionGeneratedAssetLineage, abortSignal: AbortSignal): Promise<Asset> {
    return (await this.readProductionSnapshot(input, abortSignal, false)).asset;
  }

  async readProductionResult(input: ProductionGeneratedAssetLineage, abortSignal: AbortSignal): Promise<{ asset: Asset; inputAssets: Asset[] }> {
    return this.readProductionSnapshot(input, abortSignal, true);
  }

  private async readProductionSnapshot(input: ProductionGeneratedAssetLineage, abortSignal: AbortSignal, includeInputs: boolean): Promise<{ asset: Asset; inputAssets: Asset[] }> {
    const frozen = structuredClone(input); abortSignal.throwIfAborted();
    const { assertProductionLineage, ProductionReadLifetime, productionMarkerMatches } = await import("./productionGeneratedAssetPolicy");
    const life = new ProductionReadLifetime(abortSignal, "production-local-validation");
    try {
      const view = await life.wait(assertProductionLineage(frozen, { generatedReadUiEnabled: true, tenantId: frozen.tenantId, mode: frozen.mode }, frozen.projectId, frozen.image.asset.id));
      const d = view.requestDraft, refs = includeInputs ? [...d.inputs, ...(d.operation === "edit" && d.mask ? [d.mask] : [])] : [];
      if (refs.reduce((total, ref) => total + ref.byteSize, 0) > 64 * 1024 * 1024) throw new Error("生产回流原输入声明超过 64MiB，未读取本机原文件。");
      const expected = view.image.asset, database = await life.wait(openDatabase(life.signal), db => db.close());
      let asset: Asset | undefined, marker: ProductionCacheRecord | undefined, original: BlobRecord | undefined, proxy: BlobRecord | undefined, local: unknown;
      let inputRecords: Array<[Asset | undefined, BlobRecord | undefined]> = [];
      try {
        life.check();
        const transaction = database.transaction([ASSET_STORE, BLOB_STORE, GENERATED_CACHE_STORE, PRODUCTION_CACHE_STORE], "readonly"), done = transactionComplete(transaction);
        void done.catch(() => undefined);
        const abort = () => { try { transaction.abort(); } catch { /* Read snapshot already completed. */ } };
        life.signal.addEventListener("abort", abort, { once: true });
        try {
          const reads = Promise.all([
            requestResult(transaction.objectStore(ASSET_STORE).get(expected.id) as IDBRequest<Asset | undefined>),
            requestResult(transaction.objectStore(PRODUCTION_CACHE_STORE).get(expected.id) as IDBRequest<ProductionCacheRecord | undefined>),
            requestResult(transaction.objectStore(BLOB_STORE).get(`${expected.id}:original`) as IDBRequest<BlobRecord | undefined>),
            requestResult(transaction.objectStore(BLOB_STORE).get(`${expected.id}:proxy`) as IDBRequest<BlobRecord | undefined>),
            requestResult(transaction.objectStore(GENERATED_CACHE_STORE).get(expected.id)),
          ]);
          const inputReads = Promise.all(refs.map(ref => Promise.all([
            requestResult(transaction.objectStore(ASSET_STORE).get(ref.assetId) as IDBRequest<Asset | undefined>),
            requestResult(transaction.objectStore(BLOB_STORE).get(`${ref.assetId}:original`) as IDBRequest<BlobRecord | undefined>),
          ])));
          [[asset, marker, original, proxy, local], inputRecords] = await life.wait(Promise.all([reads, inputReads]));
          await life.wait(done);
        } catch (e) { abort(); await done.catch(() => undefined); throw e; }
        finally { life.signal.removeEventListener("abort", abort); }
      } finally { database.close(); }
      if (local || !asset || !productionMarkerMatches(marker, view) || JSON.stringify(asset) !== JSON.stringify(expected)
        || !original || original.key !== `${expected.id}:original` || original.assetId !== expected.id || original.role !== "original"
        || !(original.blob instanceof Blob) || original.blob.size !== expected.byteSize || original.blob.type !== expected.mimeType
        || !proxy || proxy.key !== `${expected.id}:proxy` || proxy.assetId !== expected.id || proxy.role !== "proxy" || !(proxy.blob instanceof Blob) || !proxy.blob.size) throw new Error("生产原图缓存不完整或独立标记错配；普通恢复和副本不能替代。");
      if (await life.wait(blobSha256(original.blob)) !== view.image.checksumSha256) throw new Error("生产原图缓存实际 SHA 错配。");
      const bitmap = await life.wait(createImageBitmap(original.blob), late => late.close());
      try { if (bitmap.width !== expected.width || bitmap.height !== expected.height) throw new Error("生产原图缓存实际尺寸错配。"); }
      finally { bitmap.close(); }
      const { AssetSchema } = await life.wait(import("@canvas/contracts"));
      const inputAssets: Asset[] = [];
      for (const [index, ref] of refs.entries()) {
        const [metadata, record] = inputRecords[index], a = AssetSchema.parse(metadata);
        if (a.id !== ref.assetId || a.projectId !== view.projectId || a.kind !== "image" || a.contentFingerprint !== `sha256:${ref.checksumSha256}`
          || a.mimeType !== ref.mimeType || a.width !== ref.width || a.height !== ref.height || a.byteSize !== ref.byteSize
          || ref.width > 8192 || ref.height > 8192 || ref.width * ref.height > 16_000_000
          || (index === d.inputs.length ? a.purpose !== "mask" || a.sourceAssetId !== d.inputs[0]?.assetId : a.purpose === "mask")
          || !record || record.key !== `${ref.assetId}:original` || record.assetId !== ref.assetId || record.role !== "original"
          || !(record.blob instanceof Blob) || record.blob.type !== ref.mimeType || record.blob.size !== ref.byteSize) throw new Error("本机原输入/蒙版元数据、順序或完整原文件错配。");
        if (await life.wait(blobSha256(record.blob)) !== ref.checksumSha256) throw new Error("本机原输入/蒙版 SHA 错配。");
        const native = await life.wait(createImageBitmap(record.blob), late => late.close());
        try { if (native.width !== ref.width || native.height !== ref.height) throw new Error("本机原输入/蒙版实际尺寸错配。"); }
        finally { native.close(); }
        inputAssets.push(a);
      }
      life.check(); return { asset: structuredClone(asset), inputAssets };
    } finally { life.close(); }
  }

  async cacheGenerated(input: VerifiedImage, original: Blob, signal: AbortSignal): Promise<Asset> {
    const { VerifiedImageSchema } = await import("@canvas/contracts");
    const receipt = VerifiedImageSchema.parse(structuredClone(input)), asset = receipt.asset;
    assertGeneratedReceipt(receipt, asset.projectId, asset.id); signal.throwIfAborted();
    if (original.size !== asset.byteSize || original.type !== asset.mimeType || await blobSha256(original) !== receipt.checksumSha256) throw new Error("生成图片缓存原文件错配。");
    signal.throwIfAborted();
    const { width, height, proxy } = await inspectImage(original);
    signal.throwIfAborted();
    if (width !== asset.width || height !== asset.height || width * height > 16_000_000 || Math.max(width, height) > 8192) throw new Error("生成图片实际尺寸与权威收据不匹配。");
    const marker: GeneratedCacheRecord = { assetId: asset.id, projectId: asset.projectId, tenantId: receipt.tenantId, metadata: JSON.stringify(asset), checksum: receipt.checksumSha256 };
    const database = await openDatabase(signal);
    try {
      signal.throwIfAborted();
      const transaction = database.transaction([ASSET_STORE, BLOB_STORE, GENERATED_CACHE_STORE], "readwrite"), done = transactionComplete(transaction);
      // Handle a rejection immediately, including one occurring while IDB reads await.
      void done.catch(() => undefined);
      const abort = () => { try { transaction.abort(); } catch { /* Already committed. */ } };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const assets = transaction.objectStore(ASSET_STORE), markers = transaction.objectStore(GENERATED_CACHE_STORE);
        const [existing, previous] = await Promise.all([
          requestResult(assets.get(asset.id) as IDBRequest<Asset | undefined>),
          requestResult(markers.get(asset.id) as IDBRequest<GeneratedCacheRecord | undefined>),
        ]);
        signal.throwIfAborted();
        if ((existing && (JSON.stringify(existing) !== marker.metadata || !previous))
          || (previous && (!existing || JSON.stringify(previous) !== JSON.stringify(marker)))) throw new Error("生成资产编号、项目或不可变元数据与本地记录冲突。");
        const blobs = transaction.objectStore(BLOB_STORE);
        // Never content-deduplicate two independent outputs or replace another
        // project's global asset ID. All metadata/original/proxy/marker commit together.
        if (!existing) assets.add(asset);
        blobs.put({ key: `${asset.id}:original`, assetId: asset.id, role: "original", blob: original } satisfies BlobRecord);
        blobs.put({ key: `${asset.id}:proxy`, assetId: asset.id, role: "proxy", blob: proxy } satisfies BlobRecord);
        if (!previous) markers.add(marker);
        await done;
        return asset;
      } catch (error) { abort(); await done.catch(() => undefined); throw error; }
      finally { signal.removeEventListener("abort", abort); }
    } finally { database.close(); }
  }

  async restore(projectId: string, records: RestoredAsset[]): Promise<void> {
    const ids = new Set<string>();
    for (const { asset, original, proxy } of records) {
      if (asset.projectId !== projectId || ids.has(asset.id)) throw new Error("项目包资产编号无效或重复");
      if (original.size !== asset.byteSize) throw new Error(`原文件大小不匹配：${asset.originalName}`);
      if (Boolean(asset.proxyStorageKey) !== Boolean(proxy)) throw new Error(`预览文件不完整：${asset.originalName}`);
      ids.add(asset.id);
    }
    const database = await openDatabase();
    try {
      const transaction = database.transaction([ASSET_STORE, BLOB_STORE], "readwrite");
      const assetStore = transaction.objectStore(ASSET_STORE);
      const blobStore = transaction.objectStore(BLOB_STORE);
      for (const { asset, original, proxy } of records) {
        assetStore.add(asset);
        blobStore.add({ key: `${asset.id}:original`, assetId: asset.id, role: "original", blob: original } satisfies BlobRecord);
        if (proxy) blobStore.add({ key: `${asset.id}:proxy`, assetId: asset.id, role: "proxy", blob: proxy } satisfies BlobRecord);
      }
      await transactionComplete(transaction);
    } catch (error) {
      if (error instanceof DOMException && error.name === "ConstraintError") throw new Error("项目包资产与本地编号冲突");
      throw error;
    } finally {
      database.close();
    }
  }

  async restoreOriginal(projectId: string, assetId: string, blob: Blob): Promise<Asset> {
    const asset = (await this.list(projectId)).find((candidate) => candidate.id === assetId);
    if (!asset) throw new Error("待恢复资产不存在或不属于当前项目");
    if (blob.size !== asset.byteSize || (blob.type && blob.type !== asset.mimeType)) throw new Error("备份对象与资产元数据不匹配");
    if (asset.contentFingerprint && blob.size <= 32 * 1024 * 1024) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
      const fingerprint = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      if (fingerprint !== asset.contentFingerprint) throw new Error("备份对象内容指纹与资产不匹配");
    }
    const metadata = asset.kind === "image"
      ? await inspectImage(blob)
      : asset.kind === "video"
        ? await inspectVideo(blob, asset.originalName)
        : null;
    const proxy = metadata && "proxy" in metadata ? metadata.proxy : undefined;
    const restored: Asset = asset.purpose === "generated" ? asset : {
      ...asset,
      width: metadata?.width ?? asset.width,
      height: metadata?.height ?? asset.height,
      durationMs: metadata && "durationMs" in metadata ? metadata.durationMs : asset.durationMs,
      proxyStorageKey: proxy ? `indexeddb://assets/${asset.id}/proxy` : undefined,
    };
    const database = await openDatabase();
    try {
      const transaction = database.transaction([ASSET_STORE, BLOB_STORE], "readwrite");
      transaction.objectStore(ASSET_STORE).put(restored);
      const blobStore = transaction.objectStore(BLOB_STORE);
      blobStore.put({ key: `${asset.id}:original`, assetId: asset.id, role: "original", blob } satisfies BlobRecord);
      if (proxy) blobStore.put({ key: `${asset.id}:proxy`, assetId: asset.id, role: "proxy", blob: proxy } satisfies BlobRecord);
      else blobStore.delete(`${asset.id}:proxy`);
      await transactionComplete(transaction);
      return restored;
    } finally {
      database.close();
    }
  }

  async remove(projectId: string, assetId: string): Promise<boolean> {
    const database = await openDatabase();
    try {
      const lookup = database.transaction(ASSET_STORE, "readonly");
      const asset = await requestResult(lookup.objectStore(ASSET_STORE).get(assetId) as IDBRequest<Asset | undefined>);
      if (!asset || asset.projectId !== projectId) return false;
      const transaction = database.transaction([ASSET_STORE, BLOB_STORE, GENERATED_CACHE_STORE, PRODUCTION_CACHE_STORE, LOCKED_CACHE_STORE], "readwrite");
      transaction.objectStore(ASSET_STORE).delete(assetId);
      transaction.objectStore(GENERATED_CACHE_STORE).delete(assetId);
      transaction.objectStore(PRODUCTION_CACHE_STORE).delete(assetId);
      transaction.objectStore(LOCKED_CACHE_STORE).delete(assetId);
      transaction.objectStore(BLOB_STORE).delete(`${assetId}:original`);
      transaction.objectStore(BLOB_STORE).delete(`${assetId}:proxy`);
      await transactionComplete(transaction);
      return true;
    } finally {
      database.close();
    }
  }

  async importFiles(projectId: string, files: File[]): Promise<AssetImportResult> {
    const imported: Asset[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        imported.push(await this.importFile(projectId, file));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `${file.name} 导入失败`);
      }
    }
    return { assets: imported, errors };
  }

  private async importFile(projectId: string, file: File): Promise<Asset> {
    const kind = validateAssetFile(file);
    const contentFingerprint = await createFileFingerprint(file);
    if (contentFingerprint) {
      const existingDatabase = await openDatabase();
      try {
        const transaction = existingDatabase.transaction(ASSET_STORE, "readonly");
        const matching = await requestResult(transaction.objectStore(ASSET_STORE).index("projectFingerprint").getAll([projectId, contentFingerprint]) as IDBRequest<Asset[]>);
        const existing = matching.find((asset) => asset.purpose !== "generated");
        if (existing) return existing;
      } finally {
        existingDatabase.close();
      }
    }
    const metadata = kind === "image" ? await inspectImage(file) : await inspectVideo(file, file.name);
    const id = createId(kind);
    const asset: Asset = {
      id,
      projectId,
      kind,
      purpose: "source",
      originalName: file.name,
      contentFingerprint,
      storageKey: `indexeddb://assets/${id}/original`,
      proxyStorageKey: "proxy" in metadata && metadata.proxy ? `indexeddb://assets/${id}/proxy` : undefined,
      mimeType: file.type,
      byteSize: file.size,
      width: metadata.width,
      height: metadata.height,
      durationMs: "durationMs" in metadata ? metadata.durationMs : undefined,
      createdAt: new Date().toISOString(),
    };
    const database = await openDatabase();
    try {
      const transaction = database.transaction([ASSET_STORE, BLOB_STORE], "readwrite");
      transaction.objectStore(ASSET_STORE).put(asset);
      const blobStore = transaction.objectStore(BLOB_STORE);
      blobStore.put({ key: `${id}:original`, assetId: id, role: "original", blob: file } satisfies BlobRecord);
      if ("proxy" in metadata && metadata.proxy) {
        blobStore.put({ key: `${id}:proxy`, assetId: id, role: "proxy", blob: metadata.proxy } satisfies BlobRecord);
      }
      await transactionComplete(transaction);
      return asset;
    } finally {
      database.close();
    }
  }
}

export const assetRepository = new IndexedDbAssetRepository();
