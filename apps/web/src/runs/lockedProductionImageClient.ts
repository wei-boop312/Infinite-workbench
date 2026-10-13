import { CreateImagePreparationSchema, ImageProviderListSchema, VerifiedImageSchema, RegisterRunContextRequestSchema, type RegisterRunContextRequest, LockedProductionImageUiScopeSchema, LockedProductionImagePreparationPublicSchema, ProjectBudgetSnapshotSchema,
  LockedProductionImageConfirmationPublicSchema, LockedProductionImageConfirmationHistorySchema, ConfirmLockedProductionImagePreparationSchema,
  type CreateImagePreparation, type LockedProductionImagePreparationPublic, type LockedProductionImageConfirmationPublic, type LockedProductionImageUiScope } from "@canvas/contracts";
import { ProductionReadLifetime, productionReadId } from "../assets/productionGeneratedAssetPolicy";
import { localStudioFetch } from "./runClient";

export class LockedProductionImageClient {
  readonly scope: LockedProductionImageUiScope;
  constructor(scope: LockedProductionImageUiScope, private readonly signal: AbortSignal) { this.scope = Object.freeze(LockedProductionImageUiScopeSchema.parse(scope)); }
  private async request<T>(projectId: string, suffix: string, schema: { parse(v: unknown): T }, body?: unknown, resource: "locked-production-image-preparations" | "budget" | "image-providers" | "context" | "assets" = "locked-production-image-preparations", beforePost?: () => void, upload?: { body: Blob; mimeType: string; checksum: string }, parentSignal?: AbortSignal): Promise<T> {
    productionReadId(projectId);
    const life = new ProductionReadLifetime(parentSignal ?? this.signal, "production-lineage");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const chunks: Uint8Array[] = [];
    try {
      const text = body === undefined ? undefined : JSON.stringify(body);
      if (text && new TextEncoder().encode(text).length > (suffix.endsWith("/confirm") ? 16 : 128) * 1024) throw new Error();
      if (text !== undefined || upload) beforePost?.(); life.check();
      const response = await life.wait(localStudioFetch(resource === "context" ? "/context" : `/v1/projects/${encodeURIComponent(projectId)}/${resource}${suffix}`, {
        method: text === undefined && !upload ? "GET" : "POST", body: upload?.body ?? text, signal: life.signal, cache: "no-store", redirect: "error", credentials: "same-origin", referrerPolicy: "no-referrer",
        headers: { "x-canvas-local": "1", ...(upload ? { "content-type": upload.mimeType, "x-content-sha256": upload.checksum } : text === undefined ? {} : { "content-type": "application/json" }) },
      }), late => { void late.body?.cancel().catch(() => undefined); });
      const length = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
      if (response.redirected || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")
        || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "")
        || (encoding && encoding !== "identity") || (length === null ? resource === "locked-production-image-preparations"
          : !/^\d+$/.test(length) || Number(length) < 1 || Number(length) > (resource === "image-providers" ? 2 * 1024 * 1024 : 512 * 1024))) throw new Error();
      reader = response.body?.getReader(); if (!reader) throw new Error();
      let bytes = 0, fragments = 0;
      for (;;) {
        const item = await life.wait(reader.read()); if (item.done) break;
        if (!item.value.length) continue;
        bytes += item.value.length;
        if (bytes > (resource === "image-providers" ? 2 * 1024 * 1024 : 512 * 1024) || ++fragments > 4096) throw new Error();
        chunks.push(Uint8Array.from(item.value));
      }
      life.check(); if (length !== null && bytes !== Number(length)) throw new Error();
      const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); } finally { data.fill(0); }
      if (!response.ok) throw new Error();
      life.check(); return schema.parse(value);
    } catch { throw new Error("保护响应未能完整核对；保留原指针与可能已有的预留，仅只读核对，不自动重发。"); }
    finally { void reader?.cancel().catch(() => undefined); try { reader?.releaseLock(); } catch { /* A non-cooperating read still occupies its lifetime slot. */ } chunks.forEach(c => c.fill(0)); life.close(); }
  }
  private async validate(record: LockedProductionImagePreparationPublic) {
    const p = LockedProductionImagePreparationPublicSchema.parse(record);
    if (this.signal.aborted || p.tenantId !== this.scope.tenantId || p.mode !== this.scope.mode) throw new Error("生产准备范围不一致或已取消。");
    const life = new ProductionReadLifetime(this.signal, "production-local-validation");
    try { const digest = new Uint8Array(await life.wait(crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(p.constraint))))); life.check();
      if (Array.from(digest, v => v.toString(16).padStart(2, "0")).join("") !== p.requestDraft.constraintChecksumSha256) throw new Error("完整冻结人工约束 SHA 不一致。");
    } finally { life.close(); }
    return p;
  }
  async prepare(input: CreateImagePreparation, beforePost?: () => void) {
    const selection = CreateImagePreparationSchema.parse(input);
    if (selection.parameters.size === "auto" || selection.operation !== "edit" || selection.protection !== "pixel-exact" || !selection.maskAssetId) throw new Error("保护准备须显式原约束尺寸、编辑与绑定蒙版。");
    const p = await this.validate(await this.request(selection.projectId, "", LockedProductionImagePreparationPublicSchema, selection, undefined, beforePost)), d = p.requestDraft;
    if (p.projectId !== selection.projectId || d.connectionId !== selection.connectionId || d.connectionRevision !== selection.connectionRevision
      || d.model !== selection.model || d.capabilityVersion !== selection.capabilityVersion || d.operation !== selection.operation
      || d.constraintSnapshotId !== selection.constraintSnapshotId || d.protection !== selection.protection
      || JSON.stringify(d.parameters) !== JSON.stringify(selection.parameters) || JSON.stringify(d.providerParameters ?? {}) !== JSON.stringify(selection.providerParameters ?? {})
      || JSON.stringify(d.inputs.map(i => i.assetId)) !== JSON.stringify(selection.inputAssetIds)
      || (d.operation === "edit" ? d.mask?.assetId : undefined) !== (selection.operation === "edit" ? selection.maskAssetId : undefined)) throw new Error("生产准备与原人工选择不一致；仅只读恢复。");
    return p;
  }
  async preparation(projectId: string, id: string) {
    productionReadId(id);
    const p = await this.validate(await this.request(projectId, `/${encodeURIComponent(id)}`, LockedProductionImagePreparationPublicSchema));
    if (p.id !== id || p.projectId !== projectId) throw new Error("生产历史准备编号或项目不一致。"); return p;
  }
  private match(p: LockedProductionImagePreparationPublic, c: LockedProductionImageConfirmationPublic) {
    const d = p.requestDraft, refs = [...d.inputs, ...(d.operation === "edit" && d.mask ? [d.mask] : [])];
    if (c.tenantId !== p.tenantId || c.projectId !== p.projectId || c.mode !== p.mode || c.preparationId !== p.id || c.preparationFingerprint !== p.snapshotFingerprint
      || c.protectionPolicyFingerprint !== p.protectionPolicyFingerprint || JSON.stringify(c.protectionPolicy) !== JSON.stringify(p.protectionPolicy)
      || c.pricingFingerprint !== p.pricingFingerprint || JSON.stringify(c.pricing) !== JSON.stringify(p.pricing) || c.confirmedBy !== p.createdBy
      || Date.parse(c.confirmedAt) < Date.parse(p.createdAt) || c.task.adapterId !== d.adapterId || c.task.constraintSnapshotId !== p.constraint.id
      || c.task.tool !== "image-edit" || JSON.stringify(c.task.inputAssetIds) !== JSON.stringify(refs.map(r => r.assetId))
      || c.transformedInputs.length !== refs.length || refs.some((r, index) => c.transformedInputs[index]?.assetId !== r.assetId
        || c.transformedInputs[index].originalChecksumSha256 !== r.checksumSha256
        || (index < d.inputs.length ? c.transformedInputs[index].transform !== "exif-srgb-png-v1" : c.transformedInputs[index].transform === "exif-srgb-png-v1"))) throw new Error("生产确认不匹配完整原准备；仅只读核对，不重发。");
    return c;
  }
  async history(record: LockedProductionImagePreparationPublic) {
    const p = await this.validate(record), h = await this.request(p.projectId, `/${encodeURIComponent(p.id)}/confirmation`, LockedProductionImageConfirmationHistorySchema);
    if (h.tenantId !== p.tenantId || h.projectId !== p.projectId || h.mode !== p.mode || h.preparationId !== p.id
      || h.protectionPolicyFingerprint !== p.protectionPolicyFingerprint || h.preparationFingerprint !== p.snapshotFingerprint || h.pricingFingerprint !== p.pricingFingerprint) throw new Error("生产确认历史范围或原摘要不一致。");
    return h.confirmation ? this.match(p, h.confirmation) : null;
  }
  async confirm(record: LockedProductionImagePreparationPublic, beforePost?: () => void) {
    const p = await this.validate(record), q = p.pricing.quote;
    const body = ConfirmLockedProductionImagePreparationSchema.parse({ schemaVersion: 2, expectedProtectionPolicyFingerprint: p.protectionPolicyFingerprint, expectedSnapshotFingerprint: p.snapshotFingerprint, expectedPricingFingerprint: p.pricingFingerprint,
      expectedCurrency: q.currency, expectedMaxCostMinor: q.maxCostMinor, estimate: q.source === "manual-budget" ? { state: "unknown" } : { state: "known", expectedEstimatedCostMinor: q.estimatedCostMinor } });
    return this.match(p, await this.request(p.projectId, `/${encodeURIComponent(p.id)}/confirm`, LockedProductionImageConfirmationPublicSchema, body, undefined, beforePost));
  }
  providers(projectId: string) { return this.request(projectId, "", ImageProviderListSchema, undefined, "image-providers"); }
  async register(context: RegisterRunContextRequest, beforePost: () => void) {
    await this.request(context.projectId, "", { parse(v: unknown) { if (!v || typeof v !== "object" || (v as { registered?: unknown }).registered !== true || Object.keys(v).join() !== "registered") throw new Error(); } }, RegisterRunContextRequestSchema.parse(context), "context", beforePost);
  }
  async verifyImage(projectId: string, assetId: string, original: Blob, mimeType: string, beforePost: () => void) {
    productionReadId(assetId); if (!original.size || original.size > 30 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(mimeType) || original.type !== mimeType) throw new Error("保护原文件声明不符。");
    const life = new ProductionReadLifetime(this.signal, "production-local-validation");
    let bytes: ArrayBuffer | undefined;
    try { bytes = await life.wait(original.arrayBuffer(), late => new Uint8Array(late).fill(0)); const digest = await life.wait(crypto.subtle.digest("SHA-256", bytes)); life.check();
      const checksum = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      const r = await life.wait(this.request(projectId, `/${encodeURIComponent(assetId)}/verification`, VerifiedImageSchema, undefined, "assets", beforePost, { body: original, mimeType, checksum }, life.signal));
      life.check(); if (r.tenantId !== this.scope.tenantId || r.asset.projectId !== projectId || r.asset.id !== assetId || r.checksumSha256 !== checksum || r.asset.byteSize !== original.size || r.asset.mimeType !== mimeType) throw new Error("保护原文件核验错配。"); return r;
    } finally { if (bytes) new Uint8Array(bytes).fill(0); life.close(); }
  }
  async budget(projectId: string) {
    const b = await this.request(projectId, "", ProjectBudgetSnapshotSchema, undefined, "budget");
    if (b.tenantId !== this.scope.tenantId || b.projectId !== projectId) throw new Error("预算响应范围不一致；原确认保留。");
    return b;
  }
}
