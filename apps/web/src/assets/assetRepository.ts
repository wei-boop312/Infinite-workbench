import type { Asset } from "@canvas/contracts";

const DATABASE_NAME = "ai-commerce-canvas-assets";
const DATABASE_VERSION = 2;
const ASSET_STORE = "assets";
const BLOB_STORE = "blobs";
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

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) return Promise.reject(new Error("当前浏览器不支持本地资产库"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开浏览器资产库"));
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
      if (!asset.proxyStorageKey) continue;
      proxyBytes += (await this.getBlob(asset.id, "proxy"))?.size ?? 0;
    }
    const originalBytes = assets.reduce((total, asset) => total + asset.byteSize, 0);
    return { count: assets.length, originalBytes, proxyBytes, totalBytes: originalBytes + proxyBytes };
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
    const restored: Asset = {
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
      const transaction = database.transaction([ASSET_STORE, BLOB_STORE], "readwrite");
      transaction.objectStore(ASSET_STORE).delete(assetId);
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
        const existing = await requestResult(transaction.objectStore(ASSET_STORE).index("projectFingerprint").get([projectId, contentFingerprint]) as IDBRequest<Asset | undefined>);
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
