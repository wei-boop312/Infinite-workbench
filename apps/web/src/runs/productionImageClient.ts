import { CreateImagePreparationSchema, ProductionImageUiScopeSchema, ProductionImagePreparationPublicSchema, ProjectBudgetSnapshotSchema,
  ProductionImageConfirmationPublicSchema, ProductionImageConfirmationHistorySchema, ConfirmProductionImagePreparationSchema,
  type CreateImagePreparation, type ProductionImagePreparationPublic, type ProductionImageConfirmationPublic, type ProductionImageUiScope } from "@canvas/contracts";
import { localStudioFetch, StudioRunClient } from "./runClient";

export class ProductionImageClient {
  readonly scope: ProductionImageUiScope;
  constructor(scope: ProductionImageUiScope, private readonly signal: AbortSignal) { this.scope = ProductionImageUiScopeSchema.parse(scope); }
  private async request<T>(projectId: string, suffix: string, schema: { parse(v: unknown): T }, body?: unknown, resource: "production-image-preparations" | "budget" = "production-image-preparations"): Promise<T> {
    if (this.signal.aborted) throw new DOMException("操作已取消", "AbortError");
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text && new TextEncoder().encode(text).length > (suffix.endsWith("/confirm") ? 16 : 128) * 1024) throw new Error("生产请求过大，未提交。");
    const timeout = AbortSignal.timeout(30_000), signal = AbortSignal.any([this.signal, timeout]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const race = <V>(promise: Promise<V>): Promise<V> => new Promise((resolve, reject) => {
      const stop = () => reject(new DOMException("操作已取消或超时", "AbortError"));
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
    try {
      const response = await race(localStudioFetch(`/v1/projects/${encodeURIComponent(projectId)}/${resource}${suffix}`, {
        method: text === undefined ? "GET" : "POST", body: text, signal, cache: "no-store", redirect: "error", credentials: "same-origin",
        headers: { "x-canvas-local": "1", ...(text === undefined ? {} : { "content-type": "application/json" }) },
      }));
      const length = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
      if (response.redirected || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")
        || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "")
        || (encoding && encoding !== "identity") || (length !== null && (!/^\d+$/.test(length) || Number(length) > 512 * 1024))) throw new Error();
      reader = response.body?.getReader(); if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let bytes = 0, fragments = 0;
      for (;;) {
        const item = await race(reader.read()); if (item.done) break;
        if (!item.value.length) continue;
        bytes += item.value.length;
        if (bytes > 512 * 1024 || ++fragments > 4096) throw new Error();
        chunks.push(item.value);
      }
      if (signal.aborted || (length !== null && bytes !== Number(length))) throw new Error();
      const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
      if (!response.ok) throw new Error();
      return schema.parse(value);
    } catch { void reader?.cancel().catch(() => undefined); throw new Error("生产响应未能完整核对；保留原指针，仅只读核对，不自动重发。"); }
    finally { reader?.releaseLock(); }
  }
  private async validate(record: ProductionImagePreparationPublic) {
    const p = ProductionImagePreparationPublicSchema.parse(record);
    if (this.signal.aborted || p.tenantId !== this.scope.tenantId || p.mode !== this.scope.mode) throw new Error("生产准备范围不一致或已取消。");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(p.constraint))));
    if (Array.from(digest, v => v.toString(16).padStart(2, "0")).join("") !== p.requestDraft.constraintChecksumSha256 || this.signal.aborted) throw new Error("完整冻结人工约束 SHA 不一致或已取消。");
    return p;
  }
  async prepare(input: CreateImagePreparation) {
    const selection = CreateImagePreparationSchema.parse(input);
    if (selection.parameters.size === "auto") throw new Error("生产准备须显式原约束尺寸。");
    const p = await this.validate(await this.request(selection.projectId, "", ProductionImagePreparationPublicSchema, selection)), d = p.requestDraft;
    if (p.projectId !== selection.projectId || d.connectionId !== selection.connectionId || d.connectionRevision !== selection.connectionRevision
      || d.model !== selection.model || d.capabilityVersion !== selection.capabilityVersion || d.operation !== selection.operation
      || d.constraintSnapshotId !== selection.constraintSnapshotId || d.protection !== selection.protection
      || JSON.stringify(d.parameters) !== JSON.stringify(selection.parameters) || JSON.stringify(d.providerParameters ?? {}) !== JSON.stringify(selection.providerParameters ?? {})
      || JSON.stringify(d.inputs.map(i => i.assetId)) !== JSON.stringify(selection.inputAssetIds)
      || (d.operation === "edit" ? d.mask?.assetId : undefined) !== (selection.operation === "edit" ? selection.maskAssetId : undefined)) throw new Error("生产准备与原人工选择不一致；仅只读恢复。");
    return p;
  }
  async preparation(projectId: string, id: string) {
    const p = await this.validate(await this.request(projectId, `/${encodeURIComponent(id)}`, ProductionImagePreparationPublicSchema));
    if (p.id !== id || p.projectId !== projectId) throw new Error("生产历史准备编号或项目不一致。"); return p;
  }
  private match(p: ProductionImagePreparationPublic, c: ProductionImageConfirmationPublic) {
    const d = p.requestDraft, refs = [...d.inputs, ...(d.operation === "edit" && d.mask ? [d.mask] : [])];
    if (c.tenantId !== p.tenantId || c.projectId !== p.projectId || c.mode !== p.mode || c.preparationId !== p.id || c.preparationFingerprint !== p.snapshotFingerprint
      || c.pricingFingerprint !== p.pricingFingerprint || JSON.stringify(c.pricing) !== JSON.stringify(p.pricing) || c.confirmedBy !== p.createdBy
      || Date.parse(c.confirmedAt) < Date.parse(p.createdAt) || c.task.adapterId !== d.adapterId || c.task.constraintSnapshotId !== p.constraint.id
      || c.task.tool !== (d.operation === "generate" ? "image-generate" : "image-edit") || JSON.stringify(c.task.inputAssetIds) !== JSON.stringify(refs.map(r => r.assetId))
      || c.transformedInputs.length !== refs.length || refs.some((r, index) => c.transformedInputs[index]?.assetId !== r.assetId
        || c.transformedInputs[index].originalChecksumSha256 !== r.checksumSha256
        || (index < d.inputs.length ? c.transformedInputs[index].transform !== "exif-srgb-png-v1" : c.transformedInputs[index].transform === "exif-srgb-png-v1"))) throw new Error("生产确认不匹配完整原准备；仅只读核对，不重发。");
    return c;
  }
  async history(record: ProductionImagePreparationPublic) {
    const p = await this.validate(record), h = await this.request(p.projectId, `/${encodeURIComponent(p.id)}/confirmation`, ProductionImageConfirmationHistorySchema);
    if (h.tenantId !== p.tenantId || h.projectId !== p.projectId || h.mode !== p.mode || h.preparationId !== p.id
      || h.preparationFingerprint !== p.snapshotFingerprint || h.pricingFingerprint !== p.pricingFingerprint) throw new Error("生产确认历史范围或原摘要不一致。");
    return h.confirmation ? this.match(p, h.confirmation) : null;
  }
  async confirm(record: ProductionImagePreparationPublic) {
    const p = await this.validate(record), q = p.pricing.quote;
    const body = ConfirmProductionImagePreparationSchema.parse({ expectedSnapshotFingerprint: p.snapshotFingerprint, expectedPricingFingerprint: p.pricingFingerprint,
      expectedCurrency: q.currency, expectedMaxCostMinor: q.maxCostMinor, estimate: q.source === "manual-budget" ? { state: "unknown" } : { state: "known", expectedEstimatedCostMinor: q.estimatedCostMinor } });
    return this.match(p, await this.request(p.projectId, `/${encodeURIComponent(p.id)}/confirm`, ProductionImageConfirmationPublicSchema, body));
  }
  providers(projectId: string) { return new StudioRunClient(this.signal).imageProviders(projectId); }
  async budget(projectId: string) {
    const b = await this.request(projectId, "", ProjectBudgetSnapshotSchema, undefined, "budget");
    if (b.tenantId !== this.scope.tenantId || b.projectId !== projectId) throw new Error("预算响应范围不一致；原确认保留。");
    return b;
  }
}
