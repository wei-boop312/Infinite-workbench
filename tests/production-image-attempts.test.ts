import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConfirmedProductionImageExecution, type ImageProviderConnection } from "../packages/contracts/src/index";
import { ImageProductionPreparationHarness, type ImagePriceContext } from "../apps/api/src/productionImagePreparations";
import { createProductionImageLeaseFixturePolicy, type ProductionImageLeasePolicy } from "../apps/api/src/productionImageLeasePolicy";
import { ImageProductionReconstructionHarness, ProductionImageTaskReconstruction, type ProductionFixtureTransport } from "../apps/api/src/productionImageTaskReconstruction";
import { productionExpected } from "../apps/api/src/productionImageConfirmationIntegrity";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { imageSnapshotFingerprint as fp } from "../apps/api/src/imageProviderContract";
import { imageTaskMetadataBytes } from "../apps/api/src/imageTaskMetadata";
import { InMemoryRunKernel, type RunKernelOptions } from "../apps/api/src/runKernel";
import * as protocolApi from "../apps/api/src/productionImageProtocol";
import { principal, connection, png, setupImageTask, sha } from "./helpers/image-task-fixture";

const owned: ReturnType<typeof setupImageTask>[] = [], opened: SqliteRunKernelStateStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const s of opened.splice(0).reverse()) s.close(); for (const f of owned.splice(0).reverse()) f.cleanup(); });
const withDb = (path: string, action: (db: DatabaseSync) => void) => { const db = new DatabaseSync(path); try { action(db); } finally { db.close(); } };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 10));
async function live(options: { protocol?: ImageProviderConnection["protocol"]; manual?: boolean; edit?: boolean; cap?: number; timeout?: number; jobTimeout?: number; enabled?: boolean; raw?: boolean } = {}) {
  let service: ImageProductionPreparationHarness, policy: ProductionImageLeasePolicy, reconstruction: ImageProductionReconstructionHarness;
  let allowed = true;
  const denied = new Set<string>();
  const auth = { authenticate: () => principal, allows: (p: typeof principal, project: string, permission?: string) => allowed && !denied.has(permission ?? "")
    && p.tenantId === principal.tenantId && [principal.actorId, "other"].includes(p.actorId) && project === "project-a" };
  const gate: ProductionImageLeasePolicy = { usesStateStore: s => policy.usesStateStore(s), authorizeScope: (p, project) => policy.authorizeScope(p, project),
    validate: (p, e, purpose, bytes) => policy.validate(p, e, purpose, bytes) };
  const kernelOptions: Partial<RunKernelOptions> = { authorizer: auth, jobTimeoutMs: options.jobTimeout ?? 30_000,
    validateProductionImageConfirmation: (p, e: ConfirmedProductionImageExecution) => service.authorizeConfirmation(p, e), productionImageLeasePolicy: gate,
    productionImageStartPolicy: { usesStateStore: s => reconstruction?.usesStateStore(s) ?? false, authorizeScope: (p, project) => reconstruction?.authorizeScope(p, project) ?? false,
      validateStart: (p, e, l, i) => reconstruction?.validateStart(p, e, l, i) ?? false },
    productionImageResponsePolicy: { usesStateStore: s => reconstruction?.responsePolicy.usesStateStore(s) ?? false,
      authorizeScope: (p, project) => reconstruction?.responsePolicy.authorizeScope(p, project) ?? false,
      validateAttempt: (p, e, l, i, a) => reconstruction?.responsePolicy.validateAttempt(p, e, l, i, a) ?? false,
      validateResult: (p, e, l, i, a, r) => reconstruction?.responsePolicy.validateResult(p, e, l, i, a, r) ?? false } };
  const f = setupImageTask({ productionResponses: options.raw === false ? undefined : true, format: options.protocol === "google" ? "jpeg" : "png", kernel: kernelOptions }); owned.push(f);
  const model = connection().models[0], protocol = options.protocol ?? "openai";
  const config = connection({ protocol,
    ...(protocol === "openai-compatible" ? { compatibility: { version: "owned-compat", editEncoding: "json-images", responseEncoding: "images-b64-json-v1",
      auth: { scheme: "header", headerName: "x-api-key" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}),
    ...(protocol === "google" ? { baseUrl: "https://generativelanguage.googleapis.com", models: [{ ...model, maxInputImages: 14, outputFormats: ["jpeg"] }],
      googleNative: { version: "owned-google", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: model.model,
        sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] } } : {}) });
  f.register(config); if (options.edit) f.source();
  const pricePort = { kind: "contract-fixture" as const, realExecutionEnabled: false as const,
    read: vi.fn((c: ImagePriceContext) => ({ schemaVersion: 1, scope: c.scope, quote: { id: "owned-price", version: "owned-v1", source: options.manual === false ? "server-price-table" : "manual-budget",
      currency: "CNY", maxCostMinor: options.cap ?? 40, ...(options.manual === false ? { estimatedCostMinor: 25 } : {}), expiresAt: new Date(f.clock() + 60_000).toISOString() },
      evidence: { kind: "contract-fixture", realExecutionEnabled: false, sourceRevision: "owned-table", evidenceRef: "no-real-price", checkedBy: "owned-oracle", checkedAt: c.requestedAt } })), verify: vi.fn(() => true) };
  policy = createProductionImageLeaseFixturePolicy({ leasePreparationEnabled: true, tenantId: principal.tenantId, stateStore: f.store, clock: f.clock,
    runAuthorizer: auth, providerAuthorizer: auth, assetAuthorizer: auth, pricePort });
  service = new ImageProductionPreparationHarness({ preparationEnabled: true, tenantId: principal.tenantId, stateStore: f.store, clock: f.clock,
    runKernel: f.kernel, authorizer: auth, runAuthorizer: auth, assetAuthorizer: auth, pricePort });
  const image = protocol === "google" ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]) : png;
  const json = protocol === "google" ? { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ inlineData: { mimeType: "image/jpeg", data: image.toString("base64") } }] } }], responseId: "owned-google-id" }
    : { created: 1, data: [{ b64_json: image.toString("base64") }] };
  const response = { status: 200, contentType: "application/json", requestId: "owned-request-id", body: Buffer.from(JSON.stringify(json)) };
  const send = vi.fn<ProductionFixtureTransport["send"]>(async () => response);
  const construction = { reconstructionEnabled: true as const, startEnabled: true as const, leasePolicy: gate, stateStore: f.store,
    tenantId: principal.tenantId, runKernel: f.kernel, clock: f.clock, responseHandlingEnabled: options.enabled === false ? undefined : true as const,
    fixtureTransport: { kind: "contract-fixture" as const, realExecutionEnabled: false as const, send }, timeoutMs: options.timeout ?? 5_000 };
  reconstruction = new ImageProductionReconstructionHarness(construction);
  const prepared = service.createPreparation(principal, { projectId: "project-a", idempotencyKey: "owned-action", connectionId: config.id, connectionRevision: 1,
    model: model.model, capabilityVersion: model.version, constraintSnapshotId: "constraint-a", protection: "none", operation: options.edit ? "edit" : "generate",
    inputAssetIds: options.edit ? ["source"] : [], parameters: { prompt: "原人工指令", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", background: "auto", outputFormat: protocol === "google" ? "jpeg" : "png" } });
  const preparation = f.store.loadProductionImagePreparation(principal.tenantId, "project-a", "production-contract-fixture", prepared.id)!;
  const batch = (await service.confirmPreparation(principal, "project-a", prepared.id, productionExpected(preparation))).aggregate;
  const l = f.kernel.claimProductionImageBatch(principal, "project-a", batch.batch.id, { workerId: "owned-worker", maxJobs: 1 }).leases[0];
  const args = [principal, "project-a", batch.batch.id, l.jobId, { workerId: l.workerId, leaseId: l.leaseId }] as const;
  const execute = (signal?: AbortSignal) => reconstruction.executeFixture(...args, signal);
  const saved = () => f.store.load()!.batches[0];
  const restart = () => { const store = new SqliteRunKernelStateStore(f.path, { productionResponseStorageEnabled: true }); opened.push(store);
    const kernel = new SqliteRunKernel({ ...kernelOptions, stateStore: store, authorizer: auth, budgets: f.store.load()!.budgets, clock: f.clock }); return { store, kernel }; };
  return { f, saved, execute, reconstruction, construction, kernelOptions, pricePort, send, response, args, config, auth,
    revoke: () => { allowed = false; }, allow: () => { allowed = true; }, deny: (p: string) => denied.add(p), restart };
}

describe("6D4B 同库实际尝试/原响应与未知预算，只用零费用合同端口", () => {
  it.each((["openai", "openai-compatible", "google"] as const).flatMap(protocol => [true, false].flatMap(manual => [true, false].map(edit => [protocol, manual, edit] as const))))(
    "%s manual=%s edit=%s 完整实际闭环", async (protocol, manual, edit) => {
      const t = await live({ protocol, manual, edit }), before = t.f.kernel.getBudget(principal, "project-a"), body = Buffer.from(t.response.body);
      t.send.mockImplementationOnce(async input => {
        expect(t.saved().productionImageAttempt?.state).toBe("attempted"); expect(t.saved().productionImageResult).toBeUndefined();
        expect(input.wire.payloadChecksumSha256).toBe(sha(input.wire.body)); input.assertCurrent(); return t.response;
      });
      const result = await t.execute(), s = t.saved(), raw = t.f.store.loadProductionImageResponse(principal.tenantId, "project-a", "production-contract-fixture", t.args[3])!;
      expect(result.started).toBe(true); expect(result.aggregate.batch.status).toBe("billing_unknown");
      expect(s.productionImageResult).toEqual(raw.record); expect(raw.body).toEqual(body); raw.body.fill(0);
      expect(s.aggregate.jobs[0].estimatedCostMinor).toBe(manual ? null : 25);
      expect(s.aggregate.jobs[0].outputAssetIds).toEqual([]); expect(s.productionImageDispatchIntent?.transport).toBe("not-connected");
      expect(s.aggregate.ledger.map(l => l.settlement)).toEqual(["reserved", "unknown"]);
      expect(t.f.kernel.getBudget(principal, "project-a")).toEqual(before); expect(t.send).toHaveBeenCalledTimes(1); expect(t.pricePort.read).toHaveBeenCalledTimes(1);
      expect(t.response.body).toEqual(body); expect(imageTaskMetadataBytes(t.f.store.load(), principal.tenantId, "project-a")).toBeGreaterThan(Buffer.byteLength(JSON.stringify(s.productionImageResult)));
      const audit = JSON.stringify(s.aggregate); for (const secret of ["原人工指令", t.response.body.toString("base64"), "never-called.invalid", "opaque-never-resolved"]) expect(audit).not.toContain(secret);
  });
  it("并发/重复/重启不解码/verify/询价/补发，也不重复预留", async () => {
    const t = await live({ edit: true }); await Promise.all([t.execute(), t.execute()]); const saved = t.saved(), verifies = t.pricePort.verify.mock.calls.length;
    const rebuild = vi.spyOn(protocolApi, "prepareProductionImageProtocol"); await t.execute(); expect(rebuild).not.toHaveBeenCalled();
    expect(t.pricePort.verify).toHaveBeenCalledTimes(verifies); expect(t.send).toHaveBeenCalledTimes(1); expect(t.saved()).toEqual(saved);
    const restarted = t.restart(); expect(restarted.kernel.getBatch(principal, t.args[2])).toEqual(saved.aggregate);
    expect(restarted.store.load()!.batches[0]).toEqual(saved); expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("单独B2 start历史不能事后补建发送许可", async () => {
    const t = await live(); await t.reconstruction.start(...t.args); const before = t.saved(); const result = await t.execute();
    expect(result.started).toBe(false); expect(t.saved()).toEqual(before); expect(t.saved().productionImageAttempt).toBeUndefined(); expect(t.send).not.toHaveBeenCalled();
  });
  it.each(["same-path", "promise", "throw"])("独立响应政策%s存储端口不能替代同实例", async mode => {
    const t = await live(), read = vi.spyOn(t.f.store, "load");
    const s = new SqliteRunKernelStateStore(t.f.path, { productionResponseStorageEnabled: true }); opened.push(s);
    const options = { ...t.construction, stateStore: mode === "same-path" ? s : t.f.store,
      runKernel: { ...t.construction.runKernel, usesStateStore: () => { if (mode === "promise") return Promise.reject(new Error("private-scope")) as any;
        if (mode === "throw") throw new Error("private-scope"); return false; } } };
    const r = new ImageProductionReconstructionHarness(options); await expect(r.executeFixture(...t.args)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(t.send).not.toHaveBeenCalled(); await pause();
  });
  it.each(["quote", "lease", "job-timeout", "bytes", "wire-target"])("回调内guard遇到%s漂移阻止消费，结束后永久关闭", async mode => {
    const t = await live({ jobTimeout: mode === "job-timeout" ? 1_000 : 30_000 }); let guard: (() => void) | undefined;
    t.send.mockImplementationOnce(async input => { guard = input.assertCurrent;
      if (mode === "bytes") input.wire.body.fill(0); else if (mode === "wire-target") (input.wire as any).url = "https://wrong.invalid/";
      else t.f.advance(mode === "quote" ? 60_000 : mode === "lease" ? 30_000 : 1_001);
      input.assertCurrent(); return t.response; });
    await t.execute(); expect(t.saved().productionImageResult?.kind).toBe("interrupted"); expect(() => guard!()).toThrow();
    expect(t.saved().aggregate.jobs[0].failureCode).toBe("production-transport-error");
  });
  it.each(["constraint", "input", "permission"])("返回后%s漂移拒绝原包与任务提交", async mode => {
    const t = await live({ edit: true }); t.send.mockImplementationOnce(async () => {
      if (mode === "permission") t.deny("asset:read"); else { const c = t.f.store.loadCatalog()!;
        if (mode === "constraint") c.projects[0].constraints[0].brandRules.style = "changed"; else c.projects[0].assets[0].originalName = "changed.png";
        t.f.store.transaction(() => t.f.store.saveCatalog(c)); } return t.response;
    });
    await expect(t.execute()).rejects.toThrow(); expect(t.saved().productionImageAttempt).toBeDefined(); expect(t.saved().productionImageResult).toBeUndefined();
    expect(t.f.store.loadProductionImageResponse(principal.tenantId, "project-a", "production-contract-fixture", t.args[3])).toBeNull();
  });
  it("原包丢失不能冒充尚未返回；重播不得覆写完整原包", async () => {
    const t = await live(); await t.execute(); const current = t.f.kernel.inspectProductionImageAttempt(...t.args), raw = t.f.store.loadProductionImageResponse(principal.tenantId, "project-a", "production-contract-fixture", t.args[3])!;
    const before = t.saved(); expect(() => t.f.kernel.recordProductionImageResult(...t.args, current.result!, raw.body)).toThrow(); expect(t.saved()).toEqual(before);
    expect(() => t.f.kernel.recordProductionImageResult(...t.args, current.result!)).toThrow();
    expect(() => t.f.kernel.recordProductionImageResult(...t.args, { ...current.result!, attemptId: "production-image-attempt:00000000-0000-4000-8000-000000000000" }, raw.body)).toThrow();
    raw.body.fill(0); withDb(t.f.path, db => db.exec("DELETE FROM production_image_responses; DELETE FROM production_image_response_presence")); expect(() => t.restart()).toThrow();
  });
  it("共享逻辑元数据不足不留下attempt或调用回调，不删除历史", async () => {
    const t = await live(), before = t.saved(); const quota = vi.spyOn(t.f.store, "imageMetadataBytes").mockReturnValue(16 * 1024 * 1024);
    await expect(t.execute()).rejects.toThrow(); quota.mockRestore(); expect(t.saved()).toEqual(before); expect(t.send).not.toHaveBeenCalled();
  });
  it.each(["disabled", "raw-off", "production", "relabeled", "timeout-limit"])("%s 默认关闭且私有读取前拒绝", async kind => {
    const t = await live({ enabled: kind !== "disabled", raw: kind !== "raw-off" }), before = t.saved(), read = vi.spyOn(t.f.store, "load");
    const r = kind === "production" ? new ProductionImageTaskReconstruction(t.construction)
      : kind === "relabeled" ? new ImageProductionReconstructionHarness({ ...t.construction, fixtureTransport: { ...t.construction.fixtureTransport, kind: "native-https" } as any })
        : kind === "timeout-limit" ? new ImageProductionReconstructionHarness({ ...t.construction, timeoutMs: 30_001 }) : t.reconstruction;
    await expect(r.executeFixture(...t.args)).rejects.toThrow(); expect(read).not.toHaveBeenCalled(); read.mockRestore(); expect(t.saved()).toEqual(before); expect(t.send).not.toHaveBeenCalled();
  });
  it.each(["run:read", "run:execute", "provider:read", "asset:read"])("%s 撤权在私有读取前关闭", async permission => {
    const t = await live(); t.deny(permission); const spy = vi.spyOn(t.f.store, "load"); await expect(t.execute()).rejects.toThrow(); expect(spy).not.toHaveBeenCalled(); expect(t.send).not.toHaveBeenCalled();
  });
  it.each(["tenant", "project", "actor", "worker", "lease", "job"])("%s 不接受客户端身份替代", async field => {
    const t = await live(), args = [...t.args] as any;
    if (field === "tenant" || field === "actor") args[0] = { ...principal, [field === "tenant" ? "tenantId" : "actorId"]: "other" };
    else if (field === "project") args[1] = "project-b"; else if (field === "job") args[3] = "wrong-job";
    else args[4] = { ...args[4], [field === "worker" ? "workerId" : "leaseId"]: "wrong" };
    await expect(t.reconstruction.executeFixture(args[0], args[1], args[2], args[3], args[4])).rejects.toThrow(); expect(t.send).not.toHaveBeenCalled();
  });
  it.each(["throw", "malformed", "too-large", "bad-image", "http-error"])("%s 不自动成功结算或释放", async kind => {
    const t = await live({ cap: 0 }), before = t.f.kernel.getBudget(principal, "project-a");
    t.send.mockImplementationOnce(async () => { if (kind === "throw") throw new Error("private-key-never-log");
      return { ...t.response, ...(kind === "malformed" ? { contentType: "\r\nsecret" } : kind === "too-large" ? { body: Buffer.alloc(32 * 1024 * 1024 + 1) }
        : kind === "bad-image" ? { body: Buffer.from('{"data":[{"b64_json":"AAAA"}]}') } : { status: 500, body: Buffer.from('{"error":{"message":"private-key-never-log"}}') }) }; });
    await t.execute(); const s = t.saved(); expect(s.aggregate.batch.status).toBe("billing_unknown"); expect(s.jobReservations).toEqual([[t.args[3], 0]]);
    expect(s.aggregate.ledger).toHaveLength(2); expect(t.f.kernel.getBudget(principal, "project-a")).toEqual(before); expect(JSON.stringify(s.productionImageResult)).not.toContain("private-key-never-log");
    expect(t.send).toHaveBeenCalledTimes(1); await t.execute(); expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("迟到报价/租约/停用目录只保存当次原响应，不新授权", async () => {
    const t = await live({ edit: true }), before = t.f.kernel.getBudget(principal, "project-a");
    t.send.mockImplementationOnce(async input => { input.assertCurrent(); t.f.advance(70_000); t.f.register({ ...t.config, enabled: false, revision: 2 }); return t.response; });
    await t.execute(); expect(t.saved().productionImageResult?.kind).toBe("returned"); expect(t.f.kernel.getBudget(principal, "project-a")).toEqual(before);
    const verifyCount = t.pricePort.verify.mock.calls.length; await t.execute(); expect(t.pricePort.verify).toHaveBeenCalledTimes(verifyCount); expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("发送期间显式到期unknown恢复后可保存原包，不改原账本结论", async () => {
    const t = await live(); t.send.mockImplementationOnce(async () => { t.f.advance(31_000); t.f.kernel.reconcileProductionImageBatch(principal, "project-a", t.args[2]); return t.response; });
    await t.execute(); const s = t.saved(); expect(s.aggregate.jobs[0].failureCode).toBe("production-lease-expired-after-intent"); expect(s.productionImageResult?.kind).toBe("returned"); expect(s.aggregate.ledger).toHaveLength(2);
  });
  it.each(["fault", "revoke", "expire", "price", "cancel", "clock-back"])("attempt SQL写后%s回滚且回调不运行", async mode => {
    const t = await live(), original = t.f.store.save.bind(t.f.store), controller = new AbortController();
    const spy = vi.spyOn(t.f.store, "save").mockImplementation(snapshot => { original(snapshot);
      if (snapshot.batches[0]?.productionImageAttempt) { if (mode === "fault") throw new Error("private-save"); else if (mode === "revoke") t.revoke(); else if (mode === "expire") t.f.advance(31_000);
        else if (mode === "cancel") controller.abort(); else if (mode === "clock-back") t.f.advance(-1); else t.pricePort.verify.mockReturnValue(false); } });
    await expect(t.execute(controller.signal)).rejects.toThrow(); spy.mockRestore(); expect(t.saved().productionImageAttempt).toBeUndefined(); expect(t.saved().productionImageDispatchIntent).toBeDefined(); expect(t.send).not.toHaveBeenCalled();
  });
  it.each(["fault", "revoke", "capacity"])("raw SQL写后%s全回滚新原包但保留原attempt/max", async mode => {
    const t = await live(), original = t.f.store.saveProductionImageResponse.bind(t.f.store);
    const spy = vi.spyOn(t.f.store, "saveProductionImageResponse").mockImplementation((record, body, limits) => { original(record, body, limits);
      if (mode === "fault") throw new Error("private-save"); else if (mode === "revoke") t.revoke(); else vi.spyOn(t.f.store, "imageMetadataBytes").mockReturnValue(16 * 1024 * 1024); });
    if (mode === "fault") await t.execute(); else await expect(t.execute()).rejects.toThrow();
    spy.mockRestore(); vi.restoreAllMocks(); const s = t.saved(); expect(s.productionImageAttempt).toBeDefined(); expect(s.productionImageResult?.kind).toBe(mode === "fault" ? "interrupted" : undefined);
    expect(t.f.store.loadProductionImageResponse(principal.tenantId, "project-a", "production-contract-fixture", t.args[3])).toBeNull(); expect(s.jobReservations).toEqual([[t.args[3], 40]]); expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("超时/不合作端口保持槽，guard关闭、无迟到落库或补发", async () => {
    let settle1: ((value: any) => void) | undefined, settle2: ((value: any) => void) | undefined;
    const a = await live({ timeout: 20 }), b = await live({ timeout: 20 }), c = await live({ timeout: 20 });
    let guard: (() => void) | undefined, borrowed: Buffer | undefined;
    a.send.mockImplementationOnce(input => { guard = input.assertCurrent; borrowed = input.wire.body; return new Promise(resolve => { settle1 = resolve; }); });
    b.send.mockImplementationOnce(() => new Promise(resolve => { settle2 = resolve; }));
    try {
      await Promise.all([a.execute(), b.execute()]); expect(a.saved().productionImageResult?.kind).toBe("interrupted"); expect(a.saved().aggregate.jobs[0].failureCode).toBe("production-timeout");
      expect(guard).toBeDefined(); expect(() => guard!()).toThrow(); expect(borrowed!.every(byte => byte === 0)).toBe(true);
      await expect(c.execute()).rejects.toThrow(); expect(c.send).not.toHaveBeenCalled();
      const snapshot = a.saved(); settle1!(a.response); settle2!(b.response); await pause(); expect(a.saved()).toEqual(snapshot);
      await c.execute(); expect(c.send).toHaveBeenCalledTimes(1);
    } finally { settle1?.(a.response); settle2?.(b.response); await pause(); }
  });
  it("取消前无意图，attempt后取消保留未知且只调用一次", async () => {
    const a = await live(), signal = new AbortController(); signal.abort(); await expect(a.execute(signal.signal)).rejects.toThrow(); expect(a.saved().productionImageDispatchIntent).toBeUndefined();
    const b = await live(), abort = new AbortController(); b.send.mockImplementationOnce(async () => { abort.abort(); return b.response; });
    await b.execute(abort.signal); expect(b.saved().productionImageResult?.kind).toBe("interrupted"); expect(b.send).toHaveBeenCalledTimes(1);
  });
  it("写前attempt不证明回调运行，原价格漂移guard阻止使用", async () => {
    const t = await live(); t.send.mockImplementationOnce(async input => { t.pricePort.verify.mockReturnValue(false); input.assertCurrent(); return t.response; });
    await t.execute(); expect(t.saved().productionImageResult?.kind).toBe("interrupted"); expect(t.saved().aggregate.jobs[0].failureCode).toBe("production-transport-error");
  });
  it("默认内核拒绝纯A对象/客户端确认/实际B2返回对象", async () => {
    const t = await live(), other = new SqliteRunKernel({ stateStore: t.f.store, authorizer: t.auth, budgets: t.f.store.load()!.budgets, clock: t.f.clock });
    const spy = vi.spyOn(t.f.store, "load"); expect(() => other.beginProductionImageAttempt(...t.args, {} as any)).toThrow(); expect(spy).not.toHaveBeenCalled();
  });
  it.each(["attempt", "attempt-hash", "result", "result-hash", "audit", "lease", "intent", "estimate", "reservation", "raw", "marker", "orphan", "orphan-all"])("重启%s损坏联合失败关闭", async mode => {
    const t = await live(); await t.execute();
    if (["raw", "marker"].includes(mode)) withDb(t.f.path, db => { if (mode === "raw") db.prepare("UPDATE production_image_responses SET body = ?").run(Buffer.from("bad")); else db.exec("DELETE FROM production_image_response_presence"); });
    else { const s = t.f.store.load()!, b = s.batches[0];
      if (mode === "attempt") { b.productionImageAttempt!.actorId = "other"; b.productionImageAttemptFingerprint = fp(b.productionImageAttempt); }
      else if (mode === "attempt-hash") b.productionImageAttemptFingerprint = "f".repeat(64);
      else if (mode === "result") { b.productionImageResult!.outcome.artifactStatus = "absent"; b.productionImageResultFingerprint = fp(b.productionImageResult); }
      else if (mode === "result-hash") b.productionImageResultFingerprint = "f".repeat(64);
      else if (mode === "audit") b.aggregate.audit = b.aggregate.audit.filter(a => a.eventType !== "production-image-attempted");
      else if (mode === "lease") b.productionImageLeases![0].actorId = "other";
      else if (mode === "intent") b.productionImageDispatchIntentFingerprint = "f".repeat(64);
      else if (mode === "estimate") b.aggregate.jobs[0].estimatedCostMinor = 0;
      else if (mode === "reservation") b.jobReservations[0][1] = 0;
      else { delete b.productionImageResult; delete b.productionImageResultFingerprint;
        if (mode === "orphan-all") { delete b.productionImageAttempt; delete b.productionImageAttemptFingerprint;
          b.aggregate.audit = b.aggregate.audit.filter(a => !["production-image-attempted", "production-image-returned", "billing-unknown"].includes(a.eventType));
          b.aggregate.ledger = b.aggregate.ledger.slice(0, 1); b.aggregate.batch.status = "running"; b.aggregate.jobs[0].status = "running";
          delete b.aggregate.jobs[0].finishedAt; delete b.aggregate.jobs[0].failureCode; } }
      t.f.store.transaction(() => t.f.store.save(s)); }
    expect(() => t.restart()).toThrow(); expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("旧mock/local领取/取消/核账/自动成功不能消费生产attempt", async () => {
    const t = await live(); await t.execute(); const before = t.saved();
    for (const action of [() => t.f.kernel.executeLeasedJob(principal, t.args[2], t.args[3], t.args[4]), () => t.f.kernel.startImageJob(principal, t.args[2], t.args[3], t.args[4]),
      () => t.f.kernel.resolveBillingUnknown(principal, t.args[2], t.args[3], { decision: "not-charged", evidenceRef: "bad", resolutionId: "bad" } as any), () => t.f.kernel.cancelBatch(principal, t.args[2])]) expect(action).toThrow();
    expect(t.saved()).toEqual(before);
  });
  it("内存显式崩溃恢复attempt不补发/释放，SQLite构造只读不隐式重排", async () => {
    const t = await live(); t.send.mockImplementationOnce(async () => { t.revoke(); return t.response; }); await expect(t.execute()).rejects.toThrow(); t.allow();
    const before = t.saved(); const second = t.restart(); expect(second.store.load()!.batches[0]).toEqual(before);
    const memory = new InMemoryRunKernel({ ...t.kernelOptions, authorizer: t.auth, budgets: t.f.store.load()!.budgets, clock: t.f.clock,
      stateStore: { load: () => t.f.store.load(), save: () => undefined } });
    expect(memory.getBatch(principal, t.args[2]).jobs[0].status).toBe("billing_unknown"); expect(t.send).toHaveBeenCalledTimes(1); expect(t.saved()).toEqual(before);
  });
});
