import { createHash, randomUUID } from "node:crypto";
import {RunKernelError} from './runKernelError';
export {RunKernelError} from './runKernelError';
import type { IncomingMessage } from "node:http";
import {
  ProjectBudgetSnapshotSchema,
  RunBatchAggregateSchema,
  RunKernelSnapshotSchema,
  ConfirmedImageExecutionSchema,
  ClaimRunJobsRequestSchema,
  ExecuteRunJobRequestSchema,
  ImageDispatchIntentSchema,
  ImageFixtureAttemptSchema, ImageFixtureResultSchema,
  ImageTaskArtifactSchema, ImageTaskArtifactFailureSchema, GeneratedImageRecordSchema,
  type ImageTaskArtifact, type ImageTaskArtifactFailure, type GeneratedImageRecord,
  type ImageFixtureAttempt, type ImageFixtureResult,
  type ImageDispatchIntent,
  type ConfirmedImageExecution,
  type ConfirmedProductionImageExecution,
  type ConfirmedLockedProductionImageExecution,
  ProductionImageLeaseEvidenceSchema, type ProductionImageLeaseEvidence,
  LockedProductionImageLeaseEvidenceSchema, type LockedProductionImageLeaseEvidence,
  type ProductionImageDispatchIntent,
  type LockedProductionImageDispatchIntent,
  type ProductionImageAttempt, type ProductionImageResult,
  type LockedProductionImageAttempt, type LockedProductionImageResult,
  type ProductionImageArtifact, type LockedProductionImageArtifact,
  ProductionImageBillingRecordSchema, type ProductionImageBillingRecord,
  LockedProductionImageBillingRecordSchema, type LockedProductionImageBillingRecord,
  type ConfirmRunBatchRequest,
  type CostLedger,
  type CreateRunBatchRequest,
  type ClaimRunJobsRequest,
  type ExecuteRunJobRequest,
  type ProjectBudgetSnapshot,
  type ResolveBillingUnknownRequest,
  type RequestBillingOverage,
  type ReviewBillingOverage,
  type BillingOverage,
  type RetryRunJobRequest,
  type RunAuditEvent,
  type RunBatch,
  type RunBatchAggregate,
  type RunJob,
  type RunJobClaimResult,
  type RunJobLease,
  type RunKernelSnapshot,
} from "@canvas/contracts";
import type { RunKernelStateStore } from "./runKernelStore";
import type { ProductionImageLeasePolicy, ProductionImageLeasePurpose } from "./productionImageLeasePolicy";
import type { LockedProductionImageLeasePolicy, LockedLeasePurpose } from "./lockedProductionImageLeasePolicy";
import { assertProductionConfirmation, productionConfirmationKey } from "./productionImageConfirmationIntegrity";
import { assertLockedConfirmation, assertLockedConfirmationState, lockedConfirmationKey } from "./lockedProductionImageProtocol";
import { assertProductionDispatchIntent } from "./productionImageDispatchIntentIntegrity";
import { assertLockedDispatchIntent } from "./lockedProductionImageDispatchIntentIntegrity";
import { assertLockedImageAttempt, assertLockedImageResult } from "./lockedProductionImageResponse";
import { assertProductionImageAttempt } from "./productionImageResponse";
import { assertProductionImageResult } from "./productionImageResultIntegrity";
import { assertProductionImageArtifact } from "./productionImageArtifactIntegrity";
import { assertLockedProductionImageArtifact } from "./lockedProductionImageArtifactIntegrity";
import { assertProductionBillingState, productionBillingSummary, productionBillingSnapshot } from "./productionImageBillingIntegrity";
import { assertLockedProductionBillingState, lockedProductionBillingSummary, lockedProductionBillingSnapshot } from "./lockedProductionImageBillingIntegrity";
import { ImageProviderContractError, imageConfirmationFingerprint, imageSnapshotFingerprint, validateImageProviderRequest } from "./imageProviderContract";

export type RunPrincipal = {
  tenantId: string;
  actorId: string;
};

export type RunPermission = "run:read" | "run:create" | "run:confirm" | "run:cancel" | "run:execute" | "run:retry" | "run:reconcile-billing" | "run:approve-billing-overage";

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

export type ProjectBudgetConfig = {
  tenantId: string;
  projectId: string;
  currency: string;
  limitMinor: number;
};

export type ProjectExecutionLimitConfig = {
  tenantId: string;
  projectId: string;
  maxConcurrentJobs: number;
};

export type ProviderExecutionLimitConfig = {
  adapterId: string;
  maxConcurrentJobs: number;
  maxStartsPerWindow?: number;
  windowMs?: number;
};

type BudgetState = ProjectBudgetConfig & {
  reservedMinor: number;
  spentMinor: number;
};

type StoredBatch = {
  aggregate: RunBatchAggregate;
  lockedProductionImageExecution?: ConfirmedLockedProductionImageExecution;
  lockedProductionImageLeases?: LockedProductionImageLeaseEvidence[];
  lockedProductionImageDispatchIntent?: LockedProductionImageDispatchIntent;
  lockedProductionImageDispatchIntentFingerprint?: string;
  lockedProductionImageAttempt?: LockedProductionImageAttempt;
  lockedProductionImageAttemptFingerprint?: string;
  lockedProductionImageResult?: LockedProductionImageResult;
  lockedProductionImageResultFingerprint?: string;
  lockedProductionImageArtifact?: LockedProductionImageArtifact;
  lockedProductionImageArtifactFingerprint?: string;
  lockedProductionImageBilling?: LockedProductionImageBillingRecord[];
  lockedProductionImageBillingFingerprint?: string;
  productionImageExecution?: ConfirmedProductionImageExecution;
  productionImageLeases?: ProductionImageLeaseEvidence[];
  productionImageDispatchIntent?: ProductionImageDispatchIntent;
  productionImageDispatchIntentFingerprint?: string;
  productionImageAttempt?: ProductionImageAttempt;
  productionImageAttemptFingerprint?: string;
  productionImageResult?: ProductionImageResult;
  productionImageResultFingerprint?: string;
  productionImageArtifact?: ProductionImageArtifact;
  productionImageArtifactFingerprint?: string;
  productionImageBilling?: ProductionImageBillingRecord[];
  productionImageBillingFingerprint?: string;
  imageExecution?: ConfirmedImageExecution;
  imageDispatchIntent?: ImageDispatchIntent;
  imageDispatchIntentFingerprint?: string;
  imageFixtureAttempt?: ImageFixtureAttempt;
  imageFixtureAttemptFingerprint?: string;
  imageFixtureResult?: ImageFixtureResult;
  imageFixtureResultFingerprint?: string;
  imageTaskArtifact?: ImageTaskArtifact;
  imageTaskArtifactFingerprint?: string;
  imageTaskArtifactFailures?: ImageTaskArtifactFailure[];
  requestFingerprint: string;
  reservedMinor: number;
  actualMinor: number;
  jobReservations: Map<string, number>;
  jobScenarios: Map<string, CreateRunBatchRequest["mockScenario"]>;
};

export interface ProductionImageStartPolicy {
  usesStateStore(store: unknown): boolean;
  authorizeScope(principal: RunPrincipal, projectId: string): boolean;
  validateStart(principal: RunPrincipal, execution: ConfirmedProductionImageExecution, lease: ProductionImageLeaseEvidence, intent: ProductionImageDispatchIntent): boolean;
}
export interface LockedProductionImageStartPolicy {
  usesStateStore(store: unknown): boolean;
  authorizeScope(principal: RunPrincipal, projectId: string): boolean;
  validateStart(principal: RunPrincipal, execution: ConfirmedLockedProductionImageExecution, lease: LockedProductionImageLeaseEvidence, intent: LockedProductionImageDispatchIntent): boolean;
}
export interface ProductionImageResponsePolicy {
  usesStateStore(store: unknown): boolean;
  authorizeScope(principal: RunPrincipal, projectId: string): boolean;
  validateAttempt(p: RunPrincipal, e: ConfirmedProductionImageExecution, l: ProductionImageLeaseEvidence, i: ProductionImageDispatchIntent, a: ProductionImageAttempt): boolean;
  validateResult(p: RunPrincipal, e: ConfirmedProductionImageExecution, l: ProductionImageLeaseEvidence, i: ProductionImageDispatchIntent, a: ProductionImageAttempt, r: ProductionImageResult): boolean;
}
export interface LockedProductionImageResponsePolicy {
  usesStateStore(store: unknown): boolean;
  authorizeScope(p: RunPrincipal, project: string): boolean;
  validateAttempt(p: RunPrincipal, e: ConfirmedLockedProductionImageExecution, l: LockedProductionImageLeaseEvidence, i: LockedProductionImageDispatchIntent, a: LockedProductionImageAttempt): boolean;
  validateResult(p: RunPrincipal, e: ConfirmedLockedProductionImageExecution, l: LockedProductionImageLeaseEvidence, i: LockedProductionImageDispatchIntent, a: LockedProductionImageAttempt, r: LockedProductionImageResult): boolean;
}

export type RunKernelOptions = {
  authorizer: RunAuthorizer;
  budgets: readonly ProjectBudgetConfig[];
  stateStore?: RunKernelStateStore;
  // Shared stores reload before each command. Other processes' live jobs are not restart casualties.
  recoverRunningJobsOnRestore?: boolean;
  // Internal snapshot validation only: no lease recovery, status rewrite or save.
  restoreValidationOnly?: boolean;
  validateInputs?: (tenantId: string, request: CreateRunBatchRequest) => void;
  // Service-owned ephemeral confirmation proof; default closed. Not send authority.
  validateProductionImageConfirmation?: (principal: RunPrincipal, execution: ConfirmedProductionImageExecution) => boolean;
  validateLockedProductionImageConfirmation?: (principal: RunPrincipal, execution: ConfirmedLockedProductionImageExecution) => boolean;
  productionImageLeasePolicy?: ProductionImageLeasePolicy;
  lockedProductionImageLeasePolicy?: LockedProductionImageLeasePolicy;
  lockedProductionImageStartPolicy?: LockedProductionImageStartPolicy;
  productionImageStartPolicy?: ProductionImageStartPolicy;
  productionImageResponsePolicy?: ProductionImageResponsePolicy;
  lockedProductionImageResponsePolicy?: LockedProductionImageResponsePolicy;
  productionImageArtifactPolicy?: {
    usesStateStore(store: unknown): boolean;
    authorizeScope(p: RunPrincipal, project: string): boolean;
    validateCommit(p: RunPrincipal, record: ProductionImageArtifact): boolean;
  };
  lockedProductionImageArtifactPolicy?: {
    usesStateStore(store: unknown): boolean;
    authorizeScope(p: RunPrincipal, project: string): boolean;
    validateCommit(p: RunPrincipal, record: LockedProductionImageArtifact): boolean;
  };
  productionImageBillingPolicy?: {
    usesStateStore(store: unknown): boolean;
    authorizeScope(p: RunPrincipal, project: string, approval: boolean): boolean;
    validateCommit(p: RunPrincipal, record: ProductionImageBillingRecord): boolean;
  };
  lockedProductionImageBillingPolicy?: {
    usesStateStore(store: unknown): boolean;
    authorizeScope(p: RunPrincipal, project: string, approval: boolean): boolean;
    validateCommit(p: RunPrincipal, record: LockedProductionImageBillingRecord): boolean;
    validateOriginal(p: RunPrincipal, record: LockedProductionImageBillingRecord): boolean;
  };
  // Synchronous trusted policy only, checked inside the same command transaction.
  // It enables INTERNAL local image lease preparation, never the public mock route.
  validateImageTask?: (principal: RunPrincipal, execution: ConfirmedImageExecution, intent?: ImageDispatchIntent, additionalMetadataBytes?: number) => undefined;
  // Separate persisted-response authority. It must not reuse current quote
  // expiry as a reason to discard an already-dispatched response.
  validateImageArtifact?: (principal: RunPrincipal, execution: ConfirmedImageExecution, result: Extract<ImageFixtureResult, { kind: "returned" }>, record?: GeneratedImageRecord, additionalMetadataBytes?: number) => undefined;
  unitEstimateMinor?: number;
  unitActualMinor?: number;
  maxConcurrentJobs?: number;
  projectLimits?: readonly ProjectExecutionLimitConfig[];
  providerLimits?: readonly ProviderExecutionLimitConfig[];
  leaseDurationMs?: number;
  jobTimeoutMs?: number;
  clock?: () => number;
};

export interface RunKernelPort {
  authenticate(request: IncomingMessage): RunPrincipal | null;
  createBatch(principal: RunPrincipal, request: CreateRunBatchRequest): RunBatchAggregate;
  getBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate;
  listBatches(principal: RunPrincipal, projectId: string): RunBatchAggregate[];
  confirmBatch(principal: RunPrincipal, batchId: string, confirmation: ConfirmRunBatchRequest): RunBatchAggregate;
  claimBatch(principal: RunPrincipal, batchId: string, request: ClaimRunJobsRequest): RunJobClaimResult;
  executeLeasedJob(principal: RunPrincipal, jobId: string, request: ExecuteRunJobRequest): RunBatchAggregate;
  resolveBillingUnknown(principal: RunPrincipal, jobId: string, request: ResolveBillingUnknownRequest): RunBatchAggregate;
  requestBillingOverage(principal: RunPrincipal, jobId: string, request: RequestBillingOverage): RunBatchAggregate;
  reviewBillingOverage(principal: RunPrincipal, jobId: string, overageId: string, request: ReviewBillingOverage): RunBatchAggregate;
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

function billingResolutionFingerprint(request: ResolveBillingUnknownRequest): string {
  const canonical = request.resolution === "charged"
    ? {
      resolutionId: request.resolutionId,
      resolution: request.resolution,
      expectedReservedMinor: request.expectedReservedMinor,
      expectedCurrency: request.expectedCurrency,
      evidenceRef: request.evidenceRef,
      actualCostMinor: request.actualCostMinor,
    }
    : {
      resolutionId: request.resolutionId,
      resolution: request.resolution,
      expectedReservedMinor: request.expectedReservedMinor,
      expectedCurrency: request.expectedCurrency,
      evidenceRef: request.evidenceRef,
    };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function overageFingerprint(request: RequestBillingOverage | ReviewBillingOverage): string {
  const canonical = Object.fromEntries(Object.entries(request).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export class InMemoryRunKernel implements RunKernelPort {
  private readonly clock: () => number;
  private readonly unitEstimateMinor: number;
  private readonly unitActualMinor: number;
  private readonly maxConcurrentJobs: number;
  private readonly leaseDurationMs: number;
  private readonly jobTimeoutMs: number;
  private readonly budgets = new Map<string, BudgetState>();
  private readonly batches = new Map<string, StoredBatch>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly projectLimits = new Map<string, number>();
  private readonly providerLimits = new Map<string, ProviderExecutionLimitConfig>();

  static assertSnapshot(snapshot: RunKernelSnapshot): void {
    new InMemoryRunKernel({ budgets: snapshot.budgets, authorizer: { authenticate: () => null, allows: () => false },
      restoreValidationOnly: true, stateStore: { load: () => snapshot, save: () => { throw new Error("只读核验不能保存任务"); } } });
  }

  constructor(private readonly options: RunKernelOptions) {
    this.clock = options.clock ?? Date.now;
    this.unitEstimateMinor = options.unitEstimateMinor ?? 25;
    this.unitActualMinor = options.unitActualMinor ?? Math.max(0, this.unitEstimateMinor - 5);
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 2;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.unitEstimateMinor) || this.unitEstimateMinor < 0) throw new Error("假执行器单位估价必须是非负整数");
    if (!Number.isSafeInteger(this.unitActualMinor) || this.unitActualMinor < 0 || this.unitActualMinor > this.unitEstimateMinor) throw new Error("假执行器实际单价必须位于 0 和估价之间");
    if (!Number.isSafeInteger(this.maxConcurrentJobs) || this.maxConcurrentJobs < 1) throw new Error("假调度器并发数必须是正整数");
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 1_000) throw new Error("任务租约至少为 1 秒");
    if (!Number.isSafeInteger(this.jobTimeoutMs) || this.jobTimeoutMs < 1_000) throw new Error("假任务超时至少为 1 秒");
    for (const budget of options.budgets) {
      if (!/^[A-Z]{3}$/.test(budget.currency) || !Number.isSafeInteger(budget.limitMinor) || budget.limitMinor < 0) {
        throw new Error("项目预算配置无效");
      }
      const key = scopedProjectKey(budget.tenantId, budget.projectId);
      if (this.budgets.has(key)) throw new Error("项目预算配置重复");
      this.budgets.set(key, { ...budget, reservedMinor: 0, spentMinor: 0 });
      this.projectLimits.set(key, this.maxConcurrentJobs);
    }
    const configuredProjectLimits = new Set<string>();
    for (const limit of options.projectLimits ?? []) {
      const key = scopedProjectKey(limit.tenantId, limit.projectId);
      if (!this.budgets.has(key)) throw new Error("项目并发配置没有对应预算项目");
      if (!Number.isSafeInteger(limit.maxConcurrentJobs) || limit.maxConcurrentJobs < 1) throw new Error("项目并发上限必须是正整数");
      if (configuredProjectLimits.has(key)) throw new Error("项目并发配置重复");
      configuredProjectLimits.add(key);
      this.projectLimits.set(key, limit.maxConcurrentJobs);
    }
    for (const limit of options.providerLimits ?? []) {
      if (!limit.adapterId.trim() || !Number.isSafeInteger(limit.maxConcurrentJobs) || limit.maxConcurrentJobs < 1) {
        throw new Error("供应商并发配置无效");
      }
      const hasWindowLimit = limit.maxStartsPerWindow !== undefined || limit.windowMs !== undefined;
      if (hasWindowLimit && (!Number.isSafeInteger(limit.maxStartsPerWindow) || limit.maxStartsPerWindow! < 1
        || !Number.isSafeInteger(limit.windowMs) || limit.windowMs! < 1_000)) {
        throw new Error("供应商时间窗口限流配置无效");
      }
      if (this.providerLimits.has(limit.adapterId)) throw new Error("供应商限流配置重复");
      this.providerLimits.set(limit.adapterId, { ...limit });
    }
    this.restore();
  }

  authenticate(request: IncomingMessage): RunPrincipal | null {
    return this.options.authorizer.authenticate(request);
  }

  registerLocalProject(budget: ProjectBudgetConfig): void {
    const key = scopedProjectKey(budget.tenantId, budget.projectId);
    const existing = this.budgets.get(key);
    if (existing) {
      if (existing.currency !== budget.currency || existing.limitMinor !== budget.limitMinor) throw new Error("项目预算配置冲突");
      return;
    }
    if (!/^[A-Z]{3}$/.test(budget.currency) || !Number.isSafeInteger(budget.limitMinor) || budget.limitMinor < 0) {
      throw new Error("项目预算配置无效");
    }
    this.budgets.set(key, { ...budget, reservedMinor: 0, spentMinor: 0 });
    this.projectLimits.set(key, this.maxConcurrentJobs);
    this.persist();
  }

  listBatches(principal: RunPrincipal, projectId: string): RunBatchAggregate[] {
    this.assertAllowed(principal, projectId, "run:read");
    return [...this.batches.values()]
      .filter(({ aggregate }) => aggregate.batch.tenantId === principal.tenantId && aggregate.batch.projectId === projectId)
      .sort((left, right) => right.aggregate.batch.createdAt.localeCompare(left.aggregate.batch.createdAt))
      .map(({ aggregate }) => this.copy(aggregate));
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
    this.options.validateInputs?.(principal.tenantId, request);
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
      billingOverages: [],
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

  // Trusted local service primitive, deliberately NOT a generic HTTP create
  // contract. Its caller must prepare the protocol and revalidate authoritative
  // directory/assets under the same transaction before entering this method.
  stageConfirmedImageBatch(principal: RunPrincipal, input: ConfirmedImageExecution): RunBatchAggregate {
    const execution = ConfirmedImageExecutionSchema.parse(input);
    const request = execution.request;
    this.assertAllowed(principal, request.projectId, "run:create");
    this.assertAllowed(principal, request.projectId, "run:confirm");
    if (principal.tenantId !== request.tenantId || execution.confirmedBy !== principal.actorId) {
      throw new RunKernelError(403, "image_confirmation_permission_denied", "图片确认身份不匹配");
    }
    this.assertFrozenImageExecution(execution);
    const fingerprint = imageSnapshotFingerprint(execution);
    const idempotencyKey = `image-confirm:${execution.preparation.id}`;
    const indexKey = `${scopedProjectKey(principal.tenantId, request.projectId)}\u0000${idempotencyKey}`;
    const existingId = this.idempotencyIndex.get(indexKey);
    if (existingId) {
      const previous = this.batches.get(existingId)!;
      if (previous.requestFingerprint !== fingerprint) throw new RunKernelError(409, "image_confirmation_conflict", "准备单已有不同确认");
      return this.copy(previous.aggregate);
    }
    validateImageProviderRequest(execution.preparation.connection, request, new Date(this.clock()).toISOString());
    if (this.batches.has(execution.batchId) || [...this.batches.values()].some((item) => item.aggregate.jobs.some((job) => job.id === request.jobId))) {
      throw new RunKernelError(409, "image_task_identity_conflict", "服务端任务编号冲突");
    }
    const budget = this.requireBudget(principal.tenantId, request.projectId);
    const quote = request.quote;
    if (budget.currency !== quote.currency) throw new RunKernelError(422, "budget_currency_mismatch", "图片报价与预算币种不一致");
    if (budget.limitMinor - budget.reservedMinor - budget.spentMinor < quote.maxCostMinor) {
      throw new RunKernelError(422, "project_budget_exceeded", "项目可用预算不足以覆盖确认上限");
    }
    const inputAssetIds = request.operation === "edit" ? [...request.inputs.map((ref) => ref.assetId), ...(request.mask ? [request.mask.assetId] : [])] : [];
    const batch: RunBatch = {
      id: execution.batchId, tenantId: principal.tenantId, projectId: request.projectId, constraintSnapshotId: request.constraintSnapshotId,
      tool: request.operation === "generate" ? "image-generate" : "image-edit", adapterId: request.adapterId, inputAssetIds, idempotencyKey,
      status: "queued", expectedOutputs: 1, estimatedCostMinor: quote.estimatedCostMinor, maxCostMinor: quote.maxCostMinor, currency: quote.currency,
      confirmedBy: principal.actorId, confirmedAt: execution.confirmedAt, createdAt: execution.confirmedAt,
    };
    const job: RunJob = { id: request.jobId, batchId: batch.id, outputIndex: 0, attempt: 1, executorKind: "provider", adapterId: request.adapterId,
      idempotencyKey: request.idempotencyKey, status: "queued", inputAssetIds, outputAssetIds: [], estimatedCostMinor: quote.estimatedCostMinor, createdAt: execution.confirmedAt };
    const aggregate = RunBatchAggregateSchema.parse({ batch, jobs: [job], billingOverages: [],
      ledger: [{ id: `ledger-${randomUUID()}`, tenantId: batch.tenantId, projectId: batch.projectId, batchId: batch.id, jobId: job.id,
        currency: quote.currency, estimatedMinor: quote.estimatedCostMinor, reservedMinor: quote.maxCostMinor, settlement: "reserved", createdAt: execution.confirmedAt }],
      audit: [this.audit(batch, principal.actorId, "batch-created", { mode: "local-fixture", preparationId: execution.preparation.id }),
        this.audit(batch, principal.actorId, "batch-confirmed", { preparationFingerprint: execution.preparation.snapshotFingerprint,
          executionFingerprint: fingerprint, requestFingerprint: execution.requestFingerprint, payloadChecksumSha256: execution.payloadChecksumSha256 }),
        this.audit(batch, principal.actorId, "budget-reserved", { reservedMinor: String(quote.maxCostMinor) }),
        this.audit(batch, principal.actorId, "jobs-created", { count: "1" })] });
    budget.reservedMinor += quote.maxCostMinor;
    this.batches.set(batch.id, { aggregate, imageExecution: execution, requestFingerprint: fingerprint, reservedMinor: quote.maxCostMinor,
      actualMinor: 0, jobReservations: new Map([[job.id, quote.maxCostMinor]]), jobScenarios: new Map() });
    this.idempotencyIndex.set(indexKey, batch.id);
    this.assertStateConsistent();
    this.persist();
    return this.copy(aggregate);
  }

  stageConfirmedProductionImageBatch(principal: RunPrincipal, input: ConfirmedProductionImageExecution): RunBatchAggregate {
    return this.stageImageConfirmation(principal, input, false);
  }
  stageConfirmedLockedProductionImageBatch(principal: RunPrincipal, input: ConfirmedLockedProductionImageExecution): RunBatchAggregate {
    return this.stageImageConfirmation(principal, input, true);
  }
  private stageImageConfirmation(principal: RunPrincipal, input: ConfirmedProductionImageExecution | ConfirmedLockedProductionImageExecution, locked: boolean): RunBatchAggregate {
    const validate = locked ? this.options.validateLockedProductionImageConfirmation : this.options.validateProductionImageConfirmation;
    if (typeof validate !== "function") throw new RunKernelError(503, "production_image_confirmation_not_configured", "生产确认政策尚未配置");
    const e = locked ? assertLockedConfirmation(input) : assertProductionConfirmation(input), r = e.protocol.request, q = r.quote;
    for (const permission of ["run:create", "run:confirm", "run:read"] as const) {
      const allowed = this.options.authorizer.allows(principal, r.projectId, permission);
      if (allowed !== true) {
        void Promise.resolve(allowed).catch(() => undefined);
        throw new RunKernelError(403, "production_image_permission_denied", "生产确认权限不足");
      }
    }
    if (principal.tenantId !== r.tenantId || principal.actorId !== e.confirmedBy) throw new RunKernelError(403, "production_image_permission_denied", "生产确认身份不匹配");
    const fingerprint = imageSnapshotFingerprint(e), idempotencyKey = locked ? lockedConfirmationKey(e) : productionConfirmationKey(e as ConfirmedProductionImageExecution);
    const indexKey = `${scopedProjectKey(r.tenantId, r.projectId)}\u0000${idempotencyKey}`;
    if (locked) {
      const live = this.options.validateLockedProductionImageConfirmation!(principal, structuredClone(e as ConfirmedLockedProductionImageExecution));
      if (live !== true) { void Promise.resolve(live).catch(() => undefined); throw new RunKernelError(403, "locked_confirmation_proof_required", "锁区确认需要实际活提交"); }
    }
    const previous = this.idempotencyIndex.get(indexKey);
    if (previous) {
      const stored = this.batches.get(previous)!;
      if (stored.requestFingerprint !== fingerprint) throw new RunKernelError(409, "production_image_confirmation_conflict", "准备单已有不同确认");
      return this.copy(stored.aggregate);
    }
    const policy = () => {
      const value = locked ? this.options.validateLockedProductionImageConfirmation!(principal, structuredClone(e as ConfirmedLockedProductionImageExecution))
        : this.options.validateProductionImageConfirmation!(principal, structuredClone(e as ConfirmedProductionImageExecution));
      if (value !== true) {
        void Promise.resolve(value).catch(() => undefined);
        throw new RunKernelError(403, "production_image_confirmation_proof_required", "需要实际服务端确认准备证据");
      }
    };
    policy();
    if (this.batches.has(e.batchId) || [...this.batches.values()].some((item) => item.aggregate.jobs.some((j) => j.id === r.jobId || j.idempotencyKey === r.idempotencyKey))) throw new RunKernelError(409, "production_image_identity_conflict", "生产任务身份冲突");
    const budget = this.requireBudget(r.tenantId, r.projectId);
    if (budget.currency !== q.currency) throw new RunKernelError(422, "budget_currency_mismatch", "确认币种与预算不一致");
    if (budget.limitMinor - budget.spentMinor - budget.reservedMinor < q.maxCostMinor) throw new RunKernelError(422, "project_budget_exceeded", "预算不足以覆盖确认上限");
    const ids = r.operation === "edit" ? [...r.inputs.map((ref) => ref.assetId), ...(r.mask ? [r.mask.assetId] : [])] : [];
    const estimate = q.source === "manual-budget" ? null : q.estimatedCostMinor;
    const batch: RunBatch = { id: e.batchId, tenantId: r.tenantId, projectId: r.projectId, imageMode: e.mode,
      constraintSnapshotId: r.constraintSnapshotId, tool: r.operation === "edit" ? "image-edit" : "image-generate", adapterId: r.adapterId,
      inputAssetIds: ids, idempotencyKey, status: "queued", expectedOutputs: 1, estimatedCostMinor: estimate, maxCostMinor: q.maxCostMinor,
      currency: q.currency, createdAt: e.confirmedAt, confirmedAt: e.confirmedAt, confirmedBy: e.confirmedBy };
    const job: RunJob = { id: r.jobId, batchId: batch.id, imageMode: e.mode, outputIndex: 0, attempt: 1, executorKind: "provider",
      adapterId: r.adapterId, idempotencyKey: r.idempotencyKey, status: "queued", inputAssetIds: ids, outputAssetIds: [], estimatedCostMinor: estimate, createdAt: e.confirmedAt };
    const aggregate = RunBatchAggregateSchema.parse({ batch, jobs: [job], billingOverages: [], ledger: [{
      id: `ledger-${randomUUID()}`, tenantId: r.tenantId, projectId: r.projectId, batchId: batch.id, jobId: job.id, imageMode: e.mode,
      currency: q.currency, estimatedMinor: estimate, reservedMinor: q.maxCostMinor, settlement: "reserved", createdAt: e.confirmedAt }],
      audit: [this.audit(batch, e.confirmedBy, "batch-created", { mode: e.mode, preparationId: e.preparation.id }),
        this.audit(batch, e.confirmedBy, "batch-confirmed", { mode: e.mode, preparationFingerprint: e.preparation.snapshotFingerprint,
          pricingFingerprint: e.protocol.pricingFingerprint, executionFingerprint: fingerprint, requestFingerprint: e.protocol.requestFingerprint,
          payloadChecksumSha256: e.protocol.payloadChecksumSha256 }),
        this.audit(batch, e.confirmedBy, "budget-reserved", { reservedMinor: String(q.maxCostMinor) }),
        this.audit(batch, e.confirmedBy, "jobs-created", { count: "1" })] });
    const before = budget.reservedMinor;
    try {
      budget.reservedMinor += q.maxCostMinor;
      this.batches.set(batch.id, { aggregate, ...(locked ? { lockedProductionImageExecution: e as ConfirmedLockedProductionImageExecution } : { productionImageExecution: e as ConfirmedProductionImageExecution }), requestFingerprint: fingerprint, reservedMinor: q.maxCostMinor,
        actualMinor: 0, jobReservations: new Map([[job.id, q.maxCostMinor]]), jobScenarios: new Map() });
      this.idempotencyIndex.set(indexKey, batch.id);
      this.assertStateConsistent(); policy(); this.persist();
      return this.copy(aggregate);
    } catch (error) {
      budget.reservedMinor = before; this.batches.delete(batch.id); this.idempotencyIndex.delete(indexKey); throw error;
    }
  }

  confirmBatch(principal: RunPrincipal, batchId: string, confirmation: ConfirmRunBatchRequest): RunBatchAggregate {
    const stored = this.requireBatch(principal, batchId);
    const aggregate = stored.aggregate;
    const batch = aggregate.batch;
    this.assertAllowed(principal, batch.projectId, "run:confirm");
    this.assertMockBatch(batch);

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

    this.validateBatchInputs(batch);
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
      stored.jobScenarios.set(job.id, batch.mockScenario!);
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

  claimBatch(principal: RunPrincipal, batchId: string, request: ClaimRunJobsRequest): RunJobClaimResult {
    const stored = this.requireBatch(principal, batchId);
    this.assertAllowed(principal, stored.aggregate.batch.projectId, "run:execute");
    this.assertMockBatch(stored.aggregate.batch);
    return this.claimValidatedBatch(principal, batchId, request, false);
  }

  claimImageBatch(principal: RunPrincipal, batchId: string, request: ClaimRunJobsRequest): RunJobClaimResult {
    return this.claimValidatedBatch(principal, batchId, ClaimRunJobsRequestSchema.parse(request), true);
  }

  // INTERNAL, separate from mock/local leases and from confirmation pending proof.
  assertProductionImageTask(principal: RunPrincipal, projectId: string, batchId: string, purpose: ProductionImageLeasePurpose, extraBytes = 0): ConfirmedProductionImageExecution {
    const { e } = this.productionImageTask(principal, projectId, batchId);
    this.productionPolicyTrue(() => this.options.productionImageLeasePolicy!.validate(principal, structuredClone(e), purpose, extraBytes));
    return structuredClone(e);
  }

  private productionImageTask(principal: RunPrincipal, projectId: string, batchId: string) {
    const policy = this.options.productionImageLeasePolicy;
    if (!policy) throw new RunKernelError(503, "production_image_lease_not_configured", "生产租约默认关闭");
    this.productionPolicyTrue(() => policy.authorizeScope(principal, projectId));
    const stored = this.requireBatch(principal, batchId), e = stored.productionImageExecution;
    if (!e || e.preparation.projectId !== projectId) throw new RunKernelError(409, "production_image_lease_mode_mismatch", "批次不属于指定生产范围");
    return { stored, e };
  }

  private productionPolicyTrue(callback: () => unknown): void {
    let value: unknown;
    try { value = callback(); } catch (error) { if (error instanceof RunKernelError) throw error; throw new RunKernelError(503, "production_image_lease_policy_unavailable", "生产租约政策不可用"); }
    if (value && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => undefined);
    if (value !== true) throw new RunKernelError(403, "production_image_lease_permission_denied", "生产租约政策必须同步明确允许");
  }

  claimProductionImageBatch(principal: RunPrincipal, projectId: string, batchId: string, input: ClaimRunJobsRequest): RunJobClaimResult {
    this.assertProductionImageTask(principal, projectId, batchId, "claim");
    return this.claimValidatedBatch(principal, batchId, ClaimRunJobsRequestSchema.parse(input), "production");
  }

  assertLockedProductionImageTask(p: RunPrincipal, project: string, batch: string, purpose: LockedLeasePurpose, extraBytes = 0) {
    const policy = this.options.lockedProductionImageLeasePolicy;
    if (!policy) throw new RunKernelError(503, "locked_lease_not_configured", "保护租约默认关闭");
    this.productionPolicyTrue(() => policy.authorizeScope(p, project, purpose));
    const stored = this.requireBatch(p, batch), e = stored.lockedProductionImageExecution;
    if (!e || e.preparation.projectId !== project) throw new RunKernelError(409, "locked_lease_mode_mismatch", "原保护任务范围不匹配");
    this.productionPolicyTrue(() => policy.validate(p, structuredClone(e), purpose, extraBytes)); return structuredClone(e);
  }
  claimLockedProductionImageBatch(p: RunPrincipal, project: string, batch: string, input: ClaimRunJobsRequest) {
    const policy = this.options.lockedProductionImageLeasePolicy;
    if (!policy) throw new RunKernelError(503, "locked_lease_not_configured", "保护租约默认关闭");
    this.productionPolicyTrue(() => policy.authorizeScope(p, project, "claim")); const s = this.requireBatch(p, batch), j = s.aggregate.jobs[0];
    if (j && (["cancelled", "running", "billing_unknown"].includes(j.status) || (j.status === "leased" && this.clock() < Date.parse(j.leaseExpiresAt!)))) {
      this.assertLockedProductionImageTask(p, project, batch, "history"); return { aggregate: this.copy(s.aggregate), leases: [] };
    }
    this.assertLockedProductionImageTask(p, project, batch, "claim");
    return this.claimValidatedBatch(p, batch, ClaimRunJobsRequestSchema.parse(input), "locked");
  }
  inspectLockedProductionImageLease(p: RunPrincipal, project: string, batch: string, jobId: string, input: ExecuteRunJobRequest) {
    const policy = this.options.lockedProductionImageLeasePolicy;
    if (!policy) throw new RunKernelError(503, "locked_lease_not_configured", "保护租约默认关闭");
    this.productionPolicyTrue(() => policy.authorizeScope(p, project, "inspect"));
    const stored = this.requireBatch(p, batch), request = ExecuteRunJobRequestSchema.parse(input), j = stored.aggregate.jobs[0], l = stored.lockedProductionImageLeases?.at(-1);
    // Original claimant identity is checked before any original-input BLOB reads.
    if (!j || j.id !== jobId || j.status !== "leased" || !l || l.actorId !== p.actorId || l.leaseId !== request.leaseId || l.workerId !== request.workerId
      || j.leaseId !== request.leaseId || j.leaseOwnerId !== request.workerId) throw new RunKernelError(409, "locked_lease_identity_mismatch", "原领取人/worker/lease不匹配");
    const execution = this.assertLockedProductionImageTask(p, project, batch, "inspect");
    return { aggregate: this.copy(stored.aggregate), execution, lease: LockedProductionImageLeaseEvidenceSchema.parse(l) };
  }
  reconcileLockedProductionImageBatch(p: RunPrincipal, project: string, batch: string) {
    this.assertLockedProductionImageTask(p, project, batch, "reconcile"); const s = this.requireBatch(p, batch);
    const changed = this.recoverLockedProductionImageLease(p, s);
    this.refreshBatchStatus(s); this.assertStateConsistent(); if (changed) this.persist(); return this.copy(s.aggregate);
  }
  private recoverLockedProductionImageLease(p: RunPrincipal, s: StoredBatch) {
    const j = s.aggregate.jobs[0];
    if (j.status === "running") {
      if (this.clock() >= Date.parse(j.leaseExpiresAt!)) return this.lockedProductionUnknown(s, p, "locked-lease-expired-after-intent");
      if (this.clock() >= Date.parse(j.startedAt!) + this.jobTimeoutMs) return this.lockedProductionUnknown(s, p, "locked-job-timeout-after-intent");
      return false;
    }
    if (j.status !== "leased" || this.clock() < Date.parse(j.leaseExpiresAt!)) return false;
    const event = this.audit(s.aggregate.batch, p.actorId, "job-lease-expired", { jobId: j.id, leaseId: j.leaseId!, action: "requeued-before-start" });
    this.assertLockedProductionImageTask(p, s.aggregate.batch.projectId, s.aggregate.batch.id, "reconcile", Buffer.byteLength(JSON.stringify(event)) + 1);
    if (this.clock() < Date.parse(event.createdAt)) throw new RunKernelError(409, "locked_lease_clock_invalid", "恢复时钟倒退");
    const { leaseId: _id, leaseOwnerId: _worker, leasedAt: _at, leaseExpiresAt: _expires, ...unleased } = j;
    this.replaceJob(s.aggregate, { ...unleased, status: "queued" }); s.aggregate.audit.push(event); return true;
  }
  cancelLockedProductionImageBatch(p: RunPrincipal, project: string, batch: string) {
    this.assertLockedProductionImageTask(p, project, batch, "cancel"); const s = this.requireBatch(p, batch), a = s.aggregate, b = a.batch;
    if (b.status === "cancelled") return this.copy(a);
    // Full state validation has proved no intent/attempt/raw/fees. Future states must never inherit this release path.
    if (b.status !== "queued" || !["queued", "leased"].includes(a.jobs[0].status)) throw new RunKernelError(409, "locked_cancel_not_unsent", "只能取消未启动保护任务");
    const at = new Date(this.clock()).toISOString(), amount = s.reservedMinor;
    const event = this.audit(b, p.actorId, "batch-cancelled", { previousStatus: b.status, protectionPolicyFingerprint: imageSnapshotFingerprint(s.lockedProductionImageExecution!.preparation.protectionPolicy) });
    const release = amount > 0 ? this.audit(b, p.actorId, "budget-released", { releasedMinor: String(amount) }) : undefined;
    const entry: CostLedger | undefined = amount > 0 ? { id: `ledger-${randomUUID()}`, tenantId: b.tenantId, projectId: b.projectId, batchId: b.id, imageMode: b.imageMode,
      currency: b.currency, estimatedMinor: b.estimatedCostMinor, reservedMinor: 0, actualMinor: 0, settlement: "released", createdAt: at } : undefined;
    event.createdAt = at; if (release) release.createdAt = at;
    this.assertLockedProductionImageTask(p, project, batch, "cancel", Buffer.byteLength(JSON.stringify([event, release, entry])) + 1);
    if (this.clock() < Date.parse(at)) throw new RunKernelError(409, "locked_lease_clock_invalid", "取消时钟倒退");
    const budget = this.requireBudget(b.tenantId, project); budget.reservedMinor -= amount; s.reservedMinor = 0; s.jobReservations.clear();
    if (release && entry) { a.audit.push(release); a.ledger.push(entry); }
    a.audit.push(event); a.batch = { ...b, status: "cancelled" }; a.jobs[0] = { ...a.jobs[0], status: "cancelled", finishedAt: at };
    this.assertStateConsistent(); this.persist(); return this.copy(a);
  }

  assertLockedProductionImageStartScope(p: RunPrincipal, project: string) {
    const policy = this.options.lockedProductionImageStartPolicy;
    if (!policy) throw new RunKernelError(503, "locked_start_not_configured", "保护启动默认关闭");
    this.productionPolicyTrue(() => policy.authorizeScope(p, project));
  }
  inspectLockedProductionImageStart(p: RunPrincipal, project: string, batch: string, jobId: string, input: ExecuteRunJobRequest) {
    this.assertLockedProductionImageStartScope(p, project);
    const s = this.requireBatch(p, batch), i = s.lockedProductionImageDispatchIntent, l = s.lockedProductionImageLeases?.at(-1), request = ExecuteRunJobRequestSchema.parse(input);
    if (!i) return { ...this.inspectLockedProductionImageLease(p, project, batch, jobId, request), intent: undefined };
    if (!l || i.actorId !== p.actorId || i.jobId !== jobId || i.workerId !== request.workerId || i.leaseId !== request.leaseId
      || this.clock() < Date.parse(i.recordedAt)) throw new RunKernelError(409, "locked_start_identity_mismatch", "原启动身份不匹配");
    const execution = this.assertLockedProductionImageTask(p, project, batch, "start-history");
    assertLockedDispatchIntent(i, s.lockedProductionImageDispatchIntentFingerprint!, execution, l);
    return { aggregate: this.copy(s.aggregate), execution, lease: structuredClone(l), intent: structuredClone(i) };
  }
  startLockedProductionImageJob(p: RunPrincipal, project: string, batch: string, jobId: string, input: ExecuteRunJobRequest, incoming: LockedProductionImageDispatchIntent) {
    const initial = this.inspectLockedProductionImageStart(p, project, batch, jobId, input);
    if (initial.intent) return { aggregate: initial.aggregate, intent: initial.intent, started: false };
    const s = this.requireBatch(p, batch), e = initial.execution, fingerprint = imageSnapshotFingerprint(incoming), i = assertLockedDispatchIntent(incoming, fingerprint, e, initial.lease);
    const time = this.clock(); if (Date.parse(i.recordedAt) > time || time >= Date.parse(initial.lease.expiresAt) || time >= Date.parse(e.protocol.request.quote.expiresAt)) throw new RunKernelError(409, "locked_start_expired", "启动期限无效");
    const event = { ...this.audit(s.aggregate.batch, p.actorId, "job-started", { jobId, leaseId: i.leaseId, workerId: i.workerId,
      lockedProductionImageDispatchIntentId: i.id, intentFingerprint: fingerprint, payloadChecksumSha256: i.payloadChecksumSha256, transport: "not-connected" }), createdAt: i.recordedAt };
    this.assertLockedProductionImageTask(p, project, batch, "start", Buffer.byteLength(JSON.stringify([i, event])) + 70);
    this.productionPolicyTrue(() => this.options.lockedProductionImageStartPolicy!.validateStart(p, structuredClone(e), structuredClone(initial.lease), structuredClone(i)));
    s.lockedProductionImageDispatchIntent = i; s.lockedProductionImageDispatchIntentFingerprint = fingerprint;
    this.replaceJob(s.aggregate, { ...s.aggregate.jobs[0], status: "running", startedAt: i.recordedAt }); s.aggregate.audit.push(event);
    this.refreshBatchStatus(s); this.assertStateConsistent(); this.persist(); return { aggregate: this.copy(s.aggregate), intent: structuredClone(i), started: true };
  }
  assertLockedProductionImageStartCommit(p: RunPrincipal, project: string, batch: string, jobId: string, input: ExecuteRunJobRequest) {
    const current = this.inspectLockedProductionImageStart(p, project, batch, jobId, input);
    if (!current.intent) throw new RunKernelError(409, "locked_start_not_committed", "缺少实际保护意图");
    this.assertLockedProductionImageTask(p, project, batch, "start-commit");
    this.productionPolicyTrue(() => this.options.lockedProductionImageStartPolicy!.validateStart(p, current.execution, current.lease, current.intent));
    if (this.clock() >= Date.parse(current.intent.recordedAt) + this.jobTimeoutMs) throw new RunKernelError(409, "locked_start_expired", "写后任务期限耗尽");
  }
  private lockedProductionUnknown(s: StoredBatch, p: RunPrincipal, reason: string, observedAt?: string) {
    const b = s.aggregate.batch, j = s.aggregate.jobs[0], i = s.lockedProductionImageDispatchIntent, at = observedAt ?? new Date(this.clock()).toISOString();
    if (!i || j.status !== "running" || Date.parse(at) < Date.parse(i.recordedAt)) throw new Error("保护未知恢复缺少原意图/时刻");
    const event = { ...this.audit(b, p.actorId, "billing-unknown", { jobId: j.id, lockedProductionImageDispatchIntentId: i.id,
      intentFingerprint: s.lockedProductionImageDispatchIntentFingerprint!, reason }), createdAt: at };
    const entry: CostLedger = { id: `ledger-${randomUUID()}`, tenantId: b.tenantId, projectId: b.projectId, batchId: b.id, jobId: j.id, imageMode: b.imageMode,
      currency: b.currency, estimatedMinor: j.estimatedCostMinor, reservedMinor: s.jobReservations.get(j.id)!, settlement: "unknown", createdAt: at };
    this.assertLockedProductionImageTask(p, b.projectId, b.id, "reconcile", Buffer.byteLength(JSON.stringify([event, entry])) + 4);
    if (this.clock() < Date.parse(at)) throw new Error("保护恢复时钟倒退");
    this.replaceJob(s.aggregate, { ...j, status: "billing_unknown", failureCode: reason, finishedAt: at }); s.aggregate.audit.push(event); s.aggregate.ledger.push(entry);
    this.refreshBatchStatus(s); return true;
  }
  assertLockedImageResponseScope(p: RunPrincipal, project: string) {
    const policy = this.options.lockedProductionImageResponsePolicy;
    if (!policy) throw new RunKernelError(503, "locked_response_not_configured", "保护响应默认关闭");
    this.productionPolicyTrue(() => policy.authorizeScope(structuredClone(p), project));
  }
  inspectLockedImageAttempt(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest) {
    this.assertLockedImageResponseScope(p, project);
    const c = this.inspectLockedProductionImageStart(p, project, batch, job, input), s = this.requireBatch(p, batch);
    return { ...c, attempt: s.lockedProductionImageAttempt && structuredClone(s.lockedProductionImageAttempt), result: s.lockedProductionImageResult && structuredClone(s.lockedProductionImageResult) };
  }
  beginLockedImageAttempt(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest, incoming: LockedProductionImageAttempt) {
    const c = this.inspectLockedImageAttempt(p, project, batch, job, input);
    if (!c.intent || c.attempt || c.aggregate.jobs[0].status !== "running") throw new RunKernelError(409, "locked_attempt_not_live", "只允许首次活续接");
    const hash = imageSnapshotFingerprint(incoming), a = assertLockedImageAttempt(incoming, hash, c.execution, c.lease, c.intent).attempt;
    if (Date.parse(a.attemptedAt) > this.clock()) throw new RunKernelError(409, "locked_attempt_clock_invalid", "尝试时间不能晚于实际事务");
    const s = this.requireBatch(p, batch), event = { ...this.audit(s.aggregate.batch, p.actorId, "production-image-attempted", { jobId: job, attemptId: a.id,
      attemptFingerprint: hash, intentFingerprint: a.intentFingerprint, transport: a.transport, protectionPolicyFingerprint: a.protectionPolicyFingerprint }), createdAt: a.attemptedAt };
    this.assertLockedProductionImageTask(p, project, batch, "start-commit", Buffer.byteLength(JSON.stringify([a, event])) + 70);
    this.productionPolicyTrue(() => this.options.lockedProductionImageResponsePolicy!.validateAttempt(p, c.execution, c.lease, c.intent!, a));
    s.lockedProductionImageAttempt = a; s.lockedProductionImageAttemptFingerprint = hash; s.aggregate.audit.push(event);
    this.assertStateConsistent(); this.persist(); return this.copy(s.aggregate);
  }
  assertLockedImageAttemptCurrent(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest) {
    const c = this.inspectLockedImageAttempt(p, project, batch, job, input);
    if (!c.attempt || c.result || c.aggregate.jobs[0].status !== "running") throw new RunKernelError(409, "locked_attempt_not_live", "保护尝试不再活跃");
    this.assertLockedProductionImageTask(p, project, batch, "start-commit");
    this.productionPolicyTrue(() => this.options.lockedProductionImageResponsePolicy!.validateAttempt(p, c.execution, c.lease, c.intent!, c.attempt!));
    if (this.clock() < Date.parse(c.attempt.attemptedAt) || this.clock() >= Date.parse(c.lease.expiresAt) || this.clock() >= Date.parse(c.execution.protocol.request.quote.expiresAt)
      || this.clock() >= Date.parse(c.intent!.recordedAt) + this.jobTimeoutMs) throw new RunKernelError(409, "locked_attempt_expired", "保护尝试期限耗尽");
  }
  recordLockedImageResult(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest, incoming: LockedProductionImageResult) {
    const c = this.inspectLockedImageAttempt(p, project, batch, job, input);
    if (!c.attempt || !c.intent) throw new RunKernelError(409, "locked_attempt_missing", "响应缺少实际保护尝试");
    const hash = imageSnapshotFingerprint(incoming), r = assertLockedImageResult(incoming, hash, c.execution, c.attempt);
    // Even identical writes need the live proof. Pure history cannot authorize replay.
    this.productionPolicyTrue(() => this.options.lockedProductionImageResponsePolicy!.validateResult(p, c.execution, c.lease, c.intent!, c.attempt!, r));
    if (c.result) { if (imageSnapshotFingerprint(c.result) !== hash) throw new RunKernelError(409, "locked_result_conflict", "原响应不可覆盖"); return c.aggregate; }
    const at = r.kind === "returned" ? r.receivedAt : r.interruptedAt;
    if (Date.parse(at) > this.clock()) throw new RunKernelError(409, "locked_result_clock_invalid", "响应时间不能晚于实际提交");
    const s = this.requireBatch(p, batch), event = { ...this.audit(s.aggregate.batch, p.actorId, r.kind === "returned" ? "production-image-returned" : "production-image-interrupted",
      { jobId: job, attemptId: r.attemptId, resultFingerprint: hash, kind: r.kind, protectionPolicyFingerprint: r.protectionPolicyFingerprint }), createdAt: at };
    this.assertLockedProductionImageTask(p, project, batch, "start-history", Buffer.byteLength(JSON.stringify([r, event])) + 70);
    if (s.aggregate.jobs[0].status === "running") this.lockedProductionUnknown(s, p, r.kind === "returned" ? "locked-response-returned" : r.outcome.failureCode!, at);
    s.lockedProductionImageResult = r; s.lockedProductionImageResultFingerprint = hash; s.aggregate.audit.push(event);
    this.refreshBatchStatus(s); this.assertStateConsistent(); this.persist(); return this.copy(s.aggregate);
  }
  assertLockedImageResponseCommit(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest) {
    const c = this.inspectLockedImageAttempt(p, project, batch, job, input);
    if (!c.attempt || !c.result || c.aggregate.jobs[0].status !== "billing_unknown") throw new RunKernelError(409, "locked_result_missing", "保护响应未保存");
    this.productionPolicyTrue(() => this.options.lockedProductionImageResponsePolicy!.validateResult(p, c.execution, c.lease, c.intent!, c.attempt!, c.result!));
  }

  inspectProductionImageLease(principal: RunPrincipal, projectId: string, batchId: string, jobId: string, input: ExecuteRunJobRequest) {
    const { stored } = this.productionImageTask(principal, projectId, batchId), lease = ExecuteRunJobRequestSchema.parse(input);
    const job = stored.aggregate.jobs.find((j) => j.id === jobId);
    const evidence = stored.productionImageLeases?.at(-1);
    if (!job || job.status !== "leased" || job.leaseId !== lease.leaseId || job.leaseOwnerId !== lease.workerId
      || !evidence || evidence.actorId !== principal.actorId || evidence.leaseId !== lease.leaseId || evidence.workerId !== lease.workerId) {
      throw new RunKernelError(409, "production_image_lease_mismatch", "生产租约任务、执行器或实际领取人不匹配");
    }
    if (!job.leaseExpiresAt || this.clock() < Date.parse(job.leasedAt!) || this.clock() >= Date.parse(job.leaseExpiresAt)) throw new RunKernelError(409, "production_image_lease_expired", "生产租约已到期");
    const execution = this.assertProductionImageTask(principal, projectId, batchId, "inspect");
    if (!job.leaseExpiresAt || this.clock() < Date.parse(job.leasedAt!) || this.clock() >= Date.parse(job.leaseExpiresAt)) throw new RunKernelError(409, "production_image_lease_expired", "生产租约已到期");
    return { aggregate: this.copy(stored.aggregate), execution, lease: ProductionImageLeaseEvidenceSchema.parse(evidence) };
  }

  reconcileProductionImageBatch(principal: RunPrincipal, projectId: string, batchId: string): RunBatchAggregate {
    this.assertProductionImageTask(principal, projectId, batchId, "reconcile");
    const stored = this.requireBatch(principal, batchId);
    const changed = this.recoverProductionImageLease(principal, stored);
    this.refreshBatchStatus(stored);
    this.assertProductionImageTask(principal, projectId, batchId, "reconcile");
    this.assertStateConsistent(); if (changed) this.persist();
    return this.copy(stored.aggregate);
  }

  private recoverProductionImageLease(principal: RunPrincipal, stored: StoredBatch): boolean {
    const job = stored.aggregate.jobs[0];
    if (job.status === "running") {
      if (this.clock() >= Date.parse(job.leaseExpiresAt!)) return this.productionUnknown(stored, principal, "production-lease-expired-after-intent");
      if (this.clock() >= Date.parse(job.startedAt!) + this.jobTimeoutMs) return this.productionUnknown(stored, principal, "production-job-timeout-after-intent");
      return false;
    }
    if (job.status !== "leased" || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > this.clock()) return false;
    const event = this.audit(stored.aggregate.batch, principal.actorId, "job-lease-expired", { jobId: job.id, leaseId: job.leaseId!, action: "requeued-before-start" });
    this.assertProductionImageTask(principal, stored.aggregate.batch.projectId, stored.aggregate.batch.id, "reconcile", Buffer.byteLength(JSON.stringify(event)) + 1);
    if (this.clock() < Date.parse(event.createdAt)) throw new RunKernelError(409, "production_image_lease_clock_invalid", "恢复核验期间时钟倒退");
    const { leaseId: _id, leaseOwnerId: _worker, leasedAt: _at, leaseExpiresAt: _expires, ...unleased } = job;
    this.replaceJob(stored.aggregate, { ...unleased, status: "queued" }); stored.aggregate.audit.push(event);
    return true;
  }

  // This gate is checked BEFORE private snapshots in the SQLite wrapper too.
  assertProductionImageStartScope(p: RunPrincipal, project: string): void {
    const policy = this.options.productionImageStartPolicy;
    if (!policy) throw new RunKernelError(503, "production_image_start_not_configured", "生产启动政策默认关闭");
    this.productionPolicyTrue(() => policy.authorizeScope(p, project));
  }

  inspectProductionImageStart(p: RunPrincipal, project: string, batch: string, jobId: string, input: ExecuteRunJobRequest) {
    this.assertProductionImageStartScope(p, project);
    const { stored, e } = this.productionImageTask(p, project, batch), parsed = ExecuteRunJobRequestSchema.parse(input);
    const intent = stored.productionImageDispatchIntent, lease = stored.productionImageLeases?.at(-1);
    if (!intent) return { ...this.inspectProductionImageLease(p, project, batch, jobId, parsed), intent: undefined };
    this.assertProductionImageTask(p, project, batch, "history");
    if (!lease || intent.jobId !== jobId || intent.actorId !== p.actorId || intent.workerId !== parsed.workerId || intent.leaseId !== parsed.leaseId
      || this.clock() < Date.parse(intent.recordedAt)) throw new RunKernelError(409, "production_image_start_mismatch", "原启动身份或历史关系不匹配");
    assertProductionDispatchIntent(intent, stored.productionImageDispatchIntentFingerprint!, e, lease);
    return { aggregate: this.copy(stored.aggregate), execution: structuredClone(e), lease: structuredClone(lease), intent: structuredClone(intent) };
  }

  startProductionImageJob(p: RunPrincipal, project: string, batch: string, jobId: string, input: ExecuteRunJobRequest, incoming: ProductionImageDispatchIntent) {
    const initial = this.inspectProductionImageStart(p, project, batch, jobId, input);
    if (initial.intent) return { aggregate: initial.aggregate, intent: initial.intent, started: false };
    const { stored, e } = this.productionImageTask(p, project, batch), job = stored.aggregate.jobs[0];
    const hash = imageSnapshotFingerprint(incoming), intent = assertProductionDispatchIntent(incoming, hash, e, initial.lease);
    if (intent.recordedAt !== new Date(this.clock()).toISOString()) throw new RunKernelError(409, "production_image_start_clock_invalid", "启动记录必须匹配当前事务时间");
    const event = { ...this.audit(stored.aggregate.batch, p.actorId, "job-started", { jobId, leaseId: intent.leaseId, workerId: intent.workerId,
      productionImageDispatchIntentId: intent.id, intentFingerprint: hash, payloadChecksumSha256: intent.payloadChecksumSha256, transport: "not-connected" }), createdAt: intent.recordedAt };
    this.assertProductionImageTask(p, project, batch, "start", Buffer.byteLength(JSON.stringify(intent)) + Buffer.byteLength(JSON.stringify(event)) + 70);
    this.productionPolicyTrue(() => this.options.productionImageStartPolicy!.validateStart(p, structuredClone(e), structuredClone(initial.lease), structuredClone(intent)));
    if (this.clock() < Date.parse(intent.recordedAt) || this.clock() >= Date.parse(initial.lease.expiresAt)
      || this.clock() >= Date.parse(e.protocol.request.quote.expiresAt)) throw new RunKernelError(409, "production_image_start_expired", "最终启动核验跨过有效期限");
    stored.productionImageDispatchIntent = intent; stored.productionImageDispatchIntentFingerprint = hash;
    this.replaceJob(stored.aggregate, { ...job, status: "running", startedAt: intent.recordedAt });
    stored.aggregate.audit.push(event); this.refreshBatchStatus(stored); this.assertStateConsistent(); this.persist();
    return { aggregate: this.copy(stored.aggregate), intent: structuredClone(intent), started: true };
  }

  assertProductionImageStartCommit(p: RunPrincipal, project: string, batch: string, jobId: string, input: ExecuteRunJobRequest): void {
    const current = this.inspectProductionImageStart(p, project, batch, jobId, input);
    if (!current.intent) throw new RunKernelError(409, "production_image_start_not_committed", "生产意图缺少实际任务提交");
    this.assertProductionImageTask(p, project, batch, "start");
    this.productionPolicyTrue(() => this.options.productionImageStartPolicy!.validateStart(p, current.execution, current.lease, current.intent!));
    if (this.clock() < Date.parse(current.intent.recordedAt) || this.clock() >= Date.parse(current.lease.expiresAt)
      || this.clock() >= Date.parse(current.execution.protocol.request.quote.expiresAt)) throw new RunKernelError(409, "production_image_start_expired", "写后核验跨过有效期限");
  }

  assertProductionImageResponseScope(p: RunPrincipal, project: string): void {
    const policy = this.options.productionImageResponsePolicy;
    if (!policy) throw new RunKernelError(503, "production_image_response_not_configured", "生产尝试及响应政策默认关闭");
    this.productionPolicyTrue(() => policy.authorizeScope(p, project));
  }

  inspectProductionImageAttempt(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest) {
    this.assertProductionImageResponseScope(p, project);
    const history = this.inspectProductionImageStart(p, project, batch, job, input), stored = this.requireBatch(p, batch);
    return { ...history, attempt: stored.productionImageAttempt ? structuredClone(stored.productionImageAttempt) : undefined,
      result: stored.productionImageResult ? structuredClone(stored.productionImageResult) : undefined };
  }

  beginProductionImageAttempt(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest, incoming: ProductionImageAttempt) {
    const current = this.inspectProductionImageAttempt(p, project, batch, job, input);
    if (!current.intent || current.attempt || current.aggregate.jobs[0].status !== "running") throw new RunKernelError(409, "production_image_attempt_not_live", "只允许首次启动的活续接");
    const hash = imageSnapshotFingerprint(incoming), a = assertProductionImageAttempt(incoming, hash, current.execution, current.lease, current.intent).attempt;
    if (a.attemptedAt !== new Date(this.clock()).toISOString()) throw new RunKernelError(409, "production_image_attempt_clock_invalid", "尝试必须匹配实际事务时间");
    const stored = this.requireBatch(p, batch), event = { ...this.audit(stored.aggregate.batch, p.actorId, "production-image-attempted",
      { jobId: job, attemptId: a.id, attemptFingerprint: hash, intentFingerprint: a.intentFingerprint, transport: a.transport }), createdAt: a.attemptedAt };
    this.assertProductionImageTask(p, project, batch, "start", Buffer.byteLength(JSON.stringify(a)) + Buffer.byteLength(JSON.stringify(event)) + 70);
    this.productionPolicyTrue(() => this.options.productionImageResponsePolicy!.validateAttempt(p, current.execution, current.lease, current.intent!, a));
    stored.productionImageAttempt = a; stored.productionImageAttemptFingerprint = hash; stored.aggregate.audit.push(event);
    this.assertStateConsistent(); this.persist(); return this.copy(stored.aggregate);
  }

  assertProductionImageAttemptCurrent(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest): void {
    const current = this.inspectProductionImageAttempt(p, project, batch, job, input);
    if (!current.attempt || current.result || current.aggregate.jobs[0].status !== "running") throw new RunKernelError(409, "production_image_attempt_not_live", "尝试不再具有活续接");
    this.assertProductionImageTask(p, project, batch, "start");
    this.productionPolicyTrue(() => this.options.productionImageResponsePolicy!.validateAttempt(p, current.execution, current.lease, current.intent!, current.attempt!));
    if (this.clock() < Date.parse(current.attempt.attemptedAt) || this.clock() >= Date.parse(current.lease.expiresAt)
      || this.clock() >= Date.parse(current.execution.protocol.request.quote.expiresAt)
      || this.clock() >= Date.parse(current.aggregate.jobs[0].startedAt!) + this.jobTimeoutMs) throw new RunKernelError(409, "production_image_attempt_expired", "尝试续接已过期");
  }

  recordProductionImageResult(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest, incoming: ProductionImageResult) {
    const current = this.inspectProductionImageAttempt(p, project, batch, job, input);
    if (!current.attempt || !current.intent) throw new RunKernelError(409, "production_image_attempt_missing", "响应缺少实际尝试");
    const hash = imageSnapshotFingerprint(incoming), r = assertProductionImageResult(incoming, hash, current.execution, current.attempt);
    if (current.result) {
      if (imageSnapshotFingerprint(current.result) !== hash) throw new RunKernelError(409, "production_image_result_conflict", "原响应不可覆盖");
      return current.aggregate;
    }
    const at = r.kind === "returned" ? r.receivedAt : r.interruptedAt;
    if (at !== new Date(this.clock()).toISOString()) throw new RunKernelError(409, "production_image_response_clock_invalid", "响应必须匹配实际保存时间");
    const stored = this.requireBatch(p, batch), event = { ...this.audit(stored.aggregate.batch, p.actorId, r.kind === "returned" ? "production-image-returned" : "production-image-interrupted",
      { jobId: job, attemptId: r.attemptId, resultFingerprint: hash, kind: r.kind }), createdAt: at };
    this.assertProductionImageTask(p, project, batch, "history", Buffer.byteLength(JSON.stringify(r)) + Buffer.byteLength(JSON.stringify(event)) + 70);
    this.productionPolicyTrue(() => this.options.productionImageResponsePolicy!.validateResult(p, current.execution, current.lease, current.intent!, current.attempt!, r));
    if (stored.aggregate.jobs[0].status === "running") this.productionUnknown(stored, p, r.kind === "returned" ? "production-response-returned" : r.outcome.failureCode!);
    stored.productionImageResult = r; stored.productionImageResultFingerprint = hash; stored.aggregate.audit.push(event);
    this.refreshBatchStatus(stored); this.assertStateConsistent(); this.persist(); return this.copy(stored.aggregate);
  }

  assertProductionImageResponseCommit(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest): void {
    const c = this.inspectProductionImageAttempt(p, project, batch, job, input);
    if (!c.attempt || !c.result || c.aggregate.jobs[0].status !== "billing_unknown") throw new RunKernelError(409, "production_image_result_missing", "响应未实际保存");
    this.productionPolicyTrue(() => this.options.productionImageResponsePolicy!.validateResult(p, c.execution, c.lease, c.intent!, c.attempt!, c.result!));
  }

  inspectProductionImageArtifact(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest) {
    const policy = this.options.productionImageArtifactPolicy;
    if (!policy) throw new RunKernelError(503, "production_image_artifact_not_configured", "生产产物默认关闭");
    this.productionPolicyTrue(() => policy.authorizeScope(p, project));
    const current = this.inspectProductionImageAttempt(p, project, batch, job, input), stored = this.requireBatch(p, batch);
    if (!current.attempt || !current.intent || current.result?.kind !== "returned" || current.aggregate.jobs[0].status !== "billing_unknown")
      throw new RunKernelError(409, "production_image_artifact_response_required", "产物须实际保存的当次完整原包");
    return { ...current, artifact: stored.productionImageArtifact ? structuredClone(stored.productionImageArtifact) : undefined };
  }

  inspectLockedProductionImageArtifact(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest) {
    const policy = this.options.lockedProductionImageArtifactPolicy;
    if (!policy) throw new RunKernelError(503, "locked_artifact_not_configured", "保护产物默认关闭");
    this.productionPolicyTrue(() => policy.authorizeScope(structuredClone(p), project));
    const c = this.inspectLockedImageAttempt(p, project, batch, job, input), s = this.requireBatch(p, batch);
    if (!c.intent || !c.attempt || c.result?.kind !== "returned" || c.aggregate.jobs[0].status !== "billing_unknown")
      throw new RunKernelError(409, "locked_artifact_response_required", "保护产物须实际完整原包和未知费用任务");
    return { ...c, artifact: s.lockedProductionImageArtifact && structuredClone(s.lockedProductionImageArtifact) };
  }
  attachLockedProductionImageArtifact(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest, record: LockedProductionImageArtifact) {
    const c = this.inspectLockedProductionImageArtifact(p, project, batch, job, input), s = this.requireBatch(p, batch), hash = imageSnapshotFingerprint(record);
    this.productionPolicyTrue(() => this.options.lockedProductionImageArtifactPolicy!.validateCommit(p, structuredClone(record)));
    if (c.artifact) {
      if (imageSnapshotFingerprint(c.artifact) !== hash) throw new RunKernelError(409, "locked_artifact_conflict", "保护产物不能覆盖");
      return c.aggregate;
    }
    assertLockedProductionImageArtifact(s, record);
    if (Date.parse(record.committedAt) > this.clock()) throw new RunKernelError(409, "locked_artifact_clock_invalid", "保护产物时间不可未来");
    const event = { ...this.audit(s.aggregate.batch, p.actorId, "production-image-artifact-verified", { jobId: job, artifactFingerprint: hash,
      assetId: record.image.asset.id, checksumSha256: record.image.checksumSha256, protectionPolicyFingerprint: record.draft.protectionPolicyFingerprint }), createdAt: record.committedAt };
    this.assertLockedProductionImageTask(p, project, batch, "start-history", Buffer.byteLength(JSON.stringify([record, event])) + 70);
    this.productionPolicyTrue(() => this.options.lockedProductionImageArtifactPolicy!.validateCommit(p, structuredClone(record)));
    s.lockedProductionImageArtifact = record; s.lockedProductionImageArtifactFingerprint = hash; s.aggregate.audit.push(event);
    this.replaceJob(s.aggregate, { ...s.aggregate.jobs[0], outputAssetIds: [record.image.asset.id] });
    this.assertStateConsistent(); this.persist(); return this.copy(s.aggregate);
  }

  attachProductionImageArtifact(p: RunPrincipal, project: string, batch: string, job: string, input: ExecuteRunJobRequest, record: ProductionImageArtifact) {
    const current = this.inspectProductionImageArtifact(p, project, batch, job, input), stored = this.requireBatch(p, batch), hash = imageSnapshotFingerprint(record);
    if (current.artifact) {
      if (imageSnapshotFingerprint(current.artifact) !== hash) throw new RunKernelError(409, "production_image_artifact_conflict", "原产物不能覆盖");
      return current.aggregate;
    }
    assertProductionImageArtifact(stored, record);
    if (Date.parse(record.committedAt) > this.clock()) throw new RunKernelError(409, "production_image_artifact_clock_invalid", "产物时间不能晚于实际提交");
    const event = { ...this.audit(stored.aggregate.batch, p.actorId, "production-image-artifact-verified", { jobId: job,
      artifactFingerprint: hash, assetId: record.image.asset.id, checksumSha256: record.image.checksumSha256 }), createdAt: record.committedAt };
    this.assertProductionImageTask(p, project, batch, "history", Buffer.byteLength(JSON.stringify(record)) + Buffer.byteLength(JSON.stringify(event)) + 70);
    this.productionPolicyTrue(() => this.options.productionImageArtifactPolicy!.validateCommit(p, structuredClone(record)));
    stored.productionImageArtifact = record; stored.productionImageArtifactFingerprint = hash; stored.aggregate.audit.push(event);
    this.replaceJob(stored.aggregate, { ...stored.aggregate.jobs[0], outputAssetIds: [record.image.asset.id] });
    this.assertStateConsistent(); this.persist(); return this.copy(stored.aggregate);
  }

  private productionUnknown(stored: StoredBatch, p: RunPrincipal, reason: string): boolean {
    const { batch, jobs } = stored.aggregate, job = jobs[0], intent = stored.productionImageDispatchIntent!;
    const at = new Date(this.clock()).toISOString();
    if (!intent || job.status !== "running" || Date.parse(at) < Date.parse(intent.recordedAt)) throw new Error("生产未知恢复缺少原意图或时间倒退");
    const event = { ...this.audit(batch, p.actorId, "billing-unknown", { jobId: job.id, productionImageDispatchIntentId: intent.id,
      intentFingerprint: stored.productionImageDispatchIntentFingerprint!, reason }), createdAt: at };
    const entry: CostLedger = { id: `ledger-${randomUUID()}`, tenantId: batch.tenantId, projectId: batch.projectId, batchId: batch.id,
      jobId: job.id, imageMode: batch.imageMode, currency: batch.currency, estimatedMinor: job.estimatedCostMinor,
      reservedMinor: stored.jobReservations.get(job.id)!, settlement: "unknown", createdAt: at };
    this.assertProductionImageTask(p, batch.projectId, batch.id, "reconcile", Buffer.byteLength(JSON.stringify(entry)) + Buffer.byteLength(JSON.stringify(event)) + 4);
    if (this.clock() < Date.parse(at)) throw new Error("生产恢复核验时间倒退");
    this.replaceJob(stored.aggregate, { ...job, status: "billing_unknown", failureCode: reason, finishedAt: at });
    stored.aggregate.ledger.push(entry); stored.aggregate.audit.push(event); return true;
  }

  private claimValidatedBatch(principal: RunPrincipal, batchId: string, request: ClaimRunJobsRequest, image: boolean | "production" | "locked"): RunJobClaimResult {
    const stored = this.requireBatch(principal, batchId);
    this.assertAllowed(principal, stored.aggregate.batch.projectId, "run:execute");
    if (image === true) this.requireImageExecution(stored);
    if (stored.aggregate.batch.status === "billing_unknown") {
      throw new RunKernelError(409, "billing_state_unknown", "计费状态未知时禁止继续调度");
    }
    const recoveredExpired = image === "production" ? this.recoverProductionImageLease(principal, stored) : image === "locked" ? this.recoverLockedProductionImageLease(principal, stored) : this.recoverExpiredLeases("system-lease-reaper");
    const aggregate = stored.aggregate;
    if (aggregate.batch.status === "billing_unknown") {
      if (recoveredExpired) this.persist();
      throw new RunKernelError(409, "billing_state_unknown", "计费状态未知时禁止继续调度");
    }
    const now = this.clock();
    const latest = this.latestJobs(aggregate.jobs);
    const queued = latest.filter((job) => job.status === "queued");
    if (!queued.length) {
      if (recoveredExpired) this.persist();
      return { aggregate: this.copy(aggregate), leases: [] };
    }

    if (image === "production") this.assertProductionImageTask(principal, aggregate.batch.projectId, batchId, "claim");
    else if (image === "locked") this.assertLockedProductionImageTask(principal, aggregate.batch.projectId, batchId, "claim");
    else if (image) this.validateImageTask(principal, stored);
    else this.validateBatchInputs(aggregate.batch);

    const projectKey = scopedProjectKey(aggregate.batch.tenantId, aggregate.batch.projectId);
    const active = this.activeJobs();
    const projectLimit = this.projectLimits.get(projectKey) ?? this.maxConcurrentJobs;
    const projectActive = active.filter(({ batch }) => scopedProjectKey(batch.tenantId, batch.projectId) === projectKey).length;
    const providerLimit = this.providerLimit(aggregate.batch.adapterId);
    const providerActive = active.filter(({ job }) => job.adapterId === aggregate.batch.adapterId).length;
    const startsInWindow = providerLimit.maxStartsPerWindow === undefined
      ? []
      : this.providerStartsInWindow(aggregate.batch.adapterId, now, providerLimit.windowMs!);

    const desired = Math.min(request.maxJobs, this.maxConcurrentJobs, queued.length);
    const projectAvailable = Math.max(0, projectLimit - projectActive);
    const providerAvailable = Math.max(0, providerLimit.maxConcurrentJobs - providerActive);
    const rateAvailable = providerLimit.maxStartsPerWindow === undefined
      ? desired
      : Math.max(0, providerLimit.maxStartsPerWindow - startsInWindow.length);
    const claimCount = Math.min(desired, projectAvailable, providerAvailable, rateAvailable);
    let throttledBy: RunJobClaimResult["throttledBy"];
    let retryAfterMs: number | undefined;
    if (claimCount < desired) {
      if (projectAvailable <= claimCount) {
        throttledBy = "project-concurrency";
        retryAfterMs = this.activeRetryAfterMs(active.filter(({ batch }) => scopedProjectKey(batch.tenantId, batch.projectId) === projectKey), now);
      } else if (providerAvailable <= claimCount) {
        throttledBy = "provider-concurrency";
        retryAfterMs = this.activeRetryAfterMs(active.filter(({ job }) => job.adapterId === aggregate.batch.adapterId), now);
      } else {
        throttledBy = "provider-rate";
        retryAfterMs = Math.max(1, Date.parse(startsInWindow[0].createdAt) + providerLimit.windowMs! - now);
      }
    }

    const leases: RunJobLease[] = [];
    for (const queuedJob of queued.slice(0, claimCount)) {
      const leasedAt = new Date(now).toISOString();
      const expiresAt = new Date(now + this.leaseDurationMs).toISOString();
      const leaseId = `lease-${randomUUID()}`;
      const leased: RunJob = {
        ...queuedJob,
        status: "leased",
        leaseId,
        leaseOwnerId: request.workerId,
        leasedAt,
        leaseExpiresAt: expiresAt,
      };
      const event = this.audit(aggregate.batch, principal.actorId, "job-leased", {
        jobId: leased.id, leaseId, workerId: request.workerId, adapterId: leased.adapterId,
        ...(image === "production" || image === "locked" ? { mode: (stored.productionImageExecution ?? stored.lockedProductionImageExecution)!.mode, executionFingerprint: stored.requestFingerprint, expiresAt,
          ...(image === "locked" ? { protectionPolicyFingerprint: imageSnapshotFingerprint(stored.lockedProductionImageExecution!.preparation.protectionPolicy) } : {}) } : {}),
      });
      if (image === "production") {
        const history = stored.productionImageLeases ?? [];
        const evidence = ProductionImageLeaseEvidenceSchema.parse({ schemaVersion: 1, mode: stored.productionImageExecution!.mode,
          actorId: principal.actorId, executionFingerprint: stored.requestFingerprint, jobId: leased.id, batchId, leaseId, workerId: request.workerId, leasedAt, expiresAt });
        const updated = [...history, evidence];
        if (updated.length > 512 || Buffer.byteLength(JSON.stringify(updated)) > 512 * 1024) throw new RunKernelError(413, "production_image_lease_history_full", "不删除生产租约历史腾空间");
        event.createdAt = leasedAt;
        this.assertProductionImageTask(principal, aggregate.batch.projectId, batchId, "claim", Buffer.byteLength(JSON.stringify(evidence)) + Buffer.byteLength(JSON.stringify(event)) + 4);
        if (this.clock() < now || this.clock() >= now + this.leaseDurationMs) throw new RunKernelError(409, "production_image_lease_expired", "最终核验跨过租约期限");
        stored.productionImageLeases = updated;
      }
      if (image === "locked") {
        const history = stored.lockedProductionImageLeases ?? [], evidence = LockedProductionImageLeaseEvidenceSchema.parse({ schemaVersion: 2,
          mode: stored.lockedProductionImageExecution!.mode, actorId: principal.actorId, executionFingerprint: stored.requestFingerprint,
          protectionPolicyFingerprint: imageSnapshotFingerprint(stored.lockedProductionImageExecution!.preparation.protectionPolicy), jobId: leased.id, batchId,
          leaseId, workerId: request.workerId, leasedAt, expiresAt }), updated = [...history, evidence];
        if (updated.length > 512 || Buffer.byteLength(JSON.stringify(updated)) > 512 * 1024) throw new RunKernelError(413, "locked_lease_history_full", "不删除保护租约历史腾空间");
        event.createdAt = leasedAt; this.assertLockedProductionImageTask(principal, aggregate.batch.projectId, batchId, "claim", Buffer.byteLength(JSON.stringify([evidence, event])) + 4);
        if (this.clock() < now || this.clock() >= now + this.leaseDurationMs) throw new RunKernelError(409, "locked_lease_expired", "最终核验跨租约期限");
        stored.lockedProductionImageLeases = updated;
      }
      this.replaceJob(aggregate, leased);
      leases.push({ jobId: leased.id, batchId, leaseId, workerId: request.workerId, leasedAt, expiresAt });
      aggregate.audit.push(event);
    }
    if (leases.length > 0 && image !== "production" && image !== "locked") {
      aggregate.audit.push(this.audit(aggregate.batch, principal.actorId, "batch-dispatched", {
        count: String(leases.length),
        workerId: request.workerId,
      }));
    }
    if (throttledBy && image !== "production" && image !== "locked") {
      aggregate.audit.push(this.audit(aggregate.batch, principal.actorId, "dispatch-throttled", {
        reason: throttledBy,
        retryAfterMs: String(retryAfterMs),
        workerId: request.workerId,
      }));
    }
    this.refreshBatchStatus(stored);
    stored.aggregate = RunBatchAggregateSchema.parse(stored.aggregate);
    if (image === "production") {
      this.assertProductionImageTask(principal, aggregate.batch.projectId, batchId, "claim");
      if (leases.some((l) => this.clock() < Date.parse(l.leasedAt) || this.clock() >= Date.parse(l.expiresAt))) throw new RunKernelError(409, "production_image_lease_expired", "生产租约在提交前到期");
      this.assertStateConsistent();
    }
    if (image === "locked") {
      this.assertLockedProductionImageTask(principal, aggregate.batch.projectId, batchId, "claim");
      if (leases.some(l => this.clock() < Date.parse(l.leasedAt) || this.clock() >= Date.parse(l.expiresAt))) throw new RunKernelError(409, "locked_lease_expired", "保护租约提交前到期"); this.assertStateConsistent();
    }
    if (leases.length > 0 || (throttledBy && image !== "production" && image !== "locked") || recoveredExpired) this.persist();
    return {
      aggregate: this.copy(stored.aggregate),
      leases,
      ...(throttledBy ? { throttledBy, retryAfterMs } : {}),
    };
  }

  executeLeasedJob(principal: RunPrincipal, jobId: string, request: ExecuteRunJobRequest): RunBatchAggregate {
    const initial = this.findJob(principal, jobId);
    this.assertAllowed(principal, initial.stored.aggregate.batch.projectId, "run:execute");
    this.assertMockBatch(initial.stored.aggregate.batch);
    const recoveredExpired = this.recoverExpiredLeases("system-lease-reaper");
    const { stored, job } = this.findJob(principal, jobId);
    if (job.status !== "leased") {
      if (recoveredExpired) this.persist();
      throw new RunKernelError(409, "run_job_not_leased", "任务当前没有可执行租约");
    }
    if (job.leaseId !== request.leaseId || job.leaseOwnerId !== request.workerId) {
      if (recoveredExpired) this.persist();
      throw new RunKernelError(409, "run_job_lease_mismatch", "租约编号或执行器身份不匹配");
    }

    this.validateBatchInputs(stored.aggregate.batch);

    const startedAt = new Date(this.clock()).toISOString();
    const running: RunJob = {
      ...job,
      status: "running",
      startedAt,
      providerRequestId: `mock-request-${randomUUID()}`,
    };
    stored.aggregate.batch = { ...stored.aggregate.batch, status: "running" };
    this.replaceJob(stored.aggregate, running);
    stored.aggregate.audit.push(this.audit(stored.aggregate.batch, principal.actorId, "job-started", {
      jobId: running.id,
      leaseId: request.leaseId,
      workerId: request.workerId,
    }));
    const scenario = stored.jobScenarios.get(running.id) ?? stored.aggregate.batch.mockScenario;
    if (scenario === "billing-unknown") {
      this.finishJob(stored, running, "billing-unknown", principal.actorId);
    } else if (scenario === "failed" || (scenario === "partial-failure" && running.outputIndex % 2 === 1)) {
      this.finishJob(stored, running, "failed", principal.actorId);
    } else if (scenario !== "slow") {
      this.finishJob(stored, running, "succeeded", principal.actorId);
    }
    this.refreshBatchStatus(stored);
    stored.aggregate = RunBatchAggregateSchema.parse(stored.aggregate);
    this.persist();
    return this.copy(stored.aggregate);
  }

  // Purely INTERNAL lease-bound transition. No transport is connected here.
  // Only started=true may become a future fixture dispatch; a replay cannot send.
  startImageJob(principal: RunPrincipal, jobId: string, input: ExecuteRunJobRequest, prepared: {
    body: Buffer; contentType: string; requestFingerprint: string; payloadChecksumSha256: string;
    transformedInputs: ConfirmedImageExecution["transformedInputs"];
  }): { aggregate: RunBatchAggregate; intent: ImageDispatchIntent; started: boolean } {
    const lease = ExecuteRunJobRequestSchema.parse(input);
    const initial = this.findJob(principal, jobId);
    this.assertAllowed(principal, initial.stored.aggregate.batch.projectId, "run:execute");
    const execution = this.requireImageExecution(initial.stored);
    if (!Buffer.isBuffer(prepared.body) || prepared.body.byteLength !== execution.payloadByteSize
      || prepared.contentType !== execution.contentType || prepared.requestFingerprint !== execution.requestFingerprint
      || prepared.payloadChecksumSha256 !== execution.payloadChecksumSha256
      || createHash("sha256").update(prepared.body).digest("hex") !== execution.payloadChecksumSha256
      || imageSnapshotFingerprint(prepared.transformedInputs) !== imageSnapshotFingerprint(execution.transformedInputs)) {
      throw new RunKernelError(409, "image_dispatch_payload_mismatch", "重建协议负载与人工确认不一致");
    }
    const recovered = this.recoverExpiredLeases("system-lease-reaper");
    const { stored, job } = this.findJob(principal, jobId);
    const intent = stored.imageDispatchIntent;
    if (intent) {
      if (intent.workerId !== lease.workerId || intent.leaseId !== lease.leaseId || intent.actorId !== principal.actorId) {
        if (recovered) this.persist();
        throw new RunKernelError(409, "run_job_lease_mismatch", "派发意图属于另一个租约或执行人");
      }
      if (recovered) this.persist();
      return { aggregate: this.copy(stored.aggregate), intent: ImageDispatchIntentSchema.parse(intent), started: false };
    }
    if (job.status !== "leased") {
      if (recovered) this.persist();
      throw new RunKernelError(409, "run_job_not_leased", "图片任务没有有效租约");
    }
    if (job.leaseId !== lease.leaseId || job.leaseOwnerId !== lease.workerId
      || !stored.aggregate.audit.some((event) => event.eventType === "job-leased" && event.metadata.leaseId === lease.leaseId
        && event.metadata.jobId === job.id && event.actorId === principal.actorId)) {
      if (recovered) this.persist();
      throw new RunKernelError(409, "run_job_lease_mismatch", "图片租约编号、执行器或领取人不匹配");
    }
    this.validateImageTask(principal, stored);
    const at = new Date(this.clock()).toISOString();
    const recorded = ImageDispatchIntentSchema.parse({ schemaVersion: 1, mode: "local-fixture", transport: "not-connected",
      id: `image-intent-${randomUUID()}`, jobId: job.id, batchId: job.batchId, actorId: principal.actorId, workerId: lease.workerId, leaseId: lease.leaseId,
      executionFingerprint: stored.requestFingerprint, requestFingerprint: execution.requestFingerprint, payloadChecksumSha256: execution.payloadChecksumSha256,
      payloadByteSize: execution.payloadByteSize, contentType: execution.contentType, inputTransformsFingerprint: imageSnapshotFingerprint(execution.transformedInputs), recordedAt: at });
    this.validateImageTask(principal, stored, recorded);
    // Synchronous policy work can still cross a lease boundary. Recheck after
    // the last trusted callback, before writing any dispatch intent.
    if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= this.clock()) {
      this.recoverExpiredLeases("system-lease-reaper");
      this.persist();
      throw new RunKernelError(409, "run_job_not_leased", "图片租约在最终核验期间到期");
    }
    stored.imageDispatchIntent = recorded;
    stored.imageDispatchIntentFingerprint = imageSnapshotFingerprint(recorded);
    this.replaceJob(stored.aggregate, { ...job, status: "running", startedAt: at });
    stored.aggregate.audit.push(this.audit(stored.aggregate.batch, principal.actorId, "job-started", {
      jobId, leaseId: lease.leaseId, workerId: lease.workerId, imageDispatchIntentId: recorded.id,
      payloadChecksumSha256: recorded.payloadChecksumSha256, transport: "not-connected",
    }));
    this.refreshBatchStatus(stored);
    this.assertStateConsistent();
    this.persist();
    return { aggregate: this.copy(stored.aggregate), intent: ImageDispatchIntentSchema.parse(recorded), started: true };
  }

  inspectImageLease(principal: RunPrincipal, jobId: string, input: ExecuteRunJobRequest) {
    const lease = ExecuteRunJobRequestSchema.parse(input);
    const initial = this.findJob(principal, jobId);
    this.assertAllowed(principal, initial.stored.aggregate.batch.projectId, "run:read");
    this.assertAllowed(principal, initial.stored.aggregate.batch.projectId, "run:execute");
    this.requireImageExecution(initial.stored);
    const recovered = this.recoverExpiredLeases("system-lease-reaper");
    const { stored, job } = this.findJob(principal, jobId);
    if (recovered) this.persist();
    if (job.leaseId !== lease.leaseId || job.leaseOwnerId !== lease.workerId
      || !stored.aggregate.audit.some((event) => event.eventType === "job-leased" && event.actorId === principal.actorId
        && event.metadata.leaseId === lease.leaseId && event.metadata.jobId === jobId)) throw new RunKernelError(409, "run_job_lease_mismatch", "图片租约或领取人不匹配");
    if (!stored.imageDispatchIntent) {
      if (job.status !== "leased" || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= this.clock()) throw new RunKernelError(409, "run_job_not_leased", "图片租约已失效");
      this.validateImageTask(principal, stored);
    } else if (stored.imageDispatchIntent.actorId !== principal.actorId) throw new RunKernelError(409, "run_job_lease_mismatch", "派发意图属于另一领取人");
    return { aggregate: this.copy(stored.aggregate), execution: ConfirmedImageExecutionSchema.parse(stored.imageExecution!),
      intent: stored.imageDispatchIntent ? ImageDispatchIntentSchema.parse(stored.imageDispatchIntent) : undefined };
  }

  reconcileImageBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate {
    const stored = this.requireBatch(principal, batchId);
    this.assertAllowed(principal, stored.aggregate.batch.projectId, "run:execute");
    this.requireImageExecution(stored);
    this.recoverExpiredLeases("system-lease-reaper");
    for (const job of this.latestJobs(stored.aggregate.jobs)) {
      if (job.status === "running" && job.startedAt && this.clock() - Date.parse(job.startedAt) >= this.jobTimeoutMs) {
        this.finishJob(stored, job, "billing-unknown", principal.actorId, "image-dispatch-outcome-unknown");
      }
    }
    this.refreshBatchStatus(stored);
    this.assertStateConsistent();
    this.persist();
    return this.copy(stored.aggregate);
  }

  // INTERNAL only. Called by the first-start continuation, never by a replay.
  beginImageFixtureAttempt(principal: RunPrincipal, jobId: string, lease: ExecuteRunJobRequest, prepared: {
    body: Buffer; contentType: string; requestFingerprint: string; payloadChecksumSha256: string; transformedInputs: ConfirmedImageExecution["transformedInputs"];
  }): ImageFixtureAttempt {
    lease = ExecuteRunJobRequestSchema.parse(lease);
    const { stored, job } = this.findJob(principal, jobId), execution = this.requireImageExecution(stored), intent = stored.imageDispatchIntent;
    this.assertAllowed(principal, execution.request.projectId, "run:execute");
    if (!intent || intent.actorId !== principal.actorId || intent.workerId !== lease.workerId || intent.leaseId !== lease.leaseId) throw new RunKernelError(409, "run_job_lease_mismatch", "本地传输没有对应首次启动租约");
    if (stored.imageFixtureAttempt || stored.imageFixtureResult) throw new RunKernelError(409, "image_fixture_already_attempted", "本地传输不能重复尝试");
    if (job.status !== "running" || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= this.clock()) throw new RunKernelError(409, "run_job_not_leased", "本地传输租约已失效");
    if (!Buffer.isBuffer(prepared.body) || prepared.body.byteLength !== execution.payloadByteSize || prepared.contentType !== execution.contentType
      || prepared.requestFingerprint !== execution.requestFingerprint || prepared.payloadChecksumSha256 !== execution.payloadChecksumSha256
      || createHash("sha256").update(prepared.body).digest("hex") !== execution.payloadChecksumSha256
      || imageSnapshotFingerprint(prepared.transformedInputs) !== imageSnapshotFingerprint(execution.transformedInputs)) throw new RunKernelError(409, "image_dispatch_payload_mismatch", "本地发送字节与确认不一致");
    this.validateImageTask(principal, stored);
    const attempt = ImageFixtureAttemptSchema.parse({ schemaVersion: 1, mode: "local-fixture", transport: "local-fixture", status: "attempted",
      id: `fixture-attempt-${randomUUID()}`, jobId, batchId: job.batchId, intentId: intent.id, actorId: principal.actorId, workerId: lease.workerId, leaseId: lease.leaseId,
      executionFingerprint: stored.requestFingerprint, payloadChecksumSha256: execution.payloadChecksumSha256, attemptedAt: new Date(this.clock()).toISOString() });
    this.validateImageTask(principal, stored, undefined, Buffer.byteLength(JSON.stringify(attempt)));
    if (Date.parse(job.leaseExpiresAt) <= this.clock()) throw new RunKernelError(409, "run_job_not_leased", "本地传输最终核验时租约到期");
    stored.imageFixtureAttempt = attempt; stored.imageFixtureAttemptFingerprint = imageSnapshotFingerprint(attempt);
    stored.aggregate.audit.push(this.audit(stored.aggregate.batch, principal.actorId, "image-fixture-attempted", { jobId, attemptId: attempt.id, intentId: intent.id }));
    this.assertStateConsistent(); this.persist(); return ImageFixtureAttemptSchema.parse(attempt);
  }

  recordImageFixtureResult(principal: RunPrincipal, jobId: string, incoming: ImageFixtureResult): RunBatchAggregate {
    const result = ImageFixtureResultSchema.parse(incoming), { stored, job } = this.findJob(principal, jobId), execution = this.requireImageExecution(stored), attempt = stored.imageFixtureAttempt;
    this.assertAllowed(principal, execution.request.projectId, "run:execute");
    if (!attempt || attempt.actorId !== principal.actorId || result.attemptId !== attempt.id || result.outcome.jobId !== jobId) throw new RunKernelError(409, "image_fixture_attempt_mismatch", "响应缺少对应本地传输证据");
    if (stored.imageFixtureResult) {
      if (imageSnapshotFingerprint(result) !== stored.imageFixtureResultFingerprint) throw new RunKernelError(409, "image_fixture_result_conflict", "本地响应证据不可覆盖");
      return this.copy(stored.aggregate);
    }
    stored.imageFixtureResult = result; stored.imageFixtureResultFingerprint = imageSnapshotFingerprint(result);
    stored.aggregate.audit.push(this.audit(stored.aggregate.batch, principal.actorId, result.kind === "returned" ? "image-fixture-returned" : "image-fixture-interrupted", { jobId, attemptId: attempt.id, resultId: result.id }));
    if (job.status === "running") this.finishJob(stored, job, "billing-unknown", principal.actorId, result.outcome.failureCode ?? "image-artifact-not-yet-validated");
    if (result.outcome.providerRequestId) {
      const current = stored.aggregate.jobs.find((item) => item.id === jobId)!;
      this.replaceJob(stored.aggregate, { ...current, providerRequestId: result.outcome.providerRequestId });
    }
    this.refreshBatchStatus(stored); this.assertStateConsistent(); this.persist(); return this.copy(stored.aggregate);
  }

  // INTERNAL: no caller confirmation flag, no queued/intent-only authorization.
  inspectImageArtifact(principal: RunPrincipal, jobId: string) {
    const { stored, job } = this.findJob(principal, jobId), execution = this.requireImageExecution(stored), result = stored.imageFixtureResult;
    this.assertAllowed(principal, execution.request.projectId, "run:read");
    this.assertAllowed(principal, execution.request.projectId, "run:execute");
    if (!stored.imageFixtureAttempt || result?.kind !== "returned" || stored.imageFixtureAttempt.actorId !== principal.actorId
      || !["billing_unknown", "failed", "succeeded"].includes(job.status)) throw new RunKernelError(409, "image_output_response_not_authorized", "任务缺少实际本地返回与原运行租约证据");
    this.validateImageArtifact(principal, stored);
    return { execution: ConfirmedImageExecutionSchema.parse(execution), result: ImageFixtureResultSchema.parse(result) as Extract<ImageFixtureResult, { kind: "returned" }>,
      artifact: stored.imageTaskArtifact ? ImageTaskArtifactSchema.parse(stored.imageTaskArtifact) : undefined };
  }

  attachImageArtifact(principal: RunPrincipal, incoming: GeneratedImageRecord): RunBatchAggregate {
    const record = GeneratedImageRecordSchema.parse(incoming), inspected = this.inspectImageArtifact(principal, record.request.jobId);
    const { stored, job } = this.findJob(principal, record.request.jobId), execution = inspected.execution;
    const artifact = ImageTaskArtifactSchema.parse({ schemaVersion: 1, mode: "local-fixture", jobId: job.id, batchId: job.batchId,
      attemptId: stored.imageFixtureAttempt!.id, resultId: inspected.result.id, assetId: record.image.asset.id, executionFingerprint: stored.requestFingerprint,
      resultFingerprint: stored.imageFixtureResultFingerprint, generatedRecordFingerprint: imageSnapshotFingerprint(record), checksumSha256: record.image.checksumSha256,
      committedBy: principal.actorId, committedAt: record.image.verifiedAt });
    if (stored.imageTaskArtifact) {
      if (imageSnapshotFingerprint(artifact) !== stored.imageTaskArtifactFingerprint) throw new RunKernelError(409, "image_output_version_conflict", "产物不可变记录不能覆盖");
      this.validateImageArtifact(principal, stored, record); return this.copy(stored.aggregate);
    }
    if (JSON.stringify(record.request) !== JSON.stringify(execution.request) || record.requestFingerprint !== execution.requestFingerprint
      || record.payloadChecksumSha256 !== execution.payloadChecksumSha256 || record.confirmedAt !== execution.confirmedAt
      || record.protocol !== execution.preparation.connection.protocol || imageSnapshotFingerprint(record.constraint) !== imageSnapshotFingerprint(execution.preparation.constraint)
      || JSON.stringify(record.transformedInputs) !== JSON.stringify(execution.transformedInputs) || JSON.stringify(record.providerOutcome) !== JSON.stringify(inspected.result.outcome)) {
      throw new RunKernelError(409, "image_output_execution_mismatch", "产物与实际确认或响应不匹配");
    }
    this.validateImageArtifact(principal, stored, record, Buffer.byteLength(JSON.stringify(artifact)));
    stored.imageTaskArtifact = artifact; stored.imageTaskArtifactFingerprint = imageSnapshotFingerprint(artifact);
    this.replaceJob(stored.aggregate, { ...job, outputAssetIds: [artifact.assetId], status: job.billingResolutionId ? "succeeded" : "billing_unknown", failureCode: undefined });
    stored.aggregate.audit.push(this.audit(stored.aggregate.batch, principal.actorId, "image-artifact-verified", { jobId: job.id, assetId: artifact.assetId, resultId: artifact.resultId, generatedRecordFingerprint: artifact.generatedRecordFingerprint }));
    this.refreshBatchStatus(stored); this.assertStateConsistent(); this.persist(); return this.copy(stored.aggregate);
  }

  recordImageArtifactFailure(principal: RunPrincipal, jobId: string, stage: ImageTaskArtifactFailure["stage"], code: string): RunBatchAggregate {
    const inspected = this.inspectImageArtifact(principal, jobId), { stored, job } = this.findJob(principal, jobId);
    const failure = ImageTaskArtifactFailureSchema.parse({ schemaVersion: 1, mode: "local-fixture", jobId, resultId: inspected.result.id,
      resultFingerprint: stored.imageFixtureResultFingerprint, stage, code, recordedBy: principal.actorId, recordedAt: new Date(this.clock()).toISOString() });
    const failures = stored.imageTaskArtifactFailures ?? [];
    if (stored.imageTaskArtifact || failures.some((item) => item.stage === stage && item.code === code)) return this.copy(stored.aggregate);
    if (failures.length >= 16) throw new RunKernelError(413, "image_output_failure_history_full", "产物失败历史已达本机上限，不删除旧证据");
    this.validateImageArtifact(principal, stored, undefined, Buffer.byteLength(JSON.stringify(failure)) + 2);
    stored.imageTaskArtifactFailures = [...failures, failure];
    if (job.status === "billing_unknown") this.replaceJob(stored.aggregate, { ...job, failureCode: code });
    stored.aggregate.audit.push(this.audit(stored.aggregate.batch, principal.actorId, "image-artifact-rejected", { jobId, resultId: failure.resultId, stage, code }));
    this.assertStateConsistent(); this.persist(); return this.copy(stored.aggregate);
  }

  dispatchBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate {
    const workerId = `compat-${createHash("sha256").update(`${principal.tenantId}:${principal.actorId}`).digest("hex")}`;
    const claim = this.claimBatch(principal, batchId, { workerId, maxJobs: this.maxConcurrentJobs });
    let aggregate = claim.aggregate;
    for (const lease of claim.leases) {
      aggregate = this.executeLeasedJob(principal, lease.jobId, { workerId, leaseId: lease.leaseId });
    }
    return aggregate;
  }

  reconcileBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate {
    const stored = this.requireBatch(principal, batchId);
    this.assertAllowed(principal, stored.aggregate.batch.projectId, "run:execute");
    this.assertMockBatch(stored.aggregate.batch);
    this.recoverExpiredLeases("system-lease-reaper");
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
    this.assertMockBatch(batch);
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

    this.validateBatchInputs(batch);
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

  resolveBillingUnknown(
    principal: RunPrincipal,
    jobId: string,
    request: ResolveBillingUnknownRequest,
  ): RunBatchAggregate {
    const { stored, job } = this.findJob(principal, jobId);
    const batch = stored.aggregate.batch;
    this.assertAllowed(principal, batch.projectId, "run:reconcile-billing");
    if (stored.productionImageExecution) throw new RunKernelError(503, "production_image_billing_not_configured", "生产费用整合尚未启用，保持未知预留");
    const fingerprint = billingResolutionFingerprint(request);
    const resolutionEvents = stored.aggregate.audit.filter((event) => event.metadata.jobId === jobId
      && ["billing-resolved-charged", "billing-resolved-not-charged"].includes(event.eventType));
    const repeated = resolutionEvents.find((event) => event.metadata.resolutionId === request.resolutionId);
    if (repeated) {
      if (repeated.metadata.requestFingerprint !== fingerprint) {
        throw new RunKernelError(409, "billing_resolution_idempotency_conflict", "相同核账动作编号对应了不同参数");
      }
      return this.copy(stored.aggregate);
    }
    if (resolutionEvents.length > 0 || job.billingResolutionId) {
      throw new RunKernelError(409, "billing_already_resolved", "该任务的计费状态已经处理");
    }
    if (job.status !== "billing_unknown") {
      throw new RunKernelError(409, "billing_state_not_unknown", "只有计费待核对任务可以执行核账");
    }
    if (stored.aggregate.billingOverages.some((item) => item.jobId === job.id && item.status === "pending")) {
      throw new RunKernelError(409, "billing_overage_pending", "该任务存在待审批申请，不能绕过审批核账");
    }
    const latest = this.latestJobs(stored.aggregate.jobs).find((candidate) => candidate.outputIndex === job.outputIndex);
    if (!latest || latest.id !== job.id) throw new RunKernelError(409, "run_job_superseded", "该任务已有后续尝试");
    const reservedMinor = stored.jobReservations.get(job.id) ?? 0;
    if (request.expectedReservedMinor !== reservedMinor || request.expectedCurrency !== batch.currency) {
      stored.aggregate.audit.push(this.audit(batch, principal.actorId, "billing-resolution-rejected", {
        jobId,
        resolutionId: request.resolutionId,
        reason: "snapshot-mismatch",
      }));
      this.persist();
      throw new RunKernelError(409, "billing_resolution_snapshot_mismatch", "核账所依据的预留金额或币种已变化");
    }
    const actualCostMinor = request.resolution === "charged" ? request.actualCostMinor : 0;
    if (actualCostMinor > reservedMinor) {
      stored.aggregate.audit.push(this.audit(batch, principal.actorId, "billing-resolution-rejected", {
        jobId,
        resolutionId: request.resolutionId,
        reason: "actual-exceeds-reservation",
      }));
      this.persist();
      throw new RunKernelError(422, "billing_actual_exceeds_reservation", "外部实际扣费超过预留，必须升级处理而不能自动入账");
    }

    return this.finalizeBilling(stored, job, principal, request);
  }

  requestBillingOverage(principal: RunPrincipal, jobId: string, request: RequestBillingOverage): RunBatchAggregate {
    const { stored, job } = this.findJob(principal, jobId);
    const batch = stored.aggregate.batch;
    this.assertAllowed(principal, batch.projectId, "run:reconcile-billing");
    if (stored.productionImageExecution) throw new RunKernelError(503, "production_image_billing_not_configured", "生产费用整合尚未启用，保持未知预留");
    const fingerprint = overageFingerprint(request);
    const repeated = stored.aggregate.billingOverages.find((item) => item.jobId === jobId && item.requestId === request.requestId);
    if (repeated) {
      if (repeated.requestFingerprint !== fingerprint || repeated.requestedBy !== principal.actorId) {
        throw new RunKernelError(409, "billing_overage_idempotency_conflict", "相同超额申请动作对应不同参数或提交人");
      }
      return this.copy(stored.aggregate);
    }
    if (job.status !== "billing_unknown") throw new RunKernelError(409, "billing_state_not_unknown", "任务不再等待核账");
    if (stored.aggregate.billingOverages.some((item) => item.jobId === jobId && item.status === "pending")) {
      throw new RunKernelError(409, "billing_overage_pending", "同一任务只能有一个待审批申请");
    }
    const reservedMinor = stored.jobReservations.get(jobId) ?? 0;
    if (request.expectedReservedMinor !== reservedMinor || request.expectedCurrency !== batch.currency
      || request.expectedBatchMaxCostMinor !== batch.maxCostMinor) {
      throw new RunKernelError(409, "billing_overage_snapshot_mismatch", "超额申请所见预留或批次上限已变化");
    }
    if (request.actualCostMinor <= reservedMinor) throw new RunKernelError(422, "billing_overage_not_needed", "未超过预留，应走普通核账流程");
    const exposure = stored.actualMinor + (stored.reservedMinor - reservedMinor) + request.actualCostMinor;
    if (request.requestedBatchMaxCostMinor < batch.maxCostMinor || request.requestedBatchMaxCostMinor < exposure) {
      throw new RunKernelError(422, "billing_overage_ceiling_insufficient", "申请上限不能降低现有上限且必须覆盖全部批次费用和预留");
    }
    const overage: BillingOverage = {
      id: `overage-${randomUUID()}`, jobId, requestId: request.requestId, requestFingerprint: fingerprint,
      requestedBy: principal.actorId, requestedAt: new Date(this.clock()).toISOString(),
      reservedMinor, currency: batch.currency, actualCostMinor: request.actualCostMinor,
      batchMaxCostMinor: batch.maxCostMinor, requestedBatchMaxCostMinor: request.requestedBatchMaxCostMinor,
      evidenceRef: request.evidenceRef, reason: request.reason, status: "pending",
    };
    stored.aggregate.billingOverages.push(overage);
    stored.aggregate.audit.push(this.audit(batch, principal.actorId, "billing-overage-requested", {
      jobId, overageId: overage.id, actualCostMinor: String(overage.actualCostMinor),
      requestedBatchMaxCostMinor: String(overage.requestedBatchMaxCostMinor), evidenceRef: overage.evidenceRef,
    }));
    this.persist();
    return this.copy(stored.aggregate);
  }

  reviewBillingOverage(principal: RunPrincipal, jobId: string, overageId: string, request: ReviewBillingOverage): RunBatchAggregate {
    const { stored, job } = this.findJob(principal, jobId);
    const batch = stored.aggregate.batch;
    this.assertAllowed(principal, batch.projectId, "run:approve-billing-overage");
    if (stored.productionImageExecution) throw new RunKernelError(503, "production_image_billing_not_configured", "生产费用整合尚未启用，保持未知预留");
    const index = stored.aggregate.billingOverages.findIndex((item) => item.id === overageId && item.jobId === jobId);
    const overage = stored.aggregate.billingOverages[index];
    if (!overage) throw new RunKernelError(404, "billing_overage_not_found", "该任务没有此审批申请");
    if (overage.requestedBy === principal.actorId) throw new RunKernelError(403, "billing_overage_self_review", "申请人不能审批自己的申请");
    const fingerprint = overageFingerprint(request);
    if (overage.status !== "pending") {
      if (overage.reviewId !== request.reviewId) throw new RunKernelError(409, "billing_overage_already_reviewed", "此申请已处理，不能覆盖结论");
      if (overage.reviewFingerprint !== fingerprint || overage.reviewedBy !== principal.actorId) {
        throw new RunKernelError(409, "billing_overage_review_idempotency_conflict", "相同审批动作对应不同参数或审批人");
      }
      return this.copy(stored.aggregate);
    }
    if (request.expectedReservedMinor !== overage.reservedMinor || request.expectedCurrency !== overage.currency
      || request.expectedActualCostMinor !== overage.actualCostMinor || request.expectedBatchMaxCostMinor !== overage.batchMaxCostMinor
      || request.expectedRequestedBatchMaxCostMinor !== overage.requestedBatchMaxCostMinor) {
      throw new RunKernelError(409, "billing_overage_snapshot_mismatch", "审批金额与申请快照不一致");
    }
    if (job.status !== "billing_unknown" || stored.jobReservations.get(jobId) !== overage.reservedMinor) {
      throw new RunKernelError(409, "billing_overage_snapshot_mismatch", "任务核账状态或预留已变化");
    }
    if (request.decision === "approve") {
      if (batch.maxCostMinor !== overage.batchMaxCostMinor) throw new RunKernelError(409, "billing_overage_snapshot_mismatch", "批次上限已被其他审批改变，请拒绝后重新申请");
      const exposure = stored.actualMinor + (stored.reservedMinor - overage.reservedMinor) + overage.actualCostMinor;
      if (exposure > overage.requestedBatchMaxCostMinor) throw new RunKernelError(422, "billing_overage_ceiling_insufficient", "批次其他支出已增加，当前申请上限不足");
      const budget = this.requireBudget(batch.tenantId, batch.projectId);
      const available = budget.limitMinor - budget.reservedMinor - budget.spentMinor;
      if (available < overage.actualCostMinor - overage.reservedMinor) {
        stored.aggregate.audit.push(this.audit(batch, principal.actorId, "billing-overage-review-blocked", { jobId, overageId, reason: "project-budget-exceeded" }));
        this.persist();
        throw new RunKernelError(422, "project_budget_exceeded", "剩余项目预算不能覆盖超额费用，保持冻结");
      }
    }
    const reviewed = {
      ...overage, status: request.decision === "approve" ? "approved" as const : "rejected" as const,
      reviewId: request.reviewId, reviewFingerprint: fingerprint, reviewedBy: principal.actorId,
      reviewedAt: new Date(this.clock()).toISOString(), reviewEvidenceRef: request.evidenceRef, reviewNote: request.note,
    };
    stored.aggregate.billingOverages[index] = reviewed;
    stored.aggregate.audit.push(this.audit(batch, principal.actorId, request.decision === "approve" ? "billing-overage-approved" : "billing-overage-rejected", {
      jobId, overageId, reviewId: request.reviewId, evidenceRef: request.evidenceRef,
      previousBatchMaxCostMinor: String(batch.maxCostMinor), requestedBatchMaxCostMinor: String(overage.requestedBatchMaxCostMinor),
    }));
    if (request.decision === "reject") { this.persist(); return this.copy(stored.aggregate); }
    stored.aggregate.batch = { ...batch, maxCostMinor: overage.requestedBatchMaxCostMinor };
    return this.finalizeBilling(stored, job, principal, {
      resolutionId: request.reviewId, resolution: "charged", expectedReservedMinor: overage.reservedMinor,
      expectedCurrency: overage.currency, actualCostMinor: overage.actualCostMinor, evidenceRef: overage.evidenceRef,
    });
  }

  commitProductionImageBilling(p: RunPrincipal, incoming: ProductionImageBillingRecord): RunBatchAggregate {
    const record = ProductionImageBillingRecordSchema.parse(incoming), s = record.snapshot, stored = this.batches.get(s.batchId), policy = this.options.productionImageBillingPolicy;
    if (!policy) throw new RunKernelError(503, "production_image_billing_not_configured", "生产核账提交默认关闭");
    this.productionPolicyTrue(() => policy.authorizeScope(p, s.projectId, !!record.decision));
    if (!stored || stored.aggregate.batch.tenantId !== p.tenantId || s.tenantId !== p.tenantId || stored.aggregate.batch.projectId !== s.projectId
      || !stored.productionImageExecution || stored.aggregate.jobs[0].id !== s.jobId) throw new RunKernelError(409, "production_image_billing_task_changed", "核账实际任务不一致");
    const history = stored.productionImageBilling ?? [], old = history.find(r => r.request.reviewId === record.request.reviewId);
    const serialized = { ...stored, jobReservations: [...stored.jobReservations.entries()], jobScenarios: [...stored.jobScenarios.entries()] };
    const baseline = history.length ? assertProductionBillingState(serialized) : serialized;
    if (imageSnapshotFingerprint(productionBillingSnapshot(baseline)) !== record.snapshotFingerprint
      || imageSnapshotFingerprint(s) !== record.snapshotFingerprint) throw new RunKernelError(409, "production_image_billing_task_changed", "完整原核账期待不一致");
    if (old) {
      if (!record.decision || old.status !== "pending" || record.decision.request.expectedRecordFingerprint !== imageSnapshotFingerprint(old)
        || imageSnapshotFingerprint({ ...record, status: "pending", decision: undefined }) !== imageSnapshotFingerprint(old)) throw new RunKernelError(409, "production_image_billing_conflict", "核账或审批不可覆写");
    } else if (record.decision || history.length >= 16 || (history.length && history.at(-1)!.status !== "rejected")
      || stored.aggregate.jobs[0].status !== "billing_unknown") throw new RunKernelError(409, "production_image_billing_conflict", "核账已结算或仍待独立审批");
    if (p.actorId !== (record.decision?.decidedBy ?? record.reviewedBy)) throw new RunKernelError(403, "production_image_billing_permission_denied", "核账操作者不一致");
    const amount = record.request.actualCostMinor, job = stored.aggregate.jobs[0], batch = stored.aggregate.batch, at = record.decision?.decidedAt ?? record.reviewedAt;
    const budget = this.requireBudget(batch.tenantId, batch.projectId);
    if (record.status === "settled" && amount - s.reservedMinor > budget.limitMinor - budget.reservedMinor - budget.spentMinor)
      throw new RunKernelError(409, "production_image_billing_budget_exceeded", "项目预算不足，原预留与待审批记录保持");
    this.productionPolicyTrue(() => policy.validateCommit(p, structuredClone(record)));
    const records = old ? history.map(r => r === old ? record : r) : [...history, record];
    stored.productionImageBilling = records; stored.productionImageBillingFingerprint = imageSnapshotFingerprint(records);
    stored.aggregate.productionBilling = productionBillingSummary(records);
    const event = (type: RunAuditEvent["eventType"], metadata: Record<string, string>) => ({ ...this.audit(batch, p.actorId, type, metadata), createdAt: at });
    if (!old) stored.aggregate.audit.push(event("production-billing-reviewed", { jobId: job.id, reviewId: record.request.reviewId, recordFingerprint: imageSnapshotFingerprint(record) }));
    else stored.aggregate.audit.push(event(record.decision!.request.decision === "approve" ? "production-billing-approved" : "production-billing-rejected",
      { jobId: job.id, reviewId: record.request.reviewId, decisionId: record.decision!.request.decisionId, recordFingerprint: imageSnapshotFingerprint(record) }));
    if (record.status === "settled") {
      const resolutionId = record.decision?.request.decisionId ?? record.request.reviewId;
      budget.reservedMinor -= s.reservedMinor; budget.spentMinor += amount; stored.reservedMinor = 0; stored.actualMinor = amount; stored.jobReservations.clear();
      this.replaceJob(stored.aggregate, { ...job, status: stored.productionImageArtifact ? "succeeded" : "failed", actualCostMinor: amount,
        failureCode: stored.productionImageArtifact ? undefined : "production-billing-settled-no-artifact", billingResolutionId: resolutionId,
        billingResolvedBy: p.actorId, billingResolvedAt: at, billingEvidenceRef: record.request.evidence.evidenceRef });
      batch.maxCostMinor = Math.max(s.maxCostMinor, amount); batch.status = stored.productionImageArtifact ? "succeeded" : "failed";
      stored.aggregate.ledger.push({ id: `ledger-${randomUUID()}`, tenantId: p.tenantId, projectId: batch.projectId, batchId: batch.id, jobId: job.id,
        imageMode: record.mode, currency: s.currency, estimatedMinor: job.estimatedCostMinor, reservedMinor: 0, actualMinor: amount, settlement: amount ? "settled" : "released", createdAt: at });
      stored.aggregate.audit.push(event("production-billing-settled", { jobId: job.id, resolutionId, recordFingerprint: imageSnapshotFingerprint(record),
        actualMinor: String(amount), releasedMinor: String(Math.max(0, s.reservedMinor - amount)), additionalMinor: String(Math.max(0, amount - s.reservedMinor)) }));
    }
    this.assertStateConsistent(); this.persist(); return this.copy(stored.aggregate);
  }

  commitLockedProductionImageBilling(p: RunPrincipal, incoming: LockedProductionImageBillingRecord): RunBatchAggregate {
    const record = LockedProductionImageBillingRecordSchema.parse(incoming), s = record.snapshot, stored = this.batches.get(s.batchId), policy = this.options.lockedProductionImageBillingPolicy;
    if (!policy) throw new RunKernelError(503, "locked_billing_not_configured", "生产核账提交默认关闭");
    this.productionPolicyTrue(() => policy.authorizeScope(p, s.projectId, !!record.decision));
    if (!stored || stored.aggregate.batch.tenantId !== p.tenantId || s.tenantId !== p.tenantId || stored.aggregate.batch.projectId !== s.projectId
      || !stored.lockedProductionImageExecution || stored.aggregate.jobs[0].id !== s.jobId) throw new RunKernelError(409, "locked_billing_task_changed", "核账实际任务不一致");
    const history = stored.lockedProductionImageBilling ?? [], old = history.find(r => r.request.reviewId === record.request.reviewId);
    const serialized = { ...stored, jobReservations: [...stored.jobReservations.entries()], jobScenarios: [...stored.jobScenarios.entries()] };
    const baseline = history.length ? assertLockedProductionBillingState(serialized) : serialized;
    if (imageSnapshotFingerprint(lockedProductionBillingSnapshot(baseline)) !== record.snapshotFingerprint
      || imageSnapshotFingerprint(s) !== record.snapshotFingerprint) throw new RunKernelError(409, "locked_billing_task_changed", "完整原核账期待不一致");
    if (old) {
      if (!record.decision || old.status !== "pending" || record.decision.request.expectedRecordFingerprint !== imageSnapshotFingerprint(old)
        || imageSnapshotFingerprint({ ...record, status: "pending", decision: undefined }) !== imageSnapshotFingerprint(old)) throw new RunKernelError(409, "locked_billing_conflict", "核账或审批不可覆写");
    } else if (record.decision || history.length >= 16 || (history.length && history.at(-1)!.status !== "rejected")
      || stored.aggregate.jobs[0].status !== "billing_unknown") throw new RunKernelError(409, "locked_billing_conflict", "核账已结算或仍待独立审批");
    if (p.actorId !== (record.decision?.decidedBy ?? record.reviewedBy)) throw new RunKernelError(403, "locked_billing_permission_denied", "核账操作者不一致");
    const amount = record.request.actualCostMinor, job = stored.aggregate.jobs[0], batch = stored.aggregate.batch, at = record.decision?.decidedAt ?? record.reviewedAt;
    const budget = this.requireBudget(batch.tenantId, batch.projectId);
    if (record.status === "settled" && amount - s.reservedMinor > budget.limitMinor - budget.reservedMinor - budget.spentMinor)
      throw new RunKernelError(409, "locked_billing_budget_exceeded", "项目预算不足，原预留与待审批记录保持");
    if (!Number.isSafeInteger(budget.spentMinor + amount)) throw new RunKernelError(409, "locked_billing_amount_invalid", "保护费用整数越界");
    this.productionPolicyTrue(() => policy.validateCommit(p, structuredClone(record)));
    const records = old ? history.map(r => r === old ? record : r) : [...history, record];
    stored.lockedProductionImageBilling = records; stored.lockedProductionImageBillingFingerprint = imageSnapshotFingerprint(records);
    stored.aggregate.lockedProductionBilling = lockedProductionBillingSummary(records);
    const event = (type: RunAuditEvent["eventType"], metadata: Record<string, string>) => ({ ...this.audit(batch, p.actorId, type, metadata), createdAt: at });
    if (!old) stored.aggregate.audit.push(event("locked-billing-reviewed", { jobId: job.id, reviewId: record.request.reviewId, recordFingerprint: imageSnapshotFingerprint(record) }));
    else stored.aggregate.audit.push(event(record.decision!.request.decision === "approve" ? "locked-billing-approved" : "locked-billing-rejected",
      { jobId: job.id, reviewId: record.request.reviewId, decisionId: record.decision!.request.decisionId, recordFingerprint: imageSnapshotFingerprint(record) }));
    if (record.status === "settled") {
      const resolutionId = record.decision?.request.decisionId ?? record.request.reviewId;
      budget.reservedMinor -= s.reservedMinor; budget.spentMinor += amount; stored.reservedMinor = 0; stored.actualMinor = amount; stored.jobReservations.clear();
      this.replaceJob(stored.aggregate, { ...job, status: stored.lockedProductionImageArtifact ? "succeeded" : "failed", actualCostMinor: amount,
        failureCode: stored.lockedProductionImageArtifact ? undefined : "locked-billing-settled-no-artifact", billingResolutionId: resolutionId,
        billingResolvedBy: p.actorId, billingResolvedAt: at, billingEvidenceRef: record.request.evidence.evidenceRef });
      batch.maxCostMinor = Math.max(s.maxCostMinor, amount); batch.status = stored.lockedProductionImageArtifact ? "succeeded" : "failed";
      stored.aggregate.ledger.push({ id: `ledger-${randomUUID()}`, tenantId: p.tenantId, projectId: batch.projectId, batchId: batch.id, jobId: job.id,
        imageMode: record.mode, currency: s.currency, estimatedMinor: job.estimatedCostMinor, reservedMinor: 0, actualMinor: amount, settlement: amount ? "settled" : "released", createdAt: at });
      stored.aggregate.audit.push(event("locked-billing-settled", { jobId: job.id, resolutionId, recordFingerprint: imageSnapshotFingerprint(record),
        actualMinor: String(amount), releasedMinor: String(Math.max(0, s.reservedMinor - amount)), additionalMinor: String(Math.max(0, amount - s.reservedMinor)) }));
    }
    this.assertStateConsistent(); this.persist(); return this.copy(stored.aggregate);
  }

  private finalizeBilling(stored: StoredBatch, job: RunJob, principal: RunPrincipal, request: ResolveBillingUnknownRequest): RunBatchAggregate {
    const batch = stored.aggregate.batch;
    const actualCostMinor = request.resolution === "charged" ? request.actualCostMinor : 0;
    const fingerprint = billingResolutionFingerprint(request);
    const jobId = job.id;
    const resolvedAt = new Date(this.clock()).toISOString();
    const resolved: RunJob = {
      ...job,
      status: stored.imageTaskArtifact ? "succeeded" : "failed",
      actualCostMinor,
      failureCode: stored.imageTaskArtifact ? undefined : request.resolution === "charged" ? "billing-resolved-charged" : "billing-resolved-not-charged",
      billingResolutionId: request.resolutionId,
      billingResolvedAt: resolvedAt,
      billingResolvedBy: principal.actorId,
      billingEvidenceRef: request.evidenceRef,
      finishedAt: resolvedAt,
    };
    this.replaceJob(stored.aggregate, resolved);
    stored.aggregate.audit.push(this.audit(
      batch,
      principal.actorId,
      request.resolution === "charged" ? "billing-resolved-charged" : "billing-resolved-not-charged",
      {
        jobId,
        resolutionId: request.resolutionId,
        evidenceRef: request.evidenceRef,
        actualCostMinor: String(actualCostMinor),
        requestFingerprint: fingerprint,
      },
    ));
    this.settleReservation(
      stored,
      resolved,
      actualCostMinor,
      request.resolution === "charged" ? "settled" : "released",
      principal.actorId,
    );
    this.refreshBatchStatus(stored);
    stored.aggregate = RunBatchAggregateSchema.parse(stored.aggregate);
    this.persist();
    return this.copy(stored.aggregate);
  }

  cancelBatch(principal: RunPrincipal, batchId: string): RunBatchAggregate {
    const stored = this.requireBatch(principal, batchId);
    if (stored.lockedProductionImageExecution) throw new RunKernelError(503, "locked_task_continuation_closed", "保护任务后续入口尚未接线，保留预留");
    const aggregate = stored.aggregate;
    const batch = aggregate.batch;
    this.assertAllowed(principal, batch.projectId, "run:cancel");
    if (batch.status === "cancelled") return this.copy(aggregate);
    if (batch.status === "billing_unknown") {
      throw new RunKernelError(409, "billing_state_unknown", "计费状态未知时不能释放预算或取消批次");
    }
    if (!["awaiting_confirmation", "queued"].includes(batch.status)) {
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
        estimatedMinor: batch.imageMode ? batch.estimatedCostMinor : releasable,
        ...(batch.imageMode ? { imageMode: batch.imageMode } : {}),
        reservedMinor: 0,
        actualMinor: 0,
        settlement: "released",
        createdAt: now,
      });
    }
    // A zero cap still has a reservation relationship, which cancellation clears.
    stored.jobReservations.clear();
    aggregate.batch = { ...batch, status: "cancelled" };
    aggregate.jobs = aggregate.jobs.map((job) => ["queued", "leased", "running"].includes(job.status)
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
        productionImageExecution: serialized.productionImageExecution,
        lockedProductionImageExecution: serialized.lockedProductionImageExecution,
        lockedProductionImageLeases: serialized.lockedProductionImageLeases,
        lockedProductionImageDispatchIntent: serialized.lockedProductionImageDispatchIntent,
        lockedProductionImageDispatchIntentFingerprint: serialized.lockedProductionImageDispatchIntentFingerprint,
        lockedProductionImageAttempt: serialized.lockedProductionImageAttempt,
        lockedProductionImageAttemptFingerprint: serialized.lockedProductionImageAttemptFingerprint,
        lockedProductionImageResult: serialized.lockedProductionImageResult,
        lockedProductionImageResultFingerprint: serialized.lockedProductionImageResultFingerprint,
        lockedProductionImageArtifact: serialized.lockedProductionImageArtifact,
        lockedProductionImageArtifactFingerprint: serialized.lockedProductionImageArtifactFingerprint,
        lockedProductionImageBilling: serialized.lockedProductionImageBilling,
        lockedProductionImageBillingFingerprint: serialized.lockedProductionImageBillingFingerprint,
        productionImageLeases: serialized.productionImageLeases,
        productionImageDispatchIntent: serialized.productionImageDispatchIntent,
        productionImageDispatchIntentFingerprint: serialized.productionImageDispatchIntentFingerprint,
        productionImageAttempt: serialized.productionImageAttempt, productionImageAttemptFingerprint: serialized.productionImageAttemptFingerprint,
        productionImageResult: serialized.productionImageResult, productionImageResultFingerprint: serialized.productionImageResultFingerprint,
        productionImageArtifact: serialized.productionImageArtifact, productionImageArtifactFingerprint: serialized.productionImageArtifactFingerprint,
        productionImageBilling: serialized.productionImageBilling, productionImageBillingFingerprint: serialized.productionImageBillingFingerprint,
        imageExecution: serialized.imageExecution,
        imageDispatchIntent: serialized.imageDispatchIntent,
        imageDispatchIntentFingerprint: serialized.imageDispatchIntentFingerprint,
        imageFixtureAttempt: serialized.imageFixtureAttempt, imageFixtureAttemptFingerprint: serialized.imageFixtureAttemptFingerprint,
        imageFixtureResult: serialized.imageFixtureResult, imageFixtureResultFingerprint: serialized.imageFixtureResultFingerprint,
        imageTaskArtifact: serialized.imageTaskArtifact, imageTaskArtifactFingerprint: serialized.imageTaskArtifactFingerprint,
        imageTaskArtifactFailures: serialized.imageTaskArtifactFailures,
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
    if (this.options.restoreValidationOnly) return;

    let recoveredRunningJobs = false;
    for (const stored of this.batches.values()) {
      const batch = stored.aggregate.batch;
      for (const job of stored.aggregate.jobs.filter((candidate) => candidate.status === "running"
        && this.options.recoverRunningJobsOnRestore !== false)) {
        if (stored.lockedProductionImageExecution) {
          this.lockedProductionUnknown(stored, { tenantId: batch.tenantId, actorId: stored.lockedProductionImageDispatchIntent!.actorId }, "locked-recovered-after-restart");
          recoveredRunningJobs = true; continue;
        }
        if (stored.productionImageExecution) {
          this.productionUnknown(stored, { tenantId: batch.tenantId, actorId: stored.productionImageDispatchIntent!.actorId }, "production-recovered-after-restart");
          recoveredRunningJobs = true; continue;
        }
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
    const recoveredExpiredLeases = this.recoverExpiredLeases("system-recovery");
    this.assertStateConsistent();
    if (recoveredRunningJobs || recoveredExpiredLeases) this.persist();
  }

  private persist(): void {
    if (this.options.restoreValidationOnly) throw new Error("只读核验不能保存任务");
    if (!this.options.stateStore) return;
    const snapshot: RunKernelSnapshot = {
      schemaVersion: 1,
      savedAt: new Date(this.clock()).toISOString(),
      budgets: [...this.budgets.values()].map((budget) => ({ ...budget })),
      batches: [...this.batches.values()].map((stored) => ({
        aggregate: this.copy(stored.aggregate),
        ...(stored.productionImageExecution ? { productionImageExecution: stored.productionImageExecution } : {}),
        ...(stored.lockedProductionImageExecution ? { lockedProductionImageExecution: stored.lockedProductionImageExecution } : {}),
        ...(stored.lockedProductionImageLeases ? { lockedProductionImageLeases: stored.lockedProductionImageLeases } : {}),
        ...(stored.lockedProductionImageDispatchIntent ? { lockedProductionImageDispatchIntent: stored.lockedProductionImageDispatchIntent } : {}),
        ...(stored.lockedProductionImageDispatchIntentFingerprint ? { lockedProductionImageDispatchIntentFingerprint: stored.lockedProductionImageDispatchIntentFingerprint } : {}),
        ...(stored.lockedProductionImageAttempt ? { lockedProductionImageAttempt: stored.lockedProductionImageAttempt } : {}),
        ...(stored.lockedProductionImageAttemptFingerprint ? { lockedProductionImageAttemptFingerprint: stored.lockedProductionImageAttemptFingerprint } : {}),
        ...(stored.lockedProductionImageResult ? { lockedProductionImageResult: stored.lockedProductionImageResult } : {}),
        ...(stored.lockedProductionImageResultFingerprint ? { lockedProductionImageResultFingerprint: stored.lockedProductionImageResultFingerprint } : {}),
        ...(stored.lockedProductionImageArtifact ? { lockedProductionImageArtifact: stored.lockedProductionImageArtifact } : {}),
        ...(stored.lockedProductionImageArtifactFingerprint ? { lockedProductionImageArtifactFingerprint: stored.lockedProductionImageArtifactFingerprint } : {}),
        ...(stored.lockedProductionImageBilling ? { lockedProductionImageBilling: stored.lockedProductionImageBilling } : {}),
        ...(stored.lockedProductionImageBillingFingerprint ? { lockedProductionImageBillingFingerprint: stored.lockedProductionImageBillingFingerprint } : {}),
        ...(stored.productionImageLeases ? { productionImageLeases: stored.productionImageLeases } : {}),
        ...(stored.productionImageDispatchIntent ? { productionImageDispatchIntent: stored.productionImageDispatchIntent } : {}),
        ...(stored.productionImageDispatchIntentFingerprint ? { productionImageDispatchIntentFingerprint: stored.productionImageDispatchIntentFingerprint } : {}),
        ...(stored.productionImageAttempt ? { productionImageAttempt: stored.productionImageAttempt, productionImageAttemptFingerprint: stored.productionImageAttemptFingerprint } : {}),
        ...(stored.productionImageResult ? { productionImageResult: stored.productionImageResult, productionImageResultFingerprint: stored.productionImageResultFingerprint } : {}),
        ...(stored.productionImageArtifact ? { productionImageArtifact: stored.productionImageArtifact, productionImageArtifactFingerprint: stored.productionImageArtifactFingerprint } : {}),
        ...(stored.productionImageBilling ? { productionImageBilling: stored.productionImageBilling, productionImageBillingFingerprint: stored.productionImageBillingFingerprint } : {}),
        ...(stored.imageExecution ? { imageExecution: stored.imageExecution } : {}),
        ...(stored.imageDispatchIntent ? { imageDispatchIntent: stored.imageDispatchIntent, imageDispatchIntentFingerprint: stored.imageDispatchIntentFingerprint } : {}),
        ...(stored.imageFixtureAttempt ? { imageFixtureAttempt: stored.imageFixtureAttempt, imageFixtureAttemptFingerprint: stored.imageFixtureAttemptFingerprint } : {}),
        ...(stored.imageFixtureResult ? { imageFixtureResult: stored.imageFixtureResult, imageFixtureResultFingerprint: stored.imageFixtureResultFingerprint } : {}),
        ...(stored.imageTaskArtifact ? { imageTaskArtifact: stored.imageTaskArtifact, imageTaskArtifactFingerprint: stored.imageTaskArtifactFingerprint } : {}),
        ...(stored.imageTaskArtifactFailures ? { imageTaskArtifactFailures: stored.imageTaskArtifactFailures } : {}),
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
    const executionKeys = new Set<string>();
    for (const stored of this.batches.values()) {
      const { batch, jobs } = stored.aggregate;
      const budgetKey = scopedProjectKey(batch.tenantId, batch.projectId);
      const budget = this.budgets.get(budgetKey);
      if (!budget || budget.currency !== batch.currency) throw new Error("任务内核快照中的批次预算归属无效");
      if ((stored.lockedProductionImageBilling || stored.lockedProductionImageBillingFingerprint || stored.aggregate.lockedProductionBilling)
        && !stored.lockedProductionImageExecution) throw new Error("保护费用缺少独立完整保护确认");
      if (batch.tool === "product-retouch") {
        if (stored.lockedProductionImageExecution || stored.lockedProductionImageLeases || stored.lockedProductionImageDispatchIntent || stored.lockedProductionImageDispatchIntentFingerprint || stored.lockedProductionImageAttempt || stored.lockedProductionImageAttemptFingerprint || stored.lockedProductionImageResult || stored.lockedProductionImageResultFingerprint || stored.lockedProductionImageArtifact || stored.lockedProductionImageArtifactFingerprint) throw new Error("模拟任务不可含锁区证据");
        if (batch.imageMode || stored.productionImageExecution || stored.productionImageLeases || stored.productionImageDispatchIntent || stored.productionImageDispatchIntentFingerprint || stored.productionImageAttempt || stored.productionImageAttemptFingerprint || stored.productionImageResult || stored.productionImageResultFingerprint || stored.productionImageArtifact || stored.productionImageArtifactFingerprint || stored.imageExecution || stored.imageDispatchIntent || stored.imageDispatchIntentFingerprint || stored.imageFixtureAttempt || stored.imageFixtureAttemptFingerprint
          || stored.imageFixtureResult || stored.imageFixtureResultFingerprint || stored.imageTaskArtifact || stored.imageTaskArtifactFingerprint || stored.imageTaskArtifactFailures
          || stored.productionImageBilling || stored.productionImageBillingFingerprint || stored.aggregate.productionBilling
          || jobs.some((job) => job.executorKind !== "mock")) throw new Error("模拟任务包含供应商执行证据");
      } else if (stored.lockedProductionImageExecution) {
        assertLockedConfirmationState({ ...stored, jobReservations: [...stored.jobReservations.entries()], jobScenarios: [...stored.jobScenarios.entries()] }, this.options.restoreValidationOnly ? undefined : this.leaseDurationMs, this.options.restoreValidationOnly ? undefined : this.jobTimeoutMs);
      } else if (stored.lockedProductionImageLeases || stored.lockedProductionImageDispatchIntent || stored.lockedProductionImageDispatchIntentFingerprint || stored.lockedProductionImageAttempt || stored.lockedProductionImageAttemptFingerprint || stored.lockedProductionImageResult || stored.lockedProductionImageResultFingerprint || stored.lockedProductionImageArtifact || stored.lockedProductionImageArtifactFingerprint) {
        throw new Error("保护租约缺少独立完整确认");
      } else if (stored.productionImageExecution) {
        this.assertProductionState(stored);
      } else if (stored.productionImageLeases || stored.productionImageDispatchIntent || stored.productionImageDispatchIntentFingerprint || stored.productionImageAttempt || stored.productionImageAttemptFingerprint || stored.productionImageResult || stored.productionImageResultFingerprint || stored.productionImageArtifact || stored.productionImageArtifactFingerprint || stored.productionImageBilling || stored.productionImageBillingFingerprint || stored.aggregate.productionBilling) {
        throw new Error("生产租约缺少独立生产确认");
      } else {
        if (batch.imageMode) throw new Error("生产任务缺少独立完整确认");
        const execution = stored.imageExecution;
        if (!execution) throw new Error("图片任务缺少服务端确认快照");
        this.assertFrozenImageExecution(execution);
        const request = execution.request;
        const ids = request.operation === "edit" ? [...request.inputs.map((ref) => ref.assetId), ...(request.mask ? [request.mask.assetId] : [])] : [];
        const job = jobs[0];
        if (stored.requestFingerprint !== imageSnapshotFingerprint(execution) || execution.batchId !== batch.id
          || request.tenantId !== batch.tenantId || request.projectId !== batch.projectId || request.constraintSnapshotId !== batch.constraintSnapshotId
          || batch.tool !== (request.operation === "generate" ? "image-generate" : "image-edit") || batch.adapterId !== request.adapterId
          || batch.idempotencyKey !== `image-confirm:${execution.preparation.id}` || batch.confirmedBy !== execution.confirmedBy || batch.confirmedAt !== execution.confirmedAt
          || batch.estimatedCostMinor !== request.quote.estimatedCostMinor
          || batch.maxCostMinor !== Math.max(request.quote.maxCostMinor, ...stored.aggregate.billingOverages.filter((item) => item.status === "approved").map((item) => item.requestedBatchMaxCostMinor))
          || batch.currency !== request.quote.currency || jobs.length !== 1 || !job || job.id !== request.jobId || job.idempotencyKey !== request.idempotencyKey
          || job.executorKind !== "provider" || job.adapterId !== request.adapterId || job.estimatedCostMinor !== request.quote.estimatedCostMinor
          || JSON.stringify(batch.inputAssetIds) !== JSON.stringify(ids) || JSON.stringify(job.inputAssetIds) !== JSON.stringify(ids)
          || stored.jobScenarios.size !== 0 || JSON.stringify(job.outputAssetIds) !== JSON.stringify(stored.imageTaskArtifact ? [stored.imageTaskArtifact.assetId] : [])
          || !["queued", "leased", "running", "billing_unknown", "cancelled", "failed", "succeeded"].includes(job.status)
          || !["queued", "running", "billing_unknown", "cancelled", "failed", "succeeded"].includes(batch.status)
          || (["queued", "leased", "running", "billing_unknown"].includes(job.status) && (stored.jobReservations.get(job.id) !== request.quote.maxCostMinor || job.actualCostMinor !== undefined))
          || (["failed", "succeeded"].includes(job.status) && (!job.billingResolutionId || job.actualCostMinor === undefined))
          || (job.status === "succeeded" && !stored.imageTaskArtifact) || (job.status === "failed" && stored.imageTaskArtifact)) {
          throw new Error("图片任务确认、预留或关闭执行闸门不一致");
        }
        this.assertImageIntent(stored, execution, job);
        this.assertImageFixtureEvidence(stored, execution, job);
        this.assertImageArtifactEvidence(stored, job);
      }
      const jobsById = new Map(jobs.map((job) => [job.id, job]));
      if (jobsById.size !== jobs.length) throw new Error("任务内核快照中的任务编号重复");
      const overageIds = new Set<string>();
      const requestIds = new Set<string>();
      const pendingJobs = new Set<string>();
      const approvedJobs = new Set<string>();
      for (const overage of stored.aggregate.billingOverages) {
        const job = jobsById.get(overage.jobId);
        const actionKey = `${overage.jobId}\u0000${overage.requestId}`;
        if (!job || overageIds.has(overage.id) || requestIds.has(actionKey)
          || overage.currency !== batch.currency || overage.actualCostMinor <= overage.reservedMinor
          || overage.requestedBatchMaxCostMinor < overage.batchMaxCostMinor) {
          throw new Error("任务内核快照中的超额申请归属或金额无效");
        }
        overageIds.add(overage.id); requestIds.add(actionKey);
        const submitted: RequestBillingOverage = {
          requestId: overage.requestId, expectedReservedMinor: overage.reservedMinor, expectedCurrency: overage.currency,
          expectedBatchMaxCostMinor: overage.batchMaxCostMinor, actualCostMinor: overage.actualCostMinor,
          requestedBatchMaxCostMinor: overage.requestedBatchMaxCostMinor, evidenceRef: overage.evidenceRef, reason: overage.reason,
        };
        if (overage.requestFingerprint !== overageFingerprint(submitted)
          || !stored.aggregate.audit.some((event) => event.eventType === "billing-overage-requested"
            && event.metadata.overageId === overage.id && event.actorId === overage.requestedBy)) {
          throw new Error("任务内核快照缺少超额申请证据");
        }
        if (overage.status === "pending") {
          if (pendingJobs.has(job.id) || job.status !== "billing_unknown" || stored.jobReservations.get(job.id) !== overage.reservedMinor) {
            throw new Error("任务内核快照中的待审批预留状态无效");
          }
          pendingJobs.add(job.id);
        } else {
          const reviewed: ReviewBillingOverage = {
            reviewId: overage.reviewId, decision: overage.status === "approved" ? "approve" : "reject",
            expectedReservedMinor: overage.reservedMinor, expectedCurrency: overage.currency, expectedActualCostMinor: overage.actualCostMinor,
            expectedBatchMaxCostMinor: overage.batchMaxCostMinor, expectedRequestedBatchMaxCostMinor: overage.requestedBatchMaxCostMinor,
            evidenceRef: overage.reviewEvidenceRef, note: overage.reviewNote,
          };
          if (overage.reviewedBy === overage.requestedBy || overage.reviewFingerprint !== overageFingerprint(reviewed)
            || !stored.aggregate.audit.some((event) => event.eventType === `billing-overage-${overage.status}`
              && event.metadata.overageId === overage.id && event.actorId === overage.reviewedBy && event.metadata.reviewId === overage.reviewId)) {
            throw new Error("任务内核快照中的超额审批证据无效");
          }
          if (overage.status === "approved") {
            if (approvedJobs.has(job.id) || job.actualCostMinor !== overage.actualCostMinor || job.billingResolutionId !== overage.reviewId
              || job.billingResolvedBy !== overage.reviewedBy || batch.maxCostMinor < overage.requestedBatchMaxCostMinor) {
              throw new Error("任务内核快照中的超额结算状态无效");
            }
            approvedJobs.add(job.id);
          }
        }
      }
      for (const job of jobs) {
        if (executionKeys.has(job.idempotencyKey) && (job.imageMode || job.idempotencyKey.startsWith("production-image-execution-"))) throw new Error("生产执行幂等键重复");
        executionKeys.add(job.idempotencyKey);
        if (globalJobIds.has(job.id) || job.batchId !== batch.id) throw new Error("任务内核快照中的任务归属无效");
        globalJobIds.add(job.id);
        if (job.executorKind === "mock" && !stored.jobScenarios.has(job.id)) throw new Error("任务内核快照缺少任务执行场景");
        const shouldReserve = ["queued", "leased", "running", "billing_unknown"].includes(job.status);
        if (shouldReserve !== stored.jobReservations.has(job.id)) {
          throw new Error("任务内核快照中的任务预留状态无效");
        }
        const leaseFieldCount = [job.leaseId, job.leaseOwnerId, job.leasedAt, job.leaseExpiresAt]
          .filter((value) => value !== undefined).length;
        if ((job.status === "leased" && leaseFieldCount !== 4)
          || (job.status === "queued" && leaseFieldCount !== 0)
          || (leaseFieldCount !== 0 && leaseFieldCount !== 4)) {
          throw new Error("任务内核快照中的执行租约不完整");
        }
        const billingResolutionFieldCount = [
          job.billingResolutionId,
          job.billingResolvedAt,
          job.billingResolvedBy,
          job.billingEvidenceRef,
        ].filter((value) => value !== undefined).length;
        if ((billingResolutionFieldCount !== 0 && billingResolutionFieldCount !== 4)
          || (billingResolutionFieldCount === 4 && job.status !== "failed" && !(job.status === "succeeded" && (stored.imageTaskArtifact || stored.productionImageArtifact || stored.lockedProductionImageArtifact)))) {
          throw new Error("任务内核快照中的计费核账状态不完整");
        }
        if (billingResolutionFieldCount === 4) {
          const resolutionEvent = stored.aggregate.audit.find((event) => event.metadata.jobId === job.id
            && event.metadata.resolutionId === job.billingResolutionId
            && ["billing-resolved-charged", "billing-resolved-not-charged", "production-billing-settled", "locked-billing-settled"].includes(event.eventType));
          if (!resolutionEvent) throw new Error("任务内核快照缺少计费核账审计");
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

  private assertProductionState(stored: StoredBatch): void {
    if (stored.productionImageBilling || stored.productionImageBillingFingerprint || stored.aggregate.productionBilling) {
      const serialized = { ...stored, jobReservations: [...stored.jobReservations.entries()], jobScenarios: [...stored.jobScenarios.entries()] };
      const base = assertProductionBillingState(serialized);
      this.assertProductionState({ ...base, jobReservations: new Map(base.jobReservations), jobScenarios: new Map(base.jobScenarios) });
      return;
    }
    const e = assertProductionConfirmation(stored.productionImageExecution), r = e.protocol.request, q = r.quote;
    const { batch: b, jobs, ledger, audit, billingOverages } = stored.aggregate, j = jobs[0];
    const intent = stored.productionImageDispatchIntent, dispatched = b.status === "running" || b.status === "billing_unknown";
    const estimate = q.source === "manual-budget" ? null : q.estimatedCostMinor;
    const ids = r.operation === "edit" ? [...r.inputs.map((ref) => ref.assetId), ...(r.mask ? [r.mask.assetId] : [])] : [];
    const legacy = [stored.imageExecution, stored.imageDispatchIntent, stored.imageDispatchIntentFingerprint, stored.imageFixtureAttempt,
      stored.imageFixtureAttemptFingerprint, stored.imageFixtureResult, stored.imageFixtureResultFingerprint, stored.imageTaskArtifact,
      stored.imageTaskArtifactFingerprint, stored.imageTaskArtifactFailures];
    if (legacy.some((value) => value !== undefined) || stored.requestFingerprint !== imageSnapshotFingerprint(e) || stored.jobScenarios.size
      || billingOverages.length || stored.actualMinor !== 0 || b.id !== e.batchId || b.imageMode !== e.mode
      || b.tenantId !== r.tenantId || b.projectId !== r.projectId || b.constraintSnapshotId !== r.constraintSnapshotId
      || b.adapterId !== r.adapterId || b.tool !== (r.operation === "edit" ? "image-edit" : "image-generate")
      || b.idempotencyKey !== productionConfirmationKey(e) || b.confirmedBy !== e.confirmedBy || b.confirmedAt !== e.confirmedAt
      || b.createdAt !== e.confirmedAt || b.expectedOutputs !== 1 || b.estimatedCostMinor !== estimate || b.maxCostMinor !== q.maxCostMinor
      || b.currency !== q.currency || jobs.length !== 1 || !j || j.id !== r.jobId || j.imageMode !== e.mode || j.batchId !== b.id
      || j.idempotencyKey !== r.idempotencyKey || j.executorKind !== "provider" || j.adapterId !== r.adapterId || j.estimatedCostMinor !== estimate
      || j.outputIndex !== 0 || j.attempt !== 1 || j.createdAt !== e.confirmedAt
      || imageSnapshotFingerprint(j.outputAssetIds) !== imageSnapshotFingerprint(stored.productionImageArtifact ? [stored.productionImageArtifact.image.asset.id] : [])
      || (b.status === "queued" ? !["queued", "leased"].includes(j.status) : j.status !== b.status)
      || JSON.stringify(b.inputAssetIds) !== JSON.stringify(ids) || JSON.stringify(j.inputAssetIds) !== JSON.stringify(ids)
      || [j.providerRequestId, j.retryOf, j.actualCostMinor,
        j.billingResolutionId, j.billingResolvedAt, j.billingResolvedBy, j.billingEvidenceRef].some((v) => v !== undefined)
      || !["queued", "cancelled", "running", "billing_unknown"].includes(b.status)
      || (!!intent !== dispatched) || (!!stored.productionImageDispatchIntentFingerprint !== dispatched)
      || (intent ? j.startedAt !== intent.recordedAt : j.startedAt !== undefined)
      || (b.status === "billing_unknown" ? !["production-lease-expired-after-intent", "production-job-timeout-after-intent", "production-recovered-after-restart", "production-response-returned", "production-timeout", "production-transport-error", "production-response-invalid", "production-response-save-failed"].includes(j.failureCode ?? "") : j.failureCode !== undefined)
      || (["queued", "running"].includes(b.status) ? j.finishedAt !== undefined
        : !j.finishedAt || Date.parse(j.finishedAt) < Date.parse(j.startedAt ?? e.confirmedAt))
      || (b.status === "cancelled" ? stored.jobReservations.size !== 0 : stored.jobReservations.size !== 1 || stored.jobReservations.get(j.id) !== q.maxCostMinor)) throw new Error("生产任务确认或关闭执行状态不一致");
    const reservation = ledger[0], releases = ledger.slice(1), releaseNeeded = b.status === "cancelled" && q.maxCostMinor > 0;
    if (!reservation || reservation.jobId !== j.id || reservation.settlement !== "reserved" || reservation.reservedMinor !== q.maxCostMinor
      || reservation.estimatedMinor !== estimate || reservation.actualMinor !== undefined || reservation.createdAt !== e.confirmedAt
      || new Set(ledger.map((l) => l.id)).size !== ledger.length
      || ledger.some((l) => l.tenantId !== b.tenantId || l.projectId !== b.projectId || l.batchId !== b.id || l.imageMode !== e.mode || l.currency !== b.currency)
      || releases.length !== (releaseNeeded || b.status === "billing_unknown" ? 1 : 0)
      || releases.some((l) => l.estimatedMinor !== estimate || l.createdAt !== j.finishedAt || (b.status === "billing_unknown"
        ? l.settlement !== "unknown" || l.reservedMinor !== q.maxCostMinor || l.actualMinor !== undefined || l.jobId !== j.id
        : l.settlement !== "released" || l.reservedMinor !== 0 || l.actualMinor !== 0 || l.jobId !== undefined))) throw new Error("生产账本与估价/上限不一致");
    const expected = { "batch-created": { mode: e.mode, preparationId: e.preparation.id },
      "batch-confirmed": { mode: e.mode, preparationFingerprint: e.preparation.snapshotFingerprint, pricingFingerprint: e.protocol.pricingFingerprint,
        executionFingerprint: stored.requestFingerprint, requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256 },
      "budget-reserved": { reservedMinor: String(q.maxCostMinor) }, "jobs-created": { count: "1" } };
    for (const [type, metadata] of Object.entries(expected)) {
      const events = audit.filter((a) => a.eventType === type);
      if (events.length !== 1 || events[0].actorId !== e.confirmedBy || imageSnapshotFingerprint(events[0].metadata) !== imageSnapshotFingerprint(metadata)
        || Date.parse(events[0].createdAt) < Date.parse(e.confirmedAt) || Date.parse(events[0].createdAt) >= Date.parse(q.expiresAt)) throw new Error("生产确认审计不一致");
    }
    const history = stored.productionImageLeases ?? [], leaseEvents = audit.filter((a) => a.eventType === "job-leased"), expiries = audit.filter((a) => a.eventType === "job-lease-expired");
    if (Buffer.byteLength(JSON.stringify(history)) > 512 * 1024 || leaseEvents.length !== history.length
      || new Set(history.map((l) => l.leaseId)).size !== history.length) throw new Error("生产租约历史不一致");
    let previousEnd = Date.parse(e.confirmedAt), expectedExpiries = 0;
    for (const [index, lease] of history.entries()) {
      const event = leaseEvents[index], expiry = expiries.find((a) => a.metadata.leaseId === lease.leaseId);
      const metadata = { jobId: j.id, leaseId: lease.leaseId, workerId: lease.workerId, adapterId: j.adapterId, mode: e.mode, executionFingerprint: stored.requestFingerprint, expiresAt: lease.expiresAt };
      if (lease.mode !== e.mode || lease.executionFingerprint !== stored.requestFingerprint || lease.batchId !== b.id || lease.jobId !== j.id
        || Date.parse(lease.leasedAt) < previousEnd || Date.parse(lease.leasedAt) >= Date.parse(q.expiresAt)
        || Date.parse(lease.expiresAt) - Date.parse(lease.leasedAt) < 1_000
        || (!this.options.restoreValidationOnly && Date.parse(lease.expiresAt) - Date.parse(lease.leasedAt) !== this.leaseDurationMs)
        || event.actorId !== lease.actorId || event.createdAt !== lease.leasedAt || imageSnapshotFingerprint(event.metadata) !== imageSnapshotFingerprint(metadata)) throw new Error("生产租约与确认/领取审计不一致");
      if (expiry) {
        expectedExpiries++;
        if (Date.parse(expiry.createdAt) < Date.parse(lease.expiresAt) || imageSnapshotFingerprint(expiry.metadata) !== imageSnapshotFingerprint({ jobId: j.id, leaseId: lease.leaseId, action: "requeued-before-start" })) throw new Error("生产租约到期证据不一致");
        previousEnd = Date.parse(expiry.createdAt);
      } else {
        if (index !== history.length - 1 || !["leased", "cancelled", "running", "billing_unknown"].includes(j.status) || j.leaseId !== lease.leaseId || j.leaseOwnerId !== lease.workerId
          || j.leasedAt !== lease.leasedAt || j.leaseExpiresAt !== lease.expiresAt || (j.finishedAt && Date.parse(j.finishedAt) < Date.parse(lease.leasedAt))) throw new Error("生产活租约缺少实际绑定");
      }
    }
    if (expectedExpiries !== expiries.length || (j.status === "leased" && (!history.length || expiries.some((a) => a.metadata.leaseId === j.leaseId)))
      || (j.status === "queued" && [j.leaseId, j.leaseOwnerId, j.leasedAt, j.leaseExpiresAt].some((v) => v !== undefined))
      || (!history.length && [j.leaseId, j.leaseOwnerId, j.leasedAt, j.leaseExpiresAt].some((v) => v !== undefined))) throw new Error("生产租约状态不一致");
    if (history.length && expiries.some((a) => a.metadata.leaseId === history.at(-1)!.leaseId)
      && [j.leaseId, j.leaseOwnerId, j.leasedAt, j.leaseExpiresAt].some((v) => v !== undefined)) throw new Error("已到期生产租约不能残留活绑定");
    const starts = audit.filter((a) => a.eventType === "job-started"), unknowns = audit.filter((a) => a.eventType === "billing-unknown");
    if (intent) {
      const lease = history.at(-1);
      if (!lease) throw new Error("生产意图缺少原运行租约");
      assertProductionDispatchIntent(intent, stored.productionImageDispatchIntentFingerprint!, e, lease);
      const expectedStart = { jobId: j.id, leaseId: intent.leaseId, workerId: intent.workerId, productionImageDispatchIntentId: intent.id,
        intentFingerprint: stored.productionImageDispatchIntentFingerprint!, payloadChecksumSha256: intent.payloadChecksumSha256, transport: "not-connected" };
      if (starts.length !== 1 || starts[0].actorId !== intent.actorId || starts[0].createdAt !== intent.recordedAt
        || imageSnapshotFingerprint(starts[0].metadata) !== imageSnapshotFingerprint(expectedStart)) throw new Error("生产意图与启动审计不一致");
    } else if (starts.length) throw new Error("无意图不能存在生产启动审计");
    if (unknowns.length !== (b.status === "billing_unknown" ? 1 : 0) || unknowns.some((a) => a.createdAt !== j.finishedAt
      || imageSnapshotFingerprint(a.metadata) !== imageSnapshotFingerprint({ jobId: j.id, productionImageDispatchIntentId: intent!.id,
        intentFingerprint: stored.productionImageDispatchIntentFingerprint!, reason: j.failureCode }))) throw new Error("生产未知费用证据不一致");
    if (b.status === "billing_unknown" && (j.failureCode === "production-lease-expired-after-intent" ? Date.parse(j.finishedAt!) < Date.parse(j.leaseExpiresAt!)
      : j.failureCode === "production-job-timeout-after-intent" && !this.options.restoreValidationOnly ? Date.parse(j.finishedAt!) < Date.parse(j.startedAt!) + this.jobTimeoutMs : false)) throw new Error("生产未知恢复早于终止期限");
    const attempts = audit.filter(a => a.eventType === "production-image-attempted"), results = audit.filter(a => ["production-image-returned", "production-image-interrupted"].includes(a.eventType));
    const attempt = stored.productionImageAttempt, result = stored.productionImageResult;
    if (!!attempt !== !!stored.productionImageAttemptFingerprint || !!result !== !!stored.productionImageResultFingerprint
      || (attempt && !intent) || (result && (!attempt || b.status !== "billing_unknown"))
      || attempts.length !== (attempt ? 1 : 0) || results.length !== (result ? 1 : 0)) throw new Error("生产尝试响应缺少完整任务绑定");
    if (attempt) {
      assertProductionImageAttempt(attempt, stored.productionImageAttemptFingerprint!, e, history.at(-1), intent);
      const event = attempts[0];
      if (event.actorId !== attempt.actorId || event.createdAt !== attempt.attemptedAt || imageSnapshotFingerprint(event.metadata) !== imageSnapshotFingerprint({ jobId: j.id,
        attemptId: attempt.id, attemptFingerprint: stored.productionImageAttemptFingerprint!, intentFingerprint: attempt.intentFingerprint, transport: attempt.transport })
        || (j.finishedAt && Date.parse(j.finishedAt) < Date.parse(attempt.attemptedAt))) throw new Error("生产尝试审计不一致");
    }
    if (result) {
      assertProductionImageResult(result, stored.productionImageResultFingerprint!, e, attempt!);
      const at = result.kind === "returned" ? result.receivedAt : result.interruptedAt, event = results[0];
      if (event.actorId !== attempt!.actorId || event.createdAt !== at || Date.parse(at) < Date.parse(j.finishedAt!)
        || event.eventType !== (result.kind === "returned" ? "production-image-returned" : "production-image-interrupted")
        || imageSnapshotFingerprint(event.metadata) !== imageSnapshotFingerprint({ jobId: j.id, attemptId: result.attemptId, resultFingerprint: stored.productionImageResultFingerprint!, kind: result.kind })) throw new Error("生产响应审计不一致");
    }
    if (["production-response-returned", "production-timeout", "production-transport-error", "production-response-invalid", "production-response-save-failed"].includes(j.failureCode ?? "")
      && (!result || j.finishedAt !== (result.kind === "returned" ? result.receivedAt : result.interruptedAt)
        || j.failureCode !== (result.kind === "returned" ? "production-response-returned" : result.outcome.failureCode))) throw new Error("生产未知响应结论不一致");
    const artifacts = audit.filter(a => a.eventType === "production-image-artifact-verified"), artifact = stored.productionImageArtifact;
    if (!!artifact !== !!stored.productionImageArtifactFingerprint || artifacts.length !== (artifact ? 1 : 0)) throw new Error("生产产物缺少任务/审计绑定");
    if (artifact) {
      assertProductionImageArtifact(stored, artifact);
      if (stored.productionImageArtifactFingerprint !== imageSnapshotFingerprint(artifact) || artifacts[0].actorId !== artifact.committedBy
        || artifacts[0].createdAt !== artifact.committedAt || imageSnapshotFingerprint(artifacts[0].metadata) !== imageSnapshotFingerprint({ jobId: j.id,
          artifactFingerprint: stored.productionImageArtifactFingerprint, assetId: artifact.image.asset.id, checksumSha256: artifact.image.checksumSha256 })) throw new Error("生产产物审计损坏");
    }
    const cancelled = audit.filter((a) => a.eventType === "batch-cancelled"), released = audit.filter((a) => a.eventType === "budget-released");
    if (cancelled.length !== (b.status === "cancelled" ? 1 : 0) || released.length !== (releaseNeeded ? 1 : 0)
      || cancelled.some((a) => a.createdAt !== j.finishedAt || a.metadata.previousStatus !== "queued")
      || released.some((a) => a.createdAt !== j.finishedAt || a.metadata.releasedMinor !== String(q.maxCostMinor))
      || audit.length !== 4 + cancelled.length + released.length + leaseEvents.length + expiries.length + starts.length + unknowns.length + attempts.length + results.length + artifacts.length || new Set(audit.map((a) => a.id)).size !== audit.length
      || audit.some((a) => a.tenantId !== b.tenantId || a.projectId !== b.projectId || a.batchId !== b.id)) throw new Error("生产取消审计不一致");
  }

  private recoverExpiredLeases(actorId: string): boolean {
    const now = this.clock();
    let recovered = false;
    for (const stored of this.batches.values()) {
      // Production expiry is an explicit, independently authorized command.
      // Restore/old mock/local paths must not mutate its leases implicitly.
      if (stored.productionImageExecution || stored.lockedProductionImageExecution) continue;
      let batchChanged = false;
      for (const job of this.latestJobs(stored.aggregate.jobs)) {
        if (!["leased", "running"].includes(job.status) || !job.leaseExpiresAt) continue;
        if (Date.parse(job.leaseExpiresAt) > now) continue;
        if (job.status === "leased") {
          const {
            leaseId,
            leaseOwnerId: _leaseOwnerId,
            leasedAt: _leasedAt,
            leaseExpiresAt: _leaseExpiresAt,
            ...unleased
          } = job;
          this.replaceJob(stored.aggregate, { ...unleased, status: "queued" });
          stored.aggregate.audit.push(this.audit(stored.aggregate.batch, actorId, "job-lease-expired", {
            jobId: job.id,
            leaseId: leaseId ?? "missing",
            action: "requeued-before-start",
          }));
        } else {
          stored.aggregate.audit.push(this.audit(stored.aggregate.batch, actorId, "job-lease-expired", {
            jobId: job.id,
            leaseId: job.leaseId ?? "missing",
            action: "billing-review-after-start",
          }));
          this.finishJob(stored, job, "billing-unknown", actorId, "lease-expired-after-start");
        }
        recovered = true;
        batchChanged = true;
      }
      if (batchChanged) {
        this.refreshBatchStatus(stored);
        stored.aggregate = RunBatchAggregateSchema.parse(stored.aggregate);
      }
    }
    return recovered;
  }

  private activeJobs(): Array<{ batch: RunBatch; job: RunJob }> {
    const active: Array<{ batch: RunBatch; job: RunJob }> = [];
    for (const stored of this.batches.values()) {
      for (const job of this.latestJobs(stored.aggregate.jobs)) {
        if (["leased", "running"].includes(job.status)) active.push({ batch: stored.aggregate.batch, job });
      }
    }
    return active;
  }

  private providerLimit(adapterId: string): ProviderExecutionLimitConfig {
    return this.providerLimits.get(adapterId) ?? {
      adapterId,
      maxConcurrentJobs: this.maxConcurrentJobs,
    };
  }

  private providerStartsInWindow(adapterId: string, now: number, windowMs: number): RunAuditEvent[] {
    const windowStart = now - windowMs;
    return [...this.batches.values()]
      .flatMap((stored) => stored.aggregate.audit)
      .filter((event) => event.eventType === "job-leased"
        && event.metadata.adapterId === adapterId
        && Date.parse(event.createdAt) > windowStart)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  private activeRetryAfterMs(active: Array<{ job: RunJob }>, now: number): number {
    const expiries = active
      .map(({ job }) => job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) - now : this.leaseDurationMs)
      .filter((remaining) => remaining > 0);
    return Math.max(1, expiries.length > 0 ? Math.min(...expiries) : this.leaseDurationMs);
  }

  private finishJob(
    stored: StoredBatch,
    job: RunJob,
    outcome: "succeeded" | "failed" | "timed-out" | "billing-unknown",
    actorId: string,
    failureCode?: string,
  ): void {
    const batch = stored.aggregate.batch;
    const finishedAt = new Date(this.clock()).toISOString();
    if (outcome === "billing-unknown") {
      const reservation = stored.jobReservations.get(job.id) ?? 0;
      this.replaceJob(stored.aggregate, {
        ...job,
        status: "billing_unknown",
        ...(failureCode ? { failureCode } : {}),
        finishedAt,
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
      additionalMinor: String(Math.max(0, actualMinor - reservedMinor)),
    }));
  }

  private refreshBatchStatus(stored: StoredBatch): void {
    if (stored.aggregate.batch.status === "cancelled") return;
    const jobs = this.latestJobs(stored.aggregate.jobs);
    if (jobs.length === 0) return;
    let status: RunBatch["status"];
    if (jobs.some((job) => job.status === "billing_unknown")) status = "billing_unknown";
    else if (jobs.some((job) => job.status === "running")) status = "running";
    else if (jobs.some((job) => ["queued", "leased"].includes(job.status))) status = "queued";
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

  private validateBatchInputs(batch: RunBatch): void {
    this.assertMockBatch(batch);
    this.options.validateInputs?.(batch.tenantId, {
      projectId: batch.projectId,
      constraintSnapshotId: batch.constraintSnapshotId,
      tool: "product-retouch",
      inputAssetIds: [...batch.inputAssetIds],
      expectedOutputs: batch.expectedOutputs,
      maxCostMinor: batch.maxCostMinor,
      currency: batch.currency,
      idempotencyKey: batch.idempotencyKey,
      mockScenario: batch.mockScenario!,
    });
  }

  private assertMockBatch(batch: RunBatch): asserts batch is RunBatch & { estimatedCostMinor: number } {
    if (batch.tool !== "product-retouch" || batch.imageMode || batch.estimatedCostMinor === null) throw new RunKernelError(409, "image_execution_not_configured", "图片任务不能通过旧模拟执行入口处理");
  }
  private requireImageExecution(stored: StoredBatch): ConfirmedImageExecution {
    if (stored.productionImageExecution || stored.aggregate.batch.imageMode) throw new RunKernelError(503, "production_image_execution_not_configured", "生产任务领取与发送尚未启用");
    if (!stored.imageExecution || stored.aggregate.batch.tool === "product-retouch") throw new RunKernelError(422, "image_task_required", "需要已确认的图片任务");
    if (typeof this.options.validateImageTask !== "function") throw new RunKernelError(503, "image_lease_policy_not_configured", "尚未配置可信图片租约政策");
    return stored.imageExecution;
  }
  private validateImageTask(principal: RunPrincipal, stored: StoredBatch, intent?: ImageDispatchIntent, additionalMetadataBytes = 0): void {
    const execution = this.requireImageExecution(stored);
    try {
      validateImageProviderRequest(execution.preparation.connection, execution.request, new Date(this.clock()).toISOString());
      if (this.options.validateImageTask!(principal, ConfirmedImageExecutionSchema.parse(execution), intent ? ImageDispatchIntentSchema.parse(intent) : undefined, additionalMetadataBytes) !== undefined) {
        throw new RunKernelError(403, "image_lease_policy_invalid", "图片租约政策必须同步确认权威状态");
      }
      validateImageProviderRequest(execution.preparation.connection, execution.request, new Date(this.clock()).toISOString());
    } catch (error) {
      if (error instanceof ImageProviderContractError) throw new RunKernelError(422, error.code, "图片租约合同核验失败");
      throw error;
    }
  }
  private assertImageIntent(stored: StoredBatch, execution: ConfirmedImageExecution, job: RunJob): void {
    const intent = stored.imageDispatchIntent;
    if (!intent) {
      if (stored.imageDispatchIntentFingerprint || !["queued", "leased", "cancelled"].includes(job.status)) throw new Error("图片任务缺少派发意图");
      return;
    }
    if (stored.imageDispatchIntentFingerprint !== imageSnapshotFingerprint(intent) || !["running", "billing_unknown", "failed", "succeeded"].includes(job.status)
      || intent.jobId !== job.id || intent.batchId !== job.batchId || intent.workerId !== job.leaseOwnerId || intent.leaseId !== job.leaseId
      || intent.recordedAt !== job.startedAt || Date.parse(intent.recordedAt) < Date.parse(execution.confirmedAt)
      || !job.leasedAt || !job.leaseExpiresAt || Date.parse(intent.recordedAt) < Date.parse(job.leasedAt)
      || Date.parse(intent.recordedAt) >= Date.parse(job.leaseExpiresAt) || Date.parse(intent.recordedAt) >= Date.parse(execution.request.quote.expiresAt)
      || intent.executionFingerprint !== stored.requestFingerprint || intent.requestFingerprint !== execution.requestFingerprint
      || intent.payloadChecksumSha256 !== execution.payloadChecksumSha256 || intent.payloadByteSize !== execution.payloadByteSize || intent.contentType !== execution.contentType
      || intent.inputTransformsFingerprint !== imageSnapshotFingerprint(execution.transformedInputs)
      || !stored.aggregate.audit.some((event) => event.eventType === "job-leased" && event.actorId === intent.actorId && event.metadata.leaseId === intent.leaseId
        && event.metadata.jobId === job.id && event.metadata.workerId === intent.workerId && event.createdAt === job.leasedAt)
      || !stored.aggregate.audit.some((event) => event.eventType === "job-started" && event.actorId === intent.actorId && event.metadata.imageDispatchIntentId === intent.id
        && event.metadata.jobId === job.id && event.metadata.leaseId === intent.leaseId && event.metadata.workerId === intent.workerId
        && event.metadata.payloadChecksumSha256 === intent.payloadChecksumSha256 && event.metadata.transport === "not-connected")) throw new Error("图片派发意图、租约或审计不一致");
  }
  private assertImageFixtureEvidence(stored: StoredBatch, execution: ConfirmedImageExecution, job: RunJob): void {
    const intent = stored.imageDispatchIntent, attempt = stored.imageFixtureAttempt, result = stored.imageFixtureResult;
    if (!attempt) {
      if (stored.imageFixtureAttemptFingerprint || result || stored.imageFixtureResultFingerprint) throw new Error("图片本地响应缺少传输尝试");
      return;
    }
    if (!intent || stored.imageFixtureAttemptFingerprint !== imageSnapshotFingerprint(attempt) || attempt.intentId !== intent.id
      || attempt.actorId !== intent.actorId || attempt.workerId !== intent.workerId || attempt.leaseId !== intent.leaseId || attempt.jobId !== job.id || attempt.batchId !== job.batchId
      || attempt.executionFingerprint !== stored.requestFingerprint || attempt.payloadChecksumSha256 !== execution.payloadChecksumSha256
      || Date.parse(attempt.attemptedAt) < Date.parse(intent.recordedAt) || Date.parse(attempt.attemptedAt) >= Date.parse(job.leaseExpiresAt!)
      || Date.parse(attempt.attemptedAt) >= Date.parse(execution.request.quote.expiresAt)
      || !stored.aggregate.audit.some((event) => event.eventType === "image-fixture-attempted" && event.actorId === attempt.actorId && event.metadata.jobId === job.id && event.metadata.attemptId === attempt.id && event.metadata.intentId === intent.id)) throw new Error("图片本地传输证据错配");
    if (!result) { if (stored.imageFixtureResultFingerprint) throw new Error("图片响应摘要孤立"); return; }
    const outcome = result.outcome;
    if (stored.imageFixtureResultFingerprint !== imageSnapshotFingerprint(result) || result.attemptId !== attempt.id || Date.parse(result.receivedAt) < Date.parse(attempt.attemptedAt)
      || outcome.tenantId !== execution.request.tenantId || outcome.projectId !== execution.request.projectId || outcome.jobId !== job.id || outcome.connectionId !== execution.request.connectionId
      || outcome.requestFingerprint !== execution.requestFingerprint || outcome.billing.state !== "unknown" || job.providerRequestId !== outcome.providerRequestId
      || !["billing_unknown", "failed", "succeeded"].includes(job.status)
      || (result.kind === "interrupted" && (outcome.providerStatus !== "unknown" || outcome.artifactStatus !== "absent" || outcome.failureCode !== result.failureCode))
      || !stored.aggregate.audit.some((event) => event.eventType === `image-fixture-${result.kind}` && event.actorId === attempt.actorId && event.metadata.jobId === job.id && event.metadata.attemptId === attempt.id && event.metadata.resultId === result.id)) throw new Error("图片本地响应证据错配");
  }
  private validateImageArtifact(principal: RunPrincipal, stored: StoredBatch, record?: GeneratedImageRecord, additionalMetadataBytes = 0): void {
    const result = stored.imageFixtureResult;
    if (typeof this.options.validateImageArtifact !== "function") throw new RunKernelError(503, "image_output_policy_not_configured", "尚未配置持久化产物授权政策");
    if (result?.kind !== "returned" || this.options.validateImageArtifact(principal, ConfirmedImageExecutionSchema.parse(stored.imageExecution!),
      ImageFixtureResultSchema.parse(result) as Extract<ImageFixtureResult, { kind: "returned" }>, record, additionalMetadataBytes) !== undefined) {
      throw new RunKernelError(403, "image_output_policy_invalid", "产物政策必须同步确认实际证据");
    }
  }
  private assertImageArtifactEvidence(stored: StoredBatch, job: RunJob): void {
    const artifact = stored.imageTaskArtifact, result = stored.imageFixtureResult, attempt = stored.imageFixtureAttempt;
    if (!artifact && stored.imageTaskArtifactFingerprint) throw new Error("产物摘要没有对应记录");
    if (artifact && (!attempt || result?.kind !== "returned" || stored.imageTaskArtifactFingerprint !== imageSnapshotFingerprint(artifact)
      || artifact.jobId !== job.id || artifact.batchId !== job.batchId || artifact.attemptId !== attempt.id || artifact.resultId !== result.id
      || artifact.executionFingerprint !== stored.requestFingerprint || artifact.resultFingerprint !== stored.imageFixtureResultFingerprint
      || artifact.committedBy !== attempt.actorId || Date.parse(artifact.committedAt) < Date.parse(result.receivedAt)
      || result.outcome.artifactStatus !== "pending-validation" || result.outcome.failureCode !== undefined
      || !["billing_unknown", "succeeded"].includes(job.status)
      || !stored.aggregate.audit.some((event) => event.eventType === "image-artifact-verified" && event.actorId === artifact.committedBy && event.metadata.jobId === job.id
        && event.metadata.assetId === artifact.assetId && event.metadata.resultId === artifact.resultId && event.metadata.generatedRecordFingerprint === artifact.generatedRecordFingerprint))) throw new Error("产物、实际响应或任务审计错配");
    const seen = new Set<string>();
    for (const failure of stored.imageTaskArtifactFailures ?? []) {
      const key = `${failure.stage}:${failure.code}`;
      if (!attempt || result?.kind !== "returned" || failure.jobId !== job.id || failure.resultId !== result.id || failure.resultFingerprint !== stored.imageFixtureResultFingerprint
        || failure.recordedBy !== attempt.actorId || Date.parse(failure.recordedAt) < Date.parse(result.receivedAt) || seen.has(key)
        || !stored.aggregate.audit.some((event) => event.eventType === "image-artifact-rejected" && event.actorId === failure.recordedBy && event.metadata.jobId === job.id
          && event.metadata.resultId === failure.resultId && event.metadata.stage === failure.stage && event.metadata.code === failure.code)) throw new Error("产物失败证据损坏");
      seen.add(key);
    }
  }
  private assertFrozenImageExecution(input: ConfirmedImageExecution): void {
    const execution = ConfirmedImageExecutionSchema.parse(input);
    const preparation = execution.preparation;
    if (execution.requestFingerprint !== imageConfirmationFingerprint(preparation.connection, execution.request)
      || preparation.selectionFingerprint !== imageSnapshotFingerprint(preparation.selection)
      || preparation.snapshotFingerprint !== imageSnapshotFingerprint({ connection: preparation.connection, requestTemplate: preparation.requestTemplate, constraint: preparation.constraint, pricing: preparation.pricing })
      || execution.request.constraintChecksumSha256 !== createHash("sha256").update(JSON.stringify(preparation.constraint)).digest("hex")) {
      throw new Error("图片执行确认摘要损坏");
    }
    validateImageProviderRequest(preparation.connection, execution.request, execution.confirmedAt);
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
