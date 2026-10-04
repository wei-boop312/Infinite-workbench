import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LockedProductionImagePreparationRecordSchema, ProductionImagePreparationRecordSchema, VerifiedImageSchema } from "../packages/contracts/src/index";
import { LockedImageProductionPreparationHarness, LockedProductionImagePreparations, type LockedImagePriceContext } from "../apps/api/src/lockedProductionImagePreparations";
import { ImageProductionPreparationHarness } from "../apps/api/src/productionImagePreparations";
import { prepareProductionImageProtocol } from "../apps/api/src/productionImageProtocol";
import { productionExpected } from "../apps/api/src/productionImageConfirmationIntegrity";
import { imageSnapshotFingerprint, validateProductionImageProviderRequest } from "../apps/api/src/imageProviderContract";
import { assetMetadataFingerprint } from "../apps/api/src/assetMetadata";
import * as decoder from "../apps/api/src/staticImageDecoder";
import { at, connection, principal, setupImageTask, sha } from "./helpers/image-task-fixture";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
const owned: ReturnType<typeof setupImageTask>[] = [];
let source: Buffer, mask: Buffer, allEditable: Buffer, allLocked: Buffer, invalidMask: Buffer;
beforeAll(async () => {
  const encode = (rgba: number[]) => sharp(Buffer.from(rgba), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  source = await encode([10,20,30,255, 40,50,60,255]); mask = await encode([0,0,0,0, 255,255,255,255]);
  allEditable = await encode([255,255,255,255, 255,255,255,255]); allLocked = await encode([0,0,0,0, 255,255,255,254]);
  invalidMask = await encode([0,0,0,0, 255,0,255,128]);
});
afterEach(() => { vi.restoreAllMocks(); for (const f of owned.splice(0).reverse()) f.cleanup(); });
function fixture(options: { manual?: boolean; cap?: number; quota?: number; timeout?: number; mask?: Buffer; protocol?: "openai" | "openai-compatible" | "google"; production?: boolean } = {}) {
  const f = setupImageTask(); owned.push(f); const denied = new Set<string>(); let allowed: unknown = true, policy: unknown = true;
  const allows = (p: typeof principal, project: string, permission: string) => p.tenantId === principal.tenantId && p.actorId === principal.actorId && project === "project-a" && !denied.has(permission) ? allowed as boolean : false;
  const authorizer = { authenticate: () => principal, allows };
  const protocol = options.protocol ?? "openai", base = connection(), config = connection({ protocol,
    models: [{ ...base.models[0], sizes: { allowAuto: false, presets: [{ width: 2, height: 1 }] }, mask: { mode: "prompt-guidance", polarity: "white-edit" } }],
    ...(protocol === "openai-compatible" ? { compatibility: { version: "owned", editEncoding: "json-images", responseEncoding: "images-b64-json-v1", auth: { scheme: "bearer" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}),
    ...(protocol === "google" ? { googleNative: { version: "owned", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: base.models[0].model, sizes: [{ width: 2, height: 1, aspectRatio: "1:1", imageSize: "1K" }] }] } } : {}) });
  f.register(config);
  function registerAsset(id: string, body: Buffer, purpose: "source" | "mask", sourceId?: string) {
    const asset = { id, projectId: "project-a", kind: "image", purpose, storageKey: `owned:${id}`, originalName: `${id}.png`, mimeType: "image/png", byteSize: body.length,
      width: 2, height: 1, contentFingerprint: `sha256:${sha(body)}`, createdAt: at, ...(sourceId ? { sourceAssetId: sourceId } : {}) };
    const receipt = VerifiedImageSchema.parse({ schemaVersion: 1, id: `receipt-${id}`, tenantId: principal.tenantId, asset, checksumSha256: sha(body),
      registeredMetadataSha256: assetMetadataFingerprint(asset as any), decoder: "sharp-full-decode-v1", verifiedBy: "owned-fixture", verifiedAt: at,
      ...(sourceId ? { sourceChecksumSha256: sha(source) } : {}) });
    f.store.transaction(() => { f.store.saveVerifiedImage(receipt, body); const c = f.store.loadCatalog()!; c.projects[0].assets.push(receipt.asset); f.store.saveCatalog(c); });
  }
  registerAsset("source", source, "source"); registerAsset("mask", options.mask ?? mask, "mask", "source");
  f.store.transaction(() => { const c = f.store.loadCatalog()!, constraint = c.projects[0].constraints[0]; constraint.lockedPaths = ["product.pixels"];
    constraint.editableRegions = [{ id: "region", description: "原完整区域", maskAssetId: "mask" }]; constraint.outputSpec = { width: 2, height: 1, format: "png" }; f.store.saveCatalog(c); });
  const pricePort = { kind: options.production ? "server-pricing" as const : "contract-fixture" as const, realExecutionEnabled: false as const,
    read: vi.fn((c: LockedImagePriceContext) => ({ schemaVersion: 1, scope: c.scope,
      quote: { id: "owned-price", version: "owned-v1", source: options.manual ? "manual-budget" : "server-price-table", currency: "CNY", maxCostMinor: options.cap ?? 40,
        ...(options.manual ? {} : { estimatedCostMinor: 25 }), expiresAt: new Date(f.clock() + 60_000).toISOString() },
      evidence: { kind: options.production ? options.manual ? "server-approved-budget" : "server-verified-price" : "contract-fixture",
        ...(options.production ? {} : { realExecutionEnabled: false }), sourceRevision: "owned-table", evidenceRef: "owned-zero-cost-price", checkedBy: "owned-oracle", checkedAt: c.requestedAt } })),
    verify: vi.fn((): unknown => true) };
  const configOptions = { preparationEnabled: true as const, lockedPreparationEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel,
    authorizer, runAuthorizer: authorizer, assetAuthorizer: authorizer, clock: f.clock, pricePort: pricePort as any, timeoutMs: options.timeout, maxMetadataBytes: options.quota,
    lockedPreparationPolicy: vi.fn(() => policy as boolean) };
  const service = options.production ? new LockedProductionImagePreparations(configOptions) : new LockedImageProductionPreparationHarness(configOptions);
  const select = (extra: Record<string, unknown> = {}) => ({ projectId: "project-a", idempotencyKey: "owned-locked-action", connectionId: config.id, connectionRevision: 1,
    model: config.models[0].model, capabilityVersion: config.models[0].version, constraintSnapshotId: "constraint-a", protection: "pixel-exact", operation: "edit",
    inputAssetIds: ["source"], maskAssetId: "mask", parameters: { prompt: "原人工锁区指令", n: 1, size: { width: 2, height: 1 }, quality: "auto", background: "auto", outputFormat: "png" }, ...extra });
  const privateRecord = (id: string) => f.store.loadLockedProductionImagePreparation(principal.tenantId, "project-a", options.production ? "production" : "production-contract-fixture", id)!;
  return { ...f, config, configOptions, service, pricePort, select, privateRecord, registerAsset,
    allow: (v: unknown) => { allowed = v; }, policy: (v: unknown) => { policy = v; }, deny: (v: string) => denied.add(v) };
}
async function unchanged(f: ReturnType<typeof fixture>, action: () => unknown, expectCatalog = true) {
  const state = f.store.load(), catalog = f.store.loadCatalog(), count = f.store.productionImagePreparationCount(principal.tenantId, "project-a");
  await expect(Promise.resolve().then(action)).rejects.toThrow(); expect(f.store.load()).toEqual(state);
  if (expectCatalog) expect(f.store.loadCatalog()).toEqual(catalog);
  expect(f.store.productionImagePreparationCount(principal.tenantId, "project-a")).toBe(count);
}
describe("原锁区B实际准备前政策冻结；不是已确认/产物/发送许可", () => {
  it.each([new LockedProductionImagePreparations(), new LockedImageProductionPreparationHarness()])("默认关闭 %s", async service => {
    await expect(service.createPreparation(principal, null)).rejects.toMatchObject({ code: "locked_preparation_not_configured" });
    expect(() => service.getPreparation(principal, "project-a", "missing")).toThrow();
  });
  it.each(["openai", "openai-compatible"] as const)("%s 仅准备政策与原能力分开，不造协议/蒙版发送许可", async protocol => {
    const f = fixture({ protocol }), state = f.store.load(), r = await f.service.createPreparation(principal, f.select()), stored = f.privateRecord(r.id);
    expect(stored).toMatchObject({ schemaVersion: 2, mode: "production-contract-fixture", status: "unconfirmed", protocolPreparation: "not-run",
      protectionPolicy: { sourcePixelsSha256: expect.any(String), lockedPixels: 1, editablePixels: 1, normalizationVersion: "auto-orient-srgb-rgba8-v1" } });
    const context = f.pricePort.read.mock.calls[0][0]; expect(context.protectionPolicy).toEqual(stored.protectionPolicy);
    expect(imageSnapshotFingerprint({ connection: stored.connection, selection: stored.selection, requestDraft: stored.requestDraft, constraint: stored.constraint, protectionPolicy: stored.protectionPolicy })).toBe(stored.basisFingerprint);
    expect(f.store.load()).toEqual(state); expect(r).not.toHaveProperty("connection"); expect(r).not.toHaveProperty("requestDraft");
    expect(ProductionImagePreparationRecordSchema.safeParse(stored).success).toBe(false);
    await expect(prepareProductionImageProtocol(stored, productionExpected(stored as any), { jobId: `production-image-job-${randomUUID()}`,
      idempotencyKey: `production-image-execution-${randomUUID()}` }, [{ receipt: stored.protectionPolicy.source, body: source }, { receipt: stored.protectionPolicy.mask, body: mask }], at)).rejects.toThrow();
  });
  it("原生Google未支持绑定蒙版，声明不能让价格前预检通过", async () => {
    const f = fixture({ protocol: "google" }); await expect(f.service.createPreparation(principal, f.select())).rejects.toMatchObject({ code: "locked_preparation_unavailable" });
    expect(f.pricePort.read).not.toHaveBeenCalled(); expect(f.store.productionImagePreparationCount(principal.tenantId, "project-a")).toBe(0);
  });
  it.each([false, true])("从头production工厂自有假价格known/unknown %s，无实际请求", async manual => {
    const f = fixture({ production: true, manual }), r = await f.service.createPreparation(principal, f.select()), stored = f.privateRecord(r.id);
    expect(stored.mode).toBe("production"); expect(stored.pricing.quote).toMatchObject({ source: manual ? "manual-budget" : "server-price-table" });
    expect("estimatedCostMinor" in stored.pricing.quote).toBe(!manual); expect(r.realExecutionEnabled).toBe(false);
  });
  it("unknown zero-cap不推估价/实费0或预留", async () => {
    const f = fixture({ manual: true, cap: 0 }), before = f.store.load(), r = await f.service.createPreparation(principal, f.select());
    expect(f.privateRecord(r.id).pricing.quote).toMatchObject({ maxCostMinor: 0 }); expect(f.privateRecord(r.id).pricing.quote).not.toHaveProperty("estimatedCostMinor"); expect(f.store.load()).toEqual(before);
  });
  it.each(["provider:read", "asset:read", "run:read", "run:create"])("私有读取前独立权限%s", async permission => {
    const f = fixture(); f.deny(permission); const read = vi.spyOn(f.store, "loadLockedProductionImagePreparationByAction");
    await unchanged(f, () => f.service.createPreparation(principal, f.select())); expect(read).not.toHaveBeenCalled(); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it("不借confirm/execute/write/billing权限，read独立于create", async () => {
    const f = fixture(); ["run:confirm", "run:execute", "asset:write", "run:reconcile-billing"].forEach(f.deny);
    const r = await f.service.createPreparation(principal, f.select()); f.deny("run:create"); expect(f.service.getPreparation(principal, "project-a", r.id)).toEqual(r);
  });
  it("另获独立read权限的人只读，不改原准备人或价格scope", async () => {
    const f = fixture(), r = await f.service.createPreparation(principal, f.select()), original = f.privateRecord(r.id);
    const auth = { authenticate: () => ({ ...principal, actorId: "reviewer" }), allows: (p: typeof principal, project: string, permission: string) =>
      p.tenantId === principal.tenantId && p.actorId === "reviewer" && project === "project-a" && ["run:read", "provider:read", "asset:read"].includes(permission) };
    const reader = new LockedImageProductionPreparationHarness({ ...f.configOptions, authorizer: auth, runAuthorizer: auth, assetAuthorizer: auth });
    expect(reader.getPreparation({ ...principal, actorId: "reviewer" }, "project-a", r.id)).toEqual(r);
    await expect(reader.createPreparation({ ...principal, actorId: "reviewer" }, f.select())).rejects.toThrow();
    expect(f.privateRecord(r.id)).toEqual(original); expect(f.pricePort.read).toHaveBeenCalledTimes(1);
  });
  it.each([false, "true", 1, Promise.resolve(true)])("同步政策严格true %s", async value => {
    const f = fixture(); f.policy(value); await unchanged(f, () => f.service.createPreparation(principal, f.select())); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it.each([false, "true", 1, Promise.resolve(true)])("同步权限严格true %s", async value => {
    const f = fixture(); f.allow(value); await unchanged(f, () => f.service.createPreparation(principal, f.select())); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it.each([false, "true", 1, Promise.resolve(true)])("同步价格verify严格true %s", async value => {
    const f = fixture(); f.pricePort.verify.mockReturnValue(value); await unchanged(f, () => f.service.createPreparation(principal, f.select()));
  });
  it.each(["disabled", "wrong-store", "fixture-as-production", "wrong-tenant", "timeout"])("显式配置%s不能改标或跨库", async kind => {
    const f = fixture(); if (kind === "wrong-tenant") { await unchanged(f, () => f.service.createPreparation({ ...principal, tenantId: "other" }, f.select())); return; }
    const options: any = { ...f.configOptions };
    if (kind === "disabled") options.lockedPreparationEnabled = false;
    if (kind === "wrong-store") options.runKernel = { usesStateStore: () => false };
    if (kind === "timeout") options.timeoutMs = 30001;
    expect(() => kind === "fixture-as-production" ? new LockedProductionImagePreparations(options) : new LockedImageProductionPreparationHarness(options)).toThrow();
  });
  it.each(["generate", "none", "no-mask", "wrong-mask", "auto", "size", "unbound", "unlocked", "duplicate-region"])("原约束%s读取价格前拒绝", async kind => {
    const f = fixture(), s: any = f.select();
    if (kind === "generate") { s.operation = "generate"; s.inputAssetIds = []; delete s.maskAssetId; }
    if (kind === "none") s.protection = "none";
    if (kind === "no-mask") delete s.maskAssetId;
    if (kind === "wrong-mask") s.maskAssetId = "source";
    if (kind === "auto") s.parameters.size = "auto";
    if (kind === "size") s.parameters.size.width = 3;
    if (["unbound", "unlocked", "duplicate-region"].includes(kind)) f.store.transaction(() => { const c = f.store.loadCatalog()!, r = c.projects[0].constraints[0];
      if (kind === "unbound") r.editableRegions[0].maskAssetId = "other"; if (kind === "unlocked") r.lockedPaths = []; if (kind === "duplicate-region") r.editableRegions.push({ ...r.editableRegions[0] }); f.store.saveCatalog(c); });
    await unchanged(f, () => f.service.createPreparation(principal, s)); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it.each(["no-mask-capability", "unverified-polarity", "unsupported-format"])("不放宽供应商能力%s", async kind => {
    const f = fixture(), model: any = { ...f.config.models[0] };
    if (kind === "no-mask-capability") model.mask = { mode: "none", polarity: "unsupported" };
    if (kind === "unverified-polarity") model.mask = { mode: "prompt-guidance", polarity: "unverified" };
    if (kind === "unsupported-format") model.outputFormats = ["jpeg"];
    f.register(connection({ revision: 2, models: [model] })); await unchanged(f, () => f.service.createPreparation(principal, f.select({ connectionRevision: 2 }))); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it.each(["all-editable", "all-locked", "nonwhite-alpha"])("完整native蒙版%s不成为锁区政策", async kind => {
    const f = fixture({ mask: kind === "all-editable" ? allEditable : kind === "all-locked" ? allLocked : invalidMask });
    await unchanged(f, () => f.service.createPreparation(principal, f.select())); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it("原输入顺序与完整收据绑定，不只主源SHA", async () => {
    const f = fixture(); f.registerAsset("reference", source, "source"); const r = await f.service.createPreparation(principal, f.select({ inputAssetIds: ["source", "reference"] }));
    expect(f.privateRecord(r.id).protectionPolicy.inputAssetIds).toEqual(["source", "reference"]);
    expect(f.privateRecord(r.id).requestDraft.inputs.map(i => i.assetId)).toEqual(["source", "reference"]);
    await expect(f.service.createPreparation(principal, f.select({ inputAssetIds: ["reference", "source"] }))).rejects.toThrow();
  });
  it("总声明64MiB/单份30MiB在BLOB getter前阻断", async () => {
    const f = fixture(); f.store.transaction(() => { const c = f.store.loadCatalog()!; c.projects[0].assets[0].byteSize = 30 * 1024 * 1024 + 1; f.store.saveCatalog(c); });
    const read = vi.spyOn(f.store, "loadVerifiedImage"); await unchanged(f, () => f.service.createPreparation(principal, f.select())); expect(read).not.toHaveBeenCalled(); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it.each(["permission", "constraint", "connection", "budget", "clock", "source"])("价格端口后%s漂移整体回滚包括回调写入", async kind => {
    const f = fixture(), original = f.pricePort.read.getMockImplementation()!;
    f.pricePort.read.mockImplementation(c => { const price = original(c);
      if (kind === "permission") f.allow(false); if (kind === "clock") f.advance(-1); if (kind === "connection") f.register(connection({ revision: 2 }));
      if (["constraint", "source"].includes(kind)) f.store.transaction(() => { const catalog = f.store.loadCatalog()!;
        if (kind === "source") catalog.projects[0].assets[0].originalName = "changed"; else catalog.projects[0].constraints[0].brandRules.extra = "changed"; f.store.saveCatalog(catalog); });
      if (kind === "budget") f.store.transaction(() => { const state = f.store.load()!; state.budgets[0].limitMinor = 2000; f.store.save(state); }); return price; });
    await unchanged(f, () => f.service.createPreparation(principal, f.select()));
  });
  it("verify后撤权最终拒绝，深复制不能改原basis", async () => {
    const f = fixture(); f.pricePort.verify.mockImplementation((...args: any[]) => { args[0].protectionPolicy.lockedPixels = 500; f.allow(false); return true; });
    await unchanged(f, () => f.service.createPreparation(principal, f.select()));
  });
  it.each([1, 2])("每个实际SQL写后%s撤权回滚双表", async write => {
    const f = fixture(), save = f.store.saveLockedProductionImagePreparation.bind(f.store); let count = 0;
    vi.spyOn(f.store, "saveLockedProductionImagePreparation").mockImplementation((r, callback) => save(r, () => { if (++count === write) f.allow(false); callback(); }));
    await unchanged(f, () => f.service.createPreparation(principal, f.select())); expect(count).toBe(write);
  });
  it.each(["fault", "deadline", "constraint"])("写后%s整体回滚，不存半份政策", async kind => {
    const f = fixture(), save = f.store.saveLockedProductionImagePreparation.bind(f.store);
    vi.spyOn(f.store, "saveLockedProductionImagePreparation").mockImplementation((r, cb) => { save(r, cb); if (kind === "fault") throw Error("private-secret"); if (kind === "deadline") f.advance(5000);
      if (kind === "constraint") f.store.transaction(() => { const c = f.store.loadCatalog()!; c.projects[0].constraints[0].brandRules.drift = "changed"; f.store.saveCatalog(c); }); });
    await unchanged(f, () => f.service.createPreparation(principal, f.select()));
  });
  it("共享元数据容量满不删旧历史，SQL v8保持", async () => {
    const f = fixture({ quota: 1 }); await unchanged(f, () => f.service.createPreparation(principal, f.select())); const db = new DatabaseSync(f.path);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(8); db.close();
  });
  it("实际写后新增同库记录超共享容量，全部新行回滚", async () => {
    const f = fixture(), existing = await f.service.createPreparation(principal, f.select()), stored = f.privateRecord(existing.id), oldBytes = f.store.imageMetadataBytes(principal.tenantId, "project-a");
    const service = new LockedImageProductionPreparationHarness({ ...f.configOptions, maxMetadataBytes: oldBytes + Buffer.byteLength(JSON.stringify(stored)) + 200 });
    const save = f.store.saveLockedProductionImagePreparation.bind(f.store);
    vi.spyOn(f.store, "saveLockedProductionImagePreparation").mockImplementation((r, callback) => {
      const extra = structuredClone(r); extra.id = `locked-production-image-preparation-${randomUUID()}`; extra.selection.idempotencyKey = "owned-injected-action";
      extra.selectionFingerprint = imageSnapshotFingerprint(extra.selection);
      extra.basisFingerprint = imageSnapshotFingerprint({ connection: extra.connection, selection: extra.selection, requestDraft: extra.requestDraft, constraint: extra.constraint, protectionPolicy: extra.protectionPolicy });
      extra.pricing.scope.selectionFingerprint = extra.selectionFingerprint; extra.pricing.scope.basisFingerprint = extra.basisFingerprint;
      const { snapshotFingerprint: _fp, ...rest } = extra; extra.snapshotFingerprint = imageSnapshotFingerprint(rest);
      save(extra, () => undefined); save(r, callback);
    });
    await unchanged(f, () => service.createPreparation(principal, f.select({ idempotencyKey: "owned-next-action" })));
    expect(f.store.imageMetadataBytes(principal.tenantId, "project-a")).toBe(oldBytes); expect(f.service.getPreparation(principal, "project-a", existing.id)).toEqual(existing);
  });
  it.each(["scope", "currency", "future", "expiry", "kind", "async"])("可信价格%s不是source/schema许可", async kind => {
    const f = fixture(), read = f.pricePort.read.getMockImplementation()!;
    f.pricePort.read.mockImplementation(c => { const price: any = read(c);
      if (kind === "scope") price.scope.basisFingerprint = "0".repeat(64);
      if (kind === "currency") price.quote.currency = "USD";
      if (kind === "future") price.evidence.checkedAt = new Date(f.clock() + 1).toISOString();
      if (kind === "expiry") price.quote.expiresAt = at;
      if (kind === "kind") price.evidence.kind = "server-verified-price";
      return kind === "async" ? Promise.resolve(price) : price; });
    await unchanged(f, () => f.service.createPreparation(principal, f.select()));
  });
  it("价格上下文改写不影响冻结完整政策或原输入", async () => {
    const f = fixture(), read = f.pricePort.read.getMockImplementation()!;
    f.pricePort.read.mockImplementation(c => { const price = read(c); c.protectionPolicy.sourcePixelsSha256 = "0".repeat(64); c.constraint.brandRules.style = "wrong"; return price; });
    const r = await f.service.createPreparation(principal, f.select()); expect(f.privateRecord(r.id).protectionPolicy.sourcePixelsSha256).not.toBe("0".repeat(64));
    expect(f.privateRecord(r.id).constraint.brandRules.style).toBe("人工冻结构图");
  });
  it.each(["receipt", "input", "constraint", "permission"])("已保存历史当前%s异常只读拒绝，不删副本或重价格", async kind => {
    const f = fixture(), r = await f.service.createPreparation(principal, f.select());
    if (kind === "permission") f.deny("asset:read");
    else if (kind === "receipt") { const db = new DatabaseSync(f.path); db.exec("UPDATE verified_images SET record_sha256 = 'broken' WHERE asset_id = 'mask'"); db.close(); }
    else f.store.transaction(() => { const c = f.store.loadCatalog()!; if (kind === "input") c.projects[0].assets[0].originalName = "wrong";
      else c.projects[0].constraints[0].brandRules.style = "wrong"; f.store.saveCatalog(c); });
    const state = f.store.load(), bytes = f.store.imageMetadataBytes(principal.tenantId, "project-a"); expect(() => f.service.getPreparation(principal, "project-a", r.id)).toThrow();
    expect(f.store.load()).toEqual(state); expect(f.store.imageMetadataBytes(principal.tenantId, "project-a")).toBe(bytes); expect(f.pricePort.read).toHaveBeenCalledTimes(1);
  });
  it("native await撤权不落库，副本清零，调用者原图不改", async () => {
    const f = fixture(), native = decoder.decodeStaticImagePixels; let resume!: (v: Awaited<ReturnType<typeof native>>) => void;
    vi.spyOn(decoder, "decodeStaticImagePixels").mockImplementationOnce(() => new Promise(r => { resume = r; }));
    const work = f.service.createPreparation(principal, f.select()); f.allow(false); const decoded = await native(source, "image/png"); resume(decoded);
    await expect(work).rejects.toThrow(); expect(decoded.pixels.every(v => v === 0)).toBe(true); expect(f.store.productionImagePreparationCount(principal.tenantId, "project-a")).toBe(0); expect(source[0]).toBe(137);
  });
  it("正常毫秒时钟推进通过；输入/操作者首await前冻结", async () => {
    const f = fixture(), native = decoder.decodeStaticImagePixels; let resume!: (v: Awaited<ReturnType<typeof native>>) => void;
    vi.spyOn(decoder, "decodeStaticImagePixels").mockImplementationOnce(() => new Promise(r => { resume = r; }));
    const s = f.select(), p = { ...principal }, work = f.service.createPreparation(p, s); s.parameters.prompt = "changed after await"; p.actorId = "other"; f.advance(1); resume(await native(source, "image/png"));
    const r = await work; expect(f.privateRecord(r.id).selection.parameters.prompt).toBe("原人工锁区指令"); expect(f.privateRecord(r.id).createdBy).toBe(principal.actorId);
  });
  it("取消非合作native仍占两槽，迟到不提交", async () => {
    const f = fixture(), native = decoder.decodeStaticImagePixels, deferred: ((v: Awaited<ReturnType<typeof native>>) => void)[] = [];
    vi.spyOn(decoder, "decodeStaticImagePixels").mockImplementation(() => new Promise(r => deferred.push(r)));
    const controllers = [new AbortController(), new AbortController()], jobs = controllers.map((c, i) => f.service.createPreparation(principal, f.select({ idempotencyKey: `action-${i}` }), { signal: c.signal }));
    controllers.forEach(c => c.abort()); await Promise.all(jobs.map(job => expect(job).rejects.toThrow()));
    await expect(f.service.createPreparation(principal, f.select())).rejects.toMatchObject({ code: "locked_preparation_busy" });
    for (const resume of deferred) resume(await native(source, "image/png")); await new Promise(r => setTimeout(r, 0));
    expect(f.store.productionImagePreparationCount(principal.tenantId, "project-a")).toBe(0);
  });
  it("并发同动作只保存/询价一次；历史过期停用重启不native/price", async () => {
    const f = fixture(), results = await Promise.all([f.service.createPreparation(principal, f.select()), f.service.createPreparation(principal, f.select())]);
    expect(results[0]).toEqual(results[1]); expect(f.pricePort.read).toHaveBeenCalledTimes(1); expect(f.store.productionImagePreparationCount(principal.tenantId, "project-a")).toBe(1);
    f.advance(70_000); f.register(connection({ revision: 2, enabled: false })); const native = vi.spyOn(decoder, "decodeStaticImagePixels"), save = vi.spyOn(f.store, "saveLockedProductionImagePreparation");
    expect(f.service.getPreparation(principal, "project-a", results[0].id)).toEqual(results[0]); expect(await f.service.createPreparation(principal, f.select())).toEqual(results[0]);
    const other = setupImageTask({ path: f.path }); owned.push(other); const second = new LockedImageProductionPreparationHarness({ ...f.configOptions, stateStore: other.store, runKernel: other.kernel });
    expect(second.getPreparation(principal, "project-a", results[0].id)).toEqual(results[0]); expect(await second.createPreparation(principal, f.select())).toEqual(results[0]);
    expect(native).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(f.pricePort.read).toHaveBeenCalledTimes(1); expect(f.pricePort.verify).toHaveBeenCalledTimes(1);
  });
  it.each(["deleted-policy", "deleted-record", "deleted-marker", "unknown-version", "partial-rehash"])("恢复损坏%s不能补政策/重新询价", async kind => {
    const f = fixture(), r = await f.service.createPreparation(principal, f.select()), db = new DatabaseSync(f.path);
    if (kind === "deleted-record") db.exec("DELETE FROM production_image_preparations"); else if (kind === "deleted-marker") db.exec("DELETE FROM production_image_preparation_presence");
    else { const stored: any = f.privateRecord(r.id); if (kind === "deleted-policy") delete stored.protectionPolicy;
      if (kind === "unknown-version") stored.protectionPolicy.policyVersion = "future-v2";
      if (kind === "partial-rehash") { stored.protectionPolicy.sourcePixelsSha256 = "0".repeat(64); const { snapshotFingerprint: _sha, ...rest } = stored; stored.snapshotFingerprint = imageSnapshotFingerprint(rest); }
      const payload = JSON.stringify(stored); db.prepare("UPDATE production_image_preparations SET record = ?, record_sha256 = ?").run(payload, sha(Buffer.from(payload))); }
    db.close(); expect(() => f.service.getPreparation(principal, "project-a", r.id)).toThrow(); await expect(f.service.createPreparation(principal, f.select())).rejects.toThrow(); expect(f.pricePort.read).toHaveBeenCalledTimes(1);
  });
  it("旧准备/确认/协议不能借v2或schema/SHA作许可", async () => {
    const f = fixture(), r = await f.service.createPreparation(principal, f.select()), stored = f.privateRecord(r.id), old = new ImageProductionPreparationHarness({ ...f.configOptions, pricePort: f.pricePort as any });
    expect(() => old.getPreparation(principal, "project-a", r.id)).toThrow(); await expect(old.confirmPreparation(principal, "project-a", r.id, {})).rejects.toThrow();
    expect(() => validateProductionImageProviderRequest(stored.connection, { ...stored.requestDraft, jobId: "untrusted", idempotencyKey: "untrusted", quote: stored.pricing.quote }, at)).toThrow();
    expect(LockedProductionImagePreparationRecordSchema.safeParse({ ...stored, schemaVersion: 1 }).success).toBe(false);
    expect(LockedProductionImagePreparationRecordSchema.safeParse({ ...stored, mode: "production" }).success).toBe(false);
  });
  it("不同实际SQLite连接并发同动作，最终事务仅一份政策/价格", async () => {
    const f = fixture(), other = setupImageTask({ path: f.path }); owned.push(other);
    const second = new LockedImageProductionPreparationHarness({ ...f.configOptions, stateStore: other.store, runKernel: other.kernel });
    const [a, b] = await Promise.all([f.service.createPreparation(principal, f.select()), second.createPreparation(principal, f.select())]);
    expect(a).toEqual(b); expect(f.pricePort.read).toHaveBeenCalledTimes(1); expect(f.store.productionImagePreparationCount(principal.tenantId, "project-a")).toBe(1);
  });
});
