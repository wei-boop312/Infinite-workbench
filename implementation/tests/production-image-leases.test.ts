import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfirmedProductionImageExecution, ImageProviderConnection } from "../packages/contracts/src/index";
import { ImageProductionPreparationHarness, type ImagePriceContext } from "../apps/api/src/productionImagePreparations";
import { createProductionImageLeaseFixturePolicy, createProductionImageLeasePolicy, type ProductionImageLeasePolicy } from "../apps/api/src/productionImageLeasePolicy";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { InMemoryRunKernel, type RunKernelOptions } from "../apps/api/src/runKernel";
import { imageSnapshotFingerprint } from "../apps/api/src/imageProviderContract";
import { productionExpected } from "../apps/api/src/productionImageConfirmationIntegrity";
import { ImageProductionReconstructionHarness, ProductionImageTaskReconstruction } from "../apps/api/src/productionImageTaskReconstruction";
import * as productionProtocol from "../apps/api/src/productionImageProtocol";
import { validateProductionImageAssetPolicy } from "../apps/api/src/imageAssetPolicy";
import { assertProductionDispatchIntent } from "../apps/api/src/productionImageDispatchIntentIntegrity";
import { imageTaskMetadataBytes } from "../apps/api/src/imageTaskMetadata";
import { RunKernelError } from "../apps/api/src/runKernel";
import { at, connection, principal, setupImageTask } from "./helpers/image-task-fixture";

const owned: ReturnType<typeof setupImageTask>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of owned.splice(0).reverse()) f.cleanup(); });
const other = { ...principal, actorId: "other" }, worker = { workerId: "owned-worker", maxJobs: 2 };
function fixture(options: { protocol?: ImageProviderConnection["protocol"]; manual?: boolean; edit?: boolean; cap?: number; policy?: boolean;
  editEncoding?: "json-images" | "multipart-image-array" | "multipart-image-single";
  quota?: number; start?: boolean; kernel?: Partial<RunKernelOptions> } = {}) {
  let allowed: unknown = true, service: ImageProductionPreparationHarness, policy: ProductionImageLeasePolicy, reconstruction: ImageProductionReconstructionHarness;
  const denied = new Set<string>();
  const authorizer = { authenticate: () => principal, allows: (p: typeof principal, project: string, permission: string) =>
    p.tenantId === principal.tenantId && ["writer", "other"].includes(p.actorId) && project === "project-a" && !denied.has(permission) ? allowed as boolean : false };
  const gate: ProductionImageLeasePolicy = { usesStateStore: (s) => policy.usesStateStore(s), authorizeScope: (p, project) => policy.authorizeScope(p, project),
    validate: (p, e, purpose, bytes) => policy.validate(p, e, purpose, bytes) };
  const kernelOptions = { authorizer, validateProductionImageConfirmation: (p: typeof principal, e: ConfirmedProductionImageExecution) => service.authorizeConfirmation(p, e),
    ...(options.start ? { productionImageStartPolicy: { usesStateStore: (s: unknown) => reconstruction?.usesStateStore(s) ?? false,
      authorizeScope: (p: typeof principal, project: string) => reconstruction?.authorizeScope(p, project) ?? false,
      validateStart: (p: typeof principal, e: any, l: any, i: any) => reconstruction?.validateStart(p, e, l, i) ?? false } } : {}),
    ...(options.policy === false ? {} : { productionImageLeasePolicy: gate }), ...options.kernel };
  const f = setupImageTask({ format: options.protocol === "google" ? "jpeg" : "png", kernel: kernelOptions }); owned.push(f);
  const base = connection(), model = base.models[0], protocol = options.protocol ?? "openai";
  const config = connection({ protocol,
    ...(protocol === "openai-compatible" ? { compatibility: { version: "owned-compat", editEncoding: options.editEncoding ?? "json-images", responseEncoding: "images-b64-json-v1",
      auth: { scheme: "header", headerName: "x-api-key" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}),
    ...(protocol === "google" ? { baseUrl: "https://generativelanguage.googleapis.com", models: [{ ...model, maxInputImages: 14, outputFormats: ["jpeg"] }],
      googleNative: { version: "owned-google", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: model.model,
        sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] } } : {}) });
  f.register(config); if (options.edit) f.source();
  const pricePort = { kind: "contract-fixture" as const, realExecutionEnabled: false as const,
    read: vi.fn((c: ImagePriceContext) => ({ schemaVersion: 1, scope: c.scope, quote: { id: "owned-price", version: "owned-v1",
      source: options.manual ? "manual-budget" : "server-price-table", currency: "CNY", maxCostMinor: options.cap ?? 40,
      ...(options.manual ? {} : { estimatedCostMinor: 25 }), expiresAt: new Date(f.clock() + 60_000).toISOString() },
      evidence: { kind: "contract-fixture", realExecutionEnabled: false, sourceRevision: "owned-table", evidenceRef: "no-real-price",
        checkedBy: "owned-oracle", checkedAt: c.requestedAt } })), verify: vi.fn((): unknown => true) };
  const policyOptions = { leasePreparationEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store,
    runAuthorizer: authorizer, providerAuthorizer: authorizer, assetAuthorizer: authorizer, clock: f.clock, pricePort: pricePort as any, maxMetadataBytes: options.quota };
  policy = createProductionImageLeaseFixturePolicy(policyOptions);
  service = new ImageProductionPreparationHarness({ preparationEnabled: true, tenantId: principal.tenantId, stateStore: f.store,
    authorizer, runAuthorizer: authorizer, assetAuthorizer: authorizer, clock: f.clock, pricePort: pricePort as any, runKernel: f.kernel });
  reconstruction = new ImageProductionReconstructionHarness({ reconstructionEnabled: true, startEnabled: true, leasePolicy: gate,
    tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, clock: f.clock });
  const confirm = async (action = "owned-action") => {
    const prepared = service.createPreparation(principal, { projectId: "project-a", idempotencyKey: action, connectionId: config.id, connectionRevision: 1,
      model: model.model, capabilityVersion: model.version, constraintSnapshotId: "constraint-a", protection: "none", operation: options.edit ? "edit" : "generate",
      inputAssetIds: options.edit ? ["source"] : [], parameters: { prompt: "原人工指令", n: 1, size: { width: 1024, height: 1024 }, quality: "auto",
        background: "auto", outputFormat: options.protocol === "google" ? "jpeg" : "png" } });
    const record = f.store.loadProductionImagePreparation(principal.tenantId, "project-a", "production-contract-fixture", prepared.id)!;
    return (await service.confirmPreparation(principal, "project-a", record.id, productionExpected(record))).aggregate;
  };
  const claim = (batch: string, p = principal, input = worker) => f.kernel.claimProductionImageBatch(p, "project-a", batch, input);
  const reopen = (store: SqliteRunKernelStateStore, overrides: Partial<RunKernelOptions> = {}) => new SqliteRunKernel({ ...kernelOptions, ...overrides,
    stateStore: store, authorizer, clock: f.clock, budgets: [{ tenantId: principal.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }],
    productionImageLeasePolicy: createProductionImageLeaseFixturePolicy({ ...policyOptions, stateStore: store }) });
  const start = (batch: string, p = principal, input?: { workerId: string; leaseId: string }, signal?: AbortSignal) => {
    const stored = f.store.load()!.batches.find((b) => b.aggregate.batch.id === batch)!, l = stored.productionImageLeases!.at(-1)!;
    return reconstruction.start(p, "project-a", batch, stored.aggregate.jobs[0].id, input ?? { workerId: l.workerId, leaseId: l.leaseId }, signal);
  };
  const reopenStart = (store: SqliteRunKernelStateStore) => {
    let service: ImageProductionReconstructionHarness;
    const leasePolicy = createProductionImageLeaseFixturePolicy({ ...policyOptions, stateStore: store });
    const kernel = reopen(store, { productionImageStartPolicy: { usesStateStore: (s) => service?.usesStateStore(s) ?? false,
      authorizeScope: (p, project) => service?.authorizeScope(p, project) ?? false, validateStart: (p, e, l, i) => service?.validateStart(p, e, l, i) ?? false } });
    service = new ImageProductionReconstructionHarness({ reconstructionEnabled: true, startEnabled: true, leasePolicy, tenantId: principal.tenantId,
      stateStore: store, runKernel: kernel, clock: f.clock }); return { kernel, reconstruction: service };
  };
  return { ...f, config, policy, gate, policyOptions, pricePort, confirm, claim, reopen, reopenStart, start, reconstruction, authorizer,
    deny: (permission: string) => denied.add(permission), allow: (value: unknown) => { allowed = value; } };
}
const unchanged = (f: ReturnType<typeof fixture>, action: () => unknown) => {
  const before = f.store.load(); expect(action).toThrow(); expect(f.store.load()).toEqual(before);
};

describe("6D3B2 独立意图纯历史关系（不是启动授权）", () => {
  async function evidence(options: Parameters<typeof fixture>[0] = { manual: true }) {
    const f = fixture(options), batch = await f.confirm(); f.claim(batch.batch.id);
    const stored = f.store.load()!.batches[0], e = stored.productionImageExecution!, lease = stored.productionImageLeases![0], protocol = e.protocol;
    const intent = { schemaVersion: 1, mode: e.mode, transport: "not-connected",
      id: "production-image-intent:00000000-0000-4000-8000-000000000001", batchId: e.batchId, jobId: protocol.request.jobId,
      actorId: lease.actorId, workerId: lease.workerId, leaseId: lease.leaseId, executionFingerprint: imageSnapshotFingerprint(e),
      leaseFingerprint: imageSnapshotFingerprint(lease), requestFingerprint: protocol.requestFingerprint,
      payloadChecksumSha256: protocol.payloadChecksumSha256, payloadByteSize: protocol.payloadByteSize, contentType: protocol.contentType,
      transformedInputsFingerprint: imageSnapshotFingerprint(protocol.transformedInputs), protocolVersion: protocol.protocolVersion,
      confirmedAt: e.confirmedAt, reconstructedAt: lease.leasedAt, recordedAt: lease.leasedAt };
    return { f, e, lease, intent };
  }
  it("只校验历史关系，不改变任务/预算或将未知估价补零", async () => {
    const { f, e, lease, intent } = await evidence(), before = f.store.load();
    expect(assertProductionDispatchIntent(intent, imageSnapshotFingerprint(intent), e, lease)).toEqual(intent);
    expect(f.store.load()).toEqual(before); expect(before!.batches[0].aggregate.jobs[0]).toMatchObject({ status: "leased", estimatedCostMinor: null });
    expect(before!.batches[0]).not.toHaveProperty("productionImageDispatchIntent");
  });
  it.each(["mode", "transport", "id", "jobId", "batchId", "actorId", "workerId", "leaseId", "executionFingerprint", "leaseFingerprint",
    "requestFingerprint", "payloadChecksumSha256", "payloadByteSize", "contentType", "transformedInputsFingerprint", "protocolVersion", "confirmedAt"])("重算意图SHA仍不能绕过 %s 关系", async (field) => {
    const { e, lease, intent } = await evidence(), changed: Record<string, unknown> = { ...intent };
    changed[field] = field === "mode" ? "production" : field === "transport" ? "sent" : field === "id" ? "image-intent-00000000-0000-4000-8000-000000000001"
      : field.endsWith("Fingerprint") || field.endsWith("Sha256") ? "f".repeat(64)
      : field === "payloadByteSize" ? intent.payloadByteSize + 1 : field === "confirmedAt" ? new Date(Date.parse(intent.confirmedAt) + 1).toISOString() : "forged";
    expect(() => assertProductionDispatchIntent(changed, imageSnapshotFingerprint(changed), e, lease)).toThrow();
  });
  it.each(["lease-expired", "price-expired", "before-lease", "before-confirmation", "future-reconstruction", "extra-permit"])("时间或伪许可 %s 拒绝", async (kind) => {
    const { e, lease, intent } = await evidence();
    const changed = { ...intent, ...(kind === "extra-permit" ? { executionAuthorized: true } : {}),
      ...(kind === "lease-expired" ? { recordedAt: lease.expiresAt } : {}),
      ...(kind === "price-expired" ? { recordedAt: e.protocol.request.quote.expiresAt } : {}),
      ...(kind === "before-lease" ? { reconstructedAt: new Date(Date.parse(lease.leasedAt) - 1).toISOString() } : {}),
      ...(kind === "before-confirmation" ? { reconstructedAt: new Date(Date.parse(e.confirmedAt) - 1).toISOString() } : {}),
      ...(kind === "future-reconstruction" ? { reconstructedAt: new Date(Date.parse(intent.recordedAt) + 1).toISOString() } : {}) };
    expect(() => assertProductionDispatchIntent(changed, imageSnapshotFingerprint(changed), e, lease)).toThrow();
  });
  it("损坏摘要和替换原租约/确认拒绝，校验结果不能作为启动端口", async () => {
    const { e, lease, intent } = await evidence(), digest = imageSnapshotFingerprint(intent);
    expect(() => assertProductionDispatchIntent(intent, "0".repeat(64), e, lease)).toThrow();
    expect(() => assertProductionDispatchIntent(intent, digest, e, { ...lease, actorId: "other" })).toThrow();
    expect(() => assertProductionDispatchIntent(intent, digest, { ...e, confirmedBy: "other" }, lease)).toThrow();
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s 生成/编辑及known/unknown只绑定完整原冻结关系", async (protocol) => {
    for (const edit of [false, true]) for (const manual of [false, true]) {
      const { f, e, lease, intent } = await evidence({ protocol, edit, manual }), before = f.store.load();
      expect(assertProductionDispatchIntent(intent, imageSnapshotFingerprint(intent), e, lease)).toEqual(intent);
      expect(f.store.load()).toEqual(before); expect(f.pricePort.read).toHaveBeenCalledTimes(1);
      expect(before!.batches[0].aggregate.jobs[0].estimatedCostMinor).toBe(manual ? null : 25);
    }
  });
  it("更换有效原执行/租约并重算部分摘要仍不匹配原完整确认", async () => {
    const first = await evidence(), second = await evidence(), changed = { ...first.intent, leaseFingerprint: imageSnapshotFingerprint(second.lease) };
    expect(() => assertProductionDispatchIntent(changed, imageSnapshotFingerprint(changed), first.e, second.lease)).toThrow();
    const changedExecution = { ...first.intent, executionFingerprint: imageSnapshotFingerprint(second.e) };
    expect(() => assertProductionDispatchIntent(changedExecution, imageSnapshotFingerprint(changedExecution), second.e, first.lease)).toThrow();
  });
});

describe("6D3B2 实际重建续接/同库意图/未知预留", () => {
  async function started(options: Parameters<typeof fixture>[0] = {}) {
    const f = fixture({ start: true, ...options }), b = await f.confirm(); const l = f.claim(b.batch.id).leases[0];
    const result = await f.start(b.batch.id); return { f, b, l, result };
  }
  it("缺启动政策/服务开关在私有读取前关闭，不把B1摘要变成证明", async () => {
    const f = fixture(), b = await f.confirm(), l = f.claim(b.batch.id).leases[0], read = vi.spyOn(f.store, "load");
    await expect(f.reconstruction.start(principal, "project-a", b.batch.id, l.jobId, { leaseId: l.leaseId, workerId: l.workerId })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    await expect(new ProductionImageTaskReconstruction().start(principal, "project-a", "fake", "fake", {})).rejects.toThrow();
  });
  it.each(["run:read", "run:execute", "provider:read", "asset:read"])("启动前%s撤权不接触私有上下文", async (permission) => {
    const f = fixture({ start: true }), b = await f.confirm(), l = f.claim(b.batch.id).leases[0]; f.deny(permission);
    const read = vi.spyOn(f.store, "load"), raw = vi.spyOn(f.store, "loadVerifiedImageBytes");
    await expect(f.reconstruction.start(principal, "project-a", b.batch.id, l.jobId, { workerId: l.workerId, leaseId: l.leaseId })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s实际生成/编辑known/unknown只保存原wire摘要和上限", async (protocol) => {
    for (const edit of [false, true]) for (const manual of [false, true]) {
      const { f, result } = await started({ protocol, edit, manual }), s = f.store.load()!.batches[0], e = s.productionImageExecution!;
      expect(result.started).toBe(true); expect(s.productionImageDispatchIntent).toMatchObject({ mode: e.mode, transport: "not-connected",
        payloadChecksumSha256: e.protocol.payloadChecksumSha256, contentType: e.protocol.contentType, payloadByteSize: e.protocol.payloadByteSize });
      expect(s.aggregate.jobs[0].estimatedCostMinor).toBe(manual ? null : 25); expect(s.jobReservations).toEqual([[e.protocol.request.jobId, 40]]);
      expect(s.aggregate.ledger).toHaveLength(1); expect(f.pricePort.read).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result.intent)).not.toMatch(/never-called|credentialRef|opaque-never|base64|原人工指令/);
      expect(s).not.toHaveProperty("imageDispatchIntent"); expect(s).not.toHaveProperty("imageFixtureAttempt");
    }
  });
  it.each(["multipart-image-array", "multipart-image-single"] as const)("%s启动沿用原真实boundary并清除自有负载", async (editEncoding) => {
    const f = fixture({ start: true, protocol: "openai-compatible", edit: true, editEncoding }), b = await f.confirm(); f.claim(b.batch.id);
    const original = productionProtocol.prepareProductionImageProtocol; let wire: Buffer | undefined;
    vi.spyOn(productionProtocol, "prepareProductionImageProtocol").mockImplementation(async (...args) => { const r = await original(...args); wire = r.wire.body; return r; });
    expect((await f.start(b.batch.id)).intent.contentType).toContain("multipart/form-data; boundary=canvas-"); expect(wire!.every((v) => v === 0)).toBe(true);
  });
  it("首次原子保存not-connected意图与running；重复不重建，不发送或结算", async () => {
    const f = fixture({ start: true, manual: true }), batch = await f.confirm(); f.claim(batch.batch.id);
    f.advance(1); const first = await f.start(batch.batch.id);
    expect(first).toMatchObject({ started: true, executionAuthorized: false, realExecutionEnabled: false,
      aggregate: { batch: { status: "running", estimatedCostMinor: null }, jobs: [{ status: "running", outputAssetIds: [] }] }, intent: { transport: "not-connected" } });
    expect(first.intent.reconstructedAt).not.toBe(first.intent.confirmedAt);
    const before = f.store.load(), spy = vi.spyOn(productionProtocol, "prepareProductionImageProtocol");
    expect(await f.start(batch.batch.id)).toMatchObject({ started: false, intent: first.intent }); expect(spy).not.toHaveBeenCalled();
    expect(f.store.load()).toEqual(before); expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0 });
    expect(before!.batches[0].aggregate.audit.filter((a) => a.eventType === "job-started")).toHaveLength(1);
  });
  it("纯历史意图/完整B1返回摘要无私有活续接，直接内核启动拒绝", async () => {
    const f = fixture({ start: true }), b = await f.confirm(), l = f.claim(b.batch.id).leases[0], e = f.store.load()!.batches[0].productionImageExecution!;
    const rebuilt = await f.reconstruction.reconstruct(principal, "project-a", b.batch.id, l.jobId, { workerId: l.workerId, leaseId: l.leaseId });
    const evidence = f.store.load()!.batches[0].productionImageLeases![0];
    const i = { schemaVersion: 1, mode: e.mode, transport: "not-connected", id: "production-image-intent:00000000-0000-4000-8000-000000000001",
      jobId: l.jobId, batchId: b.batch.id, actorId: principal.actorId, workerId: l.workerId, leaseId: l.leaseId,
      executionFingerprint: rebuilt.executionFingerprint, leaseFingerprint: imageSnapshotFingerprint(evidence), requestFingerprint: rebuilt.requestFingerprint,
      payloadChecksumSha256: rebuilt.payloadChecksumSha256, payloadByteSize: rebuilt.payloadByteSize, contentType: rebuilt.contentType,
      transformedInputsFingerprint: imageSnapshotFingerprint(rebuilt.transformedInputs), protocolVersion: rebuilt.protocolVersion,
      confirmedAt: e.confirmedAt, reconstructedAt: rebuilt.reconstructedAt, recordedAt: rebuilt.validatedAt } as any;
    expect(f.reconstruction.validateStart(principal, e, evidence, i)).toBe(false);
    unchanged(f, () => f.kernel.startProductionImageJob(principal, "project-a", b.batch.id, l.jobId, { workerId: l.workerId, leaseId: l.leaseId }, i));
  });
  it("并发重建只记录一次启动；第二份恢复同一历史而不结算", async () => {
    const f = fixture({ start: true, edit: true }), b = await f.confirm(); f.claim(b.batch.id);
    const results = await Promise.all([f.start(b.batch.id), f.start(b.batch.id)]);
    expect(results.map((r) => r.started).sort()).toEqual([false, true]); expect(results[0].intent).toEqual(results[1].intent);
    expect(f.store.load()!.batches[0].aggregate.audit.filter((a) => a.eventType === "job-started")).toHaveLength(1);
  });
  it("跨连接/重启历史只读，目录停用报价过期不重建或新启动", async () => {
    const { f, b, l, result } = await started({ edit: true, manual: true }); f.advance(60_000); f.register(connection({ revision: 2, enabled: false }));
    const store = new SqliteRunKernelStateStore(f.path);
    try { const restored = f.reopenStart(store), before = store.load(), prepare = vi.spyOn(productionProtocol, "prepareProductionImageProtocol"); f.pricePort.verify.mockClear();
      const repeat = await restored.reconstruction.start(principal, "project-a", b.batch.id, l.jobId, { workerId: l.workerId, leaseId: l.leaseId });
      expect(repeat).toMatchObject({ started: false, intent: result.intent }); expect(prepare).not.toHaveBeenCalled(); expect(f.pricePort.verify).not.toHaveBeenCalled();
      expect(store.load()).toEqual(before); expect(repeat.aggregate.batch.status).toBe("running");
    } finally { store.close(); }
  });
  it.each(["actor", "worker", "lease"])("已记录历史仍拒绝%s错配，不当新许可", async (kind) => {
    const { f, b, l } = await started({ edit: true }), before = f.store.load();
    await expect(f.start(b.batch.id, kind === "actor" ? other : principal, { workerId: kind === "worker" ? "other" : l.workerId,
      leaseId: kind === "lease" ? "other" : l.leaseId })).rejects.toThrow(); expect(f.store.load()).toEqual(before);
  });
  it.each(["revoke", "expiry", "price", "constraint", "connection", "cancel", "abort", "verify"])("归一化await后%s不创建意图、不动未知估价预留", async (kind) => {
    const f = fixture({ start: true, edit: true, manual: true }), b = await f.confirm(); f.claim(b.batch.id); const controller = new AbortController();
    const original = productionProtocol.prepareProductionImageProtocol; let wire: Buffer | undefined;
    vi.spyOn(productionProtocol, "prepareProductionImageProtocol").mockImplementation(async (...args) => {
      const r = await original(...args); wire = r.wire.body;
      if (kind === "revoke") f.deny("asset:read"); if (kind === "expiry") f.advance(30_000); if (kind === "price") f.advance(60_000);
      if (kind === "constraint") f.store.transaction(() => { const c = f.store.loadCatalog()!; c.projects[0].constraints[0].brandRules = { changed: "yes" }; f.store.saveCatalog(c); });
      if (kind === "connection") f.register(connection({ revision: 2 })); if (kind === "cancel") f.kernel.cancelBatch(principal, b.batch.id);
      if (kind === "abort") controller.abort(); if (kind === "verify") f.pricePort.verify.mockReturnValue(false); return r;
    });
    await expect(f.start(b.batch.id, principal, undefined, controller.signal)).rejects.toThrow();
    expect(f.store.load()!.batches[0]).not.toHaveProperty("productionImageDispatchIntent");
    expect(f.store.load()!.batches[0].reservedMinor).toBe(kind === "cancel" ? 0 : 40); expect(wire!.every((v) => v === 0)).toBe(true);
  });
  it.each(["fault", "revoke", "expiry", "price", "abort", "verify", "clock"])("实际SQL写后%s回滚意图/任务/审计，原预留不丢", async (kind) => {
    const f = fixture({ start: true, manual: true }), b = await f.confirm(); f.claim(b.batch.id); const before = f.store.load(), controller = new AbortController();
    const save = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementation((s) => { save(s); if (!s.batches[0].productionImageDispatchIntent) return;
      if (kind === "fault") throw new Error("private-intent-write"); if (kind === "revoke") f.deny("run:execute"); if (kind === "expiry") f.advance(30_000);
      if (kind === "price") f.advance(60_000); if (kind === "abort") controller.abort(); if (kind === "verify") f.pricePort.verify.mockReturnValue(false); if (kind === "clock") f.advance(-1);
    });
    await expect(f.start(b.batch.id, principal, undefined, controller.signal)).rejects.toThrow(); expect(f.store.load()).toEqual(before);
  });
  it.each([0, 40])("上限%s运行到期恢复unknown；重复/读取/重启不释放或重发", async (cap) => {
    const { f, b, l, result } = await started({ manual: true, cap }); f.advance(30_000);
    const before = f.store.load(); expect(f.kernel.getBatch(principal, b.batch.id).batch.status).toBe("running"); expect(f.store.load()).toEqual(before);
    const unknown = f.kernel.reconcileProductionImageBatch(principal, "project-a", b.batch.id);
    expect(unknown).toMatchObject({ batch: { status: "billing_unknown", estimatedCostMinor: null }, jobs: [{ status: "billing_unknown", failureCode: "production-lease-expired-after-intent" }] });
    expect(unknown.ledger).toHaveLength(2); expect(unknown.ledger[1]).toMatchObject({ settlement: "unknown", reservedMinor: cap, estimatedMinor: null, imageMode: "production-contract-fixture" });
    expect(f.store.load()!.batches[0].jobReservations).toEqual([[l.jobId, cap]]); expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: cap, spentMinor: 0 });
    const saved = f.store.load(); expect(f.kernel.reconcileProductionImageBatch(principal, "project-a", b.batch.id)).toEqual(unknown);
    expect(await f.start(b.batch.id)).toMatchObject({ started: false, intent: result.intent }); expect(f.store.load()).toEqual(saved);
    expect(() => f.kernel.cancelBatch(principal, b.batch.id)).toThrow(); expect(f.store.load()).toEqual(saved);
  });
  it("未到租约期限但达到独立任务超时也保留unknown上限", async () => {
    const { f, b } = await started({ kernel: { jobTimeoutMs: 1000 } }); f.advance(1000);
    expect(f.kernel.reconcileProductionImageBatch(principal, "project-a", b.batch.id).jobs[0].failureCode).toBe("production-job-timeout-after-intent");
    expect(f.store.load()!.batches[0].reservedMinor).toBe(40);
  });
  it("内存崩溃恢复记录独立unknown，完整历史关系和预算守恒", async () => {
    const { f, b } = await started({ manual: true }), saved = f.store.load()!; let current = saved;
    const kernel = new InMemoryRunKernel({ authorizer: f.authorizer, budgets: saved.budgets, clock: f.clock,
      productionImageLeasePolicy: f.gate, stateStore: { load: () => current, save: (v) => { current = v; } } });
    expect(kernel.getBatch(principal, b.batch.id).jobs[0].failureCode).toBe("production-recovered-after-restart");
    expect(current.batches[0].aggregate.ledger[1]).toMatchObject({ imageMode: "production-contract-fixture", estimatedMinor: null, reservedMinor: 40, settlement: "unknown" });
    expect(() => InMemoryRunKernel.assertSnapshot(current)).not.toThrow(); expect(current.budgets).toEqual(saved.budgets);
  });
  it.each(["revoke", "fault"])("unknown恢复写后%s原子回滚仍保留原意图和预留", async (kind) => {
    const { f, b } = await started(); f.advance(30_000); const save = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementation((s) => { save(s); if (kind === "revoke") f.deny("asset:read"); else throw new Error("private-unknown-write"); });
    unchanged(f, () => f.kernel.reconcileProductionImageBatch(principal, "project-a", b.batch.id));
  });
  it("生产running占用共用供应商并发；历史恢复不新增领取窗口记录", async () => {
    const { f, b } = await started({ kernel: { providerLimits: [{ adapterId: "fixture-image-v1", maxConcurrentJobs: 1 }] } });
    const second = await f.confirm("second"); expect(f.claim(second.batch.id)).toMatchObject({ leases: [], throttledBy: "provider-concurrency" });
    expect(await f.start(b.batch.id)).toMatchObject({ started: false });
    expect(f.store.load()!.batches[0].aggregate.audit.filter((a) => a.eventType === "job-leased")).toHaveLength(1);
  });
  it("新意图及审计计共享元数据容量，满额拒绝且不删除旧历史", async () => {
    const f = fixture({ start: true }), b = await f.confirm(); f.claim(b.batch.id); const before = f.store.load();
    const current = f.store.imageMetadataBytes(principal.tenantId, "project-a") + imageTaskMetadataBytes(before, principal.tenantId, "project-a");
    const blocked = createProductionImageLeaseFixturePolicy({ ...f.policyOptions, maxMetadataBytes: current + 1 });
    vi.spyOn(f.gate, "validate").mockImplementation((...args) => blocked.validate(...args));
    await expect(f.start(b.batch.id)).rejects.toThrow(); expect(f.store.load()).toEqual(before);
  });
  it.each(["false", "promise"])("最终同步启动政策%s失败关闭，不把创建确认当启动许可", async (kind) => {
    const f = fixture({ start: true }), b = await f.confirm(); f.claim(b.batch.id); const before = f.store.load();
    vi.spyOn(f.reconstruction, "validateStart").mockImplementation(() => kind === "promise" ? Promise.resolve(true) as any : false);
    await expect(f.start(b.batch.id)).rejects.toThrow(); expect(f.store.load()).toEqual(before);
  });
  it.each(["async-rejection", "private-throw"])("存储绑定政策%s失败关闭，不泄漏异常或遗留未处理Promise", async (kind) => {
    const f = fixture({ start: true }), b = await f.confirm(), l = f.claim(b.batch.id).leases[0], before = f.store.load();
    vi.spyOn(f.gate, "usesStateStore").mockImplementation(() => {
      if (kind === "private-throw") throw new Error("PRIVATE-START-PORT"); return Promise.reject(new Error("PRIVATE-START-PORT")) as any;
    });
    const read = vi.spyOn(f.store, "load");
    await expect(f.reconstruction.start(principal, "project-a", b.batch.id, l.jobId, { workerId: l.workerId, leaseId: l.leaseId })).rejects.toThrow("未启动或发送请求");
    expect(read).not.toHaveBeenCalled(); expect(f.store.load()).toEqual(before);
  });
  it("相同路径不同实例启动关闭，生产入口不能给合同夹具改名", async () => {
    const f = fixture({ start: true }), b = await f.confirm(), l = f.claim(b.batch.id).leases[0], before = f.store.load(), store = new SqliteRunKernelStateStore(f.path);
    try {
      const args = { reconstructionEnabled: true as const, startEnabled: true as const, leasePolicy: f.gate, tenantId: principal.tenantId,
        runKernel: f.kernel, clock: f.clock };
      await expect(new ImageProductionReconstructionHarness({ ...args, stateStore: store }).start(principal, "project-a", b.batch.id, l.jobId,
        { workerId: l.workerId, leaseId: l.leaseId })).rejects.toThrow();
      await expect(new ProductionImageTaskReconstruction({ ...args, stateStore: f.store }).start(principal, "project-a", b.batch.id, l.jobId,
        { workerId: l.workerId, leaseId: l.leaseId })).rejects.toThrow(); expect(f.store.load()).toEqual(before);
    } finally { store.close(); }
  });
  it.each(["wire", "transform"])("发送前实际%s重建错配不能记录启动", async (kind) => {
    const f = fixture({ start: true, edit: true }), b = await f.confirm(); f.claim(b.batch.id); const before = f.store.load(), original = productionProtocol.prepareProductionImageProtocol;
    vi.spyOn(productionProtocol, "prepareProductionImageProtocol").mockImplementation(async (...args) => {
      const r = await original(...args); if (kind === "wire") r.wire.body[0] ^= 1;
      else r.snapshot.transformedInputs[0].transmittedChecksumSha256 = "0".repeat(64); return r;
    });
    await expect(f.start(b.batch.id)).rejects.toThrow(); expect(f.store.load()).toEqual(before);
  });
  it.each(["intent", "fingerprint", "lease", "request", "start-audit", "started-at", "transport", "mode", "unknown-ledger", "unknown-audit", "release"])("部分重算或恢复损坏%s不能制造许可/结算", async (kind) => {
    const { f, b } = await started({ manual: true }); f.advance(30_000); f.kernel.reconcileProductionImageBatch(principal, "project-a", b.batch.id);
    const snapshot = f.store.load()!, s = snapshot.batches[0], i = s.productionImageDispatchIntent!;
    if (kind === "intent") delete s.productionImageDispatchIntent;
    if (kind === "fingerprint") s.productionImageDispatchIntentFingerprint = "0".repeat(64);
    if (kind === "lease") i.leaseFingerprint = "0".repeat(64);
    if (kind === "request") i.payloadChecksumSha256 = "0".repeat(64);
    if (kind === "transport") (i as any).transport = "sent";
    if (kind === "mode") i.mode = "production";
    if (["lease", "request", "transport", "mode"].includes(kind)) s.productionImageDispatchIntentFingerprint = imageSnapshotFingerprint(i);
    if (kind === "start-audit") s.aggregate.audit = s.aggregate.audit.filter((a) => a.eventType !== "job-started");
    if (kind === "started-at") s.aggregate.jobs[0].startedAt = new Date(Date.parse(i.recordedAt) + 1).toISOString();
    if (kind === "unknown-ledger") s.aggregate.ledger[1].reservedMinor = 0;
    if (kind === "unknown-audit") s.aggregate.audit.find((a) => a.eventType === "billing-unknown")!.metadata.intentFingerprint = "0".repeat(64);
    if (kind === "release") { s.jobReservations = []; s.reservedMinor = 0; snapshot.budgets[0].reservedMinor = 0; }
    expect(() => InMemoryRunKernel.assertSnapshot(snapshot)).toThrow();
  });
  it.each(["resolveBillingUnknown", "requestBillingOverage", "reviewBillingOverage", "executeLeasedJob", "reconcileBatch", "retryJob"])("unknown生产不套用旧入口%s", async (method) => {
    const { f, b, l } = await started({ manual: true }); f.advance(30_000); f.kernel.reconcileProductionImageBatch(principal, "project-a", b.batch.id);
    unchanged(f, () => (f.kernel[method as keyof SqliteRunKernel] as any)(principal, method === "reconcileBatch" ? b.batch.id : l.jobId,
      { resolutionId: "owned-not-permitted", resolution: "not-charged", expectedReservedMinor: 40, expectedCurrency: "CNY", workerId: l.workerId, leaseId: l.leaseId }));
  });
});

describe("6D3A 独立生产租约（自有零费用合同夹具，无发送）", () => {
  it("政策无配置默认关闭；生产类拒绝假价格端口", () => {
    expect(() => createProductionImageLeasePolicy()).toThrow(); expect(() => createProductionImageLeaseFixturePolicy()).toThrow();
    const f = fixture(); expect(() => createProductionImageLeasePolicy(f.policyOptions as any)).toThrow();
  });
  it("领取/检查/恢复未配置时在读取私有状态之前关闭", async () => {
    const f = fixture({ policy: false }), batch = await f.confirm(), load = vi.spyOn(f.store, "load");
    expect(() => f.claim(batch.batch.id)).toThrow();
    expect(() => f.kernel.inspectProductionImageLease(principal, "project-a", batch.batch.id, batch.jobs[0].id, { workerId: "a", leaseId: "b" })).toThrow();
    expect(() => f.kernel.reconcileProductionImageBatch(principal, "project-a", batch.batch.id)).toThrow(); expect(load).not.toHaveBeenCalled();
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s known/unknown 实际领取人/编号绑定，预算不变且不重报价", async (protocol) => {
    for (const manual of [false, true]) {
      const f = fixture({ protocol, manual, edit: true }), batch = await f.confirm(), before = f.kernel.getBudget(principal, "project-a");
      const result = f.claim(batch.batch.id, other), lease = result.leases[0];
      expect(result.leases).toHaveLength(1); expect(result.aggregate.jobs[0]).toMatchObject({ status: "leased", estimatedCostMinor: manual ? null : 25, id: batch.jobs[0].id, idempotencyKey: batch.jobs[0].idempotencyKey });
      const inspected = f.kernel.inspectProductionImageLease(other, "project-a", batch.batch.id, lease.jobId, { leaseId: lease.leaseId, workerId: lease.workerId });
      expect(inspected.lease).toMatchObject({ mode: "production-contract-fixture", actorId: "other", executionFingerprint: f.store.load()!.batches[0].requestFingerprint });
      expect(inspected.execution).toMatchObject({ executionAuthorized: false, realExecutionEnabled: false, executionState: "confirmed-not-dispatchable" });
      expect(f.kernel.getBudget(principal, "project-a")).toEqual(before); expect(f.pricePort.read).toHaveBeenCalledTimes(1);
      const contexts = f.pricePort.verify.mock.calls.map(([c]) => c as ImagePriceContext).filter((c) => c.purpose === "lease");
      expect(contexts.length).toBeGreaterThan(0); expect(contexts.every((c) => c.scope.actorId === principal.actorId)).toBe(true);
      expect(result.aggregate.audit.some((a) => a.eventType === "batch-dispatched" || a.eventType === "job-started")).toBe(false);
      expect(f.store.load()!.batches[0]).not.toHaveProperty("imageDispatchIntent");
    }
  });
  it.each(["run:read", "run:execute", "provider:read", "asset:read"])("%s 撤权不读私有状态或原文件", async (permission) => {
    const f = fixture({ edit: true }), batch = await f.confirm(); f.deny(permission);
    const load = vi.spyOn(f.store, "load"), raw = vi.spyOn(f.store, "loadVerifiedImage");
    expect(() => f.claim(batch.batch.id)).toThrow(); expect(load).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
  });
  it.each([false, 1, "true", Promise.resolve(true)])("严格同步权限 %s", async (value) => {
    const f = fixture(), batch = await f.confirm(); f.allow(value); unchanged(f, () => f.claim(batch.batch.id));
  });
  it.each([false, 1, "true", Promise.resolve(true)])("严格同步verify %s，不重新read", async (value) => {
    const f = fixture(), batch = await f.confirm(); f.pricePort.verify.mockReturnValue(value); unchanged(f, () => f.claim(batch.batch.id)); expect(f.pricePort.read).toHaveBeenCalledTimes(1);
  });
  it.each(["tenant", "actor", "project", "batch"])("跨范围 %s 拒绝", async (kind) => {
    const f = fixture(), batch = await f.confirm(); unchanged(f, () => f.kernel.claimProductionImageBatch(
      { ...principal, ...(kind === "tenant" ? { tenantId: "other" } : kind === "actor" ? { actorId: "unknown" } : {}) }, kind === "project" ? "other" : "project-a", kind === "batch" ? "other" : batch.batch.id, worker));
  });
  it.each(["job", "worker", "lease", "actor"])("检查实际租约 %s 错配拒绝", async (kind) => {
    const f = fixture(), batch = await f.confirm(), lease = f.claim(batch.batch.id).leases[0];
    unchanged(f, () => f.kernel.inspectProductionImageLease(kind === "actor" ? other : principal, "project-a", batch.batch.id,
      kind === "job" ? "other" : lease.jobId, { workerId: kind === "worker" ? "other" : lease.workerId, leaseId: kind === "lease" ? "other" : lease.leaseId }));
  });
  it("重复及跨连接/重启不重复领取或预留，历史仍可恢复完整确认", async () => {
    const f = fixture({ manual: true }), batch = await f.confirm(), result = f.claim(batch.batch.id), before = f.store.load();
    expect(f.claim(batch.batch.id).leases).toEqual([]); expect(f.claim(batch.batch.id, other).leases).toEqual([]); expect(f.store.load()).toEqual(before);
    const second = new SqliteRunKernelStateStore(f.path);
    try { const kernel = f.reopen(second); expect(kernel.claimProductionImageBatch(principal, "project-a", batch.batch.id, worker).leases).toEqual([]);
      expect(kernel.inspectProductionImageLease(principal, "project-a", batch.batch.id, batch.jobs[0].id, { workerId: result.leases[0].workerId, leaseId: result.leases[0].leaseId }).lease.leaseId).toBe(result.leases[0].leaseId);
      expect(second.load()).toEqual(before); } finally { second.close(); }
  });
  it("不同存储实例政策拒绝，即使文件路径相同", async () => {
    const f = fixture(), batch = await f.confirm(), second = new SqliteRunKernelStateStore(f.path);
    try {
      const bad = new SqliteRunKernel({ stateStore: second, authorizer: f.authorizer, clock: f.clock, budgets: [{ tenantId: principal.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }], productionImageLeasePolicy: f.policy });
      unchanged(f, () => bad.claimProductionImageBatch(principal, "project-a", batch.batch.id, worker));
    } finally { second.close(); }
  });
  it.each(["connection", "constraint", "input", "expired"])("领取前 %s 漂移拒绝，不改预留", async (kind) => {
    const f = fixture({ edit: true }), batch = await f.confirm();
    if (kind === "connection") f.register(connection({ revision: 2 })); if (kind === "expired") f.advance(60_000);
    if (["constraint", "input"].includes(kind)) f.store.transaction(() => { const c = f.store.loadCatalog()!;
      if (kind === "constraint") c.projects[0].constraints[0].brandRules = { changed: "yes" }; else c.projects[0].assets[0].originalName = "changed.png"; f.store.saveCatalog(c); });
    unchanged(f, () => f.claim(batch.batch.id));
  });
  it.each(["revoke", "expire", "fault"])("SQL写后 %s 整个领取事务回滚", async (kind) => {
    const f = fixture(), batch = await f.confirm(), before = f.store.load(), save = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementation((s) => { save(s); if (s.batches.some((b) => b.productionImageLeases)) {
      if (kind === "revoke") f.deny("run:execute"); else if (kind === "expire") f.advance(30_000); else throw new Error("private-save-detail"); } });
    expect(() => f.claim(batch.batch.id)).toThrow(); expect(f.store.load()).toEqual(before);
  });
  it.each(["revoke", "expire"])("最后verify期间 %s 无租约写入", async (kind) => {
    const f = fixture(), batch = await f.confirm(); f.pricePort.verify.mockImplementation(() => {
      if (kind === "revoke") f.deny("asset:read"); else f.advance(60_000); return true;
    }); unchanged(f, () => f.claim(batch.batch.id));
  });
  it("过期不被普通读取或旧路径隐式恢复；明确恢复只重排未启动任务", async () => {
    const f = fixture({ manual: true }), batch = await f.confirm(), first = f.claim(batch.batch.id).leases[0]; f.advance(30_000);
    const before = f.store.load(); expect(f.kernel.getBatch(principal, batch.batch.id).jobs[0].status).toBe("leased"); expect(f.store.load()).toEqual(before);
    unchanged(f, () => f.kernel.inspectProductionImageLease(principal, "project-a", batch.batch.id, first.jobId, { workerId: first.workerId, leaseId: first.leaseId }));
    const restored = f.kernel.reconcileProductionImageBatch(principal, "project-a", batch.batch.id);
    expect(restored.jobs[0]).not.toHaveProperty("leaseId"); expect(restored.jobs[0].status).toBe("queued"); expect(f.kernel.getBudget(principal, "project-a").reservedMinor).toBe(40);
    const second = f.claim(batch.batch.id).leases[0]; expect(second.leaseId).not.toBe(first.leaseId); expect(second.jobId).toBe(first.jobId);
    expect(f.store.load()!.batches[0].productionImageLeases).toHaveLength(2); expect(f.store.load()!.batches[0].aggregate.ledger).toHaveLength(1);
  });
  it("过期报价/停用目录可安全恢复未发送租约，但不能再领取", async () => {
    const f = fixture(), batch = await f.confirm(); f.claim(batch.batch.id); f.advance(60_000); f.register(connection({ revision: 2, enabled: false }));
    const reads = f.pricePort.read.mock.calls.length, verifies = f.pricePort.verify.mock.calls.length;
    expect(f.kernel.reconcileProductionImageBatch(principal, "project-a", batch.batch.id).jobs[0].status).toBe("queued");
    expect(f.pricePort.verify).toHaveBeenCalledTimes(verifies); expect(f.pricePort.read).toHaveBeenCalledTimes(reads); unchanged(f, () => f.claim(batch.batch.id));
  });
  it.each([0, 40])("未发送租约取消上限 %i 守恒并保留历史", async (cap) => {
    const f = fixture({ manual: true, cap }), batch = await f.confirm(); f.claim(batch.batch.id);
    expect(f.kernel.cancelBatch(principal, batch.batch.id).jobs[0].status).toBe("cancelled");
    expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 0, availableMinor: 1000 });
    expect(f.store.load()!.batches[0].jobReservations).toEqual([]); expect(f.store.load()!.batches[0].productionImageLeases).toHaveLength(1);
    InMemoryRunKernel.assertSnapshot(f.store.load()!);
  });
  it("共用项目并发：本地假任务占用不能被生产领取绕过", async () => {
    const f = fixture({ kernel: { maxConcurrentJobs: 1 } }), localBatch = await setupLocal(f), batch = await f.confirm(); f.kernel.claimImageBatch(principal, localBatch.batch.id, worker);
    const result = f.claim(batch.batch.id); expect(result).toMatchObject({ leases: [], throttledBy: "project-concurrency" });
  });
  it("供应商持久化时间窗在到期重排和重启后仍限制领取", async () => {
    const f = fixture({ kernel: { providerLimits: [{ adapterId: "fixture-image-v1", maxConcurrentJobs: 2, maxStartsPerWindow: 1, windowMs: 50_000 }] } });
    const batch = await f.confirm(); f.claim(batch.batch.id); f.advance(30_000); f.kernel.reconcileProductionImageBatch(principal, "project-a", batch.batch.id);
    expect(f.claim(batch.batch.id)).toMatchObject({ leases: [], throttledBy: "provider-rate", retryAfterMs: 20_000 });
    f.advance(20_000); expect(f.claim(batch.batch.id).leases).toHaveLength(1);
  });
  it("共享元数据满时不领取且不删除原历史", async () => {
    const f = fixture({ quota: 1 }), batch = await f.confirm(); unchanged(f, () => f.claim(batch.batch.id));
  });
  it("非默认租约期限支持纯只读确认恢复，不用默认30秒覆盖原配置", async () => {
    const f = fixture({ kernel: { leaseDurationMs: 1_000 } }), batch = await f.confirm(); f.claim(batch.batch.id);
    InMemoryRunKernel.assertSnapshot(f.store.load()!); expect(f.reopen(f.store, { leaseDurationMs: 1_000 }).getBatch(principal, batch.batch.id).jobs[0].status).toBe("leased");
  });
  it("两个连接并发争同一任务只领取一次", async () => {
    const f = fixture(), batch = await f.confirm(), second = new SqliteRunKernelStateStore(f.path);
    try { const k = f.reopen(second); const results = await Promise.all([Promise.resolve().then(() => f.claim(batch.batch.id)),
      Promise.resolve().then(() => k.claimProductionImageBatch(other, "project-a", batch.batch.id, { workerId: "second", maxJobs: 1 }))]);
      expect(results.flatMap((r) => r.leases)).toHaveLength(1); expect(f.store.load()!.batches[0].productionImageLeases).toHaveLength(1);
      expect(f.kernel.getBudget(principal, "project-a").reservedMinor).toBe(40);
    } finally { second.close(); }
  });
  it("检查别人/已过期租约前不读取原文件", async () => {
    const f = fixture({ edit: true }), batch = await f.confirm(), lease = f.claim(batch.batch.id).leases[0], raw = vi.spyOn(f.store, "loadVerifiedImage");
    expect(() => f.kernel.inspectProductionImageLease(other, "project-a", batch.batch.id, lease.jobId, { leaseId: lease.leaseId, workerId: lease.workerId })).toThrow(); expect(raw).not.toHaveBeenCalled();
    f.advance(30_000); expect(() => f.kernel.inspectProductionImageLease(principal, "project-a", batch.batch.id, lease.jobId, { leaseId: lease.leaseId, workerId: lease.workerId })).toThrow(); expect(raw).not.toHaveBeenCalled();
  });
  it("原文件核验期间撤权不再读下一份或写入租约", async () => {
    const f = fixture({ edit: true }), batch = await f.confirm(), read = f.store.loadVerifiedImage.bind(f.store);
    const spy = vi.spyOn(f.store, "loadVerifiedImage").mockImplementation((...args) => { const v = read(...args); f.deny("asset:read"); return v; });
    unchanged(f, () => f.claim(batch.batch.id)); expect(spy).toHaveBeenCalledTimes(1);
  });
  it.each(["expiry", "price"])("读取原文件期间 %s 到期立即停止，不改原活租约", async (kind) => {
    const f = fixture({ edit: true }), batch = await f.confirm(), lease = f.claim(batch.batch.id).leases[0], read = f.store.loadVerifiedImage.bind(f.store);
    const spy = vi.spyOn(f.store, "loadVerifiedImage").mockImplementation((...args) => { const image = read(...args); f.advance(kind === "expiry" ? 30_000 : 60_000); return image; });
    unchanged(f, () => f.kernel.inspectProductionImageLease(principal, "project-a", batch.batch.id, lease.jobId, { leaseId: lease.leaseId, workerId: lease.workerId }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it.each(["revoke", "fault"])("到期恢复SQL写后 %s 回滚，不丢旧活绑定", async (kind) => {
    const f = fixture(), batch = await f.confirm(); f.claim(batch.batch.id); f.advance(30_000);
    const save = f.store.save.bind(f.store); vi.spyOn(f.store, "save").mockImplementation((s) => { save(s);
      if (kind === "revoke") f.deny("provider:read"); else throw new Error("private-reconcile-write"); });
    unchanged(f, () => f.kernel.reconcileProductionImageBatch(principal, "project-a", batch.batch.id));
  });
  it("供应商并发限制在不同生产批次间共用", async () => {
    const f = fixture({ kernel: { providerLimits: [{ adapterId: "fixture-image-v1", maxConcurrentJobs: 1 }] } });
    const first = await f.confirm(), second = await f.confirm("second"); f.claim(first.batch.id);
    expect(f.claim(second.batch.id)).toMatchObject({ leases: [], throttledBy: "provider-concurrency" }); expect(f.store.load()!.batches[1].aggregate.jobs[0].status).toBe("queued");
  });
  it.each(["claimBatch", "claimImageBatch", "dispatchBatch", "reconcileBatch", "reconcileImageBatch"])("旧入口 %s 拒绝生产批次", async (method) => {
    const f = fixture(), batch = await f.confirm(); unchanged(f, () => (f.kernel[method as keyof SqliteRunKernel] as any)(principal, batch.batch.id, worker));
  });
  it.each(["actor", "worker", "execution", "expiry", "missing-history", "missing-audit", "wrong-audit", "duplicate-history"])("恢复关系损坏 %s 失败关闭", async (kind) => {
    const f = fixture(), batch = await f.confirm(); f.claim(batch.batch.id); const snapshot = f.store.load()!, s = snapshot.batches[0], l = s.productionImageLeases![0];
    if (kind === "actor") l.actorId = "other"; if (kind === "worker") l.workerId = "other"; if (kind === "execution") l.executionFingerprint = "0".repeat(64);
    if (kind === "expiry") l.expiresAt = new Date(Date.parse(l.expiresAt) + 1).toISOString(); if (kind === "missing-history") delete s.productionImageLeases;
    if (kind === "missing-audit") s.aggregate.audit = s.aggregate.audit.filter((a) => a.eventType !== "job-leased");
    if (kind === "wrong-audit") s.aggregate.audit.find((a) => a.eventType === "job-leased")!.metadata.expiresAt = at;
    if (kind === "duplicate-history") s.productionImageLeases!.push(structuredClone(l));
    expect(() => InMemoryRunKernel.assertSnapshot(snapshot)).toThrow();
  });
  it("可信端口私密异常脱敏，不透传message/cause", async () => {
    const f = fixture(), batch = await f.confirm(); f.pricePort.verify.mockImplementation(() => { throw new Error("PRIVATE-PRICE"); });
    try { f.claim(batch.batch.id); throw new Error("unexpected-success"); } catch (e) { expect(String(e)).not.toContain("PRIVATE-PRICE"); }
  });
});
describe("6D3B1 权威生产负载重建（不保存意图、不发送）", () => {
  const service = (f: ReturnType<typeof fixture>) => new ImageProductionReconstructionHarness({ reconstructionEnabled: true,
    tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, clock: f.clock });
  const run = (f: ReturnType<typeof fixture>, batch: string, lease: { jobId: string; workerId: string; leaseId: string }, signal?: AbortSignal) =>
    service(f).reconstruct(principal, "project-a", batch, lease.jobId, { workerId: lease.workerId, leaseId: lease.leaseId }, signal);
  it("默认关闭且不读取存储", async () => {
    const f = fixture(), spy = vi.spyOn(f.store, "load");
    for (const s of [new ProductionImageTaskReconstruction(), new ImageProductionReconstructionHarness()])
      await expect(s.reconstruct(principal, "project-a", "fake", "fake", {})).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s known/unknown和编辑原字节匹配原确认且不改任务账本", async (protocol) => {
    for (const manual of [false, true]) for (const edit of [false, true]) {
      const f = fixture({ protocol, manual, edit }), batch = await f.confirm(), lease = f.claim(batch.batch.id).leases[0]; f.advance(500);
      const before = f.store.load(), result = await run(f, batch.batch.id, lease), e = before!.batches[0].productionImageExecution!;
      expect(result).toMatchObject({ batchId: batch.batch.id, jobId: lease.jobId, requestFingerprint: e.protocol.requestFingerprint,
        payloadChecksumSha256: e.protocol.payloadChecksumSha256, payloadByteSize: e.protocol.payloadByteSize, contentType: e.protocol.contentType,
        transformedInputs: e.protocol.transformedInputs, confirmedAt: e.confirmedAt, reconstructedAt: new Date(f.clock()).toISOString(),
        executionAuthorized: false, realExecutionEnabled: false, dispatchIntentRecorded: false });
      expect(result.reconstructedAt).not.toBe(e.protocol.preparedAt); expect(f.store.load()).toEqual(before);
      expect(JSON.stringify(result)).not.toMatch(/never-called|credentialRef|opaque-never|base64|原人工指令/);
      expect(f.pricePort.read).toHaveBeenCalledTimes(1);
    }
  });
  it("生产入口不接受合同夹具，也不复用local租约", async () => {
    const f = fixture(), batch = await f.confirm(), lease = f.claim(batch.batch.id).leases[0];
    const real = new ProductionImageTaskReconstruction({ reconstructionEnabled: true, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, clock: f.clock });
    await expect(real.reconstruct(principal, "project-a", batch.batch.id, lease.jobId, { workerId: lease.workerId, leaseId: lease.leaseId })).rejects.toThrow();
    const local = await setupLocal(f), l = f.kernel.claimImageBatch(principal, local.batch.id, worker).leases[0];
    await expect(run(f, local.batch.id, l)).rejects.toThrow();
  });
  it.each(["multipart-image-array", "multipart-image-single"] as const)("中转%s匹配原实际boundary/字节且清零临时负载", async (editEncoding) => {
    const f = fixture({ protocol: "openai-compatible", edit: true, editEncoding }), b = await f.confirm(), l = f.claim(b.batch.id).leases[0];
    const original = productionProtocol.prepareProductionImageProtocol; let body: Buffer | undefined;
    vi.spyOn(productionProtocol, "prepareProductionImageProtocol").mockImplementation(async (...args) => { const v = await original(...args); body = v.wire.body; return v; });
    const before = f.store.load(), result = await run(f, b.batch.id, l);
    expect(result.contentType).toContain("multipart/form-data; boundary=canvas-"); expect(body!.every((v) => v === 0)).toBe(true);
    expect(f.store.load()).toEqual(before);
  });
  it("异步归一化在SQL事务外，zero-cap原预留关系不变", async () => {
    const f = fixture({ manual: true, cap: 0, edit: true }), b = await f.confirm(), l = f.claim(b.batch.id).leases[0];
    const transaction = f.store.transaction.bind(f.store); let depth = 0;
    vi.spyOn(f.store, "transaction").mockImplementation((action) => transaction(() => { depth++; try { return action(); } finally { depth--; } }));
    const prepare = productionProtocol.prepareProductionImageProtocol;
    vi.spyOn(productionProtocol, "prepareProductionImageProtocol").mockImplementation(async (...args) => { expect(depth).toBe(0); const v = await prepare(...args); expect(depth).toBe(0); return v; });
    const before = f.store.load(); await run(f, b.batch.id, l); expect(f.store.load()).toEqual(before);
    expect(f.store.load()!.batches[0].jobReservations).toEqual([[l.jobId, 0]]);
  });
  it("不同store实例关闭，即使路径相同", async () => {
    const f = fixture(), batch = await f.confirm(), l = f.claim(batch.batch.id).leases[0], store = new SqliteRunKernelStateStore(f.path);
    try { const s = new ImageProductionReconstructionHarness({ reconstructionEnabled: true, tenantId: principal.tenantId, stateStore: store, runKernel: f.kernel, clock: f.clock });
      await expect(s.reconstruct(principal, "project-a", batch.batch.id, l.jobId, { workerId: l.workerId, leaseId: l.leaseId })).rejects.toThrow();
    } finally { store.close(); }
  });
  it.each(["actor", "worker", "lease", "job", "project", "tenant"])("%s错配在读取实际原文件之前拒绝", async (kind) => {
    const f = fixture({ edit: true }), b = await f.confirm(), l = f.claim(b.batch.id).leases[0], raw = vi.spyOn(f.store, "loadVerifiedImageBytes");
    await expect(service(f).reconstruct({ ...principal, ...(kind === "actor" ? { actorId: "other" } : kind === "tenant" ? { tenantId: "other" } : {}) },
      kind === "project" ? "other" : "project-a", b.batch.id, kind === "job" ? "other" : l.jobId,
      { workerId: kind === "worker" ? "other" : l.workerId, leaseId: kind === "lease" ? "other" : l.leaseId })).rejects.toThrow();
    expect(raw).not.toHaveBeenCalled();
  });
  it.each(["run:read", "run:execute", "provider:read", "asset:read"])("%s撤权不读私有状态或原字节", async (permission) => {
    const f = fixture({ edit: true }), b = await f.confirm(), l = f.claim(b.batch.id).leases[0]; f.deny(permission);
    const load = vi.spyOn(f.store, "load"), raw = vi.spyOn(f.store, "loadVerifiedImageBytes");
    await expect(run(f, b.batch.id, l)).rejects.toThrow(); expect(load).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
  });
  it.each(["revoke", "expiry", "price", "constraint", "connection", "cancel", "abort"])("归一化await后%s拒绝且保留原费用", async (kind) => {
    const f = fixture({ manual: true, edit: true }), b = await f.confirm(), l = f.claim(b.batch.id).leases[0], controller = new AbortController();
    const original = productionProtocol.prepareProductionImageProtocol; let wire: Buffer | undefined;
    vi.spyOn(productionProtocol, "prepareProductionImageProtocol").mockImplementation(async (...args) => {
      const v = await original(...args); wire = v.wire.body;
      if (kind === "revoke") f.deny("asset:read"); if (kind === "expiry") f.advance(30_000); if (kind === "price") f.advance(60_000);
      if (kind === "constraint") f.store.transaction(() => { const c = f.store.loadCatalog()!; c.projects[0].constraints[0].brandRules = { changed: "yes" }; f.store.saveCatalog(c); });
      if (kind === "connection") f.register(connection({ revision: 2 })); if (kind === "cancel") f.kernel.cancelBatch(principal, b.batch.id);
      if (kind === "abort") controller.abort(); return v;
    });
    await expect(run(f, b.batch.id, l, controller.signal)).rejects.toThrow();
    expect(wire!.every((byte) => byte === 0)).toBe(true);
    expect(f.store.load()!.batches[0]).not.toHaveProperty("imageDispatchIntent");
    expect(f.store.load()!.batches[0].reservedMinor).toBe(kind === "cancel" ? 0 : 40);
  });
  it.each(["bytes", "checksum", "length", "contentType", "transform", "request"])("实际重建%s错配失败关闭", async (kind) => {
    const f = fixture({ edit: true }), b = await f.confirm(), l = f.claim(b.batch.id).leases[0], before = f.store.load();
    const original = productionProtocol.prepareProductionImageProtocol;
    vi.spyOn(productionProtocol, "prepareProductionImageProtocol").mockImplementation(async (...args) => {
      const v = await original(...args);
      if (kind === "bytes") v.wire.body[0] ^= 1; if (kind === "checksum") v.snapshot.payloadChecksumSha256 = "0".repeat(64);
      if (kind === "length") v.snapshot.payloadByteSize++; if (kind === "contentType") v.snapshot.contentType = "wrong";
      if (kind === "transform") v.snapshot.transformedInputs[0].transmittedChecksumSha256 = "0".repeat(64);
      if (kind === "request") v.snapshot.request.parameters.prompt = "changed"; return v;
    });
    await expect(run(f, b.batch.id, l)).rejects.toThrow(); expect(f.store.load()).toEqual(before);
  });
  it("取消在读取前关闭；读取后撤权清除自有副本且不留准备证明", async () => {
    const f = fixture({ edit: true }), b = await f.confirm(), l = f.claim(b.batch.id).leases[0], controller = new AbortController(); controller.abort();
    const original = f.store.loadVerifiedImageBytes.bind(f.store), raw = vi.spyOn(f.store, "loadVerifiedImageBytes");
    await expect(run(f, b.batch.id, l, controller.signal)).rejects.toThrow(); expect(raw).not.toHaveBeenCalled(); let copy: Buffer | undefined;
    raw.mockImplementation((...args) => { const v = original(...args); copy = v!.body; f.deny("asset:read"); return v; });
    await expect(run(f, b.batch.id, l)).rejects.toThrow(); expect(copy!.every((byte) => byte === 0)).toBe(true);
  });
  it("同时两份、无无限队列，取消未结清归一化不释放槽位", async () => {
    const f = fixture(), b = await f.confirm(), l = f.claim(b.batch.id).leases[0], controller = new AbortController();
    const original = productionProtocol.prepareProductionImageProtocol; let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(productionProtocol, "prepareProductionImageProtocol").mockImplementation(async (...args) => { await wait; return original(...args); });
    const first = run(f, b.batch.id, l, controller.signal), second = run(f, b.batch.id, l); controller.abort();
    await expect(run(f, b.batch.id, l)).rejects.toMatchObject({ status: 429 }); finish();
    const outcomes = await Promise.allSettled([first, second]); expect(outcomes.map((v) => v.status)).toEqual(["rejected", "fulfilled"]);
    await expect(run(f, b.batch.id, l)).resolves.toMatchObject({ dispatchIntentRecorded: false });
  });
  it("超过64MiB声明合计在权威原图BLOB读取之前拒绝", async () => {
    const f = fixture({ edit: true }), b = await f.confirm(), request = structuredClone(f.store.load()!.batches[0].productionImageExecution!.protocol.request);
    if (request.operation !== "edit") throw new Error("fixture must edit");
    request.inputs = [0, 1, 2].map((i) => ({ ...request.inputs[0], assetId: `large-${i}`, byteSize: 24 * 1024 * 1024 }));
    const read = vi.spyOn(f.store, "loadVerifiedImage"); expect(() => validateProductionImageAssetPolicy(f.store, request)).toThrow(); expect(read).not.toHaveBeenCalled();
  });
  it("私密异常message/code/cause不透传", async () => {
    const f = fixture(), b = await f.confirm(), l = f.claim(b.batch.id).leases[0];
    vi.spyOn(f.kernel, "inspectProductionImageLease").mockImplementation(() => { throw new RunKernelError(503, "PRIVATE-CODE", "PRIVATE-MESSAGE"); });
    try { await run(f, b.batch.id, l); throw new Error("unexpected-success"); } catch (error) { expect(JSON.stringify(error)).not.toContain("PRIVATE"); expect(String(error)).not.toContain("PRIVATE"); }
  });
});
async function setupLocal(f: ReturnType<typeof fixture>) {
  const prepared = f.service.createPreparation(principal, { projectId: "project-a", idempotencyKey: "local-good", connectionId: f.config.id, connectionRevision: 1,
    model: f.config.models[0].model, capabilityVersion: f.config.models[0].version, constraintSnapshotId: "constraint-a", protection: "none", operation: "generate", inputAssetIds: [],
    parameters: { prompt: "owned-local", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", background: "auto", outputFormat: "png" } });
  return (await f.service.confirmPreparation(principal, "project-a", prepared.id, { expectedSnapshotFingerprint: prepared.snapshotFingerprint,
    expectedEstimatedCostMinor: 25, expectedMaxCostMinor: 30, expectedCurrency: "CNY" })).aggregate;
}
