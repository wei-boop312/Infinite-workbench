import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RegisterRunContextRequest, RunBatchAggregate } from "@canvas/contracts";
import { createLocalStudioMiddleware } from "../apps/api/src/localStudio";
import { InMemoryRunKernel, RunKernelError } from "../apps/api/src/runKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { FileRunKernelStateStore } from "../apps/api/src/runKernelStore";

const directories: string[] = [];
const servers: Server[] = [];
const studios: Array<ReturnType<typeof createLocalStudioMiddleware>> = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  for (const studio of studios.splice(0)) studio.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() { const path = mkdtempSync(join(tmpdir(), "canvas-studio-test-")); directories.push(path); return path; }
async function listen(path: string) {
  const middleware = createLocalStudioMiddleware(path);
  studios.push(middleware);
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("服务未启动");
  return `http://127.0.0.1:${address.port}`;
}
function context(projectId = "project-a"): RegisterRunContextRequest {
  return { projectId, assets: [{ id: `asset-${projectId}`, projectId, kind: "image", purpose: "source", originalName: "product.png", storageKey: "indexeddb://original", mimeType: "image/png", byteSize: png.length, createdAt: "2026-10-03T00:00:00Z" }],
    constraints: [{ id: `constraint-${projectId}`, projectId, lockedPaths: ["product.pixels"], editableRegions: [{ id: "background", description: "仅背景" }], brandRules: {}, outputSpec: { width: 1200, height: 1200, format: "png" }, createdAt: "2026-10-03T00:00:00Z" }] };
}
function request(projectId = "project-a") {
  return { projectId, constraintSnapshotId: `constraint-${projectId}`, tool: "product-retouch" as const, inputAssetIds: [`asset-${projectId}`], expectedOutputs: 2, maxCostMinor: 100, currency: "CNY", idempotencyKey: `action-${projectId}`, mockScenario: "success" as const };
}
function call(url: string, path: string, body?: unknown) {
  return fetch(`${url}/studio-api${path}`, { method: body === undefined ? "GET" : "POST", headers: { "x-canvas-local": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function verify(url: string, projectId = "project-a") {
  const response = await fetch(`${url}/studio-api/v1/projects/${projectId}/assets/asset-${projectId}/verification`, {
    method: "POST", headers: { "x-canvas-local": "1", "content-type": "image/png", "x-content-sha256": createHash("sha256").update(png).digest("hex") }, body: png,
  });
  expect(response.status).toBe(200);
  return response.json();
}
function rawStatus(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const outgoing = httpRequest(`${url}/studio-api/context`, { method: "POST", headers: { "x-canvas-local": "1", ...headers } }, (response) => {
      response.resume(); response.on("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.on("error", reject); outgoing.end(JSON.stringify(context()));
  });
}

describe("本地画布任务桥接", () => {
  it("拒绝跨站、伪造主机和缺少本地请求标记，且普通路径继续传递", async () => {
    const url = await listen(directory());
    expect((await fetch(`${url}/studio-api/v1/projects/project-a/budget`)).status).toBe(403);
    for (const headers of [{ origin: "https://attacker.invalid" }, { "sec-fetch-site": "cross-site" }, { host: "attacker.invalid" }]) {
      expect(await rawStatus(url, headers)).toBe(403);
    }
    expect((await fetch(`${url}/ordinary-path`)).status).toBe(404);
    expect((await call(url, "/context", context())).status).toBe(200);
  });

  it("校验项目归属、快照不可覆盖，输入与蒙版底图必须匹配", async () => {
    const url = await listen(directory());
    const original = context();
    expect((await call(url, "/context", { ...original, assets: context("other").assets })).status).toBe(400);
    expect((await call(url, "/context", original)).status).toBe(200);
    expect((await call(url, "/context", { ...original, constraints: [{ ...original.constraints[0], outputSpec: { width: 800, height: 800, format: "png" } }] })).status).toBe(400);
    const foreign = await call(url, "/v1/run-batches", { ...request(), inputAssetIds: ["asset-other"] });
    expect(foreign.status).toBe(422);
    expect(await foreign.json()).toEqual({ error: "run_input_asset_invalid" });
    const missing = await call(url, "/v1/run-batches", { ...request(), constraintSnapshotId: "foreign-constraint" });
    expect(await missing.json()).toEqual({ error: "run_constraint_not_found" });
    await verify(url);
    const mask = { ...original.assets[0], id: "mask-1", purpose: "mask", sourceAssetId: "asset-other" };
    const masked = { ...original.constraints[0], id: "masked-constraint", editableRegions: [{ id: "background", description: "仅背景", maskAssetId: mask.id }] };
    expect((await call(url, "/context", { projectId: original.projectId, assets: [mask], constraints: [masked] })).status).toBe(200);
    const mismatch = await call(url, "/v1/run-batches", { ...request(), constraintSnapshotId: masked.id });
    expect(await mismatch.json()).toEqual({ error: "run_mask_source_mismatch" });
    expect((await call(url, "/v1/projects/project-a/run-batches")).status).toBe(200);
    expect(await (await call(url, "/v1/projects/project-a/run-batches")).json()).toEqual([]);
  });

  it("动态登记项目、预估与结算跨重启恢复，列表不混入其他项目", async () => {
    const path = directory();
    const first = await listen(path);
    for (const id of ["project-a", "imported-copy"]) expect((await call(first, "/context", context(id))).status).toBe(200);
    const receipt = await verify(first);
    const draft = await (await call(first, "/v1/run-batches", request())).json() as RunBatchAggregate;
    const second = await listen(path);
    expect(await verify(second)).toEqual(receipt);
    const list = await (await call(second, "/v1/projects/project-a/run-batches")).json() as RunBatchAggregate[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ batch: { id: draft.batch.id, status: "awaiting_confirmation" }, jobs: [] });
    expect(await (await call(second, "/v1/projects/imported-copy/run-batches")).json()).toEqual([]);
    const confirm = { expectedEstimatedCostMinor: 50, expectedCurrency: "CNY" };
    expect((await call(second, `/v1/run-batches/${draft.batch.id}/confirm`, confirm)).status).toBe(200);
    await call(second, `/v1/run-batches/${draft.batch.id}/confirm`, confirm);
    expect(await (await call(second, "/v1/projects/project-a/budget")).json()).toMatchObject({ reservedMinor: 50, spentMinor: 0 });
    const completed = await (await call(second, `/v1/run-batches/${draft.batch.id}/dispatch`, {})).json() as RunBatchAggregate;
    expect(completed.batch.status).toBe("succeeded");
    const third = await listen(path);
    expect(await (await call(third, "/v1/projects/project-a/budget")).json()).toMatchObject({ reservedMinor: 0, spentMinor: 40, availableMinor: 9960 });
    expect((await (await call(third, "/v1/run-batches", request())).json() as RunBatchAggregate).batch.id).toBe(draft.batch.id);
    const database = new SqliteRunKernelStateStore(join(path, "studio.sqlite"));
    try { expect(JSON.stringify(database.load())).not.toContain("Bearer"); }
    finally { database.close(); }
  });

  it("待确认和重试时重新验证输入，验证失败不预留预算", () => {
    let inputsValid = true;
    const kernel = new InMemoryRunKernel({ authorizer: { authenticate: () => null, allows: () => true }, budgets: [{ tenantId: "local", projectId: "project-a", currency: "CNY", limitMinor: 1000 }],
      validateInputs: () => { if (!inputsValid) throw new RunKernelError(422, "invalid-input", "无效输入"); } });
    const principal = { tenantId: "local", actorId: "designer" };
    const draft = kernel.createBatch(principal, { ...request(), mockScenario: "failed" });
    inputsValid = false;
    expect(() => kernel.confirmBatch(principal, draft.batch.id, { expectedEstimatedCostMinor: 50, expectedCurrency: "CNY" })).toThrow(/无效输入/);
    expect(kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
    inputsValid = true;
    kernel.confirmBatch(principal, draft.batch.id, { expectedEstimatedCostMinor: 50, expectedCurrency: "CNY" });
    const failed = kernel.dispatchBatch(principal, draft.batch.id);
    inputsValid = false;
    expect(() => kernel.retryJob(principal, failed.jobs[0].id, { expectedEstimatedCostMinor: 25, expectedCurrency: "CNY", mockScenario: "success" })).toThrow(/无效输入/);
    expect(kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
    expect(kernel.getBatch(principal, draft.batch.id).jobs).toHaveLength(2);
  });

  it("旧 JSON 原子迁移至数据库，保留原文件，不再从旧文件覆盖新账本", async () => {
    const path = directory(); const catalogPath = join(path, "catalog.json"); const runsPath = join(path, "runs.json");
    writeFileSync(catalogPath, JSON.stringify({ schemaVersion: 1, projects: [context()] }));
    const legacy = new InMemoryRunKernel({ authorizer: { authenticate: () => null, allows: () => true },
      budgets: [{ tenantId: "local-studio", projectId: "project-a", currency: "CNY", limitMinor: 10_000 }], stateStore: new FileRunKernelStateStore(runsPath) });
    const principal = { tenantId: "local-studio", actorId: "local-designer" };
    const draft = legacy.createBatch(principal, request());
    legacy.confirmBatch(principal, draft.batch.id, { expectedEstimatedCostMinor: 50, expectedCurrency: "CNY" });
    const oldRuns = readFileSync(runsPath, "utf8"); const oldCatalog = readFileSync(catalogPath, "utf8");
    const first = await listen(path);
    expect((await (await call(first, "/v1/run-batches", request())).json() as RunBatchAggregate).batch.id).toBe(draft.batch.id);
    expect(await (await call(first, "/v1/projects/project-a/budget")).json()).toMatchObject({ reservedMinor: 50, spentMinor: 0 });
    expect(await (await call(first, `/v1/run-batches/${draft.batch.id}/dispatch`, {})).json()).toEqual({ error: "run_asset_not_verified" });
    await verify(first);
    await call(first, `/v1/run-batches/${draft.batch.id}/dispatch`, {});
    const second = await listen(path);
    expect(await (await call(second, "/v1/projects/project-a/budget")).json()).toMatchObject({ reservedMinor: 0, spentMinor: 40 });
    expect(readFileSync(runsPath, "utf8")).toBe(oldRuns);
    expect(readFileSync(catalogPath, "utf8")).toBe(oldCatalog);
  });

  it("旧记录损坏时迁移整体回滚，不留下半个项目目录", () => {
    const path = directory();
    writeFileSync(join(path, "catalog.json"), JSON.stringify({ schemaVersion: 1, projects: [context()] }));
    writeFileSync(join(path, "runs.json"), "not-json");
    expect(() => createLocalStudioMiddleware(path)).toThrow();
    const store = new SqliteRunKernelStateStore(join(path, "studio.sqlite"));
    try { expect(store.load()).toBeNull(); expect(store.loadCatalog()).toBeNull(); }
    finally { store.close(); }
    expect(readFileSync(join(path, "runs.json"), "utf8")).toBe("not-json");
  });

  it("旧单进程文件中中断的运行任务仅恢复一次，并继续冻结预算", async () => {
    const path = directory();
    writeFileSync(join(path, "catalog.json"), JSON.stringify({ schemaVersion: 1, projects: [context()] }));
    const legacy = new InMemoryRunKernel({ authorizer: { authenticate: () => null, allows: () => true },
      budgets: [{ tenantId: "local-studio", projectId: "project-a", currency: "CNY", limitMinor: 10_000 }],
      stateStore: new FileRunKernelStateStore(join(path, "runs.json")) });
    const principal = { tenantId: "local-studio", actorId: "local-designer" };
    const draft = legacy.createBatch(principal, { ...request(), mockScenario: "slow" });
    legacy.confirmBatch(principal, draft.batch.id, { expectedEstimatedCostMinor: 50, expectedCurrency: "CNY" });
    expect(legacy.dispatchBatch(principal, draft.batch.id).jobs.every((job) => job.status === "running")).toBe(true);
    const first = await listen(path); const second = await listen(path);
    const recovered = await (await call(first, `/v1/run-batches/${draft.batch.id}`)).json() as RunBatchAggregate;
    expect(recovered.jobs.every((job) => job.status === "billing_unknown")).toBe(true);
    expect(recovered.ledger.filter((entry) => entry.settlement === "unknown")).toHaveLength(2);
    expect(await (await call(second, "/v1/projects/project-a/budget")).json()).toMatchObject({ reservedMinor: 50, spentMinor: 0 });
    expect((await (await call(second, `/v1/run-batches/${draft.batch.id}`)).json() as RunBatchAggregate).ledger).toEqual(recovered.ledger);
  });

  it("共享状态的两个服务及时看见新增项目和输入，不覆盖对方目录或预算", async () => {
    const path = directory(); const first = await listen(path); const second = await listen(path);
    await Promise.all([call(first, "/context", context()), call(second, "/context", context("project-b"))]);
    await verify(second); await verify(first, "project-b");
    expect((await call(second, "/v1/run-batches", request())).status).toBe(201);
    expect((await call(first, "/v1/run-batches", request("project-b"))).status).toBe(201);
    const a = context(); const b = context();
    a.assets[0].id = "extra-a"; b.assets[0].id = "extra-b";
    expect((await Promise.all([call(first, "/context", a), call(second, "/context", b)])).every((response) => response.status === 200)).toBe(true);
    const store = new SqliteRunKernelStateStore(join(path, "studio.sqlite"));
    try {
      expect(store.loadCatalog()?.projects).toHaveLength(2);
      expect(store.loadCatalog()?.projects.find((item) => item.projectId === "project-a")?.assets).toHaveLength(3);
      expect(store.load()?.budgets).toHaveLength(2);
    } finally { store.close(); }
  });

  it("只有登记信息不能创建任务，原文件验证失败不产生预算或任务", async () => {
    const url = await listen(directory());
    await call(url, "/context", context());
    const response = await call(url, "/v1/run-batches", request());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "run_asset_not_verified" });
    expect(await (await call(url, "/v1/projects/project-a/run-batches")).json()).toEqual([]);
    expect(await (await call(url, "/v1/projects/project-a/budget")).json()).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
    await verify(url);
    expect((await call(url, "/v1/run-batches", request())).status).toBe(201);
  });

  it("专项验收：部分完成后取消，只停止未开始任务，成功输出及真实账本跨重启保留", async () => {
    const path = directory(); const url = await listen(path);
    await call(url, "/context", context()); await verify(url);
    const draft = await (await call(url, "/v1/run-batches", { ...request(), expectedOutputs: 3 })).json() as RunBatchAggregate;
    expect((await call(url, `/v1/run-batches/${draft.batch.id}/confirm`, { expectedEstimatedCostMinor: 75, expectedCurrency: "CNY" })).status).toBe(200);
    const partial = await (await call(url, `/v1/run-batches/${draft.batch.id}/dispatch`, {})).json() as RunBatchAggregate;
    expect(partial.jobs.map((job) => job.status)).toEqual(["succeeded", "succeeded", "queued"]);
    expect(await (await call(url, "/v1/projects/project-a/budget")).json()).toMatchObject({ spentMinor: 40, reservedMinor: 25 });
    const cancelled = await (await call(url, `/v1/run-batches/${draft.batch.id}/cancel`, {})).json() as RunBatchAggregate;
    expect(cancelled.jobs.slice(0, 2)).toEqual(partial.jobs.slice(0, 2));
    expect(cancelled.jobs[2]).toMatchObject({ status: "cancelled", outputAssetIds: [] });
    expect(cancelled.ledger.slice(0, partial.ledger.length)).toEqual(partial.ledger);
    expect(cancelled.ledger.filter((entry) => entry.settlement === "settled")).toHaveLength(2);
    expect(await (await call(url, "/v1/projects/project-a/budget")).json()).toMatchObject({ spentMinor: 40, reservedMinor: 0, availableMinor: 9960 });
    const restarted = await listen(path);
    expect(await (await call(restarted, `/v1/run-batches/${draft.batch.id}`)).json()).toEqual(cancelled);
    expect(await (await call(restarted, `/v1/run-batches/${draft.batch.id}/dispatch`, {})).json()).toEqual(cancelled);
    expect(await (await call(restarted, `/v1/run-batches/${draft.batch.id}/cancel`, {})).json()).toEqual(cancelled);
    expect(await (await call(restarted, "/v1/projects/project-a/budget")).json()).toMatchObject({ spentMinor: 40, reservedMinor: 0 });
  });

  it("专项验收：绕过界面直接请求也不能在项目预算耗尽后冻结新任务", async () => {
    const url = await listen(directory()); await call(url, "/context", context()); await verify(url);
    for (let index = 0; index < 40; index += 1) {
      const response = await call(url, "/v1/run-batches", { ...request(), idempotencyKey: `budget-gate-${index}`, expectedOutputs: 10, maxCostMinor: 300 });
      expect(response.status).toBe(201);
      const draft = await response.json() as RunBatchAggregate;
      expect((await call(url, `/v1/run-batches/${draft.batch.id}/confirm`, { expectedEstimatedCostMinor: 250, expectedCurrency: "CNY" })).status).toBe(200);
    }
    const before = await (await call(url, "/v1/projects/project-a/budget")).json();
    expect(before).toMatchObject({ limitMinor: 10000, reservedMinor: 10000, spentMinor: 0, availableMinor: 0 });
    const excess = await (await call(url, "/v1/run-batches", { ...request(), idempotencyKey: "excess-direct-request" })).json() as RunBatchAggregate;
    const blocked = await call(url, `/v1/run-batches/${excess.batch.id}/confirm`, { expectedEstimatedCostMinor: 50, expectedCurrency: "CNY" });
    expect(blocked.status).toBe(422); expect(await blocked.json()).toEqual({ error: "project_budget_exceeded" });
    const unchanged = await (await call(url, `/v1/run-batches/${excess.batch.id}`)).json() as RunBatchAggregate;
    expect(unchanged.jobs).toEqual([]); expect(unchanged.batch.status).toBe("awaiting_confirmation");
    expect(unchanged.audit.at(-1)?.eventType).toBe("confirmation-rejected");
    expect(await (await call(url, "/v1/projects/project-a/budget")).json()).toEqual(before);
    expect(await (await call(url, "/health")).json()).toMatchObject({ realExecutorsEnabled: false, assetVerificationEnabled: true });
  });
});
