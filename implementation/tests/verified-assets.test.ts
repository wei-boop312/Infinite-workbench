import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Asset, CreateRunBatchRequest, VerifiedImage } from "../packages/contracts/src/index";
import { VerifiedImageSchema } from "../packages/contracts/src/index";
import { createApiServer } from "../apps/api/src/index";
import { StaticObjectStorageAuthorizer } from "../apps/api/src/objectStorageGateway";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { LocalVerifiedAssets, MAX_VERIFIED_IMAGE_BYTES } from "../apps/api/src/verifiedAssets";

// Use the decoder installed by the API package to make tiny, zero-cost fixtures.
const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const checksum = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const principal = { tenantId: "tenant-a", actorId: "designer" };
const directories: string[] = [];
const stores: SqliteRunKernelStateStore[] = [];
const servers: Server[] = [];
const route = (id = "source-1", project = "project-a") => `/v1/projects/${project}/assets/${id}/verification`;
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function asset(body = png, extra: Partial<Asset> = {}): Asset {
  return { id: "source-1", projectId: "project-a", kind: "image", purpose: "source", originalName: "source.png",
    mimeType: "image/png", byteSize: body.length, storageKey: "indexeddb://untrusted-client", createdAt: "2026-10-03T00:00:00Z", ...extra };
}
function setup(options: { path?: string; store?: SqliteRunKernelStateStore; quota?: number; registered?: Map<string, Asset> } = {}) {
  const path = options.path ?? (() => { const dir = mkdtempSync(join(tmpdir(), "canvas-image-verification-")); directories.push(dir); return join(dir, "state.sqlite"); })();
  const store = options.store ?? new SqliteRunKernelStateStore(path); stores.push(store);
  const registered = options.registered ?? new Map([["source-1", asset()]]);
  const authorizer = new StaticObjectStorageAuthorizer([
    { ...principal, bearerToken: "writer", projects: { "project-a": ["asset:read", "asset:write"], "project-b": ["asset:read", "asset:write"] } },
    { tenantId: "tenant-a", actorId: "reader", bearerToken: "reader", projects: { "project-a": ["asset:read"] } },
    { tenantId: "tenant-b", actorId: "foreign", bearerToken: "foreign", projects: { "project-a": ["asset:read", "asset:write"] } },
  ]);
  const verified = new LocalVerifiedAssets({ stateStore: store, authorizer, maxProjectBytes: options.quota,
    findAsset: (tenant, project, id) => { const value = registered.get(id); return tenant === "tenant-a" && value?.projectId === project ? value : null; } });
  const kernel = new SqliteRunKernel({ stateStore: store, authorizer: { authenticate: () => null, allows: () => true },
    budgets: [{ tenantId: "tenant-a", projectId: "project-a", currency: "CNY", limitMinor: 1000 }],
    validateInputs: (tenant, request) => { for (const id of request.inputAssetIds) verified.requireImage(tenant, request.projectId, id); } });
  return { path, store, registered, verified, kernel };
}
async function listen(verified?: LocalVerifiedAssets) {
  const server = createApiServer({ verifiedAssets: verified }); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("test server unavailable");
  return `http://127.0.0.1:${address.port}`;
}
function upload(url: string, body = png, id = "source-1", headers: Record<string, string> = {}, project = "project-a") {
  return fetch(`${url}${route(id, project)}`, { method: "POST", headers: { authorization: "Bearer writer", "content-type": "image/png", "x-content-sha256": checksum(body), ...headers }, body });
}
function read(url: string, id = "source-1", token = "writer") {
  return fetch(`${url}${route(id)}`, { headers: { authorization: `Bearer ${token}` } });
}
const batchRequest: CreateRunBatchRequest = { projectId: "project-a", constraintSnapshotId: "constraint-1", tool: "product-retouch", inputAssetIds: ["source-1"],
  expectedOutputs: 1, maxCostMinor: 100, currency: "CNY", idempotencyKey: "action-1", mockScenario: "success" };

describe("权威图片原文件核验", () => {
  it("默认关闭，拒绝匿名、只读写入和跨租户/项目编号复用", async () => {
    expect((await upload(await listen())).status).toBe(503);
    const { verified } = setup(); const url = await listen(verified);
    expect((await upload(url, png, "source-1", { authorization: "" })).status).toBe(401);
    expect((await upload(url, png, "source-1", { authorization: "Bearer reader" })).status).toBe(403);
    expect((await upload(url, png, "source-1", { authorization: "Bearer foreign" })).status).toBe(404);
    expect((await upload(url, png, "source-1", {}, "project-b")).status).toBe(404);
    expect((await read(url, "source-1", "foreign")).status).toBe(404);
    expect((await upload(url)).status).toBe(200);
    expect((await read(url, "source-1", "reader")).status).toBe(200);
  });

  it("实际解码原文件，原子保存正文与服务端收据，重启及并发重放不重复占空间", async () => {
    const first = setup(); const url = await listen(first.verified);
    const responses = await Promise.all([upload(url), upload(url)]);
    expect(responses.map((value) => value.status)).toEqual([200, 200]);
    const [a, b] = await Promise.all(responses.map((value) => value.json())) as VerifiedImage[];
    expect(a).toEqual(b);
    expect(a).toMatchObject({ tenantId: "tenant-a", checksumSha256: checksum(png), decoder: "sharp-full-decode-v1", verifiedBy: "designer",
      asset: { width: 1, height: 1, byteSize: png.length, contentFingerprint: `sha256:${checksum(png)}` } });
    expect(a.asset.storageKey).toMatch(/^local-verified:[a-f0-9]{64}$/);
    expect(VerifiedImageSchema.safeParse({ ...a, asset: { ...a.asset, kind: "video" } }).success).toBe(false);
    expect(VerifiedImageSchema.safeParse({ ...a, asset: { ...a.asset, width: undefined } }).success).toBe(false);
    expect(VerifiedImageSchema.safeParse({ ...a, checksumSha256: "0".repeat(64) }).success).toBe(false);
    expect(first.store.verifiedImageBytes("tenant-a", "project-a")).toBe(png.length);
    expect(JSON.stringify(first.store.load())).not.toContain(png.toString("base64"));
    const second = setup({ path: first.path });
    expect(await (await upload(await listen(second.verified))).json()).toEqual(a);
    expect(second.store.loadVerifiedImage("tenant-a", "project-a", "source-1")).toEqual(a);
    expect(second.store.verifiedImageBytes("tenant-a", "project-a")).toBe(png.length);
  });

  it("拒绝自报收据、错误摘要、伪造 MIME、大小和尺寸，不保存无效原文件", async () => {
    const { verified, registered, store } = setup(); const url = await listen(verified);
    const cases: Array<[Buffer, Partial<Asset>, Record<string, string>, string]> = [
      [png, {}, { "x-content-sha256": "" }, "verified_asset_headers_invalid"],
      [png, {}, { "x-content-sha256": "0".repeat(64) }, "verified_asset_checksum_mismatch"],
      [png, { contentFingerprint: `sha256:${"0".repeat(64)}` }, {}, "verified_asset_checksum_mismatch"],
      [png, { mimeType: "image/jpeg" }, { "content-type": "image/jpeg" }, "verified_asset_mime_mismatch"],
      [png, { width: 2, height: 2 }, {}, "verified_asset_dimensions_mismatch"],
      [png, { byteSize: png.length + 1 }, {}, "verified_asset_size_mismatch"],
      [Buffer.from('{"decoder":"sharp-full-decode-v1","verifiedBy":"server"}'), {}, {}, "verified_asset_mime_mismatch"],
      [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), { mimeType: "image/svg+xml" }, { "content-type": "image/svg+xml" }, "verified_asset_mime_mismatch"],
    ];
    for (const [body, extra, headers, error] of cases) {
      registered.set("source-1", asset(body, extra));
      const response = await upload(url, body, "source-1", headers);
      expect(response.status).toBe(error === "verified_asset_headers_invalid" ? 400 : 422);
      expect(await response.json()).toEqual({ error });
      expect(store.verifiedImageBytes("tenant-a", "project-a")).toBe(0);
    }
  });

  it("能读出尺寸但像素已截断的 PNG 仍拒绝，不能仅通过 metadata 核验", async () => {
    const body = png.subarray(0, 45);
    const { verified, registered, store } = setup(); registered.set("source-1", asset(body));
    const response = await upload(await listen(verified), body);
    expect(response.status).toBe(422); expect(await response.json()).toEqual({ error: "verified_asset_decode_failed" });
    expect(store.verifiedImageBytes("tenant-a", "project-a")).toBe(0);
  });

  it("支持静态 JPEG/WebP/GIF/AVIF，EXIF 方向由完整解码后的真实尺寸决定", async () => {
    const { verified, registered } = setup(); const url = await listen(verified);
    for (const [format, mime] of [["jpeg", "image/jpeg"], ["webp", "image/webp"], ["gif", "image/gif"], ["avif", "image/avif"]]) {
      const body = await sharp({ create: { width: 2, height: 3, channels: 4, background: "#ffaa00" } }).toFormat(format).toBuffer();
      registered.set(format, asset(body, { id: format, mimeType: mime }));
      const response = await upload(url, body, format, { "content-type": mime });
      expect(response.status).toBe(200);
      expect((await response.json()).asset).toMatchObject({ width: 2, height: 3, mimeType: mime });
    }
    const rotated = await sharp({ create: { width: 2, height: 3, channels: 3, background: "#ff0000" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    registered.set("rotated", asset(rotated, { id: "rotated", width: 3, height: 2, mimeType: "image/jpeg" }));
    expect((await (await upload(url, rotated, "rotated", { "content-type": "image/jpeg" })).json()).asset).toMatchObject({ width: 3, height: 2 });
  });

  it("拒绝动态图，包括可能只解码首帧的 APNG", async () => {
    const animated = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } }).gif({ delay: [100, 100] }).toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    const { verified, registered } = setup(); const url = await listen(verified);
    registered.set("source-1", asset(animated, { mimeType: "image/gif" }));
    expect(await (await upload(url, animated, "source-1", { "content-type": "image/gif" })).json()).toEqual({ error: "verified_asset_animated" });
    // Insert an animation-control chunk after IHDR. Even an invalid control CRC
    // must not let a first-frame-only decoder silently accept this container.
    const control = Buffer.from("000000086163544c000000020000000000000000", "hex");
    const apng = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]);
    registered.set("source-1", asset(apng));
    expect(await (await upload(url, apng)).json()).toEqual({ error: "verified_asset_animated" });
  });

  it("限制原文件大小、像素、边长和项目镜像容量", async () => {
    const { verified, registered, store } = setup(); const url = await listen(verified);
    registered.set("source-1", asset(png, { byteSize: MAX_VERIFIED_IMAGE_BYTES + 1 }));
    expect((await upload(url)).status).toBe(413);
    const wide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: "black" } }).png().toBuffer();
    registered.set("source-1", asset(wide));
    expect(await (await upload(url, wide)).json()).toEqual({ error: "verified_asset_dimensions_exceeded" });
    const huge = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: "black" } }).png().toBuffer();
    registered.set("source-1", asset(huge));
    expect((await upload(url, huge)).status).toBe(422);
    expect(store.verifiedImageBytes("tenant-a", "project-a")).toBe(0);
    const limited = setup({ quota: png.length - 1 });
    const response = await upload(await listen(limited.verified));
    expect(response.status).toBe(413); expect(await response.json()).toEqual({ error: "verified_asset_project_quota" });
    expect(limited.store.verifiedImageBytes("tenant-a", "project-a")).toBe(0);
  });

  it("蒙版必须是透明通道 PNG，绑定已验证底图的尺寸和内容摘要", async () => {
    const { verified, registered } = setup(); const url = await listen(verified);
    registered.set("mask-1", asset(png, { id: "mask-1", purpose: "mask", sourceAssetId: "source-1" }));
    expect(await (await upload(url, png, "mask-1")).json()).toEqual({ error: "run_asset_not_verified" });
    expect((await upload(url)).status).toBe(200);
    const mask = await (await upload(url, png, "mask-1")).json() as VerifiedImage;
    expect(mask.sourceChecksumSha256).toBe(checksum(png));
    expect(verified.requireImage("tenant-a", "project-a", "mask-1")).toEqual(mask);
    const opaque = await sharp(png).removeAlpha().png().toBuffer();
    registered.set("opaque", asset(opaque, { id: "opaque", purpose: "mask", sourceAssetId: "source-1" }));
    expect(await (await upload(url, opaque, "opaque")).json()).toEqual({ error: "verified_mask_source_invalid" });
    const large = await sharp(png).resize(2, 2).png().toBuffer();
    registered.set("wrong-size", asset(large, { id: "wrong-size", purpose: "mask", sourceAssetId: "source-1" }));
    expect(await (await upload(url, large, "wrong-size")).json()).toEqual({ error: "verified_mask_source_invalid" });
    registered.set("recursive", asset(png, { id: "recursive", purpose: "mask", sourceAssetId: "mask-1" }));
    expect(await (await upload(url, png, "recursive")).json()).toEqual({ error: "verified_mask_source_invalid" });
    registered.set("source-1", asset(png, { originalName: "changed.png" }));
    expect(await (await read(url, "mask-1")).json()).toEqual({ error: "verified_mask_source_invalid" });
  });

  it("不可覆盖已验证编号，登记元数据变化后不能继续使用旧证明", async () => {
    const { verified, registered, store } = setup(); const url = await listen(verified);
    expect((await upload(url)).status).toBe(200);
    const different = await sharp(png).negate().png().toBuffer();
    registered.set("source-1", asset(different));
    expect((await upload(url, different)).status).toBe(409);
    expect(await (await read(url)).json()).toEqual({ error: "verified_asset_metadata_changed" });
    expect(store.verifiedImageBytes("tenant-a", "project-a")).toBe(png.length);
  });

  it.each(["body", "record"])("%s 损坏时拒绝读取与新任务，不从客户端声明或旧文件恢复", async (field) => {
    const { verified, path, kernel } = setup(); const url = await listen(verified);
    expect((await upload(url)).status).toBe(200);
    const db = new DatabaseSync(path);
    try {
      if (field === "body") db.prepare("UPDATE verified_images SET body = ?").run(Buffer.alloc(png.length));
      else db.exec("UPDATE verified_images SET record = '{}' ");
    }
    finally { db.close(); }
    const response = await read(url);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "run_state_unavailable" });
    expect(() => kernel.createBatch(principal, batchRequest)).toThrow(/数据库/);
    expect(kernel.getBudget(principal, "project-a")).toMatchObject({ spentMinor: 0, reservedMinor: 0 });
    expect(kernel.listBatches(principal, "project-a")).toEqual([]);
  });

  it("原文件丢失或变化时拒绝确认、领取和实际开始，不创建供应商请求", async () => {
    const { verified, path, kernel, registered } = setup(); const url = await listen(verified);
    await upload(url);
    const draft = kernel.createBatch(principal, batchRequest);
    const original = registered.get("source-1")!;
    registered.delete("source-1");
    expect(() => kernel.confirmBatch(principal, draft.batch.id, { expectedEstimatedCostMinor: 25, expectedCurrency: "CNY" })).toThrow();
    expect(kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
    registered.set("source-1", original);
    kernel.confirmBatch(principal, draft.batch.id, { expectedEstimatedCostMinor: 25, expectedCurrency: "CNY" });
    registered.delete("source-1");
    expect(() => kernel.claimBatch(principal, draft.batch.id, { workerId: "worker-a", maxJobs: 1 })).toThrow();
    expect(kernel.getBatch(principal, draft.batch.id).jobs[0].status).toBe("queued");
    registered.set("source-1", original);
    const [lease] = kernel.claimBatch(principal, draft.batch.id, { workerId: "worker-a", maxJobs: 1 }).leases;
    const db = new DatabaseSync(path); try { db.exec("DELETE FROM verified_images"); } finally { db.close(); }
    expect(() => kernel.executeLeasedJob(principal, lease.jobId, { workerId: lease.workerId, leaseId: lease.leaseId })).toThrow(/校验/);
    const blocked = kernel.getBatch(principal, draft.batch.id);
    expect(blocked.jobs[0]).toMatchObject({ status: "leased" });
    expect(blocked.jobs[0].providerRequestId).toBeUndefined();
    expect(blocked.audit.filter((event) => event.eventType === "job-started")).toHaveLength(0);
    expect(kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 25, spentMinor: 0 });
    expect(kernel.cancelBatch(principal, draft.batch.id).batch.status).toBe("cancelled");
    expect(kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
  });

  it("原文件与证明提交中断时整体回滚，重新上传可以安全恢复", async () => {
    const { verified, store } = setup(); const url = await listen(verified);
    const save = store.saveVerifiedImage.bind(store);
    store.saveVerifiedImage = (record, body) => { save(record, body); throw new Error("injected commit fault"); };
    expect((await upload(url)).status).toBe(503);
    expect(store.loadVerifiedImage("tenant-a", "project-a", "source-1")).toBeNull();
    expect(store.verifiedImageBytes("tenant-a", "project-a")).toBe(0);
    store.saveVerifiedImage = save;
    expect((await upload(url)).status).toBe(200);
  });

  it("数据库 v1 升级不会把已有元数据转换成已验证图片", () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-image-migration-")); directories.push(dir); const path = join(dir, "state.sqlite");
    const db = new DatabaseSync(path); db.exec("PRAGMA user_version = 1"); db.close();
    const { store, kernel } = setup({ path });
    expect(store.loadVerifiedImage("tenant-a", "project-a", "source-1")).toBeNull();
    expect(() => kernel.createBatch(principal, batchRequest)).toThrow(/校验/);
    expect(kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
  });
});
