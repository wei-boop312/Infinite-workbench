import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  ProjectBudgetSnapshotSchema,
  RunBatchAggregateSchema,
  RunKernelSnapshotSchema,
  type ConfirmRunBatchRequest,
  type CostLedger,
  type CreateRunBatchRequest,
  type ProjectBudgetSnapshot,
  type RetryRunJobRequest,
  type RunAuditEvent,
  type RunBatch,
  type RunBatchAggregate,
  type RunJob,
  type RunKernelSnapshot,
} from "@canvas/contracts";
import type { RunKernelStateStore } from "./runKernelStore";

export type RunPrincipal = {
  tenantId: string;
  actorId: string;
};

export type RunPermission = "run:read" | "run:create" | "run:confirm" | "run:cancel" | "run:execute" | "run:retry";

export type StaticRunAccess = RunPrincipal & {
  bearerToken: string;
  projects: Record<string, readonly RunPermission[]>;
};

export interface RunAuthorizer {
  authenticate(request: IncomingMessage): RunPrincipal | null;
  allows(principal: RunPrincipal, projectId: string, permission: RunPermission): boolean;
}

export class StaticRunAuthorizer implements RunAuthorizer {
  private readonly sessions = new Map<string, StaticRunAccess>();

  constructor(entries: readonly StaticRunAccess[]) {
    for (const entry of entries) {
      if (!entry.bearerToken || this.sessions.has(entry.bearerToken)) throw new Error("任务内核测试令牌无效或重复");
      this.sessions.set(entry.bearerToken, entry);
    }
  }

  authenticate(request: IncomingMessage): RunPrincipal | null {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return null;
    const access = this.sessions.get(authorization.slice("Bearer ".length));
    return access ? { tenantId: access.tenantId, actorId: access.actorId } : null;
  }

  allows(principal: RunPrincipal, projectId: string, permission: RunPermission): boolean {
    return [...this.sessions.values()].some((access) => access.tenantId === principal.tenantId
      && access.actorId === principal.actorId
      && (access.projects[projectId]?.includes(permission) ?? false));
  }
}

export class RunKernelError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ProjectBudgetConfig = {
  tenantId: string;
  projectId: string;
  currency: string;
  limitMinor: number;
};

type BudgetState = ProjectBudgetConfig & {
  reservedMinor: number;
  spentMinor: number;
};

type StoredBatch = {
  aggregate: RunBatchAggregate;
  requestFingerprint: string;
  reservedMinor: number;
  actualMinor: number;
  jobReservations: Map<string, number>;
  jobScenarios: Map<string, RunBatch["mockScenario"]>;
};

export type RunKernelOptions = {
  authorizer: RunAuthorizer;
  budgets: readonly ProjectBudgetConfig[];
  stateStore?: RunKernelStateStore;
  unitEstimateMinor?: number;
  unitActualMinor?: number;
  maxConcurrentJobs?: number;
  jobTimeoutMs?: number;
  clock?: () => number;
};

export interface RunKernelPort {
  authenticate(request: IncomingMessage): RunPrincipal | null;
  createBatch(principal: RunPrincipal, request: CreateRunBatchRequest): RunBatchAggregate;
  getBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate;
  confirmBatch(principal: RunPrincipal, batchId: string, confirmation: ConfirmRunBatchRequest): RunBatchAggregate;
  dispatchBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate;
  reconcileBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate;
  retryJob(principal: RunPrincipal, jobId: string, request: RetryRunJobRequest): RunBatchAggregate;
  cancelBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate;
  getBudget(principal: RunPrincipal, projectId: string): ProjectBudgetSnapshot;
}

function scopedProjectKey(tenantId: string, projectId: string): string {
  return `${tenantId}\u0000${projectId}`;
}

function requestFingerprint(request: CreateRunBatchRequest): string {
  const canonicalRequest: CreateRunBatchRequest = {
    projectId: request.projectId,
    constraintSnapshotId: request.constraintSnapshotId,
    tool: request.tool,
    inputAssetIds: [...request.inputAssetIds],
    expectedOutputs: request.expectedOutputs,
    maxCostMinor: request.maxCostMinor,
    currency: request.currency,
    idempotencyKey: request.idempotencyKey,
    mockScenario: request.mockScenario,
  };
  return createHash("sha256").update(JSON.stringify(canonicalRequest)).digest("hex");
}

function idempotencyIndexKey(principal: RunPrincipal, request: CreateRunBatchRequest): string {
  return `${scopedProjectKey(principal.tenantId, request.projectId)}\u0000${request.idempotencyKey}`;
}

export class InMemoryRunKernel implements RunKernelPort {
  private readonly clock: () => number;
  private readonly unitEstimateMinor: number;
  private readonly unitActualMinor: number;
  private readonly maxConcurrentJobs: number;
  private readonly jobTimeoutMs: number;
  private readonly budgets = new Map<string, BudgetState>();
  private readonly batches = new Map<string, StoredBatch>();
  private readonly idempotencyIndex = new Map<string, string>();

  constructor(private readonly options: RunKernelOptions) {
    this.clock = options.clock ?? Date.now;
    this.unitEstimateMinor = options.unitEstimateMinor ?? 25;
    this.unitActualMinor = options.unitActualMinor ?? Math.max(0, this.unitEstimateMinor - 5);
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 2;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.unitEstimateMinor) || this.unitEstimateMinor < 0) throw new Error("假执行器单位估价必须是非负整数");
    if (!Number.isSafeInteger(this.unitActualMinor) || this.unitActualMinor < 0 || this.unitActualMinor > this.unitEstimateMinor) throw new Error("假执行器实际单价必须位于 0 和估价之间");
    if (!Number.isSafeInteger(this.maxConcurrentJobs) || this.maxConcurrentJobs < 1) throw new Error("假调度器并发数必须是正整数");
    if (!Number.isSafeInteger(this.jobTimeoutMs) || this.jobTimeoutMs < 1_000) throw new Error("假任务超时至少为 1 秒");
    for (const budget of options.budgets) {
      if (!/^[A-Z]{3}$/.test(budget.currency) || !Number.isSafeInteger(budget.limitMinor) || budget.limitMinor < 0) {
        throw new Error("项目预算配置无效");
      }
      const key = scopedProjectKey(budget.tenantId, budget.projectId);
      if (this.budgets.has(key)) throw new Error("项目预算配置重复");
      this.budgets.set(key, { ...budget, reservedMinor: 0, spentMinor: 0 });
    }
    this.restore();
  }

  authenticate(request: IncomingMessage): RunPrincipal | null {
    return this.options.authorizer.authenticate(request);
  }

  createBatch(principal: RunPrincipal, request: CreateRunBatchRequest): RunBatchAggregate {
    this.assertAllowed(principal, request.projectId, "run:create");
    const budget = this.requireBudget(principal.tenantId, request.projectId);
    if (budget.currency !== request.currency) throw new RunKernelError(422, "budget_currency_mismatch", "批次币种与项目预算不一致");

    const indexKey = idempotencyIndexKey(principal, request);
    const fingerprint = requestFingerprint(request);
    const existingId = this.idempotencyIndex.get(indexKey);
    if (existingId) {
      const existing = this.batches.get(existingId)!;
      if (existing.requestFingerprint !== fingerprint) {
        throw new RunKernelError(409, "run_idempotency_conflict", "相同幂等键对应了不同批次参数");
      }
      return this.copy(existing.aggregate);
    }

    const now = new Date(this.clock()).toISOString();
    const batchId = `batch-${randomUUID()}`;
    const estimatedCostMinor = request.expectedOutputs * this.unitEstimateMinor;
    const batch: RunBatch = {
      id: batchId,
      tenantId: principal.tenantId,
      projectId: request.projectId,
      constraintSnapshotId: request.constraintSnapshotId,
      tool: request.tool,
      adapterId: "mock-product-retouch-v1",
      inputAssetIds: [...request.inputAssetIds],
      idempotencyKey: request.idempotencyKey,
      mockScenario: request.mockScenario,
      status: "awaiting_confirmation",
      expectedOutputs: request.expectedOutputs,
      estimatedCostMinor,
      maxCostMinor: request.maxCostMinor,
      currency: request.currency,
      createdAt: now,
    };
    const ledger: CostLedger = {
      id: `ledger-${randomUUID()}`,
      tenantId: principal.tenantId,
      projectId: request.projectId,
      batchId,
      currency: request.currency,
      estimatedMinor: estimatedCostMinor,
      reservedMinor: 0,
      settlement: "estimated",
      createdAt: now,
    };
    const aggregate: RunBatchAggregate = {
      batch,
      jobs: [],
      ledger: [ledger],
      audit: [this.audit(batch, principal.actorId, "batch-created", {
        expectedOutputs: String(request.expectedOutputs),
        estimatedCostMinor: String(estimatedCostMinor),
      })],
    };
    const parsed = RunBatchAggregateSchema.parse(aggregate);
    this.batches.set(batchId, {
      aggregate: parsed,
      requestFingerprint: fingerprint,
      reservedMinor: 0,
      actualMinor: 0,
      jobReservations: new Map(),
      jobScenarios: new Map(),
    });
    this.idempotencyIndex.set(indexKey, batchId);
    this.persist();
    return this.copy(parsed);
  }

  getBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate {
    const stored = this.requireBatch(principal, batchId);
    this.assertAllowed(principal, stored.aggregate.batch.projectId, "run:read");
    return this.copy(stored.aggregate);
  }

  confirmBatch(principal: RunPrincipal, batchId: string, confirmation: ConfirmRunBatchRequest): RunBatchAggregate {
    const stored = this.requireBatch(principal, batchId);
    const aggregate = stored.aggregate;
    const batch = aggregate.batch;
    this.assertAllowed(principal, batch.projectId, "run:confirm");

    if (batch.status === "queued") return this.copy(aggregate);
    if (batch.status !== "awaiting_confirmation") {
      throw new RunKernelError(409, "run_batch_not_confirmable", "当前批次状态不能确认");
    }
    if (confirmation.expectedEstimatedCostMinor !== batch.estimatedCostMinor || confirmation.expectedCurrency !== batch.currency) {
      aggregate.audit.push(this.audit(batch, principal.actorId, "confirmation-rejected", { reason: "snapshot-mismatch" }));
      this.persist();
      throw new RunKernelError(409, "confirmation_snapshot_mismatch", "确认的成本快照已失效");
    }
    if (batch.estimatedCostMinor > batch.maxCostMinor) {
      aggregate.audit.push(this.audit(batch, principal.actorId, "confirmation-rejected", { reason: "batch-cost-ceiling" }));
      this.persist();
      throw new RunKernelError(422, "batch_cost_ceiling_exceeded", "预计成本超过本批次上限");
    }

    const budget = this.requireBudget(batch.tenantId, batch.projectId);
    const availableMinor = budget.limitMinor - budget.reservedMinor - budget.spentMinor;
    if (availableMinor < batch.estimatedCostMinor) {
      aggregate.audit.push(this.audit(batch, principal.actorId, "confirmation-rejected", { reason: "project-budget" }));
      this.persist();
      throw new RunKernelError(422, "project_budget_exceeded", "项目可用预算不足");
    }

    budget.reservedMinor += batch.estimatedCostMinor;
    const confirmedAt = new Date(this.clock()).toISOString();
    aggregate.batch = {
      ...batch,
      status: "queued",
      confirmedBy: principal.actorId,
      confirmedAt,
    };
    aggregate.ledger.push({
      id: `ledger-${randomUUID()}`,
      tenantId: batch.tenantId,
      projectId: batch.projectId,
      batchId: batch.id,
      currency: batch.currency,
      estimatedMinor: batch.estimatedCostMinor,
      reservedMinor: batch.estimatedCostMinor,
      settlement: "reserved",
      createdAt: confirmedAt,
    });
    aggregate.jobs = Array.from({ length: batch.expectedOutputs }, (_, index): RunJob => ({
      id: `job-${randomUUID()}`,
      batchId: batch.id,
      outputIndex: index,
      attempt: 1,
      executorKind: "mock",
      adapterId: batch.adapterId,
      idempotencyKey: `job-key-${createHash("sha256").update(`${batch.tenantId}:${batch.projectId}:${batch.idempotencyKey}:${index}`).digest("hex")}`,
      status: "queued",
      inputAssetIds: [...batch.inputAssetIds],
      outputAssetIds: [],
      estimatedCostMinor: this.unitEstimateMinor,
      createdAt: confirmedAt,
    }));
    stored.reservedMinor = batch.estimatedCostMinor;
    for (const job of aggregate.jobs) {
      stored.jobReservations.set(job.id, this.unitEstimateMinor);
      stored.jobScenarios.set(job.id, batch.mockScenario);
    }
    aggregate.audit.push(
      this.audit(batch, principal.actorId, "batch-confirmed", { estimatedCostMinor: String(batch.estimatedCostMinor) }),
      this.audit(batch, principal.actorId, "budget-reserved", { reservedMinor: String(batch.estimatedCostMinor) }),
      this.audit(batch, principal.actorId, "jobs-created", { count: String(batch.expectedOutputs) }),
    );
    stored.aggregate = RunBatchAggregateSchema.parse(aggregate);
    this.persist();
    return this.copy(stored.aggregate);
  }

  dispatchBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate {
    const stored = this.requireBatch(principal, batchId);
    const aggregate = stored.aggregate;
    this.assertAllowed(principal, aggregate.batch.projectId, "run:execute");
    if (aggregate.batch.status === "billing_unknown") {
      throw new RunKernelError(409, "billing_state_unknown", "计费状态未知时禁止继续调度");
    }
    const latest = this.latestJobs(aggregate.jobs);
    const runningCount = latest.filter((job) => job.status === "running").length;
    const queued = latest.filter((job) => job.status === "queued").slice(0, Math.max(0, this.maxConcurrentJobs - runningCount));
    if (!queued.length) return this.copy(aggregate);

    aggregate.batch = { ...aggregate.batch, status: "running" };
    aggregate.audit.push(this.audit(aggregate.batch, principal.actorId, "batch-dispatched", { count: String(queued.length) }));
    for (const queuedJob of queued) {
      const startedAt = new Date(this.clock()).toISOString();
      const running: RunJob = {
        ...queuedJob,
        status: "running",
        startedAt,
        providerRequestId: `mock-request-${randomUUID()}`,
      };
      this.replaceJob(aggregate, running);
      aggregate.audit.push(this.audit(aggregate.batch, principal.actorId, "job-started", { jobId: running.id }));
      const scenario = stored.jobScenarios.get(running.id) ?? aggregate.batch.mockScenario;
      if (scenario === "slow") continue;
      if (scenario === "billing-unknown") {
        this.finishJob(stored, running, "billing-unknown", principal.actorId);
      } else if (scenario === "failed" || (scenario === "partial-failure" && running.outputIndex % 2 === 1)) {
        this.finishJob(stored, running, "failed", principal.actorId);
      } else {
        this.finishJob(stored, running, "succeeded", principal.actorId);
      }
    }
    this.refreshBatchStatus(stored);
    stored.aggregate = RunBatchAggregateSchema.parse(stored.aggregate);
    this.persist();
    return this.copy(stored.aggregate);
  }

  reconcileBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate {
    const stored = this.requireBatch(principal, batchId);
    this.assertAllowed(principal, stored.aggregate.batch.projectId, "run:execute");
    const now = this.clock();
    for (const job of this.latestJobs(stored.aggregate.jobs)) {
      if (job.status !== "running" || !job.startedAt) continue;
      if (now - Date.parse(job.startedAt) >= this.jobTimeoutMs) {
        this.finishJob(stored, job, "timed-out", principal.actorId);
      }
    }
    this.refreshBatchStatus(stored);
    stored.aggregate = RunBatchAggregateSchema.parse(stored.aggregate);
    this.persist();
    return this.copy(stored.aggregate);
  }

  retryJob(principal: RunPrincipal, jobId: string, request: RetryRunJobRequest): RunBatchAggregate {
    const located = this.findJob(principal, jobId);
    const { stored, job } = located;
    const batch = stored.aggregate.batch;
    this.assertAllowed(principal, batch.projectId, "run:retry");
    if (job.status === "billing_unknown") {
      throw new RunKernelError(409, "billing_state_unknown", "计费状态未知时禁止重试，以免重复扣费");
    }
    if (!["failed", "timed_out"].includes(job.status)) {
      throw new RunKernelError(409, "run_job_not_retryable", "当前任务状态不能重试");
    }
    const latest = this.latestJobs(stored.aggregate.jobs).find((candidate) => candidate.outputIndex === job.outputIndex);
    if (!latest || latest.id !== job.id) throw new RunKernelError(409, "run_job_superseded", "该任务已有后续重试");
    if (request.expectedEstimatedCostMinor !== this.unitEstimateMinor || request.expectedCurrency !== batch.currency) {
      throw new RunKernelError(409, "retry_cost_snapshot_mismatch", "重试成本快照已失效");
    }
    if (stored.actualMinor + stored.reservedMinor + this.unitEstimateMinor > batch.maxCostMinor) {
      throw new RunKernelError(422, "batch_cost_ceiling_exceeded", "重试会超过批次成本上限");
    }
    const budget = this.requireBudget(batch.tenantId, batch.projectId);
    const availableMinor = budget.limitMinor - budget.reservedMinor - budget.spentMinor;
    if (availableMinor < this.unitEstimateMinor) throw new RunKernelError(422, "project_budget_exceeded", "项目可用预算不足");

    budget.reservedMinor += this.unitEstimateMinor;
    stored.reservedMinor += this.unitEstimateMinor;
    const createdAt = new Date(this.clock()).toISOString();
    const retry: RunJob = {
      id: `job-${randomUUID()}`,
      batchId: batch.id,
      outputIndex: job.outputIndex,
      attempt: job.attempt + 1,
      executorKind: "mock",
      adapterId: batch.adapterId,
      idempotencyKey: `retry-key-${createHash("sha256").update(`${job.id}:${job.attempt + 1}`).digest("hex")}`,
      status: "queued",
      retryOf: job.id,
      inputAssetIds: [...job.inputAssetIds],
      outputAssetIds: [],
      estimatedCostMinor: this.unitEstimateMinor,
      createdAt,
    };
    stored.aggregate.jobs.push(retry);
    stored.jobReservations.set(retry.id, this.unitEstimateMinor);
    stored.jobScenarios.set(retry.id, request.mockScenario);
    stored.aggregate.batch = { ...batch, status: "queued" };
    stored.aggregate.ledger.push({
      id: `ledger-${randomUUID()}`,
      tenantId: batch.tenantId,
      projectId: batch.projectId,
      batchId: batch.id,
      jobId: retry.id,
      currency: batch.currency,
      estimatedMinor: this.unitEstimateMinor,
      reservedMinor: this.unitEstimateMinor,
      settlement: "reserved",
      createdAt,
    });
    stored.aggregate.audit.push(
      this.audit(batch, principal.actorId, "budget-reserved", { jobId: retry.id, reservedMinor: String(this.unitEstimateMinor) }),
      this.audit(batch, principal.actorId, "job-retry-created", { jobId: retry.id, retryOf: job.id }),
    );
    stored.aggregate = RunBatchAggregateSchema.parse(stored.aggregate);
    this.persist();
    return this.copy(stored.aggregate);
  }

  cancelBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate {
    const stored = this.requireBatch(principal, batchId);
    const aggregate = stored.aggregate;
    const batch = aggregate.batch;
    this.assertAllowed(principal, batch.projectId, "run:cancel");
    if (batch.status === "cancelled") return this.copy(aggregate);
    if (batch.status === "billing_unknown") {
      throw new RunKernelError(409, "billing_state_unknown", "计费状态未知时不能释放预算或取消批次");
    }
    if (!["awaiting_confirmation", "queued", "running"].includes(batch.status)) {
      throw new RunKernelError(409, "run_batch_not_cancellable", "当前批次状态不能取消");
    }

    const now = new Date(this.clock()).toISOString();
    const releasable = [...stored.jobReservations.values()].reduce((total, amount) => total + amount, 0);
    if (releasable > 0) {
      const budget = this.requireBudget(batch.tenantId, batch.projectId);
      budget.reservedMinor = Math.max(0, budget.reservedMinor - releasable);
      stored.reservedMinor = Math.max(0, stored.reservedMinor - releasable);
      stored.jobReservations.clear();
      aggregate.audit.push(this.audit(batch, principal.actorId, "budget-released", {
        releasedMinor: String(releasable),
      }));
      aggregate.ledger.push({
        id: `ledger-${randomUUID()}`,
        tenantId: batch.tenantId,
        projectId: batch.projectId,
        batchId: batch.id,
        currency: batch.currency,
        estimatedMinor: releasable,
        reservedMinor: 0,
        actualMinor: 0,
        settlement: "released",
        createdAt: now,
      });
    }
    aggregate.batch = { ...batch, status: "cancelled" };
    aggregate.jobs = aggregate.jobs.map((job) => ["queued", "running"].includes(job.status)
      ? { ...job, status: "cancelled", finishedAt: now }
      : job);
    aggregate.audit.push(this.audit(batch, principal.actorId, "batch-cancelled", { previousStatus: batch.status }));
    stored.aggregate = RunBatchAggregateSchema.parse(aggregate);
    this.persist();
    return this.copy(stored.aggregate);
  }

  getBudget(principal: RunPrincipal, projectId: string): ProjectBudgetSnapshot {
    this.assertAllowed(principal, projectId, "run:read");
    const budget = this.requireBudget(principal.tenantId, projectId);
    return ProjectBudgetSnapshotSchema.parse({
      tenantId: budget.tenantId,
      projectId: budget.projectId,
      currency: budget.currency,
      limitMinor: budget.limitMinor,
      reservedMinor: budget.reservedMinor,
      spentMinor: budget.spentMinor,
      availableMinor: budget.limitMinor - budget.reservedMinor - budget.spentMinor,
    });
  }

  private restore(): void {
    const loaded = this.options.stateStore?.load();
    if (!loaded) return;
    const snapshot = RunKernelSnapshotSchema.parse(loaded);
    const restoredBudgets = new Map<string, BudgetState>();
    for (const budget of snapshot.budgets) {
      const key = scopedProjectKey(budget.tenantId, budget.projectId);
      const configured = this.budgets.get(key);
      if (!configured || configured.currency !== budget.currency || configured.limitMinor !== budget.limitMinor) {
        throw new Error("任务内核快照与当前项目预算配置不兼容");
      }
      if (restoredBudgets.has(key) || budget.reservedMinor + budget.spentMinor > budget.limitMinor) {
        throw new Error("任务内核快照中的项目预算状态无效");
      }
      restoredBudgets.set(key, { ...budget });
    }
    if (restoredBudgets.size !== this.budgets.size) {
      throw new Error("任务内核快照缺少当前配置的项目预算");
    }

    const restoredBatches = new Map<string, StoredBatch>();
    const restoredIndex = new Map<string, string>();
    for (const serialized of snapshot.batches) {
      const aggregate = RunBatchAggregateSchema.parse(serialized.aggregate);
      const batch = aggregate.batch;
      if (restoredBatches.has(batch.id)) throw new Error("任务内核快照包含重复批次");
      const stored: StoredBatch = {
        aggregate,
        requestFingerprint: serialized.requestFingerprint,
        reservedMinor: serialized.reservedMinor,
        actualMinor: serialized.actualMinor,
        jobReservations: new Map(serialized.jobReservations),
        jobScenarios: new Map(serialized.jobScenarios),
      };
      if (stored.jobReservations.size !== serialized.jobReservations.length
        || stored.jobScenarios.size !== serialized.jobScenarios.length) {
        throw new Error("任务内核快照包含重复任务状态");
      }
      const indexKey = `${scopedProjectKey(batch.tenantId, batch.projectId)}\u0000${batch.idempotencyKey}`;
      if (restoredIndex.has(indexKey)) throw new Error("任务内核快照包含重复幂等键");
      restoredBatches.set(batch.id, stored);
      restoredIndex.set(indexKey, batch.id);
    }

    this.budgets.clear();
    this.batches.clear();
    this.idempotencyIndex.clear();
    for (const [key, budget] of restoredBudgets) this.budgets.set(key, budget);
    for (const [key, stored] of restoredBatches) this.batches.set(key, stored);
    for (const [key, batchId] of restoredIndex) this.idempotencyIndex.set(key, batchId);
    this.assertStateConsistent();

    let recoveredRunningJobs = false;
    for (const stored of this.batches.values()) {
      const batch = stored.aggregate.batch;
      for (const job of stored.aggregate.jobs.filter((candidate) => candidate.status === "running")) {
        const recoveredAt = new Date(this.clock()).toISOString();
        const reservation = stored.jobReservations.get(job.id) ?? 0;
        this.replaceJob(stored.aggregate, {
          ...job,
          status: "billing_unknown",
          failureCode: "recovered-after-restart",
          finishedAt: recoveredAt,
        });
        stored.aggregate.ledger.push({
          id: `ledger-${randomUUID()}`,
          tenantId: batch.tenantId,
          projectId: batch.projectId,
          batchId: batch.id,
          jobId: job.id,
          currency: batch.currency,
          estimatedMinor: job.estimatedCostMinor,
          reservedMinor: reservation,
          settlement: "unknown",
          createdAt: recoveredAt,
        });
        stored.aggregate.audit.push(this.audit(batch, "system-recovery", "billing-unknown", {
          jobId: job.id,
          reason: "process-restart",
        }));
        recoveredRunningJobs = true;
      }
      this.refreshBatchStatus(stored);
      stored.aggregate = RunBatchAggregateSchema.parse(stored.aggregate);
    }
    this.assertStateConsistent();
    if (recoveredRunningJobs) this.persist();
  }

  private persist(): void {
    if (!this.options.stateStore) return;
    const snapshot: RunKernelSnapshot = {
      schemaVersion: 1,
      savedAt: new Date(this.clock()).toISOString(),
      budgets: [...this.budgets.values()].map((budget) => ({ ...budget })),
      batches: [...this.batches.values()].map((stored) => ({
        aggregate: this.copy(stored.aggregate),
        requestFingerprint: stored.requestFingerprint,
        reservedMinor: stored.reservedMinor,
        actualMinor: stored.actualMinor,
        jobReservations: [...stored.jobReservations.entries()],
        jobScenarios: [...stored.jobScenarios.entries()],
      })),
    };
    this.options.stateStore.save(RunKernelSnapshotSchema.parse(snapshot));
  }

  private assertStateConsistent(): void {
    const reservedByProject = new Map<string, number>();
    const spentByProject = new Map<string, number>();
    const globalJobIds = new Set<string>();
    for (const stored of this.batches.values()) {
      const { batch, jobs } = stored.aggregate;
      const budgetKey = scopedProjectKey(batch.tenantId, batch.projectId);
      const budget = this.budgets.get(budgetKey);
      if (!budget || budget.currency !== batch.currency) throw new Error("任务内核快照中的批次预算归属无效");
      const jobsById = new Map(jobs.map((job) => [job.id, job]));
      if (jobsById.size !== jobs.length) throw new Error("任务内核快照中的任务编号重复");
      for (const job of jobs) {
        if (globalJobIds.has(job.id) || job.batchId !== batch.id) throw new Error("任务内核快照中的任务归属无效");
        globalJobIds.add(job.id);
        if (!stored.jobScenarios.has(job.id)) throw new Error("任务内核快照缺少任务执行场景");
        const shouldReserve = ["queued", "running", "billing_unknown"].includes(job.status);
        if (shouldReserve !== stored.jobReservations.has(job.id)) {
          throw new Error("任务内核快照中的任务预留状态无效");
        }
      }
      for (const jobId of stored.jobReservations.keys()) {
        if (!jobsById.has(jobId)) throw new Error("任务内核快照包含孤立预留记录");
      }
      for (const jobId of stored.jobScenarios.keys()) {
        if (!jobsById.has(jobId)) throw new Error("任务内核快照包含孤立执行场景");
      }
      const reservedMinor = [...stored.jobReservations.values()].reduce((total, amount) => total + amount, 0);
      const actualMinor = jobs.reduce((total, job) => total + (job.actualCostMinor ?? 0), 0);
      if (reservedMinor !== stored.reservedMinor || actualMinor !== stored.actualMinor) {
        throw new Error("任务内核快照中的批次金额不守恒");
      }
      if (stored.reservedMinor + stored.actualMinor > batch.maxCostMinor) {
        throw new Error("任务内核快照中的批次金额超过成本上限");
      }
      reservedByProject.set(budgetKey, (reservedByProject.get(budgetKey) ?? 0) + stored.reservedMinor);
      spentByProject.set(budgetKey, (spentByProject.get(budgetKey) ?? 0) + stored.actualMinor);
    }
    for (const [key, budget] of this.budgets) {
      if (budget.reservedMinor !== (reservedByProject.get(key) ?? 0)
        || budget.spentMinor !== (spentByProject.get(key) ?? 0)) {
        throw new Error("任务内核快照中的项目金额不守恒");
      }
    }
  }

  private finishJob(
    stored: StoredBatch,
    job: RunJob,
    outcome: "succeeded" | "failed" | "timed-out" | "billing-unknown",
    actorId: string,
  ): void {
    const batch = stored.aggregate.batch;
    const finishedAt = new Date(this.clock()).toISOString();
    if (outcome === "billing-unknown") {
      const reservation = stored.jobReservations.get(job.id) ?? 0;
      this.replaceJob(stored.aggregate, { ...job, status: "billing_unknown", finishedAt });
      stored.aggregate.ledger.push({
        id: `ledger-${randomUUID()}`,
        tenantId: batch.tenantId,
        projectId: batch.projectId,
        batchId: batch.id,
        jobId: job.id,
        currency: batch.currency,
        estimatedMinor: job.estimatedCostMinor,
        reservedMinor: reservation,
        settlement: "unknown",
        createdAt: finishedAt,
      });
      stored.aggregate.audit.push(this.audit(batch, actorId, "billing-unknown", { jobId: job.id }));
      return;
    }

    if (outcome === "succeeded") {
      const completed: RunJob = {
        ...job,
        status: "succeeded",
        outputAssetIds: [`mock-output-${batch.id}-${job.outputIndex}-attempt-${job.attempt}`],
        actualCostMinor: this.unitActualMinor,
        finishedAt,
      };
      this.replaceJob(stored.aggregate, completed);
      this.settleReservation(stored, completed, this.unitActualMinor, "settled", actorId);
      stored.aggregate.audit.push(this.audit(batch, actorId, "job-succeeded", { jobId: job.id }));
      return;
    }

    const timedOut = outcome === "timed-out";
    const failed: RunJob = {
      ...job,
      status: timedOut ? "timed_out" : "failed",
      actualCostMinor: 0,
      failureCode: timedOut ? "mock-timeout" : "mock-failure",
      finishedAt,
    };
    this.replaceJob(stored.aggregate, failed);
    this.settleReservation(stored, failed, 0, "released", actorId);
    stored.aggregate.audit.push(this.audit(batch, actorId, timedOut ? "job-timed-out" : "job-failed", { jobId: job.id }));
  }

  private settleReservation(
    stored: StoredBatch,
    job: RunJob,
    actualMinor: number,
    settlement: "settled" | "released",
    actorId: string,
  ): void {
    const batch = stored.aggregate.batch;
    const reservedMinor = stored.jobReservations.get(job.id) ?? 0;
    const budget = this.requireBudget(batch.tenantId, batch.projectId);
    budget.reservedMinor = Math.max(0, budget.reservedMinor - reservedMinor);
    stored.reservedMinor = Math.max(0, stored.reservedMinor - reservedMinor);
    stored.jobReservations.delete(job.id);
    if (actualMinor > 0) {
      budget.spentMinor += actualMinor;
      stored.actualMinor += actualMinor;
    }
    stored.aggregate.ledger.push({
      id: `ledger-${randomUUID()}`,
      tenantId: batch.tenantId,
      projectId: batch.projectId,
      batchId: batch.id,
      jobId: job.id,
      currency: batch.currency,
      estimatedMinor: job.estimatedCostMinor,
      reservedMinor: 0,
      actualMinor,
      settlement,
      createdAt: new Date(this.clock()).toISOString(),
    });
    stored.aggregate.audit.push(this.audit(batch, actorId, "cost-settled", {
      jobId: job.id,
      actualMinor: String(actualMinor),
      releasedMinor: String(Math.max(0, reservedMinor - actualMinor)),
    }));
  }

  private refreshBatchStatus(stored: StoredBatch): void {
    if (stored.aggregate.batch.status === "cancelled") return;
    const jobs = this.latestJobs(stored.aggregate.jobs);
    let status: RunBatch["status"];
    if (jobs.some((job) => job.status === "billing_unknown")) status = "billing_unknown";
    else if (jobs.some((job) => job.status === "running")) status = "running";
    else if (jobs.some((job) => job.status === "queued")) status = "queued";
    else if (jobs.length > 0 && jobs.every((job) => job.status === "succeeded")) status = "succeeded";
    else if (jobs.some((job) => job.status === "succeeded")) status = "partial";
    else status = "failed";
    stored.aggregate.batch = { ...stored.aggregate.batch, status };
  }

  private latestJobs(jobs: RunJob[]): RunJob[] {
    const latest = new Map<number, RunJob>();
    for (const job of jobs) {
      const current = latest.get(job.outputIndex);
      if (!current || job.attempt > current.attempt) latest.set(job.outputIndex, job);
    }
    return [...latest.values()].sort((left, right) => left.outputIndex - right.outputIndex);
  }

  private replaceJob(aggregate: RunBatchAggregate, replacement: RunJob): void {
    const index = aggregate.jobs.findIndex((job) => job.id === replacement.id);
    if (index < 0) throw new RunKernelError(404, "run_job_not_found", "任务不存在");
    aggregate.jobs[index] = replacement;
  }

  private findJob(principal: RunPrincipal, jobId: string): { stored: StoredBatch; job: RunJob } {
    for (const stored of this.batches.values()) {
      if (stored.aggregate.batch.tenantId !== principal.tenantId) continue;
      const job = stored.aggregate.jobs.find((candidate) => candidate.id === jobId);
      if (job) return { stored, job };
    }
    throw new RunKernelError(404, "run_job_not_found", "任务不存在");
  }

  private requireBatch(principal: RunPrincipal, batchId: string): StoredBatch {
    const stored = this.batches.get(batchId);
    if (!stored || stored.aggregate.batch.tenantId !== principal.tenantId) {
      throw new RunKernelError(404, "run_batch_not_found", "批次不存在");
    }
    return stored;
  }

  private requireBudget(tenantId: string, projectId: string): BudgetState {
    const budget = this.budgets.get(scopedProjectKey(tenantId, projectId));
    if (!budget) throw new RunKernelError(404, "project_budget_not_found", "项目预算不存在");
    return budget;
  }

  private assertAllowed(principal: RunPrincipal, projectId: string, permission: RunPermission): void {
    if (!this.options.authorizer.allows(principal, projectId, permission)) {
      throw new RunKernelError(403, "run_permission_denied", "当前身份没有该项目的任务权限");
    }
  }

  private audit(
    batch: RunBatch,
    actorId: string,
    eventType: RunAuditEvent["eventType"],
    metadata: Record<string, string>,
  ): RunAuditEvent {
    return {
      id: `run-audit-${randomUUID()}`,
      tenantId: batch.tenantId,
      projectId: batch.projectId,
      batchId: batch.id,
      actorId,
      eventType,
      metadata,
      createdAt: new Date(this.clock()).toISOString(),
    };
  }

  private copy(aggregate: RunBatchAggregate): RunBatchAggregate {
    return RunBatchAggregateSchema.parse(structuredClone(aggregate));
  }
}
