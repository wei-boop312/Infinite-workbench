import { expect, test } from "@playwright/test";

test("真实鼠标可拖动节点，500 节点按视口裁剪，假任务不访问外网", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") externalRequests.push(request.url());
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
  await secondPage.getByRole("button", { name: "＋ 图片占位" }).click();

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

test("导入真实图片后原文件进入资产库，画布只保存 assetId", async ({ page }) => {
  await page.goto("/");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.getByLabel("导入本地资产").setInputFiles({
    name: "phase2-product.png",
    mimeType: "image/png",
    buffer: png,
  });

  const library = page.getByRole("complementary", { name: "项目资产库" });
  await expect(library).toBeVisible();
  await expect(library.getByText("phase2-product.png")).toBeVisible();
  await expect(page.locator('.asset-node-preview img[alt="phase2-product.png"]')).toHaveCount(1);
  await expect(page.locator(".react-flow__node")).toHaveCount(7);

  await page.getByLabel("导入本地资产").setInputFiles({
    name: "phase2-product-copy.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(library.getByText("1 个资产")).toBeVisible();
  await expect(page.locator('.asset-node-preview img[alt="phase2-product.png"]')).toHaveCount(2);
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await expect(page.getByText(/已保存 r\d+/)).toBeVisible({ timeout: 4_000 });

  const persisted = await page.evaluate(() => {
    const raw = localStorage.getItem("ai-commerce-canvas.document.phase-1-demo");
    return raw ? JSON.parse(raw) : null;
  });
  const importedNode = persisted.nodes.find((node: { data?: { title?: string } }) => node.data?.title === "phase2-product.png");
  expect(importedNode.data.assetId).toMatch(/^image-/);
  expect(JSON.stringify(persisted)).not.toContain("data:image");

  await page.reload();
  await expect(page.locator('.asset-node-preview img[alt="phase2-product.png"]')).toHaveCount(2);
  await page.getByLabel("切换项目").selectOption("phase-1-campaign");
  await expect(page.getByRole("button", { name: "资产库 0" })).toBeVisible();
  await expect(page.locator('.asset-node-preview img[alt="phase2-product.png"]')).toHaveCount(0);
  await page.getByLabel("切换项目").selectOption("phase-1-demo");
  await expect(page.locator('.asset-node-preview img[alt="phase2-product.png"]')).toHaveCount(2);
});

test("人工约束每次保存都生成新的不可变快照", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 约束" }).click();
  const inspector = page.getByRole("complementary", { name: "人工约束" });
  await expect(inspector).toBeVisible();
  await inspector.getByLabel("区域 1 描述").fill("只允许替换纯色背景");
  await inspector.getByLabel("输出宽度").fill("1080");
  await inspector.getByLabel("输出高度").fill("1440");
  await inspector.getByRole("button", { name: "保存为新约束快照" }).click();
  await expect(page.getByText(/已保存不可变约束快照/)).toBeVisible();

  await inspector.getByLabel("输出宽度").fill("1200");
  await inspector.getByRole("button", { name: "保存为新约束快照" }).click();
  const snapshots = await page.evaluate(() => JSON.parse(localStorage.getItem("ai-commerce-canvas.constraints.project-main-image") ?? "[]"));
  expect(snapshots).toHaveLength(2);
  expect(snapshots[0].id).not.toBe(snapshots[1].id);
  expect(snapshots[0].outputSpec.width).toBe(1080);
  expect(snapshots[1].outputSpec.width).toBe(1200);
  await expect(page.getByText(/已保存 r\d+/)).toBeVisible({ timeout: 4_000 });
  await page.reload();
  await page.locator('.react-flow__node[data-id^="constraint-"]').click();
  await expect(page.getByRole("complementary", { name: "人工约束" }).getByText("基于已保存快照创建新版本")).toBeVisible();
});

test("画布节点引用会保护资产，解除引用后才允许移除", async ({ page }) => {
  await page.goto("/");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.getByLabel("导入本地资产").setInputFiles({ name: "protected.png", mimeType: "image/png", buffer: png });
  const library = page.getByRole("complementary", { name: "项目资产库" });
  await expect(library.getByLabel("资产存储占用")).toContainText("当前项目");
  const card = library.locator(".asset-card").filter({ hasText: "protected.png" });
  await expect(card.getByRole("button", { name: "使用中 1" })).toBeDisabled();

  await library.getByRole("button", { name: "关闭资产库" }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "资产库 1" }).click();
  await card.getByRole("button", { name: "移除" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "确认移除资产" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "确认移除" }).click();
  await expect(page.getByRole("button", { name: "资产库 0" })).toBeVisible();
});

test("可以一次清理所有未使用资产而保留引用资产", async ({ page }) => {
  await page.goto("/");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.getByLabel("导入本地资产").setInputFiles({ name: "orphan.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "关闭资产库" }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "资产库 1" }).click();
  await page.getByRole("button", { name: "清理未使用 1" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "确认清理未使用资产" });
  await confirmation.getByRole("button", { name: "确认清理" }).click();
  await expect(page.getByRole("button", { name: "资产库 0" })).toBeVisible();
});

test("在底图上绘制蒙版并把蒙版版本写入约束快照", async ({ page }) => {
  await page.goto("/");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.getByLabel("导入本地资产").setInputFiles({ name: "mask-source.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "关闭资产库" }).click();
  await page.getByRole("button", { name: "＋ 约束" }).click();
  const inspector = page.getByRole("complementary", { name: "人工约束" });
  await inspector.getByRole("button", { name: "绘制蒙版" }).click();
  const editor = page.getByRole("dialog", { name: "蒙版编辑器" });
  await expect(editor).toBeVisible();
  const canvas = editor.getByLabel("蒙版绘制画布");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 4 });
    await page.mouse.up();
  }
  await editor.getByRole("button", { name: "保存蒙版版本" }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole("button", { name: "资产库 2" })).toBeVisible();
  await inspector.getByRole("button", { name: "保存为新约束快照" }).click();

  const snapshots = await page.evaluate(() => JSON.parse(localStorage.getItem("ai-commerce-canvas.constraints.project-main-image") ?? "[]"));
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0].editableRegions[0].maskAssetId).toMatch(/^mask-/);
  await page.getByRole("button", { name: "资产库 2" }).click();
  const maskCard = page.getByRole("complementary", { name: "项目资产库" }).locator(".asset-card").filter({ hasText: "蒙版" });
  await expect(maskCard.getByRole("button", { name: "使用中 1" })).toBeDisabled();
});

test("蒙版支持独立撤销重做、多边形和套索", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#2563eb";
    context.fillRect(0, 0, 64, 64);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
    const input = document.querySelector('input[aria-label="导入本地资产"]') as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "mask-tools.png", { type: "image/png" }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByRole("complementary", { name: "项目资产库" }).getByText("mask-tools.png")).toBeVisible();
  await page.getByRole("button", { name: "关闭资产库" }).click();
  await page.getByRole("button", { name: "＋ 约束" }).click();
  await page.getByRole("complementary", { name: "人工约束" }).getByRole("button", { name: "绘制蒙版" }).click();
  const editor = page.getByRole("dialog", { name: "蒙版编辑器" });
  const canvas = editor.getByLabel("蒙版绘制画布");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await editor.getByRole("button", { name: "矩形" }).click();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 4 });
  await page.mouse.up();
  await expect(editor.getByRole("button", { name: "撤销蒙版" })).toBeEnabled();
  await expect(editor.getByRole("button", { name: "保存蒙版版本" })).toBeEnabled();
  await page.keyboard.press("Control+z");
  await expect(editor.getByRole("button", { name: "保存蒙版版本" })).toBeDisabled();
  await page.keyboard.press("Control+Shift+z");
  await expect(editor.getByRole("button", { name: "保存蒙版版本" })).toBeEnabled();

  await editor.getByRole("button", { name: "清空" }).click();
  await editor.getByRole("button", { name: "多边形" }).click();
  const polygonBox = await canvas.boundingBox();
  expect(polygonBox).not.toBeNull();
  if (!polygonBox) return;
  await canvas.click({ position: { x: polygonBox.width * 0.2, y: polygonBox.height * 0.2 } });
  await canvas.click({ position: { x: polygonBox.width * 0.8, y: polygonBox.height * 0.25 } });
  await canvas.click({ position: { x: polygonBox.width * 0.5, y: polygonBox.height * 0.8 } });
  await expect(editor.getByText("已放置 3 个点")).toBeVisible();
  await editor.getByRole("button", { name: "完成多边形" }).click();
  await expect(editor.getByRole("button", { name: "保存蒙版版本" })).toBeEnabled();
  await editor.getByRole("button", { name: "撤销蒙版" }).click();
  await expect(editor.getByRole("button", { name: "保存蒙版版本" })).toBeDisabled();
  await editor.getByRole("button", { name: "重做蒙版" }).click();

  await editor.getByRole("button", { name: "清空" }).click();
  await editor.getByRole("button", { name: "套索" }).click();
  const lassoBox = await canvas.boundingBox();
  expect(lassoBox).not.toBeNull();
  if (!lassoBox) return;
  await page.mouse.move(lassoBox.x + lassoBox.width * 0.25, lassoBox.y + lassoBox.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(lassoBox.x + lassoBox.width * 0.75, lassoBox.y + lassoBox.height * 0.3, { steps: 3 });
  await page.mouse.move(lassoBox.x + lassoBox.width * 0.55, lassoBox.y + lassoBox.height * 0.75, { steps: 3 });
  await page.mouse.move(lassoBox.x + lassoBox.width * 0.25, lassoBox.y + lassoBox.height * 0.25, { steps: 3 });
  await page.mouse.up();
  await expect(editor.getByRole("button", { name: "保存蒙版版本" })).toBeEnabled();
  await editor.getByRole("button", { name: "保存蒙版版本" }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole("button", { name: "资产库 2" })).toBeVisible();
});

test("本地假远端可分片备份并跨项目复用同一内容", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") externalRequests.push(request.url());
  });
  await page.goto("/");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.getByLabel("导入本地资产").setInputFiles({ name: "backup-source.png", mimeType: "image/png", buffer: png });
  const library = page.getByRole("complementary", { name: "项目资产库" });
  const firstCard = library.locator(".asset-card").filter({ hasText: "backup-source.png" });
  await firstCard.getByRole("button", { name: "备份", exact: true }).click();
  await expect(firstCard.getByRole("button", { name: "已备份" })).toBeDisabled();
  await expect(library.getByLabel("本地假远端备份")).toContainText("1 个对象");
  await expect(library.getByLabel("本地假远端备份")).toContainText("0 次外网请求");

  await page.getByLabel("切换项目").selectOption("phase-1-campaign");
  await page.getByLabel("导入本地资产").setInputFiles({ name: "backup-copy.png", mimeType: "image/png", buffer: png });
  const reusedCard = library.locator(".asset-card").filter({ hasText: "backup-copy.png" });
  await reusedCard.getByRole("button", { name: "备份", exact: true }).click();
  await expect(reusedCard.getByRole("button", { name: "已复用" })).toBeDisabled();
  await expect(library.getByLabel("本地假远端备份")).toContainText("1 个对象");
  expect(externalRequests).toEqual([]);

  await page.reload();
  await page.getByRole("button", { name: "资产库 1" }).click();
  await expect(page.getByRole("complementary", { name: "项目资产库" }).getByRole("button", { name: "已复用" })).toBeDisabled();
});

test("本地原文件丢失后可从备份恢复且 assetId 不变", async ({ page }) => {
  await page.goto("/");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.getByLabel("导入本地资产").setInputFiles({ name: "restore-source.png", mimeType: "image/png", buffer: png });
  const library = page.getByRole("complementary", { name: "项目资产库" });
  const card = library.locator(".asset-card").filter({ hasText: "restore-source.png" });
  await card.getByRole("button", { name: "备份", exact: true }).click();
  await expect(card.getByRole("button", { name: "已备份" })).toBeDisabled();

  const assetId = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ai-commerce-canvas-assets", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const asset = await new Promise<{ id: string }>((resolve, reject) => {
      const request = database.transaction("assets", "readonly").objectStore("assets").index("projectId").getAll("project-main-image");
      request.onsuccess = () => resolve(request.result.find((entry) => entry.originalName === "restore-source.png"));
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("blobs", "readwrite");
    transaction.objectStore("blobs").delete(`${asset.id}:original`);
    transaction.objectStore("blobs").delete(`${asset.id}:proxy`);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    return asset.id;
  });

  await page.reload();
  await page.getByRole("button", { name: "资产库 1" }).click();
  const missingCard = page.getByRole("complementary", { name: "项目资产库" }).locator(".asset-card").filter({ hasText: "restore-source.png" });
  await expect(missingCard).toContainText("本地原文件缺失 · 备份可恢复");
  await missingCard.getByRole("button", { name: "恢复本地" }).click();
  await expect(missingCard.getByRole("button", { name: "已备份" })).toBeDisabled();
  await expect(missingCard.locator('img[alt="restore-source.png"]')).toHaveCount(1);

  const restored = await page.evaluate(async (expectedAssetId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ai-commerce-canvas-assets", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const blob = await new Promise<{ assetId: string; blob: Blob } | undefined>((resolve, reject) => {
      const request = database.transaction("blobs", "readonly").objectStore("blobs").get(`${expectedAssetId}:original`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return { assetId: blob?.assetId, size: blob?.blob.size };
  }, assetId);
  expect(restored).toEqual({ assetId, size: png.length });
});

test("项目包可导出并作为独立副本完整导入", async ({ page }) => {
  await page.goto("/");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.getByLabel("导入本地资产").setInputFiles({ name: "portable.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText(/已保存 r\d+/)).toBeVisible({ timeout: 4_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出项目包" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.canvaspack$/);
  const archivePath = await download.path();
  expect(archivePath).not.toBeNull();
  await page.getByLabel("选择画布项目包").setInputFiles(archivePath!);

  const confirmation = page.getByRole("alertdialog", { name: "确认导入项目包" });
  await expect(confirmation).toContainText("1 个资产");
  await confirmation.getByRole("button", { name: "确认导入副本" }).click();
  await expect(page.getByLabel("切换项目")).toHaveValue(/import-/);
  await expect(page.getByLabel("切换项目").locator("option:checked")).toContainText("商品主图工作台（导入）");
  await expect(page.getByRole("button", { name: "资产库 1" })).toBeVisible();
  await expect(page.locator('.asset-node-preview img[alt="portable.png"]')).toHaveCount(1);
  await expect(page.locator(".react-flow__node")).toHaveCount(7);

  await page.reload();
  await expect(page.getByLabel("切换项目").locator("option:checked")).toContainText("商品主图工作台（导入）");
  await expect(page.locator('.asset-node-preview img[alt="portable.png"]')).toHaveCount(1);
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
