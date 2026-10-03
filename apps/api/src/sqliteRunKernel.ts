import type { IncomingMessage } from "node:http";
import { GeneratedImageRecordSchema, ImageFixtureResultSchema, type GeneratedImageRecord, type ImageFixtureResult } from "@canvas/contracts";
import { imageSnapshotFingerprint } from "./imageProviderContract";
import { assetMetadataFingerprint } from "./verifiedAssets";
import { assertImageArtifactRecord } from "./imageArtifactIntegrity";
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
