import { test, expect, type Page } from "@playwright/test";
import { ownedProductionBillingTask } from "../helpers/production-billing-task-core";
import { ImageProductionGeneratedAssetReadHarness } from "../../apps/api/src/productionGeneratedAssetReads";
import { createApiServer } from "../../apps/api/src/index";
import { principal } from "../helpers/image-task-fixture";
import { SqliteRunKernel } from "../../apps/api/src/sqliteRunKernel";
import { ImageProductionBillingReviewHarness } from "../../apps/api/src/productionImageBillingReview";
import { ImageProductionBillingSettlementHarness } from "../../apps/api/src/productionImageBillingSettlement";
import { imageSnapshotFingerprint as fp } from "../../apps/api/src/imageProviderContract";
test.use({ serviceWorkers: "block" });
const cleanups: Array<() => Promise<void>> = [];
test.afterEach(async () => { for (const f of cleanups.splice(0)) await f(); });
const document = async (page: Page) => {
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ai-commerce-canvas.document.owned-production-result-doc"))).not.toBeNull();
  return page.evaluate(() => JSON.parse(localStorage.getItem("ai-commerce-canvas.document.owned-production-result-doc")!));
};
const histories = async (page: Page) => (await document(page)).nodes.filter((n: any) => n.data.productionGeneratedHistory);
async function fixture(page: Page, options: Parameters<typeof ownedProductionBillingTask>[0] = {}) {
  const t = await ownedProductionBillingTask(options); await t.artifacts.ingest(...t.args);
  const r = new ImageProductionGeneratedAssetReadHarness({ generatedReadEnabled: true, tenantId: principal.tenantId, stateStore: t.f.store, runKernel: t.f.kernel, assetAuthorizer: t.auth, runAuthorizer: t.auth });
  const id = t.saved().productionImageArtifact!.image.asset.id, view = r.lineage(principal, "project-a", id), before = t.f.store.load();
  const inputs = [...view.requestDraft.inputs, ...(view.requestDraft.operation === "edit" && view.requestDraft.mask ? [view.requestDraft.mask] : [])].map(ref => {
    const record = t.f.store.loadVerifiedImageBytes(principal.tenantId, "project-a", ref.assetId)!; return { asset: record.receipt.asset, bytes: [...record.body] };
  });
  const server = createApiServer({ productionGeneratedAssets: r }); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error(); const origin = `http://127.0.0.1:${address.port}`;
  const requests: string[] = []; let hold = false, denyFinal = false, reads = 0, release: (() => void) | undefined;
  cleanups.push(async () => { hold = false; release?.(); await page.unrouteAll({ behavior: "wait" }); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); t.f.cleanup(); });
  await page.addInitScript(constraint => {
    localStorage.setItem("ai-commerce-canvas.imported-projects", JSON.stringify([{ documentId: "owned-production-result-doc", projectId: "project-a", label: "自有生产回流测试", importedAt: "2026-10-04T00:00:00Z" }]));
    localStorage.setItem("ai-commerce-canvas.active-document", "owned-production-result-doc");
    localStorage.setItem("ai-commerce-canvas.constraints.project-a", JSON.stringify([constraint]));
  }, view.constraint);
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(), source = await response.text(), body = source.replace("jsxDEV(App, {},", 'jsxDEV(App, { productionGeneratedRead: { generatedReadUiEnabled: true, tenantId: "tenant-a", mode: "production-contract-fixture" } },');
    if (body === source) throw new Error("owned trusted configuration failed"); await route.fulfill({ response, body });
  });
  await page.route(/\/studio-api\/v1\/projects\/[^/]+\/production-generated-assets\/[^/]+\/(?:lineage|content)$/, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/studio-api/, ""); requests.push(`${route.request().method()} ${path}`);
    if ((hold || denyFinal) && path.endsWith("/lineage")) { reads++; if (denyFinal && reads === 2) t.denied.add("run:read"); }
    const response = await route.fetch({ url: origin + path, maxRedirects: 0 });
    if (hold && path.endsWith("/lineage") && reads === 2) await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ response });
  });
  await page.goto("/");
  if (inputs.length) {
    await page.evaluate(async records => { const { assetRepository } = await import("/src/assets/assetRepository.ts"); await assetRepository.restore("project-a", records.map(r => ({ asset: r.asset, original: new Blob([Uint8Array.from(r.bytes)], { type: r.asset.mimeType }) }))); }, inputs);
    await page.reload();
  }
  await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  const panel = page.getByRole("region", { name: "生产原图只读缓存" }); await expect(panel).toBeVisible(); await panel.getByLabel("生产原图资产编号").fill(id);
  await document(page); // Observe the initial autosave before comparing or reading history.
  const cache = async () => { await panel.getByRole("button", { name: "缓存生产原图", exact: true }).click(); await expect(panel.getByRole("status")).toContainText("已缓存"); };
  const put = async () => { await panel.getByRole("button", { name: "核验生产原图并回画布", exact: true }).click(); await expect(panel.getByRole("status")).toContainText("已受控回画布"); await expect.poll(async () => (await histories(page)).length).toBe(1); };
  return { t, view, id, before, inputs, requests, panel, cache, put, hold: () => { hold = true; reads = 0; }, denyFinal: () => { denyFinal = true; reads = 0; }, release: () => { hold = false; release?.(); }, held: () => !!release };
}
for (const protocol of ["openai", "openai-compatible", "google"] as const) for (const manual of [true, false]) test(`${protocol}/${manual} actual production graph return/repeat/undo/redo/refresh without budget writes`, async ({ page }) => {
  const f = await fixture(page, { protocol, manual, edit: true }); await f.cache(); const original = await document(page); await f.put();
  const first = (await histories(page))[0]; expect(first.data.productionGeneratedHistory).toMatchObject({ estimateState: manual ? "unknown" : "known", estimatedCostMinor: manual ? null : 25, maxCostMinor: 40, reservedMinor: 40, inputAssetIds: ["source"], artifactFingerprint: f.view.artifactFingerprint });
  expect(first.data.generatedHistory).toBeUndefined(); expect((await document(page)).nodes.length - original.nodes.length).toBe(4);
  await f.put(); expect((await histories(page))[0]).toEqual(first); await page.getByRole("button", { name: "关闭任务面板" }).click();
  await page.getByRole("button", { name: /撤销/ }).click(); await expect.poll(async () => (await histories(page)).length).toBe(0); await page.getByRole("button", { name: /重做/ }).click(); await expect.poll(async () => (await histories(page)).length).toBe(1);
  await page.reload(); expect((await histories(page))[0].data.productionGeneratedHistory).toEqual(first.data.productionGeneratedHistory); expect(f.t.f.store.load()).toEqual(f.before);
  expect(f.requests.every(r => /^GET .*\/(lineage|content)$/.test(r))).toBe(true);
});
for (const protocol of ["openai", "openai-compatible", "google"] as const) test(`${protocol} generate no-source controlled return does not invent edit inputs`, async ({ page }) => {
  const f = await fixture(page, { protocol, manual: true }); await f.cache(); await f.put(); expect((await histories(page))[0].data.productionGeneratedHistory.inputAssetIds).toEqual([]); expect(f.t.f.store.load()).toEqual(f.before);
});
test("actual multiple source + native mask original order, package two copies and input reference protection", async ({ page }) => {
  const f = await fixture(page, { edit: true, mask: true, twoInputs: true }); await f.cache(); await f.put();
  const h = (await histories(page))[0].data.productionGeneratedHistory; expect(h.inputAssetIds).toEqual(["source", "source-2", "owned-mask"]);
  const result = await page.evaluate(async () => {
    const { createProjectPackage, parseProjectPackage, remapProjectPackage } = await import("/src/projects/projectPackage.ts"), { assetRepository } = await import("/src/assets/assetRepository.ts"), { constraintRepository } = await import("/src/constraints/constraintRepository.ts");
    const d = JSON.parse(localStorage.getItem("ai-commerce-canvas.document.owned-production-result-doc")!), assets = await assetRepository.list("project-a");
    const archive = await createProjectPackage({ projectName: "owned", document: d, constraints: constraintRepository.list("project-a"), assets }, (id, role) => assetRepository.getBlob(id, role));
    const one = remapProjectPackage(await parseProjectPackage(archive), "copy-doc", "copy-project"), two = remapProjectPackage(one, "copy-two-doc", "copy-two-project");
    await assetRepository.restore("copy-two-project", two.assets);
    const request = indexedDB.open("ai-commerce-canvas-assets"), db = await new Promise<IDBDatabase>((r,j) => { request.onsuccess = () => r(request.result); request.onerror = () => j(request.error); });
    const copied = two.document.nodes.find((n: any) => n.data.productionGeneratedHistory)!.data.productionGeneratedHistory as any;
    const tx = db.transaction(["productionGeneratedCaches", "generatedCaches"], "readonly");
    const marker = await new Promise(r => { const q = tx.objectStore("productionGeneratedCaches").get(copied.assetId); q.onsuccess = () => r(q.result); }); db.close();
    return { copied, marker, assets: two.assets.map(a => a.asset.id), constraints: two.constraints.map(c => c.id) };
  });
  expect(result.copied).toMatchObject({ evidence: "imported-copy-history", originProjectId: "project-a", estimatedCostMinor: null, inputChecksums: h.inputChecksums }); expect(result.marker).toBeUndefined(); expect(result.assets).toContain(result.copied.assetId); expect(result.constraints).toContain(result.copied.constraintSnapshotId);
  await page.getByRole("button", { name: "关闭任务面板" }).click();
  // Remove only the visual source node; the output's historical input references remain.
  await page.evaluate(() => { const key = "ai-commerce-canvas.document.owned-production-result-doc", d = JSON.parse(localStorage.getItem(key)!); const gone = d.nodes.filter((n: any) => ["source", "source-2"].includes(n.data.assetId)).map((n: any) => n.id); d.nodes = d.nodes.filter((n: any) => !gone.includes(n.id)); d.edges = d.edges.filter((e: any) => !gone.includes(e.source) && !gone.includes(e.target)); localStorage.setItem(key, JSON.stringify(d)); });
  await page.reload(); await page.getByRole("button", { name: /资产库/ }).click(); const source = page.getByRole("complementary", { name: "项目资产库" }).locator("article").filter({ hasText: "source.png" }); await expect(source.locator("button.remove")).toBeDisabled(); await expect(source.locator("button.remove")).toContainText("使用中"); expect(f.t.f.store.load()).toEqual(f.before);
  const second = page.getByRole("complementary", { name: "项目资产库" }).locator("article").filter({ hasText: "source-2.png" }); await expect(second.locator("button.remove")).toBeDisabled(); await expect(second.locator("button.remove")).toContainText("使用中 1");
});
for (const damage of ["not-cached", "marker", "output-bytes", "output-meta", "input-missing", "input-sha", "input-size", "mask-source", "constraint", "permission"] as const) test(`${damage} controlled return rejected, good offline copies retained`, async ({ page }) => {
  const f = await fixture(page, { edit: true, mask: true }); if (damage !== "not-cached") await f.cache();
  if (damage === "permission") f.t.denied.add("run:read");
  else if (damage === "constraint") await page.evaluate(() => { const key = "ai-commerce-canvas.constraints.project-a", c = JSON.parse(localStorage.getItem(key)!); c[0].brandRules = { changed: "not-original" }; localStorage.setItem(key, JSON.stringify(c)); });
  else if (damage !== "not-cached") await page.evaluate(async ({ damage, id }) => {
    const q = indexedDB.open("ai-commerce-canvas-assets"), db = await new Promise<IDBDatabase>((r,j) => { q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    const tx = db.transaction(["assets", "blobs", "productionGeneratedCaches"], "readwrite"), done = new Promise<void>((r,j) => { tx.oncomplete = () => r(); tx.onabort = () => j(tx.error); });
    const read = (store: string, key: string) => new Promise<any>((r,j) => { const a = tx.objectStore(store).get(key); a.onsuccess = () => r(a.result); a.onerror = () => j(a.error); });
    if (damage === "marker") tx.objectStore("productionGeneratedCaches").delete(id);
    if (damage === "input-missing") tx.objectStore("blobs").delete("source:original");
    if (damage === "output-bytes" || damage === "input-sha") { const b = await read("blobs", `${damage === "output-bytes" ? id : "source"}:original`); b.blob = new Blob([new Uint8Array(b.blob.size)], { type: b.blob.type }); tx.objectStore("blobs").put(b); }
    if (["output-meta", "input-size", "mask-source"].includes(damage)) { const a = await read("assets", damage === "output-meta" ? id : damage === "mask-source" ? "owned-mask" : "source"); if (damage === "output-meta") a.originalName = "fake"; if (damage === "input-size") a.width = 2; if (damage === "mask-source") a.sourceAssetId = "foreign"; tx.objectStore("assets").put(a); }
    await done; db.close();
  }, { damage, id: f.id });
  const reads = f.requests.length; await f.panel.getByRole("button", { name: "核验生产原图并回画布" }).click(); await expect(f.panel.getByRole("alert")).toBeVisible(); expect(await histories(page)).toHaveLength(0); expect(f.t.f.store.load()).toEqual(f.before); expect(f.requests.length - reads).toBeLessThanOrEqual(2);
  if (!["not-cached"].includes(damage)) expect(await page.evaluate(async id => { const { assetRepository } = await import("/src/assets/assetRepository.ts"); return !!await assetRepository.getBlob(id, "original"); }, f.id)).toBe(true);
});
for (const action of ["close", "switch", "constraint-drift"] as const) test(`${action} during final lineage discards late graph`, async ({ page }) => {
  const f = await fixture(page, { edit: true }); await f.cache(); f.hold(); await f.panel.getByRole("button", { name: "核验生产原图并回画布" }).click(); await expect.poll(f.held).toBe(true);
  if (action === "close") await page.getByRole("button", { name: "关闭任务面板" }).click();
  if (action === "switch") await page.getByLabel("切换项目").selectOption("phase-1-campaign");
  if (action === "constraint-drift") await page.evaluate(() => { const key = "ai-commerce-canvas.constraints.project-a", c = JSON.parse(localStorage.getItem(key)!); c[0].brandRules = { final: "changed" }; localStorage.setItem(key, JSON.stringify(c)); });
  f.release(); if (action === "constraint-drift") await expect(f.panel.getByRole("alert")).toBeVisible(); else if (action === "close") await expect(f.panel).toBeHidden(); else { await expect(page.getByLabel("切换项目")).toHaveValue("phase-1-campaign"); await expect(f.panel.getByRole("status")).toHaveCount(0); } expect(await histories(page)).toHaveLength(0); expect(f.t.f.store.load()).toEqual(f.before);
});
function settleOwned(f: Awaited<ReturnType<typeof fixture>>) {
  let settlement: ImageProductionBillingSettlementHarness;
  const kernel = new SqliteRunKernel({ ...f.t.kernelOptions, stateStore: f.t.f.store, budgets: f.t.f.store.load()!.budgets, clock: f.t.f.clock, productionImageBillingPolicy: { usesStateStore: s => settlement.billingPolicy.usesStateStore(s), authorizeScope: (p,j,a) => settlement.billingPolicy.authorizeScope(p,j,a), validateCommit: (p,r) => settlement.billingPolicy.validateCommit(p,r) } });
  const shared = { tenantId: principal.tenantId, stateStore: f.t.f.store, runKernel: kernel, runAuthorizer: f.t.auth, providerAuthorizer: f.t.auth, assetAuthorizer: f.t.auth, clock: f.t.f.clock, billingSource: { kind: "contract-fixture" as const, realExecutionEnabled: false as const, verify: () => true } };
  const review = new ImageProductionBillingReviewHarness({ ...shared, billingReviewEnabled: true }); settlement = new ImageProductionBillingSettlementHarness({ ...shared, billingSettlementEnabled: true });
  const args = [{ ...principal, actorId: "other" }, "project-a", f.view.batchId, f.view.jobId] as const, s = review.inspect(...args);
  settlement.settle(...args, { reviewId: "owned-canvas-bill", expectedSnapshotFingerprint: fp(s), expectedCurrency: "CNY", expectedReservedMinor: 40, expectedMaxCostMinor: 40, resolution: "charged", actualCostMinor: 25, evidence: { sourceId: "owned", sourceVersion: "v1", evidenceRef: "owned-zero-cost-proof", checksumSha256: "a".repeat(64), observedAt: s.unknownAt } });
}
test("actual owned settlement observed on first return, repeat does not rewrite historical fee or original response", async ({ page }) => {
  const f = await fixture(page); await f.cache(); settleOwned(f);
  const before = f.t.f.store.load(); await f.put(); expect((await histories(page))[0].data.productionGeneratedHistory).toMatchObject({ estimatedCostMinor: null, actualMinor: 25, reservedMinor: 0, billingState: "settled" }); await f.put(); expect(f.t.f.store.load()).toEqual(before); expect(f.t.saved().productionImageResult).toEqual(f.before!.batches[0].productionImageResult);
});
test("repeat after actual settlement preserves the old unknown canvas observation without hiding current server billing", async ({ page }) => {
  const f = await fixture(page); await f.cache(); await f.put(); const first = (await histories(page))[0]; settleOwned(f); const settled = f.t.f.store.load();
  await f.put(); expect((await histories(page))[0]).toEqual(first); expect(first.data.productionGeneratedHistory).toMatchObject({ estimatedCostMinor:null,billingState:"unknown",reservedMinor:40 });
  await f.panel.getByRole("button",{name:"只读生产原图谱系"}).click(); await expect(f.panel.getByRole("article")).toContainText("实费 CNY 25 最小单位");
  expect(f.t.f.store.load()).toEqual(settled); expect(f.t.saved().productionImageResult).toEqual(f.before!.batches[0].productionImageResult);
});
test("390px production history readable with native local preview", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const f = await fixture(page); await f.cache(); await f.put(); await page.getByRole("button", { name: "关闭任务面板" }).click();
  const h = page.getByRole("complementary", { name: "生产生成结果历史" }); await expect(h).toContainText("未知（不是零费用）"); await expect(h).toContainText(f.view.image.checksumSha256); expect(await h.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: "test-results/production-result-390.png" });
});
test("final actual server read after original native validation denies revoked permission", async ({ page }) => {
  const f = await fixture(page, { edit: true }); await f.cache(); const count = f.requests.length; f.denyFinal();
  await f.panel.getByRole("button", { name: "核验生产原图并回画布" }).click(); await expect(f.panel.getByRole("alert")).toBeVisible();
  expect(f.requests.length - count).toBe(2); expect(await histories(page)).toHaveLength(0); expect(f.t.f.store.load()).toEqual(f.before);
  expect(await page.evaluate(async id => { const { assetRepository } = await import("/src/assets/assetRepository.ts"); return (await assetRepository.getBlob(id,"original"))!.size; }, f.id)).toBe(f.t.output.length);
});
test("deleted output is restored under fresh permission without duplicated sources or budget writes", async ({ page }) => {
  const f = await fixture(page, { edit: true }); await f.cache(); await f.put(); const first = await document(page);
  await page.getByRole("button", { name: "关闭任务面板" }).click();
  await page.evaluate(() => { const key = "ai-commerce-canvas.document.owned-production-result-doc", d = JSON.parse(localStorage.getItem(key)!), id = d.nodes.find((n:any)=>n.data.productionGeneratedHistory).id; d.nodes = d.nodes.filter((n:any)=>n.id!==id); d.edges=d.edges.filter((e:any)=>e.source!==id&&e.target!==id); localStorage.setItem(key,JSON.stringify(d)); });
  await page.reload(); await page.getByRole("button", {name:"任务与预算",exact:true}).click(); await f.panel.getByLabel("生产原图资产编号").fill(f.id); await f.put();
  expect((await document(page)).nodes.length).toBe(first.nodes.length); expect((await document(page)).edges.length).toBe(first.edges.length); expect(f.t.f.store.load()).toEqual(f.before);
});
test("unknown zero cap return keeps nullable estimate rather than asserting zero measured cost", async ({ page }) => {
  const f = await fixture(page, { cap: 0 }); await f.cache(); await f.put();
  expect((await histories(page))[0].data.productionGeneratedHistory).toMatchObject({ estimatedCostMinor:null,maxCostMinor:0,reservedMinor:0,billingState:"unknown" });
  expect((await histories(page))[0].data.productionGeneratedHistory.actualMinor).toBeUndefined(); expect(f.t.f.store.load()).toEqual(f.before);
});
