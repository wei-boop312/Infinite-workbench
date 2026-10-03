import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateRunBatchRequest, RunBatchAggregate, RunJobClaimResult, RunKernelSnapshot, ReviewBillingOverage } from "../packages/contracts/src/index";
import { RunKernelError, type RunKernelOptions } from "../apps/api/src/runKernel";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore, SqliteStateStoreError } from "../apps/api/src/sqliteRunKernelStore";

const directories: string[] = [];
const stores: SqliteRunKernelStateStore[] = [];
const children: ChildProcess[] = [];
const principal = { tenantId: "tenant-a", actorId: "owner" };
const options: RunKernelOptions = { authorizer: { authenticate: () => null, allows: () => true },
  budgets: [{ tenantId: "tenant-a", projectId: "project-a", currency: "CNY", limitMinor: 100 }],
  unitEstimateMinor: 40, unitActualMinor: 30, maxConcurrentJobs: 2 };
const request: CreateRunBatchRequest = { projectId: "project-a", tool: "product-retouch", constraintSnapshotId: "constraint-1", inputAssetIds: ["asset-1"],
  expectedOutputs: 2, maxCostMinor: 80, currency: "CNY", idempotencyKey: "action-1", mockScenario: "success" };
function setup(extra: Partial<RunKernelOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "canvas-sqlite-")); directories.push(directory);
  const path = join(directory, "state.sqlite");
  return { path, ...open(path, extra) };
}
function open(path: string, extra: Partial<RunKernelOptions> = {}, timeout = 1_000) {
  const store = new SqliteRunKernelStateStore(path, { busyTimeoutMs: timeout }); stores.push(store);
  return { store, kernel: new SqliteRunKernel({ ...options, ...extra, stateStore: store }) };
}
function confirm(kernel: SqliteRunKernel, id: string) {
  return kernel.confirmBatch(principal, id, { expectedEstimatedCostMinor: 80, expectedCurrency: "CNY" });
}
type ChildResult = { ok: boolean; result?: RunBatchAggregate | RunJobClaimResult; error?: string; exit?: number };
async function processCommand(path: string, command: Record<string, unknown>) {
  const child = fork(fileURLToPath(new URL("./fixtures/sqlite-run-process.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveResult!: (value: ChildResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<ChildResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Attach rejection handling even while another child's readiness is awaited.
  void result.catch(() => undefined);
  child.on("message", (message: ChildResult & { ready?: boolean }) => { if (message.ready) resolveReady(); else resolveResult(message); });
  child.on("error", (error) => { rejectReady(error); rejectResult(error); });
  child.on("exit", (code) => {
    if (code === 27) resolveResult({ ok: false, exit: code });
    else if (code !== 0) { const error = new Error(`子进程失败: ${errors}`); rejectReady(error); rejectResult(error); }
  });
  child.send({ path, ...command });
  await ready;
  return { start: () => child.send("go"), result, child };
}
async function race(path: string, commands: Record<string, unknown>[]) {
  const processes = await Promise.all(commands.map((command) => processCommand(path, command)));
  for (const child of processes) child.start();
  return Promise.all(processes.map((child) => child.result));
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null) continue;
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); });
  }
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("本机 SQLite 任务事务", () => {
  it("不同连接始终读取最新预算，重复确认和创建不重复入账", () => {
    const { path, kernel, store } = setup(); const other = open(path).kernel;
    const draft = kernel.createBatch(principal, request);
    const confirmed = confirm(other, draft.batch.id);
    const revision = store.revision();
    expect(confirm(kernel, draft.batch.id).jobs).toHaveLength(2);
    expect(store.revision()).toBe(revision);
    expect(kernel.createBatch(principal, request).batch.id).toBe(draft.batch.id);
    expect(kernel.getBudget(principal, "project-a").reservedMinor).toBe(80);
    other.dispatchBatch(principal, confirmed.batch.id);
    expect(kernel.getBudget(principal, "project-a")).toMatchObject({ spentMinor: 60, reservedMinor: 0 });
  });

  it("多个真实进程同时创建同一动作，只保存一个批次", async () => {
    const { path, kernel } = setup();
    const responses = await race(path, Array.from({ length: 4 }, () => ({ mode: "create", request })));
    expect(responses.every((item) => item.ok)).toBe(true);
    expect(new Set(responses.map((item) => (item.result as RunBatchAggregate).batch.id)).size).toBe(1);
    expect(kernel.listBatches(principal, "project-a")).toHaveLength(1);
    expect(kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
  });

  it("不同进程抢同一项目预算，不能超额冻结，拒绝审计不会覆盖成功者", async () => {
    const { path, kernel } = setup(); const a = kernel.createBatch(principal, request);
    const b = kernel.createBatch(principal, { ...request, idempotencyKey: "action-2" });
    const responses = await race(path, [a, b, a, b].map((batch) => ({ mode: "confirm", batchId: batch.batch.id })));
    expect(responses.filter((item) => item.ok)).toHaveLength(2);
    expect(responses.filter((item) => !item.ok).map((item) => item.error)).toEqual(["project_budget_exceeded", "project_budget_exceeded"]);
    expect(kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 80, availableMinor: 20, spentMinor: 0 });
    const list = kernel.listBatches(principal, "project-a");
    expect(list.flatMap((batch) => batch.jobs)).toHaveLength(2);
    expect(list.find((batch) => batch.jobs.length === 0)?.audit.filter((event) => event.eventType === "confirmation-rejected")).toHaveLength(2);
  });

  it("多个进程领取租约，每个输出只能有一个执行器，结算也不能重复", async () => {
    const { path, kernel } = setup(); const draft = kernel.createBatch(principal, request); confirm(kernel, draft.batch.id);
    const claims = await race(path, Array.from({ length: 4 }, (_, index) => ({ mode: "claim", batchId: draft.batch.id, workerId: `worker-${index}` })));
    expect(claims.every((item) => item.ok)).toBe(true);
    const leases = claims.flatMap((item) => (item.result as RunJobClaimResult).leases);
    expect(leases).toHaveLength(2);
    expect(new Set(leases.map((lease) => lease.jobId)).size).toBe(2);
    const lease = leases[0];
    const command = { mode: "execute", jobId: lease.jobId, leaseId: lease.leaseId, workerId: lease.workerId };
    const runs = await race(path, [command, command]);
    expect(runs.filter((item) => item.ok)).toHaveLength(1);
    expect(kernel.getBudget(principal, "project-a")).toMatchObject({ spentMinor: 30, reservedMinor: 40 });
    expect(kernel.getBatch(principal, draft.batch.id).ledger.filter((item) => item.jobId === lease.jobId && item.settlement === "settled")).toHaveLength(1);
  });

  it("共享数据库重载不会误判其他进程运行中任务；到租约期限才进入未知计费", () => {
    let now = Date.parse("2026-10-03T12:00:00Z");
    const timedOptions = { clock: () => now, leaseDurationMs: 1_000, jobTimeoutMs: 10_000 };
    const { path, kernel: timed } = setup(timedOptions);
    const draft = timed.createBatch(principal, { ...request, mockScenario: "slow" }); confirm(timed, draft.batch.id);
    const lease = timed.claimBatch(principal, draft.batch.id, { workerId: "worker", maxJobs: 1 }).leases[0];
    timed.executeLeasedJob(principal, lease.jobId, { workerId: "worker", leaseId: lease.leaseId });
    const peer = open(path, timedOptions).kernel;
    expect(peer.getBatch(principal, draft.batch.id).jobs[0].status).toBe("running");
    expect(peer.getBudget(principal, "project-a").reservedMinor).toBe(80);
    now += 1_001;
    expect(peer.getBatch(principal, draft.batch.id).jobs[0].status).toBe("billing_unknown");
    expect(() => peer.cancelBatch(principal, draft.batch.id)).toThrowError(expect.objectContaining({ code: "billing_state_unknown" }));
    // The original connection observes the same frozen reservation, not an old cache.
    expect(timed.getBudget(principal, "project-a").reservedMinor).toBe(80);
  });

  it("写入后模拟故障完整回滚，下一次同动作确认可以安全恢复", () => {
    const { path, kernel } = setup(); const draft = kernel.createBatch(principal, request);
    class FaultStore extends SqliteRunKernelStateStore {
      failing = false;
      override save(snapshot: RunKernelSnapshot) { super.save(snapshot); if (this.failing) throw new Error("simulated-disk-fault"); }
    }
    const store = new FaultStore(path); stores.push(store); const broken = new SqliteRunKernel({ ...options, stateStore: store });
    const revision = store.revision(); store.failing = true;
    expect(() => confirm(broken, draft.batch.id)).toThrowError(expect.objectContaining({ status: 503, code: "run_state_unavailable" }));
    expect(store.revision()).toBe(revision);
    expect(kernel.getBatch(principal, draft.batch.id).jobs).toHaveLength(0);
    expect(kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
    store.failing = false; confirm(broken, draft.batch.id);
    expect(kernel.getBudget(principal, "project-a").reservedMinor).toBe(80);
  });

  it("确认事务尚未提交时进程退出，不留下任务、预留或半份账本", async () => {
    const { path, kernel, store } = setup(); const draft = kernel.createBatch(principal, request); const before = store.load();
    const response = await race(path, [{ mode: "crash-confirm", batchId: draft.batch.id }]);
    expect(response[0].exit).toBe(27);
    expect(store.load()).toEqual(before);
    expect(kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
    expect(confirm(kernel, draft.batch.id).jobs).toHaveLength(2);
  });

  it("重放同一审批的真实进程不会重复结算或提高项目额度", async () => {
    const { path, kernel } = setup();
    const draft = kernel.createBatch(principal, { ...request, mockScenario: "billing-unknown" }); confirm(kernel, draft.batch.id);
    const unknown = kernel.dispatchBatch(principal, draft.batch.id); const jobId = unknown.jobs[0].id;
    const record = kernel.requestBillingOverage(principal, jobId, { requestId: "overage-1", expectedReservedMinor: 40, expectedCurrency: "CNY", expectedBatchMaxCostMinor: 80,
      actualCostMinor: 50, requestedBatchMaxCostMinor: 90, evidenceRef: "invoice", reason: "价格漂移" }).billingOverages[0];
    const review: ReviewBillingOverage = { reviewId: "review-1", decision: "approve", expectedReservedMinor: 40, expectedCurrency: "CNY", expectedActualCostMinor: 50,
      expectedBatchMaxCostMinor: 80, expectedRequestedBatchMaxCostMinor: 90, evidenceRef: "approval-proof", note: "费用核实" };
    const command = { mode: "review", jobId, overageId: record.id, review };
    const responses = await race(path, [command, command]);
    expect(responses.every((item) => item.ok)).toBe(true);
    expect(kernel.getBudget(principal, "project-a")).toMatchObject({ limitMinor: 100, spentMinor: 50, reservedMinor: 40, availableMinor: 10 });
    expect(kernel.getBatch(principal, draft.batch.id).ledger.filter((item) => item.jobId === jobId && item.settlement === "settled")).toHaveLength(1);
  });

  it("数据库锁冲突返回可重试错误，不修改原始快照", () => {
    const { path, kernel, store } = setup(); const draft = kernel.createBatch(principal, request);
    const peer = open(path, {}, 5).kernel; const before = store.load();
    store.transaction(() => {
      expect(() => confirm(peer, draft.batch.id)).toThrowError(expect.objectContaining({ status: 503, code: "run_state_busy" }));
    });
    expect(store.load()).toEqual(before);
    expect(confirm(peer, draft.batch.id).jobs).toHaveLength(2);
  });

  it("拒绝损坏摘要、初始化后行丢失、未来版本和预算漂移，不静默重置", () => {
    const { path, kernel, store } = setup(); kernel.createBatch(principal, request);
    expect(() => new SqliteRunKernel({ ...options, budgets: [{ ...options.budgets[0], limitMinor: 101 }], stateStore: store }))
      .toThrowError(expect.objectContaining({ code: "run_state_unavailable" }));
    const database = new DatabaseSync(path);
    try {
      database.prepare("UPDATE kernel_state SET sha256 = ? WHERE kind = 'runs'").run("0".repeat(64));
      expect(() => kernel.listBatches(principal, "project-a")).toThrowError(expect.objectContaining({ code: "run_state_unavailable" }));
      database.exec("DELETE FROM kernel_state WHERE kind = 'runs'");
      expect(() => store.load()).toThrow(SqliteStateStoreError);
      database.exec("PRAGMA user_version = 4");
      expect(() => new SqliteRunKernelStateStore(path)).toThrow(SqliteStateStoreError);
    } finally { database.close(); }
  });

  it("保存必须在事务中，嵌套注册失败会回滚目录与预算，不能异步跨锁", () => {
    const { store, kernel } = setup(); const before = store.load();
    expect(() => store.save(before!)).toThrow(/事务/);
    expect(() => store.transaction(() => {
      store.saveCatalog({ schemaVersion: 1, projects: [] });
      kernel.registerLocalProject({ tenantId: "tenant-a", projectId: "new-project", currency: "CNY", limitMinor: 100 });
      throw new Error("registration-failed");
    })).toThrow(/registration-failed/);
    expect(store.loadCatalog()).toBeNull();
    expect(store.load()).toEqual(before);
    expect(() => store.transaction(() => Promise.resolve())).toThrow(/不能包含异步/);
  });

  it("共享数据库禁止服务间改变定价、租约或并发策略绕过闸门", () => {
    const { store, kernel } = setup(); const before = store.load();
    for (const drift of [{ unitEstimateMinor: 50 }, { maxConcurrentJobs: 4 }, { leaseDurationMs: 60_000 },
      { providerLimits: [{ adapterId: "mock-product-retouch-v1", maxConcurrentJobs: 5 }] }]) {
      expect(() => new SqliteRunKernel({ ...options, ...drift, stateStore: store }))
        .toThrowError(expect.objectContaining({ code: "run_state_unavailable" }));
    }
    expect(store.load()).toEqual(before);
    expect(kernel.getBudget(principal, "project-a").availableMinor).toBe(100);
  });

  it("跨项目的真实进程共用供应商并发槽位，不按服务或批次重新计数", async () => {
    const providerLimits = [{ adapterId: "mock-product-retouch-v1", maxConcurrentJobs: 1, maxStartsPerWindow: 10, windowMs: 60_000 }];
    const { path, kernel } = setup({ providerLimits });
    kernel.registerLocalProject({ tenantId: "tenant-a", projectId: "project-b", currency: "CNY", limitMinor: 100 });
    const a = kernel.createBatch(principal, request); confirm(kernel, a.batch.id);
    const b = kernel.createBatch(principal, { ...request, projectId: "project-b" }); confirm(kernel, b.batch.id);
    const responses = await race(path, [a, b].map((batch, index) => ({ mode: "claim", batchId: batch.batch.id, workerId: `worker-${index}`, providerLimits })));
    expect(responses.every((item) => item.ok)).toBe(true);
    expect(responses.flatMap((item) => (item.result as RunJobClaimResult).leases)).toHaveLength(1);
    const blocked = responses.find((item) => (item.result as RunJobClaimResult).leases.length === 0)?.result as RunJobClaimResult;
    expect(blocked.throttledBy).toBe("provider-concurrency");
    expect(kernel.getBudget(principal, "project-a").reservedMinor).toBe(80);
    expect(kernel.getBudget(principal, "project-b").reservedMinor).toBe(80);
  });
});
