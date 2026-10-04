import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateImagePreparationSchema, ImageExecutionRequestSchema, ImagePreparationRecordSchema, ImageProviderConnectionSchema, VerifiedImageSchema,
  type Asset, type ConstraintSnapshot, type ImageProviderConnection } from "../packages/contracts/src/index";
import { LocalImageProviders } from "../apps/api/src/imageProviders";
import { createApiServer } from "../apps/api/src/index";
import { assetMetadataFingerprint } from "../apps/api/src/verifiedAssets";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";

const at = "2026-10-03T16:00:00.000Z";
const principal = { tenantId: "tenant-a", actorId: "writer" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const sha = (body: Buffer | string) => createHash("sha256").update(body).digest("hex");
const directories: string[] = [];
const stores: SqliteRunKernelStateStore[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function connection(extra: Partial<ImageProviderConnection> = {}): ImageProviderConnection {
  return ImageProviderConnectionSchema.parse({ schemaVersion: 1, id: "fixture-provider", tenantId: principal.tenantId, projectId: "project-a", name: "只做本地合同测试",
    revision: 1, protocol: "openai", adapterId: "fixture-image-v1", baseUrl: "https://never-called.invalid/v1", credentialRef: "opaque-never-resolved-reference",
    enabled: true, diagnostic: { state: "not-run" }, models: [{ model: "explicit-fixture-model", version: "caps-fixture-v1", operations: ["generate", "edit"], inputMimeTypes: ["image/png"],
      outputFormats: ["png", "jpeg"], maxInputImages: 2, maxPromptCharacters: 32000, maxInputEdge: 8192, maxInputPixels: 16000000, maxInputBytes: 30 * 1024 * 1024, maxTotalInputBytes: 100 * 1024 * 1024,
      sizes: { allowAuto: true, presets: [{ width: 1024, height: 1024 }, { width: 4096, height: 4096 }] }, qualities: ["auto"], backgrounds: ["auto"], inputFidelities: [],
      supportsOutputCompression: false, mask: { mode: "prompt-guidance", polarity: "transparent-edit" }, evidence: { state: "declared" } }], ...extra });
}
function constraint(extra: Partial<ConstraintSnapshot> = {}): ConstraintSnapshot {
  return { id: "constraint-a", projectId: "project-a", lockedPaths: [], editableRegions: [], brandRules: { color: "orange", style: "人工冻结版式" },
    outputSpec: { width: 1024, height: 1024, format: "png" }, createdAt: at, ...extra };
}
function selection(extra: Record<string, unknown> = {}) {
  return { projectId: "project-a", idempotencyKey: "human-action-a", connectionId: "fixture-provider", connectionRevision: 1, model: "explicit-fixture-model", capabilityVersion: "caps-fixture-v1",
    constraintSnapshotId: "constraint-a", protection: "none", operation: "generate", inputAssetIds: [],
    parameters: { prompt: "人工指定的设计目标", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", background: "auto", outputFormat: "png" }, ...extra };
}
function setup(options: { path?: string; quota?: number; snapshot?: ConstraintSnapshot } = {}) {
  const directory = options.path ? undefined : mkdtempSync(join(tmpdir(), "canvas-provider-directory-")); if (directory) directories.push(directory);
  const path = options.path ?? join(directory!, "state.sqlite");
  const store = new SqliteRunKernelStateStore(path); stores.push(store);
  if (!store.loadCatalog()) store.transaction(() => store.saveCatalog({ schemaVersion: 1, projects: [{ projectId: "project-a", assets: [], constraints: [options.snapshot ?? constraint()] }] }));
  let allowed = true;
  let now = Date.parse(at);
  const scoped = (actor: typeof principal, projectId: string) => allowed && actor.tenantId === principal.tenantId && projectId === "project-a";
  const runAuthorizer = { authenticate: () => null, allows: (actor: typeof principal, projectId: string, permission: string) => scoped(actor, projectId) && (actor.actorId === "writer" || (actor.actorId === "reader" && permission === "run:read")) };
  const assetAuthorizer = { authenticate: () => null, allows: (actor: typeof principal, projectId: string) => scoped(actor, projectId) && actor.actorId === "writer" };
  const authorizer = { authenticate: (request: { headers: { authorization?: string } }) => request.headers.authorization === "Bearer writer" ? principal : null,
    allows: (actor: typeof principal, projectId: string, permission: string) => scoped(actor, projectId) && (actor.actorId === "writer" || (actor.actorId === "reader" && permission === "provider:read")) };
  const estimate = vi.fn((_config: unknown, _input: unknown, time: string) => ({ mode: "local-fixture" as const, evidenceRef: "no-real-price-or-call",
    quote: { id: "fixture-quote", version: "price-fixture-v1", source: "server-price-table" as const, currency: "CNY", estimatedCostMinor: 25, maxCostMinor: 30, expiresAt: new Date(Date.parse(time) + 60_000).toISOString() } }));
  const service = new LocalImageProviders({ tenantId: principal.tenantId, stateStore: store, authorizer, assetAuthorizer, runAuthorizer, estimate, maxMetadataBytes: options.quota, clock: () => now });
  const kernel = new SqliteRunKernel({ stateStore: store, authorizer: runAuthorizer, budgets: [{ tenantId: principal.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }] });
  return { path, store, service, estimate, kernel, revoke: () => { allowed = false; }, advance: (ms: number) => { now += ms; } };
}
function register(fixture: ReturnType<typeof setup>, config = connection()) { fixture.service.registerRevision(principal, config, config.revision - 1); }
// Trusted receipt fixture for the directory tests; full ingestion/decode has
// independent HTTP coverage in verified-assets.test.ts/generated-images.test.ts.
function source(fixture: ReturnType<typeof setup>, purpose: "source" | "mask" = "source") {
  const asset: Asset = { id: purpose, projectId: "project-a", kind: "image", purpose, sourceAssetId: purpose === "mask" ? "source" : undefined,
    originalName: `${purpose}.png`, storageKey: `local-verified:${purpose}`, mimeType: "image/png", byteSize: png.length, width: 1, height: 1,
    contentFingerprint: `sha256:${sha(png)}`, createdAt: at };
  const receipt = VerifiedImageSchema.parse({ schemaVersion: 1, id: `proof-${purpose}`, tenantId: principal.tenantId, asset, checksumSha256: sha(png),
    registeredMetadataSha256: assetMetadataFingerprint(asset), sourceChecksumSha256: purpose === "mask" ? sha(png) : undefined, decoder: "sharp-full-decode-v1", verifiedAt: at, verifiedBy: "server-fixture" });
  fixture.store.transaction(() => { fixture.store.saveVerifiedImage(receipt, png); const catalog = fixture.store.loadCatalog()!; catalog.projects[0].assets.push(asset); fixture.store.saveCatalog(catalog); });
  return receipt;
}
async function listen(service?: LocalImageProviders) {
  const server = createApiServer({ imageProviders: service }); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("loopback server unavailable");
  return `http://127.0.0.1:${address.port}`;
}
function call(url: string, path: string, body?: unknown, token = "writer") {
  return fetch(`${url}/v1/projects/project-a/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("持久化供应商目录与未确认图片准备单（不启动任务）", () => {
  it("目录初始为空；配置版本/重放持久化，公开视图不含地址和凭证引用", () => {
    const fixture = setup(); expect(fixture.service.list(principal, "project-a")).toEqual([]); register(fixture);
    const before = fixture.store.imageMetadataBytes(principal.tenantId, "project-a"); register(fixture);
    expect(fixture.store.imageMetadataBytes(principal.tenantId, "project-a")).toBe(before);
    const restarted = setup({ path: fixture.path }); expect(restarted.service.get(principal, "project-a", connection().id)).toMatchObject({ revision: 1, realExecutionEnabled: false });
    const publicText = JSON.stringify(restarted.service.list(principal, "project-a")); expect(publicText).not.toContain(connection().baseUrl); expect(publicText).not.toContain(connection().credentialRef);
    expect(fixture.store.loadImageProviderHistory(principal.tenantId, "project-a")).toHaveLength(1);
  });
  it("不同数据库连接的过时修改不能覆盖，新版本保留旧配置并可停用", () => {
    const a = setup(); register(a); const b = setup({ path: a.path });
    register(a, connection({ revision: 2, enabled: false }));
    expect(() => register(b, connection({ revision: 2, name: "stale-write" }))).toThrow(expect.objectContaining({ code: "image_connection_revision_conflict" }));
    expect(() => register(b, connection({ revision: 4 }))).toThrow(expect.objectContaining({ code: "image_connection_revision_conflict" }));
    expect(a.store.loadImageProviderHistory(principal.tenantId, "project-a").map((item) => item.connection.enabled)).toEqual([true, false]);
    expect(b.service.list(principal, "project-a")[0].revision).toBe(2);
  });
  it("管理、只读、未知项目及租户权限分离；不接收原始密钥或坏 URL", () => {
    const fixture = setup(); register(fixture); const reader = { ...principal, actorId: "reader" };
    expect(fixture.service.list(reader, "project-a")).toHaveLength(1);
    for (const actor of [reader, { ...principal, tenantId: "tenant-b" }]) expect(() => fixture.service.registerRevision(actor, connection({ revision: 2 }), 1)).toThrow(expect.objectContaining({ code: "image_connection_not_found" }));
    expect(() => fixture.service.list(principal, "project-b")).toThrow(expect.objectContaining({ code: "image_connection_not_found" }));
    for (const extra of [{ apiKey: "not-a-key" }, { baseUrl: "https://user:password@never-called.invalid" }, { baseUrl: "https://never-called.invalid/?secret=fake" }]) expect(ImageProviderConnectionSchema.safeParse({ ...connection(), ...extra }).success).toBe(false);
    fixture.revoke(); expect(() => fixture.service.list(principal, "project-a")).toThrow(expect.objectContaining({ code: "image_connection_not_found" }));
  });
  it("同一连接修订号的内容漂移拒绝，不能用跳号或非整数绕过", () => {
    const fixture = setup(); register(fixture);
    expect(() => register(fixture, connection({ baseUrl: "https://other.invalid" }))).toThrow(expect.objectContaining({ code: "image_connection_revision_conflict" }));
    for (const expected of [NaN, Infinity, -1, 0.5, 1]) expect(() => fixture.service.registerRevision(principal, connection(), expected)).toThrow(expect.objectContaining({ code: "image_connection_revision_conflict" }));
  });
  it.each(["record", "head", "missing-record", "missing-head"])("目录损坏 %s 时失败关闭，不重建或覆写", (damage) => {
    const fixture = setup(); register(fixture); const db = new DatabaseSync(fixture.path);
    try {
      if (damage === "record") db.exec("UPDATE image_provider_revisions SET record = '{}' ");
      if (damage === "head") db.exec("UPDATE image_provider_heads SET revision = 2");
      if (damage === "missing-record") db.exec("DELETE FROM image_provider_revisions");
      if (damage === "missing-head") db.exec("DELETE FROM image_provider_heads");
    } finally { db.close(); }
    expect(() => fixture.service.list(principal, "project-a")).toThrow(expect.objectContaining({ code: "run_state_unavailable" }));
    expect(() => register(fixture, connection({ revision: 2 }))).toThrow(expect.objectContaining({ code: "run_state_unavailable" }));
  });
  it("目录配额失败原子回滚；修订历史和连接数量有界", () => {
    const limited = setup({ quota: 1 }); expect(() => register(limited)).toThrow(expect.objectContaining({ code: "image_metadata_quota" })); expect(limited.service.list(principal, "project-a")).toEqual([]);
    const fixture = setup(); for (let revision = 1; revision <= 32; revision++) register(fixture, connection({ revision }));
    expect(() => register(fixture, connection({ revision: 33 }))).toThrow(expect.objectContaining({ code: "image_connection_catalog_full" }));
    for (let index = 1; index < 64; index++) register(fixture, connection({ id: `provider-${index}` }));
    expect(() => register(fixture, connection({ id: "provider-over-limit" }))).toThrow(expect.objectContaining({ code: "image_connection_catalog_full" }));
    expect(fixture.service.list(principal, "project-a")).toHaveLength(64);
  });
  it("报价准备单冻结完整参数/供应商/约束，恢复不重复估价且绝不冻结预算或创建任务", () => {
    const fixture = setup(); register(fixture); const original = selection(); const before = fixture.store.load(); const prepared = fixture.service.createPreparation(principal, original);
    original.parameters.prompt = "修改调用者对象";
    expect(prepared).toMatchObject({ status: "unconfirmed", executionAuthorized: false, protocolPreparation: "not-run", mode: "local-fixture", requestTemplate: { parameters: { prompt: "人工指定的设计目标" }, quote: { estimatedCostMinor: 25 } } });
    expect(fixture.store.load()).toEqual(before); expect(fixture.kernel.listBatches(principal, "project-a")).toHaveLength(0);
    const restarted = setup({ path: fixture.path }); const recovered = restarted.service.createPreparation(principal, selection()); expect(recovered).toEqual(prepared); expect(restarted.estimate).not.toHaveBeenCalled();
    expect(ImageExecutionRequestSchema.safeParse(prepared.requestTemplate).success).toBe(false);
    const text = JSON.stringify(prepared); expect(text).not.toContain(connection().baseUrl); expect(text).not.toContain(connection().credentialRef); expect(text).not.toContain(png.toString("base64"));
  });
  it("相同动作的参数漂移拒绝；新连接版本需新动作，旧准备单仍是历史而非授权", () => {
    const fixture = setup(); register(fixture); const first = fixture.service.createPreparation(principal, selection());
    expect(() => fixture.service.createPreparation(principal, selection({ parameters: { ...selection().parameters, prompt: "不同目标" } }))).toThrow(expect.objectContaining({ code: "image_preparation_idempotency_conflict" }));
    register(fixture, connection({ revision: 2, name: "供应商修订" }));
    expect(fixture.service.createPreparation(principal, selection())).toEqual(first);
    expect(() => fixture.service.createPreparation(principal, selection({ idempotencyKey: "new-action" }))).toThrow(expect.objectContaining({ code: "image_connection_changed" }));
    const second = fixture.service.createPreparation(principal, selection({ connectionRevision: 2, idempotencyKey: "new-action" })); expect(second.id).not.toBe(first.id);
    expect(fixture.store.imagePreparationCount(principal.tenantId, "project-a")).toBe(2);
  });
  it("完整快照规范化摘要不受额外参数键顺序影响，保留 0/false", () => {
    const fixture = setup(); const compatible = connection({ protocol: "openai-compatible", compatibility: { version: "fixture-profile", endpoints: { generate: "/images/generations", edit: "/images/edits" }, editEncoding: "json-images", auth: { scheme: "bearer" }, responseEncoding: "images-b64-json-v1", extraParameters: [
      { name: "seed", type: "integer", operations: ["generate"], minimum: 0, maximum: 100 }, { name: "watermark", type: "boolean", operations: ["generate"] } ] } }); register(fixture, compatible);
    const first = fixture.service.createPreparation(principal, selection({ providerParameters: { seed: 0, watermark: false } }));
    expect(fixture.service.createPreparation(principal, selection({ providerParameters: { watermark: false, seed: 0 } }))).toEqual(first);
    expect(first.requestTemplate.providerParameters).toEqual({ seed: 0, watermark: false });
  });
  it("预算币种匹配但不把报价当预留；报价版本与金额漂移不能更改旧准备单", () => {
    const fixture = setup(); register(fixture); const first = fixture.service.createPreparation(principal, selection());
    fixture.estimate.mockImplementation((_c, _s, time) => ({ mode: "local-fixture", evidenceRef: "new-fake-table", quote: { id: "new-quote", version: "price-fixture-v2", source: "server-price-table", currency: "CNY", estimatedCostMinor: 30, maxCostMinor: 30, expiresAt: new Date(Date.parse(time) + 60_000).toISOString() } }));
    expect(fixture.service.createPreparation(principal, selection())).toEqual(first);
    expect(fixture.service.createPreparation(principal, selection({ idempotencyKey: "new-price-action" })).pricing.quote.estimatedCostMinor).toBe(30);
    expect(fixture.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
    fixture.estimate.mockImplementation((_c, _s, time) => ({ mode: "local-fixture", evidenceRef: "wrong-currency", quote: { id: "wrong", version: "price-1", source: "server-price-table", currency: "USD", estimatedCostMinor: 25, maxCostMinor: 30, expiresAt: new Date(Date.parse(time) + 60_000).toISOString() } }));
    expect(() => fixture.service.createPreparation(principal, selection({ idempotencyKey: "usd-action" }))).toThrow(expect.objectContaining({ code: "image_preparation_budget_currency_mismatch" }));
  });
  it("过期报价拒绝新准备单；历史恢复不刷新报价或制造授权", () => {
    const fixture = setup(); register(fixture); const first = fixture.service.createPreparation(principal, selection()); fixture.advance(120_000);
    expect(fixture.service.getPreparation(principal, "project-a", first.id)).toEqual(first); expect(fixture.service.createPreparation(principal, selection())).toEqual(first);
    fixture.estimate.mockImplementation(() => first.pricing);
    expect(() => fixture.service.createPreparation(principal, selection({ idempotencyKey: "expired-action" }))).toThrow(expect.objectContaining({ code: "image_quote_expired" }));
    expect(fixture.store.imagePreparationCount(principal.tenantId, "project-a")).toBe(1);
  });
  it("锁商品像素、错误输出和 4K 超界在报价前拒绝，不放松现有保护承诺", () => {
    for (const snapshot of [constraint({ lockedPaths: ["product.pixels"] }), constraint({ outputSpec: { width: 4096, height: 4096, format: "png" } }), constraint({ outputSpec: { width: 1024, height: 1024, format: "mp4" } })]) {
      const fixture = setup({ snapshot }); register(fixture);
      const input = selection({ parameters: { ...selection().parameters, size: "auto" } }); expect(() => fixture.service.createPreparation(principal, input)).toThrow(); expect(fixture.estimate).not.toHaveBeenCalled();
      expect(fixture.store.imagePreparationCount(principal.tenantId, "project-a")).toBe(0);
    }
    const fixture = setup(); register(fixture); expect(() => fixture.service.createPreparation(principal, selection({ protection: "pixel-exact" }))).toThrow(expect.objectContaining({ code: "image_pixel_protection_not_configured" }));
  });
  it("编辑输入和蒙版由权威数据库收据生成，保留真实 SHA/尺寸及底图约束", () => {
    const snapshot = constraint({ editableRegions: [{ id: "background", description: "人工选择背景", maskAssetId: "mask" }] }); const fixture = setup({ snapshot }); register(fixture);
    const image = source(fixture); source(fixture, "mask");
    const prepared = fixture.service.createPreparation(principal, selection({ operation: "edit", inputAssetIds: ["source"], maskAssetId: "mask" }));
    expect(prepared.requestTemplate).toMatchObject({ operation: "edit", inputs: [{ assetId: "source", checksumSha256: image.checksumSha256, width: 1, height: 1, byteSize: png.length }], mask: { assetId: "mask", checksumSha256: image.checksumSha256 } });
    expect(() => fixture.service.createPreparation(principal, selection({ operation: "edit", inputAssetIds: ["source"], idempotencyKey: "missing-mask" }))).toThrow(expect.objectContaining({ code: "image_output_constraint_mask_changed" }));
    const db = new DatabaseSync(fixture.path); db.prepare("UPDATE verified_images SET body = ? WHERE asset_id = 'source'").run(Buffer.alloc(png.length)); db.close();
    expect(() => fixture.service.createPreparation(principal, selection({ operation: "edit", inputAssetIds: ["source"], maskAssetId: "mask", idempotencyKey: "tampered-source" }))).toThrow(expect.objectContaining({ code: "run_state_unavailable" }));
  });
  it("客户端不能提交收据、报价、确认、任务编号、地址或密钥，未验证输入也不能准备", () => {
    const fixture = setup(); register(fixture);
    for (const extra of [{ quote: { estimatedCostMinor: 0 } }, { confirmedAt: at }, { jobId: "forged-job" }, { inputs: [{ checksumSha256: "a".repeat(64) }] }, { baseUrl: "https://other.invalid" }, { apiKey: "fake" }]) expect(CreateImagePreparationSchema.safeParse(selection(extra)).success).toBe(false);
    expect(() => fixture.service.createPreparation(principal, selection({ operation: "edit", inputAssetIds: ["unverified" ] }))).toThrow(expect.objectContaining({ code: "image_input_not_verified" }));
    expect(fixture.estimate).not.toHaveBeenCalled();
  });
  it("准备权限、读取权限和配置管理权限分离，撤销后旧单也不可读取", () => {
    const fixture = setup(); register(fixture); const prepared = fixture.service.createPreparation(principal, selection()); const reader = { ...principal, actorId: "reader" };
    expect(fixture.service.getPreparation(reader, "project-a", prepared.id)).toEqual(prepared); expect(() => fixture.service.createPreparation(reader, selection())).toThrow(expect.objectContaining({ code: "image_preparation_permission_denied" }));
    expect(() => fixture.service.getPreparation({ ...principal, tenantId: "tenant-b" }, "project-a", prepared.id)).toThrow(expect.objectContaining({ code: "image_connection_not_found" }));
    fixture.revoke(); expect(() => fixture.service.getPreparation(principal, "project-a", prepared.id)).toThrow(expect.objectContaining({ code: "image_connection_not_found" }));
  });
  it.each(["record", "missing-record", "missing-marker", "snapshot"])("准备单损坏 %s 时不重新报价，不静默覆盖", (damage) => {
    const fixture = setup(); register(fixture); const prepared = fixture.service.createPreparation(principal, selection()); const db = new DatabaseSync(fixture.path);
    try {
      if (damage === "record") db.exec("UPDATE image_preparations SET record = '{}' ");
      if (damage === "missing-record") db.exec("DELETE FROM image_preparations");
      if (damage === "missing-marker") db.exec("DELETE FROM image_preparation_presence");
      if (damage === "snapshot") { const record = fixture.store.loadImagePreparation(principal.tenantId, "project-a", prepared.id)!; record.selection.parameters.prompt = "tamper"; record.requestTemplate.parameters.prompt = "tamper"; const payload = JSON.stringify(record); db.prepare("UPDATE image_preparations SET record = ?, record_sha256 = ?").run(payload, sha(payload)); }
    } finally { db.close(); }
    expect(() => fixture.service.getPreparation(principal, "project-a", prepared.id)).toThrow(expect.objectContaining({ code: "run_state_unavailable" }));
    expect(() => fixture.service.createPreparation(principal, selection())).toThrow(expect.objectContaining({ code: "run_state_unavailable" })); expect(fixture.estimate).toHaveBeenCalledTimes(1);
  });
  it("准备单写入故障或容量不足回滚，不更改已有未知费用任务/账本", () => {
    const fixture = setup(); register(fixture); const draft = fixture.kernel.createBatch(principal, { projectId: "project-a", constraintSnapshotId: "constraint-a", tool: "product-retouch", inputAssetIds: ["fixture-source"], expectedOutputs: 1, maxCostMinor: 25, currency: "CNY", idempotencyKey: "existing-mock", mockScenario: "billing-unknown" });
    fixture.kernel.confirmBatch(principal, draft.batch.id, { expectedEstimatedCostMinor: 25, expectedCurrency: "CNY" }); fixture.kernel.dispatchBatch(principal, draft.batch.id); const before = fixture.store.load();
    const save = fixture.store.saveImagePreparation.bind(fixture.store); fixture.store.saveImagePreparation = (record) => { save(record); throw new Error("fixture fail after inserts"); };
    expect(() => fixture.service.createPreparation(principal, selection())).toThrow(expect.objectContaining({ code: "run_state_unavailable" })); expect(fixture.store.loadImagePreparationByAction(principal.tenantId, "project-a", "human-action-a")).toBeNull(); expect(fixture.store.load()).toEqual(before);
    fixture.store.saveImagePreparation = save; fixture.service.createPreparation(principal, selection()); expect(fixture.store.load()).toEqual(before);
    expect(fixture.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 25, spentMinor: 0 });
    const limited = setup({ path: fixture.path, quota: fixture.store.imageMetadataBytes(principal.tenantId, "project-a") });
    expect(() => limited.service.createPreparation(principal, selection({ idempotencyKey: "quota-action" }))).toThrow(expect.objectContaining({ code: "image_metadata_quota" }));
  });
  it("估价期间撤销权限或变更连接/约束，会阻止保存准备单", () => {
    for (const change of ["permission", "connection", "constraint"] as const) {
      const fixture = setup(); register(fixture); const quote = fixture.estimate.getMockImplementation()!;
      fixture.estimate.mockImplementation((config, input, time) => {
        if (change === "permission") fixture.revoke();
        if (change === "connection") register(fixture, connection({ revision: 2, name: "changed during estimate" }));
        if (change === "constraint") { const catalog = fixture.store.loadCatalog()!; catalog.projects[0].constraints[0].brandRules.color = "changed"; fixture.store.saveCatalog(catalog); }
        return quote(config, input, time);
      });
      expect(() => fixture.service.createPreparation(principal, selection())).toThrow();
      expect(fixture.store.imagePreparationCount(principal.tenantId, "project-a")).toBe(0);
      expect(fixture.store.loadImageProviderHistory(principal.tenantId, "project-a")).toHaveLength(1);
      expect(fixture.store.loadCatalog()!.projects[0].constraints[0].brandRules.color).toBe("orange");
    }
  });
  it("供应商版本写到一半失败时全部回滚；不能留下可读取的新版本", () => {
    const fixture = setup(); register(fixture); const save = fixture.store.saveImageProviderRevision.bind(fixture.store);
    fixture.store.saveImageProviderRevision = (record) => { save(record); throw new Error("fixture failure after head update"); };
    expect(() => register(fixture, connection({ revision: 2 }))).toThrow(expect.objectContaining({ code: "run_state_unavailable" }));
    expect(fixture.service.list(principal, "project-a")[0].revision).toBe(1);
    expect(fixture.store.loadImageProviderHistory(principal.tenantId, "project-a")).toHaveLength(1);
  });
  it("v3 迁移保留目录、原图和任务账本，不启用执行；未知更高版本拒绝", () => {
    const fixture = setup(); source(fixture);
    const draft = fixture.kernel.createBatch(principal, { projectId: "project-a", constraintSnapshotId: "constraint-a", tool: "product-retouch", inputAssetIds: ["source"], expectedOutputs: 1, maxCostMinor: 25, currency: "CNY", idempotencyKey: "v3-legacy-mock", mockScenario: "billing-unknown" });
    fixture.kernel.confirmBatch(principal, draft.batch.id, { expectedEstimatedCostMinor: 25, expectedCurrency: "CNY" }); fixture.kernel.dispatchBatch(principal, draft.batch.id);
    const before = fixture.store.load(); const catalog = fixture.store.loadCatalog(); const image = fixture.store.loadVerifiedImage(principal.tenantId, "project-a", "source");
    const db = new DatabaseSync(fixture.path); db.exec("DROP TABLE image_provider_revisions; DROP TABLE image_provider_heads; DROP TABLE image_preparations; DROP TABLE image_preparation_presence; PRAGMA user_version = 3"); db.close();
    const migrated = setup({ path: fixture.path }); expect(migrated.store.load()).toEqual(before); expect(migrated.store.loadCatalog()).toEqual(catalog); expect(migrated.store.loadVerifiedImage(principal.tenantId, "project-a", "source")).toEqual(image); expect(migrated.service.list(principal, "project-a")).toEqual([]);
    expect(migrated.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 25, spentMinor: 0 }); expect(migrated.kernel.getBatch(principal, draft.batch.id).jobs[0].status).toBe("billing_unknown");
    const future = new DatabaseSync(fixture.path); future.exec("PRAGMA user_version = 8"); future.close(); expect(() => new SqliteRunKernelStateStore(fixture.path)).toThrow(expect.objectContaining({ code: "run_state_unavailable" }));
  });
  it("HTTP 默认关闭/拒绝匿名，只读目录和准备操作不开放配置写入或执行", async () => {
    const disabled = await listen(); expect((await call(disabled, "image-providers")).status).toBe(503);
    const fixture = setup(); register(fixture); const url = await listen(fixture.service);
    expect((await call(url, "image-providers", undefined, "anonymous")).status).toBe(401);
    const listing = await call(url, "image-providers"); expect(listing.status).toBe(200); expect(listing.headers.get("cache-control")).toBe("no-store"); expect(await listing.json()).toHaveLength(1);
    expect((await call(url, "image-providers", connection())).status).toBe(404);
    const created = await call(url, "image-preparations", selection()); expect(created.status).toBe(201); const prepared = await created.json(); expect(prepared.executionAuthorized).toBe(false);
    expect(await (await call(url, `image-preparations/${prepared.id}`)).json()).toEqual(prepared);
    expect((await call(url, `image-preparations/${prepared.id}/confirm`, {})).status).toBe(400);
    expect((await call(url, `image-preparations/${prepared.id}/confirm`, { expectedSnapshotFingerprint: prepared.snapshotFingerprint,
      expectedEstimatedCostMinor: 25, expectedMaxCostMinor: 30, expectedCurrency: "CNY" })).status).toBe(503);
    expect((await call(url, "image-preparations", selection({ projectId: "foreign" }))).status).toBe(422);
    expect((await call(url, "image-preparations", selection({ apiKey: "fake", quote: { estimatedCostMinor: 0 } }))).status).toBe(400);
    expect((await call(url, "image-preparations", { oversized: "x".repeat(129 * 1024) })).status).toBe(413);
    expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ realExecutorsEnabled: false, imageProviderMode: "catalog-and-preparations-only" });
    expect(fixture.store.load()?.batches).toHaveLength(0);
  });
  it("快照 schema 拒绝假授权、错误关系及任务标识，非法容量配置也拒绝", () => {
    const fixture = setup(); register(fixture); const prepared = fixture.service.createPreparation(principal, selection()); const record = fixture.store.loadImagePreparation(principal.tenantId, "project-a", prepared.id)!;
    for (const extra of [{ executionAuthorized: true }, { status: "confirmed" }, { protocolPreparation: "passed" }, { jobId: "fake-job" }, { tenantId: "other" }, { requestTemplate: { ...record.requestTemplate, jobId: "fake-job" } }]) expect(ImagePreparationRecordSchema.safeParse({ ...record, ...extra }).success).toBe(false);
    for (const quota of [NaN, Infinity, -1, 0.5, 16 * 1024 * 1024 + 1]) expect(() => setup({ quota })).toThrow("供应商目录的租户或容量配置无效");
  });
});
