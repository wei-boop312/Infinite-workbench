import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { RunBatchAggregate } from "@canvas/contracts";
import { createApiServer } from "../apps/api/src/index";
import { InMemoryRunKernel, StaticRunAuthorizer } from "../apps/api/src/runKernel";

const runningServers: Server[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(server: Server): Promise<string> {
  runningServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP 端口");
  return `http://127.0.0.1:${address.port}`;
}

function createKernel() {
  const full = ["run:read", "run:create", "run:confirm", "run:cancel"] as const;
  return new InMemoryRunKernel({
    authorizer: new StaticRunAuthorizer([
      { bearerToken: "owner-token", tenantId: "tenant-a", actorId: "owner", projects: { "project-a": full } },
      { bearerToken: "creator-token", tenantId: "tenant-a", actorId: "creator", projects: { "project-a": ["run:read", "run:create"] } },
      { bearerToken: "other-token", tenantId: "tenant-b", actorId: "other", projects: { "project-a": full } },
    ]),
    budgets: [
      { tenantId: "tenant-a", projectId: "project-a", currency: "CNY", limitMinor: 300 },
      { tenantId: "tenant-b", projectId: "project-a", currency: "CNY", limitMinor: 500 },
    ],
    unitEstimateMinor: 40,
  });
}

function batchRequest(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-a",
    constraintSnapshotId: "constraint-v1",
    tool: "product-retouch",
    inputAssetIds: ["asset-a"],
    expectedOutputs: 3,
    maxCostMinor: 200,
    currency: "CNY",
    idempotencyKey: "user-action-1",
    ...overrides,
  };
}

async function postJson(baseUrl: string, path: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("阶段 3 批次与预算内核", () => {
  it("默认关闭任务内核并保持真实执行器禁用", async () => {
    const baseUrl = await listen(createApiServer());
    expect(await (await fetch(`${baseUrl}/health`)).json()).toMatchObject({
      mode: "phase-3",
      realExecutorsEnabled: false,
      runKernelEnabled: false,
    });
    const response = await postJson(baseUrl, "/v1/run-batches", "owner-token", batchRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "run_kernel_not_configured" });
  });

  it("创建待确认批次，并用幂等键阻止重复批次或参数漂移", async () => {
    const baseUrl = await listen(createApiServer({ runKernel: createKernel() }));
    const anonymous = await fetch(`${baseUrl}/v1/run-batches/non-existent`);
    expect(anonymous.status).toBe(401);

    const firstResponse = await postJson(baseUrl, "/v1/run-batches", "owner-token", batchRequest());
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as RunBatchAggregate;
    expect(first.batch).toMatchObject({ status: "awaiting_confirmation", estimatedCostMinor: 120, maxCostMinor: 200 });
    expect(first.jobs).toEqual([]);
    expect(first.ledger).toHaveLength(1);
    expect(first.ledger[0]).toMatchObject({ settlement: "estimated", reservedMinor: 0 });

    const repeated = await postJson(baseUrl, "/v1/run-batches", "owner-token", batchRequest());
    expect((await repeated.json() as RunBatchAggregate).batch.id).toBe(first.batch.id);

    const conflict = await postJson(baseUrl, "/v1/run-batches", "owner-token", batchRequest({ expectedOutputs: 2 }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "run_idempotency_conflict" });

    const hiddenAcrossTenants = await fetch(`${baseUrl}/v1/run-batches/${first.batch.id}`, {
      headers: { authorization: "Bearer other-token" },
    });
    expect(hiddenAcrossTenants.status).toBe(404);
  });

  it("只有成本快照一致且具备确认权限时才冻结预算和创建独立任务", async () => {
    const kernel = createKernel();
    const baseUrl = await listen(createApiServer({ runKernel: kernel }));
    const created = await postJson(baseUrl, "/v1/run-batches", "owner-token", batchRequest());
    const draft = await created.json() as RunBatchAggregate;

    const unauthorized = await postJson(baseUrl, `/v1/run-batches/${draft.batch.id}/confirm`, "creator-token", {
      expectedEstimatedCostMinor: 120,
      expectedCurrency: "CNY",
    });
    expect(unauthorized.status).toBe(403);

    const stale = await postJson(baseUrl, `/v1/run-batches/${draft.batch.id}/confirm`, "owner-token", {
      expectedEstimatedCostMinor: 80,
      expectedCurrency: "CNY",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "confirmation_snapshot_mismatch" });

    const confirmedResponse = await postJson(baseUrl, `/v1/run-batches/${draft.batch.id}/confirm`, "owner-token", {
      expectedEstimatedCostMinor: 120,
      expectedCurrency: "CNY",
    });
    expect(confirmedResponse.status).toBe(200);
    const confirmed = await confirmedResponse.json() as RunBatchAggregate;
    expect(confirmed.batch).toMatchObject({ status: "queued", confirmedBy: "owner" });
    expect(confirmed.jobs).toHaveLength(3);
    expect(new Set(confirmed.jobs.map((job) => job.idempotencyKey)).size).toBe(3);
    expect(confirmed.jobs.every((job) => job.executorKind === "mock" && job.status === "queued")).toBe(true);
    expect(confirmed.ledger.at(-1)).toMatchObject({ settlement: "reserved", reservedMinor: 120 });

    const repeated = await postJson(baseUrl, `/v1/run-batches/${draft.batch.id}/confirm`, "owner-token", {
      expectedEstimatedCostMinor: 120,
      expectedCurrency: "CNY",
    });
    const repeatedAggregate = await repeated.json() as RunBatchAggregate;
    expect(repeatedAggregate.jobs.map((job) => job.id)).toEqual(confirmed.jobs.map((job) => job.id));
    expect((await (await fetch(`${baseUrl}/v1/projects/project-a/budget`, {
      headers: { authorization: "Bearer owner-token" },
    })).json())).toMatchObject({ limitMinor: 300, reservedMinor: 120, availableMinor: 180 });
  });

  it("同时执行批次会占用项目预算，超出批次或项目上限时由服务端拒绝", async () => {
    const baseUrl = await listen(createApiServer({ runKernel: createKernel() }));
    const ceilingDraft = await (await postJson(baseUrl, "/v1/run-batches", "owner-token", batchRequest({
      idempotencyKey: "ceiling",
      expectedOutputs: 2,
      maxCostMinor: 70,
    }))).json() as RunBatchAggregate;
    const ceiling = await postJson(baseUrl, `/v1/run-batches/${ceilingDraft.batch.id}/confirm`, "owner-token", {
      expectedEstimatedCostMinor: 80,
      expectedCurrency: "CNY",
    });
    expect(ceiling.status).toBe(422);
    expect(await ceiling.json()).toEqual({ error: "batch_cost_ceiling_exceeded" });

    const first = await (await postJson(baseUrl, "/v1/run-batches", "owner-token", batchRequest({
      idempotencyKey: "reserve-first",
      expectedOutputs: 5,
      maxCostMinor: 250,
    }))).json() as RunBatchAggregate;
    expect((await postJson(baseUrl, `/v1/run-batches/${first.batch.id}/confirm`, "owner-token", {
      expectedEstimatedCostMinor: 200,
      expectedCurrency: "CNY",
    })).status).toBe(200);

    const second = await (await postJson(baseUrl, "/v1/run-batches", "owner-token", batchRequest({
      idempotencyKey: "reserve-second",
      expectedOutputs: 3,
      maxCostMinor: 200,
    }))).json() as RunBatchAggregate;
    const overBudget = await postJson(baseUrl, `/v1/run-batches/${second.batch.id}/confirm`, "owner-token", {
      expectedEstimatedCostMinor: 120,
      expectedCurrency: "CNY",
    });
    expect(overBudget.status).toBe(422);
    expect(await overBudget.json()).toEqual({ error: "project_budget_exceeded" });
  });

  it("取消排队批次会取消未开始任务并完整释放预留预算", async () => {
    const baseUrl = await listen(createApiServer({ runKernel: createKernel() }));
    const draft = await (await postJson(baseUrl, "/v1/run-batches", "owner-token", batchRequest({
      idempotencyKey: "cancel-me",
      expectedOutputs: 2,
    }))).json() as RunBatchAggregate;
    await postJson(baseUrl, `/v1/run-batches/${draft.batch.id}/confirm`, "owner-token", {
      expectedEstimatedCostMinor: 80,
      expectedCurrency: "CNY",
    });

    const cancelledResponse = await postJson(baseUrl, `/v1/run-batches/${draft.batch.id}/cancel`, "owner-token");
    expect(cancelledResponse.status).toBe(200);
    const cancelled = await cancelledResponse.json() as RunBatchAggregate;
    expect(cancelled.batch.status).toBe("cancelled");
    expect(cancelled.jobs.every((job) => job.status === "cancelled")).toBe(true);
    expect(cancelled.ledger.at(-1)).toMatchObject({ settlement: "released", actualMinor: 0, reservedMinor: 0 });
    expect(cancelled.audit.map((event) => event.eventType)).toContain("budget-released");
    expect((await (await fetch(`${baseUrl}/v1/projects/project-a/budget`, {
      headers: { authorization: "Bearer owner-token" },
    })).json())).toMatchObject({ reservedMinor: 0, availableMinor: 300 });

    const repeated = await postJson(baseUrl, `/v1/run-batches/${draft.batch.id}/cancel`, "owner-token");
    expect((await repeated.json() as RunBatchAggregate).ledger).toHaveLength(cancelled.ledger.length);
  });
});
