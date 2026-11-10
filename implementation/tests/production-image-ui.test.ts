import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { ProductionImageUiScopeSchema, ProductionImageRecoverySchema, type ProductionImageUiScope } from "../packages/contracts/src/index";
import { ProductionImageClient } from "../apps/web/src/runs/productionImageClient";
import { productionRecoveryKey, readProductionRecovery, saveProductionRecovery } from "../apps/web/src/runs/productionImageRecovery";
import { productionPublicFixture } from "./helpers/production-public-fixture";
import { principal } from "./helpers/image-task-fixture";
import { createApiServer } from "../apps/api/src/index";

const owned: ReturnType<typeof productionPublicFixture>[] = [], servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((resolve, reject) => s.close(e => e ? reject(e) : resolve())); } for (const f of owned.splice(0)) f.cleanup(); });
const scope: ProductionImageUiScope = { preparationUiEnabled: true, tenantId: principal.tenantId, mode: "production-contract-fixture" };
const fixture = (o: Parameters<typeof productionPublicFixture>[0] = {}) => { const f = productionPublicFixture(o); owned.push(f); return f; };
const client = (s = scope, signal = new AbortController().signal) => new ProductionImageClient(s, signal);
const reply = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": "private,no-store", ...headers } });
async function confirmed(f: ReturnType<typeof fixture>) {
  const p = f.port.createPreparation(principal, "project-a", f.selection());
  const q = p.pricing.quote, c = await f.port.confirmPreparation(principal, "project-a", p.id, { expectedSnapshotFingerprint: p.snapshotFingerprint, expectedPricingFingerprint: p.pricingFingerprint,
    expectedCurrency: q.currency, expectedMaxCostMinor: q.maxCostMinor, estimate: q.source === "manual-budget" ? { state: "unknown" } : { state: "known", expectedEstimatedCostMinor: q.estimatedCostMinor } });
  return { p, c };
}
describe("6D8B 独立生产客户端和有界只读指针", () => {
  it.each([{}, { ...scope, preparationUiEnabled: false }, { ...scope, mode: "local-fixture" }, { ...scope, url: "https://private.invalid" }])("显式严格配置 %j，不能从local改标或浏览器地址启用", config => {
    expect(ProductionImageUiScopeSchema.safeParse(config).success).toBe(false); expect(() => client(config as never)).toThrow();
  });
  for (const protocol of ["openai", "openai-compatible", "google"] as const) for (const manual of [false, true]) it(`${protocol}/${manual} 客户端实际HTTP临时SQLite准备/人工确认/只读恢复`, async () => {
    const f = fixture({ protocol, manual, edit: true }), s = createApiServer({ productionImagePreparations: f.port }); servers.push(s);
    await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve)); const a = s.address(); if (!a || typeof a === "string") throw new Error();
    const actualFetch = globalThis.fetch, fetcher = vi.fn((path: string, options: RequestInit) => actualFetch(`http://127.0.0.1:${a.port}${path.replace(/^\/studio-api/, "")}`, { ...options, headers: { ...options.headers, authorization: "Bearer writer" } })); vi.stubGlobal("fetch", fetcher);
    const api = client(), p = await api.prepare(f.selection()); expect(f.kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
    expect(await api.history(p)).toBeNull(); const c = await api.confirm(p); expect(c.task.estimatedCostMinor).toBe(manual ? null : 25); expect(c.task.currentMaxCostMinor).toBe(40);
    const calls = fetcher.mock.calls, body = JSON.parse(calls[2][1].body as string);
    expect(body).toEqual({ expectedSnapshotFingerprint: p.snapshotFingerprint, expectedPricingFingerprint: p.pricingFingerprint, expectedCurrency: "CNY", expectedMaxCostMinor: 40,
      estimate: manual ? { state: "unknown" } : { state: "known", expectedEstimatedCostMinor: 25 } });
    expect(calls[2][0]).toMatch(/production-image-preparations\/[^/]+\/confirm$/); expect(calls[2][1]).toMatchObject({ cache: "no-store", redirect: "error", credentials: "same-origin" });
    const before = f.store.load(); f.advance(61_000); f.register({ ...f.config, enabled: false, revision: 2 }); f.price.read.mockClear(); f.price.verify.mockClear();
    expect(await api.history(await api.preparation("project-a", p.id))).toEqual(c); expect(f.store.load()).toEqual(before); expect(f.price.read).not.toHaveBeenCalled(); expect(f.price.verify).not.toHaveBeenCalled();
    expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0 }); expect(before?.batches[0].productionImageAttempt).toBeUndefined();
  });
  it.each([false, true])("从头生产工厂 %s 估价，不改标夹具；拒绝相反模式", async manual => {
    const f = fixture({ production: true, manual }), { p, c } = await confirmed(f), fetcher = vi.fn().mockResolvedValue(reply(c)); vi.stubGlobal("fetch", fetcher);
    expect(await client({ ...scope, mode: "production" }).confirm(p)).toEqual(c);
    await expect(client().confirm(p)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["tenant", "mode", "project", "preparation", "pricing", "constraint", "creator", "adapter", "inputs", "time", "transform", "private"])("错配 %s 关闭，不补发确认", async damage => {
    const f = fixture({ edit: true }), { p, c } = await confirmed(f), altered = structuredClone(c);
    if (damage === "tenant") altered.tenantId = "foreign"; if (damage === "mode") altered.mode = "production";
    if (damage === "project") altered.projectId = "foreign"; if (damage === "preparation") altered.preparationFingerprint = "1".repeat(64);
    if (damage === "pricing") altered.pricingFingerprint = "1".repeat(64); if (damage === "constraint") altered.task.constraintSnapshotId = "foreign";
    if (damage === "creator") altered.confirmedBy = "foreign"; if (damage === "adapter") altered.task.adapterId = "foreign";
    if (damage === "inputs") altered.task.inputAssetIds.reverse(); if (damage === "time") altered.confirmedAt = "2100-01-01T00:00:00.000Z";
    if (damage === "transform") altered.transformedInputs[0].originalChecksumSha256 = "1".repeat(64); if (damage === "private") Object.assign(altered, { workerId: "private" });
    const fetcher = vi.fn().mockResolvedValue(reply(altered)); vi.stubGlobal("fetch", fetcher);
    await expect(client().confirm(p)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["brand", "region", "dimensions"])("完整原约束 %s 篡改保留SHA在POST前拒绝", async damage => {
    const f = fixture(), { p } = await confirmed(f);
    if (damage === "brand") p.constraint.brandRules.tone = "篡改"; if (damage === "region") p.constraint.editableRegions.push({ id: "new", description: "篡改" });
    if (damage === "dimensions") p.constraint.outputSpec.width = 4096;
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
    const waiting = new AbortController(), cancel = vi.fn(); fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
    const result = client(scope, waiting.signal).history(p); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); waiting.abort(); await expect(result).rejects.toThrow(); expect(cancel).toHaveBeenCalled(); expect(fetcher.mock.calls[0][1].method).toBe("GET");
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
    const p = { schemaVersion: 1 as const, tenantId: scope.tenantId, projectId: "project-a", mode: scope.mode, actionId: "human-action", stage: "prepared" as const,
      preparationId: "original", preparationFingerprint: "a".repeat(64), pricingFingerprint: "b".repeat(64) }, raw = JSON.stringify(p);
    expect(readProductionRecovery(raw, scope, p.projectId)).toEqual(p); expect(readProductionRecovery(null, scope, p.projectId)).toBeNull();
    const storage = { setItem: vi.fn(), getItem: vi.fn().mockReturnValue(raw) }; saveProductionRecovery(storage, scope, p); expect(storage.setItem).toHaveBeenCalledWith(productionRecoveryKey(scope, p.projectId), raw);
    storage.getItem.mockReturnValue(null); expect(() => saveProductionRecovery(storage, scope, p)).toThrow(); storage.setItem.mockImplementation(() => { throw new Error("full"); }); expect(() => saveProductionRecovery(storage, scope, p)).toThrow();
    for (const altered of [{ ...p, tenantId: "foreign" }, { ...p, projectId: "foreign" }, { ...p, mode: "production" }, { ...p, pricingFingerprint: undefined }, { ...p, stage: "preparing" }, { ...p, quote: {} }, { ...p, selection: {} }, { ...p, executionAuthorized: true }]) expect(() => readProductionRecovery(JSON.stringify(altered), scope, p.projectId)).toThrow();
    expect(() => readProductionRecovery("x".repeat(16 * 1024 + 1), scope, p.projectId)).toThrow(); expect(ProductionImageRecoverySchema.safeParse({ ...p, stage: "confirm-submitted" }).success).toBe(true);
    expect(productionRecoveryKey(scope, p.projectId)).not.toContain("image-confirmation."); expect(productionRecoveryKey({ ...scope, mode: "production" }, p.projectId)).not.toBe(productionRecoveryKey(scope, p.projectId));
  });
});
