import {
  ProjectBudgetSnapshotSchema,
  RunBatchAggregateSchema,
  RunBatchListSchema,
  type CreateRunBatchRequest,
  type RegisterRunContextRequest,
  type ResolveBillingUnknownRequest,
  type RequestBillingOverage,
  type ReviewBillingOverage,
  type RunBatchAggregate,
} from "@canvas/contracts";

const ERROR_LABELS: Record<string, string> = {
  project_budget_exceeded: "项目模拟预算不足，请先处理仍占用预算的任务。",
  batch_cost_ceiling_exceeded: "预估或重试成本超过本批次上限。",
  confirmation_snapshot_mismatch: "确认金额已变化，请刷新后重新查看。",
  run_idempotency_conflict: "这次动作的参数已变化，请重新创建预估。",
  run_constraint_not_found: "请使用当前项目已保存的约束快照。",
  run_constraint_unsupported: "产品精修需要锁定商品主体，并选择图片输出格式。",
  run_input_asset_invalid: "请选择当前项目的商品图片。",
  run_mask_source_mismatch: "所选蒙版来自另一张图片，请调整输入或创建新约束。",
  invalid_run_context: "项目资产或约束登记失败，请检查数据完整性。",
  billing_state_unknown: "计费仍待核对，请先提交核账结论。",
  billing_actual_exceeds_reservation: "实际扣费超过预留，仍保持冻结，需要升级处理。",
  billing_already_resolved: "此任务已由核账人员处理，请刷新。",
  billing_resolution_snapshot_mismatch: "核账预留金额已变化，请刷新。",
  billing_resolution_idempotency_conflict: "这次核账动作已提交其他参数，请刷新记录。",
  run_permission_denied: "当前身份没有该操作的权限。",
  run_batch_not_cancellable: "此批次已经启动或结束，不能直接取消。",
  run_job_superseded: "此任务已有后续重试，请查看最新尝试。",
  retry_cost_snapshot_mismatch: "重试金额已变化，请刷新任务再确认。",
  run_job_not_retryable: "此任务当前不能重试，请刷新记录。",
  run_batch_not_confirmable: "批次状态已变化，请刷新记录。",
  billing_state_not_unknown: "此任务已经不处于计费待核对状态，请刷新记录。",
  billing_overage_pending: "该任务已有待审批申请，请完成审批后再处理核账。",
  billing_overage_snapshot_mismatch: "审批所见金额或批次上限已变化，请刷新；必要时拒绝旧申请并重新提交。",
  billing_overage_ceiling_insufficient: "拟审批上限必须覆盖现有批次费用与其他预留，且不能低于当前上限。",
  billing_overage_not_needed: "此金额未超过预留，请使用普通核账。",
  billing_overage_self_review: "申请人不能审批自己的超额申请。",
  billing_overage_idempotency_conflict: "这次申请动作已对应其他参数，请刷新记录。",
  billing_overage_already_reviewed: "这项申请已经处理，请刷新查看结论。",
  billing_overage_review_idempotency_conflict: "这次审批已提交其他结论或参数，请刷新记录。",
  billing_overage_not_found: "该任务没有此审批申请，请刷新记录。",
  invalid_billing_overage: "申请或审批字段不完整，请填写金额、理由和证据引用。",
  invalid_billing_resolution: "请填写有效的核账金额和证据引用。",
  local_studio_origin_denied: "本地任务服务仅接受当前工作台的请求。",
};

export function money(minor: number): string { return `¥${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`; }

export function parseMoney(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) throw new Error("金额需要是非负数字，最多两位小数。");
  const [integer, fraction = ""] = value.trim().split(".");
  const minor = Number(integer) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) throw new Error("金额超出支持范围。");
  return minor;
}

export const RUN_STATUS_LABEL: Record<string, string> = {
  awaiting_confirmation: "待人工确认", queued: "排队中", leased: "已领取", running: "执行中",
  partial: "部分成功", succeeded: "已完成", failed: "失败", timed_out: "超时",
  billing_unknown: "计费待核对", cancelled: "已取消", draft: "草稿",
};

export class StudioRunClient {
  constructor(private readonly signal: AbortSignal) {}

  private async request<T>(path: string, schema: { parse(value: unknown): T }, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`/studio-api${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-canvas-local": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.signal,
      });
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new Error("本地任务服务暂时不可用，未确认收到的请求可安全重试。");
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new Error("任务服务没有返回有效数据；请通过本地开发工作台打开面板。"); }
    if (!response.ok) {
      const code = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : "";
      throw new Error(ERROR_LABELS[code] ?? `任务操作失败（${code || response.status}），请刷新记录。`);
    }
    return schema.parse(payload);
  }

  async register(context: RegisterRunContextRequest): Promise<void> {
    await this.request("/context", { parse: (value) => value }, context);
  }
  list(projectId: string) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/run-batches`, RunBatchListSchema);
  }
  budget(projectId: string) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/budget`, ProjectBudgetSnapshotSchema);
  }
  create(request: CreateRunBatchRequest) { return this.request("/v1/run-batches", RunBatchAggregateSchema, request); }
  action(batch: RunBatchAggregate, action: "confirm" | "cancel" | "dispatch" | "reconcile") {
    const body = action === "confirm"
      ? { expectedEstimatedCostMinor: batch.batch.estimatedCostMinor, expectedCurrency: batch.batch.currency }
      : {};
    return this.request(`/v1/run-batches/${encodeURIComponent(batch.batch.id)}/${action}`, RunBatchAggregateSchema, body);
  }
  retry(jobId: string, expectedEstimatedCostMinor: number, expectedCurrency: string) {
    return this.request(`/v1/run-jobs/${encodeURIComponent(jobId)}/retry`, RunBatchAggregateSchema, {
      expectedEstimatedCostMinor, expectedCurrency, mockScenario: "success",
    });
  }
  resolve(jobId: string, request: ResolveBillingUnknownRequest) {
    return this.request(`/v1/run-jobs/${encodeURIComponent(jobId)}/resolve-billing`, RunBatchAggregateSchema, request);
  }
  requestOverage(jobId: string, request: RequestBillingOverage) {
    return this.request(`/v1/run-jobs/${encodeURIComponent(jobId)}/billing-overages`, RunBatchAggregateSchema, request);
  }
  reviewOverage(jobId: string, overageId: string, request: ReviewBillingOverage) {
    return this.request(`/v1/run-jobs/${encodeURIComponent(jobId)}/billing-overages/${encodeURIComponent(overageId)}/review`, RunBatchAggregateSchema, request);
  }
}
