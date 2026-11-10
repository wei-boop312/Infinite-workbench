import { afterEach, describe, expect, it, vi } from "vitest";
import { RunBatchAggregateSchema, RunKernelSnapshotSchema, type ConfirmedProductionImageExecution, type ImageProviderConnection } from "../packages/contracts/src/index";
import { ImageProductionPreparationHarness, ProductionImagePreparations, type ImagePriceContext } from "../apps/api/src/productionImagePreparations";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { InMemoryRunKernel } from "../apps/api/src/runKernel";
import { imageSnapshotFingerprint } from "../apps/api/src/imageProviderContract";
import { productionExpected } from "../apps/api/src/productionImageConfirmationIntegrity";
import { at, connection, principal, setupImageTask } from "./helpers/image-task-fixture";

const owned: ReturnType<typeof setupImageTask>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of owned.splice(0).reverse()) f.cleanup(); });
function fixture(options: { protocol?: ImageProviderConnection["protocol"]; manual?: boolean; edit?: boolean; max?: number; quota?: number; policy?: boolean } = {}) {
  const denied = new Set<string>(); let allowed: unknown = true, service: ImageProductionPreparationHarness;
  const authorizer = { authenticate: () => principal, allows: (p: typeof principal, project: string, permission: string) =>
    p.tenantId === principal.tenantId && p.actorId === principal.actorId && project === "project-a" && !denied.has(permission) ? allowed as boolean : false };
  const validator = (p: typeof principal, e: ConfirmedProductionImageExecution) => service.authorizeConfirmation(p, e);
  const f = setupImageTask({ format: options.protocol === "google" ? "jpeg" : "png", kernel: { authorizer,
    ...(options.policy === false ? {} : { validateProductionImageConfirmation: validator }) } }); owned.push(f);
  const base = connection(), model = base.models[0], protocol = options.protocol ?? "openai";
  const config = connection({ protocol,
    ...(protocol === "openai-compatible" ? { compatibility: { version: "owned-compat", editEncoding: "json-images", responseEncoding: "images-b64-json-v1",
      auth: { scheme: "header", headerName: "x-api-key" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}),
    ...(protocol === "google" ? { baseUrl: "https://generativelanguage.googleapis.com", models: [{ ...model, maxInputImages: 14, outputFormats: ["jpeg"] }],
      googleNative: { version: "owned-google", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: model.model,
        sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] } } : {}) });
  f.register(config); if (options.edit) { f.source("source"); f.source("second"); }
  const pricePort = { kind: "contract-fixture" as const, realExecutionEnabled: false as const,
    read: vi.fn((c: ImagePriceContext) => ({ schemaVersion: 1, scope: c.scope, quote: { id: "owned-price", version: "owned-v1",
      source: options.manual ? "manual-budget" : "server-price-table", currency: "CNY", maxCostMinor: options.max ?? 40,
      ...(options.manual ? {} : { estimatedCostMinor: 25 }), expiresAt: new Date(f.clock() + 60_000).toISOString() },
      evidence: { kind: "contract-fixture", realExecutionEnabled: false, sourceRevision: "owned-table", evidenceRef: "no-real-price",
        checkedBy: "owned-oracle", checkedAt: c.requestedAt } })), verify: vi.fn((): unknown => true) };
  const serviceOptions = { preparationEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, authorizer,
    assetAuthorizer: authorizer, runAuthorizer: authorizer, clock: f.clock, pricePort: pricePort as any, runKernel: f.kernel, maxMetadataBytes: options.quota };
  service = new ImageProductionPreparationHarness(serviceOptions);
  const select = (action = "owned-action") => ({ projectId: "project-a", idempotencyKey: action, connectionId: config.id, connectionRevision: 1,
    model: model.model, capabilityVersion: model.version, constraintSnapshotId: "constraint-a", protection: "none", operation: options.edit ? "edit" : "generate",
    inputAssetIds: options.edit ? ["source", "second"] : [], parameters: { prompt: "完整原人工指令", n: 1, size: { width: 1024, height: 1024 }, quality: "auto",
      background: "auto", outputFormat: options.protocol === "google" ? "jpeg" : "png" } });
  const prepare = (action?: string) => {
    const publicRecord = service.createPreparation(principal, select(action));
    return f.store.loadProductionImagePreparation(principal.tenantId, "project-a", "production-contract-fixture", publicRecord.id)!;
  };
  const record = prepare(), expected = productionExpected(record);
  const confirm = (input: unknown = expected) => service.confirmPreparation(principal, "project-a", record.id, input);
  return { ...f, config, record, service, serviceOptions, validator, pricePort, prepare, expected, confirm, authorizer,
    deny: (permission: string) => denied.add(permission), allow: (value: unknown) => { allowed = value; } };
}
async function unchanged(f: ReturnType<typeof fixture>, action: () => unknown) {
  const before = f.store.load(); await expect(Promise.resolve().then(action)).rejects.toThrow(); expect(f.store.load()).toEqual(before);
}

describe("6D2B 实际生产确认事务（仅自有零费用合同夹具）", () => {
  it("默认关闭，不触碰存储/价格/凭证/网络", async () => {
    await expect(new ProductionImagePreparations().confirmPreparation(principal, "project-a", "unknown", {})).rejects.toMatchObject({ code: "production_image_preparation_not_configured" });
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s 完整冻结 known/unknown 原子预留，原准备不改写", async (protocol) => {
    for (const manual of [false, true]) {
      const f = fixture({ protocol, manual, edit: true }), before = structuredClone(f.record), result = await f.confirm();
      expect(result).toMatchObject({ mode: "production-contract-fixture", executionState: "confirmed-not-dispatchable", executionAuthorized: false, realExecutionEnabled: false, protocolPreparation: "prepared" });
      expect(result.aggregate.batch).toMatchObject({ imageMode: "production-contract-fixture", estimatedCostMinor: manual ? null : 25, maxCostMinor: 40, status: "queued" });
      expect(result.aggregate.jobs[0]).toMatchObject({ estimatedCostMinor: manual ? null : 25, executorKind: "provider", status: "queued", inputAssetIds: ["source", "second"], outputAssetIds: [] });
      expect(result.aggregate.ledger[0]).toMatchObject({ estimatedMinor: manual ? null : 25, reservedMinor: 40, settlement: "reserved" });
      const e = f.store.load()!.batches[0].productionImageExecution!;
      expect(e.protocol.transformedInputs.map((t) => t.assetId)).toEqual(["source", "second"]);
      expect(e.protocol.payloadByteSize).toBeGreaterThan(0); expect(e.protocol.request.jobId).toMatch(/^production-image-job-/);
      expect(e.protocol.request.idempotencyKey).toMatch(/^production-image-execution-/); expect(e.batchId).toMatch(/^production-image-batch-/);
      expect(f.store.loadProductionImagePreparation(principal.tenantId, "project-a", before.mode, before.id)).toEqual(before);
      expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0, availableMinor: 960 });
      expect(f.pricePort.read).toHaveBeenCalledTimes(1); expect(f.pricePort.verify.mock.calls.some(([c]) => (c as ImagePriceContext).purpose === "confirm")).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/never-called|opaque-never-resolved|credentialRef|baseUrl/);
    }
  });
  it.each(["expectedSnapshotFingerprint", "expectedPricingFingerprint", "expectedCurrency", "expectedMaxCostMinor", "estimate"])("完整期待不匹配 %s 不创建/预留", async (key) => {
    const f = fixture({ manual: true }); await unchanged(f, () => f.confirm({ ...f.expected, [key]: key.endsWith("Fingerprint") ? "0".repeat(64) : key === "expectedCurrency" ? "USD" : key === "estimate" ? { state: "known", expectedEstimatedCostMinor: 0 } : 0 }));
  });
  it.each(["prepared", "confirmed", "jobId", "executionAuthorized", "source"])("调用者自报字段 %s 严格拒绝", async (key) => {
    const f = fixture(); await unchanged(f, () => f.confirm({ ...f.expected, [key]: true }));
  });
  it.each(["provider:read", "run:create", "run:confirm", "run:read", "asset:read"])("%s 撤权在读取私有准备或原文件前拒绝", async (permission) => {
    const f = fixture({ edit: true }); f.deny(permission);
    const load = vi.spyOn(f.store, "loadProductionImagePreparation"), body = vi.spyOn(f.store, "loadVerifiedImageBytes");
    await unchanged(f, () => f.confirm()); expect(load).not.toHaveBeenCalled(); expect(body).not.toHaveBeenCalled();
  });
  it.each([false, "true", 1, Promise.resolve(true)])("严格同步权限 %s", async (value) => {
    const f = fixture(); f.allow(value); await unchanged(f, () => f.confirm());
  });
  it.each([false, "true", 1, Promise.resolve(true)])("严格同步价格verify %s，不重新read报价", async (value) => {
    const f = fixture(); f.pricePort.verify.mockReturnValue(value); await unchanged(f, () => f.confirm()); expect(f.pricePort.read).toHaveBeenCalledTimes(1);
  });
  it("无内核政策不能确认；已确认快照不能被自报为新创建证据", async () => {
    const f = fixture({ policy: false }); await unchanged(f, () => f.confirm());
    const good = fixture(); await good.confirm(); const e = good.store.load()!.batches[0].productionImageExecution!;
    expect(good.service.authorizeConfirmation(principal, e)).toBe(false);
    const forged = structuredClone(e); forged.batchId = forged.batchId.replace(/.$/, "0"); forged.preparation.id = "self-reported";
    expect(() => good.kernel.stageConfirmedProductionImageBatch(principal, forged)).toThrow();
  });
  it("同路径不同连接实例也不能分裂任务/预算事务", () => {
    const f = fixture(), second = new SqliteRunKernelStateStore(f.path);
    try { expect(() => new ImageProductionPreparationHarness({ ...f.serviceOptions, stateStore: second })).toThrow(); }
    finally { second.close(); }
  });
  it.each(["tenant", "actor", "project"])("跨范围确认 %s 拒绝", async (kind) => {
    const f = fixture(); const p = { ...principal, ...(kind === "tenant" ? { tenantId: "other" } : kind === "actor" ? { actorId: "other" } : {}) };
    await unchanged(f, () => f.service.confirmPreparation(p, kind === "project" ? "other" : "project-a", f.record.id, f.expected));
  });
  it.each(["connection", "constraint", "expired", "input"])("确认前漂移 %s 不预留", async (kind) => {
    const f = fixture({ edit: true });
    if (kind === "connection") f.register(connection({ revision: 2 }));
    if (kind === "expired") f.advance(60_000);
    if (kind === "constraint" || kind === "input") f.store.transaction(() => { const c = f.store.loadCatalog()!;
      if (kind === "constraint") c.projects[0].constraints[0].brandRules = { style: "changed" }; else c.projects[0].assets[0].originalName = "changed.png";
      f.store.saveCatalog(c); });
    await unchanged(f, () => f.confirm());
  });
  it.each(["revoke", "expire"])("归一化await期间 %s 最终复查拒绝", async (kind) => {
    const f = fixture({ edit: true }), pending = f.confirm();
    if (kind === "revoke") f.deny("run:confirm"); else f.advance(60_000);
    await expect(pending).rejects.toThrow(); expect(f.store.load()!.batches).toHaveLength(0); expect(f.store.load()!.budgets[0].reservedMinor).toBe(0);
  });
  it.each(["revoke", "expire", "fault"])("任务写后 %s 回滚整个统一事务", async (kind) => {
    const f = fixture(), save = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementation((snapshot) => { save(snapshot); if (snapshot.batches.some((b) => b.productionImageExecution)) {
      if (kind === "revoke") f.deny("run:confirm"); else if (kind === "expire") f.advance(60_000); else throw new Error("private-storage-detail");
    } });
    await unchanged(f, () => f.confirm()); expect(f.pricePort.read).toHaveBeenCalledTimes(1);
  });
  it("并发重复及报价失效/停用后的历史恢复不重建、重预留或verify", async () => {
    const f = fixture({ manual: true }), results = await Promise.all([f.confirm(), f.confirm()]);
    expect(results[0]).toEqual(results[1]); expect(f.store.load()!.batches).toHaveLength(1);
    f.advance(100_000); f.register(connection({ revision: 2, enabled: false })); f.pricePort.verify.mockClear().mockReturnValue(false);
    const bytes = vi.spyOn(f.store, "loadVerifiedImageBytes"), save = vi.spyOn(f.store, "save"), before = f.store.load();
    expect(await f.confirm()).toEqual(results[0]); expect(f.service.getConfirmation(principal, "project-a", f.record.id)).toEqual(results[0]);
    expect(bytes).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(f.pricePort.verify).not.toHaveBeenCalled(); expect(f.store.load()).toEqual(before);
  });
  it("跨连接与重启恢复一个任务，历史完整检查不依赖当前价格", async () => {
    const f = fixture({ manual: true }), first = await f.confirm(), second = new SqliteRunKernelStateStore(f.path);
    try {
      const kernel = new SqliteRunKernel({ stateStore: second, authorizer: f.authorizer, budgets: [{ tenantId: principal.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }], clock: f.clock });
      const restored = new ImageProductionPreparationHarness({ ...f.serviceOptions, stateStore: second, runKernel: kernel });
      f.pricePort.verify.mockClear().mockReturnValue(false);
      expect(await restored.confirmPreparation(principal, "project-a", f.record.id, f.expected)).toEqual(first);
      expect(f.pricePort.verify).not.toHaveBeenCalled();
    } finally { second.close(); }
  });
  it.each([0, 40])("取消上限%s清关系且守恒，重复与过期历史不重预留", async (max) => {
    const f = fixture({ manual: true, max }), result = await f.confirm(), cancelled = f.kernel.cancelBatch(principal, result.aggregate.batch.id);
    expect(cancelled.batch.status).toBe("cancelled"); expect(f.store.load()!.batches[0].jobReservations).toEqual([]);
    expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 0, availableMinor: 1000 });
    expect(cancelled.ledger).toHaveLength(max > 0 ? 2 : 1); expect(cancelled.ledger.every((l) => l.estimatedMinor === null)).toBe(true);
    f.advance(100_000); expect((await f.confirm()).aggregate).toEqual(cancelled); expect(f.kernel.cancelBatch(principal, cancelled.batch.id)).toEqual(cancelled);
  });
  it("预算竞争：只按上限，不以估价扩大可用预算", async () => {
    const f = fixture({ manual: true, max: 600 }), second = f.prepare("another-action");
    const results = await Promise.allSettled([f.confirm(), f.service.confirmPreparation(principal, "project-a", second.id, productionExpected(second))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); expect(f.store.load()!.batches).toHaveLength(1);
    expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ limitMinor: 1000, reservedMinor: 600, spentMinor: 0 });
  });
  it("共享元数据容量包含完整生产确认，不删除历史腾空间", async () => {
    const f = fixture(); const used = f.store.imageMetadataBytes(principal.tenantId, "project-a");
    const limited = new ImageProductionPreparationHarness({ ...f.serviceOptions, maxMetadataBytes: used });
    await unchanged(f, () => limited.confirmPreparation(principal, "project-a", f.record.id, f.expected));
    expect(f.store.loadProductionImagePreparation(principal.tenantId, "project-a", f.record.mode, f.record.id)).toEqual(f.record);
  });
  it("同进程确认准备两槽，第三份拒绝且之后恢复可用", async () => {
    const f = fixture({ edit: true });
    const results = await Promise.allSettled([f.confirm(), f.confirm(), f.confirm()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "production_image_confirmation_busy" } });
    expect(f.store.load()!.batches).toHaveLength(1); await expect(f.confirm()).resolves.toBeTruthy();
  });
  it("准备上限可超过可用预算，但确认拒绝且不抬高预算", async () => {
    const f = fixture({ manual: true, max: 2000 }); await unchanged(f, () => f.confirm()); expect(f.store.load()!.budgets[0].limitMinor).toBe(1000);
  });
  it("实际原文件字节损坏，不用元数据或代理冒充", async () => {
    const f = fixture({ edit: true }), read = f.store.loadVerifiedImageBytes.bind(f.store);
    vi.spyOn(f.store, "loadVerifiedImageBytes").mockImplementation((...args) => { const image = read(...args)!; image.body[0] ^= 1; return image; });
    await unchanged(f, () => f.confirm());
  });
  it("价格verify私密异常不透传；不把报价source当授权", async () => {
    const f = fixture(); f.pricePort.verify.mockImplementation(() => { throw new Error("secret-private-url-token"); });
    await expect(f.confirm()).rejects.toMatchObject({ code: "production_image_preparation_unavailable" });
    await expect(f.confirm()).rejects.not.toThrow("secret-private-url-token"); expect(f.store.load()!.batches).toHaveLength(0);
  });
  it("实际原准备丢失不能用任务中自带副本替代", async () => {
    const f = fixture(); await f.confirm(); vi.spyOn(f.store, "loadProductionImagePreparation").mockReturnValue(null);
    expect(() => f.kernel.getBudget(principal, "project-a")).toThrow();
    expect(() => f.service.getConfirmation(principal, "project-a", f.record.id)).toThrow();
  });
  it.each(["mock-confirm", "claim", "dispatch", "execute", "reconcile", "retry", "image-claim", "image-reconcile"])("生产任务拒绝旧路径 %s", async (kind) => {
    const f = fixture({ manual: true }), result = await f.confirm(), b = result.aggregate.batch.id, j = result.aggregate.jobs[0].id;
    const actions = {
      "mock-confirm": () => f.kernel.confirmBatch(principal, b, { expectedCurrency: "CNY", expectedEstimatedCostMinor: 0 }),
      claim: () => f.kernel.claimBatch(principal, b, { workerId: "worker", maxJobs: 1 }), dispatch: () => f.kernel.dispatchBatch(principal, b),
      execute: () => f.kernel.executeLeasedJob(principal, j, { workerId: "worker", leaseId: "unknown" }), reconcile: () => f.kernel.reconcileBatch(principal, b),
      retry: () => f.kernel.retryJob(principal, j, { expectedEstimatedCostMinor: 0, expectedCurrency: "CNY", mockScenario: "success" as const }),
      "image-claim": () => f.kernel.claimImageBatch(principal, b, { workerId: "worker", maxJobs: 1 }), "image-reconcile": () => f.kernel.reconcileImageBatch(principal, b),
    };
    await unchanged(f, actions[kind as keyof typeof actions]);
  });
  it.each(["estimate", "cap", "namespace", "output", "lease", "billing", "key", "audit", "ledger", "request", "payload", "pricing", "providerRequestId", "retryOf", "auditId"])("恢复损坏关系 %s 失败关闭", async (kind) => {
    const f = fixture({ manual: true }); await f.confirm(); const snapshot = structuredClone(f.store.load()!), s = snapshot.batches[0], e = s.productionImageExecution!;
    const b = s.aggregate.batch, j = s.aggregate.jobs[0];
    if (kind === "estimate") b.estimatedCostMinor = 0;
    if (kind === "cap") b.maxCostMinor += 1;
    if (kind === "namespace") delete b.imageMode;
    if (kind === "output") j.outputAssetIds = ["self-reported-output"];
    if (kind === "lease") j.leaseId = "lease";
    if (kind === "billing") j.actualCostMinor = 0;
    if (kind === "key") j.idempotencyKey = "local-key";
    if (kind === "audit") s.aggregate.audit[1].metadata.pricingFingerprint = "0".repeat(64);
    if (kind === "ledger") s.aggregate.ledger[0].estimatedMinor = 40;
    if (kind === "request") e.protocol.request.parameters.prompt = "changed";
    if (kind === "payload") e.protocol.payloadChecksumSha256 = "0".repeat(64);
    if (kind === "pricing") e.protocol.pricingFingerprint = "0".repeat(64);
    if (kind === "providerRequestId") j.providerRequestId = "self-reported-provider-response";
    if (kind === "retryOf") j.retryOf = "old-local-task";
    if (kind === "auditId") s.aggregate.audit[1].id = s.aggregate.audit[0].id;
    expect(() => InMemoryRunKernel.assertSnapshot(snapshot)).toThrow();
  });
  it("旧mock/local任务不能用null估价或生产标签绕过旧合同", async () => {
    const f = fixture(), legacy = await f.confirm(); const a = structuredClone(legacy.aggregate);
    delete a.batch.imageMode; for (const j of a.jobs) delete j.imageMode; for (const l of a.ledger) delete l.imageMode;
    expect(RunBatchAggregateSchema.safeParse(a).success).toBe(true); // known amount remains valid, but not an actual task proof.
    a.batch.estimatedCostMinor = null; expect(RunBatchAggregateSchema.safeParse(a).success).toBe(false);
    expect(RunKernelSnapshotSchema.safeParse(f.store.load()).success).toBe(true);
  });
});
