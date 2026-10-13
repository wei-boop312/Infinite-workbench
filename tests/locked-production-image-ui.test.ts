import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { LockedProductionImageUiScopeSchema, LockedProductionImageRecoverySchema, type LockedProductionImageUiScope } from "../packages/contracts/src/index";
import { LockedProductionImageClient } from "../apps/web/src/runs/lockedProductionImageClient";
import { lockedProductionRecoveryKey, readLockedProductionRecovery, saveLockedProductionRecovery } from "../apps/web/src/runs/lockedProductionImageRecovery";
import { createRequire } from "node:module";
import { createLockedTaskFixture } from "./helpers/locked-production-task-fixture";
import { LockedImageProductionPublicHarness, LockedProductionImagePublicService } from "../apps/api/src/lockedProductionImagePublic";
import { buildLockedImageSelection } from "../apps/web/src/runs/lockedImagePreparationDraft";
import { emptyImageDraft, type ImagePreparationDraft } from "../apps/web/src/runs/imagePreparationDraft";
import { buildImageSelection } from "../apps/web/src/runs/imagePreparationDraft";
import { imageProviderPublicView } from "../apps/api/src/imageProviderContract";
import { LocalVerifiedAssets } from "../apps/api/src/verifiedAssets";
import { assetMetadataFingerprint, verifiedImageMatchesRegistration } from "../apps/api/src/assetMetadata";
import { LockedImageProductionArtifactHarness } from "../apps/api/src/lockedProductionImageTaskArtifacts";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
let source: Buffer, mask: Buffer;
beforeAll(async () => { const png = (v: number[]) => sharp(Buffer.from(v), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  source = await png([40,70,90,255,1,2,3,255]); mask = await png([255,255,255,0,255,255,255,255]); });
function lockedUiFixture(opts: Parameters<typeof createLockedTaskFixture>[2] = {}) {
  const f = createLockedTaskFixture(source, mask, opts);
  const auth = { authenticate: (r: any) => r.headers.authorization === "Bearer writer" ? principal : null, allows: f.authorizer.allows };
  const options = { lockedPublicPreparationEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, preparations: f.service,
    runAuthorizer: auth, providerAuthorizer: auth, assetAuthorizer: auth, clock: f.clock, lockedPublicPreparationPolicy: () => true };
  const port = opts.production ? new LockedProductionImagePublicService(options) : new LockedImageProductionPublicHarness(options);
  return { ...f, port, selection: () => f.select(), price: f.pricePort };
}
import { principal } from "./helpers/image-task-fixture";
import { createApiServer } from "../apps/api/src/index";

const owned: ReturnType<typeof lockedUiFixture>[] = [], servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((resolve, reject) => s.close(e => e ? reject(e) : resolve())); } for (const f of owned.splice(0)) f.cleanup(); });
const scope: LockedProductionImageUiScope = { lockedPreparationUiEnabled: true, tenantId: principal.tenantId, mode: "production-contract-fixture" };
const fixture = (o: Parameters<typeof lockedUiFixture>[0] = {}) => { const f = lockedUiFixture(o); owned.push(f); return f; };
const client = (s = scope, signal = new AbortController().signal) => new LockedProductionImageClient(s, signal);
const reply = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": "private,no-store", "content-length": String(new TextEncoder().encode(JSON.stringify(value)).length), ...headers } });
async function confirmed(f: ReturnType<typeof fixture>) {
  const p = await f.port.createPreparation(principal, "project-a", f.selection());
  const q = p.pricing.quote, c = await f.port.confirmPreparation(principal, "project-a", p.id, { schemaVersion: 2, expectedProtectionPolicyFingerprint: p.protectionPolicyFingerprint, expectedSnapshotFingerprint: p.snapshotFingerprint, expectedPricingFingerprint: p.pricingFingerprint,
    expectedCurrency: q.currency, expectedMaxCostMinor: q.maxCostMinor, estimate: q.source === "manual-budget" ? { state: "unknown" } : { state: "known", expectedEstimatedCostMinor: q.estimatedCostMinor } });
  return { p, c };
}
describe("B10B 独立生产客户端和有界只读指针", () => {
  it.each([{}, { ...scope, lockedPreparationUiEnabled: false }, { ...scope, mode: "local-fixture" }, { ...scope, url: "https://private.invalid" }])("显式严格配置 %j，不能从local改标或浏览器地址启用", config => {
    expect(LockedProductionImageUiScopeSchema.safeParse(config).success).toBe(false); expect(() => client(config as never)).toThrow();
  });
  for (const protocol of ["openai", "openai-compatible"] as const) for (const manual of [false, true]) it(`${protocol}/${manual} 客户端实际HTTP临时SQLite准备/人工确认/只读恢复`, async () => {
    const f = fixture({ protocol, manual }), s = createApiServer({ lockedProductionImagePreparations: f.port }); servers.push(s);
    await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve)); const a = s.address(); if (!a || typeof a === "string") throw new Error();
    const actualFetch = globalThis.fetch, fetcher = vi.fn((path: string, options: RequestInit) => actualFetch(`http://127.0.0.1:${a.port}${path.replace(/^\/studio-api/, "")}`, { ...options, headers: { ...options.headers, authorization: "Bearer writer" } })); vi.stubGlobal("fetch", fetcher);
    const api = client(), p = await api.prepare(f.selection()); expect(f.kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
    expect(await api.history(p)).toBeNull(); const c = await api.confirm(p); expect(c.task.estimatedCostMinor).toBe(manual ? null : 25); expect(c.task.currentMaxCostMinor).toBe(40);
    const calls = fetcher.mock.calls, body = JSON.parse(calls[2][1].body as string);
    expect(body).toEqual({ schemaVersion: 2, expectedProtectionPolicyFingerprint: p.protectionPolicyFingerprint, expectedSnapshotFingerprint: p.snapshotFingerprint, expectedPricingFingerprint: p.pricingFingerprint, expectedCurrency: "CNY", expectedMaxCostMinor: 40,
      estimate: manual ? { state: "unknown" } : { state: "known", expectedEstimatedCostMinor: 25 } });
    expect(calls[2][0]).toMatch(/locked-production-image-preparations\/[^/]+\/confirm$/); expect(calls[2][1]).toMatchObject({ cache: "no-store", redirect: "error", credentials: "same-origin" });
    const before = f.store.load(); f.advance(61_000); f.register({ ...f.config, enabled: false, revision: 2 }); f.price.read.mockClear(); f.price.verify.mockClear();
    expect(await api.history(await api.preparation("project-a", p.id))).toEqual(c); expect(f.store.load()).toEqual(before); expect(f.price.read).not.toHaveBeenCalled(); expect(f.price.verify).not.toHaveBeenCalled();
    expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0 }); expect(before?.batches[0].lockedProductionImageAttempt).toBeUndefined();
  });
  it.each([false, true])("从头生产工厂 %s 估价，不改标夹具；拒绝相反模式", async manual => {
    const f = fixture({ production: true, manual }), { p, c } = await confirmed(f), fetcher = vi.fn().mockResolvedValue(reply(c)); vi.stubGlobal("fetch", fetcher);
    expect(await client({ ...scope, mode: "production" }).confirm(p)).toEqual(c);
    await expect(client().confirm(p)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["tenant", "mode", "project", "preparation", "pricing", "policy", "constraint", "creator", "adapter", "inputs", "time", "transform", "private"])("错配 %s 关闭，不补发确认", async damage => {
    const f = fixture({ twoInputs: true }), { p, c } = await confirmed(f), altered = structuredClone(c);
    if (damage === "tenant") altered.tenantId = "foreign"; if (damage === "mode") altered.mode = "production";
    if (damage === "project") altered.projectId = "foreign"; if (damage === "preparation") altered.preparationFingerprint = "1".repeat(64);
    if (damage === "policy") altered.protectionPolicyFingerprint = "1".repeat(64); if (damage === "pricing") altered.pricingFingerprint = "1".repeat(64); if (damage === "constraint") altered.task.constraintSnapshotId = "foreign";
    if (damage === "creator") altered.confirmedBy = "foreign"; if (damage === "adapter") altered.task.adapterId = "foreign";
    if (damage === "inputs") altered.task.inputAssetIds.reverse(); if (damage === "time") altered.confirmedAt = "2100-01-01T00:00:00.000Z";
    if (damage === "transform") altered.transformedInputs[0].originalChecksumSha256 = "1".repeat(64); if (damage === "private") Object.assign(altered, { workerId: "private" });
    const fetcher = vi.fn().mockResolvedValue(reply(altered)); vi.stubGlobal("fetch", fetcher);
    await expect(client().confirm(p)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["brand", "region", "dimensions"])("完整原约束 %s 篡改保留SHA在POST前拒绝", async damage => {
    const f = fixture(), { p } = await confirmed(f);
    if (damage === "brand") p.constraint.brandRules.tone = "篡改"; if (damage === "region") p.constraint.editableRegions.push({ id: "new", description: "篡改" });
    if (damage === "dimensions") { p.constraint.outputSpec.width = 4096; p.protectionPolicy.outputSpec.width = 4096; }
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); await expect(client().confirm(p)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["no-store", "declared", "encoding", "type", "actual", "utf8", "fragments", "lost"])("网络 %s 全包拒绝，不自动重试或使用缓存", async damage => {
    const f = fixture(), { p, c } = await confirmed(f); let response = reply(c);
    if (damage === "no-store") response = reply(c, { "cache-control": "public" });
    if (damage === "declared") response = reply(c, { "content-length": String(512 * 1024 + 1) });
    if (damage === "encoding") response = reply(c, { "content-encoding": "gzip" });
    if (damage === "type") response = reply(c, { "content-type": "text/html" });
    if (damage === "actual") response = reply("x".repeat(512 * 1024));
    if (damage === "utf8") response = new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (damage === "fragments") response = new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 4097; i++) controller.enqueue(new Uint8Array([32])); controller.close(); } }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    const fetcher = damage === "lost" ? vi.fn().mockRejectedValue(new Error("secret")) : vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetcher);
    await expect(client().confirm(p)).rejects.toThrow("不自动重发"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("已取消和不合作流有界取消，只读历史无POST", async () => {
    const f = fixture(), { p } = await confirmed(f), abort = new AbortController(); abort.abort();
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); await expect(client(scope, abort.signal).history(p)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    const waiting = new AbortController(), cancel = vi.fn(); fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json", "cache-control": "no-store", "content-length": "20" } }));
    const result = expect(client(scope, waiting.signal).history(p)).rejects.toThrow(); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); waiting.abort(); await result; await vi.waitFor(() => expect(cancel).toHaveBeenCalled()); expect(fetcher.mock.calls[0][1].method).toBe("GET");
  });
  it("不合作fetch仍按绝对取消信号结束，不再POST", async () => {
    const f = fixture(), { p } = await confirmed(f), abort = new AbortController(), fetcher = vi.fn(() => new Promise<Response>(() => undefined)); vi.stubGlobal("fetch", fetcher);
    const result = client(scope, abort.signal).confirm(p); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); abort.abort(); await expect(result).rejects.toThrow("不自动重发"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["tenant", "project", "large", "no-store"])("预算 %s 失败关闭但不创建或再次确认任务", async damage => {
    const f = fixture(), b = f.kernel.getBudget(principal, "project-a"); if (damage === "tenant") b.tenantId = "foreign"; if (damage === "project") b.projectId = "foreign";
    const fetcher = vi.fn().mockResolvedValue(damage === "large" ? reply(b, { "content-length": String(512 * 1024 + 1) }) : reply(b, damage === "no-store" ? { "cache-control": "public" } : {})); vi.stubGlobal("fetch", fetcher);
    await expect(client().budget("project-a")).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toMatch(/\/budget$/); expect(fetcher.mock.calls[0][1].method).toBe("GET");
  });
  it("只读指针不含选择价格凭证；租户模式项目和阶段严格隔离，先写后回读", () => {
    const p = { schemaVersion: 2 as const, tenantId: scope.tenantId, projectId: "project-a", mode: scope.mode, actionId: "human-action", stage: "prepared" as const,
      preparationId: "original", preparationFingerprint: "a".repeat(64), pricingFingerprint: "b".repeat(64), protectionPolicyFingerprint: "c".repeat(64) }, raw = JSON.stringify(p);
    expect(readLockedProductionRecovery(raw, scope, p.projectId)).toEqual(p); expect(readLockedProductionRecovery(null, scope, p.projectId)).toBeNull();
    const storage = { setItem: vi.fn(), getItem: vi.fn().mockReturnValue(raw) }; saveLockedProductionRecovery(storage, scope, p); expect(storage.setItem).toHaveBeenCalledWith(lockedProductionRecoveryKey(scope, p.projectId), raw);
    storage.getItem.mockReturnValue(null); expect(() => saveLockedProductionRecovery(storage, scope, p)).toThrow(); storage.setItem.mockImplementation(() => { throw new Error("full"); }); expect(() => saveLockedProductionRecovery(storage, scope, p)).toThrow();
    for (const altered of [{ ...p, tenantId: "foreign" }, { ...p, projectId: "foreign" }, { ...p, mode: "production" }, { ...p, pricingFingerprint: undefined }, { ...p, protectionPolicyFingerprint: undefined }, { ...p, schemaVersion: 1 }, { ...p, stage: "preparing" }, { ...p, quote: {} }, { ...p, selection: {} }, { ...p, executionAuthorized: true }]) expect(() => readLockedProductionRecovery(JSON.stringify(altered), scope, p.projectId)).toThrow();
    expect(() => readLockedProductionRecovery("x".repeat(16 * 1024 + 1), scope, p.projectId)).toThrow(); expect(LockedProductionImageRecoverySchema.safeParse({ ...p, stage: "confirm-submitted" }).success).toBe(true);
    expect(lockedProductionRecoveryKey(scope, p.projectId)).not.toContain("image-confirmation."); expect(lockedProductionRecoveryKey({ ...scope, mode: "production" }, p.projectId)).not.toBe(lockedProductionRecoveryKey(scope, p.projectId));
  });
});


describe("B10B 原POST前范围守卫", () => {
  it("已提交历史的损坏指针不能宣称从未提交或预留", () => {
    expect(() => readLockedProductionRecovery('{"schemaVersion":2,"stage":"confirm-submitted"}', scope, "project-a")).toThrow("可能已有的预留");
    try { readLockedProductionRecovery("broken", scope, "project-a"); } catch (e) { expect((e as Error).message).not.toMatch(/未提交|未预留/); }
  });

  it("确认真实POST前再核指针，摘要 await 中失效不发送", async () => {
    const f = fixture(), { p } = await confirmed(f), fetcher = vi.fn(), guard = vi.fn(() => { throw Error("pointer lost"); }); vi.stubGlobal("fetch", fetcher);
    await expect(client().confirm(p, guard)).rejects.toThrow(); expect(guard).toHaveBeenCalledTimes(1); expect(fetcher).not.toHaveBeenCalled();
  });
  it("原选择不能借 protected client 发 none/generate 请求", async () => {
    const f = fixture(), fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(client().prepare({ ...f.selection(), protection: "none" } as never)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });

});
describe("B10B 独立保护选择，旧 none/local 保持拒绝", () => {
  function inputs() {
    const f = fixture({ twoInputs: true }), catalog = f.store.loadCatalog()!.projects[0], providers = [imageProviderPublicView(f.config)];
    const draft: ImagePreparationDraft = { ...emptyImageDraft(), connectionId: f.config.id, model: f.config.models[0].model, operation: "edit",
      constraintId: "constraint-a", prompt: "原锁区", quality: "auto", background: "auto", inputAssetIds: ["source", "source-2"], maskAssetId: "mask" };
    return { f, catalog, providers, draft, make: () => buildLockedImageSelection("project-a", "owned-human", draft, providers, catalog.constraints, catalog.assets, new Set()) };
  }
  it("原完整保护选择/顺序，不剥离锁后借旧builder", () => { const x = inputs(); expect(x.make()).toMatchObject({ protection: "pixel-exact", operation: "edit", inputAssetIds: ["source", "source-2"], maskAssetId: "mask" });
    expect(() => buildImageSelection("project-a", "old", x.draft, x.providers, x.catalog.constraints, x.catalog.assets, new Set())).toThrow(); });
  it.each(["google", "none", "auto", "generate", "binding", "no-region", "duplicate-region", "66MiB", "pixels", "missing", "polarity"])("选择 %s 明确拒绝，不上传价格或改锁", damage => {
    const x = inputs();
    if (damage === "google") x.providers[0].protocol = "google";
    if (damage === "none") x.catalog.constraints[0].lockedPaths = [];
    if (damage === "auto") x.draft.sizeMode = "auto"; if (damage === "generate") x.draft.operation = "generate";
    if (damage === "binding") x.catalog.assets.find(a => a.id === "mask")!.sourceAssetId = "source-2";
    if (damage === "no-region") x.catalog.constraints[0].editableRegions = [];
    if (damage === "duplicate-region") x.catalog.constraints[0].editableRegions.push(x.catalog.constraints[0].editableRegions[0]);
    if (damage === "66MiB") for (const a of x.catalog.assets.filter(a => ["source", "source-2", "mask"].includes(a.id))) a.byteSize = 22 * 1024 * 1024;
    if (damage === "pixels") x.catalog.constraints[0].outputSpec = { width: 4096, height: 4096, format: "png" };
    if (damage === "missing") x.catalog.assets = x.catalog.assets.filter(a => a.id !== "mask");
    if (damage === "polarity") x.providers[0].models[0].mask.polarity = "unverified";
    expect(x.make).toThrow(); expect(x.f.price.read).not.toHaveBeenCalled(); expect(x.f.kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
  });
});

describe("实际上传登记与服务端收据身份各自冻结", () => {
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  async function upload(f: ReturnType<typeof fixture>) {
    const catalog = f.store.loadCatalog()!, project = catalog.projects[0];
    const originals = ["source", "mask"].map(id => ({ ...project.assets.find(a => a.id === id)!, id: `uploaded-${id}`, storageKey: `browser:${id}`, proxyStorageKey: `proxy:${id}`, ...(id === "mask" ? { sourceAssetId: "uploaded-source" } : {}) }));
    f.store.transaction(() => { project.assets.push(...originals); project.constraints[0].editableRegions[0].maskAssetId = "uploaded-mask"; f.store.saveCatalog(catalog); });
    const service = new LocalVerifiedAssets({ stateStore: f.store, authorizer: f.authorizer, findAsset: (_tenant, _project, id) => f.store.loadCatalog()!.projects[0].assets.find(a => a.id === id) ?? null });
    const records = [];
    for (let i = 0; i < originals.length; i++) { const body = i ? mask : source, request = Object.assign(Readable.from([body]), { headers: { "content-type": "image/png", "content-length": String(body.length), "x-content-sha256": sha(body) } });
      records.push(await service.verify(principal, "project-a", originals[i].id, request as never)); }
    return { originals, records, select: { ...f.selection(), inputAssetIds: [originals[0].id], maskAssetId: originals[1].id } };
  }
  it.each([false, true])("上传实际规范存储收据到完整保护产物 manual=%s，不混同注册SHA", async manual => {
    let artifact!: LockedImageProductionArtifactHarness;
    const policy = { usesStateStore: (s: any) => artifact.usesStateStore(s), authorizeScope: (p: any, j: string) => artifact.authorizeScope(p,j), validateCommit: (p: any, r: any) => artifact.validateCommit(p,r) };
    const f = fixture({ manual, kernel: { lockedProductionImageArtifactPolicy: policy } }), u = await upload(f);
    for (let i = 0; i < 2; i++) { expect(u.records[i].registeredMetadataSha256).toBe(assetMetadataFingerprint(u.originals[i])); expect(u.records[i].registeredMetadataSha256).not.toBe(assetMetadataFingerprint(u.records[i].asset)); expect(verifiedImageMatchesRegistration(u.records[i], u.originals[i])).toBe(true); }
    const p = await f.port.createPreparation(principal, "project-a", u.select), v = await f.service.confirmPreparation(principal, "project-a", p.id, { schemaVersion: 2, expectedProtectionPolicyFingerprint: p.protectionPolicyFingerprint,
      expectedSnapshotFingerprint: p.snapshotFingerprint, expectedPricingFingerprint: p.pricingFingerprint, expectedCurrency: "CNY", expectedMaxCostMinor: 40, estimate: manual ? { state: "unknown" } : { state: "known", expectedEstimatedCostMinor: 25 } });
    const l = f.kernel.claimLockedProductionImageBatch(principal, "project-a", v.batchId, { workerId: "owned", maxJobs: 1 }).leases[0], identity = { workerId: l.workerId, leaseId: l.leaseId };
    await f.reconstruction.executeFixture(principal, "project-a", v.batchId, v.jobId, identity);
    artifact = new LockedImageProductionArtifactHarness({ lockedArtifactEnabled: true, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, clock: f.clock,
      runAuthorizer: f.authorizer, providerAuthorizer: f.authorizer, assetAuthorizer: f.authorizer, lockedArtifactPolicy: () => true });
    const result = await artifact.ingest(principal, "project-a", v.batchId, v.jobId, identity);
    expect(result.draft.pixelProof.lockedPixelsEqual).toBe(true); const before = f.store.load(); expect(await artifact.ingest(principal, "project-a", v.batchId, v.jobId, identity)).toEqual(result); expect(f.store.load()).toEqual(before);
    expect(f.port.getConfirmation(principal, "project-a", p.id).confirmation?.task).toMatchObject({ jobStatus: "billing_unknown", estimatedCostMinor: manual ? null : 25, reservedMinor: 40 });
  });
  it.each(["name", "bytes", "dimensions", "mime", "registeredSHA", "storage", "proxy"])("规范收据的 %s 任意漂移仍拒绝，不借规范化抹元信息", async damage => {
    const f = fixture(), u = await upload(f), r = structuredClone(u.records[0]);
    if (damage === "name") r.asset.originalName = "drift"; if (damage === "bytes") r.asset.byteSize++; if (damage === "dimensions") r.asset.width!++; if (damage === "mime") r.asset.mimeType = "image/webp";
    if (damage === "registeredSHA") r.registeredMetadataSha256 = "1".repeat(64); if (damage === "storage") r.asset.storageKey = "foreign"; if (damage === "proxy") r.asset.proxyStorageKey = "untrusted";
    expect(verifiedImageMatchesRegistration(r, u.originals[0])).toBe(false);
  });
});
