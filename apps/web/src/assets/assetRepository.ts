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
export interface AssetRepositoryPort {
  list(projectId: string): Promise<Asset[]>;
  getBlob(assetId: string, role: BlobRole): Promise<Blob | null>;
  importFiles(projectId: string, files: File[]): Promise<AssetImportResult>;
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

async function inspectImage(file: File): Promise<{ width: number; height: number; proxy: Blob }> {
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

async function inspectVideo(file: File): Promise<{ width: number; height: number; durationMs: number; proxy?: Blob }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(`读取视频元数据超时：${file.name}`)), 8_000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error(`无法读取视频元数据：${file.name}`));
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
    const metadata = kind === "image" ? await inspectImage(file) : await inspectVideo(file);
    const id = createId(kind);
    const asset: Asset = {
      id,
      projectId,
      kind,
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
