import { expect, test, type Page } from "@playwright/test";
import { CreateImagePreparationSchema, type CreateImagePreparation, type ImagePreparationPublic, type ImageProviderConnection } from "../../packages/contracts/src/index";
import { imageProviderPublicView } from "../../apps/api/src/imageProviderContract";
import { fixtureConnection, fixturePublicPreparation } from "../fixtures/image-preparation";

test.use({ serviceWorkers: "block" });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function open(page: Page, options: { locked?: boolean; edge?: number; format?: "png" | "jpeg" } = {}) {
  await page.goto("/");
  await page.getByLabel("导入本地资产").setInputFiles({ name: "preparation-source.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("button", { name: "资产库 1" })).toBeVisible();
  await page.getByRole("button", { name: "关闭资产库" }).click(); await page.getByRole("button", { name: "＋ 约束" }).click();
  const inspector = page.getByRole("complementary", { name: "人工约束" });
  if (!options.locked) await inspector.getByLabel("锁定商品主体像素").uncheck();
  await inspector.getByLabel("输出宽度").fill(String(options.edge ?? 1024)); await inspector.getByLabel("输出高度").fill(String(options.edge ?? 1024));
  await inspector.getByLabel("输出格式").selectOption(options.format ?? "png");
  await inspector.getByRole("button", { name: "保存为新约束快照" }).click();
  await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "任务与预算" }), section = panel.getByRole("region", { name: "图片供应商准备" });
  await expect(section.getByRole("button", { name: "刷新供应商目录" })).toBeEnabled();
  return { panel, section };
}
// Public directory/preparation contract routes only. They DO NOT register a
// provider or execute a model in the day-to-day or test bridge database.
async function routes(page: Page, protocol: ImageProviderConnection["protocol"] = "openai") {
  const visible = imageProviderPublicView(fixtureConnection(protocol));
  const submissions: CreateImagePreparation[] = [], reads: string[] = [], saved = new Map<string, ImagePreparationPublic>();
  let mode: "good" | "mismatch" | "denied" = "good";
  let revision = 1;
  let release: (() => void) | null = null; let hold = false;
  await page.route("**/studio-api/v1/projects/*/image-providers", async route => {
    await route.fulfill({ json: [{ ...visible, revision }], headers: { "cache-control": "no-store" } });
  });
  await page.route("**/studio-api/v1/projects/*/image-preparations/*/confirmation", async route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
    const record = [...saved.values()].find(item => item.id === id);
    await route.fulfill({ json: { mode: "local-fixture", preparationId: id, preparationFingerprint: record?.snapshotFingerprint ?? "a".repeat(64), confirmation: null }, headers: { "cache-control": "no-store" } });
  });
  await page.route(/\/studio-api\/v1\/projects\/[^/]+\/image-preparations(?:\/[^/?]+)?$/, async route => {
    const request = route.request();
    expect(request.headers()["x-canvas-local"]).toBe("1");
    if (request.method() === "GET") {
      const id = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-1)!); reads.push(id);
      const record = [...saved.values()].find(item => item.id === id);
      await route.fulfill({ status: record ? 200 : 404, json: record ?? { error: "image_preparation_not_found" }, headers: { "cache-control": "no-store" } }); return;
    }
    const selection = CreateImagePreparationSchema.parse(request.postDataJSON()); submissions.push(selection);
    let record = saved.get(selection.idempotencyKey);
    if (!record) {
      record = fixturePublicPreparation(selection, `preparation-${saved.size + 1}`); saved.set(selection.idempotencyKey, record);
    }
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    try {
      await route.fulfill({ status: mode === "denied" ? 403 : 201,
        json: mode === "denied" ? { error: "image_preparation_permission_denied" } : mode === "mismatch" ? { ...record, requestTemplate: { ...record.requestTemplate, parameters: { ...record.requestTemplate.parameters, prompt: "not-human-input" } } } : record,
        headers: { "cache-control": "no-store" } });
    } catch { /* A closed panel legitimately cancels the response. */ }
  });
  return { visible, submissions, reads, saved, setMode: (value: typeof mode) => { mode = value; }, changeRevision: () => { revision++; },
    hold: () => { hold = true; }, release: () => { hold = false; release?.(); } };
}
async function choose(section: ReturnType<Page["getByRole"]>, connectionId = "fixture-openai", operation = "generate") {
  await section.getByLabel("图片供应商", { exact: true }).selectOption(connectionId);
  await expect(section.getByLabel("图片模型")).toHaveValue("");
  await section.getByLabel("图片模型").selectOption("explicit-fixture-model");
  await expect(section.getByLabel("图片操作")).toHaveValue("");
  await section.getByLabel("图片操作").selectOption(operation);
  await section.getByLabel("图片准备约束").selectOption({ index: 1 });
  await section.getByLabel("图片设计指令").fill("人工固定构图，不抽卡换模型");
  await section.getByLabel("图片质量").selectOption("auto"); await section.getByLabel("图片背景").selectOption("opaque");
}
async function budget(page: Page, projectId: string) {
  return (await page.request.get(`/studio-api/v1/projects/${encodeURIComponent(projectId)}/budget`, { headers: { "x-canvas-local": "1" } })).json();
}

test("日常目录为空，不默认选模型、不创建任务/预算/网络请求", async ({ page }) => {
  const external: string[] = [], writes: string[] = [];
  page.on("request", request => {
    if (!/^(https?:\/\/(127\.0\.0\.1|localhost)(:|\/)|blob:|data:)/.test(request.url())) external.push(request.url());
    if (/image-preparations|\/confirm|\/dispatch/.test(request.url()) && request.method() === "POST") writes.push(request.url());
  });
  const { section } = await open(page);
  await expect(section).toContainText("当前项目供应商目录为空"); await expect(section.getByLabel("图片供应商", { exact: true })).toHaveValue("");
  await expect(section.getByRole("button", { name: "保存未确认假报价准备单" })).toBeDisabled(); expect(writes).toEqual([]); expect(external).toEqual([]);
});

for (const protocol of ["openai", "openai-compatible", "google"] as const) test(`${protocol} 明确选择/假报价/历史只读恢复，预算与任务不变`, async ({ page }) => {
  const f = await routes(page, protocol); const { section } = await open(page, { format: protocol === "google" ? "jpeg" : "png" });
  await choose(section, f.visible.id);
  if (protocol === "openai-compatible") {
    await section.getByLabel("图片参数 seed").fill("0"); await section.getByLabel("图片参数 watermark").selectOption("false"); await section.getByLabel("图片参数 style_hint").selectOption("studio");
  }
  await expect(section.getByRole("button", { name: "保存未确认假报价准备单" })).toBeEnabled();
  await section.getByRole("button", { name: "保存未确认假报价准备单" }).click();
  await expect(section.getByRole("article", { name: "未确认图片准备单" })).toContainText("未确认 · 未授权执行 · 协议未准备");
  expect(f.submissions).toHaveLength(1); const selection = f.submissions[0];
  expect(selection).toMatchObject({ connectionRevision: 1, protection: "none", operation: "generate", inputAssetIds: [], parameters: { n: 1, size: { width: 1024, height: 1024 }, prompt: "人工固定构图，不抽卡换模型" } });
  if (protocol === "openai-compatible") expect(selection.providerParameters).toEqual({ seed: 0, watermark: false, style_hint: "studio" });
  const before = await budget(page, selection.projectId); expect(before).toMatchObject({ spentMinor: 0, reservedMinor: 0 });
  await expect(section.getByRole("article", { name: "未确认图片准备单" })).toContainText("CNY，估算 25 最小币种单位，上限 30");
  if (protocol === "openai") { await section.getByRole("article", { name: "未确认图片准备单" }).scrollIntoViewIfNeeded(); await page.screenshot({ path: "test-results/image-preparation-ui.png" }); }
  await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  const restored = page.getByRole("region", { name: "图片供应商准备" }); await expect(restored.getByRole("article", { name: "未确认图片准备单" })).toContainText("preparation-1");
  expect(f.submissions).toHaveLength(1); expect(f.reads).toContain("preparation-1");
  expect(await budget(page, selection.projectId)).toEqual(before);
  const batches = await page.request.get(`/studio-api/v1/projects/${selection.projectId}/run-batches`, { headers: { "x-canvas-local": "1" } }); expect(await batches.json()).toEqual([]);
  await expect(restored.getByRole("button", { name: /确认.*并排队|执行|重试/ })).toHaveCount(0);
});

test("商品锁和4096平方超限在准备前拦截，不改约束，不自动降级", async ({ page }) => {
  const f = await routes(page); let { section } = await open(page, { locked: true }); await choose(section);
  await expect(section).toContainText("不会移除锁定或降级"); await expect(section.getByRole("button", { name: "保存未确认假报价准备单" })).toBeDisabled();
  await page.getByRole("button", { name: "关闭任务面板" }).click();
  // Add a new explicit human snapshot; the locked snapshot remains intact.
  const inspector = page.getByRole("complementary", { name: "人工约束" }); await inspector.getByLabel("锁定商品主体像素").uncheck();
  await inspector.getByLabel("输出宽度").fill("4096"); await inspector.getByLabel("输出高度").fill("4096"); await inspector.getByRole("button", { name: "保存为新约束快照" }).click();
  await page.getByRole("button", { name: "任务与预算", exact: true }).click(); section = page.getByRole("region", { name: "图片供应商准备" });
  await expect(section.getByRole("button", { name: "刷新供应商目录" })).toBeEnabled(); await choose(section); await section.getByLabel("图片准备约束").selectOption({ index: 2 });
  await expect(section).toContainText("4096×4096 也超限"); await expect(section.getByRole("button", { name: "保存未确认假报价准备单" })).toBeDisabled(); expect(f.submissions).toEqual([]);
});

test("错配响应保留原动作；刷新不重发，人工恢复不采用已改表单", async ({ page }) => {
  const f = await routes(page); f.setMode("mismatch"); const { section } = await open(page); await choose(section);
  await section.getByRole("button", { name: "保存未确认假报价准备单" }).click(); await expect(section.getByRole("alert")).toContainText("不一致");
  await expect(section.getByRole("article", { name: "未确认图片准备单" })).toHaveCount(0); const initial = f.submissions[0];
  await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); const reopened = page.getByRole("region", { name: "图片供应商准备" });
  await expect(reopened.getByRole("button", { name: "人工恢复原准备动作" })).toBeEnabled(); expect(f.submissions).toHaveLength(1);
  await choose(reopened); await reopened.getByLabel("图片设计指令").fill("表单漂移不冒充原动作");
  f.setMode("good"); await reopened.getByRole("button", { name: "人工恢复原准备动作" }).click(); await expect(reopened.getByRole("article", { name: "未确认图片准备单" })).toBeVisible();
  expect(f.submissions).toHaveLength(2); expect(f.submissions[1]).toEqual(initial); expect(f.saved.size).toBe(1);
});

test("目录修订变化清空显式选择；历史过期仍只读，不重新报价", async ({ page }) => {
  const f = await routes(page), { section } = await open(page); await choose(section);
  await section.getByRole("button", { name: "保存未确认假报价准备单" }).click(); await expect(section.getByRole("article", { name: "未确认图片准备单" })).toBeVisible();
  const record = [...f.saved.values()][0]; record.pricing.quote.expiresAt = "2000-01-01T00:00:00.000Z"; record.requestTemplate.quote.expiresAt = record.pricing.quote.expiresAt;
  f.changeRevision(); await section.getByRole("button", { name: "刷新供应商目录" }).click(); await expect(section.getByLabel("图片供应商", { exact: true })).toHaveValue("");
  await section.getByRole("button", { name: "读取历史准备单" }).click(); await expect(section.getByRole("article", { name: "未确认图片准备单" })).toContainText("假报价已过期");
  await expect(section).toContainText("当前目录与冻结版本不同"); expect(f.submissions).toHaveLength(1);
});

test("关闭面板取消响应且保留恢复指针，不留下伪成功或自动重发", async ({ page }) => {
  const f = await routes(page), { section } = await open(page); await choose(section); f.hold();
  await section.getByRole("button", { name: "保存未确认假报价准备单" }).click(); await expect.poll(() => f.submissions.length).toBe(1);
  await page.getByRole("button", { name: "关闭任务面板" }).click(); f.release();
  await page.getByRole("button", { name: "任务与预算", exact: true }).click(); const reopened = page.getByRole("region", { name: "图片供应商准备" });
  await expect(reopened.getByRole("button", { name: "人工恢复原准备动作" })).toBeEnabled(); await expect(reopened.getByRole("article", { name: "未确认图片准备单" })).toHaveCount(0);
  expect(f.submissions).toHaveLength(1); expect(await budget(page, f.submissions[0].projectId)).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
});

test("浏览器恢复存储写失败在POST前停止，不产生不可追踪准备单", async ({ page }) => {
  const f = await routes(page), { section } = await open(page); await choose(section);
  await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
    if (key.startsWith("ai-commerce-canvas.image-preparation.")) throw new Error("fixture recovery quota"); return original.call(this, key, value);
  }; });
  await section.getByRole("button", { name: "保存未确认假报价准备单" }).click(); await expect(section.getByRole("alert")).toContainText("fixture recovery quota");
  expect(f.submissions).toEqual([]); await expect(section.getByRole("article", { name: "未确认图片准备单" })).toHaveCount(0);
});

test("编辑上传IndexedDB原文件而非代理，拒绝权限不创建准备记录", async ({ page }) => {
  const f = await routes(page); f.setMode("denied"); const uploads: Buffer[] = [];
  page.on("request", request => { if (request.url().includes("/verification") && request.method() === "POST") uploads.push(request.postDataBuffer()!); });
  const { section } = await open(page); await choose(section, "fixture-openai", "edit");
  await section.getByLabel("编辑输入 preparation-source.png").check(); await section.getByLabel("图片输入保真度").selectOption("high");
  await section.getByRole("button", { name: "保存未确认假报价准备单" }).click(); await expect(section.getByRole("alert")).toContainText("无权创建本地准备单");
  expect(uploads).toEqual([png]); expect(f.submissions[0]).toMatchObject({ operation: "edit", parameters: { inputFidelity: "high" } });
  await expect(section.getByRole("article", { name: "未确认图片准备单" })).toHaveCount(0);
});

test("损坏恢复指针失败关闭，必须明确新动作才能清除，不覆盖服务端历史", async ({ page }) => {
  const f = await routes(page), { section } = await open(page); await choose(section);
  await section.getByRole("button", { name: "保存未确认假报价准备单" }).click(); await expect(section.getByRole("article", { name: "未确认图片准备单" })).toBeVisible();
  const projectId = f.submissions[0].projectId;
  await page.evaluate(project => localStorage.setItem(`ai-commerce-canvas.image-preparation.${project}`, "corrupt-pointer"), projectId);
  await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click(); const reopened = page.getByRole("region", { name: "图片供应商准备" });
  await expect(reopened.getByRole("alert")).toContainText("恢复记录损坏"); await choose(reopened);
  await expect(reopened.getByRole("button", { name: "保存未确认假报价准备单" })).toBeDisabled(); expect(f.submissions).toHaveLength(1);
  await reopened.getByRole("button", { name: "开始新准备动作（保留服务端历史）" }).click();
  await reopened.getByRole("button", { name: "保存未确认假报价准备单" }).click(); await expect(reopened.getByRole("article", { name: "未确认图片准备单" })).toContainText("preparation-2");
  expect(f.submissions[1].idempotencyKey).not.toBe(f.submissions[0].idempotencyKey); expect(f.saved.size).toBe(2);
});

test("项目切换取消待响应，恢复指针留在原项目，不串入另一个项目", async ({ page }) => {
  const f = await routes(page), { section } = await open(page); await choose(section); f.hold();
  await section.getByRole("button", { name: "保存未确认假报价准备单" }).click(); await expect.poll(() => f.submissions.length).toBe(1);
  await page.getByLabel("切换项目").selectOption("phase-1-campaign"); f.release();
  const next = page.getByRole("region", { name: "图片供应商准备" }); await expect(next.getByRole("button", { name: "刷新供应商目录" })).toBeEnabled();
  await expect(next.getByRole("article", { name: "未确认图片准备单" })).toHaveCount(0); await expect(next.getByRole("button", { name: "人工恢复原准备动作" })).toHaveCount(0);
  expect(f.submissions).toHaveLength(1); expect(f.reads).toEqual([]);
  const keys = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("ai-commerce-canvas.image-preparation.")));
  expect(keys).toEqual([`ai-commerce-canvas.image-preparation.${f.submissions[0].projectId}`]);
});
