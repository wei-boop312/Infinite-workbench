import { describe, expect, it } from "vitest";
import type { Asset } from "../packages/contracts/src/index";
import {
  ResumableUploadManager,
  createChunkTreeFingerprint,
  type BeginUploadInput,
  type ObjectStoragePort,
  type RemoteObject,
  type RemoteStorageUsage,
  type UploadSession,
  type UploadStatus,
} from "../apps/web/src/storage/objectStorage";

class MemoryObjectStorage implements ObjectStoragePort {
  sessions = new Map<string, UploadSession>();
  objects = new Map<string, RemoteObject>();
  parts = new Map<string, Map<number, Blob>>();
  partWrites: number[] = [];
  failOnceAt: number | null = null;

  async listSessions(projectId: string) { return [...this.sessions.values()].filter((session) => session.projectId === projectId); }
  async getSession(projectId: string, assetId: string) {
    return [...this.sessions.values()].find((session) => session.projectId === projectId && session.assetId === assetId) ?? null;
  }
  async getObject(objectKey: string) {
    const object = [...this.objects.values()].find((candidate) => candidate.key === objectKey);
    if (!object) return null;
    const parts = this.parts.get(object.ownerSessionId);
    if (!parts) return null;
    return new Blob([...parts.entries()].sort(([left], [right]) => left - right).map(([, blob]) => blob), { type: object.mimeType });
  }
  async findObject(fingerprint: string, byteSize: number) { return this.objects.get(`${fingerprint}:${byteSize}`) ?? null; }
  async beginUpload(input: BeginUploadInput) {
    const existing = await this.getSession(input.projectId, input.assetId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const session: UploadSession = {
      id: `session-${this.sessions.size + 1}`,
      ...input,
      uploadedParts: [],
      uploadedBytes: 0,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }
  async setStatus(sessionId: string, status: UploadStatus, error?: string) {
    const current = this.sessions.get(sessionId)!;
    const next = { ...current, status, error, updatedAt: new Date().toISOString() };
    this.sessions.set(sessionId, next);
    return next;
  }
  async putPart(sessionId: string, index: number, blob: Blob, _digest: string) {
    if (this.failOnceAt === index) {
      this.failOnceAt = null;
      throw new Error("模拟分片失败");
    }
    const current = this.sessions.get(sessionId)!;
    if (current.uploadedParts.includes(index)) return current;
    const stored = this.parts.get(sessionId) ?? new Map<number, Blob>();
    stored.set(index, blob);
    this.parts.set(sessionId, stored);
    this.partWrites.push(index);
    const uploadedParts = [...current.uploadedParts, index].sort((a, b) => a - b);
    const next = {
      ...current,
      uploadedParts,
      uploadedBytes: uploadedParts.reduce((total, partIndex) => total + Math.min(current.chunkSize, current.totalBytes - partIndex * current.chunkSize), 0),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, next);
    return next;
  }
  async completeUpload(sessionId: string) {
    const current = this.sessions.get(sessionId)!;
    const object: RemoteObject = {
      key: `memory://object-${this.objects.size + 1}`,
      fingerprint: current.fingerprint,
      mimeType: current.mimeType,
      byteSize: current.totalBytes,
      chunkSize: current.chunkSize,
      totalParts: current.totalParts,
      ownerSessionId: current.id,
      partDigests: current.uploadedParts.map(() => "sha256:test"),
      createdAt: new Date().toISOString(),
    };
    this.objects.set(`${object.fingerprint}:${object.byteSize}`, object);
    const next = { ...current, status: "completed" as const, objectKey: object.key, updatedAt: new Date().toISOString() };
    this.sessions.set(sessionId, next);
    return next;
  }
  async linkExisting(input: BeginUploadInput, object: RemoteObject) {
    const current = await this.getSession(input.projectId, input.assetId);
    const now = new Date().toISOString();
    const session: UploadSession = {
      id: current?.id ?? `session-${this.sessions.size + 1}`,
      ...input,
      uploadedParts: Array.from({ length: input.totalParts }, (_, index) => index),
      uploadedBytes: input.totalBytes,
      status: "reused",
      objectKey: object.key,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }
  async usage(): Promise<RemoteStorageUsage> {
    return {
      objectCount: this.objects.size,
      sessionCount: this.sessions.size,
      storedBytes: [...this.parts.values()].flatMap((parts) => [...parts.values()]).reduce((total, blob) => total + blob.size, 0),
      completedBytes: [...this.objects.values()].reduce((total, object) => total + object.byteSize, 0),
    };
  }
}

function createAsset(id: string, projectId: string, byteSize: number): Asset {
  return {
    id,
    projectId,
    kind: "video",
    purpose: "source",
    originalName: `${id}.mp4`,
    storageKey: `memory://${id}`,
    mimeType: "video/mp4",
    byteSize,
    createdAt: "2026-09-27T00:00:00.000Z",
  };
}

describe("可续传对象存储状态机", () => {
  it("为任意大小 Blob 生成稳定的分片 SHA-256 树指纹", async () => {
    const first = await createChunkTreeFingerprint(new Blob([new Uint8Array([1, 2, 3, 4, 5])]), 2);
    const second = await createChunkTreeFingerprint(new Blob([new Uint8Array([1, 2, 3, 4, 5])]), 2);
    const changed = await createChunkTreeFingerprint(new Blob([new Uint8Array([1, 2, 3, 4, 6])]), 2);
    expect(first.fingerprint).toMatch(/^sha256-tree-v1:[a-f0-9]{64}:5:2$/);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(first.partDigests.size).toBe(3);
  });

  it("暂停后只上传剩余分片，并让另一项目复用相同对象", async () => {
    const storage = new MemoryObjectStorage();
    const manager = new ResumableUploadManager(storage, 4);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])], { type: "video/mp4" });
    const controller = new AbortController();
    const paused = await manager.upload(createAsset("asset-a", "project-a", blob.size), blob, {
      signal: controller.signal,
      onProgress: (session) => {
        if (session.status === "uploading" && session.uploadedParts.length === 1) controller.abort();
      },
    });
    expect(paused).toMatchObject({ status: "paused", uploadedParts: [0], uploadedBytes: 4 });

    const completed = await manager.upload(createAsset("asset-a", "project-a", blob.size), blob);
    expect(completed).toMatchObject({ status: "completed", uploadedParts: [0, 1, 2], uploadedBytes: 10 });
    expect(storage.partWrites).toEqual([0, 1, 2]);
    expect(new Uint8Array(await (await storage.getObject(completed.objectKey!))!.arrayBuffer())).toEqual(new Uint8Array(await blob.arrayBuffer()));

    const reused = await manager.upload(createAsset("asset-b", "project-b", blob.size), blob);
    expect(reused.status).toBe("reused");
    expect(reused.objectKey).toBe(completed.objectKey);
    expect(storage.partWrites).toEqual([0, 1, 2]);
    expect(storage.objects.size).toBe(1);
  });

  it("分片失败后保留进度，重试不会重新写入成功分片", async () => {
    const storage = new MemoryObjectStorage();
    storage.failOnceAt = 1;
    const manager = new ResumableUploadManager(storage, 4);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])], { type: "video/mp4" });
    const asset = createAsset("asset-failure", "project-a", blob.size);
    await expect(manager.upload(asset, blob)).rejects.toThrow(/模拟分片失败/);
    expect(await storage.getSession(asset.projectId, asset.id)).toMatchObject({ status: "failed", uploadedParts: [0] });

    const recovered = await manager.upload(asset, blob);
    expect(recovered.status).toBe("completed");
    expect(storage.partWrites).toEqual([0, 1, 2]);
  });
});
