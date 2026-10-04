import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { RegisterRunContextRequestSchema, ImageProviderConnectionSchema, type ImageProviderConnection, type ConfirmedProductionImageExecution } from "../../packages/contracts/src/index";
import { LocalImageProviders } from "../../apps/api/src/imageProviders";
import { SqliteRunKernelStateStore } from "../../apps/api/src/sqliteRunKernelStore";
import { SqliteRunKernel } from "../../apps/api/src/sqliteRunKernel";
import { createApiServer } from "../../apps/api/src/index";
import { LocalVerifiedAssets } from "../../apps/api/src/verifiedAssets";
import { ImageProductionPreparationHarness, type ImagePriceContext } from "../../apps/api/src/productionImagePreparations";
import { ImageProductionPublicHarness } from "../../apps/api/src/productionImagePublic";
import { fixtureConnection } from "../fixtures/image-preparation";

test.use({ serviceWorkers: "block" });
const cleanups: Array<() => Promise<void>> = [];
test.afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
// Actual App + explicitly supplied trusted host prop, real API + owned SQLite.
// No shipped bootstrap switch, production credentials or supplier transport.
async function fixture(page: Page, protocol: ImageProviderConnection["protocol"] = "openai", manual = false, cap = 40) {
  const dir = mkdtempSync(join(tmpdir(), "canvas-production-ui-")), store = new SqliteRunKernelStateStore(join(dir, "state.sqlite"), { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true });
  let projectId = "", now = Date.now(), allowed = true, pricingAllowed = true, confirms = 0, creates = 0, historyReads = 0, priceReads = 0;
  let mode: "good" | "lost" | "mismatch" | "hold" | "budget-lost" | "prepare-lost" = "good", release: (() => void) | undefined;
  const principal = { tenantId: "local-studio", actorId: "owned-production-designer" }, auth = {
    authenticate: (req: { headers: Record<string, unknown> }) => req.headers["x-canvas-local"] === "1" ? principal : null,
    allows: (p: typeof principal, id: string, permission: string) => p.tenantId === principal.tenantId && id === projectId && (permission !== "run:confirm" || allowed) };
  let kernel!: SqliteRunKernel, providers!: LocalImageProviders, preparation!: ImageProductionPreparationHarness, config!: ImageProviderConnection, server: ReturnType<typeof createApiServer> | undefined, origin = "", startup: Promise<void> | undefined;
  let contexts = 0, legacyReads = 0;
  cleanups.push(async () => {
    mode = "good"; release?.(); await page.unrouteAll({ behavior: "wait" });
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve())); } store.close();
    const target = resolve(dir); if (!target.startsWith(resolve(tmpdir()) + "\\canvas-production-ui-")) throw new Error("unsafe owned cleanup"); rmSync(target, { recursive: true, force: true });
  });
  await page.route("**/src/main.tsx", async route => {
    const response = await route.fetch(), original = await response.text();
    const text = original.replace("jsxDEV(App, {},", 'jsxDEV(App, { productionImagePreparation: { preparationUiEnabled: true, tenantId: "local-studio", mode: "production-contract-fixture" } },');
    if (text === original) throw new Error("actual App trusted configuration injection did not match");
    await route.fulfill({ response, body: text });
  });
  await page.route("**/studio-api/context", async route => {
    contexts++;
    const context = RegisterRunContextRequestSchema.parse(route.request().postDataJSON());
    await initialize(context.projectId);
    if (context.projectId === projectId) {
      store.transaction(() => {
        const old = store.loadCatalog()?.projects[0];
        const merge = <T extends { id: string }>(before: T[], after: T[]) => { const map = new Map(before.map(v => [v.id, v])); for (const item of after) { const previous = map.get(item.id); if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error("owned immutable context conflict"); map.set(item.id, item); } return [...map.values()]; };
        store.saveCatalog({ schemaVersion: 1, projects: [{ ...context, assets: merge(old?.assets ?? [], context.assets), constraints: merge(old?.constraints ?? [], context.constraints) }] });
      });
    }
    await route.fulfill({ status: context.projectId === projectId ? 200 : 403, json: { registered: context.projectId === projectId }, headers: { "cache-control": "no-store" } });
  });
  async function initialize(id: string) {
      if (!projectId) projectId = id;
      if (id !== projectId) return;
      if (!startup) startup = (async () => {
        store.transaction(() => { if (!store.loadCatalog()) store.saveCatalog({ schemaVersion: 1, projects: [{ projectId, assets: [], constraints: [] }] }); });
        kernel = new SqliteRunKernel({ stateStore: store, authorizer: auth, budgets: [{ tenantId: principal.tenantId, projectId, currency: "CNY", limitMinor: 10000 }], clock: () => now,
          validateProductionImageConfirmation: (p, c: ConfirmedProductionImageExecution) => preparation.authorizeConfirmation(p, c) });
        providers = new LocalImageProviders({ tenantId: principal.tenantId, stateStore: store, authorizer: auth, assetAuthorizer: auth, runAuthorizer: auth, clock: () => now });
        const base = fixtureConnection(protocol); config = ImageProviderConnectionSchema.parse({ ...base, projectId,
          ...(protocol === "google" ? { baseUrl: "https://generativelanguage.googleapis.com", googleNative: { version: "owned-google", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: base.models[0].model, sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] },
            models: [{ ...base.models[0], sizes: { allowAuto: false, presets: [{ width: 1024, height: 1024 }] }, qualities: ["auto"], backgrounds: ["auto"] }] } : {}) }); providers.registerRevision(principal, config, 0);
        preparation = new ImageProductionPreparationHarness({ preparationEnabled: true, tenantId: principal.tenantId, stateStore: store, runKernel: kernel, authorizer: auth, runAuthorizer: auth, assetAuthorizer: auth, clock: () => now,
          pricePort: { kind: "contract-fixture", realExecutionEnabled: false, read: (c: ImagePriceContext) => { priceReads++; return { schemaVersion: 1, scope: c.scope, quote: { id: "owned-ui-price", version: "owned-ui-v1", source: manual ? "manual-budget" : "server-price-table", currency: "CNY", maxCostMinor: cap, ...(manual ? {} : { estimatedCostMinor: 25 }), expiresAt: new Date(now + 60_000).toISOString() }, evidence: { kind: "contract-fixture", realExecutionEnabled: false, sourceRevision: "owned-source", evidenceRef: "not-a-real-price", checkedBy: "owned-oracle", checkedAt: c.requestedAt } }; }, verify: () => pricingAllowed } });
        const port = new ImageProductionPublicHarness({ publicPreparationEnabled: true, tenantId: principal.tenantId, stateStore: store, runKernel: kernel, preparations: preparation, runAuthorizer: auth, providerAuthorizer: auth, assetAuthorizer: auth });
        const verifiedAssets = new LocalVerifiedAssets({ stateStore: store, authorizer: auth, findAsset: (tenant, project, id) => tenant === principal.tenantId && project === projectId ? store.loadCatalog()?.projects[0].assets.find(a => a.id === id) ?? null : null });
        server = createApiServer({ productionImagePreparations: port, imageProviders: providers, runKernel: kernel, verifiedAssets }); await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error(); origin = `http://127.0.0.1:${address.port}`;
      })();
      await startup;
  }
  await page.route(/\/studio-api\/v1\/projects\/[^/]+\/(?:production-image-preparations|image-providers|budget|run-batches|assets)(?:\/[^?]*)?$/, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/studio-api/, "");
    if (/\/image-providers$/.test(path)) await initialize(decodeURIComponent(path.split("/")[3]));
    if (!origin || !path.includes(`/projects/${projectId}/`)) { await route.fulfill({ status: 403, json: { error: "owned_scope_denied" }, headers: { "cache-control": "no-store" } }); return; }
    if (/\/run-batches$/.test(path)) legacyReads++;
    const confirm = /\/confirm$/.test(path) && route.request().method() === "POST", create = /\/production-image-preparations$/.test(path) && route.request().method() === "POST";
    if (confirm) confirms++; if (create) creates++; if (/\/confirmation$/.test(path)) historyReads++;
    const response = await route.fetch({ url: origin + path, maxRedirects: 0 });
    if (confirm && mode === "hold") await new Promise<void>(resolve => { release = resolve; });
    try {
      if ((confirm && mode === "lost") || (create && mode === "prepare-lost") || (/\/budget$/.test(path) && mode === "budget-lost")) await route.abort("failed");
      else if (confirm && mode === "mismatch" && response.ok()) { const json = await response.json(); json.preparationFingerprint = "f".repeat(64); await route.fulfill({ json, headers: { "cache-control": "no-store" } }); }
      else await route.fulfill({ response });
    } catch { /* Browser cancellation can discard a response, never roll back a committed confirmation. */ }
  });
  return { get projectId() { return projectId; }, get confirms() { return confirms; }, get creates() { return creates; }, get historyReads() { return historyReads; }, get priceReads() { return priceReads; }, get contexts() { return contexts; }, get legacyReads() { return legacyReads; },
    snapshot: () => store.load(), budget: () => kernel.getBudget(principal, projectId), setMode: (v: typeof mode) => { mode = v; }, release: () => { mode = "good"; release?.(); },
    revoke: () => { allowed = false; }, revokePrice: () => { pricingAllowed = false; }, expire: () => { now += 61_000; },
    drift: () => { config = { ...config, revision: config.revision + 1, enabled: false }; providers.registerRevision(principal, config, config.revision - 1); },
    changeConstraint: () => store.transaction(() => { const catalog = store.loadCatalog()!; catalog.projects[0].constraints[0].brandRules.tone = "未经原人工确认"; store.saveCatalog(catalog); }) };
}
async function prepare(page: Page, protocol: ImageProviderConnection["protocol"] = "openai", edit = false, beforeSubmit?: () => Promise<void>) {
  await page.goto("/");
  if (edit) { await page.getByLabel("导入本地资产").setInputFiles({ name: "owned-production-original.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") }); await expect(page.getByRole("button", { name: "资产库 1" })).toBeVisible(); await page.getByRole("button", { name: "关闭资产库" }).click(); }
  await page.getByRole("button", { name: "＋ 约束" }).click(); const inspector = page.getByRole("complementary", { name: "人工约束" });
  await inspector.getByLabel("锁定商品主体像素").uncheck(); await inspector.getByLabel("区域 1 描述").fill("仅原人工指定布景"); await inspector.getByLabel("语气", { exact: true }).fill("原冻结品牌语气");
  await inspector.getByLabel("输出宽度").fill("1024"); await inspector.getByLabel("输出高度").fill("1024"); await inspector.getByLabel("输出格式").selectOption(protocol === "google" ? "jpeg" : "png"); await inspector.getByRole("button", { name: "保存为新约束快照" }).click();
  await page.getByRole("button", { name: "任务与预算", exact: true }).click(); const section = page.getByRole("region", { name: "生产图片准备" }); await expect(section.getByRole("button", { name: "刷新生产供应商目录" })).toBeEnabled();
  await section.getByLabel("生产图片供应商", { exact: true }).selectOption(`fixture-${protocol}`); await section.getByLabel("生产图片模型").selectOption("explicit-fixture-model"); await section.getByLabel("生产图片操作").selectOption(edit ? "edit" : "generate"); await section.getByLabel("生产图片约束").selectOption({ index: 1 });
  if (edit) await section.getByLabel("生产编辑输入 owned-production-original.png").check(); await section.getByLabel("生产图片设计指令").fill("原完整人工构图，不抽卡或换模型"); await section.getByLabel("生产图片质量").selectOption("auto"); await section.getByLabel("生产图片背景").selectOption("auto");
  await beforeSubmit?.(); await section.getByRole("button", { name: "保存未确认生产准备单" }).click(); const review = section.getByRole("region", { name: "生产图片人工冻结确认" }); if (!beforeSubmit) await expect(review.getByLabel("已核对生产完整冻结记录与独立上限")).toBeEnabled();
  return { section, review, check: review.getByLabel("已核对生产完整冻结记录与独立上限"), button: review.getByRole("button", { name: "人工确认生产记录并预留上限" }) };
}
for (const protocol of ["openai", "openai-compatible", "google"] as const) for (const manual of [false, true]) test(`${protocol}/${manual} 实际生产合同人工确认和刷新GET，一次max预留不生成`, async ({ page }) => {
  const f = await fixture(page, protocol, manual), { section, review, check, button } = await prepare(page, protocol);
  await expect(review).toContainText("原冻结品牌语气"); await expect(review).toContainText("仅原人工指定布景"); await expect(review).toContainText(manual ? "估价未知（不能当作0或上限）" : "原估价 25"); await expect(review).toContainText("独立预留上限 40"); await expect(button).toBeDisabled();
  expect(f.budget()).toMatchObject({ reservedMinor: 0, spentMinor: 0 }); await check.check(); await button.click(); await expect(review.getByRole("article", { name: "生产图片确认结果" })).toBeVisible();
  expect(f.confirms).toBe(1); expect(f.creates).toBe(1); expect(f.contexts).toBe(1); expect(f.legacyReads).toBe(0); expect(f.budget()).toMatchObject({ reservedMinor: 40, spentMinor: 0 }); expect(f.snapshot()?.batches[0].aggregate.batch.estimatedCostMinor).toBe(manual ? null : 25); expect(f.snapshot()?.batches[0].productionImageAttempt).toBeUndefined();
  await expect(section.getByRole("article", { name: "未确认生产准备单" })).toContainText("未确认 · 未授权执行 · 协议未准备"); const before = f.snapshot(); await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(page.getByRole("article", { name: "生产图片确认结果" })).toBeVisible();
  expect(f.snapshot()).toEqual(before); expect(f.confirms).toBe(1); expect(f.creates).toBe(1); expect(f.priceReads).toBe(1); expect(f.historyReads).toBeGreaterThan(1); await expect(page.getByRole("button", { name: /执行排队|重试失败/ })).toHaveCount(0);
});
for (const protocol of ["openai", "openai-compatible", "google"] as const) test(`${protocol} 编辑实际IndexedDB原图与权威SHA冻结，不用代理`, async ({ page }) => {
  const f = await fixture(page, protocol, true), { review, check, button } = await prepare(page, protocol, true); await expect(review).toContainText("image/png · 1×1 · 68 字节"); await expect(review).toContainText("SHA-256："); await check.check(); await button.click(); await expect(review.getByRole("article", { name: "生产图片确认结果" })).toBeVisible();
  const e = f.snapshot()?.batches[0].productionImageExecution; expect(e?.protocol.request.operation).toBe("edit"); expect(e?.protocol.transformedInputs).toHaveLength(1); expect(e?.protocol.transformedInputs[0].originalChecksumSha256).toBe(e?.protocol.request.inputs[0].checksumSha256); expect(f.budget().reservedMinor).toBe(40);
});
for (const mode of ["lost", "mismatch"] as const) test(`确认已提交但${mode}，原指针只GET不再POST`, async ({ page }) => {
  const f = await fixture(page), { review, check, button } = await prepare(page); f.setMode(mode); await check.check(); await button.click(); await expect(review.getByRole("alert")).toBeVisible(); await expect(button).toBeDisabled(); expect(f.confirms).toBe(1); expect(f.budget().reservedMinor).toBe(40);
  f.setMode("good"); await review.getByRole("button", { name: "只读核对生产确认结果" }).click(); await expect(review.getByRole("article", { name: "生产图片确认结果" })).toBeVisible(); expect(f.confirms).toBe(1);
});
for (const kind of ["permission", "price", "constraint", "directory"] as const) test(`确认时${kind}漂移保持unknown动作只读、不预留`, async ({ page }) => {
  const f = await fixture(page), { review, check, button } = await prepare(page); if (kind === "permission") f.revoke(); if (kind === "price") f.revokePrice(); if (kind === "constraint") f.changeConstraint(); if (kind === "directory") f.drift();
  await check.check(); await button.click(); await expect(review.getByRole("alert")).toBeVisible(); await expect(button).toBeDisabled(); expect(f.confirms).toBe(1); expect(f.budget().reservedMinor).toBe(0); expect(f.snapshot()?.batches ?? []).toHaveLength(0);
  await review.getByRole("button", { name: "只读核对生产确认结果" }).click(); await expect(button).toBeDisabled(); expect(f.confirms).toBe(1);
});
test("关闭丢弃已提交迟到确认，重开只读原结果", async ({ page }) => {
  const f = await fixture(page), { check, button } = await prepare(page); f.setMode("hold"); await check.check(); await button.click(); await expect.poll(() => f.budget().reservedMinor).toBe(40);
  await page.getByRole("button", { name: "关闭任务面板" }).click(); f.release(); await expect(page.getByRole("article", { name: "生产图片确认结果" })).toHaveCount(0); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(page.getByRole("article", { name: "生产图片确认结果" })).toBeVisible(); expect(f.confirms).toBe(1);
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
  f.setMode("good"); await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); const restored = page.getByRole("region", { name: "生产图片准备" }); await expect(restored).toContainText("原准备响应不明"); expect(f.creates).toBe(1); expect(f.contexts).toBe(1); await expect(restored.getByRole("button", { name: "保存未确认生产准备单" })).toBeDisabled();
});
test("损坏或跨项目指针失败关闭，不覆盖原内容或POST", async ({ page }) => {
  const f = await fixture(page), { section } = await prepare(page); await page.evaluate(() => { const key = Object.keys(localStorage).find(k => k.includes("production-preparation."))!; const p = JSON.parse(localStorage.getItem(key)!); p.projectId = "another-project"; localStorage.setItem(key, JSON.stringify(p)); });
  await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(section.getByRole("alert")).toBeVisible(); await expect(section.getByRole("button", { name: "保存未确认生产准备单" })).toBeDisabled(); expect(f.creates).toBe(1); expect(f.confirms).toBe(0);
  expect(await page.evaluate(() => Object.values(localStorage).some(raw => raw.includes("another-project")))).toBe(true);
});
test("切项目隔离已提交迟到确认，只回原项目GET恢复", async ({ page }) => {
  const f = await fixture(page), { check, button } = await prepare(page); f.setMode("hold"); await check.check(); await button.click(); await expect.poll(() => f.budget().reservedMinor).toBe(40);
  await page.getByLabel("切换项目").selectOption({ label: "活动套图工作台" }); f.release(); await expect(page.getByRole("region", { name: "生产图片准备" }).getByRole("alert")).toBeVisible(); await expect(page.getByRole("article", { name: "生产图片确认结果" })).toHaveCount(0);
  // App preserves the open panel across a project switch; clicking its toggle
  // here would close it. The project-keyed child itself must perform GET only.
  await page.getByLabel("切换项目").selectOption({ label: "商品主图工作台" }); await expect(page.getByRole("article", { name: "生产图片确认结果" })).toBeVisible(); expect(f.confirms).toBe(1); expect(f.creates).toBe(1); expect(f.contexts).toBe(1);
});
test("未知估价zero-cap仍须完整人工确认，刷新不自动补0实费", async ({ page }) => {
  const f = await fixture(page, "openai", true, 0), { review, check, button } = await prepare(page); await expect(review).toContainText("估价未知"); await expect(review).toContainText("独立预留上限 0"); await check.check(); await button.click(); await expect(review.getByRole("article", { name: "生产图片确认结果" })).toContainText("实费 未测得");
  expect(f.snapshot()?.batches[0].aggregate.jobs[0]).toMatchObject({ status: "queued", estimatedCostMinor: null }); expect(f.budget()).toMatchObject({ reservedMinor: 0, spentMinor: 0 }); const before = f.snapshot(); await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(page.getByRole("article", { name: "生产图片确认结果" })).toBeVisible(); expect(f.snapshot()).toEqual(before); expect(f.confirms).toBe(1);
});
test("已确认后预算响应失败保留结果，刷新恢复不重复预留", async ({ page }) => {
  const f = await fixture(page, "openai", true), { review, check, button } = await prepare(page); f.setMode("budget-lost"); await check.check(); await button.click(); await expect(review.getByRole("article", { name: "生产图片确认结果" })).toBeVisible(); await expect(review.getByRole("alert")).toBeVisible(); expect(f.budget().reservedMinor).toBe(40); expect(f.confirms).toBe(1);
});
test("过期停用的已确认历史只读，当前表单修改阻断新确认", async ({ page }) => {
  const f = await fixture(page), { section, review, check, button } = await prepare(page); await section.getByLabel("生产图片设计指令").fill("不能代替原构图"); await expect(button).toBeDisabled(); await expect(review).toContainText("原完整人工构图");
  await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await page.getByLabel("已核对生产完整冻结记录与独立上限").check(); await page.getByRole("button", { name: "人工确认生产记录并预留上限" }).click(); await expect(page.getByRole("article", { name: "生产图片确认结果" })).toBeVisible(); f.expire(); f.drift(); const before = f.snapshot();
  await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(page.getByRole("article", { name: "生产图片确认结果" })).toBeVisible(); expect(f.snapshot()).toEqual(before); expect(f.confirms).toBe(1); expect(f.priceReads).toBe(1);
});
test("390像素完整生产摘要无横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page, "openai", true); const { section, review } = await prepare(page);
  await review.scrollIntoViewIfNeeded(); expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true); await page.screenshot({ path: "test-results/production-confirmation-ui-390.png" });
});
test("默认日常入口不显示生产UI，不读取或启用旧local指针", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(page.getByRole("region", { name: "图片供应商准备" })).toBeVisible(); await expect(page.getByRole("region", { name: "生产图片准备" })).toHaveCount(0);
});
