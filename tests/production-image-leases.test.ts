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
import { RunKernelError } from "../apps/api/src/runKernel";
import { at, connection, principal, setupImageTask } from "./helpers/image-task-fixture";

const owned: ReturnType<typeof setupImageTask>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of owned.splice(0).reverse()) f.cleanup(); });
const other = { ...principal, actorId: "other" }, worker = { workerId: "owned-worker", maxJobs: 2 };
function fixture(options: { protocol?: ImageProviderConnection["protocol"]; manual?: boolean; edit?: boolean; cap?: number; policy?: boolean;
  editEncoding?: "json-images" | "multipart-image-array" | "multipart-image-single";
  quota?: number; kernel?: Partial<RunKernelOptions> } = {}) {
  let allowed: unknown = true, service: ImageProductionPreparationHarness, policy: ProductionImageLeasePolicy;
  const denied = new Set<string>();
  const authorizer = { authenticate: () => principal, allows: (p: typeof principal, project: string, permission: string) =>
    p.tenantId === principal.tenantId && ["writer", "other"].includes(p.actorId) && project === "project-a" && !denied.has(permission) ? allowed as boolean : false };
  const gate: ProductionImageLeasePolicy = { usesStateStore: (s) => policy.usesStateStore(s), authorizeScope: (p, project) => policy.authorizeScope(p, project),
    validate: (p, e, purpose, bytes) => policy.validate(p, e, purpose, bytes) };
  const kernelOptions = { authorizer, validateProductionImageConfirmation: (p: typeof principal, e: ConfirmedProductionImageExecution) => service.authorizeConfirmation(p, e),
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
  return { ...f, config, policy, gate, policyOptions, pricePort, confirm, claim, reopen, authorizer,
    deny: (permission: string) => denied.add(permission), allow: (value: unknown) => { allowed = value; } };
}
const unchanged = (f: ReturnType<typeof fixture>, action: () => unknown) => {
  const before = f.store.load(); expect(action).toThrow(); expect(f.store.load()).toEqual(before);
};

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
