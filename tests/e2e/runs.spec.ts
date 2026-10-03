import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

test.use({ serviceWorkers: "block" });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function prepare(page: Page) {
  await page.goto("/");
  await page.getByLabel("导入本地资产").setInputFiles({ name: "task-product.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("button", { name: "资产库 1" })).toBeVisible();
  await page.getByRole("button", { name: "关闭资产库" }).click();
  await page.getByRole("button", { name: "＋ 约束" }).click();
  await page.getByRole("complementary", { name: "人工约束" }).getByRole("button", { name: "保存为新约束快照" }).click();
  await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "任务与预算" });
  await expect(panel.getByRole("button", { name: "查看批次预估" })).toBeEnabled();
  return panel;
}

async function prepareOverage(page: Page) {
  const panel = await prepare(page);
  await panel.getByLabel("任务输出数量").fill("1");
  await panel.getByLabel("任务成本上限").fill("0.25");
  await panel.getByText("模拟运行情况", { exact: true }).click();
  await panel.getByLabel("模拟运行情况").selectOption("billing-unknown");
  await panel.getByRole("button", { name: "查看批次预估" }).click();
  await panel.getByRole("button", { name: "确认模拟成本并排队" }).click();
  await panel.getByRole("button", { name: "执行排队任务" }).click();
  await panel.getByRole("button", { name: "核对输出 1 计费" }).click();
  const decision = panel.getByRole("alertdialog", { name: "确认计费核账" });
  await decision.getByLabel("核账结论").selectOption("charged");
  await decision.getByLabel("核实扣费金额").fill("0.40");
  await expect(decision.getByRole("button", { name: "提交超额审批申请" })).toBeDisabled();
  await decision.getByLabel("拟审批批次上限").fill("0.40");
  await decision.getByLabel("超额原因").fill("供应商账单与估价不一致，需要人工核实");
  await decision.getByLabel("核账证据引用").fill("invoice-overage-040");
  return { panel, decision };
}

test("画布内预估、确认、部分失败和人工重试，结果可回画布且刷新恢复", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => { if (!/^(https?:\/\/(127\.0\.0\.1|localhost)(:|\/)|blob:|data:)/.test(request.url())) external.push(request.url()); });
  const panel = await prepare(page);
  await panel.getByText("模拟运行情况", { exact: true }).click();
  await panel.getByLabel("模拟运行情况").selectOption("partial-failure");
  await panel.getByRole("button", { name: "查看批次预估" }).click();
  const current = panel.getByRole("region", { name: "当前批次" });
  await expect(current.getByText("待人工确认", { exact: true })).toBeVisible();
  await expect(current).toContainText("¥0.50");
  await expect(current.getByRole("article")).toHaveCount(0);
  const batchId = await panel.getByLabel("选择任务批次").inputValue();
  await panel.getByRole("button", { name: "确认模拟成本并排队" }).click();
  await expect(current.getByRole("article")).toHaveCount(2);
  await panel.getByRole("button", { name: "执行排队任务" }).click();
  await expect(current.getByText("部分成功", { exact: true })).toBeVisible();
  await expect(current.getByRole("status")).toHaveText("输出进度：1 / 2 成功");
  await panel.getByRole("button", { name: "人工重试输出 2" }).click();
  const confirmation = panel.getByRole("alertdialog", { name: "确认任务重试" });
  await expect(confirmation).toContainText("¥0.25");
  await confirmation.getByRole("button", { name: "确认重试", exact: true }).click();
  await expect(current.getByLabel("输出 2 任务")).toContainText("第 2 次");
  await panel.getByRole("button", { name: "执行排队任务" }).click();
  await expect(current.locator(".run-batch-title")).toContainText("已完成");
  await panel.getByRole("button", { name: "结果回到画布" }).click();
  await expect(page.getByText(/已放置 2 个模拟结果记录/)).toBeVisible();
  await panel.getByRole("button", { name: "结果回到画布" }).click();
  await expect(page.getByText("这些模拟结果已经在画布上，无需重复添加")).toBeVisible();
  await expect(page.getByText(/已保存 r\d+/)).toBeVisible();
  const document = await page.evaluate(() => JSON.parse(localStorage.getItem("ai-commerce-canvas.document.phase-1-demo") ?? "{}"));
  const results = document.nodes.filter((node: { data: { runJobId?: string } }) => node.data.runJobId);
  expect(results).toHaveLength(2);
  expect(results.every((node: { data: { assetId?: string; runBatchId: string } }) => !node.data.assetId && node.data.runBatchId === batchId)).toBe(true);
  expect(document.edges.filter((edge: { id: string; deletable: boolean }) => edge.id.startsWith("run-lineage-")).every((edge: { deletable: boolean }) => edge.deletable === false)).toBe(true);
  await panel.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: resolve("test-results/run-panel-desktop.png") });
  await page.reload();
  await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  await panel.getByLabel("选择任务批次").selectOption(batchId);
  await expect(current.getByRole("status")).toHaveText("输出进度：2 / 2 成功");
  await page.getByRole("button", { name: "资产库 1" }).click();
  await expect(page.getByRole("complementary", { name: "项目资产库" }).getByRole("button", { name: "使用中 2" })).toBeDisabled();
  await page.getByLabel("切换项目").selectOption("phase-1-campaign");
  await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  await expect(panel.getByRole("button", { name: "刷新任务记录" })).toBeEnabled();
  await expect(panel.getByLabel("选择任务批次").locator(`option[value="${batchId}"]`)).toHaveCount(0);
  expect(external).toEqual([]);
});

test("计费待核对必须人工填写证据，核账不自动重试", async ({ page }) => {
  const panel = await prepare(page);
  await panel.getByLabel("任务输出数量").fill("1");
  await panel.getByText("模拟运行情况", { exact: true }).click();
  await panel.getByLabel("模拟运行情况").selectOption("billing-unknown");
  await panel.getByRole("button", { name: "查看批次预估" }).click();
  await panel.getByRole("button", { name: "确认模拟成本并排队" }).click();
  await panel.getByRole("button", { name: "执行排队任务" }).click();
  const current = panel.getByRole("region", { name: "当前批次" });
  await expect(current.getByText("计费待核对", { exact: true })).toHaveCount(2);
  await expect(panel.getByRole("button", { name: /人工重试/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "核对输出 1 计费" }).click();
  const decision = panel.getByRole("alertdialog", { name: "确认计费核账" });
  await expect(decision.getByRole("button", { name: "提交核账结论" })).toBeDisabled();
  await decision.getByLabel("核账结论").selectOption("charged");
  await decision.getByLabel("核实扣费金额").fill("0.20");
  await decision.getByLabel("核账证据引用").fill("模拟工单 TEST-001");
  await decision.getByRole("button", { name: "提交核账结论" }).click();
  await expect(decision).toBeHidden();
  await expect(current.getByLabel("输出 1 任务")).toContainText("实际模拟成本 ¥0.20");
  await expect(current).toContainText("核账证据：模拟工单 TEST-001");
  await expect(panel.getByRole("button", { name: "人工重试输出 1" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "执行排队任务" })).toHaveCount(0);
});

test("创建响应丢失后重试复用原批次，取消不会保留预算", async ({ page }) => {
  const panel = await prepare(page);
  const before = await panel.getByLabel("选择任务批次").locator("option").count();
  await page.route("**/studio-api/v1/run-batches", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    await route.fetch(); await route.abort("failed");
  }, { times: 1 });
  await panel.getByRole("button", { name: "查看批次预估" }).click();
  await expect(panel.getByRole("alert")).toContainText("可安全重试");
  await panel.getByRole("button", { name: "查看批次预估" }).click();
  await expect(panel.getByLabel("选择任务批次").locator("option")).toHaveCount(before + 1);
  await panel.getByRole("button", { name: "确认模拟成本并排队" }).click();
  await panel.getByRole("button", { name: "取消批次" }).click();
  await expect(panel.getByRole("region", { name: "当前批次" }).getByText("已取消", { exact: true })).toHaveCount(3);
  await expect(panel.locator(".run-budget")).toContainText("预留¥0.00");
});

test("图片核验响应丢失后安全重放同一证明，预估不占用预算", async ({ page }) => {
  const panel = await prepare(page);
  const before = await panel.getByLabel("选择任务批次").locator("option").count();
  const beforeBudget = await (await page.request.get("/studio-api/v1/projects/project-main-image/budget", { headers: { "x-canvas-local": "1" } })).json();
  let verificationUrl = ""; let receipt: { id: string; checksumSha256: string } | null = null;
  await page.route("**/studio-api/v1/projects/*/assets/*/verification", async (route) => {
    verificationUrl = route.request().url();
    expect(route.request().method()).toBe("POST");
    const response = await route.fetch(); expect(response.status()).toBe(200); receipt = await response.json();
    await route.abort("failed");
  }, { times: 1 });
  await panel.getByRole("button", { name: "查看批次预估" }).click();
  await expect(panel.getByRole("alert")).toContainText("可安全重试");
  await expect(panel.getByLabel("选择任务批次").locator("option")).toHaveCount(before);
  const saved = await (await page.request.get(verificationUrl, { headers: { "x-canvas-local": "1" } })).json();
  expect(saved).toEqual(receipt);
  expect(saved.asset).toMatchObject({ width: 1, height: 1, byteSize: png.length });
  await panel.getByRole("button", { name: "查看批次预估" }).click();
  await expect(panel.getByLabel("选择任务批次").locator("option")).toHaveCount(before + 1);
  expect(await (await page.request.get(verificationUrl, { headers: { "x-canvas-local": "1" } })).json()).toEqual(saved);
  const budget = await (await page.request.get("/studio-api/v1/projects/project-main-image/budget", { headers: { "x-canvas-local": "1" } })).json();
  expect(budget).toEqual(beforeBudget);
  await page.screenshot({ path: resolve("test-results/verified-image-replay-desktop.png") });
});

test("预估后浏览器原文件丢失，不用缩略图或已存证明绕过确认", async ({ page }) => {
  const panel = await prepare(page);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/verification") && response.request().method() === "POST");
  await panel.getByRole("button", { name: "查看批次预估" }).click();
  const receipt = await (await responsePromise).json();
  await expect(panel.getByRole("button", { name: "确认模拟成本并排队" })).toBeEnabled();
  const batchId = await panel.getByLabel("选择任务批次").inputValue();
  const before = await (await page.request.get("/studio-api/v1/projects/project-main-image/budget", { headers: { "x-canvas-local": "1" } })).json();
  await page.evaluate(async (assetId: string) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ai-commerce-canvas-assets", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("blobs", "readwrite"); transaction.objectStore("blobs").delete(`${assetId}:original`);
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    database.close();
  }, receipt.asset.id);
  await panel.getByRole("button", { name: "确认模拟成本并排队" }).click();
  await expect(panel.getByRole("alert")).toContainText("不会仅用缩略图代替原图");
  const blocked = await (await page.request.get(`/studio-api/v1/run-batches/${batchId}`, { headers: { "x-canvas-local": "1" } })).json();
  expect(blocked.jobs).toEqual([]); expect(blocked.batch.status).toBe("awaiting_confirmation");
  expect(await (await page.request.get("/studio-api/v1/projects/project-main-image/budget", { headers: { "x-canvas-local": "1" } })).json()).toEqual(before);
});

test("绘制蒙版后原图先验证，蒙版绑定真实底图摘要再确认执行", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("导入本地资产").setInputFiles({ name: "masked-product.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "关闭资产库" }).click();
  await page.getByRole("button", { name: "＋ 约束" }).click();
  const inspector = page.getByRole("complementary", { name: "人工约束" });
  await inspector.getByRole("button", { name: "绘制蒙版" }).click();
  const editor = page.getByRole("dialog", { name: "蒙版编辑器" });
  const box = await editor.getByLabel("蒙版绘制画布").boundingBox();
  if (!box) throw new Error("蒙版画布未显示");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 4 }); await page.mouse.up();
  await editor.getByRole("button", { name: "保存蒙版版本" }).click(); await expect(editor).toBeHidden();
  await inspector.getByRole("button", { name: "保存为新约束快照" }).click();
  await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "任务与预算" });
  await expect(panel.getByRole("button", { name: "查看批次预估" })).toBeEnabled();
  const receipts: Array<{ checksumSha256: string; sourceChecksumSha256?: string; asset: { id: string; purpose: string; sourceAssetId?: string } }> = [];
  await page.route("**/studio-api/v1/projects/*/assets/*/verification", async (route) => {
    const response = await route.fetch(); expect(response.status()).toBe(200); receipts.push(await response.json()); await route.fulfill({ response });
  });
  await panel.getByRole("button", { name: "查看批次预估" }).click();
  await expect(panel.getByRole("button", { name: "确认模拟成本并排队" })).toBeEnabled();
  expect(receipts).toHaveLength(2); expect(receipts[0].asset.purpose).toBe("source"); expect(receipts[1].asset.purpose).toBe("mask");
  expect(receipts[1].asset.sourceAssetId).toBe(receipts[0].asset.id); expect(receipts[1].sourceChecksumSha256).toBe(receipts[0].checksumSha256);
  await panel.getByRole("button", { name: "确认模拟成本并排队" }).click();
  await panel.getByRole("button", { name: "执行排队任务" }).click();
  await expect(panel.getByRole("region", { name: "当前批次" }).getByRole("status")).toHaveText("输出进度：2 / 2 成功");
  expect(receipts).toHaveLength(6);
  expect(receipts[2]).toEqual(receipts[0]); expect(receipts[4]).toEqual(receipts[0]);
  expect(receipts[3]).toEqual(receipts[1]); expect(receipts[5]).toEqual(receipts[1]);
});

test("专项验收：三张输出完成两张后取消，结果保留且刷新不继续派发", async ({ page }) => {
  const panel = await prepare(page);
  await panel.getByLabel("任务输出数量").fill("3");
  const createdPromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/studio-api/v1/run-batches" && response.request().method() === "POST");
  await panel.getByRole("button", { name: "查看批次预估" }).click();
  const batchId = (await (await createdPromise).json()).batch.id as string;
  await expect(panel.getByLabel("选择任务批次")).toHaveValue(batchId);
  await panel.getByRole("button", { name: "确认模拟成本并排队" }).click();
  await panel.getByRole("button", { name: "执行排队任务" }).click();
  const current = panel.getByRole("region", { name: "当前批次" });
  await expect(current.getByRole("status")).toHaveText("输出进度：2 / 3 成功");
  const before = await (await page.request.get(`/studio-api/v1/run-batches/${batchId}`, { headers: { "x-canvas-local": "1" } })).json();
  await panel.getByRole("button", { name: "取消批次" }).click();
  await expect(current.locator(".run-batch-title")).toContainText("已取消");
  await expect(current.getByLabel("输出 3 任务")).toContainText("已取消");
  const cancelled = await (await page.request.get(`/studio-api/v1/run-batches/${batchId}`, { headers: { "x-canvas-local": "1" } })).json();
  expect(cancelled.jobs.slice(0, 2)).toEqual(before.jobs.slice(0, 2)); expect(cancelled.jobs[2].providerRequestId).toBeUndefined();
  await panel.getByRole("button", { name: "结果回到画布" }).click();
  await expect(page.getByText(/已放置 2 个模拟结果记录/)).toBeVisible();
  await expect(page.getByText(/已保存 r\d+/)).toBeVisible();
  await page.reload(); await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  await panel.getByLabel("选择任务批次").selectOption(batchId);
  await expect(current.getByRole("status")).toHaveText("输出进度：2 / 3 成功");
  await expect(panel.getByRole("button", { name: "执行排队任务" })).toHaveCount(0);
  expect(await (await page.request.get(`/studio-api/v1/run-batches/${batchId}`, { headers: { "x-canvas-local": "1" } })).json()).toEqual(cancelled);
});

test("超额申请刷新恢复，审批响应丢失后重放不重复结算", async ({ page }) => {
  const { panel, decision } = await prepareOverage(page);
  const batchId = await panel.getByLabel("选择任务批次").inputValue();
  const before = await (await page.request.get("/studio-api/v1/projects/project-main-image/budget", { headers: { "x-canvas-local": "1" } })).json();
  await decision.getByRole("button", { name: "提交超额审批申请" }).click();
  await expect(panel.getByLabel("超额审批记录")).toContainText("待审批");
  await expect(panel.getByRole("button", { name: "核对输出 1 计费" })).toHaveCount(0);
  const pending = await (await page.request.get(`/studio-api/v1/run-batches/${batchId}`, { headers: { "x-canvas-local": "1" } })).json();
  expect(pending.batch.maxCostMinor).toBe(25);
  expect(pending.jobs[0].status).toBe("billing_unknown");
  await page.reload();
  await page.getByRole("button", { name: "任务与预算", exact: true }).click();
  await panel.getByLabel("选择任务批次").selectOption(batchId);
  await panel.getByRole("button", { name: "审批超额申请" }).click();
  const review = panel.getByRole("alertdialog", { name: "审批超额结算" });
  await expect(review).toContainText("不是真实多人鉴权");
  await expect(review).toContainText("额外支出 ¥0.15");
  await expect(review.getByRole("button", { name: "提交审批结论" })).toBeDisabled();
  await review.getByLabel("审批证据引用").fill("verified-invoice-040");
  await review.getByLabel("审批意见").fill("核实账单无误，同意从剩余模拟预算结算");
  await page.screenshot({ path: resolve("test-results/billing-overage-review-desktop.png") });
  await page.route("**/studio-api/v1/run-jobs/*/billing-overages/*/review", async (route) => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await review.getByRole("button", { name: "提交审批结论" }).click();
  await expect(panel.getByRole("alert")).toContainText("可安全重试");
  await expect(review.getByLabel("审批证据引用")).toBeDisabled();
  await review.getByRole("button", { name: "提交审批结论" }).click();
  await expect(review).toBeHidden();
  await expect(panel.getByLabel("超额审批记录")).toContainText("已批准并结算");
  const after = await (await page.request.get("/studio-api/v1/projects/project-main-image/budget", { headers: { "x-canvas-local": "1" } })).json();
  expect(after.spentMinor).toBe(before.spentMinor + 40); expect(after.reservedMinor).toBe(before.reservedMinor - 25);
  expect(after.limitMinor).toBe(before.limitMinor);
  const approved = await (await page.request.get(`/studio-api/v1/run-batches/${batchId}`, { headers: { "x-canvas-local": "1" } })).json();
  expect(approved.billingOverages[0]).toMatchObject({ requestedBy: "local-designer", reviewedBy: "local-reviewer", status: "approved" });
  expect(approved.ledger.filter((entry: { settlement: string }) => entry.settlement === "settled")).toHaveLength(1);
  expect(approved.jobs).toHaveLength(1); expect(approved.batch.maxCostMinor).toBe(40);
  await expect(panel.getByRole("button", { name: "执行排队任务" })).toHaveCount(0);
});

test("拒绝超额申请保留冻结与证据，并可补证重新提交", async ({ page }) => {
  const { panel, decision } = await prepareOverage(page);
  await decision.getByRole("button", { name: "提交超额审批申请" }).click();
  const batchId = await panel.getByLabel("选择任务批次").inputValue();
  await panel.getByRole("button", { name: "审批超额申请" }).click();
  const review = panel.getByRole("alertdialog", { name: "审批超额结算" });
  await review.getByLabel("超额审批结论").selectOption("reject");
  await review.getByLabel("审批证据引用").fill("dispute-ticket-001");
  await review.getByLabel("审批意见").fill("证据不完整，请补充明细");
  await review.getByRole("button", { name: "提交审批结论" }).click();
  await expect(panel.getByLabel("超额审批记录")).toContainText("已拒绝 · 预留未释放");
  const rejected = await (await page.request.get(`/studio-api/v1/run-batches/${batchId}`, { headers: { "x-canvas-local": "1" } })).json();
  expect(rejected.batch.maxCostMinor).toBe(25); expect(rejected.jobs[0].status).toBe("billing_unknown");
  await panel.getByRole("button", { name: "核对输出 1 计费" }).click();
  const again = panel.getByRole("alertdialog", { name: "确认计费核账" });
  await again.getByLabel("核账结论").selectOption("charged");
  await again.getByLabel("核实扣费金额").fill("0.40");
  await again.getByLabel("拟审批批次上限").fill("0.40");
  await again.getByLabel("超额原因").fill("已补齐扣费明细");
  await again.getByLabel("核账证据引用").fill("updated-invoice-040");
  await again.getByRole("button", { name: "提交超额审批申请" }).click();
  await expect(panel.getByLabel("超额审批记录").getByRole("article")).toHaveCount(2);
  await expect(panel.getByLabel("超额审批记录")).toContainText("证据不完整，请补充明细");
  await expect(panel.getByLabel("超额审批记录")).toContainText("待审批");
});

test("超额审批不能提高项目预算，预算不足时可返回并改为拒绝", async ({ page }) => {
  const { panel, decision } = await prepareOverage(page);
  await decision.getByLabel("核实扣费金额").fill("101.00");
  await decision.getByLabel("拟审批批次上限").fill("101.00");
  const batchId = await panel.getByLabel("选择任务批次").inputValue();
  const before = await (await page.request.get("/studio-api/v1/projects/project-main-image/budget", { headers: { "x-canvas-local": "1" } })).json();
  await decision.getByRole("button", { name: "提交超额审批申请" }).click();
  await panel.getByRole("button", { name: "审批超额申请" }).click();
  const review = panel.getByRole("alertdialog", { name: "审批超额结算" });
  await review.getByLabel("审批证据引用").fill("budget-test-proof");
  await review.getByLabel("审批意见").fill("测试项目额度保护");
  await review.getByRole("button", { name: "提交审批结论" }).click();
  await expect(review.getByRole("alert")).toContainText("模拟预算不足");
  const after = await (await page.request.get("/studio-api/v1/projects/project-main-image/budget", { headers: { "x-canvas-local": "1" } })).json();
  expect(after).toEqual(before);
  const blocked = await (await page.request.get(`/studio-api/v1/run-batches/${batchId}`, { headers: { "x-canvas-local": "1" } })).json();
  expect(blocked.billingOverages[0].status).toBe("pending"); expect(blocked.batch.maxCostMinor).toBe(25);
  await review.getByRole("button", { name: "返回任务" }).click();
  await panel.getByRole("button", { name: "审批超额申请" }).click();
  await review.getByLabel("超额审批结论").selectOption("reject");
  await review.getByLabel("审批证据引用").fill("budget-dispute-ticket");
  await review.getByLabel("审批意见").fill("项目预算不足，进入人工争议处理");
  await review.getByRole("button", { name: "提交审批结论" }).click();
  await expect(panel.getByLabel("超额审批记录")).toContainText("已拒绝 · 预留未释放");
});

test.describe("390 像素任务布局", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("触控可打开任务面板且面板内部无横向溢出", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "任务与预算", exact: true }).tap();
    const panel = page.getByRole("complementary", { name: "任务与预算" });
    await expect(panel.getByRole("button", { name: "刷新任务记录" })).toBeEnabled();
    await expect(panel).toContainText("真实费用 ¥0");
    const sizes = await panel.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth, body: document.body.scrollWidth, width: window.innerWidth }));
    expect(sizes.scroll).toBe(sizes.client); expect(sizes.body).toBe(sizes.width);
    await page.screenshot({ path: resolve("test-results/run-panel-mobile.png") });
    await panel.getByRole("button", { name: "关闭任务面板" }).tap();
    await expect(panel).toBeHidden();
  });
  test("窄屏超额申请表单可填写且不横向溢出", async ({ page }) => {
    const { panel, decision } = await prepareOverage(page);
    await expect(decision.getByRole("button", { name: "提交超额审批申请" })).toBeEnabled();
    const sizes = await panel.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth, body: document.body.scrollWidth, width: window.innerWidth }));
    expect(sizes.scroll).toBe(sizes.client); expect(sizes.body).toBe(sizes.width);
    await decision.getByRole("button", { name: "提交超额审批申请" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve("test-results/billing-overage-request-mobile.png") });
    await decision.getByRole("button", { name: "提交超额审批申请" }).tap();
    await expect(panel.getByLabel("超额审批记录")).toContainText("待审批");
  });
});
