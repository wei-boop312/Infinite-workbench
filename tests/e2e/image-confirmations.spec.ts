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
import { createRequire } from "node:module";
import { LocalGeneratedAssetReads } from "../../apps/api/src/generatedAssetReads";
import { LocalImageTaskArtifacts } from "../../apps/api/src/imageTaskArtifacts";
import { LocalFixtureImageExecutor } from "../../apps/api/src/imageFixtureExecutor";
import { createImageTaskValidator } from "../../apps/api/src/imageTaskPolicy";
import { createImageArtifactValidator } from "../../apps/api/src/imageArtifactPolicy";

test.use({ serviceWorkers: "block" });
const cleanups: Array<() => Promise<void>> = [];
test.afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// Real localhost HTTP + isolated SQLite, not seeded into the daily 5173 bridge.
// Confirmation tests have no transport. Result tests explicitly opt into ONE
// trusted, zero-fee local response on this isolated store; never supplier HTTP.
async function fixture(page: Page, protocol: ImageProviderConnection["protocol"] = "openai", boundOutput = false) {
  const directory = mkdtempSync(join(tmpdir(), "canvas-confirmation-browser-")), store = new SqliteRunKernelStateStore(join(directory, "state.sqlite"));
  let projectId = "", now = Date.now(), allowed = true, confirms = 0, historyReads = 0;
  let mode: "good" | "lost" | "mismatch" | "hold" = "good", release: (() => void) | undefined;
  let lineageAllowed = true, lineageReads = 0, holdLineage = false, sends = 0;
  const principal = { tenantId: "local-studio", actorId: "fixture-designer" };
  const authorizer = { authenticate: (request: { headers: Record<string, unknown> }) => request.headers["x-canvas-local"] === "1" ? principal : null,
    allows: (actor: typeof principal, project: string, permission: string) => actor.tenantId === principal.tenantId && project === projectId
      && (permission !== "run:confirm" || allowed) && (permission !== "run:read" || lineageAllowed) };
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
      store.transaction(() => {
        const previous = boundOutput ? store.loadCatalog()?.projects[0] : undefined;
        const merge = <T extends { id: string }>(before: T[], after: T[]) => {
          const items = new Map(before.map(item => [item.id, item]));
          for (const item of after) { const old = items.get(item.id); if (old && JSON.stringify(old) !== JSON.stringify(item)) throw new Error("immutable fixture catalog conflict"); items.set(item.id, item); }
          return [...items.values()];
        };
        store.saveCatalog({ schemaVersion: 1, projects: [{ ...context, assets: merge(previous?.assets ?? [], context.assets), constraints: merge(previous?.constraints ?? [], context.constraints) }] });
      });
      if (!origin) {
        kernel = new SqliteRunKernel({ stateStore: store, authorizer, budgets: [{ tenantId: principal.tenantId, projectId, currency: "CNY", limitMinor: 10000 }], clock: () => now,
          ...(boundOutput ? { validateImageTask: createImageTaskValidator({ tenantId: principal.tenantId, stateStore: store, providerAuthorizer: authorizer, assetAuthorizer: authorizer }),
            validateImageArtifact: createImageArtifactValidator({ tenantId: principal.tenantId, stateStore: store, providerAuthorizer: authorizer, assetAuthorizer: authorizer }) } : {}) });
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
        const reads = new LocalGeneratedAssetReads({ tenantId: principal.tenantId, stateStore: store, authorizer, runAuthorizer: authorizer });
        actualServer = createApiServer({ imageProviders: providers, runKernel: kernel, verifiedAssets, generatedAssetReads: reads, generatedAssetLineages: reads });
        await new Promise<void>(resolve => actualServer.listen(0, "127.0.0.1", resolve)); const address = actualServer.address(); if (!address || typeof address === "string") throw new Error();
        origin = `http://127.0.0.1:${address.port}`;
      }
    }
    await route.continue();
  });
  await page.route(/\/studio-api\/v1\/(?:projects\/[^/]+\/(?:image-providers|image-preparations|budget|run-batches|assets|generated-assets)(?:\/[^?]*)?|run-jobs\/[^/]+\/resolve-billing)$/, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/studio-api/, "");
    if (!origin || (path.includes("/projects/") && !path.includes(`/projects/${projectId}/`))) { await route.continue(); return; }
    const isConfirmation = /\/confirm$/.test(path) && route.request().method() === "POST";
    if (isConfirmation) confirms++; if (/\/confirmation$/.test(path)) historyReads++;
    const isLineage = /\/lineage$/.test(path); if (isLineage) lineageReads++;
    const response = await route.fetch({ url: origin + path, maxRedirects: 0 });
    if (isConfirmation && mode === "hold") await new Promise<void>(resolve => { release = resolve; });
    if (isLineage && holdLineage) await new Promise<void>(resolve => { release = resolve; });
    try {
      if (isConfirmation && mode === "lost") await route.abort("failed");
      else if (isConfirmation && mode === "mismatch" && response.ok()) { const body = await response.json(); body.aggregate.batch.currency = "USD"; await route.fulfill({ json: body, headers: { "cache-control": "no-store" } }); }
      else await route.fulfill({ response });
    } catch { /* Panel cancellation can discard the HTTP response, not the committed transaction. */ }
  });
  return { get projectId() { return projectId; }, get confirms() { return confirms; }, get historyReads() { return historyReads; }, get lineageReads() { return lineageReads; }, get sends() { return sends; },
    snapshot: () => store.load(), budget: () => kernel.getBudget(principal, projectId), setMode: (value: typeof mode) => { mode = value; },
    release: () => { mode = "good"; release?.(); }, revoke: () => { allowed = false; }, expire: () => { now += 61_000; },
    revokeLineage: () => { lineageAllowed = false; }, holdLineage: () => { holdLineage = true; }, releaseLineage: () => { holdLineage = false; release?.(); },
    executeFixture: async () => {
      if (!boundOutput) throw new Error("fixture transport is not configured");
      const batch = store.load()!.batches[0].aggregate, job = batch.jobs[0];
      const lease = kernel.claimImageBatch(principal, batch.batch.id, { workerId: "explicit-result-fixture", maxJobs: 1 }).leases[0];
      const sharp = createRequire(new URL("../../apps/api/package.json", import.meta.url))("sharp");
      const image = sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#3070b0" } });
      const original: Buffer = await (protocol === "google" ? image.jpeg() : image.png()).toBuffer();
      const packet = protocol === "google" ? { candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: original.toString("base64") } }] } }] }
        : { created: 1, data: [{ b64_json: original.toString("base64") }] };
      await new LocalFixtureImageExecutor({ stateStore: store, runKernel: kernel, clock: () => now,
        transport: { mode: "local-fixture", realExecutionEnabled: false, send: async () => { sends++; return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(packet)) }; } },
        artifacts: new LocalImageTaskArtifacts({ tenantId: principal.tenantId, stateStore: store, runKernel: kernel, authorizer, clock: () => now }) })
        .execute(principal, job.id, { workerId: lease.workerId, leaseId: lease.leaseId });
      return store.loadGeneratedImage(principal.tenantId, projectId, job.id)!;
    },
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

async function prepareBoundResult(page: Page, protocol: ImageProviderConnection["protocol"] = "openai", edit = false) {
  const f = await fixture(page, protocol, true), { review, button } = await prepare(page, protocol, edit);
  await review.getByLabel("已核对完整冻结摘要与假报价上限").check(); await button.click();
  await expect(review.getByRole("article", { name: "本地图片确认结果" })).toBeVisible();
  const record = await f.executeFixture();
  await page.getByRole("button", { name: "关闭任务面板" }).click(); await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  await expect(page.getByRole("button", { name: "只读核验输出 1 谱系" })).toBeEnabled();
  return { f, record };
}
for (const protocol of ["openai", "openai-compatible", "google"] as const) test(`${protocol} 实际本地原响应→资产绑定→只读结果谱系；费用仍unknown`, async ({ page }) => {
  const { f, record } = await prepareBoundResult(page, protocol), before = f.snapshot();
  expect(f.lineageReads).toBe(0); await page.getByRole("button", { name: "只读核验输出 1 谱系" }).click();
  const result = page.getByRole("article", { name: "已核验实际图片结果" }); await expect(result).toContainText(record.image.asset.id);
  await expect(result).toContainText("固定人工构图，不抽卡、不换模型"); await expect(result).toContainText("保持人工冻结的品牌语气");
  await expect(result).toContainText("费用未知 · 预留 30"); await expect(result).toContainText("非真实供应商生成");
  expect(f.snapshot()).toEqual(before); expect(f.sends).toBe(1); expect(f.confirms).toBe(1); expect(f.lineageReads).toBe(1);
  await expect(page.getByRole("button", { name: /执行排队|结果回到画布|重试失败/ })).toHaveCount(0);
  if (protocol === "openai") { await result.scrollIntoViewIfNeeded(); await page.screenshot({ path: "test-results/generated-result-lineage.png" }); }
});
test("编辑结果显示原输入SHA及输出关系；390像素无横溢", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const { record } = await prepareBoundResult(page, "openai", true);
  await page.getByRole("button", { name: "只读核验输出 1 谱系" }).click(); const result = page.getByRole("article", { name: "已核验实际图片结果" });
  await expect(result).toContainText(record.request.inputs[0].assetId); await expect(result).toContainText(record.request.inputs[0].checksumSha256);
  expect(record.image.asset.sourceAssetId).toBe(record.request.inputs[0].assetId);
  expect(await page.getByRole("complementary", { name: "任务与预算" }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});
test("缓存后谱系撤权不留旧授权视图，不删除良好缓存或修改费用", async ({ page }) => {
  const { f, record } = await prepareBoundResult(page); await page.getByRole("button", { name: "缓存输出 1 原图" }).click();
  await expect(page.getByRole("complementary", { name: "任务与预算" })).toContainText("原文件已缓存到项目资产库"); await page.getByRole("button", { name: "只读核验输出 1 谱系" }).click();
  await expect(page.getByRole("article", { name: "已核验实际图片结果" })).toBeVisible(); const before = f.snapshot(); f.revokeLineage();
  await page.getByRole("button", { name: "只读核验输出 1 谱系" }).click(); await expect(page.getByRole("region", { name: "实际图片结果谱系" }).getByRole("alert")).toBeVisible();
  await expect(page.getByRole("article", { name: "已核验实际图片结果" })).toHaveCount(0);
  expect(await page.evaluate(async id => { const { assetRepository } = await import("/src/assets/assetRepository.ts"); return !!await assetRepository.getBlob(id, "original"); }, record.image.asset.id)).toBe(true);
  expect(f.snapshot()).toEqual(before); expect(f.sends).toBe(1);
});
test("关闭面板取消迟到谱系响应，重开须重新只读核验而非沿用视图", async ({ page }) => {
  const { f } = await prepareBoundResult(page); const before = f.snapshot(); f.holdLineage(); await page.getByRole("button", { name: "只读核验输出 1 谱系" }).click();
  await expect.poll(() => f.lineageReads).toBe(1); await page.getByRole("button", { name: "关闭任务面板" }).click(); f.releaseLineage();
  await page.getByRole("button", { name: "任务与预算", exact: true }).click(); await expect(page.getByRole("button", { name: "只读核验输出 1 谱系" })).toBeEnabled();
  await expect(page.getByRole("article", { name: "已核验实际图片结果" })).toHaveCount(0); expect(f.lineageReads).toBe(1);
  await page.getByRole("button", { name: "只读核验输出 1 谱系" }).click(); await expect(page.getByRole("article", { name: "已核验实际图片结果" })).toBeVisible();
  expect(f.snapshot()).toEqual(before); expect(f.sends).toBe(1); expect(f.lineageReads).toBe(2);
});

async function cacheBoundResult(page: Page) {
  await page.getByRole("button", { name: "缓存输出 1 原图" }).click();
  await expect(page.getByRole("complementary", { name: "任务与预算" })).toContainText("原文件已缓存到项目资产库");
}
async function savedCanvas(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem(`ai-commerce-canvas.document.${localStorage.getItem("ai-commerce-canvas.active-document")}`)!));
}
for (const protocol of ["openai", "openai-compatible", "google"] as const) test(`${protocol} 实际产物原图缓存→受控回画布→撤销重做刷新，不重新发送或释放预留`, async ({ page }) => {
  const { f, record } = await prepareBoundResult(page, protocol, protocol === "openai"), before = f.snapshot();
  await cacheBoundResult(page); const count = (await savedCanvas(page)).nodes.length;
  const button = page.getByRole("button", { name: "核验缓存原图并回画布" }); await button.click();
  await expect(page.getByRole("region", { name: "实际图片结果谱系" })).toContainText("已核验缓存原图并回到画布");
  const nodeId = `image-result-${record.request.jobId}-output`, outputNode = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(outputNode.locator("img")).toBeVisible(); await expect(outputNode).toContainText("费用未知");
  const addedCount = record.request.operation === "edit" ? 4 : 3; await expect.poll(async () => (await savedCanvas(page)).nodes.length).toBe(count + addedCount);
  await button.click(); await expect(button).toBeEnabled(); expect((await savedCanvas(page)).nodes.length).toBe(count + addedCount);
  expect(f.lineageReads).toBe(2); expect(f.snapshot()).toEqual(before); expect(f.sends).toBe(1); expect(f.confirms).toBe(1); expect(f.budget().reservedMinor).toBe(30);
  await page.getByRole("button", { name: "关闭任务面板" }).click(); await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => (await savedCanvas(page)).nodes.length).toBe(count); await page.getByRole("button", { name: "重做", exact: true }).click(); await expect(outputNode.locator("img")).toBeVisible();
  await expect.poll(async () => (await savedCanvas(page)).nodes.find((n: any) => n.id === nodeId)?.data.assetId).toBe(record.image.asset.id);
  const document = await savedCanvas(page), data = document.nodes.find((n: any) => n.id === nodeId).data;
  expect(data.generatedHistory).toMatchObject({ evidence: "local-fixture-history", model: record.request.model, confirmedBy: "fixture-designer", checksumSha256: record.image.checksumSha256,
    billingState: "unknown", reservedMinor: 30, inputAssetIds: record.request.inputs.map(input => input.assetId) });
  expect(JSON.stringify(document)).not.toMatch(/data:image|blob:|https:\/\/|credentialRef|idempotencyKey|leaseId/);
  await page.reload(); await expect(outputNode.locator("img")).toBeVisible(); expect(f.snapshot()).toEqual(before); expect(f.sends).toBe(1);
  if (protocol === "openai") {
    await page.screenshot({ path: "test-results/generated-result-canvas.png" });
    const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "导出项目包" }).click(); const download = await downloadPromise;
    await page.getByLabel("选择画布项目包").setInputFiles((await download.path())!);
    await page.getByRole("alertdialog", { name: "确认导入项目包" }).getByRole("button", { name: "确认导入副本" }).click();
    await expect(page.getByLabel("切换项目")).toHaveValue(/import-/); await expect(outputNode.locator("img")).toBeVisible(); await expect(outputNode).toContainText("导入历史副本");
    await expect.poll(async () => (await savedCanvas(page)).nodes.find((n: any) => n.id === nodeId)?.data.generatedHistory?.evidence).toBe("imported-copy-history");
    const copy = (await savedCanvas(page)).nodes.find((n: any) => n.id === nodeId).data; expect(copy.assetId).not.toBe(record.image.asset.id);
    expect(copy.generatedHistory.originProjectId).toBe(f.projectId); expect(copy.generatedHistory.inputAssetIds).not.toEqual(data.generatedHistory.inputAssetIds);
    const failure = await page.evaluate(async ({ image, assetId }) => {
      const { assetRepository } = await import("/src/assets/assetRepository.ts"); const projectId = JSON.parse(localStorage.getItem(`ai-commerce-canvas.document.${localStorage.getItem("ai-commerce-canvas.active-document")}`)!).projectId;
      const asset = (await assetRepository.list(projectId)).find(a => a.id === assetId)!;
      try { await assetRepository.readGenerated({ ...image, asset }, new AbortController().signal); return "unexpected"; } catch (error) { return String(error); }
    }, { image: record.image, assetId: copy.assetId }); expect(failure).toContain("导入副本"); expect(f.sends).toBe(1);
  }
});
test("未缓存时拒绝；良好缓存也不能用上次谱系授权绕过撤权", async ({ page }) => {
  const { f } = await prepareBoundResult(page), before = f.snapshot(), count = await page.locator(".react-flow__node").count();
  await page.getByRole("button", { name: "核验缓存原图并回画布" }).click(); const region = page.getByRole("region", { name: "实际图片结果谱系" });
  await expect(region.getByRole("alert")).toContainText("请先完整缓存"); await expect(page.locator(".react-flow__node")).toHaveCount(count);
  await cacheBoundResult(page); await page.getByRole("button", { name: "只读核验输出 1 谱系" }).click(); await expect(page.getByRole("article", { name: "已核验实际图片结果" })).toBeVisible();
  f.revokeLineage(); await region.getByRole("button", { name: "核验缓存原图并回画布" }).click(); await expect(region.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("article", { name: "已核验实际图片结果" })).toHaveCount(0); await expect(page.locator(".react-flow__node")).toHaveCount(count);
  expect(f.lineageReads).toBe(3); expect(f.snapshot()).toEqual(before); expect(f.sends).toBe(1);
});
for (const damage of ["marker", "original", "metadata", "checksum", "foreign-project", "ordinary-restored"] as const) test(`实际任务仍绑定但${damage}缓存损坏拒绝回画布，不改费用或删除文件`, async ({ page }) => {
  const { f, record } = await prepareBoundResult(page); await cacheBoundResult(page); const count = await page.locator(".react-flow__node").count(), before = f.snapshot();
  await page.evaluate(async ({ id, damage }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("ai-commerce-canvas-assets", 3); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const transaction = database.transaction(["assets", "blobs", "generatedCaches"], "readwrite"), done = new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
      const assets = transaction.objectStore("assets"), blobs = transaction.objectStore("blobs"), markers = transaction.objectStore("generatedCaches");
      if (damage === "marker" || damage === "ordinary-restored") markers.delete(id);
      if (damage === "original") blobs.delete(`${id}:original`);
      if (damage === "metadata" || damage === "foreign-project") { const request = assets.get(id); request.onsuccess = () => assets.put({ ...request.result, ...(damage === "metadata" ? { originalName: "not-original.png" } : { projectId: "foreign" }) }); }
      if (damage === "checksum") { const request = blobs.get(`${id}:original`); request.onsuccess = () => blobs.put({ ...request.result, blob: new Blob([new Uint8Array(request.result.blob.size)], { type: "image/png" }) }); }
      await done;
    } finally { database.close(); }
  }, { id: record.image.asset.id, damage });
  await page.getByRole("button", { name: "核验缓存原图并回画布" }).click(); await expect(page.getByRole("region", { name: "实际图片结果谱系" }).getByRole("alert")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(count); expect(f.snapshot()).toEqual(before); expect(f.sends).toBe(1); expect(f.lineageReads).toBe(1);
});
test("回画布迟到谱系响应在项目切换/关闭后丢弃，无伪节点或自动补读", async ({ page }) => {
  const { f } = await prepareBoundResult(page); await cacheBoundResult(page); const before = f.snapshot();
  f.holdLineage(); await page.getByRole("button", { name: "核验缓存原图并回画布" }).click(); await expect.poll(() => f.lineageReads).toBe(1);
  await page.getByLabel("切换项目").selectOption("phase-1-campaign"); f.releaseLineage(); await expect(page.locator('.react-flow__node[data-id^="image-result-"]')).toHaveCount(0);
  await page.getByLabel("切换项目").selectOption("phase-1-demo");
  await expect(page.getByRole("button", { name: "核验缓存原图并回画布" })).toBeEnabled(); await expect(page.locator('.react-flow__node[data-id^="image-result-"]')).toHaveCount(0);
  expect(f.lineageReads).toBe(1); expect(f.snapshot()).toEqual(before); expect(f.sends).toBe(1);
});
test("实际已核账产物回画布保留实费；后续重复回流不重复结算或改原响应", async ({ page }) => {
  const { f, record } = await prepareBoundResult(page); await cacheBoundResult(page);
  const raw = f.snapshot()?.batches[0].imageFixtureResult; expect(raw?.kind).toBe("returned");
  await page.getByRole("button", { name: "核对输出 1 计费" }).click(); const decision = page.getByRole("alertdialog", { name: "确认计费核账" });
  await decision.getByLabel("核账结论").selectOption("charged"); await decision.getByLabel("核实扣费金额").fill("0.27");
  await decision.getByLabel("核账证据引用").fill("explicit-local-fixture-accounting-no-real-charge"); await decision.getByRole("button", { name: "提交核账结论" }).click(); await expect(decision).toBeHidden();
  expect(f.budget()).toMatchObject({ reservedMinor: 0, spentMinor: 27 }); expect(f.snapshot()?.batches[0].imageFixtureResult).toEqual(raw);
  const before = f.snapshot(); await page.getByRole("button", { name: "核验缓存原图并回画布" }).click();
  await expect(page.getByRole("article", { name: "已核验实际图片结果" })).toContainText("已人工核账 · 实费 27 · 预留 0");
  await expect.poll(async () => (await savedCanvas(page)).nodes.find((n: any) => n.data.assetId === record.image.asset.id)?.data.generatedHistory?.billingState).toBe("settled");
  const history = (await savedCanvas(page)).nodes.find((n: any) => n.data.assetId === record.image.asset.id).data.generatedHistory;
  expect(history).toMatchObject({ actualMinor: 27, reservedMinor: 0, maxCostMinor: 30, estimatedCostMinor: 25 });
  await page.getByRole("button", { name: "核验缓存原图并回画布" }).click(); await expect(page.getByRole("button", { name: "核验缓存原图并回画布" })).toBeEnabled();
  expect(f.snapshot()).toEqual(before); expect(f.sends).toBe(1); expect(f.confirms).toBe(1);
});
test("390像素结果历史可读且不横溢；原图预览不是Base64，历史不冒充当前授权", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const { record } = await prepareBoundResult(page); await cacheBoundResult(page);
  await page.getByRole("button", { name: "核验缓存原图并回画布" }).click(); await expect(page.getByRole("region", { name: "实际图片结果谱系" })).toContainText("已核验缓存原图并回到画布");
  await page.getByRole("button", { name: "关闭任务面板" }).click();
  const history = page.getByRole("complementary", { name: "生成结果历史" }); await expect(history).toContainText("不是实时账本或当前服务端授权"); await expect(history).toContainText(record.image.checksumSha256);
  expect(await history.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/generated-result-history-mobile.png" });
});
