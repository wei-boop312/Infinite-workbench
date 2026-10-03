import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { RegisterRunContextRequestSchema, ImageProviderConnectionSchema, type ImageProviderConnection } from "../../packages/contracts/src/index";
import { LocalImageProviders } from "../../apps/api/src/imageProviders";
import { SqliteRunKernelStateStore } from "../../apps/api/src/sqliteRunKernelStore";
import { SqliteRunKernel } from "../../apps/api/src/sqliteRunKernel";
import { createApiServer } from "../../apps/api/src/index";
import { LocalVerifiedAssets } from "../../apps/api/src/verifiedAssets";
import { fixtureConnection } from "../fixtures/image-preparation";

test.use({ serviceWorkers: "block" });
const cleanups: Array<() => Promise<void>> = [];
test.afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// Real localhost HTTP + isolated SQLite, not seeded into the daily 5173 bridge.
// No transport/credentials/real executor is configured even in this fixture.
async function fixture(page: Page, protocol: ImageProviderConnection["protocol"] = "openai") {
  const directory = mkdtempSync(join(tmpdir(), "canvas-confirmation-browser-")), store = new SqliteRunKernelStateStore(join(directory, "state.sqlite"));
  let projectId = "", now = Date.now(), allowed = true, confirms = 0, historyReads = 0;
  let mode: "good" | "lost" | "mismatch" | "hold" = "good", release: (() => void) | undefined;
  const principal = { tenantId: "local-studio", actorId: "fixture-designer" };
  const authorizer = { authenticate: (request: { headers: Record<string, unknown> }) => request.headers["x-canvas-local"] === "1" ? principal : null,
    allows: (actor: typeof principal, project: string, permission: string) => actor.tenantId === principal.tenantId && project === projectId && (permission !== "run:confirm" || allowed) };
  let kernel!: SqliteRunKernel, providers!: LocalImageProviders, config!: ImageProviderConnection;
  const server = createApiServer(); // Replaced once the browser's actual project is registered.
  let actualServer = server, origin = "";
  cleanups.push(async () => {
    release?.(); if (actualServer.listening) await new Promise<void>(resolve => actualServer.close(() => resolve())); store.close();
    const target = resolve(directory); if (!target.startsWith(resolve(tmpdir()) + "\\canvas-confirmation-browser-")) throw new Error("unsafe test cleanup");
    rmSync(target, { recursive: true, force: true });
  });
  await page.route("**/studio-api/context", async route => {
    const context = RegisterRunContextRequestSchema.parse(route.request().postDataJSON());
    if (!projectId) projectId = context.projectId;
    if (context.projectId === projectId) {
      store.transaction(() => store.saveCatalog({ schemaVersion: 1, projects: [context] }));
      if (!origin) {
        kernel = new SqliteRunKernel({ stateStore: store, authorizer, budgets: [{ tenantId: principal.tenantId, projectId, currency: "CNY", limitMinor: 10000 }], clock: () => now });
        providers = new LocalImageProviders({ tenantId: principal.tenantId, stateStore: store, authorizer, assetAuthorizer: authorizer, runAuthorizer: authorizer, runKernel: kernel,
          estimate: (_connection, _selection, at) => ({ mode: "local-fixture", evidenceRef: "explicit-zero-fee-fixture", quote: { id: "fixture-quote", version: "fake-price-v1", source: "server-price-table",
            currency: "CNY", estimatedCostMinor: 25, maxCostMinor: 30, expiresAt: new Date(Date.parse(at) + 60_000).toISOString() } }), clock: () => now });
        const base = fixtureConnection(protocol);
        config = ImageProviderConnectionSchema.parse({ ...base, projectId,
          ...(protocol === "google" ? { baseUrl: "https://generativelanguage.googleapis.com", googleNative: { version: "google-profile-v1", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1",
            modelMappings: [{ model: base.models[0].model, sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] },
            models: [{ ...base.models[0], sizes: { allowAuto: true, presets: [{ width: 1024, height: 1024 }] }, qualities: ["auto"], backgrounds: ["auto"] }] } : {}) });
        providers.registerRevision(principal, config, 0);
        const verifiedAssets = new LocalVerifiedAssets({ stateStore: store, authorizer,
          findAsset: (tenantId, project, id) => tenantId === principal.tenantId && project === projectId ? store.loadCatalog()?.projects[0].assets.find(asset => asset.id === id) ?? null : null });
        actualServer = createApiServer({ imageProviders: providers, runKernel: kernel, verifiedAssets });
        await new Promise<void>(resolve => actualServer.listen(0, "127.0.0.1", resolve)); const address = actualServer.address(); if (!address || typeof address === "string") throw new Error();
        origin = `http://127.0.0.1:${address.port}`;
      }
    }
    await route.continue();
  });
  await page.route(/\/studio-api\/v1\/projects\/[^/]+\/(?:image-providers|image-preparations|budget|run-batches|assets)(?:\/[^?]*)?$/, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/studio-api/, "");
    if (!origin || !path.includes(`/projects/${projectId}/`)) { await route.continue(); return; }
    const isConfirmation = /\/confirm$/.test(path) && route.request().method() === "POST";
    if (isConfirmation) confirms++; if (/\/confirmation$/.test(path)) historyReads++;
    const response = await route.fetch({ url: origin + path, maxRedirects: 0 });
    if (isConfirmation && mode === "hold") await new Promise<void>(resolve => { release = resolve; });
    try {
      if (isConfirmation && mode === "lost") await route.abort("failed");
      else if (isConfirmation && mode === "mismatch" && response.ok()) { const body = await response.json(); body.aggregate.batch.currency = "USD"; await route.fulfill({ json: body, headers: { "cache-control": "no-store" } }); }
      else await route.fulfill({ response });
    } catch { /* Panel cancellation can discard the HTTP response, not the committed transaction. */ }
  });
  return { get projectId() { return projectId; }, get confirms() { return confirms; }, get historyReads() { return historyReads; },
    snapshot: () => store.load(), budget: () => kernel.getBudget(principal, projectId), setMode: (value: typeof mode) => { mode = value; },
    release: () => { mode = "good"; release?.(); }, revoke: () => { allowed = false; }, expire: () => { now += 61_000; },
    drift: () => { config = { ...config, revision: config.revision + 1, enabled: false }; providers.registerRevision(principal, config, config.revision - 1); },
    mutateConstraint: () => store.transaction(() => { const catalog = store.loadCatalog()!; catalog.projects[0].constraints[0].brandRules.tone = "不应成为原人工确认"; store.saveCatalog(catalog); }) };
}
async function prepare(page: Page, protocol: ImageProviderConnection["protocol"] = "openai", edit = false) {
  await page.goto("/");
  if (edit) {
    await page.getByLabel("导入本地资产").setInputFiles({ name: "verified-edit-original.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
    await expect(page.getByRole("button", { name: "资产库 1" })).toBeVisible(); await page.getByRole("button", { name: "关闭资产库" }).click();
  }
  await page.getByRole("button", { name: "＋ 约束" }).click();
  const inspector = page.getByRole("complementary", { name: "人工约束" });
  await inspector.getByLabel("锁定商品主体像素").uncheck(); await inspector.getByLabel("区域 1 描述").fill("只编辑人工指定的布景");
  await inspector.getByLabel("语气", { exact: true }).fill("保持人工冻结的品牌语气");
  await inspector.getByLabel("输出宽度").fill("1024"); await inspector.getByLabel("输出高度").fill("1024"); await inspector.getByLabel("输出格式").selectOption(protocol === "google" ? "jpeg" : "png");
  await inspector.getByRole("button", { name: "保存为新约束快照" }).click(); await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  const section = page.getByRole("region", { name: "图片供应商准备" }); await expect(section.getByRole("button", { name: "刷新供应商目录" })).toBeEnabled();
  await section.getByLabel("图片供应商", { exact: true }).selectOption(`fixture-${protocol}`); await section.getByLabel("图片模型").selectOption("explicit-fixture-model");
  await section.getByLabel("图片操作").selectOption(edit ? "edit" : "generate"); await section.getByLabel("图片准备约束").selectOption({ index: 1 });
  if (edit) await section.getByLabel("编辑输入 verified-edit-original.png").check();
  await section.getByLabel("图片设计指令").fill("固定人工构图，不抽卡、不换模型"); await section.getByLabel("图片质量").selectOption("auto"); await section.getByLabel("图片背景").selectOption("auto");
  await section.getByRole("button", { name: "保存未确认假报价准备单" }).click();
  const review = section.getByRole("region", { name: "图片人工冻结确认" }); await expect(review.getByLabel("已核对完整冻结摘要与假报价上限")).toBeEnabled();
  return { section, review, button: review.getByRole("button", { name: "确认假报价并预留上限" }) };
}

for (const protocol of ["openai", "openai-compatible", "google"] as const) test(`${protocol} 完整人工核对→真实本地确认事务→刷新GET恢复；不生成`, async ({ page }) => {
  const f = await fixture(page, protocol), { section, review, button } = await prepare(page, protocol);
  await expect(review).toContainText("保持人工冻结的品牌语气"); await expect(review).toContainText("只编辑人工指定的布景"); await expect(review).toContainText("预算预留上限 30");
  await expect(button).toBeDisabled(); expect(f.budget()).toMatchObject({ reservedMinor: 0, spentMinor: 0 }); expect(f.confirms).toBe(0);
  await review.getByLabel("已核对完整冻结摘要与假报价上限").check(); await button.click();
  await expect(review.getByRole("article", { name: "本地图片确认结果" })).toContainText("已人工确认 · 未授权执行");
  expect(f.confirms).toBe(1); expect(f.snapshot()?.batches).toHaveLength(1); expect(f.budget()).toMatchObject({ reservedMinor: 30, spentMinor: 0 });
  expect(f.snapshot()?.batches[0]).toMatchObject({ aggregate: { batch: { status: "queued" }, jobs: [{ status: "queued", outputAssetIds: [] }] } });
  expect(f.snapshot()?.batches[0].imageDispatchIntent).toBeUndefined();
  await expect(page.locator(".run-budget")).toContainText("¥0.30"); await expect(section.getByRole("article", { name: "未确认图片准备单" })).toContainText("未确认 · 未授权执行 · 协议未准备");
  if (protocol === "openai") { await review.scrollIntoViewIfNeeded(); await page.screenshot({ path: "test-results/image-confirmation-ui.png" }); }
  await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  await expect(page.getByRole("article", { name: "本地图片确认结果" })).toBeVisible(); expect(f.confirms).toBe(1); expect(f.historyReads).toBeGreaterThan(1);
  expect(f.budget().reservedMinor).toBe(30); await expect(page.getByRole("button", { name: /执行排队|重试失败/ })).toHaveCount(0);
});

test("编辑人工摘要使用实际已核验原文件SHA/尺寸/顺序，确认保留输入转换谱系且不生成", async ({ page }) => {
  const f = await fixture(page), { review, button } = await prepare(page, "openai", true);
  await expect(review).toContainText("image/png · 1×1 · 68 字节"); await expect(review).toContainText("SHA-256：");
  await review.getByLabel("已核对完整冻结摘要与假报价上限").check(); await button.click(); await expect(review.getByRole("article", { name: "本地图片确认结果" })).toBeVisible();
  const execution = f.snapshot()?.batches[0].imageExecution; expect(execution?.request.operation).toBe("edit"); expect(execution?.transformedInputs).toHaveLength(1);
  expect(execution?.transformedInputs[0]).toMatchObject({ originalChecksumSha256: execution?.request.inputs[0].checksumSha256, transform: "exif-srgb-png-v1" });
  expect(f.confirms).toBe(1); expect(f.snapshot()?.batches[0].imageFixtureAttempt).toBeUndefined(); expect(f.budget()).toMatchObject({ reservedMinor: 30, spentMinor: 0 });
});

for (const mode of ["lost", "mismatch"] as const) test(`确认已提交但${mode}响应只读恢复，不重新POST或二次预留`, async ({ page }) => {
  const f = await fixture(page), { review, button } = await prepare(page); f.setMode(mode);
  await review.getByLabel("已核对完整冻结摘要与假报价上限").check(); await button.click();
  await expect(review.getByRole("alert")).toBeVisible(); await expect(button).toBeDisabled(); expect(f.confirms).toBe(1); expect(f.budget().reservedMinor).toBe(30);
  f.setMode("good"); await review.getByRole("button", { name: "只读核对确认结果" }).click();
  await expect(review.getByRole("article", { name: "本地图片确认结果" })).toBeVisible(); expect(f.confirms).toBe(1); expect(f.snapshot()?.batches).toHaveLength(1);
  expect(f.budget()).toMatchObject({ reservedMinor: 30, spentMinor: 0 });
});

for (const reason of ["permission", "quote", "revision", "constraint"] as const) test(`确认前${reason}漂移服务端拒绝，无任务/预留且不自动重报价`, async ({ page }) => {
  const f = await fixture(page), { review, button } = await prepare(page);
  if (reason === "permission") f.revoke(); if (reason === "quote") f.expire(); if (reason === "revision") f.drift(); if (reason === "constraint") f.mutateConstraint();
  await review.getByLabel("已核对完整冻结摘要与假报价上限").check(); await button.click();
  await expect(review.getByRole("alert")).toBeVisible(); await expect(button).toBeDisabled(); expect(f.confirms).toBe(1); expect(f.snapshot()?.batches).toHaveLength(0);
  expect(f.budget()).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
});

test("确认恢复指针存储失败时不POST；当前参数修改与目录刷新阻断旧确认", async ({ page }) => {
  const f = await fixture(page), { section, review, button } = await prepare(page);
  await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.includes("image-confirmation.")) throw new Error("fixture-full"); return original.call(this, key, value); }; });
  await review.getByLabel("已核对完整冻结摘要与假报价上限").check(); await button.click(); await expect(review.getByRole("alert")).toBeVisible(); expect(f.confirms).toBe(0);
  await section.getByLabel("图片设计指令").fill("新的指令不可复用旧确认"); await expect(review.getByLabel("已核对完整冻结摘要与假报价上限")).toBeDisabled(); await expect(button).toBeDisabled();
  f.drift(); await section.getByRole("button", { name: "刷新供应商目录" }).click(); await expect(section).toContainText("当前目录与冻结版本不同");
  expect(f.snapshot()?.batches).toHaveLength(0); expect(f.budget().reservedMinor).toBe(0);
});

test("关闭面板丢弃迟到确认响应，重开只GET原确认且保留一次预留", async ({ page }) => {
  const f = await fixture(page), { review, button } = await prepare(page); f.setMode("hold");
  await review.getByLabel("已核对完整冻结摘要与假报价上限").check(); await button.click();
  await expect.poll(() => f.budget().reservedMinor).toBe(30); await page.getByRole("button", { name: "关闭任务面板" }).click(); f.release();
  await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(page.getByRole("article", { name: "本地图片确认结果" })).toBeVisible();
  expect(f.confirms).toBe(1); expect(f.snapshot()?.batches).toHaveLength(1); expect(f.budget().reservedMinor).toBe(30);
});

test("390像素人工摘要不横溢；损坏/跨项目确认指针失败关闭，不覆盖原历史", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page), { review, button } = await prepare(page);
  await review.scrollIntoViewIfNeeded(); await expect(button).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.getByRole("complementary", { name: "任务与预算" }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.evaluate(projectId => localStorage.setItem(`ai-commerce-canvas.image-confirmation.${projectId}`, JSON.stringify({ schemaVersion: 1,
    projectId: "foreign", preparationId: "invented", preparationFingerprint: "a".repeat(64), executionAuthorized: true })), f.projectId);
  await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  const section = page.getByRole("region", { name: "图片供应商准备" }); await expect(section.getByRole("alert")).toContainText("确认恢复指针损坏或跨项目");
  await expect(section.getByRole("region", { name: "图片人工冻结确认" })).toHaveCount(0); expect(f.confirms).toBe(0); expect(f.budget().reservedMinor).toBe(0);
  await section.getByRole("button", { name: "开始新准备动作（保留服务端历史）" }).click();
  expect(await page.evaluate(projectId => localStorage.getItem(`ai-commerce-canvas.image-confirmation.${projectId}`), f.projectId)).toBeNull(); expect(f.snapshot()?.batches).toHaveLength(0);
});
