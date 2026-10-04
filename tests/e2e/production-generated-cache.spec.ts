import { expect, test, type Page } from "@playwright/test";
import { ownedProductionBillingTask } from "../helpers/production-billing-task-core";
import { ImageProductionGeneratedAssetReadHarness } from "../../apps/api/src/productionGeneratedAssetReads";
import { createApiServer } from "../../apps/api/src/index";
import { principal } from "../helpers/image-task-fixture";
import { SqliteRunKernel } from "../../apps/api/src/sqliteRunKernel";
import { ImageProductionBillingSettlementHarness } from "../../apps/api/src/productionImageBillingSettlement";
import { ImageProductionBillingReviewHarness } from "../../apps/api/src/productionImageBillingReview";
import { imageSnapshotFingerprint as fp } from "../../apps/api/src/imageProviderContract";

test.use({ serviceWorkers: "block" });
const cleanups: Array<() => Promise<void>> = [];
test.afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(page: Page, options: Parameters<typeof ownedProductionBillingTask>[0] = {}) {
  const t = await ownedProductionBillingTask(options); await t.artifacts.ingest(...t.args);
  const r = new ImageProductionGeneratedAssetReadHarness({ generatedReadEnabled: true, tenantId: principal.tenantId, stateStore: t.f.store, runKernel: t.f.kernel, assetAuthorizer: t.auth, runAuthorizer: t.auth });
  const id = t.saved().productionImageArtifact!.image.asset.id, view = r.lineage(principal, "project-a", id), before = t.f.store.load();
  const server = createApiServer({ productionGeneratedAssets: r }); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error(); const origin = `http://127.0.0.1:${address.port}`;
  const requests: { method: string; path: string }[] = []; let hold = false, corrupt = false, finalDenied = false, reads = 0, release: (() => void) | undefined;
  cleanups.push(async () => { hold = false; release?.(); await page.unrouteAll({ behavior: "wait" }); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); t.f.cleanup(); });
  // Owned browser project metadata is test setup, NOT a production UI switch.
  await page.addInitScript(() => {
    localStorage.setItem("ai-commerce-canvas.imported-projects", JSON.stringify([{ documentId: "owned-production-cache-doc", projectId: "project-a", label: "自有缓存测试项目", importedAt: "2026-10-04T00:00:00Z" }]));
    localStorage.setItem("ai-commerce-canvas.active-document", "owned-production-cache-doc");
  });
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(), original = await response.text(), text = original.replace("jsxDEV(App, {},", 'jsxDEV(App, { productionGeneratedRead: { generatedReadUiEnabled: true, tenantId: "tenant-a", mode: "production-contract-fixture" } },');
    if (text === original) throw new Error("owned trusted App configuration injection failed"); await route.fulfill({ response, body: text });
  });
  await page.route(/\/studio-api\/v1\/projects\/[^/]+\/production-generated-assets\/[^/]+\/(?:lineage|content)$/, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/studio-api/, ""); requests.push({ method: route.request().method(), path });
    if (path.endsWith("/lineage")) { reads++; if (finalDenied && reads >= 2) t.denied.add("run:read"); }
    const response = await route.fetch({ url: origin + path, maxRedirects: 0 });
    if (hold && path.endsWith("/content")) await new Promise<void>(resolve => { release = resolve; });
    if (corrupt && path.endsWith("/content")) await route.fulfill({ response, body: Buffer.alloc(t.output.length) });
    else await route.fulfill({ response });
  });
  await page.goto("/"); await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  const panel = page.getByRole("region", { name: "生产原图只读缓存" }); await expect(panel).toBeVisible(); await panel.getByLabel("生产原图资产编号").fill(id);
  const cache = async () => { await panel.getByRole("button", { name: "缓存生产原图", exact: true }).click(); await expect(panel.getByRole("status")).toContainText("已缓存"); };
  return { t, id, view, before, panel, requests, cache, setHold: () => { hold = true; }, release: () => { hold = false; release?.(); }, corrupt: () => { corrupt = true; }, finalDeny: () => { finalDenied = true; } };
}
async function cached(page: Page, id: string) {
  return page.evaluate(async id => {
    const { assetRepository } = await import("/src/assets/assetRepository.ts");
    const original = await assetRepository.getBlob(id, "original"), proxy = await assetRepository.getBlob(id, "proxy");
    const request = indexedDB.open("ai-commerce-canvas-assets"); const db = await new Promise<IDBDatabase>((r,j) => { request.onsuccess = () => r(request.result); request.onerror = () => j(request.error); });
    try {
      const tx = db.transaction(["productionGeneratedCaches", "generatedCaches"], "readonly"), read = (name: string) => new Promise<any>((r,j) => { const q = tx.objectStore(name).get(id); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
      const [marker, local] = await Promise.all([read("productionGeneratedCaches"), read("generatedCaches")]);
      return { assets: await assetRepository.list("project-a"), bytes: original?.size ?? 0, type: original?.type, proxyBytes: proxy?.size ?? 0,
        marker, local, sha: original ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await original.arrayBuffer())), n => n.toString(16).padStart(2,"0")).join("") : null };
    } finally { db.close(); }
  }, id);
}
for (const protocol of ["openai", "openai-compatible", "google"] as const) for (const manual of [false, true]) test(`${protocol}/${manual} actual artifact HTTP + IndexedDB cache/replay/fresh read/reload`, async ({ page }) => {
  const f = await fixture(page, { protocol, manual, edit: true }); const nodes = await page.locator(".react-flow__node").count(); await f.cache();
  const c = await cached(page, f.id); expect(c.assets).toEqual([f.view.image.asset]); expect(c.bytes).toBe(f.t.output.length); expect(c.sha).toBe(f.view.image.checksumSha256); expect(c.proxyBytes).toBeGreaterThan(0); expect(c.local).toBeUndefined();
  expect(c.marker.lineage).toEqual(f.view); expect(c.marker).toMatchObject({ version: 1, mode: "production-contract-fixture", tenantId: principal.tenantId });
  await f.cache(); expect((await cached(page, f.id)).assets).toHaveLength(1); await f.panel.getByRole("button", { name: "重新核验生产原图缓存" }).click(); await expect(f.panel.getByRole("status")).toContainText("已核验");
  await expect(f.panel.getByRole("article", { name: "生产原图谱系摘要" })).toContainText(manual ? "未知（不是零费用）" : "CNY 25 最小单位"); expect(f.view.requestDraft.inputs[0].assetId).toBe("source");
  expect(await page.locator(".react-flow__node").count()).toBe(nodes); expect(f.t.f.store.load()).toEqual(f.before); expect(f.requests.every(r => r.method === "GET" && /\/(lineage|content)$/.test(r.path))).toBe(true);
  const legacy = await page.evaluate(async ({ image, view }) => { const { assetRepository } = await import("/src/assets/assetRepository.ts"); let error = ""; try { await assetRepository.readGenerated(image, new AbortController().signal); } catch (e) { error = String(e); } return { error, same: await assetRepository.readProductionGenerated(view, new AbortController().signal) }; }, { image: f.view.image, view: f.view });
  expect(legacy.error).not.toBe(""); expect(legacy.same).toEqual(f.view.image.asset);
  await page.reload(); await page.getByRole("button", { name: "资产库 1" }).click(); const library = page.getByRole("complementary", { name: "项目资产库" }); await expect(library.locator("img")).toBeVisible(); await expect(library.getByRole("button", { name: "添加到画布" })).toBeDisabled(); expect(f.t.f.store.load()).toEqual(f.before);
});
for (const protocol of ["openai", "openai-compatible", "google"] as const) test(`${protocol} original generate task is cached without an edit or new execution`, async ({ page }) => {
  const f = await fixture(page, { protocol, manual: true, edit: false }); await f.cache();
  expect(f.view.requestDraft.operation).toBe("generate"); expect(f.view.requestDraft.inputs).toEqual([]); expect(f.view.transformedInputs).toEqual([]);
  expect((await cached(page, f.id)).sha).toBe(f.view.image.checksumSha256); expect(f.t.f.store.load()).toEqual(f.before);
});
test("repository freezes complete input before the first await for cache and read", async ({ page }) => {
  const f = await fixture(page);
  const result = await page.evaluate(async ({ view, bytes }) => {
    const { assetRepository } = await import("/src/assets/assetRepository.ts"), signal = new AbortController().signal;
    const input = structuredClone(view), original = new Blob([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], { type: view.image.asset.mimeType });
    const pending = assetRepository.cacheProductionGenerated(input, original, signal, async () => structuredClone(view)); input.constraint.brandRules.style = "caller-mutated-after-call";
    const cached = await pending, readInput = structuredClone(view), reading = assetRepository.readProductionGenerated(readInput, signal); readInput.constraint.brandRules.style = "caller-mutated-after-read";
    return { cached, read: await reading };
  }, { view: f.view, bytes: f.t.output.toString("base64") });
  expect(result).toEqual({ cached: f.view.image.asset, read: f.view.image.asset }); expect(f.t.f.store.load()).toEqual(f.before);
});
for (const bad of ["bytes", "permission"] as const) test(`${bad} download/final reauthorization failure leaves no cache or new request`, async ({ page }) => {
  const f = await fixture(page); if (bad === "bytes") f.corrupt(); else f.finalDeny();
  await f.panel.getByRole("button", { name: "缓存生产原图", exact: true }).click(); await expect(f.panel.getByRole("alert")).toBeVisible();
  const c = await cached(page, f.id); expect(c.assets).toHaveLength(0); expect(c.bytes).toBe(0); expect(c.marker).toBeUndefined(); expect(f.t.f.store.load()).toEqual(f.before); expect(f.requests).toHaveLength(bad === "bytes" ? 2 : 3);
});
test("actual IDB write-after failure and cancellation roll back metadata/original/proxy/independent marker", async ({ page }) => {
  const f = await fixture(page);
  for (const kind of ["failure", "abort"] as const) {
    await page.evaluate(({ id, kind }) => { const put = IDBObjectStore.prototype.put; (window as any).__ownedPut = put; IDBObjectStore.prototype.put = function(value, ...args) {
      const request = put.call(this, value, ...args); if (this.name === "blobs" && value.assetId === id) { if (kind === "failure") throw new Error("owned-write-after"); this.transaction.abort(); } return request;
    }; }, { id: f.id, kind });
    await f.panel.getByRole("button", { name: "缓存生产原图", exact: true }).click(); await expect(f.panel.getByRole("alert")).toBeVisible(); const c = await cached(page, f.id); expect(c.assets).toHaveLength(0); expect(c.bytes).toBe(0); expect(c.proxyBytes).toBe(0); expect(c.marker).toBeUndefined();
    await page.evaluate(() => { IDBObjectStore.prototype.put = (window as any).__ownedPut; });
  }
  await f.cache(); expect((await cached(page, f.id)).assets).toHaveLength(1); expect(f.t.f.store.load()).toEqual(f.before);
});
for (const bad of ["marker", "local-marker", "original", "metadata", "sha", "lineage"] as const) test(`damaged ${bad} cached snapshot fails, preserves offline original and task budget`, async ({ page }) => {
  const f = await fixture(page); await f.cache();
  await page.evaluate(async ({ id, bad }) => {
    const q = indexedDB.open("ai-commerce-canvas-assets"), db = await new Promise<IDBDatabase>(r => { q.onsuccess = () => r(q.result); });
    const tx = db.transaction(["assets","blobs","productionGeneratedCaches","generatedCaches"],"readwrite"), store = tx.objectStore(bad === "metadata" ? "assets" : bad === "sha" || bad === "original" ? "blobs" : "productionGeneratedCaches");
    if (bad === "marker" || bad === "local-marker") { store.delete(id); if (bad === "local-marker") tx.objectStore("generatedCaches").put({ assetId:id, projectId:"project-a", tenantId:"tenant-a" }); }
    else if (bad === "original") store.delete(`${id}:original`);
    else { const r = store.get(bad === "sha" ? `${id}:original` : id); r.onsuccess = () => { const v = r.result; if (bad === "sha") v.blob = new Blob([new Uint8Array(v.blob.size)],{type:v.blob.type}); else if (bad === "metadata") v.originalName = "drift.png"; else v.lineage.preparationFingerprint = "0".repeat(64); store.put(v); }; }
    await new Promise<void>((r,j) => { tx.oncomplete=()=>r();tx.onabort=()=>j(tx.error); }); db.close();
  }, { id: f.id, bad });
  await f.panel.getByRole("button", { name: "重新核验生产原图缓存" }).click(); await expect(f.panel.getByRole("alert")).toBeVisible(); const c = await cached(page, f.id); expect(c.assets).toHaveLength(1); if (bad !== "original") expect(c.bytes).toBe(f.t.output.length); expect(f.t.f.store.load()).toEqual(f.before);
});
test("ordinary restore/copy IDs cannot acquire production cache mark; foreign global ID is never overwritten", async ({ page }) => {
  const f = await fixture(page);
  await page.evaluate(async ({ asset, bytes }) => { const { assetRepository } = await import("/src/assets/assetRepository.ts"), original = new Blob([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))],{type:asset.mimeType}); await assetRepository.restore("project-a", [{ asset, original }]); }, { asset: f.view.image.asset, bytes: f.t.output.toString("base64") });
  await f.panel.getByRole("button", { name: "缓存生产原图", exact: true }).click(); await expect(f.panel.getByRole("alert")).toContainText("冲突"); expect((await cached(page, f.id)).marker).toBeUndefined();
  const copy = await page.evaluate(async ({ view, bytes }) => {
    const { assetRepository } = await import("/src/assets/assetRepository.ts"), copied = structuredClone(view); copied.image.asset.id = "owned-imported-copy";
    await assetRepository.restore("project-a", [{ asset: copied.image.asset, original: new Blob([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], { type: copied.image.asset.mimeType }) }]);
    let denied = false; try { await assetRepository.readProductionGenerated(copied, new AbortController().signal); } catch { denied = true; } return denied;
  }, { view: f.view, bytes: f.t.output.toString("base64") }); expect(copy).toBe(true);
  await page.evaluate(async ({ asset, bytes }) => { const { assetRepository } = await import("/src/assets/assetRepository.ts"); await assetRepository.remove("project-a",asset.id); await assetRepository.restore("foreign",[{asset:{...asset,projectId:"foreign"},original:new Blob([Uint8Array.from(atob(bytes),c=>c.charCodeAt(0))],{type:asset.mimeType})}]); }, { asset: f.view.image.asset, bytes: f.t.output.toString("base64") });
  await f.panel.getByRole("button", { name: "缓存生产原图", exact: true }).click(); await expect(f.panel.getByRole("alert")).toContainText("冲突"); expect((await cached(page, f.id)).bytes).toBe(f.t.output.length); expect(f.t.f.store.load()).toEqual(f.before);
});
test("real owned settlement projection changes without changing original artifact cache identity", async ({ page }) => {
  const f = await fixture(page); await f.cache(); const marker = (await cached(page, f.id)).marker;
  let billing!: ImageProductionBillingSettlementHarness;
  const kernel = new SqliteRunKernel({ ...f.t.kernelOptions, stateStore: f.t.f.store, authorizer: f.t.auth, budgets: f.t.f.store.load()!.budgets, clock: f.t.f.clock,
    productionImageBillingPolicy: { usesStateStore: s => billing.billingPolicy.usesStateStore(s), authorizeScope: (p,j,a) => billing.billingPolicy.authorizeScope(p,j,a), validateCommit: (p,r) => billing.billingPolicy.validateCommit(p,r) } });
  const options = { billingSettlementEnabled:true as const, tenantId:principal.tenantId,stateStore:f.t.f.store,runKernel:kernel,runAuthorizer:f.t.auth,providerAuthorizer:f.t.auth,assetAuthorizer:f.t.auth,clock:f.t.f.clock,billingSource:{kind:"contract-fixture" as const,realExecutionEnabled:false as const,verify:()=>true} };
  billing = new ImageProductionBillingSettlementHarness(options); const review = new ImageProductionBillingReviewHarness({...options,billingReviewEnabled:true}), reviewer = {...principal,actorId:"other"}, args = [reviewer,"project-a",f.t.args[2],f.t.args[3]] as const, snapshot = review.inspect(...args);
  billing.settle(...args,{reviewId:"owned-cache-review",expectedSnapshotFingerprint:fp(snapshot),expectedCurrency:snapshot.currency,expectedReservedMinor:snapshot.reservedMinor,expectedMaxCostMinor:snapshot.maxCostMinor,resolution:"charged",actualCostMinor:25,evidence:{sourceId:"owned-source",sourceVersion:"v1",evidenceRef:"not-real-bill",checksumSha256:"a".repeat(64),observedAt:snapshot.unknownAt}});
  const settled = f.t.f.store.load(); await f.panel.getByRole("button", { name: "重新核验生产原图缓存" }).click(); await expect(f.panel.getByRole("status")).toContainText("已核验"); await expect(f.panel.getByRole("article")).toContainText("实费 CNY 25 最小单位");
  expect((await cached(page, f.id)).marker).toEqual(marker); await f.cache(); expect((await cached(page, f.id)).marker).toEqual(marker); expect(f.t.f.store.load()).toEqual(settled);
});
for (const action of ["close", "project"] as const) test(`${action} cancels held original response without stale IDB/UI callback`, async ({ page }) => {
  const f = await fixture(page); f.setHold(); await f.panel.getByRole("button", { name: "缓存生产原图", exact: true }).click(); await expect.poll(() => f.requests.some(r => r.path.endsWith("/content"))).toBe(true);
  if (action === "close") await page.getByRole("button", { name: "关闭任务面板" }).click(); else await page.getByLabel("切换项目").selectOption("phase-1-campaign");
  f.release(); await expect.poll(async () => (await cached(page, f.id)).bytes).toBe(0); expect(f.t.f.store.load()).toEqual(f.before);
});
test("v3 incremental migration retains legacy assets/blobs/local marks; production changes add only independent store", async ({ page }) => {
  await page.addInitScript(() => {
    const q = indexedDB.open("ai-commerce-canvas-assets",3); q.onupgradeneeded=()=>{const db=q.result,a=db.createObjectStore("assets",{keyPath:"id"});a.createIndex("projectId","projectId");a.createIndex("projectFingerprint",["projectId","contentFingerprint"]);const b=db.createObjectStore("blobs",{keyPath:"key"});b.createIndex("assetId","assetId");db.createObjectStore("generatedCaches",{keyPath:"assetId"});};
    q.onsuccess=()=>{const db=q.result,tx=db.transaction(["assets","blobs","generatedCaches"],"readwrite");tx.objectStore("assets").put({id:"old-generated",projectId:"old-project",kind:"image",purpose:"generated",originalName:"old.png",storageKey:"local-verified:old",mimeType:"image/png",byteSize:3,createdAt:"2026-10-03T00:00:00Z"});tx.objectStore("blobs").put({key:"old-generated:original",assetId:"old-generated",role:"original",blob:new Blob([new Uint8Array([1,2,3])])});tx.objectStore("generatedCaches").put({assetId:"old-generated",projectId:"old-project",tenantId:"local-studio",metadata:"unchanged",checksum:"old"});tx.oncomplete=()=>db.close();};
  });
  const f = await fixture(page); await f.cache(); const old = await page.evaluate(async () => { const {assetRepository}=await import("/src/assets/assetRepository.ts"); const q=indexedDB.open("ai-commerce-canvas-assets"),db=await new Promise<IDBDatabase>(r=>{q.onsuccess=()=>r(q.result);});const tx=db.transaction("generatedCaches","readonly"),r=tx.objectStore("generatedCaches").get("old-generated"),marker=await new Promise<any>(res=>{r.onsuccess=()=>res(r.result);});db.close();return {version:db.version,marker,assets:await assetRepository.list("old-project"),bytes:Array.from(new Uint8Array(await (await assetRepository.getBlob("old-generated","original"))!.arrayBuffer()))}; });
  expect(old.version).toBe(4);expect(old.assets[0].id).toBe("old-generated");expect(old.bytes).toEqual([1,2,3]);expect(old.marker.metadata).toBe("unchanged");
});
test("390px original lineage and offline cache preview fit without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({width:390,height:844});const f=await fixture(page);await f.cache();await f.panel.getByRole("button",{name:"只读生产原图谱系"}).click();await expect(f.panel.getByRole("article")).toBeVisible();
  expect(await f.panel.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await page.screenshot({path:"test-results/production-cache-390.png"});
});
test("daily App cannot enable production cache through query/window/localStorage and original routes stay closed", async ({ page }) => {
  await page.addInitScript(()=>{(window as any).productionGeneratedRead={generatedReadUiEnabled:true,tenantId:"tenant-a",mode:"production"};localStorage.setItem("productionGeneratedRead",JSON.stringify((window as any).productionGeneratedRead));});await page.goto("/?generatedReadUiEnabled=true&mode=production");await page.getByRole("button",{name:"任务与预算",exact:true}).click();await expect(page.getByRole("region",{name:"生产原图只读缓存"})).toHaveCount(0);
  const before=await(await page.request.get("/studio-api/v1/projects/project-main-image/budget",{headers:{"x-canvas-local":"1"}})).json();for(const path of ["lineage","content"])expect((await page.request.get(`/studio-api/v1/projects/project-main-image/production-generated-assets/unknown/${path}`,{headers:{"x-canvas-local":"1"}})).status()).toBe(404);
  expect(await(await page.request.get("/studio-api/v1/projects/project-main-image/budget",{headers:{"x-canvas-local":"1"}})).json()).toEqual(before);expect(await(await page.request.get("/studio-api/health",{headers:{"x-canvas-local":"1"}})).json()).toMatchObject({realExecutorsEnabled:false});
});
