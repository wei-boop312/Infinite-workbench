import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { ProductionImagePreparationPublicSchema, ProductionImageConfirmationPublicSchema, ProductionImageConfirmationHistorySchema, ImagePreparationPublicSchema, ImageConfirmationPublicSchema } from "../packages/contracts/src/index";
import { createApiServer } from "../apps/api/src/index";
import { ImageProductionPublicHarness, ProductionImagePublicService } from "../apps/api/src/productionImagePublic";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { ImageProductionBillingSettlementHarness } from "../apps/api/src/productionImageBillingSettlement";
import { ImageProductionBillingReviewHarness } from "../apps/api/src/productionImageBillingReview";
import { imageSnapshotFingerprint as fp } from "../apps/api/src/imageProviderContract";
import { productionPublicFixture } from "./helpers/production-public-fixture";
import { productionBillingTaskFixture } from "./helpers/production-billing-task-fixture";
import { principal } from "./helpers/image-task-fixture";

const owned: ReturnType<typeof productionPublicFixture>[] = [], servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((resolve, reject) => s.close(e => e ? reject(e) : resolve())); }
  vi.restoreAllMocks(); for (const f of owned.splice(0).reverse()) f.cleanup(); });
function fixture(o: Parameters<typeof productionPublicFixture>[0] = {}) { const f = productionPublicFixture(o); owned.push(f); return f; }
async function api(port?: ReturnType<typeof fixture>["port"]) {
  const s = createApiServer({ productionImagePreparations: port }); servers.push(s); await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
  const address = s.address(); if (!address || typeof address === "string") throw new Error();
  const base = `http://127.0.0.1:${address.port}/v1/projects/project-a/production-image-preparations`;
  const request = (suffix = "", method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(base + suffix, { method, headers: { authorization: "Bearer writer", "content-type": "application/json", ...headers },
    cache: "no-store", redirect: "error", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { base, request };
}
const expected = (p: ReturnType<typeof ProductionImagePreparationPublicSchema.parse>) => ({ expectedSnapshotFingerprint: p.snapshotFingerprint,
  expectedPricingFingerprint: p.pricingFingerprint, expectedCurrency: p.pricing.quote.currency, expectedMaxCostMinor: p.pricing.quote.maxCostMinor,
  estimate: p.pricing.quote.source === "manual-budget" ? { state: "unknown" } : { state: "known", expectedEstimatedCostMinor: p.pricing.quote.estimatedCostMinor } });

describe("6D8A 独立公开生产准备/确认HTTP合同，仅自有零费用库", () => {
  it("默认API404，未配置服务在私有读取前关闭", async () => {
    const f = fixture(), a = await api(), load = vi.spyOn(f.store, "loadProductionImagePreparation");
    for (const [suffix, method] of [["", "POST"], ["/missing", "GET"], ["/missing/confirmation", "GET"], ["/missing/confirm", "POST"]]) expect((await a.request(suffix, method, method === "POST" ? {} : undefined)).status).toBe(404);
    expect(() => new ProductionImagePublicService().getPreparation(principal, "project-a", "missing")).toThrow(); expect(load).not.toHaveBeenCalled();
    expect(f.kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s/known 三协议完整确认仅一次预留", async protocol => positive(protocol, false));
  it.each(["openai", "openai-compatible", "google"] as const)("%s/unknown 不补0或上限，编辑原图", async protocol => positive(protocol, true, true));
  async function positive(protocol: "openai" | "openai-compatible" | "google", manual: boolean, edit = false) {
    const f = fixture({ protocol, manual, edit }), a = await api(f.port), create = await a.request("", "POST", f.selection()); expect(create.status).toBe(201);
    expect(create.headers.get("cache-control")).toBe("private, no-store"); const p = ProductionImagePreparationPublicSchema.parse(await create.json());
    expect(p.pricing.quote.source).toBe(manual ? "manual-budget" : "server-price-table"); expect(p.requestDraft.inputs.map(i => i.assetId)).toEqual(edit ? ["source", "second"] : []);
    const before = f.store.load(); expect(before!.batches).toHaveLength(0);
    const h = ProductionImageConfirmationHistorySchema.parse(await (await a.request(`/${p.id}/confirmation`)).json()); expect(h.confirmation).toBeNull(); expect(f.store.load()).toEqual(before);
    const responses = await Promise.all([a.request(`/${p.id}/confirm`, "POST", expected(p)), a.request(`/${p.id}/confirm`, "POST", expected(p))]);
    expect(responses.map(r => r.status)).toEqual([200, 200]); const results = await Promise.all(responses.map(r => r.json())); expect(results[0]).toEqual(results[1]);
    const c = ProductionImageConfirmationPublicSchema.parse(results[0]); expect(c.task.estimatedCostMinor).toBe(manual ? null : 25); expect(c.task.currentMaxCostMinor).toBe(40);
    expect(c.task.jobStatus).toBe("queued"); expect(c.transformedInputs.map(i => i.assetId)).toEqual(edit ? ["source", "second"] : []);
    expect(f.store.load()!.batches).toHaveLength(1); expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0, availableMinor: 960 });
    expect(f.price.read).toHaveBeenCalledTimes(1); expect(JSON.stringify([p, c])).not.toMatch(/credentialRef|baseUrl|idempotencyKey|leaseId|workerId|aggregate|never-called|opaque-never-resolved/);
    expect(ImagePreparationPublicSchema.safeParse(p).success).toBe(false); expect(ImageConfirmationPublicSchema.safeParse(c).success).toBe(false);
    const persisted = f.store.loadProductionImagePreparation(principal.tenantId, "project-a", "production-contract-fixture", p.id)!;
    expect(c.pricingFingerprint).toBe(fp(persisted.pricing)); expect(p.status).toBe("unconfirmed"); expect(p.executionAuthorized).toBe(false);
    f.advance(100_000); f.register({ ...f.config, revision: 2, enabled: false }); f.price.read.mockClear(); f.price.verify.mockClear().mockReturnValue(false);
    const save = vi.spyOn(f.store, "save"), bytes = vi.spyOn(f.store, "loadVerifiedImageBytes"), state = f.store.load();
    expect(await (await a.request(`/${p.id}/confirmation`)).json()).toMatchObject({ confirmation: c });
    expect(await (await a.request(`/${p.id}/confirm`, "POST", expected(p))).json()).toEqual(c); expect(f.store.load()).toEqual(state);
    expect(save).not.toHaveBeenCalled(); expect(bytes).not.toHaveBeenCalled(); expect(f.price.read).not.toHaveBeenCalled(); expect(f.price.verify).not.toHaveBeenCalled();
  }
  it.each([false, true])("生产工厂从头建 %s金额，假oracle不改标合同夹具", async manual => {
    const f = fixture({ production: true, manual }), a = await api(f.port), p = ProductionImagePreparationPublicSchema.parse(await (await a.request("", "POST", f.selection())).json());
    const c = ProductionImageConfirmationPublicSchema.parse(await (await a.request(`/${p.id}/confirm`, "POST", expected(p))).json());
    expect(p.mode).toBe("production"); expect(c.mode).toBe("production"); expect(c.pricing.evidence.kind).toBe(manual ? "server-approved-budget" : "server-verified-price");
    expect(c.task.estimatedCostMinor).toBe(manual ? null : 25); expect(c.executionAuthorized).toBe(false); expect(c.realExecutionEnabled).toBe(false);
    expect(f.store.load()!.batches[0].productionImageAttempt).toBeUndefined(); expect(f.store.load()!.batches[0].productionImageDispatchIntent).toBeUndefined();
  });
  it.each(["run:read", "run:create", "provider:read", "asset:read"])("%s 创建在读取私有资料前拒绝", async permission => {
    const f = fixture(), a = await api(f.port); f.deny(permission); const load = vi.spyOn(f.store, "loadProductionImagePreparationByAction"), catalog = vi.spyOn(f.store, "loadCatalog");
    expect((await a.request("", "POST", f.selection())).status).toBe(403); expect(load).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled(); expect(f.price.read).not.toHaveBeenCalled();
  });
  it.each([false, 1, "true", Promise.resolve(true)])("同步stricttrue，不采用truthy/Promise %s", async value => {
    const f = fixture(), a = await api(f.port); f.allow(value); expect((await a.request("", "POST", f.selection())).status).toBe(403); expect(f.price.read).not.toHaveBeenCalled();
  });
  it("历史仅read权限，不借执行/核账或确认权限", async () => {
    const f = fixture({ manual: true }), a = await api(f.port), p = await (await a.request("", "POST", f.selection())).json();
    await a.request(`/${p.id}/confirm`, "POST", expected(p)); f.deny("run:create"); f.deny("run:confirm"); f.deny("run:execute"); f.deny("run:reconcile-billing");
    const before = f.store.load(); expect((await a.request(`/${p.id}/confirmation`, "GET", undefined, { authorization: "Bearer other" })).status).toBe(200);
    expect((await a.request(`/${p.id}/confirm`, "POST", expected(p))).status).toBe(403); expect(f.store.load()).toEqual(before);
  });
  it("独立命名空间与同一实际实例是必要配置", () => {
    const f = fixture(); expect(() => new ProductionImagePublicService(f.publicOptions)).toThrow();
    const second = new SqliteRunKernelStateStore(f.path); try { expect(() => new ImageProductionPublicHarness({ ...f.publicOptions, stateStore: second })).toThrow(); } finally { second.close(); }
  });
  it.each(["query", "range", "method", "encoding", "cross-project", "anonymous", "body"])("HTTP拒绝 %s，不新增准备或任务", async bad => {
    const f = fixture(), a = await api(f.port); let r: Response;
    if (bad === "query") r = await a.request("?a=1", "POST", f.selection());
    else if (bad === "range") r = await a.request("", "POST", f.selection(), { range: "bytes=0-1" });
    else if (bad === "method") r = await a.request("", "GET");
    else if (bad === "encoding") r = await a.request("", "POST", f.selection(), { "content-type": "text/plain" });
    else if (bad === "cross-project") r = await a.request("", "POST", { ...f.selection(), projectId: "other" });
    else if (bad === "anonymous") r = await a.request("", "POST", f.selection(), { authorization: "" });
    else r = await a.request("", "POST", { ...f.selection(), confirmed: true });
    expect(r.ok).toBe(false); expect(f.price.read).not.toHaveBeenCalled(); expect(f.store.load()!.batches).toHaveLength(0);
  });
  it.each(["expectedSnapshotFingerprint", "expectedPricingFingerprint", "expectedCurrency", "estimate"])("人工完整期待%s漂移不预留", async key => {
    const f = fixture({ manual: true }), a = await api(f.port), p = await (await a.request("", "POST", f.selection())).json(), before = f.store.load();
    const changed = { ...expected(p), [key]: key.endsWith("Fingerprint") ? "0".repeat(64) : key === "estimate" ? { state: "known", expectedEstimatedCostMinor: 0 } : "USD" };
    expect((await a.request(`/${p.id}/confirm`, "POST", changed)).ok).toBe(false); expect(f.store.load()).toEqual(before);
  });
  it.each(["fault", "revoke"])("实际任务SQL写后%s仍整体回滚", async kind => {
    const f = fixture(), a = await api(f.port), p = await (await a.request("", "POST", f.selection())).json(), before = f.store.load(), save = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementation(s => { save(s); if (s.batches.length) { if (kind === "revoke") f.deny("run:confirm"); else throw new Error("owned-private-storage-key"); } });
    const r = await a.request(`/${p.id}/confirm`, "POST", expected(p)); expect(r.ok).toBe(false); expect(JSON.stringify(await r.json())).not.toContain("owned-private"); expect(f.store.load()).toEqual(before);
  });
  it("跨连接重启仅GET，不保存/原图归一化/verify或再次预留", async () => {
    const f = fixture({ manual: true, edit: true }), a = await api(f.port), p = await (await a.request("", "POST", f.selection())).json(), c = await (await a.request(`/${p.id}/confirm`, "POST", expected(p))).json();
    const second = fixture({ path: f.path, manual: true, edit: false }), b = await api(second.port); second.price.read.mockClear(); second.price.verify.mockClear(); const save = vi.spyOn(second.store, "save");
    expect(await (await b.request(`/${p.id}/confirmation`)).json()).toMatchObject({ confirmation: c }); expect(save).not.toHaveBeenCalled(); expect(second.price.read).not.toHaveBeenCalled(); expect(second.price.verify).not.toHaveBeenCalled();
  });
  it("缺实际快照/损坏原确认不是未确认null", async () => {
    const f = fixture(), p = f.port.createPreparation(principal, "project-a", f.selection()); await f.port.confirmPreparation(principal, "project-a", p.id, expected(p));
    f.store.transaction(() => { const s = f.store.load()!; s.batches[0].requestFingerprint = "0".repeat(64); f.store.save(s); });
    expect(() => f.port.getConfirmation(principal, "project-a", p.id)).toThrow();
  });
  it.each(["raw", "artifact", "constraint", "permission"])("当次响应/产物历史%s损坏或撤权失败关闭，不借实际worker权限", async bad => {
    const f = await productionBillingTaskFixture({ manual: true, edit: true }); await f.artifacts.ingest(...f.args);
    const opts = { publicPreparationEnabled: true as const, tenantId: principal.tenantId, stateStore: f.f.store, runKernel: f.f.kernel,
      preparations: f.preparations, runAuthorizer: f.auth, providerAuthorizer: f.auth, assetAuthorizer: f.auth };
    const p = new ImageProductionPublicHarness(opts); const before = f.f.store.load(); expect(p.getConfirmation({ ...principal, actorId: "other" }, "project-a", f.preparation.id).confirmation!.task.jobStatus).toBe("billing_unknown"); expect(f.f.store.load()).toEqual(before);
    if (bad === "permission") f.denied.add("asset:read");
    else if (bad === "constraint") f.f.store.transaction(() => { const c = f.f.store.loadCatalog()!; c.projects[0].constraints[0].brandRules = { style: "changed" }; f.f.store.saveCatalog(c); });
    else {
      const method = bad === "raw" ? "loadProductionImageResponse" : "loadProductionImageArtifact"; vi.spyOn(f.f.store, method).mockReturnValue(null);
    }
    expect(() => p.getConfirmation({ ...principal, actorId: "other" }, "project-a", f.preparation.id)).toThrow();
  });
  it("公开严格字段关系不接受执行键/lease/私有连接和夹具改标", () => {
    const f = fixture({ manual: true }), p = f.port.createPreparation(principal, "project-a", f.selection());
    for (const bad of [{ ...p, mode: "production" }, { ...p, jobId: "fake" }, { ...p, connection: { ...p.connection, baseUrl: "https://private.invalid" } },
      { ...p, requestDraft: { ...p.requestDraft, idempotencyKey: "execution" } }, { ...p, constraint: { ...p.constraint, projectId: "other" } },
      { ...p, pricing: { ...p.pricing, quote: { ...p.pricing.quote, estimatedCostMinor: 0 } } }]) expect(ProductionImagePreparationPublicSchema.safeParse(bad).success).toBe(false);
  });
  it.each(["run:read", "provider:read", "asset:read", "run:confirm"])("确认或历史%s撤权先于私有读取", async permission => {
    const f = fixture(), p = f.port.createPreparation(principal, "project-a", f.selection()); f.deny(permission);
    const load = vi.spyOn(f.store, "loadProductionImagePreparation");
    await expect(f.port.confirmPreparation(principal, "project-a", p.id, expected(p))).rejects.toThrow();
    if (permission !== "run:confirm") expect(() => f.port.getConfirmation(principal, "project-a", p.id)).toThrow();
    expect(load).not.toHaveBeenCalled();
  });
  it.each(["async", "private-error", "cross-tenant"])("身份%s不泄私密异常或读库", async kind => {
    const f = fixture(), a = await api(f.port), load = vi.spyOn(f.store, "loadCatalog");
    vi.spyOn(f.auth, "authenticate").mockImplementation(() => { if (kind === "private-error") throw new Error("owned-secret-auth");
      return (kind === "async" ? Promise.resolve(principal) : { ...principal, tenantId: "other" }) as never; });
    const r = await a.request("", "POST", f.selection()); expect(r.ok).toBe(false); expect(JSON.stringify(await r.json())).not.toContain("owned-secret"); expect(load).not.toHaveBeenCalled();
  });
  it.each(["body-size", "confirm-size", "compressed", "escaped-id", "get-body"])("有界HTTP拒绝%s且不调用私有端口", async kind => {
    const f = fixture(), a = await api(f.port), create = vi.spyOn(f.port, "createPreparation"), confirm = vi.spyOn(f.port, "confirmPreparation"), read = vi.spyOn(f.port, "getConfirmation");
    const suffix = kind === "confirm-size" ? "/missing/confirm" : kind === "escaped-id" ? "/bad%2Fid/confirmation" : kind === "get-body" ? "/missing/confirmation" : "";
    const body = JSON.stringify(kind === "body-size" || kind === "confirm-size" ? { padding: "x".repeat(kind === "body-size" ? 128 * 1024 : 16 * 1024) } : {});
    const status = await new Promise<number>((resolve, reject) => { const req = httpRequest(a.base + suffix, { method: kind === "get-body" || kind === "escaped-id" ? "GET" : "POST",
      headers: { authorization: "Bearer writer", "content-type": "application/json", "content-length": Buffer.byteLength(body), ...(kind === "compressed" ? { "content-encoding": "gzip" } : {}) } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); }); req.on("error", reject); req.end(body); });
    expect(status).toBe(kind.endsWith("size") ? 413 : 400); expect(create).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it.each(["fault", "revoke"])("准备SQL写后%s回滚新记录，不修改旧用户状态", kind => {
    const f = fixture(), save = f.store.saveProductionImagePreparation.bind(f.store), catalog = f.store.loadCatalog(), state = f.store.load();
    vi.spyOn(f.store, "saveProductionImagePreparation").mockImplementation((...args) => { save(...args); if (kind === "revoke") f.deny("run:create"); else throw new Error("owned-secret-preparation"); });
    expect(() => f.port.createPreparation(principal, "project-a", f.selection())).toThrow(); expect(f.store.load()).toEqual(state); expect(f.store.loadCatalog()).toEqual(catalog);
    expect(f.store.loadProductionImagePreparationByAction(principal.tenantId, "project-a", "production-contract-fixture", f.selection().idempotencyKey)).toBeNull();
  });
  it.each(["revoke", "constraint"])("原包读后%s最终重查/回滚且清自有副本", async kind => {
    const t = await productionBillingTaskFixture({ edit: true }), f = t.f, p = new ImageProductionPublicHarness({ publicPreparationEnabled: true, tenantId: principal.tenantId,
      stateStore: f.store, runKernel: f.kernel, preparations: t.preparations, runAuthorizer: t.auth, providerAuthorizer: t.auth, assetAuthorizer: t.auth });
    const read = f.store.loadProductionImageResponse.bind(f.store), catalog = f.store.loadCatalog(), state = f.store.load(); let body: Buffer | undefined;
    vi.spyOn(f.store, "loadProductionImageResponse").mockImplementation((...a) => { const r = read(...a); body = r?.body;
      if (kind === "revoke") t.denied.add("asset:read"); else { const c = f.store.loadCatalog()!; c.projects[0].constraints[0].brandRules.style = "changed"; f.store.saveCatalog(c); } return r; });
    expect(() => p.getConfirmation({ ...principal, actorId: "other" }, "project-a", t.preparation.id)).toThrow(); expect(body?.every(v => v === 0)).toBe(true);
    expect(f.store.loadCatalog()).toEqual(catalog); expect(f.store.load()).toEqual(state);
    const original = read(principal.tenantId, "project-a", "production-contract-fixture", t.args[3])!; expect(original.body.some(v => v !== 0)).toBe(true); original.body.fill(0);
  });
  it.each([false, true])("实际独立结算后完整历史恢复%s有图，不借核账权或重验来源", async image => {
    const t = await productionBillingTaskFixture({ manual: image, edit: true, bad: !image }), f = t.f; if (image) await t.artifacts.ingest(...t.args);
    let billing!: ImageProductionBillingSettlementHarness; const source = { kind: "contract-fixture" as const, realExecutionEnabled: false as const, verify: vi.fn(() => true) };
    const kernel = new SqliteRunKernel({ ...t.kernelOptions, stateStore: f.store, authorizer: t.auth, budgets: f.store.load()!.budgets, clock: f.clock,
      productionImageBillingPolicy: { usesStateStore: s => billing?.billingPolicy.usesStateStore(s) ?? false, authorizeScope: (p,j,a) => billing?.billingPolicy.authorizeScope(p,j,a) ?? false,
        validateCommit: (p,r) => billing?.billingPolicy.validateCommit(p,r) ?? false } });
    const opts = { tenantId: principal.tenantId, stateStore: f.store, runKernel: kernel, runAuthorizer: t.auth, providerAuthorizer: t.auth, assetAuthorizer: t.auth, clock: f.clock, billingSource: source };
    billing = new ImageProductionBillingSettlementHarness({ ...opts, billingSettlementEnabled: true }); const review = new ImageProductionBillingReviewHarness({ ...opts, billingReviewEnabled: true });
    const actor = { ...principal, actorId: "other" }, args = [actor, "project-a", t.args[2], t.args[3]] as const, snapshot = review.inspect(...args);
    billing.settle(...args, { reviewId: "owned-public-review", expectedSnapshotFingerprint: fp(snapshot), expectedCurrency: snapshot.currency,
      expectedReservedMinor: snapshot.reservedMinor, expectedMaxCostMinor: snapshot.maxCostMinor, actualCostMinor: 25, resolution: "charged",
      evidence: { sourceId: "owned-bill", sourceVersion: "v1", evidenceRef: "owned-fake-only", checksumSha256: "a".repeat(64), observedAt: snapshot.unknownAt } });
    t.denied.add("run:reconcile-billing"); t.denied.add("run:execute"); t.denied.add("asset:write"); source.verify.mockClear(); t.price.read.mockClear(); t.price.verify.mockClear(); const state = f.store.load(), save = vi.spyOn(f.store, "save");
    const p = new ImageProductionPublicHarness({ ...opts, publicPreparationEnabled: true, preparations: t.preparations }), c = p.getConfirmation(actor, "project-a", t.preparation.id).confirmation!;
    expect(c.task).toMatchObject({ jobStatus: image ? "succeeded" : "failed", actualCostMinor: 25, estimatedCostMinor: image ? null : 25 });
    expect(c.task.outputAssetIds).toHaveLength(image ? 1 : 0); expect(JSON.stringify(c)).not.toMatch(/leaseId|workerId|idempotencyKey|evidenceRef.*owned-fake-only/);
    expect(f.store.load()).toEqual(state); expect(save).not.toHaveBeenCalled(); expect(source.verify).not.toHaveBeenCalled(); expect(t.price.verify).not.toHaveBeenCalled(); expect(t.price.read).not.toHaveBeenCalled(); expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("删除全部result并重算有效unknown任务不能使孤立原包变成无响应历史", async () => {
    const t = await productionBillingTaskFixture(), f = t.f, x = f.store.load()!, b = x.batches[0], j = b.aggregate.jobs[0];
    f.advance(30_000); j.finishedAt = new Date(f.clock()).toISOString(); j.failureCode = "production-lease-expired-after-intent";
    delete b.productionImageResult; delete b.productionImageResultFingerprint; b.aggregate.audit = b.aggregate.audit.filter(a => a.eventType !== "production-image-returned");
    const unknown = b.aggregate.audit.find(a => a.eventType === "billing-unknown")!; unknown.createdAt = j.finishedAt; unknown.metadata.reason = j.failureCode;
    b.aggregate.ledger.find(l => l.settlement === "unknown")!.createdAt = j.finishedAt; f.store.transaction(() => f.store.save(x));
    expect(() => f.kernel.validateProductionBillingSnapshot(x)).not.toThrow();
    const p = new ImageProductionPublicHarness({ publicPreparationEnabled: true, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel,
      preparations: t.preparations, runAuthorizer: t.auth, providerAuthorizer: t.auth, assetAuthorizer: t.auth });
    expect(() => p.getConfirmation({ ...principal, actorId: "other" }, "project-a", t.preparation.id)).toThrow(); expect(t.send).toHaveBeenCalledTimes(1);
  });
  it.each([0, 40])("已取消%d上限只读恢复原未知估价及取消结论，不重新预留", async cap => {
    const f = fixture({ manual: true, cap }), p = f.port.createPreparation(principal, "project-a", f.selection()), c = await f.port.confirmPreparation(principal, "project-a", p.id, expected(p));
    f.kernel.cancelBatch(principal, c.task.batchId); const state = f.store.load(), save = vi.spyOn(f.store, "save"); f.price.read.mockClear(); f.price.verify.mockClear();
    const h = f.port.getConfirmation(principal, "project-a", p.id); expect(h.confirmation!.task).toMatchObject({ jobStatus: "cancelled", estimatedCostMinor: null });
    expect(h.confirmation!.task.actualCostMinor).toBeUndefined(); // Unsent cancellation does not fabricate a measured fee.
    expect(await f.port.confirmPreparation(principal, "project-a", p.id, expected(p))).toEqual(h.confirmation); expect(f.store.load()).toEqual(state);
    expect(save).not.toHaveBeenCalled(); expect(f.price.verify).not.toHaveBeenCalled(); expect(f.price.read).not.toHaveBeenCalled();
  });
  it("无声明chunked正文实际超限失败关闭而不截断调用创建", async () => {
    const f = fixture(), a = await api(f.port), create = vi.spyOn(f.port, "createPreparation");
    const outcome = await new Promise<number | string>((resolve) => { const req = httpRequest(a.base, { method: "POST", headers: { authorization: "Bearer writer", "content-type": "application/json", "transfer-encoding": "chunked" } }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode!)); }); req.on("error", e => resolve((e as NodeJS.ErrnoException).code ?? "closed"));
      req.end(JSON.stringify({ padding: "x".repeat(129 * 1024) })); });
    expect([413, "ECONNRESET", "EPIPE"]).toContain(outcome); expect(create).not.toHaveBeenCalled(); expect(f.price.read).not.toHaveBeenCalled();
  });
  it.each(["supportsProductionImageResponses", "supportsProductionImageArtifacts"] as const)("%s关闭不能跳过孤立原包/产物核验", method => {
    const f = fixture(), p = f.port.createPreparation(principal, "project-a", f.selection()), read = vi.spyOn(f.store, "loadProductionImagePreparation");
    vi.spyOn(f.store, method).mockReturnValue(false); expect(() => f.port.getConfirmation(principal, "project-a", p.id)).toThrow(); expect(read).not.toHaveBeenCalled();
  });
});
