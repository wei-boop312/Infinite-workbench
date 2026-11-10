import {
  ProjectBudgetSnapshotSchema,
  RunBatchAggregateSchema,
  RunBatchListSchema,
  VerifiedImageSchema,
  CreateImagePreparationSchema, ImageProviderListSchema, ImagePreparationPublicSchema, ConfirmImagePreparationSchema, ImageConfirmationPublicSchema, ImageConfirmationHistorySchema,
  GeneratedAssetLineageSchema, type RunJob,
  type ImagePreparationPublic, type ImageConfirmationPublic,
  type CreateImagePreparation,
  type CreateRunBatchRequest,
  type RegisterRunContextRequest,
  type ResolveBillingUnknownRequest,
  type RequestBillingOverage,
  type ReviewBillingOverage,
  type RunBatchAggregate,
} from "@canvas/contracts";

const ERROR_LABELS: Record<string, string> = {
  run_asset_not_verified: "原图或蒙版尚未通过本机服务校验，请重新提交所需原文件。",
  asset_verification_not_configured: "当前服务尚未启用图片验证，请正常重启更新后的本地工作台。",
  verified_asset_not_found: "图片未登记或不属于当前项目。",
  verified_asset_permission_denied: "当前身份没有图片写入权限。",
  verified_asset_headers_invalid: "图片上传类型或摘要无效。",
  verified_asset_size_mismatch: "图片真实大小与登记信息不一致。",
  verified_asset_checksum_mismatch: "图片内容摘要与原资产不一致，请恢复原文件或创建新版本。",
  verified_asset_mime_mismatch: "图片真实格式与文件类型不一致。",
  verified_asset_decode_failed: "图片无法完整解码，可能已损坏或被截断，请使用完整原文件。",
  verified_asset_dimensions_mismatch: "图片真实尺寸与登记信息不一致。",
  verified_asset_dimensions_exceeded: "本机任务暂支持不超过 1600 万像素、单边 8192 像素的图片。",
  verified_asset_animated: "动态图暂不能参与图片任务，请先导出静态帧。",
  verified_asset_too_large: "图片原文件超过本机校验限制（30 MB）。",
  verified_asset_project_quota: "本项目的本机图片镜像空间已满，未创建任务或扣费。",
  verified_asset_busy: "本机正在校验其他图片，请稍后重试。",
  verified_mask_source_invalid: "蒙版需要有透明通道的 PNG，且尺寸与已验证底图一致。",
  verified_asset_metadata_changed: "资产登记信息已变化，请创建新版本。",
  verified_asset_version_conflict: "同一资产编号不能替换为另一份内容，请创建新版本。",
  run_state_busy: "任务数据库正在处理另一个操作，请保留原动作编号后重试。",
  run_state_unavailable: "任务数据库不可用，未重置任何预算，请保留原动作编号并检查服务。",
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
  image_provider_catalog_not_configured: "供应商目录尚未启用；请正常重启更新后的本地工作台，不会自动添加模型。",
  image_connection_not_found: "没有当前项目的供应商读取权限，或连接已不存在。",
  image_connection_changed: "连接修订已变化，请刷新目录并明确重新选择，旧动作不会自动换供应商。",
  image_connection_disabled: "所选供应商已停用，未创建新准备单。",
  image_preparation_not_found: "准备单不存在或无权读取，请保留原动作编号核对。",
  image_preparation_idempotency_conflict: "原动作已绑定另一组选项，不能覆盖；请查看原准备单或明确开始新动作。",
  image_preparation_permission_denied: "当前身份无权创建本地准备单。",
  image_quote_expired: "报价已过期；历史恢复不会重新估价，请明确开始新的准备动作。",
  image_pixel_protection_not_configured: "原生图片暂不能兑现商品像素锁；不会移除锁定或降级生成。",
  image_output_dimensions_exceeded: "输出超过本机 1600 万像素或单边 8192 限制，未估价。",
  image_protocol_not_implemented: "自定义协议没有适配器，不能准备。",
  image_output_constraint_changed: "原约束快照已变化，请核对后创建新动作。",
  image_confirmation_permission_denied: "当前身份没有人工确认权限；不会创建任务或预留。",
  image_confirmation_not_configured: "当前服务未配置本地确认事务，保持未确认。",
  image_confirmation_snapshot_mismatch: "冻结摘要或币种/估价/上限不匹配，未确认，请只读核对原记录。",
  generated_asset_lineage_not_configured: "任务结果谱系读取未配置；不会用本地资产或模拟编号代替。",
  generated_asset_not_found: "结果不存在或没有完整读取权限，未使用旧缓存冒充当前授权。",
  generated_asset_unavailable: "结果证据无法完整核验；未重新生成或改变费用。",
};

export function money(minor: number | null): string { return minor === null ? "估价未知" : `¥${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`; }

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

// One browser network boundary for task commands AND explicit binary reads.
// Callers supply only locally constructed paths, never provider URLs or keys.
export function localStudioFetch(path: string, options: RequestInit): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("本地服务路径无效。");
  return fetch(`/studio-api${path}`, options);
}

export class StudioRunClient {
  constructor(private readonly signal: AbortSignal) {}

  private async request<T>(path: string, schema: { parse(value: unknown): T }, body?: unknown, upload?: { blob: Blob; mimeType: string; checksum: string }, maxBytes?: number): Promise<T> {
    let response: Response;
    try {
      response = await localStudioFetch(path, {
        method: body === undefined && !upload ? "GET" : "POST",
        headers: { "x-canvas-local": "1", ...(upload ? { "content-type": upload.mimeType, "x-content-sha256": upload.checksum }
          : body === undefined ? {} : { "content-type": "application/json" }) },
        body: upload ? upload.blob : body === undefined ? undefined : JSON.stringify(body),
        signal: maxBytes ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]) : this.signal,
        cache: "no-store", redirect: "error", credentials: "same-origin",
      });
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new Error(maxBytes ? "本地响应未能确认；请读取原动作历史，不会自动重发。" : "本地任务服务暂时不可用，未确认收到的请求可安全重试。");
    }
    let payload: unknown;
    try {
      if (!maxBytes) payload = await response.json();
      else {
        if (response.redirected || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
          || !response.headers.get("cache-control")?.includes("no-store") || Number(response.headers.get("content-length")) > maxBytes) throw new Error();
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        const chunks: Uint8Array[] = []; let length = 0; let fragments = 0;
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            if (!chunk.value.length) continue;
            length += chunk.value.length;
            if (length > maxBytes || ++fragments > 4096 || this.signal.aborted) throw new Error();
            chunks.push(chunk.value);
          }
        } catch (failure) { await reader.cancel().catch(() => undefined); throw failure; }
        finally { reader.releaseLock(); }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      }
    }
    catch { throw new Error("任务服务没有返回有效数据；请通过本地开发工作台打开面板。"); }
    if (!response.ok) {
      const code = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : "";
      throw new Error(ERROR_LABELS[code] ?? `任务操作失败（${code || response.status}），请刷新记录。`);
    }
    if (this.signal.aborted) throw new DOMException("操作已取消", "AbortError");
    try { return schema.parse(payload); }
    catch { throw new Error("任务服务没有返回符合合同的有效数据，未继续执行；请刷新记录。"); }
  }

  async register(context: RegisterRunContextRequest): Promise<void> {
    await this.request("/context", { parse: (value) => value }, context);
  }
  async verifyImage(projectId: string, assetId: string, blob: Blob, mimeType: string) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    const checksum = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const receipt = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/verification`, VerifiedImageSchema,
      undefined, { blob, mimeType, checksum });
    if (receipt.asset.projectId !== projectId || receipt.asset.id !== assetId || receipt.checksumSha256 !== checksum) {
      throw new Error("图片校验结果与本次原文件不一致，未继续执行。");
    }
    return receipt;
  }
  list(projectId: string) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/run-batches`, RunBatchListSchema);
  }
  budget(projectId: string) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/budget`, ProjectBudgetSnapshotSchema);
  }
  imageProviders(projectId: string) {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/image-providers`, ImageProviderListSchema, undefined, undefined, 2 * 1024 * 1024);
  }
  async prepareImage(input: CreateImagePreparation) {
    const selection = CreateImagePreparationSchema.parse(input);
    if (new TextEncoder().encode(JSON.stringify(selection)).length > 128 * 1024) throw new Error("准备参数过大，未提交。");
    const record = await this.request(`/v1/projects/${encodeURIComponent(selection.projectId)}/image-preparations`, ImagePreparationPublicSchema, selection, undefined, 512 * 1024);
    const template = record.requestTemplate;
    if (record.projectId !== selection.projectId || template.tenantId !== "local-studio" || template.connectionId !== selection.connectionId
      || template.connectionRevision !== selection.connectionRevision || template.model !== selection.model || template.capabilityVersion !== selection.capabilityVersion
      || template.constraintSnapshotId !== selection.constraintSnapshotId || template.operation !== selection.operation
      || JSON.stringify(template.parameters) !== JSON.stringify(selection.parameters)
      || JSON.stringify(template.providerParameters ?? {}) !== JSON.stringify(selection.providerParameters ?? {})
      || JSON.stringify(template.inputs.map((ref) => ref.assetId)) !== JSON.stringify(selection.inputAssetIds)
      || (template.operation === "edit" ? template.mask?.assetId : undefined) !== (selection.operation === "edit" ? selection.maskAssetId : undefined)) {
      throw new Error("准备单与本次人工选择不一致，保留原动作编号，未继续执行。");
    }
    await this.validateFrozenConstraint(record);
    return record;
  }
  async imagePreparation(projectId: string, preparationId: string) {
    const record = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/image-preparations/${encodeURIComponent(preparationId)}`, ImagePreparationPublicSchema, undefined, undefined, 512 * 1024);
    if (record.projectId !== projectId || record.id !== preparationId || record.requestTemplate.tenantId !== "local-studio") throw new Error("历史准备单不属于当前项目或编号，未恢复。");
    await this.validateFrozenConstraint(record);
    return record;
  }
  private async validateFrozenConstraint(record: ImagePreparationPublic) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(record.constraint))));
    const checksum = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    if (checksum !== record.requestTemplate.constraintChecksumSha256 || this.signal.aborted) throw new Error("冻结人工约束摘要不一致或操作已取消，不能用于人工确认。");
  }
  private matchImageConfirmation(record: ImagePreparationPublic, result: ImageConfirmationPublic) {
    const { batch } = result.aggregate, template = record.requestTemplate;
    const refs = [...template.inputs, ...(template.operation === "edit" && template.mask ? [template.mask] : [])];
    const inputs = refs.map(item => item.assetId);
    if (result.preparationId !== record.id || result.preparationFingerprint !== record.snapshotFingerprint
      || batch.projectId !== record.projectId || batch.tenantId !== template.tenantId || batch.constraintSnapshotId !== record.constraint.id
      || batch.adapterId !== template.adapterId || batch.tool !== (template.operation === "generate" ? "image-generate" : "image-edit")
      || batch.currency !== record.pricing.quote.currency || batch.estimatedCostMinor !== record.pricing.quote.estimatedCostMinor
      || batch.maxCostMinor < record.pricing.quote.maxCostMinor || JSON.stringify(batch.inputAssetIds) !== JSON.stringify(inputs)
      || Date.parse(result.confirmedAt) < Date.parse(record.createdAt) || Date.parse(result.confirmedAt) >= Date.parse(record.pricing.quote.expiresAt)
      || result.transformedInputs.length !== refs.length || refs.some((ref, index) => {
        const transform = result.transformedInputs[index];
        return transform?.assetId !== ref.assetId || transform.originalChecksumSha256 !== ref.checksumSha256
          || (index < template.inputs.length ? transform.transform !== "exif-srgb-png-v1" : transform.transform === "exif-srgb-png-v1");
      })) throw new Error("确认结果与完整冻结准备单不一致，请只读核对，不会重发。");
    return result;
  }
  async imageConfirmation(record: ImagePreparationPublic) {
    await this.validateFrozenConstraint(record);
    const history = await this.request(`/v1/projects/${encodeURIComponent(record.projectId)}/image-preparations/${encodeURIComponent(record.id)}/confirmation`, ImageConfirmationHistorySchema, undefined, undefined, 512 * 1024);
    if (history.preparationId !== record.id || history.preparationFingerprint !== record.snapshotFingerprint) throw new Error("确认历史与当前准备单不一致，未恢复。");
    return history.confirmation ? this.matchImageConfirmation(record, history.confirmation) : null;
  }
  async confirmImage(record: ImagePreparationPublic) {
    await this.validateFrozenConstraint(record);
    const quote = record.pricing.quote;
    const body = ConfirmImagePreparationSchema.parse({ expectedSnapshotFingerprint: record.snapshotFingerprint,
      expectedCurrency: quote.currency, expectedEstimatedCostMinor: quote.estimatedCostMinor, expectedMaxCostMinor: quote.maxCostMinor });
    const result = await this.request(`/v1/projects/${encodeURIComponent(record.projectId)}/image-preparations/${encodeURIComponent(record.id)}/confirm`, ImageConfirmationPublicSchema, body, undefined, 512 * 1024);
    return this.matchImageConfirmation(record, result);
  }
  async cacheImage(projectId: string, assetId: string) {
    const { cacheGeneratedAsset } = await import("../assets/generatedAssetCache");
    return cacheGeneratedAsset(projectId, assetId, { signal: this.signal });
  }
  async generatedLineage(batch: RunBatchAggregate, job: RunJob) {
    if (batch.batch.tool === "product-retouch" || job.batchId !== batch.batch.id || job.outputAssetIds.length !== 1
      || !batch.jobs.some(item => item.id === job.id && JSON.stringify(item.outputAssetIds) === JSON.stringify(job.outputAssetIds))) throw new Error("没有实际原生图片输出，不能读取结果谱系。");
    const view = await this.request(`/v1/projects/${encodeURIComponent(batch.batch.projectId)}/generated-assets/${encodeURIComponent(job.outputAssetIds[0])}/lineage`,
      GeneratedAssetLineageSchema, undefined, undefined, 512 * 1024);
    if (view.tenantId !== "local-studio" || view.tenantId !== batch.batch.tenantId || view.projectId !== batch.batch.projectId
      || view.batchId !== batch.batch.id || view.jobId !== job.id || view.image.asset.id !== job.outputAssetIds[0]
      || view.requestTemplate.constraintSnapshotId !== batch.batch.constraintSnapshotId || view.requestTemplate.adapterId !== batch.batch.adapterId
      || view.requestTemplate.operation !== (batch.batch.tool === "image-generate" ? "generate" : "edit")
      || view.confirmedBy !== batch.batch.confirmedBy || view.confirmedAt !== batch.batch.confirmedAt || view.billing.currency !== batch.batch.currency
      || JSON.stringify([...view.requestTemplate.inputs.map(input => input.assetId), ...(view.requestTemplate.operation === "edit" && view.requestTemplate.mask ? [view.requestTemplate.mask.assetId] : [])]) !== JSON.stringify(job.inputAssetIds)) {
      throw new Error("结果谱系与当前项目实际任务或输出编号不一致，未使用缓存替代。");
    }
    const { assertGeneratedReceipt } = await import("../assets/generatedAssetPolicy");
    assertGeneratedReceipt(view.image, view.projectId, view.image.asset.id);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(view.constraint))));
    if (Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") !== view.requestTemplate.constraintChecksumSha256 || this.signal.aborted) {
      throw new Error("结果中的原冻结约束摘要不一致或读取已取消，未继续。");
    }
    return view;
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
