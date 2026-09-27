import type { Asset } from "@canvas/contracts";

export const DEFAULT_UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;

export type UploadStatus = "queued" | "hashing" | "uploading" | "paused" | "failed" | "completed" | "reused";

export type UploadSession = {
  id: string;
  projectId: string;
  assetId: string;
  fingerprint: string;
  mimeType: string;
  totalBytes: number;
  chunkSize: number;
  totalParts: number;
  uploadedParts: number[];
  uploadedBytes: number;
  status: UploadStatus;
  objectKey?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type RemoteObject = {
  key: string;
  fingerprint: string;
  mimeType: string;
  byteSize: number;
  chunkSize: number;
  totalParts: number;
  ownerSessionId: string;
  partDigests: string[];
  createdAt: string;
};

export type RemoteStorageUsage = {
  objectCount: number;
  sessionCount: number;
  storedBytes: number;
  completedBytes: number;
};

export type BeginUploadInput = {
  projectId: string;
  assetId: string;
  fingerprint: string;
  mimeType: string;
  totalBytes: number;
  chunkSize: number;
  totalParts: number;
};

export interface ObjectStoragePort {
  listSessions(projectId: string): Promise<UploadSession[]>;
  getSession(projectId: string, assetId: string): Promise<UploadSession | null>;
  getObject(objectKey: string): Promise<Blob | null>;
  findObject(fingerprint: string, byteSize: number): Promise<RemoteObject | null>;
  beginUpload(input: BeginUploadInput): Promise<UploadSession>;
  setStatus(sessionId: string, status: UploadStatus, error?: string): Promise<UploadSession>;
  putPart(sessionId: string, index: number, blob: Blob, digest: string): Promise<UploadSession>;
  completeUpload(sessionId: string): Promise<UploadSession>;
  linkExisting(input: BeginUploadInput, object: RemoteObject): Promise<UploadSession>;
  usage(): Promise<RemoteStorageUsage>;
}

export type UploadProgressHandlers = {
  signal?: AbortSignal;
  onProgress?: (session: UploadSession) => void;
  onHashProgress?: (processedBytes: number, totalBytes: number) => void;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(blob: Blob): Promise<{ hex: string; bytes: Uint8Array }> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return { hex: bytesToHex(digest), bytes: digest };
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("上传已暂停", "AbortError");
}

export async function createChunkTreeFingerprint(
  blob: Blob,
  chunkSize = DEFAULT_UPLOAD_CHUNK_SIZE,
  handlers: Pick<UploadProgressHandlers, "signal" | "onHashProgress"> = {},
): Promise<{ fingerprint: string; partDigests: Map<number, string> }> {
  if (blob.size <= 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("无法为无效文件计算内容指纹");
  const totalParts = Math.ceil(blob.size / chunkSize);
  const digestBytes: Uint8Array[] = [];
  const partDigests = new Map<number, string>();
  for (let index = 0; index < totalParts; index += 1) {
    abortIfRequested(handlers.signal);
    const start = index * chunkSize;
    const part = blob.slice(start, Math.min(blob.size, start + chunkSize));
    const digest = await sha256(part);
    digestBytes.push(digest.bytes);
    partDigests.set(index, `sha256:${digest.hex}`);
    handlers.onHashProgress?.(start + part.size, blob.size);
  }
  const joined = new Uint8Array(digestBytes.reduce((total, digest) => total + digest.byteLength, 0));
  let offset = 0;
  for (const digest of digestBytes) {
    joined.set(digest, offset);
    offset += digest.byteLength;
  }
  const root = new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
  return {
    fingerprint: `sha256-tree-v1:${bytesToHex(root)}:${blob.size}:${chunkSize}`,
    partDigests,
  };
}

export class ResumableUploadManager {
  constructor(
    private readonly storage: ObjectStoragePort,
    private readonly chunkSize = DEFAULT_UPLOAD_CHUNK_SIZE,
  ) {}

  async upload(asset: Asset, blob: Blob, handlers: UploadProgressHandlers = {}): Promise<UploadSession> {
    if (blob.size !== asset.byteSize) throw new Error(`本地原文件大小不匹配：${asset.originalName}`);
    let session = await this.storage.getSession(asset.projectId, asset.id);
    if (session?.status === "completed" || session?.status === "reused") {
      handlers.onProgress?.(session);
      return session;
    }

    let fingerprint = session?.fingerprint || asset.contentFingerprint;
    let cachedPartDigests = new Map<number, string>();
    if (!fingerprint) {
      const fingerprintResult = await createChunkTreeFingerprint(blob, this.chunkSize, handlers);
      fingerprint = fingerprintResult.fingerprint;
      cachedPartDigests = fingerprintResult.partDigests;
    }
    abortIfRequested(handlers.signal);

    const input: BeginUploadInput = {
      projectId: asset.projectId,
      assetId: asset.id,
      fingerprint,
      mimeType: asset.mimeType,
      totalBytes: blob.size,
      chunkSize: this.chunkSize,
      totalParts: Math.ceil(blob.size / this.chunkSize),
    };
    const existing = await this.storage.findObject(fingerprint, blob.size);
    if (existing) {
      session = await this.storage.linkExisting(input, existing);
      handlers.onProgress?.(session);
      return session;
    }

    session = session ?? await this.storage.beginUpload(input);
    session = await this.storage.setStatus(session.id, "uploading");
    handlers.onProgress?.(session);
    try {
      const completedParts = new Set(session.uploadedParts);
      for (let index = 0; index < session.totalParts; index += 1) {
        if (completedParts.has(index)) continue;
        abortIfRequested(handlers.signal);
        const start = index * session.chunkSize;
        const part = blob.slice(start, Math.min(blob.size, start + session.chunkSize));
        let digest = cachedPartDigests.get(index);
        if (!digest) digest = `sha256:${(await sha256(part)).hex}`;
        session = await this.storage.putPart(session.id, index, part, digest);
        handlers.onProgress?.(session);
      }
      abortIfRequested(handlers.signal);
      session = await this.storage.completeUpload(session.id);
      handlers.onProgress?.(session);
      return session;
    } catch (error) {
      const paused = handlers.signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
      session = await this.storage.setStatus(
        session.id,
        paused ? "paused" : "failed",
        paused ? undefined : error instanceof Error ? error.message : "分片上传失败",
      );
      handlers.onProgress?.(session);
      if (paused) return session;
      throw error;
    }
  }
}
