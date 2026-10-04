import type { IncomingMessage } from "node:http";
import { GeneratedImageRecordSchema, ImageFixtureResultSchema, ProductionImageResultSchema, type GeneratedImageRecord, type ImageFixtureResult, type ProductionImageResult } from "@canvas/contracts";
import { imageSnapshotFingerprint } from "./imageProviderContract";
import { assetMetadataFingerprint } from "./verifiedAssets";
import { assertImageArtifactRecord } from "./imageArtifactIntegrity";
import { assertProductionImageRawResponse } from "./productionImageResponse";
import { InMemoryRunKernel, RunKernelError, type ProjectBudgetConfig, type RunKernelOptions, type RunKernelPort, type RunPrincipal } from "./runKernel";
import { SqliteRunKernelStateStore, SqliteStateStoreError } from "./sqliteRunKernelStore";

type Options = Omit<RunKernelOptions, "stateStore" | "recoverRunningJobsOnRestore"> & { stateStore: SqliteRunKernelStateStore };

// Each command reloads under BEGIN IMMEDIATE. Never reuse stale process-local budgets or leases.
export class SqliteRunKernel implements RunKernelPort {
  constructor(private readonly options: Options) { this.run(() => undefined); }
  usesStateStore(store: SqliteRunKernelStateStore): boolean { return this.options.stateStore === store; }

  authenticate(request: IncomingMessage): RunPrincipal | null { return this.options.authorizer.authenticate(request); }
  registerLocalProject(budget: ProjectBudgetConfig): void { this.run((kernel) => kernel.registerLocalProject(budget)); }
  createBatch: RunKernelPort["createBatch"] = (...args) => this.run((kernel) => kernel.createBatch(...args));
  stageConfirmedImageBatch: InMemoryRunKernel["stageConfirmedImageBatch"] = (...args) => this.run((kernel) => kernel.stageConfirmedImageBatch(...args));
  stageConfirmedProductionImageBatch: InMemoryRunKernel["stageConfirmedProductionImageBatch"] = (...args) => this.run((kernel) => kernel.stageConfirmedProductionImageBatch(...args));
  claimProductionImageBatch: InMemoryRunKernel["claimProductionImageBatch"] = (p, project, batch, input) => this.productionLeaseCommand(p, project, batch, "claim", (kernel) => {
    return kernel.claimProductionImageBatch(p, project, batch, input);
  }, (result, kernel) => { for (const lease of result.leases) kernel.inspectProductionImageLease(p, project, batch, lease.jobId, { workerId: lease.workerId, leaseId: lease.leaseId }); });
  inspectProductionImageLease: InMemoryRunKernel["inspectProductionImageLease"] = (p, project, batch, job, input) => this.productionLeaseCommand(p, project, batch, "inspect",
    (kernel) => kernel.inspectProductionImageLease(p, project, batch, job, input), (_result, kernel) => { kernel.inspectProductionImageLease(p, project, batch, job, input); });
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

  private run<T>(action: (kernel: InMemoryRunKernel) => T): T {
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
          if (stored.productionImageExecution) {
            const e = stored.productionImageExecution;
            const preparation = this.options.stateStore.loadProductionImagePreparation(batch.tenantId, batch.projectId, e.mode, e.preparation.id);
            if (!preparation || imageSnapshotFingerprint(preparation) !== imageSnapshotFingerprint(e.preparation)) throw new Error("生产任务原准备缺失或不一致");
            if (this.options.stateStore.supportsProductionImageResponses() || stored.productionImageAttempt || stored.productionImageResult) {
              const raw = this.options.stateStore.loadProductionImageResponse(batch.tenantId, batch.projectId, e.mode, e.protocol.request.jobId);
              try {
                if (stored.productionImageResult?.kind === "returned") {
                  if (!raw || imageSnapshotFingerprint(raw.record) !== stored.productionImageResultFingerprint) throw new Error("生产任务原包缺失或不一致");
                  const parsed = assertProductionImageRawResponse(raw.record, e, stored.productionImageLeases?.at(-1), stored.productionImageDispatchIntent, stored.productionImageAttempt, raw.body);
                  parsed.candidate?.body.fill(0);
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
