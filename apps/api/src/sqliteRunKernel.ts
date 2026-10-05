import type { IncomingMessage } from "node:http";
import { GeneratedImageRecordSchema, ImageFixtureResultSchema, ProductionImageResultSchema, type RunKernelSnapshot, type GeneratedImageRecord, type ImageFixtureResult, type ProductionImageResult } from "@canvas/contracts";
import { imageSnapshotFingerprint } from "./imageProviderContract";
import { assetMetadataFingerprint } from "./verifiedAssets";
import { assertImageArtifactRecord } from "./imageArtifactIntegrity";
import { assertProductionImageRawResponse } from "./productionImageResponse";
import { assertLockedImageRawResponse } from "./lockedProductionImageResponse";
import { LockedProductionImageResultSchema, type LockedProductionImageResult } from "@canvas/contracts";
import { assertProductionImageArtifact } from "./productionImageArtifactIntegrity";
import { type ProductionImageArtifact, type ProductionImageBillingRecord } from "@canvas/contracts";
import { InMemoryRunKernel, RunKernelError, type ProjectBudgetConfig, type RunKernelOptions, type RunKernelPort, type RunPrincipal } from "./runKernel";
import { SqliteRunKernelStateStore, SqliteStateStoreError } from "./sqliteRunKernelStore";

type Options = Omit<RunKernelOptions, "stateStore" | "recoverRunningJobsOnRestore"> & { stateStore: SqliteRunKernelStateStore };

// Each command reloads under BEGIN IMMEDIATE. Never reuse stale process-local budgets or leases.
export class SqliteRunKernel implements RunKernelPort {
  constructor(private readonly options: Options) { this.run(() => undefined); }
  usesStateStore(store: SqliteRunKernelStateStore): boolean { return this.options.stateStore === store; }

  commitProductionImageBilling(p: RunPrincipal, record: ProductionImageBillingRecord) {
    const policy = this.options.productionImageBillingPolicy;
    if (!policy) throw new RunKernelError(503, "production_image_billing_not_configured", "生产核账默认关闭");
    const check = () => {
      this.strictArtifactPolicy(() => policy.usesStateStore(this.options.stateStore));
      this.strictArtifactPolicy(() => policy.authorizeScope(p, record.snapshot.projectId, !!record.decision));
      this.strictArtifactPolicy(() => policy.validateCommit(p, structuredClone(record)));
    };
    check();
    return this.options.stateStore.transaction(() => {
      const result = this.run(k => k.commitProductionImageBilling(p, record));
      this.run(() => undefined); check(); return result;
    });
  }

  // Pure validation of a snapshot already loaded by an independently scoped
  // internal service. No SQL reads, writes, lease recovery or task permission.
  validateProductionBillingSnapshot(snapshot: RunKernelSnapshot): void {
    new InMemoryRunKernel({ ...this.options, budgets: snapshot.budgets, recoverRunningJobsOnRestore: false, restoreValidationOnly: true,
      stateStore: { load: () => structuredClone(snapshot), save: () => { throw new Error("只读核账快照不得保存"); } } });
    for (const stored of snapshot.batches) for (const lease of [...stored.productionImageLeases ?? [], ...stored.lockedProductionImageLeases ?? []]) {
      if (Date.parse(lease.expiresAt) - Date.parse(lease.leasedAt) !== (this.options.leaseDurationMs ?? 30_000)) throw new Error("原租约期限与实际内核配置不一致");
    }
    for (const stored of snapshot.batches.filter(b => b.productionImageExecution || b.lockedProductionImageExecution)) {
      const job = stored.aggregate.jobs[0];
      if (["production-job-timeout-after-intent", "locked-job-timeout-after-intent"].includes(job.failureCode ?? "")
        && Date.parse(job.finishedAt!) < Date.parse(job.startedAt!) + (this.options.jobTimeoutMs ?? 30_000)) throw new Error("原任务超时早于实际内核期限");
    }
    for (const configured of this.options.budgets) {
      const actual = snapshot.budgets.find(b => b.tenantId === configured.tenantId && b.projectId === configured.projectId);
      if (!actual || actual.currency !== configured.currency || actual.limitMinor !== configured.limitMinor) throw new Error("实际项目预算配置不一致");
    }
  }

  authenticate(request: IncomingMessage): RunPrincipal | null { return this.options.authorizer.authenticate(request); }
  registerLocalProject(budget: ProjectBudgetConfig): void { this.run((kernel) => kernel.registerLocalProject(budget)); }
  createBatch: RunKernelPort["createBatch"] = (...args) => this.run((kernel) => kernel.createBatch(...args));
  stageConfirmedImageBatch: InMemoryRunKernel["stageConfirmedImageBatch"] = (...args) => this.run((kernel) => kernel.stageConfirmedImageBatch(...args));
  stageConfirmedProductionImageBatch: InMemoryRunKernel["stageConfirmedProductionImageBatch"] = (...args) => this.run((kernel) => kernel.stageConfirmedProductionImageBatch(...args));
  stageConfirmedLockedProductionImageBatch: InMemoryRunKernel["stageConfirmedLockedProductionImageBatch"] = (p, e) => {
    const check = () => this.strictArtifactPolicy(() => this.options.validateLockedProductionImageConfirmation?.(p, structuredClone(e)));
    check();
    return this.options.stateStore.transaction(() => {
      const result = this.run(k => k.stageConfirmedLockedProductionImageBatch(p, e));
      const verify = () => {
        this.run(() => undefined);
        const actual = this.options.stateStore.load()?.batches.find(b => b.aggregate.batch.id === e.batchId);
        if (!actual || imageSnapshotFingerprint(actual.lockedProductionImageExecution) !== imageSnapshotFingerprint(e)
          || actual.requestFingerprint !== imageSnapshotFingerprint(e) || imageSnapshotFingerprint(actual.aggregate) !== imageSnapshotFingerprint(result))
          throw new Error("实际锁区任务写后漂移");
      };
      verify(); check(); verify(); return result;
    });
  };
  claimProductionImageBatch: InMemoryRunKernel["claimProductionImageBatch"] = (p, project, batch, input) => this.productionLeaseCommand(p, project, batch, "claim", (kernel) => {
    return kernel.claimProductionImageBatch(p, project, batch, input);
  }, (result, kernel) => { for (const lease of result.leases) kernel.inspectProductionImageLease(p, project, batch, lease.jobId, { workerId: lease.workerId, leaseId: lease.leaseId }); });
  claimLockedProductionImageBatch: InMemoryRunKernel["claimLockedProductionImageBatch"] = (p, project, batch, input) =>
    this.lockedLeaseCommand(p, project, batch, "claim", k => k.claimLockedProductionImageBatch(p, project, batch, input), (r, k) => {
      for (const l of r.leases) k.inspectLockedProductionImageLease(p, project, batch, l.jobId, { workerId: l.workerId, leaseId: l.leaseId }); });
  inspectLockedProductionImageLease: InMemoryRunKernel["inspectLockedProductionImageLease"] = (p, project, batch, job, input) =>
    this.lockedLeaseCommand(p, project, batch, "inspect", k => k.inspectLockedProductionImageLease(p, project, batch, job, input));
  reconcileLockedProductionImageBatch: InMemoryRunKernel["reconcileLockedProductionImageBatch"] = (p, project, batch) =>
    this.lockedLeaseCommand(p, project, batch, "reconcile", k => k.reconcileLockedProductionImageBatch(p, project, batch));
  cancelLockedProductionImageBatch: InMemoryRunKernel["cancelLockedProductionImageBatch"] = (p, project, batch) =>
    this.lockedLeaseCommand(p, project, batch, "cancel", k => k.cancelLockedProductionImageBatch(p, project, batch));
  inspectProductionImageLease: InMemoryRunKernel["inspectProductionImageLease"] = (p, project, batch, job, input) => this.productionLeaseCommand(p, project, batch, "inspect",
    (kernel) => kernel.inspectProductionImageLease(p, project, batch, job, input), (_result, kernel) => { kernel.inspectProductionImageLease(p, project, batch, job, input); });
  inspectLockedProductionImageStart: InMemoryRunKernel["inspectLockedProductionImageStart"] = (p, project, batch, job, input) => {
    this.lockedStartScope(p, project);
    return this.lockedLeaseCommand(p, project, batch, "start-history", k => k.inspectLockedProductionImageStart(p, project, batch, job, input));
  };
  startLockedProductionImageJob: InMemoryRunKernel["startLockedProductionImageJob"] = (p, project, batch, job, input, intent) => {
    this.lockedStartScope(p, project);
    return this.lockedLeaseCommand(p, project, batch, "start-history", k => k.startLockedProductionImageJob(p, project, batch, job, input, intent), (r, k) => {
      if (r.started) k.assertLockedProductionImageStartCommit(p, project, batch, job, input);
      else k.inspectLockedProductionImageStart(p, project, batch, job, input);
    });
  };
  private lockedStartScope(p: RunPrincipal, project: string) {
    const policy = this.options.lockedProductionImageStartPolicy;
    if (!policy) throw new RunKernelError(503, "locked_start_not_configured", "保护启动默认关闭");
    this.strictArtifactPolicy(() => policy.usesStateStore(this.options.stateStore)); this.strictArtifactPolicy(() => policy.authorizeScope(p, project));
  }
  private lockedResponseScope(p: RunPrincipal, project: string) {
    const policy = this.options.lockedProductionImageResponsePolicy;
    if (!policy) throw new RunKernelError(503, "locked_response_not_configured", "保护响应默认关闭");
    this.strictArtifactPolicy(() => policy.usesStateStore(this.options.stateStore)); this.strictArtifactPolicy(() => policy.authorizeScope(structuredClone(p), project));
  }
  inspectLockedImageAttempt: InMemoryRunKernel["inspectLockedImageAttempt"] = (p, project, batch, job, input) => {
    this.lockedResponseScope(p, project);
    return this.lockedLeaseCommand(p, project, batch, "start-history", k => k.inspectLockedImageAttempt(p, project, batch, job, input));
  };
  beginLockedImageAttempt: InMemoryRunKernel["beginLockedImageAttempt"] = (p, project, batch, job, input, a) => {
    this.lockedResponseScope(p, project);
    return this.lockedLeaseCommand(p, project, batch, "start-history", k => k.beginLockedImageAttempt(p, project, batch, job, input, a), (_r, k) => k.assertLockedImageAttemptCurrent(p, project, batch, job, input));
  };
  assertLockedImageAttemptCurrent: InMemoryRunKernel["assertLockedImageAttemptCurrent"] = (p, project, batch, job, input) => {
    this.lockedResponseScope(p, project);
    return this.lockedLeaseCommand(p, project, batch, "start-history", k => k.assertLockedImageAttemptCurrent(p, project, batch, job, input));
  };
  recordLockedImageResult(p: RunPrincipal, project: string, batch: string, job: string, input: Parameters<InMemoryRunKernel["recordLockedImageResult"]>[4], incoming: LockedProductionImageResult, body?: Buffer) {
    this.lockedResponseScope(p, project); const result = LockedProductionImageResultSchema.parse(incoming);
    if (result.kind === "returned" && !Buffer.isBuffer(body)) throw new RunKernelError(409, "locked_response_body_required", "原包须共同保存");
    return this.lockedLeaseCommand(p, project, batch, "start-history", k => {
      const c = k.inspectLockedImageAttempt(p, project, batch, job, input);
      if (result.kind === "returned") { const parsed = assertLockedImageRawResponse(result, c.execution, c.lease, c.intent, c.attempt, body!); parsed.candidate?.body.fill(0); }
      const aggregate = k.recordLockedImageResult(p, project, batch, job, input, result);
      if (result.kind === "returned") this.options.stateStore.saveLockedProductionImageResponse(result, body!, () => {
        const before = imageSnapshotFingerprint(this.options.stateStore.load()); this.lockedResponseScope(p, project);
        this.strictArtifactPolicy(() => this.options.lockedProductionImageResponsePolicy!.validateResult(p, c.execution, c.lease, c.intent!, c.attempt!, result));
        if (imageSnapshotFingerprint(this.options.stateStore.load()) !== before) throw new Error("原包实际写后任务漂移");
      });
      return aggregate;
    }, (_r, k) => k.assertLockedImageResponseCommit(p, project, batch, job, input));
  }
  reconcileProductionImageBatch: InMemoryRunKernel["reconcileProductionImageBatch"] = (p, project, batch) => this.productionLeaseCommand(p, project, batch, "reconcile",
    (kernel) => kernel.reconcileProductionImageBatch(p, project, batch));
  inspectProductionImageStart: InMemoryRunKernel["inspectProductionImageStart"] = (p, project, batch, job, input) => {
    this.productionStartScope(p, project);
    return this.productionLeaseCommand(p, project, batch, "history", (kernel) => kernel.inspectProductionImageStart(p, project, batch, job, input),
      (_result, kernel) => { kernel.inspectProductionImageStart(p, project, batch, job, input); });
  };
  startProductionImageJob: InMemoryRunKernel["startProductionImageJob"] = (p, project, batch, job, input, intent) => {
    this.productionStartScope(p, project);
    return this.productionLeaseCommand(p, project, batch, "history", (kernel) => kernel.startProductionImageJob(p, project, batch, job, input, intent),
      (result, kernel) => { if (result.started) kernel.assertProductionImageStartCommit(p, project, batch, job, input);
        else kernel.inspectProductionImageStart(p, project, batch, job, input); });
  };
  inspectProductionImageAttempt: InMemoryRunKernel["inspectProductionImageAttempt"] = (p, project, batch, job, input) => {
    this.productionResponseScope(p, project);
    return this.productionLeaseCommand(p, project, batch, "history", k => k.inspectProductionImageAttempt(p, project, batch, job, input));
  };
  beginProductionImageAttempt: InMemoryRunKernel["beginProductionImageAttempt"] = (p, project, batch, job, input, attempt) => {
    this.productionResponseScope(p, project);
    return this.productionLeaseCommand(p, project, batch, "history", k => k.beginProductionImageAttempt(p, project, batch, job, input, attempt),
      (_r, k) => k.assertProductionImageAttemptCurrent(p, project, batch, job, input));
  };
  assertProductionImageAttemptCurrent: InMemoryRunKernel["assertProductionImageAttemptCurrent"] = (p, project, batch, job, input) => {
    this.productionResponseScope(p, project);
    return this.productionLeaseCommand(p, project, batch, "history", k => k.assertProductionImageAttemptCurrent(p, project, batch, job, input));
  };
  recordProductionImageResult(p: RunPrincipal, project: string, batch: string, job: string,
    input: Parameters<InMemoryRunKernel["recordProductionImageResult"]>[4], incoming: ProductionImageResult, body?: Buffer) {
    this.productionResponseScope(p, project);
    const result = ProductionImageResultSchema.parse(incoming);
    if (result.kind === "returned" && !Buffer.isBuffer(body)) throw new RunKernelError(409, "production_image_response_body_required", "响应必须与原始正文共同保存");
    return this.productionLeaseCommand(p, project, batch, "history", k => {
      const current = k.inspectProductionImageAttempt(p, project, batch, job, input);
      if (result.kind === "returned") {
        const verified = assertProductionImageRawResponse(result, current.execution, current.lease, current.intent, current.attempt, body!);
        verified.candidate?.body.fill(0);
      }
      const aggregate = k.recordProductionImageResult(p, project, batch, job, input, result);
      if (result.kind === "returned") this.options.stateStore.saveProductionImageResponse(result, body!);
      return aggregate;
    }, (_r, k) => k.assertProductionImageResponseCommit(p, project, batch, job, input));
  }
  inspectProductionImageArtifact: InMemoryRunKernel["inspectProductionImageArtifact"] = (p, project, batch, job, input) => {
    this.productionArtifactScope(p, project);
    return this.productionLeaseCommand(p, project, batch, "history", k => k.inspectProductionImageArtifact(p, project, batch, job, input));
  };
  attachProductionImageArtifact(p: RunPrincipal, project: string, batch: string, job: string,
    input: Parameters<InMemoryRunKernel["inspectProductionImageArtifact"]>[4], record: ProductionImageArtifact) {
    this.productionArtifactScope(p, project);
    return this.options.stateStore.transaction(() => {
      const saved = this.options.stateStore.loadProductionImageArtifact(p.tenantId, project, record.mode, job);
      if (!saved || imageSnapshotFingerprint(saved) !== imageSnapshotFingerprint(record)) throw new RunKernelError(409, "production_image_artifact_not_saved", "产物须同一事务先保存");
      const result = this.run(inner => inner.attachProductionImageArtifact(p, project, batch, job, input, record), { principal: p, record });
      this.run(k => { k.inspectProductionImageArtifact(p, project, batch, job, input); k.assertProductionImageTask(p, project, batch, "history"); });
      this.productionArtifactScope(p, project);
      this.strictArtifactPolicy(() => this.options.productionImageArtifactPolicy!.validateCommit(p, record));
      return result;
    });
  }
  private strictArtifactPolicy(check: () => unknown): void {
    let value: unknown; try { value = check(); } catch { throw new RunKernelError(503, "production_image_artifact_policy_unavailable", "生产产物政策不可用"); }
    if (value && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => undefined);
    if (value !== true) throw new RunKernelError(403, "production_image_artifact_permission_denied", "生产产物须严格同步许可");
  }
  private productionArtifactScope(p: RunPrincipal, project: string): void {
    const policy = this.options.productionImageArtifactPolicy;
    if (!policy || !this.options.stateStore.supportsProductionImageArtifacts()) throw new RunKernelError(503, "production_image_artifact_not_configured", "生产产物默认关闭");
    this.strictArtifactPolicy(() => policy.usesStateStore(this.options.stateStore)); this.strictArtifactPolicy(() => policy.authorizeScope(p, project));
    this.productionResponseScope(p, project);
  }
  claimImageBatch: InMemoryRunKernel["claimImageBatch"] = (...args) => this.run((kernel) => kernel.claimImageBatch(...args));
  startImageJob: InMemoryRunKernel["startImageJob"] = (...args) => this.run((kernel) => kernel.startImageJob(...args));
  inspectImageLease: InMemoryRunKernel["inspectImageLease"] = (...args) => this.run((kernel) => kernel.inspectImageLease(...args));
  reconcileImageBatch: InMemoryRunKernel["reconcileImageBatch"] = (...args) => this.run((kernel) => kernel.reconcileImageBatch(...args));
  beginImageFixtureAttempt: InMemoryRunKernel["beginImageFixtureAttempt"] = (...args) => this.run((kernel) => kernel.beginImageFixtureAttempt(...args));
  inspectImageArtifact: InMemoryRunKernel["inspectImageArtifact"] = (...args) => this.run((kernel) => kernel.inspectImageArtifact(...args));
  recordImageArtifactFailure: InMemoryRunKernel["recordImageArtifactFailure"] = (...args) => this.run((kernel) => kernel.recordImageArtifactFailure(...args));
  attachImageArtifact(principal: RunPrincipal, incoming: GeneratedImageRecord) {
    const record = GeneratedImageRecordSchema.parse(incoming);
    return this.run((kernel) => {
      const saved = this.options.stateStore.loadGeneratedImage(record.request.tenantId, record.request.projectId, record.request.jobId);
      this.assertGeneratedArtifact(record);
      if (!saved || imageSnapshotFingerprint(saved) !== imageSnapshotFingerprint(record)) throw new RunKernelError(409, "image_output_record_not_committed", "产物须在同一事务先保存完整正文与谱系");
      return kernel.attachImageArtifact(principal, record);
    });
  }
  // Returned evidence cannot commit without its raw body, even if another
  // trusted server caller forgets the executor's outer transaction.
  recordImageFixtureResult(principal: RunPrincipal, jobId: string, incoming: ImageFixtureResult, body?: Buffer) {
    const result = ImageFixtureResultSchema.parse(incoming);
    if (result.kind === "returned" && !Buffer.isBuffer(body)) throw new RunKernelError(409, "image_fixture_response_body_required", "返回证据必须与原始正文一同保存");
    return this.options.stateStore.transaction(() => {
      const aggregate = this.run((kernel) => {
        const value = kernel.recordImageFixtureResult(principal, jobId, result);
        if (result.kind === "returned") {
          const { tenantId, projectId } = result.outcome;
          const existing = this.options.stateStore.loadImageFixtureResponse(tenantId, projectId, jobId);
          if (existing) {
            if (JSON.stringify(existing.record) !== JSON.stringify(result) || !existing.body.equals(body!)) throw new RunKernelError(409, "image_fixture_result_conflict", "原始响应证据不可覆盖");
          } else this.options.stateStore.saveImageFixtureResponse(result, body!);
        }
        return value;
      });
      this.getBatch(principal, aggregate.batch.id);
      return aggregate;
    });
  }
  getBatch: RunKernelPort["getBatch"] = (...args) => this.run((kernel) => kernel.getBatch(...args));
  listBatches: RunKernelPort["listBatches"] = (...args) => this.run((kernel) => kernel.listBatches(...args));
  confirmBatch: RunKernelPort["confirmBatch"] = (...args) => this.run((kernel) => kernel.confirmBatch(...args));
  claimBatch: RunKernelPort["claimBatch"] = (...args) => this.run((kernel) => kernel.claimBatch(...args));
  executeLeasedJob: RunKernelPort["executeLeasedJob"] = (...args) => this.run((kernel) => kernel.executeLeasedJob(...args));
  resolveBillingUnknown: RunKernelPort["resolveBillingUnknown"] = (...args) => this.run((kernel) => kernel.resolveBillingUnknown(...args));
  requestBillingOverage: RunKernelPort["requestBillingOverage"] = (...args) => this.run((kernel) => kernel.requestBillingOverage(...args));
  reviewBillingOverage: RunKernelPort["reviewBillingOverage"] = (...args) => this.run((kernel) => kernel.reviewBillingOverage(...args));
  dispatchBatch: RunKernelPort["dispatchBatch"] = (...args) => this.run((kernel) => kernel.dispatchBatch(...args));
  reconcileBatch: RunKernelPort["reconcileBatch"] = (...args) => this.run((kernel) => kernel.reconcileBatch(...args));
  retryJob: RunKernelPort["retryJob"] = (...args) => this.run((kernel) => kernel.retryJob(...args));
  cancelBatch: RunKernelPort["cancelBatch"] = (...args) => this.run((kernel) => kernel.cancelBatch(...args));
  getBudget: RunKernelPort["getBudget"] = (...args) => this.run((kernel) => kernel.getBudget(...args));

  private productionResponseScope(p: RunPrincipal, project: string): void {
    const policy = this.options.productionImageResponsePolicy;
    if (!policy || !this.options.stateStore.supportsProductionImageResponses()) throw new RunKernelError(503, "production_image_response_not_configured", "生产尝试及原包默认关闭");
    for (const check of [() => policy.usesStateStore(this.options.stateStore), () => policy.authorizeScope(p, project)]) {
      let value: unknown;
      try { value = check(); } catch { throw new RunKernelError(503, "production_image_response_unavailable", "生产响应政策不可用"); }
      if (value && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => undefined);
      if (value !== true) throw new RunKernelError(403, "production_image_response_not_configured", "生产响应须同库同步政策");
    }
  }

  private productionStartScope(p: RunPrincipal, project: string): void {
    const policy = this.options.productionImageStartPolicy;
    if (!policy) throw new RunKernelError(503, "production_image_start_not_configured", "生产启动政策默认关闭");
    for (const check of [() => policy.usesStateStore(this.options.stateStore), () => policy.authorizeScope(p, project)]) {
      let value: unknown;
      try { value = check(); } catch (error) { if (error instanceof RunKernelError) throw error; throw new RunKernelError(503, "production_image_start_unavailable", "生产启动政策不可用"); }
      if (value && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => undefined);
      if (value !== true) throw new RunKernelError(503, "production_image_start_not_configured", "生产启动须配置同库同步政策");
    }
  }

  private productionLeaseCommand<T>(p: RunPrincipal, project: string, batch: string, purpose: "claim" | "inspect" | "reconcile" | "history",
    action: (kernel: InMemoryRunKernel) => T, after?: (result: T, kernel: InMemoryRunKernel) => void): T {
    const policy = this.options.productionImageLeasePolicy;
    if (!policy) throw new RunKernelError(503, "production_image_lease_not_configured", "生产租约须显式配置同一事务存储");
    try {
      const sameStore: unknown = policy.usesStateStore(this.options.stateStore);
      if (sameStore && (typeof sameStore === "object" || typeof sameStore === "function") && "then" in sameStore) void Promise.resolve(sameStore).catch(() => undefined);
      if (sameStore !== true) throw new RunKernelError(503, "production_image_lease_not_configured", "生产租约须显式配置同一事务存储");
      const allowed: unknown = policy.authorizeScope(p, project);
      if (allowed && (typeof allowed === "object" || typeof allowed === "function") && "then" in allowed) void Promise.resolve(allowed).catch(() => undefined);
      if (allowed !== true) throw new RunKernelError(403, "production_image_lease_permission_denied", "生产租约范围未获授权");
      return this.options.stateStore.transaction(() => {
        const result = this.run(action);
        // This runs after the actual SQL write, so faults/revocation/expiry in a
        // save hook roll back the whole outer transaction, not just an in-memory copy.
        this.run((kernel) => { kernel.assertProductionImageTask(p, project, batch, purpose); after?.(result, kernel); });
        return result;
      });
    } catch (error) { if (error instanceof RunKernelError) throw error; throw new RunKernelError(503, "production_image_lease_unavailable", "生产租约存储或政策不可用"); }
  }

  private lockedLeaseCommand<T>(principal: RunPrincipal, project: string, batch: string, purpose: import("./lockedProductionImageLeasePolicy").LockedLeasePurpose,
    action: (kernel: InMemoryRunKernel) => T, after?: (result: T, kernel: InMemoryRunKernel) => void): T {
    const policy = this.options.lockedProductionImageLeasePolicy, p = structuredClone(principal);
    if (!policy) throw new RunKernelError(503, "locked_lease_not_configured", "保护租约须显式同库政策");
    try {
      const store = this.options.stateStore, clock = this.options.clock, identities = [policy.usesStateStore, policy.authorizeScope, policy.validate], principalFingerprint = imageSnapshotFingerprint(p);
      const startPolicy = this.options.lockedProductionImageStartPolicy, startFunctions = startPolicy && [startPolicy.usesStateStore, startPolicy.authorizeScope, startPolicy.validateStart];
      const responsePolicy = this.options.lockedProductionImageResponsePolicy, responseFunctions = responsePolicy && [responsePolicy.usesStateStore, responsePolicy.authorizeScope, responsePolicy.validateAttempt, responsePolicy.validateResult];
      const fixed = () => { if (this.options.stateStore !== store || this.options.clock !== clock || this.options.lockedProductionImageLeasePolicy !== policy
        || imageSnapshotFingerprint(p) !== principalFingerprint
        || identities.some((f, i) => f !== [policy.usesStateStore, policy.authorizeScope, policy.validate][i])
        || this.options.lockedProductionImageResponsePolicy !== responsePolicy || responseFunctions?.some((f,i) => f !== [responsePolicy!.usesStateStore,responsePolicy!.authorizeScope,responsePolicy!.validateAttempt,responsePolicy!.validateResult][i])
        || (purpose.startsWith("start") && (this.options.lockedProductionImageStartPolicy !== startPolicy
          || startFunctions?.some((f,i) => f !== [startPolicy!.usesStateStore,startPolicy!.authorizeScope,startPolicy!.validateStart][i])))) throw new Error("保护租约配置/身份/端口漂移"); };
      fixed();
      this.strictArtifactPolicy(() => policy.usesStateStore(this.options.stateStore));
      this.strictArtifactPolicy(() => policy.authorizeScope(p, project, purpose));
      const timeout = policy.timeoutMs ?? 5000;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error("保护租约时限无效");
      let last = this.options.clock?.() ?? Date.now(); const deadline = last + timeout;
      if (!Number.isSafeInteger(last) || last < 0 || last > 8_640_000_000_000_000 - 30000) throw new Error("保护任务首时钟无效");
      const guard = () => { fixed(); const now = clock?.() ?? Date.now(); if (!Number.isSafeInteger(now) || now < 0 || now < last || now >= deadline) throw new Error("保护任务事务时钟/期限无效"); last = now; };
      return this.options.stateStore.transaction(() => {
        guard(); const result = this.run(action); guard();
        const actual = this.options.stateStore.load()?.batches.find(b => b.aggregate.batch.id === batch);
        if (!actual) throw new Error("保护任务缺失"); const fingerprint = imageSnapshotFingerprint(this.options.stateStore.load());
        const postPurpose = purpose === "claim" && actual.aggregate.jobs[0].status !== "queued" ? "history" : purpose;
        this.run(k => { k.assertLockedProductionImageTask(p, project, batch, postPurpose); after?.(result, k); }); guard();
        // Re-read after all trusted post-write callbacks, even if they coherently mutate a valid state.
        this.run(() => undefined);
        if (imageSnapshotFingerprint(this.options.stateStore.load()) !== fingerprint) throw new Error("保护任务实际写后漂移");
        return result;
      });
    } catch (e) { if (e instanceof RunKernelError) throw e; throw new RunKernelError(503, "locked_lease_unavailable", "保护任务存储/政策不可用，请保留原编号核对"); }
  }

  private run<T>(action: (kernel: InMemoryRunKernel) => T, pendingArtifact?: { principal: RunPrincipal; record: ProductionImageArtifact }): T {
    try {
      const outcome = this.options.stateStore.transaction(() => {
        const estimate = this.options.unitEstimateMinor ?? 25;
        const concurrency = this.options.maxConcurrentJobs ?? 2;
        this.options.stateStore.assertConfiguration({
          schemaVersion: 1, unitEstimateMinor: estimate, unitActualMinor: this.options.unitActualMinor ?? Math.max(0, estimate - 5),
          maxConcurrentJobs: concurrency, leaseDurationMs: this.options.leaseDurationMs ?? 30_000,
          jobTimeoutMs: this.options.jobTimeoutMs ?? 30_000,
          projectLimits: (this.options.projectLimits ?? []).map((limit) => ({ tenantId: limit.tenantId, projectId: limit.projectId, maxConcurrentJobs: limit.maxConcurrentJobs }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          providerLimits: (this.options.providerLimits ?? []).map((limit) => ({ adapterId: limit.adapterId, maxConcurrentJobs: limit.maxConcurrentJobs,
            maxStartsPerWindow: limit.maxStartsPerWindow ?? null, windowMs: limit.windowMs ?? null })).sort((a, b) => a.adapterId.localeCompare(b.adapterId)),
        });
        let snapshot = this.options.stateStore.load();
        for (const stored of snapshot?.batches ?? []) {
          const batch = stored.aggregate.batch, result = stored.imageFixtureResult;
          if (stored.lockedProductionImageExecution) {
            const e = stored.lockedProductionImageExecution;
            const p = this.options.stateStore.loadLockedProductionImagePreparation(batch.tenantId, batch.projectId, e.mode, e.preparation.id);
            if (!p || imageSnapshotFingerprint(p) !== imageSnapshotFingerprint(e.preparation)) throw new Error("锁区任务原准备损坏");
            const raw = this.options.stateStore.supportsProductionImageResponses()
              ? this.options.stateStore.loadLockedProductionImageResponse(batch.tenantId, batch.projectId, e.mode, e.protocol.request.jobId) : null;
            try {
              if (stored.lockedProductionImageResult?.kind === "returned") {
                if (!raw || imageSnapshotFingerprint(raw.record) !== stored.lockedProductionImageResultFingerprint) throw new Error("保护原包缺失或不一致");
                const parsed = assertLockedImageRawResponse(raw.record, e, stored.lockedProductionImageLeases?.at(-1), stored.lockedProductionImageDispatchIntent, stored.lockedProductionImageAttempt, raw.body);
                parsed.candidate?.body.fill(0);
              } else if (raw) throw new Error("孤立保护原包");
              if (!this.options.stateStore.supportsProductionImageResponses() || !this.options.stateStore.supportsProductionImageArtifacts()
                || this.options.stateStore.loadProductionImageArtifact(batch.tenantId, batch.projectId, e.mode, e.protocol.request.jobId)) throw new Error("保护产物未开放或存储关闭"); }
            finally { raw?.body.fill(0); }
          }
          if (stored.productionImageExecution) {
            const e = stored.productionImageExecution;
            const preparation = this.options.stateStore.loadProductionImagePreparation(batch.tenantId, batch.projectId, e.mode, e.preparation.id);
            if (!preparation || imageSnapshotFingerprint(preparation) !== imageSnapshotFingerprint(e.preparation)) throw new Error("生产任务原准备缺失或不一致");
            const productionArtifact = this.options.stateStore.supportsProductionImageArtifacts() || stored.productionImageArtifact
              ? this.options.stateStore.loadProductionImageArtifact(batch.tenantId, batch.projectId, e.mode, e.protocol.request.jobId) : null;
            if (productionArtifact && stored.productionImageResult?.kind !== "returned") throw new Error("孤立生产产物缺少实际原包关系");
            if (this.options.stateStore.supportsProductionImageResponses() || stored.productionImageAttempt || stored.productionImageResult) {
              const raw = this.options.stateStore.loadProductionImageResponse(batch.tenantId, batch.projectId, e.mode, e.protocol.request.jobId);
              try {
                if (stored.productionImageResult?.kind === "returned") {
                  if (!raw || imageSnapshotFingerprint(raw.record) !== stored.productionImageResultFingerprint) throw new Error("生产任务原包缺失或不一致");
                  const parsed = assertProductionImageRawResponse(raw.record, e, stored.productionImageLeases?.at(-1), stored.productionImageDispatchIntent, stored.productionImageAttempt, raw.body);
                  parsed.candidate?.body.fill(0);
                  const record = productionArtifact;
                  if (stored.productionImageArtifact) {
                    if (!record || imageSnapshotFingerprint(record) !== stored.productionImageArtifactFingerprint
                      || imageSnapshotFingerprint(record) !== imageSnapshotFingerprint(stored.productionImageArtifact)) throw new Error("生产产物任务与存储关系损坏");
                    assertProductionImageArtifact(stored, record);
                    const asset = this.options.stateStore.loadCatalog()?.projects.find(p => p.projectId === batch.projectId)?.assets.find(a => a.id === record.image.asset.id);
                    if (!asset || assetMetadataFingerprint(asset) !== record.image.registeredMetadataSha256 || !parsed.candidate
                      || parsed.candidate.checksumSha256 !== record.image.checksumSha256 || parsed.candidate.mimeType !== record.image.asset.mimeType
                      || parsed.candidate.body.length !== record.image.asset.byteSize) throw new Error("生产产物不是原包图片或目录损坏");
                  } else if (record) {
                    // Only the scoped attach command may observe its uncommitted
                    // row. Recovery/ordinary reads never get this continuation.
                    if (!pendingArtifact || imageSnapshotFingerprint(record) !== imageSnapshotFingerprint(pendingArtifact.record)) throw new Error("孤立生产产物不能成为任务证据");
                    assertProductionImageArtifact(stored, record);
                    this.strictArtifactPolicy(() => this.options.productionImageArtifactPolicy?.validateCommit(pendingArtifact.principal, record));
                  }
                } else if (raw) throw new Error("孤立原包不能成为生产响应");
              } finally { raw?.body.fill(0); }
            }
          }
          if (!stored.imageFixtureAttempt && !result) continue;
          const response = this.options.stateStore.loadImageFixtureResponse(batch.tenantId, batch.projectId, stored.aggregate.jobs[0].id);
          if (result?.kind === "returned" ? !response || JSON.stringify(response.record) !== JSON.stringify(result) : response !== null) throw new Error("本地响应正文与任务证据不一致");
          const artifact = stored.imageTaskArtifact;
          if (artifact) {
            const generated = this.options.stateStore.loadGeneratedImage(batch.tenantId, batch.projectId, stored.aggregate.jobs[0].id);
            assertImageArtifactRecord(stored, generated);
            this.assertGeneratedArtifact(generated);
          }
        }
        if (!snapshot) {
          snapshot = { schemaVersion: 1, savedAt: new Date((this.options.clock ?? Date.now)()).toISOString(),
            budgets: this.options.budgets.map((budget) => ({ ...budget, reservedMinor: 0, spentMinor: 0 })), batches: [] };
          this.options.stateStore.save(snapshot);
        }
        for (const configured of this.options.budgets) {
          const saved = snapshot.budgets.find((budget) => budget.tenantId === configured.tenantId && budget.projectId === configured.projectId);
          if (!saved || configured.currency !== saved.currency || configured.limitMinor !== saved.limitMinor) {
            throw new Error("任务内核快照与当前项目预算配置不兼容");
          }
        }
        let modified = false;
        const kernel = new InMemoryRunKernel({ ...this.options, budgets: snapshot.budgets, recoverRunningJobsOnRestore: false,
          stateStore: { load: () => snapshot, save: (next) => { snapshot = next; modified = true; } } });
        let value: T | undefined;
        let rejection: RunKernelError | undefined;
        try { value = action(kernel); }
        catch (error) {
          // Explicit business rejections can append denial audits. They may commit, but
          // unexpected faults roll back everything, including intermediate dispatch steps.
          if (!(error instanceof RunKernelError)) throw error;
          rejection = error;
        }
        if (modified) this.options.stateStore.save(snapshot);
        return { value, rejection };
      });
      if (outcome.rejection) throw outcome.rejection;
      return outcome.value as T;
    } catch (error) {
      if (error instanceof RunKernelError) throw error;
      const code = error instanceof SqliteStateStoreError ? error.code : "run_state_unavailable";
      throw new RunKernelError(503, code, "任务数据库暂不可用，请保持原动作编号后重试");
    }
  }

  private assertGeneratedArtifact(record: GeneratedImageRecord): void {
    const asset = this.options.stateStore.loadCatalog()?.projects.find((item) => item.projectId === record.request.projectId)?.assets.find((item) => item.id === record.image.asset.id);
    if (!asset || assetMetadataFingerprint(asset) !== record.image.registeredMetadataSha256) throw new RunKernelError(503, "run_state_unavailable", "任务产物目录或正文缺失");
  }
}
