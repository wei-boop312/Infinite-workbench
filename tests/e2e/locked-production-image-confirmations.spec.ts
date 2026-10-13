import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { RegisterRunContextRequestSchema, ImageProviderConnectionSchema, ConstraintSnapshotSchema, type ImageProviderConnection, type ConfirmedLockedProductionImageExecution } from "../../packages/contracts/src/index";
import { LocalImageProviders } from "../../apps/api/src/imageProviders";
import { SqliteRunKernelStateStore } from "../../apps/api/src/sqliteRunKernelStore";
import { SqliteRunKernel } from "../../apps/api/src/sqliteRunKernel";
import { createApiServer } from "../../apps/api/src/index";
import { LocalVerifiedAssets } from "../../apps/api/src/verifiedAssets";
import { LockedImageProductionPreparationHarness, type LockedImagePriceContext } from "../../apps/api/src/lockedProductionImagePreparations";
import { LockedImageProductionPublicHarness } from "../../apps/api/src/lockedProductionImagePublic";
import { fixtureConnection } from "../fixtures/image-preparation";
const sharp = createRequire(new URL("../../apps/api/package.json", import.meta.url))("sharp");
test.use({ serviceWorkers: "block" });
const cleanups: Array<() => Promise<void>> = [];
test.afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
async function fixture(page: Page, protocol: "openai" | "openai-compatible" = "openai", manual = false, cap = 40, encoding = "json-images", format: "png" | "webp" = "png") {
  const dir = mkdtempSync(join(tmpdir(), "canvas-locked-ui-")), store = new SqliteRunKernelStateStore(join(dir, "task.sqlite"), { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true });
  const projectId = "project-a", principal = { tenantId: "tenant-a", actorId: "writer" }; let now = Date.now(), allowed = true, pricingAllowed = true, confirms = 0, creates = 0, historyReads = 0, priceReads = 0, contexts = 0, legacyReads = 0, uploads = 0;
  let mode: "good" | "lost" | "mismatch" | "hold" | "budget-lost" | "prepare-lost" = "good", release: (() => void) | undefined, eraseAfterUpload = false, preparationId = "";
  const auth = { authenticate: () => principal, allows: (p: typeof principal, id: string, permission: string) => p.tenantId === principal.tenantId && id === projectId && (permission !== "run:confirm" || allowed) };
  const png = (v: number[]) => sharp(Buffer.from(v), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const source = await png([40,70,90,255,1,2,3,255]), mask = await png([255,255,255,0,255,255,255,255]);
  const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
  const inputs = [["source", source, "source"], ["source-2", source, "source"], ["mask", mask, "mask"]].map(([id, body, purpose]) => ({
    asset: { id, projectId, kind: "image", purpose, storageKey: `owned:${id}`, originalName: `${id}.png`, mimeType: "image/png", byteSize: (body as Buffer).length, width: 2, height: 1,
      contentFingerprint: `sha256:${sha(body as Buffer)}`, createdAt: new Date(now).toISOString(), ...(purpose === "mask" ? { sourceAssetId: "source" } : {}) }, bytes: [...body as Buffer] }));
  const constraint = ConstraintSnapshotSchema.parse({ id: "owned-constraint", projectId, lockedPaths: ["product.pixels"], editableRegions: [{ id: "region", description: "仅原人工指定布景", maskAssetId: "mask" }],
    brandRules: { tone: "原冻结品牌语气" }, outputSpec: { width: 2, height: 1, format }, createdAt: new Date(now).toISOString() });
  store.transaction(() => store.saveCatalog({ schemaVersion: 1, projects: [{ projectId, assets: [], constraints: [] }] }));
  let preparation!: LockedImageProductionPreparationHarness;
  const kernel = new SqliteRunKernel({ stateStore: store, authorizer: auth, budgets: [{ tenantId: principal.tenantId, projectId, currency: "CNY", limitMinor: 10000 }], clock: () => now,
    validateLockedProductionImageConfirmation: (p, c: ConfirmedLockedProductionImageExecution) => preparation.authorizeConfirmation(p, c) });
  const providers = new LocalImageProviders({ tenantId: principal.tenantId, stateStore: store, authorizer: auth, assetAuthorizer: auth, runAuthorizer: auth, clock: () => now });
  const base = fixtureConnection(protocol); let config = ImageProviderConnectionSchema.parse({ ...base, tenantId: principal.tenantId, projectId,
    models: base.models.map(m => ({ ...m, sizes: { allowAuto: false, presets: [{ width: 2, height: 1 }] } })),
    ...(protocol === "openai-compatible" ? { compatibility: { ...base.compatibility, editEncoding: encoding } } : {}) });
  providers.registerRevision(principal, config, 0);
  preparation = new LockedImageProductionPreparationHarness({ preparationEnabled: true, lockedPreparationEnabled: true, lockedConfirmationEnabled: true, tenantId: principal.tenantId, stateStore: store, runKernel: kernel,
    authorizer: auth, runAuthorizer: auth, assetAuthorizer: auth, clock: () => now, lockedPreparationPolicy: () => true, lockedConfirmationPolicy: () => true,
    pricePort: { kind: "contract-fixture", realExecutionEnabled: false, read: (c: LockedImagePriceContext) => { priceReads++; return { schemaVersion: 1, scope: c.scope, quote: { id: "owned-ui-price", version: "owned-ui-v1", source: manual ? "manual-budget" : "server-price-table", currency: "CNY", maxCostMinor: cap, ...(manual ? {} : { estimatedCostMinor: 25 }), expiresAt: new Date(now + 60_000).toISOString() }, evidence: { kind: "contract-fixture", realExecutionEnabled: false, sourceRevision: "owned-source", evidenceRef: "not-a-real-price", checkedBy: "owned-oracle", checkedAt: c.requestedAt } }; }, verify: () => pricingAllowed } });
  const port = new LockedImageProductionPublicHarness({ lockedPublicPreparationEnabled: true, tenantId: principal.tenantId, stateStore: store, runKernel: kernel, preparations: preparation,
    runAuthorizer: auth, providerAuthorizer: auth, assetAuthorizer: auth, clock: () => now, lockedPublicPreparationPolicy: () => true });
  const verifiedAssets = new LocalVerifiedAssets({ stateStore: store, authorizer: auth, findAsset: (tenant, project, id) => tenant === principal.tenantId && project === projectId ? store.loadCatalog()?.projects[0].assets.find(a => a.id === id) ?? null : null });
  const server = createApiServer({ lockedProductionImagePreparations: port, imageProviders: providers, runKernel: kernel, verifiedAssets });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const address = server.address(); if (!address || typeof address === "string") throw Error(); const origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { mode = "good"; release?.(); await page.unrouteAll({ behavior: "wait" }); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close();
    const target = resolve(dir); if (!target.startsWith(resolve(tmpdir()) + "\\canvas-locked-ui-")) throw Error("unsafe owned cleanup"); rmSync(target, { recursive: true, force: true }); });
  await page.addInitScript(constraint => {
    localStorage.setItem("ai-commerce-canvas.imported-projects", JSON.stringify([{ documentId: "owned-locked-ui-doc", projectId: "project-a", label: "自有保护人工UI", importedAt: "2026-10-14T00:00:00Z" }]));
    localStorage.setItem("ai-commerce-canvas.active-document", "owned-locked-ui-doc"); localStorage.setItem("ai-commerce-canvas.constraints.project-a", JSON.stringify([constraint]));
  }, constraint);
  await page.route("**/src/main.tsx", async route => { const response = await route.fetch(), original = await response.text();
    const body = original.replace("jsxDEV(App, {},", 'jsxDEV(App, { lockedProductionImagePreparation: { lockedPreparationUiEnabled: true, tenantId: "tenant-a", mode: "production-contract-fixture" } },');
    if (body === original) throw Error("owned trusted App config injection failed"); await route.fulfill({ response, body }); });
  await page.route("**/studio-api/context", async route => { contexts++; const context = RegisterRunContextRequestSchema.parse(route.request().postDataJSON());
    if (context.projectId === projectId) store.transaction(() => { const previous = store.loadCatalog()!.projects[0];
      for (const group of ["assets", "constraints"] as const) for (const item of context[group]) { const before = previous[group].find(v => v.id === item.id);
        if (before && JSON.stringify(before) !== JSON.stringify(item)) throw Error("owned immutable context conflict"); }
      store.saveCatalog({ schemaVersion: 1, projects: [context] }); });
    await route.fulfill({ status: context.projectId === projectId ? 200 : 403, json: { registered: context.projectId === projectId }, headers: { "cache-control": "no-store" } }); });
  await page.route(/\/studio-api\/v1\/projects\/[^/]+\/(?:locked-production-image-preparations|image-providers|budget|run-batches|assets)(?:\/[^?]*)?$/, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/studio-api/, "");
    if (!path.includes(`/projects/${projectId}/`)) { await route.fulfill({ status: 403, json: { error: "owned_scope_denied" }, headers: { "cache-control": "no-store" } }); return; }
    if (/\/run-batches$/.test(path)) legacyReads++; if (/\/verification$/.test(path)) uploads++;
    const confirm = /\/confirm$/.test(path) && route.request().method() === "POST", create = /\/locked-production-image-preparations$/.test(path) && route.request().method() === "POST";
    if (confirm) confirms++; if (create) creates++; if (/\/confirmation$/.test(path)) historyReads++;
    // This owned reverse-proxy hop preserves same-origin semantics for its
    // actual HTTP host; the service must still reject a foreign Origin.
    const response = await route.fetch({ url: origin + path, maxRedirects: 0, headers: { ...route.request().headers(), origin, "accept-encoding": "identity" } }); if (confirm && mode === "hold") await new Promise<void>(r => { release = r; });
    if (create && response.ok()) preparationId = (await response.json()).id;
    if (eraseAfterUpload && /\/verification$/.test(path)) { eraseAfterUpload = false; await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.includes("locked-production-preparation.")) localStorage.removeItem(key); }); }
    try { if ((confirm && mode === "lost") || (create && mode === "prepare-lost") || (/\/budget$/.test(path) && mode === "budget-lost")) await route.abort("failed");
      else if (confirm && mode === "mismatch" && response.ok()) { const json = await response.json(); json.protectionPolicyFingerprint = "f".repeat(64); await route.fulfill({ json, headers: { "cache-control": "no-store" } }); }
      else await route.fulfill({ response }); } catch { /* Response cancellation cannot undo a committed reservation. */ }
  });
  await page.goto("/"); await page.evaluate(async inputs => { const { assetRepository } = await import("/src/assets/assetRepository.ts");
    await assetRepository.restore("project-a", inputs.map(r => ({ asset: r.asset, original: new Blob([Uint8Array.from(r.bytes)], { type: r.asset.mimeType }) }))); }, inputs);
  return { projectId, get preparationId() { return preparationId; }, get confirms() { return confirms; }, get creates() { return creates; }, get historyReads() { return historyReads; }, get priceReads() { return priceReads; }, get contexts() { return contexts; }, get legacyReads() { return legacyReads; }, get uploads() { return uploads; },
    snapshot: () => store.load(), budget: () => kernel.getBudget(principal, projectId), setMode: (v: typeof mode) => { mode = v; }, release: () => { mode = "good"; release?.(); }, revoke: () => { allowed = false; }, revokePrice: () => { pricingAllowed = false; },
    expire: () => { now += 61_000; }, drift: () => { config = { ...config, revision: config.revision + 1, enabled: false }; providers.registerRevision(principal, config, config.revision - 1); },
    eraseAfterFirstUpload: () => { eraseAfterUpload = true; }, changeConstraint: () => store.transaction(() => { const c = store.loadCatalog()!; c.projects[0].constraints[0].brandRules.tone = "未经原人工确认"; store.saveCatalog(c); }) };
}
async function prepare(page: Page, protocol: "openai" | "openai-compatible" = "openai", _edit = true, beforeSubmit?: () => Promise<void>) {
  await page.goto("/"); await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  const section = page.getByRole("region", { name: "保护生产图片准备" }); await expect(section.getByRole("button", { name: "刷新保护供应商目录" })).toBeEnabled();
  await section.getByLabel("保护生产图片供应商", { exact: true }).selectOption(`fixture-${protocol}`); await section.getByLabel("保护生产图片模型").selectOption("explicit-fixture-model");
  await section.getByLabel("保护生产图片操作").selectOption("edit"); await section.getByLabel("保护生产图片约束").selectOption({ index: 1 });
  await section.getByLabel("保护编辑输入 source.png", { exact: true }).check(); await section.getByLabel("保护编辑输入 source-2.png", { exact: true }).check(); await section.getByLabel("保护生产图片蒙版").selectOption("mask");
  await section.getByLabel("保护生产图片设计指令").fill("原完整人工构图，不抽卡或换模型"); await section.getByLabel("保护生产图片质量").selectOption("auto"); await section.getByLabel("保护生产图片背景").selectOption("auto");
  await beforeSubmit?.(); await section.getByRole("button", { name: "保存未确认保护准备单" }).click();
  const review = section.getByRole("region", { name: "保护生产图片人工冻结确认" }); if (!beforeSubmit) await expect(review.getByLabel("已核对保护完整冻结记录与独立上限")).toBeEnabled();
  return { section, review, check: review.getByLabel("已核对保护完整冻结记录与独立上限"), button: review.getByRole("button", { name: "人工确认保护记录并预留上限" }) };
}
for (const protocol of ["openai", "openai-compatible"] as const) for (const manual of [false, true]) test(`${protocol}/${manual} 实际生产合同人工确认和刷新GET，一次max预留不生成`, async ({ page }) => {
  const f = await fixture(page, protocol, manual), { section, review, check, button } = await prepare(page, protocol);
  await expect(review).toContainText("原冻结品牌语气"); await expect(review).toContainText("仅原人工指定布景"); await expect(review).toContainText(manual ? "估价未知（不能当作0或上限）" : "原估价 25"); await expect(review).toContainText("独立预留上限 40"); await expect(button).toBeDisabled();
  expect(f.budget()).toMatchObject({ reservedMinor: 0, spentMinor: 0 }); await check.check(); await button.click(); await expect(review.getByRole("article", { name: "保护生产图片确认结果" })).toBeVisible();
  expect(f.confirms).toBe(1); expect(f.creates).toBe(1); expect(f.contexts).toBe(1); expect(f.legacyReads).toBe(0); expect(f.budget()).toMatchObject({ reservedMinor: 40, spentMinor: 0 }); expect(f.snapshot()?.batches[0].aggregate.batch.estimatedCostMinor).toBe(manual ? null : 25); expect(f.snapshot()?.batches[0].lockedProductionImageAttempt).toBeUndefined(); await expect(review).toContainText("input-verified-output-unchecked"); await expect(review).toContainText("fixed-rgba8-only"); await expect(review).toContainText("ICC"); await expect(review).toContainText("注册元信息 SHA"); expect(f.uploads).toBe(3);
  await expect(section.getByRole("article", { name: "未确认保护准备单" })).toContainText("未确认 · 未授权执行 · 协议未准备"); const before = f.snapshot(); await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(page.getByRole("article", { name: "保护生产图片确认结果" })).toBeVisible();
  expect(f.snapshot()).toEqual(before); expect(f.confirms).toBe(1); expect(f.creates).toBe(1); expect(f.priceReads).toBe(1); expect(f.historyReads).toBeGreaterThan(1); await expect(page.getByRole("button", { name: /执行排队|重试失败/ })).toHaveCount(0);
});
for (const protocol of ["openai", "openai-compatible"] as const) test(`${protocol} 编辑实际IndexedDB原图与权威SHA冻结，不用代理`, async ({ page }) => {
  const f = await fixture(page, protocol, true), { review, check, button } = await prepare(page, protocol, true); await expect(review).toContainText("image/png · 2×1"); await expect(review).toContainText("SHA-256："); await check.check(); await button.click(); await expect(review.getByRole("article", { name: "保护生产图片确认结果" })).toBeVisible();
  const e = f.snapshot()?.batches[0].lockedProductionImageExecution; expect(e?.protocol.request.operation).toBe("edit"); expect(e?.protocol.transformedInputs).toHaveLength(3); expect(e?.protocol.transformedInputs[0].originalChecksumSha256).toBe(e?.protocol.request.inputs[0].checksumSha256); expect(f.budget().reservedMinor).toBe(40);
});
for (const mode of ["lost", "mismatch"] as const) test(`确认已提交但${mode}，原指针只GET不再POST`, async ({ page }) => {
  const f = await fixture(page), { review, check, button } = await prepare(page); f.setMode(mode); await check.check(); await button.click(); await expect(review.getByRole("alert")).toBeVisible(); await expect(button).toBeDisabled(); expect(f.confirms).toBe(1); expect(f.budget().reservedMinor).toBe(40);
  f.setMode("good"); await review.getByRole("button", { name: "只读核对保护确认结果" }).click(); await expect(review.getByRole("article", { name: "保护生产图片确认结果" })).toBeVisible(); expect(f.confirms).toBe(1);
});
for (const kind of ["permission", "price", "constraint", "directory"] as const) test(`确认时${kind}漂移保持unknown动作只读、不预留`, async ({ page }) => {
  const f = await fixture(page), { review, check, button } = await prepare(page); if (kind === "permission") f.revoke(); if (kind === "price") f.revokePrice(); if (kind === "constraint") f.changeConstraint(); if (kind === "directory") f.drift();
  await check.check(); await button.click(); await expect(review.getByRole("alert")).toBeVisible(); await expect(button).toBeDisabled(); expect(f.confirms).toBe(1); expect(f.budget().reservedMinor).toBe(0); expect(f.snapshot()?.batches ?? []).toHaveLength(0);
  await review.getByRole("button", { name: "只读核对保护确认结果" }).click(); await expect(button).toBeDisabled(); expect(f.confirms).toBe(1);
});
test("关闭丢弃已提交迟到确认，重开只读原结果", async ({ page }) => {
  const f = await fixture(page), { check, button } = await prepare(page); f.setMode("hold"); await check.check(); await button.click(); await expect.poll(() => f.budget().reservedMinor).toBe(40);
  await page.getByRole("button", { name: "关闭任务面板" }).click(); f.release(); await expect(page.getByRole("article", { name: "保护生产图片确认结果" })).toHaveCount(0); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(page.getByRole("article", { name: "保护生产图片确认结果" })).toBeVisible(); expect(f.confirms).toBe(1);
});
test("确认指针存储失败不POST，不清除原准备", async ({ page }) => {
  const f = await fixture(page), { review, check, button } = await prepare(page); await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.includes("production-preparation.")) throw new Error("owned quota"); return original.call(this, key, value); }; });
  await check.check(); await button.click(); await expect(review.getByRole("alert")).toBeVisible(); expect(f.confirms).toBe(0); expect(f.budget().reservedMinor).toBe(0); await expect(button).toBeDisabled();
});
test("确认前原指针丢失不POST，只读核对不重新预留", async ({ page }) => {
  const f = await fixture(page), { review, check, button } = await prepare(page); await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.includes("production-preparation.")) localStorage.removeItem(key); });
  await check.check(); await button.click(); await expect(review.getByRole("alert")).toContainText("指针丢失"); expect(f.confirms).toBe(0); expect(f.budget().reservedMinor).toBe(0); await expect(button).toBeDisabled();
});
test("准备指针存储失败阻断所有POST，不上传原图或创建准备", async ({ page }) => {
  const f = await fixture(page), { section } = await prepare(page, "openai", true, () => page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.includes("production-preparation.")) throw new Error("owned quota"); return original.call(this, key, value); }; }));
  await expect(section.getByRole("alert")).toBeVisible(); expect(f.contexts).toBe(0); expect(f.creates).toBe(0); expect(f.priceReads).toBe(0); expect(f.snapshot()?.batches ?? []).toHaveLength(0);
});
test("准备已保存但响应丢失保留preparing指针，不自动POST或询价", async ({ page }) => {
  const f = await fixture(page), { section } = await prepare(page, "openai", false, async () => { f.setMode("prepare-lost"); }); await expect(section.getByRole("alert")).toBeVisible(); expect(f.creates).toBe(1); expect(f.priceReads).toBe(1); expect(f.budget().reservedMinor).toBe(0);
  f.setMode("good"); await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); const restored = page.getByRole("region", { name: "保护生产图片准备" }); await expect(restored).toContainText("原准备响应不明"); expect(f.creates).toBe(1); expect(f.contexts).toBe(1); await expect(restored.getByRole("button", { name: "保存未确认保护准备单" })).toBeDisabled();
});
test("损坏或跨项目指针失败关闭，不覆盖原内容或POST", async ({ page }) => {
  const f = await fixture(page), { section } = await prepare(page); await page.evaluate(() => { const key = Object.keys(localStorage).find(k => k.includes("production-preparation."))!; const p = JSON.parse(localStorage.getItem(key)!); p.projectId = "another-project"; localStorage.setItem(key, JSON.stringify(p)); });
  await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(section.getByRole("alert")).toBeVisible(); await expect(section.getByRole("button", { name: "保存未确认保护准备单" })).toBeDisabled(); expect(f.creates).toBe(1); expect(f.confirms).toBe(0);
  expect(await page.evaluate(() => Object.values(localStorage).some(raw => raw.includes("another-project")))).toBe(true);
});
test("切项目隔离已提交迟到确认，只回原项目GET恢复", async ({ page }) => {
  const f = await fixture(page), { check, button } = await prepare(page); f.setMode("hold"); await check.check(); await button.click(); await expect.poll(() => f.budget().reservedMinor).toBe(40);
  await page.getByLabel("切换项目").selectOption({ label: "活动套图工作台" }); f.release(); await expect(page.getByRole("region", { name: "保护生产图片准备" }).getByRole("alert")).toBeVisible(); await expect(page.getByRole("article", { name: "保护生产图片确认结果" })).toHaveCount(0);
  // App preserves the open panel across a project switch; clicking its toggle
  // here would close it. The project-keyed child itself must perform GET only.
  await page.getByLabel("切换项目").selectOption("owned-locked-ui-doc"); await expect(page.getByRole("article", { name: "保护生产图片确认结果" })).toBeVisible(); expect(f.confirms).toBe(1); expect(f.creates).toBe(1); expect(f.contexts).toBe(1);
});
test("未知估价zero-cap仍须完整人工确认，刷新不自动补0实费", async ({ page }) => {
  const f = await fixture(page, "openai", true, 0), { review, check, button } = await prepare(page); await expect(review).toContainText("估价未知"); await expect(review).toContainText("独立预留上限 0"); await check.check(); await button.click(); await expect(review.getByRole("article", { name: "保护生产图片确认结果" })).toContainText("实费 未测得");
  expect(f.snapshot()?.batches[0].aggregate.jobs[0]).toMatchObject({ status: "queued", estimatedCostMinor: null }); expect(f.budget()).toMatchObject({ reservedMinor: 0, spentMinor: 0 }); const before = f.snapshot(); await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(page.getByRole("article", { name: "保护生产图片确认结果" })).toBeVisible(); expect(f.snapshot()).toEqual(before); expect(f.confirms).toBe(1);
});
test("已确认后预算响应失败保留结果，刷新恢复不重复预留", async ({ page }) => {
  const f = await fixture(page, "openai", true), { review, check, button } = await prepare(page); f.setMode("budget-lost"); await check.check(); await button.click(); await expect(review.getByRole("article", { name: "保护生产图片确认结果" })).toBeVisible(); await expect(review.getByRole("alert")).toBeVisible(); expect(f.budget().reservedMinor).toBe(40); expect(f.confirms).toBe(1);
});
test("过期停用的已确认历史只读，当前表单修改阻断新确认", async ({ page }) => {
  const f = await fixture(page), { section, review, check, button } = await prepare(page); await section.getByLabel("保护生产图片设计指令").fill("不能代替原构图"); await expect(button).toBeDisabled(); await expect(review).toContainText("原完整人工构图");
  await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await page.getByLabel("已核对保护完整冻结记录与独立上限").check(); await page.getByRole("button", { name: "人工确认保护记录并预留上限" }).click(); await expect(page.getByRole("article", { name: "保护生产图片确认结果" })).toBeVisible(); f.expire(); f.drift(); const before = f.snapshot();
  await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(page.getByRole("article", { name: "保护生产图片确认结果" })).toBeVisible(); expect(f.snapshot()).toEqual(before); expect(f.confirms).toBe(1); expect(f.priceReads).toBe(1);
});
test("390像素完整生产摘要无横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page, "openai", true); const { section, review } = await prepare(page);
  await review.scrollIntoViewIfNeeded(); expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true); await page.screenshot({ path: "test-results/locked-production-confirmation-ui-390.png" });
});
test("默认日常入口不显示生产UI，不读取或启用旧local指针", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(page.getByRole("region", { name: "图片供应商准备" })).toBeVisible(); await expect(page.getByRole("region", { name: "保护生产图片准备" })).toHaveCount(0);
});

for (const encoding of ["multipart-image-array", "multipart-image-single"] as const) test(`实际 protected ${encoding}/WebP 完整人工确认不发送`, async ({ page }) => {
  const f = await fixture(page, "openai-compatible", true, 40, encoding, "webp");
  const { review, check, button } = await prepare(page, "openai-compatible", true, encoding === "multipart-image-single" ? async () => {
    await page.getByLabel("保护编辑输入 source-2.png", { exact: true }).uncheck();
  } : undefined);
  await expect(check).toBeEnabled(); await expect(review).toContainText("2×1 webp"); await check.check(); await button.click();
  await expect(review.getByRole("article", { name: "保护生产图片确认结果" })).toBeVisible();
  expect(f.snapshot()?.batches[0].lockedProductionImageExecution?.protocol.contentType).toMatch(/^multipart\/form-data; boundary=/);
  expect(f.uploads).toBe(encoding === "multipart-image-single" ? 2 : 3); expect(f.budget()).toMatchObject({ reservedMinor: 40, spentMinor: 0 });
});
test("第一原图已上传后指针丢失，不POST下一原图/蒙版/准备", async ({ page }) => {
  const f = await fixture(page); f.eraseAfterFirstUpload(); const { section } = await prepare(page, "openai", true, async () => undefined);
  await expect(section.getByRole("alert")).toBeVisible(); expect(f.contexts).toBe(1); expect(f.uploads).toBe(1); expect(f.creates).toBe(0); expect(f.priceReads).toBe(0); expect(f.budget().reservedMinor).toBe(0);
});
test("保护政策期待SHA漂移失败关闭，不借原准备/价格SHA提交", async ({ page }) => {
  const f = await fixture(page), { review, check, button } = await prepare(page);
  await page.evaluate(() => { const key = Object.keys(localStorage).find(k => k.includes("locked-production-preparation."))!, p = JSON.parse(localStorage.getItem(key)!); p.protectionPolicyFingerprint = "0".repeat(64); localStorage.setItem(key, JSON.stringify(p)); });
  await check.check(); await button.click(); await expect(review.getByRole("alert")).toBeVisible(); expect(f.confirms).toBe(0); await expect(button).toBeDisabled(); expect(f.budget().reservedMinor).toBe(0);
});
test("未知准备preparing只按原id GET观察，不能覆盖指针或补确认", async ({ page }) => {
  const f = await fixture(page), { section } = await prepare(page, "openai", true, async () => f.setMode("prepare-lost"));
  await expect(section.getByRole("alert")).toBeVisible(); f.setMode("good");
  const id = f.snapshot()?.batches[0]?.lockedProductionImageExecution?.preparation.id; expect(id).toBeUndefined();
  const pointer = await page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.includes("locked-production-preparation."))!; return localStorage.getItem(k); });
  await section.getByLabel("历史保护准备单编号").fill(f.preparationId); await section.getByRole("button", { name: "读取历史保护准备单" }).click();
  const review = section.getByRole("region", { name: "保护生产图片人工冻结确认" }); await expect(review).toBeVisible(); await expect(review.getByRole("button", { name: "人工确认保护记录并预留上限" })).toBeDisabled();
  expect(await page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.includes("locked-production-preparation."))!; return localStorage.getItem(k); })).toBe(pointer);
  expect(JSON.parse(pointer!).stage).toBe("preparing"); expect(f.confirms).toBe(0); expect(f.budget().reservedMinor).toBe(0);
});

test("人工原编号不能覆盖现有不同准备编号/三SHA指针", async ({ page }) => {
  const f = await fixture(page), { section } = await prepare(page), raw = await page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.includes("locked-production-preparation."))!; return localStorage.getItem(k); });
  await section.getByLabel("历史保护准备单编号").fill("another-original-id"); await section.getByRole("button", { name: "读取历史保护准备单" }).click();
  await expect(section.getByRole("alert")).toBeVisible(); expect(f.confirms).toBe(0);
  expect(await page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.includes("locked-production-preparation."))!; return localStorage.getItem(k); })).toBe(raw);
});
test("确认原约束SHA await 中表单漂移，已提交指针保留但实际POST关闭", async ({ page }) => {
  const f = await fixture(page), { section, review, check, button } = await prepare(page);
  await page.evaluate(() => { const original = crypto.subtle.digest.bind(crypto.subtle); (window as any).ownedDigestWaiting = false;
    crypto.subtle.digest = (...args) => { (window as any).ownedDigestWaiting = true; return new Promise<ArrayBuffer>(resolve => { (window as any).ownedDigestRelease = () => original(...args).then(resolve); }); }; });
  await check.check(); await button.click(); await expect.poll(() => page.evaluate(() => (window as any).ownedDigestWaiting)).toBe(true);
  await section.getByLabel("保护生产图片设计指令").fill("等待中已改，不能确认旧单"); await page.evaluate(() => (window as any).ownedDigestRelease());
  await expect(review.getByRole("alert")).toBeVisible(); expect(f.confirms).toBe(0); expect(f.budget().reservedMinor).toBe(0); await expect(button).toBeDisabled();
});
