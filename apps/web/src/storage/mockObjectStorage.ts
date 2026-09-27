import type {
  BeginUploadInput,
  ObjectStoragePort,
  RemoteObject,
  RemoteStorageUsage,
  UploadSession,
  UploadStatus,
} from "./objectStorage";

const DATABASE_NAME = "ai-commerce-canvas-mock-remote";
const DATABASE_VERSION = 1;
const SESSION_STORE = "sessions";
const PART_STORE = "parts";
const OBJECT_STORE = "objects";

type PartRecord = { key: string; sessionId: string; index: number; digest: string; blob: Blob };

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("假远端存储请求失败"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("假远端存储事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("假远端存储事务已中止"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) return Promise.reject(new Error("当前浏览器不支持本地假远端"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const sessions = database.createObjectStore(SESSION_STORE, { keyPath: "id" });
      sessions.createIndex("projectId", "projectId", { unique: false });
      sessions.createIndex("projectAsset", ["projectId", "assetId"], { unique: true });
      const parts = database.createObjectStore(PART_STORE, { keyPath: "key" });
      parts.createIndex("sessionId", "sessionId", { unique: false });
      const objects = database.createObjectStore(OBJECT_STORE, { keyPath: "key" });
      objects.createIndex("fingerprintSize", ["fingerprint", "byteSize"], { unique: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地假远端"));
  });
}

function uploadedBytes(session: UploadSession, parts: number[]): number {
  return parts.reduce((total, index) => {
    const start = index * session.chunkSize;
    return total + Math.max(0, Math.min(session.chunkSize, session.totalBytes - start));
  }, 0);
}

export class IndexedDbMockObjectStorage implements ObjectStoragePort {
  private async getSessionById(sessionId: string): Promise<UploadSession | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(SESSION_STORE, "readonly");
      return await requestResult(transaction.objectStore(SESSION_STORE).get(sessionId) as IDBRequest<UploadSession | undefined>) ?? null;
    } finally {
      database.close();
    }
  }

  async listSessions(projectId: string): Promise<UploadSession[]> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(SESSION_STORE, "readonly");
      const sessions = await requestResult(transaction.objectStore(SESSION_STORE).index("projectId").getAll(projectId) as IDBRequest<UploadSession[]>);
      return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } finally {
      database.close();
    }
  }

  async getSession(projectId: string, assetId: string): Promise<UploadSession | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(SESSION_STORE, "readonly");
      return await requestResult(transaction.objectStore(SESSION_STORE).index("projectAsset").get([projectId, assetId]) as IDBRequest<UploadSession | undefined>) ?? null;
    } finally {
      database.close();
    }
  }

  async findObject(fingerprint: string, byteSize: number): Promise<RemoteObject | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(OBJECT_STORE, "readonly");
      return await requestResult(transaction.objectStore(OBJECT_STORE).index("fingerprintSize").get([fingerprint, byteSize]) as IDBRequest<RemoteObject | undefined>) ?? null;
    } finally {
      database.close();
    }
  }

  async beginUpload(input: BeginUploadInput): Promise<UploadSession> {
    const existing = await this.getSession(input.projectId, input.assetId);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint || existing.totalBytes !== input.totalBytes) {
        throw new Error("资产内容已变化，不能续传旧会话");
      }
      return existing;
    }
    const now = new Date().toISOString();
    const session: UploadSession = {
      id: `upload-${crypto.randomUUID()}`,
      ...input,
      uploadedParts: [],
      uploadedBytes: 0,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    const database = await openDatabase();
    try {
      const transaction = database.transaction(SESSION_STORE, "readwrite");
      transaction.objectStore(SESSION_STORE).add(session);
      await transactionComplete(transaction);
      return session;
    } finally {
      database.close();
    }
  }

  async setStatus(sessionId: string, status: UploadStatus, error?: string): Promise<UploadSession> {
    const session = await this.getSessionById(sessionId);
    if (!session) throw new Error("上传会话不存在");
    const next: UploadSession = { ...session, status, error, updatedAt: new Date().toISOString() };
    const database = await openDatabase();
    try {
      const transaction = database.transaction(SESSION_STORE, "readwrite");
      transaction.objectStore(SESSION_STORE).put(next);
      await transactionComplete(transaction);
      return next;
    } finally {
      database.close();
    }
  }

  async putPart(sessionId: string, index: number, blob: Blob, digest: string): Promise<UploadSession> {
    const session = await this.getSessionById(sessionId);
    if (!session || session.status !== "uploading") throw new Error("上传会话未处于可写状态");
    if (!Number.isInteger(index) || index < 0 || index >= session.totalParts) throw new Error("分片编号无效");
    const expectedSize = Math.min(session.chunkSize, session.totalBytes - index * session.chunkSize);
    if (blob.size !== expectedSize || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("分片内容或摘要无效");
    if (session.uploadedParts.includes(index)) return session;
    const uploadedParts = [...session.uploadedParts, index].sort((a, b) => a - b);
    const next: UploadSession = {
      ...session,
      uploadedParts,
      uploadedBytes: uploadedBytes(session, uploadedParts),
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
    const database = await openDatabase();
    try {
      const transaction = database.transaction([SESSION_STORE, PART_STORE], "readwrite");
      transaction.objectStore(PART_STORE).add({ key: `${sessionId}:${index}`, sessionId, index, digest, blob } satisfies PartRecord);
      transaction.objectStore(SESSION_STORE).put(next);
      await transactionComplete(transaction);
      return next;
    } finally {
      database.close();
    }
  }

  async completeUpload(sessionId: string): Promise<UploadSession> {
    const session = await this.getSessionById(sessionId);
    if (!session || session.uploadedParts.length !== session.totalParts || session.uploadedBytes !== session.totalBytes) {
      throw new Error("仍有分片未上传，不能完成对象");
    }
    const alreadyStored = await this.findObject(session.fingerprint, session.totalBytes);
    if (alreadyStored) return this.linkExisting({
      projectId: session.projectId,
      assetId: session.assetId,
      fingerprint: session.fingerprint,
      mimeType: session.mimeType,
      totalBytes: session.totalBytes,
      chunkSize: session.chunkSize,
      totalParts: session.totalParts,
    }, alreadyStored);
    const database = await openDatabase();
    try {
      const readTransaction = database.transaction(PART_STORE, "readonly");
      const parts = await requestResult(readTransaction.objectStore(PART_STORE).index("sessionId").getAll(sessionId) as IDBRequest<PartRecord[]>);
      parts.sort((a, b) => a.index - b.index);
      if (parts.length !== session.totalParts) throw new Error("假远端分片记录不完整");
      const object: RemoteObject = {
        key: `mock://objects/${crypto.randomUUID()}`,
        fingerprint: session.fingerprint,
        mimeType: session.mimeType,
        byteSize: session.totalBytes,
        chunkSize: session.chunkSize,
        totalParts: session.totalParts,
        ownerSessionId: session.id,
        partDigests: parts.map((part) => part.digest),
        createdAt: new Date().toISOString(),
      };
      const next: UploadSession = {
        ...session,
        status: "completed",
        objectKey: object.key,
        error: undefined,
        updatedAt: new Date().toISOString(),
      };
      const writeTransaction = database.transaction([OBJECT_STORE, SESSION_STORE], "readwrite");
      writeTransaction.objectStore(OBJECT_STORE).add(object);
      writeTransaction.objectStore(SESSION_STORE).put(next);
      await transactionComplete(writeTransaction);
      return next;
    } finally {
      database.close();
    }
  }

  async linkExisting(input: BeginUploadInput, object: RemoteObject): Promise<UploadSession> {
    const current = await this.getSession(input.projectId, input.assetId);
    const now = new Date().toISOString();
    const session: UploadSession = {
      id: current?.id ?? `upload-${crypto.randomUUID()}`,
      ...input,
      uploadedParts: Array.from({ length: input.totalParts }, (_, index) => index),
      uploadedBytes: input.totalBytes,
      status: "reused",
      objectKey: object.key,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    const database = await openDatabase();
    try {
      const transaction = database.transaction(SESSION_STORE, "readwrite");
      transaction.objectStore(SESSION_STORE).put(session);
      await transactionComplete(transaction);
      return session;
    } finally {
      database.close();
    }
  }

  async usage(): Promise<RemoteStorageUsage> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction([OBJECT_STORE, SESSION_STORE, PART_STORE], "readonly");
      const [objects, sessions, parts] = await Promise.all([
        requestResult(transaction.objectStore(OBJECT_STORE).getAll() as IDBRequest<RemoteObject[]>),
        requestResult(transaction.objectStore(SESSION_STORE).getAll() as IDBRequest<UploadSession[]>),
        requestResult(transaction.objectStore(PART_STORE).getAll() as IDBRequest<PartRecord[]>),
      ]);
      return {
        objectCount: objects.length,
        sessionCount: sessions.length,
        storedBytes: parts.reduce((total, part) => total + part.blob.size, 0),
        completedBytes: objects.reduce((total, object) => total + object.byteSize, 0),
      };
    } finally {
      database.close();
    }
  }
}

export const mockObjectStorage = new IndexedDbMockObjectStorage();
