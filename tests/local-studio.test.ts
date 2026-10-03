import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RegisterRunContextRequest, RunBatchAggregate } from "@canvas/contracts";
import { createLocalStudioMiddleware } from "../apps/api/src/localStudio";
import { InMemoryRunKernel, RunKernelError } from "../apps/api/src/runKernel";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() { const path = mkdtempSync(join(tmpdir(), "canvas-studio-test-")); directories.push(path); return path; }
async function listen(path: string) {
  const middleware = createLocalStudioMiddleware(path);
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("服务未启动");
  return `http://127.0.0.1:${address.port}`;
}
function context(projectId = "project-a"): RegisterRunContextRequest {
  return { projectId, assets: [{ id: `asset-${projectId}`, projectId, kind: "image", purpose: "source", originalName: "product.png", storageKey: "indexeddb://original", mimeType: "image/png", byteSize: 70, createdAt: "2026-10-03T00:00:00Z" }],
    constraints: [{ id: `constraint-${projectId}`, projectId, lockedPaths: ["product.pixels"], editableRegions: [{ id: "background", description: "仅背景" }], brandRules: {}, outputSpec: { width: 1200, height: 1200, format: "png" }, createdAt: "2026-10-03T00:00:00Z" }] };
}
function request(projectId = "project-a") {
  return { projectId, constraintSnapshotId: `constraint-${projectId}`, tool: "product-retouch" as const, inputAssetIds: [`asset-${projectId}`], expectedOutputs: 2, maxCostMinor: 100, currency: "CNY", idempotencyKey: `action-${projectId}`, mockScenario: "success" as const };
}
function call(url: string, path: string, body?: unknown) {
  return fetch(`${url}/studio-api${path}`, { method: body === undefined ? "GET" : "POST", headers: { "x-canvas-local": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
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
    const draft = await (await call(first, "/v1/run-batches", request())).json() as RunBatchAggregate;
    const second = await listen(path);
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
    expect(readFileSync(join(path, "runs.json"), "utf8")).not.toContain("Bearer");
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
});
