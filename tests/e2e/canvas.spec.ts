import { expect, test } from "@playwright/test";

test("真实鼠标可拖动节点，500 节点按视口裁剪，假任务不访问外网", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") externalRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "无限画布底座验证台" })).toBeVisible();
  await expect(page.getByText("6", { exact: true })).toBeVisible();
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
  await expect(page.getByText("500", { exact: true })).toBeVisible();
  const renderedNodes = await page.locator(".react-flow__node").count();
  expect(renderedNodes).toBeGreaterThan(0);
  expect(renderedNodes).toBeLessThan(500);

  await page.getByRole("button", { name: "业务样例" }).click();
  await page.getByRole("button", { name: "运行假任务" }).click();
  await expect(page.getByText(/0 次网络调用 · ¥0/)).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test.describe("390 像素触控布局", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("触控可切换压力场景且不产生横向溢出", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "100 节点" }).tap();
    await expect(page.getByText("100", { exact: true })).toBeVisible();
    const widths = await page.evaluate(() => ({ inner: window.innerWidth, scroll: document.body.scrollWidth }));
    expect(widths).toEqual({ inner: 390, scroll: 390 });
    await expect(page.locator(".legend")).toBeHidden();
  });
});

