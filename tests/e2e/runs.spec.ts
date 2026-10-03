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
});
