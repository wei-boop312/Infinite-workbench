import { beforeAll, afterEach, describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { request as httpRequest, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Readable, PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { LockedProductionImagePreparationPublicSchema, LockedProductionImageConfirmationPublicSchema, LockedProductionImageConfirmationHistorySchema,
  ProductionImagePreparationPublicSchema, ProductionImageConfirmationPublicSchema, ImagePreparationPublicSchema, ImageConfirmationPublicSchema } from "../packages/contracts/src/index";
import { LockedImageProductionPublicHarness, LockedProductionImagePublicService } from "../apps/api/src/lockedProductionImagePublic";
import { LockedImageProductionPreparationHarness } from "../apps/api/src/lockedProductionImagePreparations";
import { createApiServer } from "../apps/api/src/index";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { RunKernelError } from "../apps/api/src/runKernel";
import { handleLockedProductionImagePublicHttp } from "../apps/api/src/lockedProductionImagePublicHttp";
import { imageSnapshotFingerprint as fp } from "../apps/api/src/imageProviderContract";
import { createLockedTaskFixture } from "./helpers/locked-production-task-fixture";
import { ownedLockedGeneratedTask } from "./helpers/locked-generated-task";
import { principal } from "./helpers/image-task-fixture";
import * as decoder from "../apps/api/src/staticImageDecoder";
import * as pixels from "../apps/api/src/lockedImagePixelValidation";
import * as protocol from "../apps/api/src/lockedProductionImageProtocol";
import * as evidence from "../apps/api/src/lockedProductionImagePublicRead";
const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
let source: Buffer, mask: Buffer;
const owned: { cleanup(): void }[] = [], servers: Server[] = [];
beforeAll(async () => { const png = (v: number[]) => sharp(Buffer.from(v), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  source = await png([40,70,90,255,1,2,3,255]); mask = await png([255,255,255,0,255,255,255,255]); });
afterEach(async () => { vi.useRealTimers(); for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
  vi.restoreAllMocks(); for (const f of owned.splice(0).reverse()) f.cleanup(); });
function publicPort(f: ReturnType<typeof createLockedTaskFixture>, extra: Record<string, unknown> = {}) {
  const policy = vi.fn((): unknown => true), auth = { authenticate: (r: any) => r.headers.authorization === "Bearer writer" ? principal : null, allows: f.authorizer.allows };
  const options = { lockedPublicPreparationEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, preparations: f.service,
    runAuthorizer: auth, providerAuthorizer: auth, assetAuthorizer: auth, clock: f.clock, lockedPublicPreparationPolicy: policy as () => boolean, ...extra };
  const port = f.options.pricePort.kind === "server-pricing" ? new LockedProductionImagePublicService(options as any) : new LockedImageProductionPublicHarness(options as any);
  return { port, policy, options, auth };
}
function fixture(opts: Parameters<typeof createLockedTaskFixture>[2] = {}) { const f = createLockedTaskFixture(source, mask, opts); owned.push(f); return { ...f, preparationOptions: f.options, ...publicPort(f) }; }
const expected = (p: ReturnType<typeof LockedProductionImagePreparationPublicSchema.parse>) => ({ schemaVersion: 2,
  expectedSnapshotFingerprint: p.snapshotFingerprint, expectedPricingFingerprint: p.pricingFingerprint, expectedProtectionPolicyFingerprint: p.protectionPolicyFingerprint,
  expectedCurrency: p.pricing.quote.currency, expectedMaxCostMinor: p.pricing.quote.maxCostMinor,
  estimate: p.pricing.quote.source === "manual-budget" ? { state: "unknown" } : { state: "known", expectedEstimatedCostMinor: p.pricing.quote.estimatedCostMinor } });
async function api(port?: LockedImageProductionPublicHarness | LockedProductionImagePublicService) {
  const s = createApiServer({ lockedProductionImagePreparations: port }); servers.push(s); await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const a = s.address(); if (!a || typeof a === "string") throw new Error(); const base = `http://127.0.0.1:${a.port}/v1/projects/project-a/locked-production-image-preparations`;
  const request = (suffix = "", method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(base + suffix, { method, headers: { authorization: "Bearer writer", "content-type": "application/json", ...headers },
    cache: "no-store", redirect: "error", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { base, request };
}
describe("B10A protected public preparation/confirmation: owned zero-cost SQLite + HTTP", () => {
  it("默认四路由404，未配置在私有读取前关闭", async () => {
    const f = fixture(), a = await api(), load = vi.spyOn(f.store, "loadLockedProductionImagePreparation");
    for (const [suffix, method] of [["", "POST"], ["/missing", "GET"], ["/missing/confirm", "POST"], ["/missing/confirmation", "GET"]])
      expect((await a.request(suffix, method, method === "POST" ? {} : undefined)).status).toBe(404);
    expect(() => new LockedProductionImagePublicService().getPreparation(principal, "project-a", "missing")).toThrow(); expect(load).not.toHaveBeenCalled();
    expect(f.kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
  });
  it.each((["openai", "openai-compatible"] as const).flatMap(protocol => [false, true].map(manual => [protocol, manual] as const)))("%s/manual=%s 原全人工摘要/一次确认，只读过期恢复", async (protocol, manual) => {
    const f = fixture({ protocol, manual, twoInputs: true }), a = await api(f.port), response = await a.request("", "POST", f.select()); expect(response.status).toBe(201);
    const p = LockedProductionImagePreparationPublicSchema.parse(await response.json());
    expect(p).toMatchObject({ schemaVersion: 2, status: "unconfirmed", protocolPreparation: "not-run", executionAuthorized: false,
      protectionPolicy: { validation: "input-verified-output-unchecked", domain: "fixed-rgba8-only", lockedPixels: 1, editablePixels: 1 } });
    expect(p.requestDraft.inputs.map(i => i.assetId)).toEqual(["source", "source-2"]); expect(p.protectionPolicy.mask.sourceAssetId).toBe("source");
    const r = f.store.loadLockedProductionImagePreparation(principal.tenantId, "project-a", p.mode, p.id)!;
    expect(p.pricingFingerprint).toBe(fp(r.pricing)); expect(p.pricingFingerprint).not.toBe(fp(p.pricing)); expect(p.protectionPolicyFingerprint).toBe(fp(r.protectionPolicy));
    expect(p.constraint).toEqual(r.constraint); expect(p.connection.models[0].mask.polarity).toBe(protocol === "openai" ? "transparent-edit" : "white-edit");
    expect((await (await a.request(`/${p.id}/confirmation`)).json()).confirmation).toBeNull(); expect(f.store.load()!.batches).toHaveLength(0);
    const both = await Promise.all([a.request(`/${p.id}/confirm`, "POST", expected(p)), a.request(`/${p.id}/confirm`, "POST", expected(p))]); expect(both.map(r => r.status)).toEqual([200, 200]);
    const values = await Promise.all(both.map(r => r.json())); expect(values[0]).toEqual(values[1]); const c = LockedProductionImageConfirmationPublicSchema.parse(values[0]);
    expect(c.task).toMatchObject({ jobStatus: "queued", inputAssetIds: ["source", "source-2", "mask"], estimatedCostMinor: manual ? null : 25, currentMaxCostMinor: 40, reservedMinor: 40 });
    expect(f.store.load()!.batches).toHaveLength(1); expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0, availableMinor: 960 });
    expect(JSON.stringify([p, c])).not.toMatch(/storageKey|credentialRef|baseUrl|idempotencyKey|leaseId|workerId|aggregate|never-called|opaque-never-resolved|b64_json/);
    expect(ProductionImagePreparationPublicSchema.safeParse(p).success).toBe(false); expect(ImagePreparationPublicSchema.safeParse(p).success).toBe(false);
    expect(ProductionImageConfirmationPublicSchema.safeParse(c).success).toBe(false); expect(ImageConfirmationPublicSchema.safeParse(c).success).toBe(false);
    f.advance(100_000); f.register({ ...f.config, revision: 2, enabled: false }); const before = f.store.load(), save = vi.spyOn(f.store, "save"), native = vi.spyOn(decoder, "decodeStaticImagePixels");
    f.pricePort.read.mockClear(); f.pricePort.verify.mockClear().mockReturnValue(false);
    expect(await (await a.request(`/${p.id}/confirmation`)).json()).toMatchObject({ confirmation: c }); expect(await (await a.request(`/${p.id}/confirm`, "POST", expected(p))).json()).toEqual(c);
    expect(f.store.load()).toEqual(before); expect(save).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled(); expect(f.pricePort.read).not.toHaveBeenCalled(); expect(f.pricePort.verify).not.toHaveBeenCalled();
  });
  it.each([false, true])("从头production/manual=%s，假server-pricing不是改标夹具", async manual => {
    const f = fixture({ production: true, manual }), p = await f.port.createPreparation(principal, "project-a", f.select()), c = await f.port.confirmPreparation(principal, "project-a", p.id, expected(p));
    expect(p.mode).toBe("production"); expect(c.pricing.evidence.kind).toBe(manual ? "server-approved-budget" : "server-verified-price");
    expect(c.task.estimatedCostMinor).toBe(manual ? null : 25); expect(f.send).not.toHaveBeenCalled(); expect(c.executionAuthorized).toBe(false);
  });
  it.each(["multipart-image-array", "multipart-image-single"] as const)("%s真实boundary/原转换，不返回wire", async encoding => {
    const f = fixture({ protocol: "openai-compatible", encoding, manual: true }), p = await f.port.createPreparation(principal, "project-a", f.select()), c = await f.port.confirmPreparation(principal, "project-a", p.id, expected(p));
    expect(c.contentType).toMatch(/^multipart\/form-data; boundary=canvas-[a-f0-9]{40}$/); expect(c.transformedInputs.map(i => i.assetId)).toEqual(["source", "mask"]);
    expect(c.payloadChecksumSha256).toBe(f.store.load()!.batches[0].lockedProductionImageExecution!.protocol.payloadChecksumSha256); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["run:read", "run:create", "provider:read", "asset:read"])("%s准备在私有读取前拒绝", async permission => {
    const f = fixture(); f.deny(permission); const load = vi.spyOn(f.store, "loadCatalog"); await expect(f.port.createPreparation(principal, "project-a", f.select())).rejects.toThrow();
    expect(load).not.toHaveBeenCalled(); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it.each([false, 1, "true", Promise.resolve(true)])("公开政策strict sync true %s", async value => {
    const f = fixture(); f.policy.mockReturnValue(value); const load = vi.spyOn(f.store, "loadLockedProductionImagePreparationByAction");
    await expect(f.port.createPreparation(principal, "project-a", f.select())).rejects.toThrow(); expect(load).not.toHaveBeenCalled();
  });
  it("独立read历史，不借create/confirm/execute/核账/write，原确认人不变", async () => {
    const f = fixture({ manual: true }), p = await f.port.createPreparation(principal, "project-a", f.select()); await f.port.confirmPreparation(principal, "project-a", p.id, expected(p));
    for (const x of ["run:create", "run:confirm", "run:execute", "run:reconcile-billing", "asset:write"]) f.deny(x);
    const before = f.store.load(), reader = { ...principal, actorId: "reader" }, h = f.port.getConfirmation(reader, "project-a", p.id);
    expect(h.confirmation!.confirmedBy).toBe("writer"); expect(h.confirmation!.task.estimatedCostMinor).toBeNull(); expect(f.store.load()).toEqual(before);
    await expect(f.port.confirmPreparation(reader, "project-a", p.id, expected(p))).rejects.toThrow();
  });
  it.each(["run:read", "provider:read", "asset:read"])("历史%s仍必须，读失败不声称从未预留", async permission => {
    const f = fixture(), p = await f.port.createPreparation(principal, "project-a", f.select()); await f.port.confirmPreparation(principal, "project-a", p.id, expected(p)); f.deny(permission);
    const before = f.store.load(), load = vi.spyOn(f.store, "loadLockedProductionImagePreparation"); expect(() => f.port.getConfirmation(principal, "project-a", p.id)).toThrow();
    expect(load).not.toHaveBeenCalled(); expect(f.store.load()).toEqual(before); expect(before!.batches[0].reservedMinor).toBe(40);
  });
  it.each(["expectedSnapshotFingerprint", "expectedPricingFingerprint", "expectedProtectionPolicyFingerprint", "expectedCurrency", "expectedMaxCostMinor", "estimate"])("原人工期待%s漂移不预留", async key => {
    const f = fixture({ manual: true }), p = await f.port.createPreparation(principal, "project-a", f.select()), before = f.store.load();
    const changed = { ...expected(p), [key]: key.endsWith("Fingerprint") ? "0".repeat(64) : key === "estimate" ? { state: "known", expectedEstimatedCostMinor: 0 } : key === "expectedCurrency" ? "USD" : 0 };
    await expect(f.port.confirmPreparation(principal, "project-a", p.id, changed)).rejects.toThrow(); expect(f.store.load()).toEqual(before);
  });
  it.each([0, 40])("未发送取消%d仍unknown/null/没有实费0，只GET完整历史", async cap => {
    const f = fixture({ manual: true, cap }), p = await f.port.createPreparation(principal, "project-a", f.select()), c = await f.port.confirmPreparation(principal, "project-a", p.id, expected(p));
    f.kernel.cancelLockedProductionImageBatch(principal, "project-a", c.task.batchId); const before = f.store.load(), h = f.port.getConfirmation(principal, "project-a", p.id);
    expect(h.confirmation!.task).toMatchObject({ jobStatus: "cancelled", estimatedCostMinor: null, reservedMinor: 0 }); expect(h.confirmation!.task.actualCostMinor).toBeUndefined(); expect(f.store.load()).toEqual(before);
  });
  it("namespace/同一实际SQLite而非同路径是必要配置", () => {
    const f = fixture(); expect(() => new LockedProductionImagePublicService(f.options as any)).toThrow();
    const second = new SqliteRunKernelStateStore(f.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true });
    try { expect(() => new LockedImageProductionPublicHarness({ ...f.options, stateStore: second } as any)).toThrow(); } finally { second.close(); }
  });
  it.each(["supportsProductionImageResponses", "supportsProductionImageArtifacts"] as const)("%s关闭不跳过证据核验", async method => {
    const f = fixture(), p = await f.port.createPreparation(principal, "project-a", f.select()), load = vi.spyOn(f.store, "loadLockedProductionImagePreparation");
    vi.spyOn(f.store, method).mockReturnValue(false); expect(() => f.port.getConfirmation(principal, "project-a", p.id)).toThrow(); expect(load).not.toHaveBeenCalled();
  });
  it("实际第二SQLite重启历史只GET，不重预留/报价/native", async () => {
    const f = fixture({ manual: true }), p = await f.port.createPreparation(principal, "project-a", f.select()), c = await f.port.confirmPreparation(principal, "project-a", p.id, expected(p));
    const store = new SqliteRunKernelStateStore(f.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true });
    try { const kernel = new SqliteRunKernel({ stateStore: store, authorizer: f.auth, budgets: f.store.load()!.budgets, clock: f.clock }),
      preparations = new LockedImageProductionPreparationHarness({ ...f.preparationOptions, stateStore: store, runKernel: kernel });
      const port = new LockedImageProductionPublicHarness({ ...f.options, stateStore: store, runKernel: kernel, preparations } as any), save = vi.spyOn(store, "save"), native = vi.spyOn(decoder, "decodeStaticImagePixels");
      f.pricePort.read.mockClear(); f.pricePort.verify.mockClear(); expect(port.getConfirmation(principal, "project-a", p.id).confirmation).toEqual(c);
      expect(save).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled(); expect(f.pricePort.read).not.toHaveBeenCalled(); expect(f.pricePort.verify).not.toHaveBeenCalled(); }
    finally { store.close(); }
    expect(c.task.estimatedCostMinor).toBeNull();
  });
  it.each(["prepare", "confirm"])("%s真实SQL保存故障回滚", async action => {
    const f = fixture(); const p = action === "confirm" ? await f.port.createPreparation(principal, "project-a", f.select()) : null, before = f.store.load();
    const method = action === "confirm" ? "save" : "saveLockedProductionImagePreparation", original = (f.store[method] as any).bind(f.store);
    vi.spyOn(f.store, method as any).mockImplementation((...args: any[]) => { original(...args); throw new Error("owned-private-sql-fault"); });
    await expect(action === "confirm" ? f.port.confirmPreparation(principal, "project-a", p!.id, expected(p!)) : f.port.createPreparation(principal, "project-a", f.select())).rejects.toThrow();
    expect(f.store.load()).toEqual(before);
  });
  it("提交后公开权限失败不能说从未提交，原编号GET恢复一次预留", async () => {
    const f = fixture(), p = await f.port.createPreparation(principal, "project-a", f.select());
    f.policy.mockImplementation((ctx: any) => ctx?.action !== "confirm" || f.store.load()!.batches.length === 0);
    await expect(f.port.confirmPreparation(principal, "project-a", p.id, expected(p))).rejects.toThrow();
    expect(f.port.getConfirmation(principal, "project-a", p.id).confirmation!.task.reservedMinor).toBe(40); expect(f.store.load()!.batches).toHaveLength(1);
  });
  it.each(["query", "range", "method", "encoding", "cross-project", "anonymous", "extra", "origin"])("HTTP拒绝%s，不调用价格", async bad => {
    const f = fixture(), a = await api(f.port); const r = await a.request(bad === "query" ? "?x=1" : "", bad === "method" ? "GET" : "POST",
      bad === "method" ? undefined : bad === "cross-project" ? { ...f.select(), projectId: "other" } : bad === "extra" ? { ...f.select(), confirmed: true } : f.select(),
      bad === "range" ? { range: "bytes=0-1" } : bad === "encoding" ? { "content-type": "text/plain" } : bad === "anonymous" ? { authorization: "" } : bad === "origin" ? { origin: "https://owned-cross-origin.invalid" } : {});
    expect(r.ok).toBe(false); expect(f.pricePort.read).not.toHaveBeenCalled(); expect(f.store.load()!.batches).toHaveLength(0);
  });
  it.each(["prepare-size", "confirm-size", "compressed", "get-body", "escaped-id", "utf8"])("HTTP有界严格正文%s，不调用私有方法", async bad => {
    const f = fixture(), a = await api(f.port), create = vi.spyOn(f.port, "createPreparation"), confirm = vi.spyOn(f.port, "confirmPreparation"), get = vi.spyOn(f.port, "getConfirmation");
    const suffix = bad === "confirm-size" ? "/missing/confirm" : bad === "escaped-id" ? "/bad%2Fid/confirmation" : bad === "get-body" ? "/missing/confirmation" : "",
      body = bad === "utf8" ? Buffer.from([123,34,120,34,58,34,255,34,125]) : Buffer.from(JSON.stringify({ pad: "x".repeat(bad === "prepare-size" ? 128 * 1024 : bad === "confirm-size" ? 16 * 1024 : 0) }));
    const status = await new Promise<number>((resolve, reject) => { const req = httpRequest(a.base + suffix, { method: bad === "get-body" || bad === "escaped-id" ? "GET" : "POST",
      headers: { authorization: "Bearer writer", "content-type": "application/json", "content-length": body.length, ...(bad === "compressed" ? { "content-encoding": "gzip" } : {}) } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); }); req.on("error", reject); req.end(body); });
    expect(status).toBe(bad.endsWith("size") ? 413 : 400); expect(create).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it.each(["private", "known-private", "async"])("授权异常%s固定白名单/Promise拒绝", async bad => {
    const f = fixture(), a = await api(f.port); f.policy.mockImplementation(() => { if (bad === "async") return Promise.resolve(true);
      throw bad === "known-private" ? new RunKernelError(599, "locked_public_permission_denied", "owned-private-secret") : new Error("owned-private-secret"); });
    const r = await a.request("", "POST", f.select()); expect([403, 503]).toContain(r.status); expect(JSON.stringify(await r.json())).not.toContain("owned-private"); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it("精确私有头/长度且准备不是输出像素证明", async () => {
    const f = fixture(), a = await api(f.port), r = await a.request("", "POST", f.select()), body = await r.text();
    expect(r.headers.get("cache-control")).toBe("private, no-store"); expect(r.headers.get("vary")).toBe("Authorization"); expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin"); expect(r.headers.get("referrer-policy")).toBe("no-referrer"); expect(Number(r.headers.get("content-length"))).toBe(Buffer.byteLength(body));
    const p = JSON.parse(body); expect(p.protectionPolicy.lockedPixelsEqual).toBeUndefined(); expect(p.protectionPolicy.candidatePixelsSha256).toBeUndefined();
  });
  it.each(["policy", "usesStateStore"])("%s函数替换在私有读取前拒绝", async kind => {
    const f = fixture(), p = await f.port.createPreparation(principal, "project-a", f.select()), load = vi.spyOn(f.store, "loadLockedProductionImagePreparation");
    if (kind === "policy") (f.port as any).options.lockedPublicPreparationPolicy = () => true;
    else f.kernel.usesStateStore = () => true;
    expect(() => f.port.getPreparation(principal, "project-a", p.id)).toThrow(); expect(load).not.toHaveBeenCalled();
  });
  it("当前三份22MiB声明总66MiB在任何收据/BLOB getter前拒绝", async () => {
    const f = fixture({ twoInputs: true }), p = await f.port.createPreparation(principal, "project-a", f.select());
    f.store.transaction(() => { const c = f.store.loadCatalog()!; for (const a of c.projects[0].assets) a.byteSize = 22 * 1024 * 1024; f.store.saveCatalog(c); });
    const receipt = vi.spyOn(f.store, "loadVerifiedImage"), body = vi.spyOn(f.store, "loadVerifiedImageBytes");
    expect(() => f.port.getPreparation(principal, "project-a", p.id)).toThrow(); expect(receipt).not.toHaveBeenCalled(); expect(body).not.toHaveBeenCalled();
  });
  it("Google绑定蒙版仍价格前拒绝，公开入口不制造协议支持", async () => {
    const f = fixture(), config = { ...f.config, protocol: "google" as const, revision: 2, googleNative: { version: "owned", apiVersion: "v1" as const,
      requestEncoding: "generate-content-response-format-v1" as const, modelMappings: [{ model: f.config.models[0].model, sizes: [{ width: 2, height: 1, aspectRatio: "1:1" as const, imageSize: "1K" as const }] }] } };
    f.register(config); await expect(f.port.createPreparation(principal, "project-a", { ...f.select(), connectionRevision: 2 })).rejects.toThrow();
    expect(f.pricePort.read).not.toHaveBeenCalled(); expect(f.store.load()!.batches).toHaveLength(0);
  });
  it.each(["version", "policy", "mask-source", "locked-count", "constraint", "private", "null-estimate"])("公开准备%s损坏不由schema改标升级", async bad => {
    const f = fixture({ manual: true }), original = await f.port.createPreparation(principal, "project-a", f.select()), p: any = structuredClone(original);
    if (bad === "version") p.schemaVersion = 1;
    else if (bad === "policy") delete p.protectionPolicy;
    else if (bad === "mask-source") p.protectionPolicy.mask.sourceAssetId = "other";
    else if (bad === "locked-count") p.protectionPolicy.lockedPixels = 0;
    else if (bad === "constraint") p.constraint.editableRegions[0].maskAssetId = "other";
    else if (bad === "private") p.protectionPolicy.source.storageKey = "owned-private-key";
    else p.pricing.quote.estimatedCostMinor = 0;
    expect(LockedProductionImagePreparationPublicSchema.safeParse(p).success).toBe(false);
  });
  it("HTTP4097非空分片整体拒绝，准备不消费前4096片", async () => {
    const f = fixture(), create = vi.spyOn(f.port, "createPreparation"), req = Object.assign(Readable.from(Array.from({ length: 4097 }, () => Buffer.from(" ")), { objectMode: true }),
      { method: "POST", url: "/v1/projects/project-a/locked-production-image-preparations", headers: { authorization: "Bearer writer", "content-type": "application/json" } });
    const res: any = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn(), destroy: vi.fn() });
    expect(await handleLockedProductionImagePublicHttp(req as any, res, f.port)).toBe(true); expect(res.writeHead.mock.calls[0][0]).toBe(413); expect(create).not.toHaveBeenCalled();
  });
  it("HTTP正文绝对30秒，无穷慢流销毁且不调用准备", async () => {
    const f = fixture(), create = vi.spyOn(f.port, "createPreparation"); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const req = Object.assign(new PassThrough(), { method: "POST", url: "/v1/projects/project-a/locked-production-image-preparations", headers: { authorization: "Bearer writer", "content-type": "application/json" } });
    const res: any = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn(),
      destroy() { this.destroyed = true; this.emit("close"); } });
    const work = handleLockedProductionImagePublicHttp(req as any, res, f.port); await vi.advanceTimersByTimeAsync(30_000); expect(await work).toBe(true);
    expect(req.destroyed).toBe(true); expect(res.destroyed).toBe(true); expect(create).not.toHaveBeenCalled(); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it.each(["cancel", "time"])("最后纯读取之后%s不得返回", async kind => {
    const f = fixture(), p = await f.port.createPreparation(principal, "project-a", f.select()), controller = new AbortController(), original = evidence.readLockedPublicEvidence;
    let calls = 0; vi.spyOn(evidence, "readLockedPublicEvidence").mockImplementation((...args) => { const result = original(...args);
      if (++calls === 2) { if (kind === "cancel") controller.abort(); else f.advance(5000); } return result; });
    expect(() => f.port.getPreparation(principal, "project-a", p.id, { signal: controller.signal })).toThrow(); expect(calls).toBe(2);
  });
  it.each(["input", "catalog"])("最后授权回调%s漂移也整体回滚", async kind => {
    const f = fixture(), p = await f.port.createPreparation(principal, "project-a", f.select());
    f.policy.mockClear(); f.port.getPreparation(principal, "project-a", p.id); const total = f.policy.mock.calls.length, before = f.store.loadCatalog(); let calls = 0;
    f.policy.mockImplementation(() => { if (++calls === total) { const catalog = f.store.loadCatalog()!;
      if (kind === "input") catalog.projects[0].constraints[0].brandRules.style = "owned-drift";
      else catalog.projects[0].assets.push({ ...catalog.projects[0].assets[0], id: "owned-unrelated" }); f.store.saveCatalog(catalog); } return true; });
    expect(() => f.port.getPreparation(principal, "project-a", p.id)).toThrow(); expect(f.store.loadCatalog()).toEqual(before);
  });
  it.each(["tenant", "timeout"])("最后授权回调配置%s漂移仍拒绝", async kind => {
    const f = fixture(), p = await f.port.createPreparation(principal, "project-a", f.select());
    f.policy.mockClear(); f.port.getPreparation(principal, "project-a", p.id); const total = f.policy.mock.calls.length; let calls = 0;
    f.policy.mockImplementation(() => { if (++calls === total) {
      if (kind === "tenant") (f.port as any).options.tenantId = "owned-other-tenant";
      else (f.port as any).options.timeoutMs = 30_000;
    } return true; });
    expect(() => f.port.getPreparation(principal, "project-a", p.id)).toThrow();
  });
});
describe("B10A full persisted protected artifact/fee history, never reprocess or send", () => {
  it("删全task结果/产物且重算合法unknown投影仍拒绝孤立raw/产物", async () => {
    const t = await ownedLockedGeneratedTask(); owned.push(t); const { port } = publicPort(t), snapshot = t.store.load()!, s = snapshot.batches[0], j = s.aggregate.jobs[0];
    t.advance(30_000); j.finishedAt = new Date(t.clock()).toISOString(); j.failureCode = "locked-lease-expired-after-intent"; j.outputAssetIds = [];
    delete s.lockedProductionImageResult; delete s.lockedProductionImageResultFingerprint; delete s.lockedProductionImageArtifact; delete s.lockedProductionImageArtifactFingerprint;
    s.aggregate.audit = s.aggregate.audit.filter(a => !["production-image-returned", "production-image-artifact-verified"].includes(a.eventType));
    const unknown = s.aggregate.audit.find(a => a.eventType === "billing-unknown")!; unknown.createdAt = j.finishedAt; unknown.metadata.reason = j.failureCode;
    s.aggregate.ledger.find(l => l.settlement === "unknown")!.createdAt = j.finishedAt;
    expect(() => t.kernel.validateProductionBillingSnapshot(snapshot)).not.toThrow(); t.store.transaction(() => t.store.save(snapshot));
    expect(() => port.getConfirmation(principal, "project-a", t.preparation.id)).toThrow(); expect(t.send).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("unknown/独立超额结算=%s后完整历史", async settled => {
    const t = await ownedLockedGeneratedTask({ manual: true }); owned.push(t); if (settled) t.settle(65); const { port } = publicPort(t), before = t.store.load();
    for (const x of ["run:execute", "run:create", "run:confirm", "run:reconcile-billing", "asset:write"]) t.deny(x);
    const native = vi.spyOn(decoder, "decodeStaticImagePixels"), pixel = vi.spyOn(pixels, "verifyLockedImagePixels"), wire = vi.spyOn(protocol, "prepareLockedProductionImageProtocol"), save = vi.spyOn(t.store, "save");
    t.pricePort.read.mockClear(); t.pricePort.verify.mockClear(); const c = port.getConfirmation(principal, "project-a", t.preparation.id).confirmation!;
    expect(c.task).toMatchObject({ jobStatus: settled ? "succeeded" : "billing_unknown", estimatedCostMinor: null, currentMaxCostMinor: settled ? 65 : 40, reservedMinor: settled ? 0 : 40 });
    expect(c.task.actualCostMinor).toBe(settled ? 65 : undefined); expect(c.task.outputAssetIds).toEqual([t.id]); expect(c.protectionPolicyFingerprint).toBe(fp(t.preparation.protectionPolicy));
    expect(t.store.load()).toEqual(before); for (const fn of [native, pixel, wire, save, t.pricePort.read, t.pricePort.verify]) expect(fn).not.toHaveBeenCalled(); expect(t.send).toHaveBeenCalledTimes(1);
  });
  it.each(["revoke", "input"])("raw getter后%s复查/回滚，清借出副本", async bad => {
    const t = await ownedLockedGeneratedTask(); owned.push(t); const { port } = publicPort(t), before = t.store.loadCatalog(), load = t.store.loadLockedProductionImageResponse.bind(t.store); let body: Buffer | undefined;
    vi.spyOn(t.store, "loadLockedProductionImageResponse").mockImplementation((...args) => { const r = load(...args); body = r?.body;
      if (bad === "revoke") t.deny("asset:read"); else { const c = t.store.loadCatalog()!; c.projects[0].constraints[0].brandRules.style = "owned-drift"; t.store.saveCatalog(c); } return r; });
    expect(() => port.getConfirmation(principal, "project-a", t.preparation.id)).toThrow(); expect(body?.every(v => v === 0)).toBe(true); expect(t.store.loadCatalog()).toEqual(before);
  });
  it.each(["proof", "fees", "result"])("原%s字段损坏，部分重算SQLite SHA仍失败关闭", async bad => {
    const t = await ownedLockedGeneratedTask(); owned.push(t); if (bad === "fees") t.settle(25); const { port } = publicPort(t), db = new DatabaseSync(t.path);
    try { const row = db.prepare("SELECT payload FROM kernel_state WHERE kind = 'runs'").get()!, snapshot = JSON.parse(row.payload as string), s = snapshot.batches[0];
      if (bad === "proof") delete s.lockedProductionImageArtifact.draft.pixelProof;
      else if (bad === "fees") { delete s.lockedProductionImageBilling; delete s.lockedProductionImageBillingFingerprint; delete s.aggregate.lockedProductionBilling; }
      else { delete s.lockedProductionImageResult; delete s.lockedProductionImageResultFingerprint; }
      const payload = JSON.stringify(snapshot), hash = createRequire(import.meta.url)("node:crypto").createHash("sha256").update(payload).digest("hex");
      db.prepare("UPDATE kernel_state SET payload = ?, sha256 = ? WHERE kind = 'runs'").run(payload, hash);
    } finally { db.close(); }
    expect(() => port.getConfirmation(principal, "project-a", t.preparation.id)).toThrow(); expect(t.send).toHaveBeenCalledTimes(1);
  });
});
