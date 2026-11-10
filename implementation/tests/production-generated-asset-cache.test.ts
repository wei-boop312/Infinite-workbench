import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { ProductionGeneratedReadScopeSchema, type ProductionGeneratedAssetLineage } from "../packages/contracts/src/index";
import { ProductionGeneratedAssetClient } from "../apps/web/src/runs/productionGeneratedAssetClient";
import { productionCacheIdentity, productionMarkerMatches, ProductionReadLifetime } from "../apps/web/src/assets/productionGeneratedAssetPolicy";
import { ownedProductionBillingTask } from "./helpers/production-billing-task-core";
import { ImageProductionGeneratedAssetReadHarness } from "../apps/api/src/productionGeneratedAssetReads";
import { createApiServer } from "../apps/api/src/index";
import { principal } from "./helpers/image-task-fixture";

const scope = { generatedReadUiEnabled: true as const, tenantId: principal.tenantId, mode: "production-contract-fixture" as const };
let base: Awaited<ReturnType<typeof ownedProductionBillingTask>>, view: ProductionGeneratedAssetLineage;
const owned: typeof base[] = [], servers: Server[] = [];
const reader = (t: typeof base) => new ImageProductionGeneratedAssetReadHarness({ generatedReadEnabled: true, tenantId: principal.tenantId,
  stateStore: t.f.store, runKernel: t.f.kernel, assetAuthorizer: t.auth, runAuthorizer: t.auth });
beforeAll(async () => { base = await ownedProductionBillingTask({ edit: true }); await base.artifacts.ingest(...base.args); view = reader(base).lineage(principal, "project-a", base.saved().productionImageArtifact!.image.asset.id); });
afterAll(() => base.f.cleanup());
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } for (const t of owned.splice(0)) t.f.cleanup(); });
const reply = (v: unknown, headers: Record<string, string> = {}) => { const text = JSON.stringify(v); return new Response(text, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private,no-store", "content-length": String(Buffer.byteLength(text)), ...headers } }); };
const content = (v = view, bytes = base.output, headers: Record<string, string> = {}) => new Response(Uint8Array.from(bytes), { headers: {
  "content-type": v.image.asset.mimeType, "content-length": String(v.image.asset.byteSize), "cache-control": "private,no-store", "x-content-sha256": v.image.checksumSha256,
  "x-canvas-binary-version": "production-generated-image-v1", "x-canvas-image-mode": v.mode, "x-canvas-artifact-sha256": v.artifactFingerprint, ...headers } });
function setup(responses: Response[] = [reply(view), content(), reply(view)], abort = new AbortController()) {
  const fetcher = vi.fn(); for (const response of responses) fetcher.mockResolvedValueOnce(response); vi.stubGlobal("fetch", fetcher);
  const repository = { cacheProductionGenerated: vi.fn(async (v, _b, signal, reauthorize) => { signal.throwIfAborted(); await reauthorize(); return v.image.asset; }) };
  return { api: new ProductionGeneratedAssetClient(scope, abort.signal), fetcher, repository, abort };
}
describe("6D9B production original cache boundary", () => {
  it.each([{}, { ...scope, generatedReadUiEnabled: false }, { ...scope, mode: "local-fixture" }, { ...scope, preparationUiEnabled: true }])("strict independent host scope %j", v => {
    expect(ProductionGeneratedReadScopeSchema.safeParse(v).success).toBe(false); expect(() => new ProductionGeneratedAssetClient(v as never, new AbortController().signal)).toThrow();
  });
  for (const protocol of ["openai", "openai-compatible", "google"] as const) for (const manual of [false, true]) it(`${protocol}/${manual} actual HTTP + full task SQLite read-only cache input`, async () => {
    const t = await ownedProductionBillingTask({ protocol, manual, edit: true }, fn => vi.fn(fn)); owned.push(t); await t.artifacts.ingest(...t.args);
    const s = createApiServer({ productionGeneratedAssets: reader(t) }); servers.push(s); await new Promise<void>(r => s.listen(0, "127.0.0.1", r)); const address = s.address(); if (!address || typeof address === "string") throw new Error();
    const before = t.f.store.load(), native = globalThis.fetch, fetcher = vi.fn((path: string, options: RequestInit) => native(`http://127.0.0.1:${address.port}${path.replace(/^\/studio-api/, "")}`, options)); vi.stubGlobal("fetch", fetcher);
    t.price.read.mockClear(); t.price.verify.mockClear();
    const port = { cacheProductionGenerated: vi.fn(async (v: ProductionGeneratedAssetLineage, blob: Blob, signal: AbortSignal, auth: () => Promise<ProductionGeneratedAssetLineage>) => {
      expect(Buffer.from(await blob.arrayBuffer())).toEqual(t.output); expect(v.billing.estimatedMinor).toBe(manual ? null : 25); signal.throwIfAborted(); expect(await auth()).toEqual(v); return v.image.asset;
    }) };
    const id = t.saved().productionImageArtifact!.image.asset.id;
    expect(await new ProductionGeneratedAssetClient(scope, new AbortController().signal).cache("project-a", id, port)).toEqual(t.saved().productionImageArtifact!.image.asset);
    expect(fetcher.mock.calls.map(([p]) => p.split("/").at(-1))).toEqual(["lineage", "content", "lineage"]);
    for (const [, o] of fetcher.mock.calls) expect(o).toMatchObject({ method: "GET", cache: "no-store", redirect: "error", credentials: "same-origin", mode: "same-origin", referrerPolicy: "no-referrer" });
    expect(t.f.store.load()).toEqual(before); expect(t.price.read).not.toHaveBeenCalled(); expect(t.price.verify).not.toHaveBeenCalled(); expect(t.send).toHaveBeenCalledTimes(1);
  });
  it.each(["tenant", "project", "asset", "mode", "constraint", "private", "bytes", "pixels", "estimate", "transform"])("lineage %s mismatch fails before content/IDB", damage => {
    const v = structuredClone(view);
    if (damage === "tenant") v.tenantId = "other"; if (damage === "project") v.projectId = "other"; if (damage === "asset") v.image.asset.id = "other";
    if (damage === "mode") v.mode = "production"; if (damage === "constraint") v.constraint.brandRules.style = "drift"; if (damage === "private") (v as any).workerId = "secret";
    if (damage === "bytes") v.image.asset.byteSize = 20 * 1024 * 1024 + 1; if (damage === "pixels") v.image.asset.width = v.image.asset.height = 4096;
    if (damage === "estimate") v.billing.estimatedMinor = 0; if (damage === "transform") v.transformedInputs[0].originalChecksumSha256 = "0".repeat(64);
    const f = setup([reply(v)]); return expect(f.api.cache("project-a", view.image.asset.id, f.repository)).rejects.toThrow().then(() => { expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.repository.cacheProductionGenerated).not.toHaveBeenCalled(); });
  });
  it.each([{"x-canvas-binary-version":"generated-image-v1"},{"x-canvas-image-mode":"production"},{"x-canvas-artifact-sha256":"0".repeat(64)}, {"content-length":"1"}, {"x-content-sha256":"0".repeat(64)}, {"content-type":"image/webp"}, {"content-encoding":"gzip"}, {"cache-control":"public"}])("content headers %j cannot use local markers", async headers => {
    const f = setup([reply(view), content(view, base.output, headers)]); await expect(f.api.cache("project-a", view.image.asset.id, f.repository)).rejects.toThrow(); expect(f.repository.cacheProductionGenerated).not.toHaveBeenCalled();
  });
  it.each(["truncated", "changed", "oversize"])("%s original rejected before IDB", async bad => {
    const bytes = bad === "truncated" ? base.output.subarray(0, 16) : Buffer.alloc(base.output.length + (bad === "oversize" ? 1 : 0)); const f = setup([reply(view), content(view, bytes)]);
    await expect(f.api.cache("project-a", view.image.asset.id, f.repository)).rejects.toThrow(); expect(f.repository.cacheProductionGenerated).not.toHaveBeenCalled();
  });
  it("fresh final server permission denied, never uses old view or retries", async () => {
    const f = setup([reply(view), content(), new Response("private-denied", { status: 403 })]); await expect(f.api.cache("project-a", view.image.asset.id, f.repository)).rejects.toThrow(/读取被拒绝/); expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it("fresh final immutable relation drift rejected, but legitimate fee settlement is the same artifact", async () => {
    const v = structuredClone(view); v.preparationFingerprint = "1".repeat(64); const f = setup([reply(view), content(), reply(v)]);
    await expect(f.api.cache("project-a", view.image.asset.id, f.repository)).rejects.toThrow(/冻结关系/);
    const settled = structuredClone(view); settled.jobStatus = "succeeded"; settled.billing = { ...settled.billing, state: "settled", reservedMinor: 0, actualMinor: 65, currentMaxCostMinor: 65 };
    const good = setup([reply(view), content(), reply(settled)]); await expect(good.api.cache("project-a", view.image.asset.id, good.repository)).resolves.toEqual(view.image.asset);
    expect(productionCacheIdentity(settled)).toBe(productionCacheIdentity(view));
  });
  it("independent full marker validates historical projection without granting current permission", () => {
    const marker = { version: 1 as const, assetId: view.image.asset.id, tenantId: view.tenantId, projectId: view.projectId, mode: view.mode, identity: productionCacheIdentity(view), lineage: view };
    expect(productionMarkerMatches(marker, view)).toBe(true);
    for (const damaged of [{ ...marker, mode: "local-fixture" }, { ...marker, lineage: { ...view, billing: { ...view.billing, actualMinor: 0 } } }, { ...marker, authority: true }, { ...marker, identity: "partial" }]) expect(productionMarkerMatches(damaged as never, view)).toBe(false);
  });
  it.each(["utf8", "over", "empty", "fragments", "compressed", "type", "length"])("bounded %s lineage fails closed", async bad => {
    let response: Response;
    if (["empty", "fragments"].includes(bad)) response = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(bad === "empty" ? [] : [32])); } }), { headers: { "content-length": "1", "content-type": "application/json", "cache-control": "no-store" } });
    else if (bad === "utf8") response = new Response(new Uint8Array([255]), { headers: { "content-length": "1", "content-type": "application/json", "cache-control": "no-store" } });
    else response = reply(view, bad === "over" ? { "content-length": "524289" } : bad === "compressed" ? { "content-encoding": "gzip" } : bad === "type" ? { "content-type": "text/html" } : { "content-length": "1" });
    const f = setup([response]); await expect(f.api.cache("project-a", view.image.asset.id, f.repository)).rejects.toThrow(); expect(f.repository.cacheProductionGenerated).not.toHaveBeenCalled();
  });
  it("non-cooperative fetch does not extend waiting or free an occupied slot; late response is discarded", async () => {
    const resolvers: Array<(r: Response) => void> = [], fetcher = vi.fn(() => new Promise<Response>(r => resolvers.push(r))); vi.stubGlobal("fetch", fetcher);
    const a = new AbortController(), b = new AbortController(), x = new ProductionGeneratedAssetClient(scope, a.signal), y = new ProductionGeneratedAssetClient(scope, b.signal);
    const pending = Promise.allSettled([x.cache("project-a", view.image.asset.id), y.cache("project-a", view.image.asset.id)]); a.abort(); b.abort(); await pending;
    await expect(new ProductionGeneratedAssetClient(scope, new AbortController().signal).cache("project-a", view.image.asset.id)).rejects.toThrow(/正在进行/);
    for (const resolve of resolvers) resolve(reply(view)); await new Promise(r => setTimeout(r, 0)); const f = setup(); await expect(f.api.cache("project-a", view.image.asset.id, f.repository)).resolves.toEqual(view.image.asset);
  });
  it("absolute timeout rejects a non-cooperative operation, delayed bitmap cleanup retains slot", async () => {
    vi.useFakeTimers(); let finish!: (v: { close: () => void }) => void; const close = vi.fn(), life = new ProductionReadLifetime(new AbortController().signal, "owned-native-test");
    const waiting = life.wait(new Promise<{ close: () => void }>(r => { finish = r; }), v => v.close()), rejection = expect(waiting).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30001); await rejection; life.close(); finish({ close }); await Promise.resolve(); expect(close).toHaveBeenCalledTimes(1);
  });
  it("verification reauthorizes after local decode and never requests binary/task/billing routes", async () => {
    const f = setup([reply(view), reply(view)]), readProductionGenerated = vi.fn(async v => v.image.asset);
    expect(await f.api.verifyCached("project-a", view.image.asset.id, { readProductionGenerated })).toEqual({ view, asset: view.image.asset }); expect(readProductionGenerated).toHaveBeenCalledTimes(1);
    expect(f.fetcher.mock.calls.every(([p]) => p.endsWith("/lineage"))).toBe(true);
  });
});
