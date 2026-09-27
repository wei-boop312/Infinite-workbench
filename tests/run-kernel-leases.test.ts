import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateRunBatchRequest, RunBatchAggregate, RunJobClaimResult } from "@canvas/contracts";
import { createApiServer } from "../apps/api/src/index";
import {
  InMemoryRunKernel,
  RunKernelError,
  StaticRunAuthorizer,
  type ProjectExecutionLimitConfig,
  type ProviderExecutionLimitConfig,
  type RunPrincipal,
} from "../apps/api/src/runKernel";

const principal: RunPrincipal = { tenantId: "tenant-a", actorId: "owner" };
const full = ["run:read", "run:create", "run:confirm", "run:cancel", "run:execute", "run:retry"] as const;
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

function createKernel(options: {
  clock?: () => number;
  projectLimits?: ProjectExecutionLimitConfig[];
  providerLimits?: ProviderExecutionLimitConfig[];
  leaseDurationMs?: number;
  jobTimeoutMs?: number;
} = {}) {
  return new InMemoryRunKernel({
    authorizer: new StaticRunAuthorizer([
      {
        bearerToken: "owner-token",
        tenantId: "tenant-a",
        actorId: "owner",
        projects: { "project-a": full, "project-b": full },
      },
    ]),
    budgets: [
      { tenantId: "tenant-a", projectId: "project-a", currency: "CNY", limitMinor: 1_000 },
      { tenantId: "tenant-a", projectId: "project-b", currency: "CNY", limitMinor: 1_000 },
    ],
    unitEstimateMinor: 40,
    unitActualMinor: 30,
    maxConcurrentJobs: 4,
    projectLimits: options.projectLimits,
    providerLimits: options.providerLimits,
    leaseDurationMs: options.leaseDurationMs ?? 1_000,
    jobTimeoutMs: options.jobTimeoutMs ?? 10_000,
    clock: options.clock,
  });
}

function request(projectId: string, idempotencyKey: string, mockScenario: CreateRunBatchRequest["mockScenario"] = "success"):
CreateRunBatchRequest {
  return {
    projectId,
    constraintSnapshotId: `constraint-${projectId}`,
    tool: "product-retouch",
    inputAssetIds: [`asset-${projectId}`],
    expectedOutputs: 1,
    maxCostMinor: 100,
    currency: "CNY",
    idempotencyKey,
    mockScenario,
  };
}

function confirm(kernel: InMemoryRunKernel, input: CreateRunBatchRequest): RunBatchAggregate {
  const draft = kernel.createBatch(principal, input);
  return kernel.confirmBatch(principal, draft.batch.id, {
    expectedEstimatedCostMinor: draft.batch.estimatedCostMinor,
    expectedCurrency: draft.batch.currency,
  });
}

describe("阶段 3 可领取租约与分层限流", () => {
  it("租约绑定执行器和编号；未启动租约过期后安全回队列并使用新编号", () => {
    let now = Date.parse("2026-09-27T20:00:00+08:00");
    const kernel = createKernel({ clock: () => now });
    const batch = confirm(kernel, request("project-a", "lease-fencing"));
    const firstClaim = kernel.claimBatch(principal, batch.batch.id, { workerId: "worker-a", maxJobs: 1 });
    const firstLease = firstClaim.leases[0];
    expect(firstClaim.aggregate.jobs[0]).toMatchObject({
      status: "leased",
      leaseId: firstLease.leaseId,
      leaseOwnerId: "worker-a",
    });
    expect(() => kernel.executeLeasedJob(principal, firstLease.jobId, {
      workerId: "worker-b",
      leaseId: firstLease.leaseId,
    })).toThrowError(expect.objectContaining<Partial<RunKernelError>>({ code: "run_job_lease_mismatch" }));

    now += 1_001;
    const secondClaim = kernel.claimBatch(principal, batch.batch.id, { workerId: "worker-b", maxJobs: 1 });
    const secondLease = secondClaim.leases[0];
    expect(secondLease.leaseId).not.toBe(firstLease.leaseId);
    expect(secondClaim.aggregate.audit).toContainEqual(expect.objectContaining({
      eventType: "job-lease-expired",
      metadata: expect.objectContaining({ action: "requeued-before-start" }),
    }));
    expect(() => kernel.executeLeasedJob(principal, firstLease.jobId, {
      workerId: "worker-a",
      leaseId: firstLease.leaseId,
    })).toThrowError(expect.objectContaining<Partial<RunKernelError>>({ code: "run_job_lease_mismatch" }));
    expect(kernel.executeLeasedJob(principal, secondLease.jobId, {
      workerId: "worker-b",
      leaseId: secondLease.leaseId,
    }).batch.status).toBe("succeeded");
  });

  it("项目级并发上限会约束同一项目中的不同批次", () => {
    const now = Date.parse("2026-09-27T20:10:00+08:00");
    const kernel = createKernel({
      clock: () => now,
      projectLimits: [{ tenantId: "tenant-a", projectId: "project-a", maxConcurrentJobs: 1 }],
      providerLimits: [{ adapterId: "mock-product-retouch-v1", maxConcurrentJobs: 4 }],
    });
    const first = confirm(kernel, request("project-a", "project-limit-1", "slow"));
    const second = confirm(kernel, request("project-a", "project-limit-2"));
    expect(kernel.dispatchBatch(principal, first.batch.id).jobs[0].status).toBe("running");

    const blocked = kernel.claimBatch(principal, second.batch.id, { workerId: "worker-b", maxJobs: 1 });
    expect(blocked.leases).toEqual([]);
    expect(blocked).toMatchObject({ throttledBy: "project-concurrency", retryAfterMs: 1_000 });
    expect(blocked.aggregate.audit.at(-1)).toMatchObject({
      eventType: "dispatch-throttled",
      metadata: expect.objectContaining({ reason: "project-concurrency" }),
    });
  });

  it("供应商并发上限会跨项目约束使用同一适配器的任务", () => {
    const now = Date.parse("2026-09-27T20:20:00+08:00");
    const kernel = createKernel({
      clock: () => now,
      projectLimits: [
        { tenantId: "tenant-a", projectId: "project-a", maxConcurrentJobs: 4 },
        { tenantId: "tenant-a", projectId: "project-b", maxConcurrentJobs: 4 },
      ],
      providerLimits: [{ adapterId: "mock-product-retouch-v1", maxConcurrentJobs: 1 }],
    });
    const first = confirm(kernel, request("project-a", "provider-limit-1", "slow"));
    const second = confirm(kernel, request("project-b", "provider-limit-2"));
    kernel.dispatchBatch(principal, first.batch.id);

    const blocked = kernel.claimBatch(principal, second.batch.id, { workerId: "worker-b", maxJobs: 1 });
    expect(blocked.leases).toEqual([]);
    expect(blocked.throttledBy).toBe("provider-concurrency");
  });

  it("供应商时间窗口限流在并发已释放后仍阻止突发启动", () => {
    let now = Date.parse("2026-09-27T20:30:00+08:00");
    const kernel = createKernel({
      clock: () => now,
      providerLimits: [{
        adapterId: "mock-product-retouch-v1",
        maxConcurrentJobs: 4,
        maxStartsPerWindow: 1,
        windowMs: 1_000,
      }],
    });
    const first = confirm(kernel, request("project-a", "rate-limit-1"));
    const firstLease = kernel.claimBatch(principal, first.batch.id, { workerId: "worker-a", maxJobs: 1 }).leases[0];
    kernel.executeLeasedJob(principal, firstLease.jobId, { workerId: "worker-a", leaseId: firstLease.leaseId });

    const second = confirm(kernel, request("project-b", "rate-limit-2"));
    const blocked = kernel.claimBatch(principal, second.batch.id, { workerId: "worker-b", maxJobs: 1 });
    expect(blocked).toMatchObject({ leases: [], throttledBy: "provider-rate", retryAfterMs: 1_000 });

    now += 1_000;
    const allowed = kernel.claimBatch(principal, second.batch.id, { workerId: "worker-b", maxJobs: 1 });
    expect(allowed.leases).toHaveLength(1);
  });

  it("已启动任务的租约过期后进入计费待核对，不会回队列或自动重试", () => {
    let now = Date.parse("2026-09-27T20:40:00+08:00");
    const kernel = createKernel({ clock: () => now, leaseDurationMs: 1_000, jobTimeoutMs: 10_000 });
    const batch = confirm(kernel, request("project-a", "running-lease-expiry", "slow"));
    const lease = kernel.claimBatch(principal, batch.batch.id, { workerId: "worker-a", maxJobs: 1 }).leases[0];
    expect(kernel.executeLeasedJob(principal, lease.jobId, {
      workerId: "worker-a",
      leaseId: lease.leaseId,
    }).jobs[0].status).toBe("running");
    expect(() => kernel.cancelBatch(principal, batch.batch.id))
      .toThrowError(expect.objectContaining<Partial<RunKernelError>>({ code: "run_batch_not_cancellable" }));
    expect(kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0 });

    now += 1_001;
    const recovered = kernel.reconcileBatch(principal, batch.batch.id);
    expect(recovered.jobs).toHaveLength(1);
    expect(recovered.jobs[0]).toMatchObject({
      status: "billing_unknown",
      failureCode: "lease-expired-after-start",
    });
    expect(recovered.ledger.at(-1)).toMatchObject({ settlement: "unknown", reservedMinor: 40 });
    expect(kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0 });
    expect(recovered.audit.map((event) => event.eventType)).not.toContain("job-retry-created");
  });

  it("HTTP 入口分别执行领取和带租约启动", async () => {
    const kernel = createKernel();
    const batch = confirm(kernel, request("project-a", "lease-http"));
    const baseUrl = await listen(createApiServer({ runKernel: kernel }));
    const claimResponse = await fetch(`${baseUrl}/v1/run-batches/${batch.batch.id}/claims`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ workerId: "http-worker", maxJobs: 1 }),
    });
    expect(claimResponse.status).toBe(200);
    const claimed = await claimResponse.json() as RunJobClaimResult;
    expect(claimed.leases).toHaveLength(1);

    const lease = claimed.leases[0];
    const executeResponse = await fetch(`${baseUrl}/v1/run-jobs/${lease.jobId}/execute`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ workerId: lease.workerId, leaseId: lease.leaseId }),
    });
    expect(executeResponse.status).toBe(200);
    expect((await executeResponse.json() as RunBatchAggregate).batch.status).toBe("succeeded");
  });
});
