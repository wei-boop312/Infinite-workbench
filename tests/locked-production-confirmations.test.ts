import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VerifiedImageSchema, ConfirmedProductionImageExecutionSchema, ProductionImageExecutionRequestSchema, ConfirmedLockedProductionImageExecutionSchema } from "../packages/contracts/src/index";
import { LockedImageProductionPreparationHarness, LockedProductionImagePreparations, type LockedImagePriceContext } from "../apps/api/src/lockedProductionImagePreparations";
import { assertLockedConfirmation, lockedExpected } from "../apps/api/src/lockedProductionImageProtocol";
import * as protocol from "../apps/api/src/lockedProductionImageProtocol";
import * as decoder from "../apps/api/src/staticImageDecoder";
import { imageSnapshotFingerprint as fp, validateProductionImageProviderRequest } from "../apps/api/src/imageProviderContract";
import { assetMetadataFingerprint } from "../apps/api/src/assetMetadata";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { at, connection, principal, setupImageTask, sha } from "./helpers/image-task-fixture";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
let source: Buffer, mask: Buffer;
const owned: ReturnType<typeof setupImageTask>[] = [], connections: SqliteRunKernelStateStore[] = [];
beforeAll(async () => { const png = (p: number[]) => sharp(Buffer.from(p), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  source = await png([10,20,30,255,40,50,60,255]); mask = await png([0,0,0,0,255,255,255,255]); });
afterEach(() => { vi.restoreAllMocks(); connections.splice(0).forEach(c => c.close()); owned.splice(0).forEach(f => f.cleanup()); });
function fixture(opts: { manual?: boolean; cap?: number; protocol?: "openai" | "openai-compatible"; encoding?: "json-images" | "multipart-image-array" | "multipart-image-single"; production?: boolean; timeout?: number; enabled?: boolean } = {}) {
  let service: LockedImageProductionPreparationHarness | LockedProductionImagePreparations;
  const f = setupImageTask({ productionResponses: true, productionArtifacts: true,
    kernel: { validateLockedProductionImageConfirmation: (p, e) => service.authorizeConfirmation(p, e) } }); owned.push(f);
  const denied = new Set<string>(); let policy: unknown = true, allowed: unknown = true;
  const authorizer = { authenticate: () => principal, allows: (p: typeof principal, project: string, permission: string) =>
    p.tenantId === principal.tenantId && ["writer", "reader"].includes(p.actorId) && project === "project-a" && !denied.has(permission) ? allowed as boolean : false };
  const base = connection(), config = connection({ protocol: opts.protocol ?? "openai", models: [{ ...base.models[0], sizes: { allowAuto: false, presets: [{ width: 2, height: 1 }] },
    mask: { mode: "prompt-guidance", polarity: opts.protocol === "openai-compatible" ? "white-edit" : "transparent-edit" } }],
    ...(opts.protocol === "openai-compatible" ? { compatibility: { version: "owned", editEncoding: opts.encoding ?? "json-images", responseEncoding: "images-b64-json-v1",
      auth: { scheme: "bearer" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}) }); f.register(config);
  for (const [id, body, purpose] of [["source", source, "source"], ["mask", mask, "mask"]] as const) {
    const a = { id, projectId: "project-a", kind: "image", purpose, storageKey: `owned:${id}`, originalName: `${id}.png`, mimeType: "image/png", byteSize: body.length,
      width: 2, height: 1, contentFingerprint: `sha256:${sha(body)}`, createdAt: at, ...(purpose === "mask" ? { sourceAssetId: "source" } : {}) };
    const r = VerifiedImageSchema.parse({ schemaVersion: 1, id: `receipt-${id}`, tenantId: principal.tenantId, asset: a, checksumSha256: sha(body),
      registeredMetadataSha256: assetMetadataFingerprint(a as any), decoder: "sharp-full-decode-v1", verifiedBy: "owned", verifiedAt: at,
      ...(purpose === "mask" ? { sourceChecksumSha256: sha(source) } : {}) });
    f.store.transaction(() => { f.store.saveVerifiedImage(r, body); const c = f.store.loadCatalog()!; c.projects[0].assets.push(r.asset); f.store.saveCatalog(c); });
  }
  f.store.transaction(() => { const c = f.store.loadCatalog()!, x = c.projects[0].constraints[0]; x.lockedPaths = ["product.pixels"];
    x.editableRegions = [{ id: "region", description: "原锁区", maskAssetId: "mask" }]; x.outputSpec = { width: 2, height: 1, format: "png" }; f.store.saveCatalog(c); });
  const pricePort = { kind: opts.production ? "server-pricing" : "contract-fixture", realExecutionEnabled: false,
    read: vi.fn((c: LockedImagePriceContext) => ({ schemaVersion: 1, scope: c.scope, quote: { id: "owned-price", version: "owned-v1", currency: "CNY",
      source: opts.manual ? "manual-budget" : "server-price-table", maxCostMinor: opts.cap ?? 40, ...(opts.manual ? {} : { estimatedCostMinor: 25 }), expiresAt: new Date(f.clock() + 60_000).toISOString() },
      evidence: { kind: opts.production ? opts.manual ? "server-approved-budget" : "server-verified-price" : "contract-fixture", ...(opts.production ? {} : { realExecutionEnabled: false }),
        sourceRevision: "owned", evidenceRef: "owned-price", checkedBy: "owned", checkedAt: c.requestedAt } })), verify: vi.fn((): unknown => true) };
  const options = { preparationEnabled: true as const, lockedPreparationEnabled: true as const, lockedConfirmationEnabled: opts.enabled === false ? undefined : true as const,
    tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, clock: f.clock, timeoutMs: opts.timeout, pricePort: pricePort as any,
    authorizer, runAuthorizer: authorizer, assetAuthorizer: authorizer, lockedPreparationPolicy: () => true, lockedConfirmationPolicy: () => policy as boolean };
  service = opts.production ? new LockedProductionImagePreparations(options) : new LockedImageProductionPreparationHarness(options);
  const select = (action = "locked-owned") => ({ projectId: "project-a", idempotencyKey: action, connectionId: config.id, connectionRevision: 1, model: config.models[0].model,
    capabilityVersion: config.models[0].version, constraintSnapshotId: "constraint-a", operation: "edit", inputAssetIds: ["source"], maskAssetId: "mask", protection: "pixel-exact",
    parameters: { prompt: "原人工锁区指令", n: 1, size: { width: 2, height: 1 }, quality: "auto", background: "auto", outputFormat: "png" } });
  const prepare = async (action = "locked-owned") => { const v = await service.createPreparation(principal, select(action)); return f.store.loadLockedProductionImagePreparation(principal.tenantId, "project-a", v.mode, v.id)!; };
  const confirm = (p: Awaited<ReturnType<typeof prepare>>, actor = principal, expected: unknown = lockedExpected(p), signal?: AbortSignal) => service.confirmPreparation(actor, "project-a", p.id, expected, { signal });
  return { ...f, service, options, authorizer, config, select, prepare, confirm, pricePort, deny: (p: string) => denied.add(p), policy: (p: unknown) => { policy = p; }, allow: (v: unknown) => { allowed = v; } };
}
async function unchanged(f: ReturnType<typeof fixture>, action: () => unknown) {
  const s = f.store.load(), c = f.store.loadCatalog(); await expect(Promise.resolve().then(action)).rejects.toThrow(); expect(f.store.load()).toEqual(s); expect(f.store.loadCatalog()).toEqual(c);
}
describe("锁区B2实际同库确认，不是后续运行/产物许可", () => {
  it.each([false, true])("从头生产工厂known/unknown %s，完整政策身份与预算一次预留", async manual => {
    const f = fixture({ production: true, manual }), p = await f.prepare(), before = f.store.load(), v = await f.confirm(p), stored = f.store.load()!.batches[0], e = stored.lockedProductionImageExecution!;
    expect(v).toMatchObject({ schemaVersion: 2, mode: "production", executionAuthorized: false, realExecutionEnabled: false, status: "queued", reservedMinor: 40, estimatedCostMinor: manual ? null : 25 });
    expect(before!.batches).toHaveLength(0); expect(stored.aggregate.ledger[0]).toMatchObject({ reservedMinor: 40, estimatedMinor: manual ? null : 25 });
    expect(stored.aggregate.jobs[0].actualCostMinor).toBeUndefined(); expect(e.protocol.request.protectionPolicy).toEqual(p.protectionPolicy); expect(assertLockedConfirmation(e)).toEqual(e);
    expect(e.protocol.requestFingerprint).toBe(fp({ connection: p.connection, request: e.protocol.request })); expect(stored.productionImageExecution).toBeUndefined();
    expect(ConfirmedProductionImageExecutionSchema.safeParse(e).success).toBe(false); expect(ProductionImageExecutionRequestSchema.safeParse(e.protocol.request).success).toBe(false);
    expect(f.pricePort.read).toHaveBeenCalledTimes(1); expect(f.pricePort.verify.mock.calls.at(-1)![0]).toMatchObject({ purpose: "confirm", protectionPolicy: p.protectionPolicy, scope: p.pricing.scope });
    expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0, availableMinor: 960 });
    expect(JSON.stringify(v)).not.toMatch(/idempotencyKey|worker|lease|endpoint|credential|wire|body|baseUrl/);
  });
  it.each(["json-images", "multipart-image-array", "multipart-image-single"] as const)("compatible原编码%s，政策不作为任意供应商字段", async encoding => {
    const f = fixture({ protocol: "openai-compatible", encoding }), p = await f.prepare(), real = protocol.prepareLockedProductionImageProtocol; let actual = "";
    const spy = vi.spyOn(protocol, "prepareLockedProductionImageProtocol").mockImplementation(async (...args) => { const value = await real(...args); actual = value.wire.body.toString("utf8"); return value; });
    await f.confirm(p); const wire = (await spy.mock.results[0].value).wire; expect(wire.body.every((b: number) => b === 0)).toBe(true);
    expect(actual).not.toMatch(/protectionPolicy|lockedPixels|editablePixels|receipt-source|normalizationVersion|sourcePixelsSha256/);
    const e = f.store.load()!.batches[0].lockedProductionImageExecution!; expect(e.protocol.contentType).toMatch(encoding === "json-images" ? /application\/json/ : /boundary=canvas-/);
    expect(e.protocol.transformedInputs.at(-1)!.transform).toBe("internal-white-mask-v1"); expect(assertLockedConfirmation(e)).toEqual(e);
  });
  it("unknown zero-cap仍保存完整身份和零预留关系，不推估价或实费0", async () => {
    const f = fixture({ manual: true, cap: 0 }), p = await f.prepare(), v = await f.confirm(p), s = f.store.load()!.batches[0];
    expect(v).toMatchObject({ estimatedCostMinor: null, reservedMinor: 0 }); expect(s.jobReservations).toEqual([[v.jobId, 0]]); expect(s.aggregate.jobs[0]).not.toHaveProperty("actualCostMinor");
  });
  it("确认双开关默认关闭，在私有读取前拒绝", async () => {
    const f = fixture({ enabled: false }), p = await f.prepare(), spy = vi.spyOn(f.store, "loadLockedProductionImagePreparation");
    await unchanged(f, () => f.confirm(p)); expect(spy).not.toHaveBeenCalled(); expect(() => f.service.getConfirmation(principal, "project-a", p.id)).toThrow();
  });
  it.each(["run:create", "run:confirm", "run:read", "provider:read", "asset:read"])("私有确认读取前%s同步权限", async permission => {
    const f = fixture(), p = await f.prepare(); f.deny(permission); const spy = vi.spyOn(f.store, "loadLockedProductionImagePreparation");
    await unchanged(f, () => f.confirm(p)); expect(spy).not.toHaveBeenCalled();
  });
  it.each([false, undefined, 1, "true", { then: () => undefined }])("独立同步政策非true %s关闭", async policy => {
    const f = fixture(), p = await f.prepare(); f.policy(policy); await unchanged(f, () => f.confirm(p));
  });
  it.each(["expectedSnapshotFingerprint", "expectedPricingFingerprint", "expectedProtectionPolicyFingerprint", "expectedCurrency", "expectedMaxCostMinor", "estimate"])("人工完整期待%s漂移拒绝", async key => {
    const f = fixture(), p = await f.prepare(), x: any = lockedExpected(p); x[key] = key === "expectedCurrency" ? "USD" : key === "expectedMaxCostMinor" ? 41 : key === "estimate" ? { state: "unknown" } : "a".repeat(64);
    await unchanged(f, () => f.confirm(p, principal, x));
  });
  it("确认仅原准备人；独立读者可以只读，无create/confirm/execute/billing/write", async () => {
    const f = fixture(), p = await f.prepare(); await unchanged(f, () => f.confirm(p, { ...principal, actorId: "reader" }));
    const v = await f.confirm(p); ["run:create", "run:confirm", "run:execute", "run:reconcile-billing", "asset:write"].forEach(f.deny);
    expect(f.service.getConfirmation({ ...principal, actorId: "reader" }, "project-a", p.id)).toEqual(v);
  });
  it.each(["tenant", "project"])("跨%s读取拒绝", async scope => {
    const f = fixture(), p = await f.prepare(); await f.confirm(p); expect(() => f.service.getConfirmation(scope === "tenant" ? { ...principal, tenantId: "other" } : principal, scope === "project" ? "other" : "project-a", p.id)).toThrow();
  });
  it("报价到期/目录停用后的重复和只读历史不read/verify/解码/保存或二次预留", async () => {
    const f = fixture(), p = await f.prepare(), v = await f.confirm(p); f.advance(120000);
    f.register({ ...f.config, revision: 2, enabled: false }); f.pricePort.read.mockClear(); f.pricePort.verify.mockClear();
    const native = vi.spyOn(decoder, "decodeStaticImagePixels"), save = vi.spyOn(f.store, "save"), state = f.store.load();
    expect(await f.confirm(p)).toEqual(v); expect(f.service.getConfirmation(principal, "project-a", p.id)).toEqual(v);
    expect(f.store.load()).toEqual(state); expect(f.pricePort.read).not.toHaveBeenCalled(); expect(f.pricePort.verify).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it("首次过期报价不确认", async () => { const f = fixture(), p = await f.prepare(); f.advance(60001); await unchanged(f, () => f.confirm(p)); });
  it("同库并发只一个确认/预留", async () => {
    const f = fixture(), p = await f.prepare(), [a, b] = await Promise.all([f.confirm(p), f.confirm(p)]); expect(a).toEqual(b); expect(f.store.load()!.batches).toHaveLength(1);
    expect(f.kernel.getBudget(principal, "project-a").reservedMinor).toBe(40);
  });
  it("另一实际SQLite连接和重启恢复原任务，不需要活提交或重新报价", async () => {
    const f = fixture(), p = await f.prepare(), v = await f.confirm(p); const store = new SqliteRunKernelStateStore(f.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true }); connections.push(store);
    const kernel = new SqliteRunKernel({ stateStore: store, authorizer: f.authorizer as any, clock: f.clock, budgets: [{ tenantId: principal.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }] });
    const reader = new LockedImageProductionPreparationHarness({ ...f.options, stateStore: store, runKernel: kernel }); f.pricePort.verify.mockClear();
    expect(reader.getConfirmation(principal, "project-a", p.id)).toEqual(v); expect(await reader.confirmPreparation(principal, "project-a", p.id, lockedExpected(p))).toEqual(v); expect(f.pricePort.verify).not.toHaveBeenCalled();
  });
  it("原预算不足不消耗准备/创建任务或缩小上限", async () => {
    const f = fixture({ cap: 600 }), a = await f.prepare("one"), b = await f.prepare("two"); await f.confirm(a); await unchanged(f, () => f.confirm(b));
    expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 600, availableMinor: 400, spentMinor: 0 });
  });
  it.each(["permission", "price", "constraint", "clock", "failure"])("实际SQL写后%s撤销/漂移/故障整体回滚", async cause => {
    const f = fixture(), p = await f.prepare(), save = f.store.save.bind(f.store); vi.spyOn(f.store, "save").mockImplementation(s => { save(s);
      if (s.batches.some(b => b.lockedProductionImageExecution)) {
        if (cause === "permission") f.deny("run:confirm"); else if (cause === "price") f.pricePort.verify.mockReturnValue(false); else if (cause === "clock") f.advance(6000);
        else if (cause === "failure") throw new Error("owned-write-fault"); else { const c = f.store.loadCatalog()!; c.projects[0].constraints[0].brandRules.style = "drift"; f.store.saveCatalog(c); }
      } }); await unchanged(f, () => f.confirm(p));
  });
  it("确认权限撤回、取消、输入变化在SQL外await后拒绝", async () => {
    const f = fixture(), p = await f.prepare(), real = protocol.prepareLockedProductionImageProtocol; let release!: () => void;
    vi.spyOn(protocol, "prepareLockedProductionImageProtocol").mockImplementation(async (...args) => { const wire = await real(...args); await new Promise<void>(r => release = r); return wire; });
    const state = f.store.load(), action = f.confirm(p); while (!release) await new Promise(r => setTimeout(r, 1)); f.deny("asset:read"); release(); await expect(action).rejects.toThrow(); expect(f.store.load()).toEqual(state);
  });
  it("首已取消signal不读取输入/创建任务", async () => { const f = fixture(), p = await f.prepare(), c = new AbortController(); c.abort(); await unchanged(f, () => f.confirm(p, principal, lockedExpected(p), c.signal)); });
  it.each(["policy", "confirmation", "protocol", "ledger", "audit", "reservation", "both"])("存档%s删除/部分重算摘要仍失败关闭", async kind => {
    const f = fixture(), p = await f.prepare(); await f.confirm(p); const state: any = f.store.load()!, s = state.batches[0];
    if (kind === "policy") { s.lockedProductionImageExecution.protocol.request.protectionPolicy.lockedPixels = 2; }
    else if (kind === "confirmation") delete s.lockedProductionImageExecution;
    else if (kind === "both") { s.productionImageExecution = s.lockedProductionImageExecution; }
    else if (kind === "protocol") { s.lockedProductionImageExecution.protocol.requestFingerprint = "a".repeat(64); s.requestFingerprint = fp(s.lockedProductionImageExecution); }
    else if (kind === "ledger") s.aggregate.ledger[0].estimatedMinor = 0;
    else if (kind === "audit") s.aggregate.audit[1].metadata.preparationFingerprint = "a".repeat(64);
    else s.jobReservations = [];
    try { f.store.transaction(() => f.store.save(state)); } catch { return; }
    expect(() => f.service.getConfirmation(principal, "project-a", p.id)).toThrow();
  });
  it("活pending关闭后直接内核重放/schema/SHA不成为许可", async () => {
    const f = fixture(), p = await f.prepare(); await f.confirm(p); const e = f.store.load()!.batches[0].lockedProductionImageExecution!;
    expect(f.service.authorizeConfirmation(principal, e)).toBe(false); expect(() => f.kernel.stageConfirmedLockedProductionImageBatch(principal, e)).toThrow();
    expect(() => f.kernel.stageConfirmedProductionImageBatch(principal, e as any)).toThrow(); expect(() => validateProductionImageProviderRequest(p.connection, e.protocol.request, at)).toThrow();
  });
  it("所有旧领取/运行/取消/费用路径仍拒绝新保护任务", async () => {
    const f = fixture(), p = await f.prepare(), v = await f.confirm(p), state = f.store.load();
    expect(() => f.kernel.cancelBatch(principal, v.batchId)).toThrow(); expect(() => f.kernel.dispatchBatch(principal, v.batchId)).toThrow();
    expect(() => f.kernel.claimProductionImageBatch(principal, "project-a", v.batchId, { workerId: "owned", maxJobs: 1 })).toThrow(); expect(f.store.load()).toEqual(state);
  });
  it.each([false, "true", 1, Promise.resolve(true)])("确认权限非严格true %s", async allowed => {
    const f = fixture(), p = await f.prepare(); f.allow(allowed); await unchanged(f, () => f.confirm(p));
  });
  it.each([false, "true", 1, Promise.resolve(true)])("确认可信价格verify非严格true %s", async value => {
    const f = fixture(), p = await f.prepare(); f.pricePort.verify.mockReturnValue(value); await unchanged(f, () => f.confirm(p));
  });
  it.each(["connection", "constraint", "input", "clock", "budget"])("可信价格回调改变%s整体回滚", async kind => {
    const f = fixture(), p = await f.prepare(); let once = false;
    f.pricePort.verify.mockImplementation(() => { if (!once) { once = true;
      if (kind === "clock") f.advance(60001);
      else if (kind === "connection") f.register({ ...f.config, revision: 2, enabled: false });
      else if (kind === "budget") { const s = f.store.load()!; s.budgets[0].limitMinor++; f.store.save(s); }
      else { const c = f.store.loadCatalog()!; if (kind === "input") c.projects[0].assets.find(a => a.id === "source")!.byteSize++; else c.projects[0].constraints[0].brandRules.style = "callback-drift"; f.store.saveCatalog(c); }
    } return true; }); await unchanged(f, () => f.confirm(p));
  });
  it("写后共享元数据容量不足，任务账本预留一起回滚", async () => {
    const f = fixture(), p = await f.prepare(), limit = f.store.imageMetadataBytes(principal.tenantId, "project-a") + Buffer.byteLength(JSON.stringify(p)) + 100;
    const service = new LockedImageProductionPreparationHarness({ ...f.options, maxMetadataBytes: limit });
    const e = vi.spyOn(f.service, "authorizeConfirmation"); e.mockImplementation((principal, incoming) => service.authorizeConfirmation(principal, incoming));
    await unchanged(f, () => service.confirmPreparation(principal, "project-a", p.id, lockedExpected(p)));
  });
  it("关闭任一原包/产物存储开关不能跳过完整历史核验", async () => {
    const f = fixture(), p = await f.prepare(); await f.confirm(p);
    for (const which of ["supportsProductionImageResponses", "supportsProductionImageArtifacts"] as const) {
      const stub = vi.spyOn(f.store, which).mockReturnValue(false); expect(() => f.service.getConfirmation(principal, "project-a", p.id)).toThrow(); stub.mockRestore();
    }
  });
  it("两SQLite连接并发确认只保留原完整结论与一次预留", async () => {
    const f = fixture(), p = await f.prepare(); const store = new SqliteRunKernelStateStore(f.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true }); connections.push(store);
    let service!: LockedImageProductionPreparationHarness;
    const kernel = new SqliteRunKernel({ stateStore: store, authorizer: f.authorizer as any, clock: f.clock, budgets: [{ tenantId: principal.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }],
      validateLockedProductionImageConfirmation: (actor, e) => service.authorizeConfirmation(actor, e) });
    service = new LockedImageProductionPreparationHarness({ ...f.options, stateStore: store, runKernel: kernel });
    const [a, b] = await Promise.all([f.confirm(p), service.confirmPreparation(principal, "project-a", p.id, lockedExpected(p))]); expect(a).toEqual(b);
    expect(store.load()!.batches).toHaveLength(1); expect(store.load()!.budgets[0].reservedMinor).toBe(40);
  });
  it("提交后只读中的撤权保持历史与预留，不冒充未确认", async () => {
    const f = fixture(), p = await f.prepare(); await f.confirm(p); const state = f.store.load(), get = f.store.loadVerifiedImage.bind(f.store);
    vi.spyOn(f.store, "loadVerifiedImage").mockImplementation((...args) => { const r = get(...args); f.deny("asset:read"); return r; });
    expect(() => f.service.getConfirmation(principal, "project-a", p.id)).toThrow(/只读核对/); expect(f.store.load()).toEqual(state);
  });
  it("取消非合作协议工作仍占两槽，迟到不提交且自有wire清零", async () => {
    const f = fixture(), p = await f.prepare(), real = protocol.prepareLockedProductionImageProtocol;
    const pending: (() => void)[] = [], wires: Buffer[] = [];
    vi.spyOn(protocol, "prepareLockedProductionImageProtocol").mockImplementation(async (...args) => { const value = await real(...args); wires.push(value.wire.body); await new Promise<void>(r => pending.push(r)); return value; });
    const c1 = new AbortController(), c2 = new AbortController(), state = f.store.load();
    const a = f.confirm(p, principal, lockedExpected(p), c1.signal), b = f.confirm(p, principal, lockedExpected(p), c2.signal);
    while (pending.length !== 2) await new Promise(r => setTimeout(r, 1)); c1.abort(); c2.abort(); await expect(a).rejects.toThrow(); await expect(b).rejects.toThrow();
    await expect(f.confirm(p)).rejects.toMatchObject({ code: "locked_confirmation_busy" }); pending.forEach(done => done()); await new Promise(r => setTimeout(r, 10));
    expect(f.store.load()).toEqual(state); expect(wires.every(w => w.every(b => b === 0))).toBe(true);
  });
  it("普通毫秒推进可以确认，价格时刻不冒充确认时刻", async () => {
    const f = fixture(), p = await f.prepare(), verify = f.pricePort.verify.getMockImplementation()!;
    f.pricePort.verify.mockImplementation((...args: any[]) => { f.advance(1); return (verify as any)(...args); }); const v = await f.confirm(p);
    expect(Date.parse(v.confirmedAt)).toBeGreaterThan(Date.parse(p.createdAt)); expect(assertLockedConfirmation(f.store.load()!.batches[0].lockedProductionImageExecution)).toBeTruthy();
  });
  it.each(["raw", "artifact"])("孤立%s不能附着在B2仅queued确认上", async kind => {
    const f = fixture(), p = await f.prepare(); await f.confirm(p); const getter = kind === "raw" ? "loadLockedProductionImageResponse" : "loadProductionImageArtifact";
    const body = Buffer.from("owned"); vi.spyOn(f.store, getter as any).mockReturnValue(kind === "raw" ? { body, record: {} } : {});
    expect(() => f.service.getConfirmation(principal, "project-a", p.id)).toThrow(); expect(() => f.kernel.getBudget(principal, "project-a")).toThrow();
    if (kind === "raw") expect(body.every(b => b === 0)).toBe(true);
  });
  it("旧none确认不能事后加入保护政策升级", async () => {
    const f = fixture(), p = await f.prepare(); await f.confirm(p); const e: any = f.store.load()!.batches[0].lockedProductionImageExecution!;
    e.schemaVersion = 1; e.preparation.schemaVersion = 1; e.protocol.schemaVersion = 1; e.protocol.protocolVersion = "production-image-protocol-v1";
    expect(ConfirmedProductionImageExecutionSchema.safeParse(e).success).toBe(false); expect(ConfirmedLockedProductionImageExecutionSchema.safeParse(e).success).toBe(false);
  });
  it("未来版本拒绝，不默认为none或新的许可", async () => {
    const f = fixture(), p = await f.prepare(); await f.confirm(p); const e: any = f.store.load()!.batches[0].lockedProductionImageExecution!; e.protocol.schemaVersion = 3;
    expect(() => assertLockedConfirmation(e)).toThrow(); expect(() => f.kernel.stageConfirmedLockedProductionImageBatch(principal, e)).toThrow();
  });
});
