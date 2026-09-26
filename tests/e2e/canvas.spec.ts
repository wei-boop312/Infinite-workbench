import { expect, test } from "@playwright/test";

test("真实鼠标可拖动节点，500 节点按视口裁剪，假任务不访问外网", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") externalRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "AI 电商视觉工作台" })).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);

  const node = page.locator(".react-flow__node").first();
  const before = await node.getAttribute("style");
  const box = await node.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + 60, { steps: 5 });
    await page.mouse.up();
  }
  await expect.poll(() => node.getAttribute("style")).not.toBe(before);

  await page.getByRole("button", { name: "500 节点" }).click();
  const renderedNodes = await page.locator(".react-flow__node").count();
  expect(renderedNodes).toBeGreaterThan(0);
  expect(renderedNodes).toBeLessThan(500);

  await page.getByRole("button", { name: "业务样例" }).click();
  await page.getByRole("button", { name: "运行假任务" }).click();
  await expect(page.getByText(/0 次网络调用 · ¥0/)).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test("撤销重做、复制删除、分组和刷新恢复形成同一历史", async ({ page }) => {
  await page.goto("/");
  const canvasNodes = page.locator(".react-flow__node");
  await expect(canvasNodes).toHaveCount(6);

  await page.getByRole("button", { name: "＋ 文字" }).click();
  await expect(canvasNodes).toHaveCount(7);
  await expect(page.getByLabel("修订冲突恢复")).toHaveCount(0);

  await page.getByRole("button", { name: "撤销" }).click();
  await expect(canvasNodes).toHaveCount(6);
  await page.getByRole("button", { name: "重做" }).click();
  await expect(canvasNodes).toHaveCount(7);

  await page.getByRole("button", { name: "复制" }).click();
  await expect(canvasNodes).toHaveCount(8);
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(canvasNodes).toHaveCount(7);

  await page.locator('.react-flow__node[data-id="product"]').click();
  await page.locator('.react-flow__node[data-id="brand"]').click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "建立分组" }).click();
  await expect(page.locator('.react-flow__node[data-id^="group-"]')).toHaveCount(1);
  await page.getByRole("button", { name: "解散分组" }).click();
  await expect(page.locator('.react-flow__node[data-id^="group-"]')).toHaveCount(0);

  await expect(page.getByText(/已保存 r\d+/)).toBeVisible({ timeout: 4_000 });
  await page.reload();
  await expect(canvasNodes).toHaveCount(7);
  await expect(page.getByText(/已恢复本地修订 r\d+/)).toBeVisible();
});

test("双标签页冲突不会静默覆盖，并可另存恢复副本", async ({ context, page: firstPage }) => {
  await firstPage.goto("/");
  await expect(firstPage.getByText(/已保存 r1/)).toBeVisible({ timeout: 4_000 });

  const secondPage = await context.newPage();
  await secondPage.goto("/");
  await expect(secondPage.getByText(/已恢复本地修订 r1/)).toBeVisible();

  await firstPage.getByRole("button", { name: "＋ 文字" }).click();
  await firstPage.waitForTimeout(180);
  await secondPage.getByRole("button", { name: "＋ 图片" }).click();

  const conflict = secondPage.getByRole("alertdialog", { name: "修订冲突恢复" });
  await expect(conflict).toBeVisible({ timeout: 4_000 });
  await conflict.getByRole("button", { name: "保留当前为副本" }).click();
  await expect(conflict).toBeHidden();
  await expect(secondPage.locator(".save-badge")).toContainText(/已保存 r1/, { timeout: 4_000 });

  const documentKeys = await secondPage.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ai-commerce-canvas.document.")));
  expect(documentKeys.length).toBeGreaterThanOrEqual(2);
});

test("项目切换会隔离草稿并恢复各自修订", async ({ page }) => {
  await page.goto("/");
  const canvasNodes = page.locator(".react-flow__node");
  await page.getByRole("button", { name: "＋ 文字" }).click();
  await expect(canvasNodes).toHaveCount(7);
  await expect(page.getByText(/已保存 r\d+/)).toBeVisible({ timeout: 4_000 });

  await page.getByLabel("切换项目").selectOption("phase-1-campaign");
  await expect(canvasNodes).toHaveCount(6);
  await expect(page.getByText("已保存 r1")).toBeVisible({ timeout: 4_000 });

  await page.getByLabel("切换项目").selectOption("phase-1-demo");
  await expect(canvasNodes).toHaveCount(7);
  await expect(page.getByText(/已恢复本地修订 r\d+/)).toBeVisible();
});

test("离线重载仍可打开应用并恢复草稿", async ({ context, page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 文字" }).click();
  await expect(page.getByText(/已保存 r\d+/)).toBeVisible({ timeout: 4_000 });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(7);

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: "AI 电商视觉工作台" })).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(7);
    await expect(page.getByText("离线草稿")).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test("保存失败时保留内存草稿并可下载恢复文件", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key: string, value: string) {
      if (key.startsWith("ai-commerce-canvas.document.")) {
        throw new DOMException("测试模拟存储空间不足", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 文字" }).click();
  const recovery = page.getByRole("alert", { name: "自动保存失败恢复" });
  await expect(recovery).toBeVisible({ timeout: 4_000 });
  await expect(page.locator(".react-flow__node")).toHaveCount(7);

  const downloadPromise = page.waitForEvent("download");
  await recovery.getByRole("button", { name: "下载恢复文件" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("phase-1-demo-recovery.json");
});

test.describe("390 像素触控布局", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("触控可添加文字节点且不产生横向溢出", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "＋ 文字" }).tap();
    await expect(page.locator(".react-flow__node")).toHaveCount(7);
    const widths = await page.evaluate(() => ({ inner: window.innerWidth, scroll: document.body.scrollWidth }));
    expect(widths).toEqual({ inner: 390, scroll: 390 });
    await expect(page.locator(".legend")).toBeHidden();
  });
});
