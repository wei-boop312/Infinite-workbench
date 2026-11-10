import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmImagePreparationSchema, ImageProviderConnectionSchema, VerifiedImageSchema,
  type Asset, type ConstraintSnapshot, type ImageProviderConnection } from "../packages/contracts/src/index";
import { LocalImageProviders } from "../apps/api/src/imageProviders";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { createApiServer } from "../apps/api/src/index";
import { assetMetadataFingerprint } from "../apps/api/src/verifiedAssets";
import { prepareOpenAiImageRequest } from "../apps/api/src/openaiImageProtocol";
import { prepareCompatibleImageRequest } from "../apps/api/src/compatibleImageProtocol";
import { prepareGoogleImageRequest } from "../apps/api/src/googleImageProtocol";
import { imageSnapshotFingerprint } from "../apps/api/src/imageProviderContract";
import { withStaticImageDecodeSlot } from "../apps/api/src/staticImageDecoder";

const at = "2026-10-03T17:20:00.000Z";
const principal = { tenantId: "tenant-a", actorId: "writer" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const directories: string[] = [], stores: SqliteRunKernelStateStore[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function connection(extra: Partial<ImageProviderConnection> = {}): ImageProviderConnection {
  return ImageProviderConnectionSchema.parse({ schemaVersion: 1, id: "fixture-provider", tenantId: principal.tenantId, projectId: "project-a", name: "本地零费用确认夹具",
    revision: 1, protocol: "openai", adapterId: "fixture-image-v1", baseUrl: "https://never-called.invalid/v1", credentialRef: "opaque-never-resolved",
    enabled: true, diagnostic: { state: "not-run" }, models: [{ model: "explicit-fixture-model", version: "caps-fixture-v1", operations: ["generate", "edit"], inputMimeTypes: ["image/png"],
      outputFormats: ["png"], maxInputImages: 20, maxPromptCharacters: 32000, maxInputEdge: 8192, maxInputPixels: 16000000, maxInputBytes: 30 * 1024 * 1024, maxTotalInputBytes: 100 * 1024 * 1024,
      sizes: { allowAuto: true, presets: [{ width: 1024, height: 1024 }] }, qualities: ["auto"], backgrounds: ["auto"], inputFidelities: [],
      supportsOutputCompression: false, mask: { mode: "none", polarity: "unsupported" }, evidence: { state: "declared" } }], ...extra });
}
function constraint(format: "png" | "jpeg" = "png"): ConstraintSnapshot {
  return { id: "constraint-a", projectId: "project-a", lockedPaths: [], editableRegions: [], brandRules: { style: "人工冻结版式" },
    outputSpec: { width: 1024, height: 1024, format }, createdAt: at };
}
function selection(extra: Record<string, unknown> = {}) {
  return { projectId: "project-a", idempotencyKey: "human-action-a", connectionId: "fixture-provider", connectionRevision: 1, model: "explicit-fixture-model", capabilityVersion: "caps-fixture-v1",
    constraintSnapshotId: "constraint-a", protection: "none", operation: "generate", inputAssetIds: [],
    parameters: { prompt: "人工指定构图", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", background: "auto", outputFormat: "png" }, ...extra };
}
function setup(options: { path?: string; limit?: number; format?: "png" | "jpeg"; quota?: number } = {}) {
  const directory = options.path ? undefined : mkdtempSync(join(tmpdir(), "canvas-image-confirm-")); if (directory) directories.push(directory);
  const path = options.path ?? join(directory!, "state.sqlite");
  const store = new SqliteRunKernelStateStore(path); stores.push(store);
  if (!store.loadCatalog()) store.transaction(() => store.saveCatalog({ schemaVersion: 1, projects: [{ projectId: "project-a", assets: [], constraints: [constraint(options.format)] }] }));
  let now = Date.parse(at), runAllowed = true, assetAllowed = true, readOnly = false;
  const scope = (actor: typeof principal, id: string) => actor.tenantId === principal.tenantId && actor.actorId === "writer" && id === "project-a";
  const authenticate = (request: { headers: { authorization?: string } }) => request.headers.authorization === "Bearer writer" ? principal : null;
  const runAuthorizer = { authenticate, allows: (actor: typeof principal, id: string, permission: string) => runAllowed && scope(actor, id) && (!readOnly || permission === "run:read") };
  const assetAuthorizer = { authenticate, allows: (actor: typeof principal, id: string) => assetAllowed && scope(actor, id) };
  const authorizer = { authenticate, allows: scope };
  const kernel = new SqliteRunKernel({ stateStore: store, authorizer: runAuthorizer, budgets: [{ tenantId: principal.tenantId, projectId: "project-a", currency: "CNY", limitMinor: options.limit ?? 1000 }], clock: () => now });
  const estimate = vi.fn((_config: unknown, _input: unknown, time: string) => ({ mode: "local-fixture" as const, evidenceRef: "no-real-price-or-call",
    quote: { id: "fixture-quote", version: "price-fixture-v1", source: "server-price-table" as const, currency: "CNY", estimatedCostMinor: 25, maxCostMinor: 30, expiresAt: new Date(Date.parse(time) + 60_000).toISOString() } }));
  const service = new LocalImageProviders({ tenantId: principal.tenantId, stateStore: store, authorizer, assetAuthorizer, runAuthorizer, runKernel: kernel, estimate, maxMetadataBytes: options.quota, clock: () => now });
  return { store, path, kernel, service, estimate, advance: (ms: number) => { now += ms; }, revokeRun: () => { runAllowed = false; }, revokeAsset: () => { assetAllowed = false; }, restrictToReadOnly: () => { readOnly = true; } };
}
function register(fixture: ReturnType<typeof setup>, config = connection()) { fixture.service.registerRevision(principal, config, config.revision - 1); }
function preparation(fixture: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) { return fixture.service.createPreparation(principal, selection(extra)); }
type Preparation = ReturnType<typeof preparation>;
function ack(prepared: Preparation) { return { expectedSnapshotFingerprint: prepared.snapshotFingerprint, expectedEstimatedCostMinor: prepared.pricing.quote.estimatedCostMinor,
  expectedMaxCostMinor: prepared.pricing.quote.maxCostMinor, expectedCurrency: prepared.pricing.quote.currency }; }
const confirm = (fixture: ReturnType<typeof setup>, prepared: Preparation, extra: Record<string, unknown> = {}) => fixture.service.confirmPreparation(principal, "project-a", prepared.id, { ...ack(prepared), ...extra });
function source(fixture: ReturnType<typeof setup>, id = "source", body = png) {
  const asset: Asset = { id, projectId: "project-a", kind: "image", purpose: "source", originalName: `${id}.png`, storageKey: `local-verified:${id}`,
    mimeType: "image/png", byteSize: body.length, width: 1, height: 1, contentFingerprint: `sha256:${sha(body)}`, createdAt: at };
  const receipt = VerifiedImageSchema.parse({ schemaVersion: 1, id: `proof-${id}`, tenantId: principal.tenantId, asset, checksumSha256: sha(body),
    registeredMetadataSha256: assetMetadataFingerprint(asset), decoder: "sharp-full-decode-v1", verifiedAt: at, verifiedBy: "trusted-fixture" });
  fixture.store.transaction(() => { fixture.store.saveVerifiedImage(receipt, body); const catalog = fixture.store.loadCatalog()!; catalog.projects[0].assets.push(asset); fixture.store.saveCatalog(catalog); });
  return { receipt, body };
}
const rejectCode = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });
const untouched = (fixture: ReturnType<typeof setup>) => { expect(fixture.store.load()?.batches).toHaveLength(0); expect(fixture.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 0 }); };

describe("本地图片确认与统一预算/任务原子绑定（尚不执行）", () => {
  it("公开人工约束与输入从不可变准备单恢复，而不是当前目录；不泄漏连接秘密", () => {
    const fixture = setup(); register(fixture); source(fixture);
    const prepared = preparation(fixture, { operation: "edit", inputAssetIds: ["source"] });
    expect(prepared.constraint).toEqual(constraint()); expect(prepared.requestTemplate.inputs[0]).toMatchObject({ assetId: "source", checksumSha256: sha(png), byteSize: png.length, width: 1, height: 1 });
    fixture.store.transaction(() => { const catalog = fixture.store.loadCatalog()!; catalog.projects[0].constraints[0].brandRules.style = "后来修改"; fixture.store.saveCatalog(catalog); });
    expect(fixture.service.getPreparation(principal, "project-a", prepared.id)).toEqual(prepared);
    expect(JSON.stringify(prepared)).not.toMatch(/never-called|opaque-never-resolved|baseUrl|credentialRef/); untouched(fixture);
  });
  it("只读确认恢复未确认/已确认/已取消历史，既不确认也不再次预留；撤权及跨范围拒绝", async () => {
    const fixture = setup(); register(fixture); const prepared = preparation(fixture), before = fixture.store.load();
    expect(fixture.service.getConfirmation(principal, "project-a", prepared.id).confirmation).toBeNull(); expect(fixture.store.load()).toEqual(before);
    const confirmed = await confirm(fixture, prepared); fixture.advance(61_000); register(fixture, connection({ revision: 2, enabled: false }));
    const snapshot = fixture.store.load(); expect(fixture.service.getConfirmation(principal, "project-a", prepared.id).confirmation).toEqual(confirmed); expect(fixture.store.load()).toEqual(snapshot);
    fixture.kernel.cancelBatch(principal, confirmed.aggregate.batch.id); const cancelled = fixture.store.load();
    expect(fixture.service.getConfirmation(principal, "project-a", prepared.id).confirmation?.aggregate.batch.status).toBe("cancelled"); expect(fixture.store.load()).toEqual(cancelled);
    const missing = vi.spyOn(fixture.store, "load").mockReturnValue(null);
    expect(() => fixture.service.getConfirmation(principal, "project-a", prepared.id)).toThrow(expect.objectContaining({ code: "run_state_unavailable" })); missing.mockRestore();
    fixture.restrictToReadOnly(); expect(fixture.service.getConfirmation(principal, "project-a", prepared.id).confirmation?.aggregate.batch.status).toBe("cancelled");
    await rejectCode(confirm(fixture, prepared), "image_confirmation_permission_denied"); expect(fixture.store.load()).toEqual(cancelled);
    expect(() => fixture.service.getConfirmation({ ...principal, tenantId: "foreign" }, "project-a", prepared.id)).toThrow();
    expect(() => fixture.service.getConfirmation(principal, "foreign", prepared.id)).toThrow();
    fixture.revokeRun(); expect(() => fixture.service.getConfirmation(principal, "project-a", prepared.id)).toThrow(); expect(fixture.store.load()).toEqual(cancelled);
  });
  it("只读HTTP确认恢复要求认证且拒绝查询/范围/正文/POST，不改变预算或任务", async () => {
    const fixture = setup(); register(fixture); const prepared = preparation(fixture);
    const server = createApiServer({ imageProviders: fixture.service }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error();
    const path = `http://127.0.0.1:${address.port}/v1/projects/project-a/image-preparations/${prepared.id}/confirmation`;
    expect((await fetch(path)).status).toBe(401);
    const good = await fetch(path, { headers: { authorization: "Bearer writer" } }); expect(good.headers.get("cache-control")).toBe("no-store"); expect((await good.json()).confirmation).toBeNull();
    expect((await fetch(path + "?pretend=confirmed", { headers: { authorization: "Bearer writer" } })).status).toBe(400);
    expect((await fetch(path, { headers: { authorization: "Bearer writer", range: "bytes=0-1" } })).status).toBe(400);
    expect((await fetch(path, { method: "POST", headers: { authorization: "Bearer writer" }, body: "{}" })).status).toBe(404); untouched(fixture);
  });
  it("完整摘要/估价/上限/币种确认，冻结实际任务请求及协议摘要而非准备单摘要", async () => {
    const fixture = setup(); register(fixture); const prepared = preparation(fixture);
    const result = await confirm(fixture, prepared);
    expect(result).toMatchObject({ mode: "local-fixture", realExecutionEnabled: false, executionAuthorized: false, executionState: "confirmed-not-dispatchable", protocolPreparation: "prepared" });
    expect(result.aggregate.batch).toMatchObject({ tool: "image-generate", status: "queued", estimatedCostMinor: 25, maxCostMinor: 30, confirmedBy: "writer", confirmedAt: at });
    expect(result.aggregate.jobs).toHaveLength(1); expect(result.aggregate.jobs[0]).toMatchObject({ executorKind: "provider", status: "queued", outputAssetIds: [] });
    expect(fixture.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 30, spentMinor: 0, availableMinor: 970 });
    const stored = fixture.store.load()!.batches[0]; const snapshot = stored.imageExecution!;
    expect(snapshot.request.jobId).toBe(result.aggregate.jobs[0].id); expect(snapshot.request.idempotencyKey).toBe(result.aggregate.jobs[0].idempotencyKey);
    expect(snapshot.protocolVersion).toBe("pure-image-protocol-v1"); expect(stored.requestFingerprint).toBe(imageSnapshotFingerprint(snapshot));
    const wire = await prepareOpenAiImageRequest(snapshot.preparation.connection, snapshot.request, [], at);
    expect(snapshot.payloadChecksumSha256).toBe(sha(wire.body)); expect(snapshot.payloadByteSize).toBe(wire.body.length);
    expect(result.requestFingerprint).toBe(wire.requestFingerprint); expect(result.requestFingerprint).not.toBe(prepared.snapshotFingerprint);
    const text = JSON.stringify(result); expect(text).not.toContain(connection().baseUrl); expect(text).not.toContain(connection().credentialRef);
    expect(fixture.estimate).toHaveBeenCalledTimes(1); expect(fixture.service.getPreparation(principal, "project-a", prepared.id).executionAuthorized).toBe(false);
  });
  it("逐项确认错配被拒绝，无预留/任务；客户端不能自报任务/确认时间/发送摘要", async () => {
    const fixture = setup(); register(fixture); const prepared = preparation(fixture);
    for (const extra of [{ expectedSnapshotFingerprint: "a".repeat(64) }, { expectedEstimatedCostMinor: 0 }, { expectedMaxCostMinor: 25 }, { expectedCurrency: "USD" }]) await rejectCode(confirm(fixture, prepared, extra), "image_confirmation_snapshot_mismatch");
    for (const extra of [{ confirmedAt: at }, { jobId: "client-job" }, { payloadChecksumSha256: "a".repeat(64) }, { executionAuthorized: true }, { apiKey: "not-a-real-key" }]) expect(ConfirmImagePreparationSchema.safeParse({ ...ack(prepared), ...extra }).success).toBe(false);
    untouched(fixture);
  });
  it("重复/重启/过期后的确认恢复同一历史任务；取消后不会重新预留", async () => {
    const fixture = setup(); register(fixture); const prepared = preparation(fixture); const first = await confirm(fixture, prepared);
    expect(await confirm(fixture, prepared)).toEqual(first);
    const restarted = setup({ path: fixture.path }); restarted.advance(61_000); expect(await confirm(restarted, prepared)).toEqual(first);
    restarted.kernel.cancelBatch(principal, first.aggregate.batch.id); const cancelled = await confirm(restarted, prepared);
    expect(cancelled.aggregate.batch.status).toBe("cancelled"); expect(cancelled.aggregate.jobs[0].id).toBe(first.aggregate.jobs[0].id);
    expect(restarted.kernel.getBudget(principal, "project-a").reservedMinor).toBe(0); expect(restarted.store.load()?.batches).toHaveLength(1);
    await rejectCode(confirm(restarted, prepared, { expectedMaxCostMinor: 29 }), "image_confirmation_snapshot_mismatch");
  });
  it("两个数据库连接同时确认同一准备单，只形成一次任务和一次预留", async () => {
    const a = setup(); register(a); const prepared = preparation(a); const b = setup({ path: a.path });
    const [left, right] = await Promise.all([confirm(a, prepared), confirm(b, prepared)]);
    expect(left).toEqual(right); expect(a.store.load()?.batches).toHaveLength(1); expect(b.kernel.getBudget(principal, "project-a").reservedMinor).toBe(30);
  });
  it("并发不同准备单不能透支，预算按照上限而非估价判断", async () => {
    const a = setup({ limit: 40 }); register(a); const first = preparation(a); const second = preparation(a, { idempotencyKey: "second-human-action" }); const b = setup({ path: a.path, limit: 40 });
    const results = await Promise.allSettled([confirm(a, first), confirm(b, second)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "project_budget_exceeded" } });
    expect(a.store.load()?.batches).toHaveLength(1); expect(a.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 30, availableMinor: 10 });
    const insufficient = setup({ limit: 25 }); register(insufficient); await rejectCode(confirm(insufficient, preparation(insufficient)), "project_budget_exceeded"); untouched(insufficient);
  });
  it("确认前目录修订/停用或报价过期要求新动作，不能沿用历史准备单", async () => {
    const fixture = setup(); register(fixture); const prepared = preparation(fixture); register(fixture, connection({ revision: 2, enabled: false }));
    await rejectCode(confirm(fixture, prepared), "image_connection_changed"); untouched(fixture);
    const expired = setup(); register(expired); const old = preparation(expired); expired.advance(60_000);
    await rejectCode(confirm(expired, old), "image_quote_expired"); untouched(expired);
  });
  it("异步协议准备期间目录漂移、权限撤销和报价到期均重新检查", async () => {
    const drift = setup(); register(drift); const pending = confirm(drift, preparation(drift)); register(drift, connection({ revision: 2 }));
    await rejectCode(pending, "image_connection_changed"); untouched(drift);
    const denied = setup(); register(denied); const revoked = confirm(denied, preparation(denied)); denied.revokeRun(); await rejectCode(revoked, "image_confirmation_permission_denied"); expect(denied.store.load()?.batches).toHaveLength(0);
    const expired = setup(); register(expired); const delayed = confirm(expired, preparation(expired)); expired.advance(60_001); await rejectCode(delayed, "image_quote_expired"); untouched(expired);
  });
  it("约束漂移以及商品像素锁在确认前/后都不被放松", async () => {
    const fixture = setup(); register(fixture); const prepared = preparation(fixture); const pending = confirm(fixture, prepared);
    fixture.store.transaction(() => { const catalog = fixture.store.loadCatalog()!; catalog.projects[0].constraints[0].lockedPaths = ["product.pixels"]; fixture.store.saveCatalog(catalog); });
    await rejectCode(pending, "image_output_constraint_changed"); untouched(fixture);
  });
  it("编辑输入完整解码/转换，冻结传输谱系并重查资产权限", async () => {
    const fixture = setup(); register(fixture); const image = source(fixture); const prepared = preparation(fixture, { operation: "edit", inputAssetIds: ["source"] });
    const result = await confirm(fixture, prepared); expect(result.aggregate.batch.tool).toBe("image-edit");
    expect(result.transformedInputs).toEqual([expect.objectContaining({ assetId: "source", originalChecksumSha256: sha(png), transform: "exif-srgb-png-v1" })]);
    const snapshot = fixture.store.load()!.batches[0].imageExecution!; const wire = await prepareOpenAiImageRequest(snapshot.preparation.connection, snapshot.request, [image], at);
    expect(snapshot.payloadChecksumSha256).toBe(sha(wire.body));
    const denied = setup(); register(denied); source(denied); const second = preparation(denied, { operation: "edit", inputAssetIds: ["source"] }); const pending = confirm(denied, second); denied.revokeAsset();
    await rejectCode(pending, "image_confirmation_permission_denied"); untouched(denied);
  });
  it("协议准备期间原图登记内容发生漂移，不能沿用先前读到的字节", async () => {
    const fixture = setup(); register(fixture); source(fixture); const prepared = preparation(fixture, { operation: "edit", inputAssetIds: ["source"] }); const pending = confirm(fixture, prepared);
    fixture.store.transaction(() => { const catalog = fixture.store.loadCatalog()!; catalog.projects[0].assets[0].originalName = "changed.png"; fixture.store.saveCatalog(catalog); });
    await rejectCode(pending, "image_input_not_verified"); untouched(fixture);
  });
  it("同进程最多同时准备两份确认，第三份失败关闭且可用原动作恢复", async () => {
    const fixture = setup(); register(fixture);
    const first = preparation(fixture), second = preparation(fixture, { idempotencyKey: "second-action" }), third = preparation(fixture, { idempotencyKey: "third-action" });
    const pendingA = confirm(fixture, first), pendingB = confirm(fixture, second);
    await rejectCode(confirm(fixture, third), "image_confirmation_capacity"); await Promise.all([pendingA, pendingB]);
    expect(fixture.store.load()?.batches).toHaveLength(2); await confirm(fixture, third); expect(fixture.kernel.getBudget(principal, "project-a").reservedMinor).toBe(90);
  });
  it("协议输入归一化与原图/输出验证共用两个解码槽，繁忙不占预算", async () => {
    const fixture = setup(); register(fixture); source(fixture); const prepared = preparation(fixture, { operation: "edit", inputAssetIds: ["source"] });
    let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
    const occupied = [withStaticImageDecodeSlot(() => barrier), withStaticImageDecodeSlot(() => barrier)];
    try { await rejectCode(confirm(fixture, prepared), "verified_asset_busy"); untouched(fixture); }
    finally { release(); await Promise.all(occupied); }
    expect((await confirm(fixture, prepared)).transformedInputs).toHaveLength(1);
  });
  it("执行快照与目录/准备单共享元数据额度，超限不删除历史也不占预算", async () => {
    const fixture = setup(); register(fixture); const prepared = preparation(fixture);
    const quota = fixture.store.imageMetadataBytes(principal.tenantId, "project-a") + 1;
    const capped = setup({ path: fixture.path, quota }); await rejectCode(confirm(capped, prepared), "image_metadata_quota"); untouched(capped);
    expect(capped.service.getPreparation(principal, "project-a", prepared.id)).toEqual(prepared);
  });
  it("拒绝把目录和任务内核接到不同数据库事务，防止分裂提交", () => {
    const directory = setup(), other = setup();
    expect(() => new LocalImageProviders({ tenantId: principal.tenantId, stateStore: directory.store, runKernel: other.kernel,
      authorizer: { authenticate: () => principal, allows: () => true }, runAuthorizer: { authenticate: () => principal, allows: () => true },
      assetAuthorizer: { authenticate: () => principal, allows: () => true }, estimate: directory.estimate })).toThrow("同一事务存储实例");
    untouched(directory); untouched(other);
  });
  it("不同项目/租户/没有确认权限不能创建或恢复授权证据", async () => {
    const fixture = setup(); register(fixture); const prepared = preparation(fixture);
    await rejectCode(fixture.service.confirmPreparation({ ...principal, tenantId: "tenant-b" }, "project-a", prepared.id, ack(prepared)), "image_connection_not_found");
    await rejectCode(fixture.service.confirmPreparation(principal, "project-b", prepared.id, ack(prepared)), "image_connection_not_found");
    await rejectCode(fixture.service.confirmPreparation({ ...principal, actorId: "reader" }, "project-a", prepared.id, ack(prepared)), "image_connection_not_found");
    untouched(fixture); fixture.revokeRun(); await rejectCode(confirm(fixture, prepared), "image_confirmation_permission_denied"); expect(fixture.store.load()?.batches).toHaveLength(0);
  });
  it("仅有伪完整验证收据的坏原图在协议解码时被拒绝，不创建任务/预留", async () => {
    const fixture = setup(); register(fixture); source(fixture, "truncated", png.subarray(0, 41));
    const prepared = preparation(fixture, { operation: "edit", inputAssetIds: ["truncated"] }); await rejectCode(confirm(fixture, prepared), "image_input_decode_failed"); untouched(fixture);
  });
  it("官方协议输入数量边界在确认提交前拦截，准备单不能充当协议已准备", async () => {
    const fixture = setup(); register(fixture); const ids = Array.from({ length: 17 }, (_, i) => `source-${i}`); ids.forEach((id) => source(fixture, id));
    const prepared = preparation(fixture, { operation: "edit", inputAssetIds: ids }); await rejectCode(confirm(fixture, prepared), "image_input_count_exceeded"); untouched(fixture);
  });
  it("兼容中转 multipart 使用实际任务指纹构造边界，不复用准备单摘要", async () => {
    const fixture = setup(); const config = connection({ protocol: "openai-compatible", compatibility: { version: "profile-v1", endpoints: { generate: "/images/generations", edit: "/images/edits" },
      auth: { scheme: "header", headerName: "x-api-key" }, editEncoding: "multipart-image-single", responseEncoding: "images-b64-json-v1", extraParameters: [] } });
    register(fixture, config); const image = source(fixture); const result = await confirm(fixture, preparation(fixture, { operation: "edit", inputAssetIds: ["source"] }));
    const snapshot = fixture.store.load()!.batches[0].imageExecution!; const wire = await prepareCompatibleImageRequest(config, snapshot.request, [image], at);
    expect(snapshot.contentType).toBe(`multipart/form-data; boundary=canvas-${result.requestFingerprint.slice(0, 40)}`);
    expect(snapshot.payloadChecksumSha256).toBe(sha(wire.body)); expect(snapshot.transformedInputs).toEqual(wire.transformedInputs);
  });
  it("Google 原生明确 JPEG/v1 合同可冻结，不伪装为 OpenAI", async () => {
    const fixture = setup({ format: "jpeg" }); const base = connection(); const config = connection({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com",
      googleNative: { version: "google-profile-v1", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: "explicit-fixture-model", sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] },
      models: [{ ...base.models[0], maxInputImages: 3, outputFormats: ["jpeg"] }] });
    register(fixture, config); const input = selection(); const result = await confirm(fixture, preparation(fixture, { parameters: { ...input.parameters, outputFormat: "jpeg" } }));
    const snapshot = fixture.store.load()!.batches[0].imageExecution!; const wire = await prepareGoogleImageRequest(config, snapshot.request, [], at);
    expect(result.payloadChecksumSha256).toBe(sha(wire.body)); expect(JSON.parse(wire.body.toString()).generationConfig.responseFormat.image.mimeType).toBe("IMAGE_JPEG");
  });
  it("写入后故障与确认回读故障整笔回滚预算/任务/执行快照，原准备单保留", async () => {
    for (const failure of ["save", "read"] as const) {
      const fixture = setup(); register(fixture); const prepared = preparation(fixture); const before = fixture.store.load();
      const original = fixture.store.save.bind(fixture.store);
      const spy = failure === "save" ? vi.spyOn(fixture.store, "save").mockImplementation((snapshot) => { original(snapshot); throw new Error("fixture after write"); })
        : vi.spyOn(fixture.kernel, "getBatch").mockImplementation(() => { throw new Error("fixture response failure"); });
      await rejectCode(confirm(fixture, prepared), "run_state_unavailable"); spy.mockRestore();
      expect(fixture.store.load()).toEqual(before); expect(fixture.service.getPreparation(principal, "project-a", prepared.id)).toEqual(prepared); untouched(fixture);
      expect((await confirm(fixture, prepared)).aggregate.jobs).toHaveLength(1);
    }
  });
  it("新任务不能走旧确认/租约/执行/超时/重试入口自动结算", async () => {
    const fixture = setup(); register(fixture); const result = await confirm(fixture, preparation(fixture)); const batchId = result.aggregate.batch.id, jobId = result.aggregate.jobs[0].id;
    const actions = [() => fixture.kernel.confirmBatch(principal, batchId, { expectedEstimatedCostMinor: 25, expectedCurrency: "CNY" }),
      () => fixture.kernel.claimBatch(principal, batchId, { workerId: "mock-worker", maxJobs: 1 }), () => fixture.kernel.dispatchBatch(principal, batchId),
      () => fixture.kernel.executeLeasedJob(principal, jobId, { workerId: "mock-worker", leaseId: "fake-lease" }), () => fixture.kernel.reconcileBatch(principal, batchId),
      () => fixture.kernel.retryJob(principal, jobId, { expectedEstimatedCostMinor: 25, expectedCurrency: "CNY", mockScenario: "success" })];
    for (const action of actions) expect(action).toThrow(expect.objectContaining({ code: "image_execution_not_configured" }));
    expect(fixture.kernel.getBatch(principal, batchId)).toEqual(result.aggregate); expect(fixture.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 30, spentMinor: 0 });
  });
  it("保留旧 mock 未知扣费/配置指纹/幂等语义；新路径不改单位假价格", async () => {
    const fixture = setup(); register(fixture); const draft = fixture.kernel.createBatch(principal, { projectId: "project-a", constraintSnapshotId: "constraint-a", tool: "product-retouch", inputAssetIds: ["legacy-fixture"], expectedOutputs: 1, maxCostMinor: 25, currency: "CNY", idempotencyKey: "legacy-human-action", mockScenario: "billing-unknown" });
    fixture.kernel.confirmBatch(principal, draft.batch.id, { expectedEstimatedCostMinor: 25, expectedCurrency: "CNY" }); const unknown = fixture.kernel.dispatchBatch(principal, draft.batch.id);
    const before = fixture.store.load()!.batches[0]; await confirm(fixture, preparation(fixture));
    expect(fixture.kernel.getBatch(principal, draft.batch.id)).toEqual(unknown); expect(fixture.store.load()!.batches[0]).toEqual(before);
    expect(fixture.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 55, spentMinor: 0 });
    expect(() => new SqliteRunKernel({ stateStore: fixture.store, authorizer: { authenticate: () => null, allows: () => true }, budgets: [], unitEstimateMinor: 30 })).toThrow(expect.objectContaining({ code: "run_state_unavailable" }));
    expect(fixture.kernel.getBudget(principal, "project-a").reservedMinor).toBe(55);
  });
  it("重新哈希数据库仍不能绕过丢失/漂移的执行确认和关闭闸门", async () => {
    for (const mutation of ["missing", "payload", "success", "scenario"] as const) {
      const fixture = setup(); register(fixture); await confirm(fixture, preparation(fixture));
      fixture.store.transaction(() => { const state = fixture.store.load()!; const saved = state.batches[0];
        if (mutation === "missing") delete saved.imageExecution;
        if (mutation === "payload") saved.imageExecution!.payloadChecksumSha256 = "a".repeat(64);
        if (mutation === "success") saved.aggregate.jobs[0].status = "succeeded";
        if (mutation === "scenario") saved.jobScenarios.push([saved.aggregate.jobs[0].id, "success"]);
        fixture.store.save(state);
      });
      expect(() => fixture.kernel.getBudget(principal, "project-a")).toThrow(expect.objectContaining({ code: "run_state_unavailable" }));
    }
  });
  it("HTTP 确认只接收摘要与成本，不接收授权证据；真实执行仍拒绝", async () => {
    const fixture = setup(); register(fixture); const prepared = preparation(fixture); const server = createApiServer({ imageProviders: fixture.service, runKernel: fixture.kernel }); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("no loopback server");
    const url = `http://127.0.0.1:${address.port}`; const path = `/v1/projects/project-a/image-preparations/${prepared.id}/confirm`;
    const post = (body: unknown, token = "writer") => fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post(ack(prepared), "anonymous")).status).toBe(401); expect((await post({ ...ack(prepared), confirmedAt: at })).status).toBe(400);
    expect((await post({ oversized: "x".repeat(17 * 1024) })).status).toBe(413);
    const response = await post(ack(prepared)); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); const result = await response.json();
    expect(JSON.stringify(result)).not.toContain(connection().credentialRef);
    const dispatch = await fetch(`${url}/v1/run-batches/${result.aggregate.batch.id}/dispatch`, { method: "POST", headers: { authorization: "Bearer writer" } }); expect(dispatch.status).toBe(409);
    expect(await dispatch.json()).toEqual({ error: "image_execution_not_configured" });
    expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ realExecutorsEnabled: false, imageProviderMode: "catalog-preparations-staged-confirmations" });
  });
});
