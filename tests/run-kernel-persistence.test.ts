import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateRunBatchRequest, RunKernelSnapshot } from "@canvas/contracts";
import {
  InMemoryRunKernel,
  RunKernelError,
  StaticRunAuthorizer,
  type RunPrincipal,
} from "../apps/api/src/runKernel";
import { FileRunKernelStateStore, type RunKernelStateStore } from "../apps/api/src/runKernelStore";

class MemoryRunKernelStateStore implements RunKernelStateStore {
  snapshot: RunKernelSnapshot | null = null;
  saveCount = 0;

  load(): RunKernelSnapshot | null {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  save(snapshot: RunKernelSnapshot): void {
    this.snapshot = structuredClone(snapshot);
    this.saveCount += 1;
  }
}

const temporaryDirectories: string[] = [];
const principal: RunPrincipal = { tenantId: "tenant-a", actorId: "owner" };
const full = ["run:read", "run:create", "run:confirm", "run:cancel", "run:execute", "run:retry"] as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createKernel(store: RunKernelStateStore, options: {
  clock?: () => number;
  maxConcurrentJobs?: number;
  leaseDurationMs?: number;
} = {}) {
  return new InMemoryRunKernel({
    authorizer: new StaticRunAuthorizer([
      { bearerToken: "owner-token", tenantId: "tenant-a", actorId: "owner", projects: { "project-a": full } },
    ]),
    budgets: [{ tenantId: "tenant-a", projectId: "project-a", currency: "CNY", limitMinor: 300 }],
    stateStore: store,
    unitEstimateMinor: 40,
    unitActualMinor: 30,
    maxConcurrentJobs: options.maxConcurrentJobs ?? 2,
    leaseDurationMs: options.leaseDurationMs,
    jobTimeoutMs: 1_000,
    clock: options.clock,
  });
}

function request(overrides: Partial<CreateRunBatchRequest> = {}): CreateRunBatchRequest {
  return {
    projectId: "project-a",
    constraintSnapshotId: "constraint-v1",
    tool: "product-retouch",
    inputAssetIds: ["asset-a"],
    expectedOutputs: 3,
    maxCostMinor: 200,
    currency: "CNY",
    idempotencyKey: "persistent-action-1",
    mockScenario: "success",
    ...overrides,
  };
}

function createConfirmed(kernel: InMemoryRunKernel, runRequest: CreateRunBatchRequest) {
  const draft = kernel.createBatch(principal, runRequest);
  return kernel.confirmBatch(principal, draft.batch.id, {
    expectedEstimatedCostMinor: draft.batch.estimatedCostMinor,
    expectedCurrency: draft.batch.currency,
  });
}

describe("阶段 3 任务内核持久化与重启恢复", () => {
  it("重启后待人工确认的预估不会被错误标记为已完成", () => {
    const store = new MemoryRunKernelStateStore();
    const draft = createKernel(store).createBatch(principal, request());
    const restored = createKernel(store);
    expect(restored.getBatch(principal, draft.batch.id)).toMatchObject({ batch: { status: "awaiting_confirmation" }, jobs: [] });
    expect(restored.getBudget(principal, "project-a").reservedMinor).toBe(0);
    expect(restored.confirmBatch(principal, draft.batch.id, {
      expectedEstimatedCostMinor: draft.batch.estimatedCostMinor, expectedCurrency: "CNY",
    }).jobs).toHaveLength(3);
  });
  it("重启后保留排队任务、预算、幂等索引，并可继续完成任务", () => {
    const store = new MemoryRunKernelStateStore();
    const runRequest = request();
    const firstKernel = createKernel(store);
    const confirmed = createConfirmed(firstKernel, runRequest);
    expect(confirmed.jobs.every((job) => job.status === "queued")).toBe(true);
    expect(store.saveCount).toBeGreaterThanOrEqual(2);

    const restoredKernel = createKernel(store);
    const restored = restoredKernel.getBatch(principal, confirmed.batch.id);
    expect(restored.jobs.map((job) => job.status)).toEqual(["queued", "queued", "queued"]);
    expect(restoredKernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 120, spentMinor: 0 });
    expect(restoredKernel.createBatch(principal, runRequest).batch.id).toBe(confirmed.batch.id);

    restoredKernel.dispatchBatch(principal, confirmed.batch.id);
    const completed = restoredKernel.dispatchBatch(principal, confirmed.batch.id);
    expect(completed.batch.status).toBe("succeeded");

    const finalKernel = createKernel(store);
    expect(finalKernel.getBatch(principal, confirmed.batch.id).batch.status).toBe("succeeded");
    expect(finalKernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 90 });
  });

  it("把进程中断前的运行任务恢复为计费待核对，保留预留且禁止自动重试", () => {
    const store = new MemoryRunKernelStateStore();
    const now = Date.parse("2026-09-27T19:00:00+08:00");
    const firstKernel = createKernel(store, { clock: () => now, maxConcurrentJobs: 1 });
    const confirmed = createConfirmed(firstKernel, request({
      expectedOutputs: 1,
      idempotencyKey: "crash-running",
      mockScenario: "slow",
    }));
    const running = firstKernel.dispatchBatch(principal, confirmed.batch.id);
    expect(running.jobs[0].status).toBe("running");

    const restoredKernel = createKernel(store, { clock: () => now, maxConcurrentJobs: 1 });
    const recovered = restoredKernel.getBatch(principal, confirmed.batch.id);
    expect(recovered.batch.status).toBe("billing_unknown");
    expect(recovered.jobs).toHaveLength(1);
    expect(recovered.jobs[0]).toMatchObject({
      status: "billing_unknown",
      failureCode: "recovered-after-restart",
    });
    expect(recovered.ledger.at(-1)).toMatchObject({ settlement: "unknown", reservedMinor: 40 });
    expect(recovered.audit.at(-1)).toMatchObject({
      actorId: "system-recovery",
      eventType: "billing-unknown",
      metadata: { jobId: recovered.jobs[0].id, reason: "process-restart" },
    });
    expect(restoredKernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0 });
    expect(() => restoredKernel.retryJob(principal, recovered.jobs[0].id, {
      expectedEstimatedCostMinor: 40,
      expectedCurrency: "CNY",
      mockScenario: "success",
    })).toThrowError(expect.objectContaining<Partial<RunKernelError>>({ code: "billing_state_unknown" }));
    expect(() => restoredKernel.cancelBatch(principal, confirmed.batch.id))
      .toThrowError(expect.objectContaining<Partial<RunKernelError>>({ code: "billing_state_unknown" }));
    expect(store.snapshot?.batches[0].aggregate.jobs).toHaveLength(1);
  });

  it("未启动租约跨重启保持独占，并只在到期后安全回队列", () => {
    const store = new MemoryRunKernelStateStore();
    let now = Date.parse("2026-09-27T19:30:00+08:00");
    const firstKernel = createKernel(store, { clock: () => now, leaseDurationMs: 1_000 });
    const confirmed = createConfirmed(firstKernel, request({
      expectedOutputs: 1,
      idempotencyKey: "leased-before-restart",
    }));
    const firstLease = firstKernel.claimBatch(principal, confirmed.batch.id, {
      workerId: "worker-before-restart",
      maxJobs: 1,
    }).leases[0];

    const restoredKernel = createKernel(store, { clock: () => now, leaseDurationMs: 1_000 });
    expect(restoredKernel.getBatch(principal, confirmed.batch.id).jobs[0]).toMatchObject({
      status: "leased",
      leaseId: firstLease.leaseId,
    });
    expect(restoredKernel.claimBatch(principal, confirmed.batch.id, {
      workerId: "worker-after-restart",
      maxJobs: 1,
    }).leases).toEqual([]);

    now += 1_001;
    const reclaimed = restoredKernel.claimBatch(principal, confirmed.batch.id, {
      workerId: "worker-after-restart",
      maxJobs: 1,
    });
    expect(reclaimed.leases).toHaveLength(1);
    expect(reclaimed.leases[0].leaseId).not.toBe(firstLease.leaseId);
    expect(reclaimed.aggregate.audit.map((event) => event.eventType)).toContain("job-lease-expired");
  });

  it("以原子文件快照保存状态，并在文件损坏时拒绝静默重置", () => {
    const directory = mkdtempSync(join(tmpdir(), "canvas-run-kernel-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "run-kernel.json");
    const store = new FileRunKernelStateStore(filePath);
    const empty: RunKernelSnapshot = {
      schemaVersion: 1,
      savedAt: "2026-09-27T11:00:00.000Z",
      budgets: [],
      batches: [],
    };
    store.save(empty);
    expect(store.load()).toEqual(empty);
    store.save({ ...empty, savedAt: "2026-09-27T11:01:00.000Z" });
    expect(store.load()?.savedAt).toBe("2026-09-27T11:01:00.000Z");

    writeFileSync(filePath, "not-json", "utf8");
    expect(() => store.load()).toThrow();
  });

  it("拒绝预算配置漂移或金额不守恒的持久化快照", () => {
    const store = new MemoryRunKernelStateStore();
    createConfirmed(createKernel(store), request({ expectedOutputs: 1 }));
    store.snapshot!.budgets[0].limitMinor = 999;
    expect(() => createKernel(store)).toThrow("任务内核快照与当前项目预算配置不兼容");

    store.snapshot!.budgets[0].limitMinor = 300;
    store.snapshot!.budgets[0].reservedMinor = 39;
    expect(() => createKernel(store)).toThrow("任务内核快照中的项目金额不守恒");
  });
});
