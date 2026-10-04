import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { ProductionImageQuoteSchema, ProductionImagePreparationRecordSchema, ImagePreparationRecordSchema, ConfirmedImageExecutionSchema } from "../packages/contracts/src/index";
import { ImageProductionPreparationHarness, ProductionImagePreparations, type ImagePriceContext } from "../apps/api/src/productionImagePreparations";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { imageSnapshotFingerprint } from "../apps/api/src/imageProviderContract";
import { at, connection, principal, setupImageTask } from "./helpers/image-task-fixture";

const owned: ReturnType<typeof setupImageTask>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const fixture of owned.splice(0).reverse()) fixture.cleanup(); });
const selection = (extra: Record<string, unknown> = {}) => ({ projectId: "project-a", idempotencyKey: "owned-production-action", connectionId: "fixture-provider", connectionRevision: 1,
  model: "explicit-fixture-model", capabilityVersion: "caps-fixture-v1", constraintSnapshotId: "constraint-a", protection: "none", operation: "generate", inputAssetIds: [],
  parameters: { prompt: "人工冻结，不询价不生成", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", background: "auto", outputFormat: "png" }, ...extra });
function fixture(options: { manual?: boolean; maxMetadataBytes?: number; mutate?: (pricing: any, context: ImagePriceContext, f: ReturnType<typeof setupImageTask>) => unknown; verify?: (context: ImagePriceContext, pricing: any) => unknown } = {}) {
  const f = setupImageTask(); owned.push(f); f.register();
  let allowed: unknown = true;
  const permission = (p: typeof principal, id: string) => p.tenantId === principal.tenantId && p.actorId === principal.actorId && id === "project-a" ? allowed as boolean : false;
  const authorizer = { authenticate: () => principal, allows: permission };
  const pricePort = { kind: "contract-fixture" as const, realExecutionEnabled: false as const,
    read: vi.fn((context: ImagePriceContext) => {
      const pricing = { schemaVersion: 1, scope: context.scope, quote: { id: "owned-fake-price", version: "fake-v1",
        source: options.manual ? "manual-budget" : "server-price-table", currency: "CNY", maxCostMinor: 40,
        ...(options.manual ? {} : { estimatedCostMinor: 25 }), expiresAt: new Date(f.clock() + 60_000).toISOString() },
        evidence: { kind: "contract-fixture", realExecutionEnabled: false, sourceRevision: "owned-fake-table-v1", evidenceRef: "owned-zero-cost-proof", checkedBy: "owned-oracle", checkedAt: context.requestedAt } };
      return options.mutate ? options.mutate(pricing, context, f) : pricing;
    }), verify: vi.fn((context: ImagePriceContext, pricing: unknown) => options.verify ? options.verify(context, pricing) as boolean : true) };
  const config = { preparationEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, authorizer, runAuthorizer: authorizer, assetAuthorizer: authorizer,
    pricePort, clock: f.clock, maxMetadataBytes: options.maxMetadataBytes };
  const service = new ImageProductionPreparationHarness(config);
  return { ...f, service, config, pricePort, allow: (value: unknown) => { allowed = value; } };
}
function unchanged(f: ReturnType<typeof fixture>, callback: () => unknown) {
  const snapshot = f.store.load(), catalog = f.store.loadCatalog(), bytes = f.store.imageMetadataBytes(principal.tenantId, "project-a");
  expect(callback).toThrow();
  expect(f.store.productionImagePreparationCount(principal.tenantId, "project-a")).toBe(0);
  expect(f.store.load()).toEqual(snapshot); expect(f.store.loadCatalog()).toEqual(catalog);
  expect(f.store.imageMetadataBytes(principal.tenantId, "project-a")).toBe(bytes);
}
describe("6D1 independent production preparation / pricing contract", () => {
  it.each([new ProductionImagePreparations(), new ImageProductionPreparationHarness()])("无配置先失败关闭且无存储访问 %s", (service) => {
    expect(() => service.createPreparation(principal, null)).toThrow(expect.objectContaining({ code: "production_image_preparation_not_configured" }));
    expect(() => service.getPreparation(principal, "project-a", "id")).toThrow(expect.objectContaining({ code: "production_image_preparation_not_configured" }));
  });
  it("production 不接受假端口，夹具也不接受server标记或执行开关", () => {
    const f = fixture();
    expect(() => new ProductionImagePreparations(f.config as any)).toThrow();
    expect(() => new ImageProductionPreparationHarness({ ...f.config, pricePort: { ...f.pricePort, kind: "server-pricing" } } as any)).toThrow();
    expect(() => new ImageProductionPreparationHarness({ ...f.config, pricePort: { ...f.pricePort, realExecutionEnabled: true } } as any)).toThrow();
    expect(() => new ImageProductionPreparationHarness({ ...f.config, preparationEnabled: false } as any)).toThrow();
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s 独立假准备不预留/创建任务、不包含wire或执行key", (protocol) => {
    const f = fixture();
    f.register(connection({ revision: 2, protocol,
      ...(protocol === "openai-compatible" ? { compatibility: { version: "owned-compat", editEncoding: "json-images", responseEncoding: "images-b64-json-v1", auth: { scheme: "bearer" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}),
      ...(protocol === "google" ? { googleNative: { version: "owned-google", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: "explicit-fixture-model", sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] } } : {}) }));
    const before = f.store.load(); const result = f.service.createPreparation(principal, selection({ connectionRevision: 2 }));
    expect(result).toMatchObject({ mode: "production-contract-fixture", status: "unconfirmed", executionAuthorized: false, realExecutionEnabled: false, protocolPreparation: "not-run" });
    expect(f.store.load()).toEqual(before); expect(f.pricePort.read).toHaveBeenCalledTimes(1);
    expect(result.connection).not.toHaveProperty("baseUrl"); expect(result.connection).not.toHaveProperty("credentialRef");
    for (const key of ["quote", "jobId", "idempotencyKey", "payloadChecksumSha256"]) expect(result.requestDraft).not.toHaveProperty(key);
    expect(result.pricing.scope.basisFingerprint).toBe(result.basisFingerprint);
  });
  it("人工预算只有上限，无估价，不把0或上限当核验单价", () => {
    const f = fixture({ manual: true }), result = f.service.createPreparation(principal, selection());
    expect(result.pricing.quote).toMatchObject({ source: "manual-budget", maxCostMinor: 40 });
    expect(result.pricing.quote).not.toHaveProperty("estimatedCostMinor");
  });
  it.each([0, 25, 40, undefined, null])("manual-budget 禁止estimatedCostMinor字段 %s", (estimatedCostMinor) => {
    const quote = { id: "cap", version: "v1", source: "manual-budget", currency: "CNY", maxCostMinor: 40, expiresAt: at, estimatedCostMinor };
    expect(ProductionImageQuoteSchema.safeParse(quote).success).toBe(false);
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, 41])("估价无效或大于上限 %s", (amount) => {
    const f = fixture({ mutate: (p) => ({ ...p, quote: { ...p.quote, estimatedCostMinor: amount } }) }); unchanged(f, () => f.service.createPreparation(principal, selection()));
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("上限非安全整数 %s", (amount) => {
    const f = fixture({ mutate: (p) => ({ ...p, quote: { ...p.quote, maxCostMinor: amount } }) }); unchanged(f, () => f.service.createPreparation(principal, selection()));
  });
  it.each(["tenantId", "projectId", "actorId", "connectionId", "connectionRevision", "model", "capabilityVersion", "operation", "basisFingerprint", "selectionFingerprint"])("报价绑定漂移 %s", (key) => {
    const f = fixture({ mutate: (p) => ({ ...p, scope: { ...p.scope, [key]: key === "connectionRevision" ? 2 : key.endsWith("Fingerprint") ? "0".repeat(64) : key === "operation" ? "edit" : "wrong" } }) });
    unchanged(f, () => f.service.createPreparation(principal, selection()));
  });
  it.each([false, "true", 1, Promise.resolve(true)])("verify必须同步严格true %s", (value) => {
    const f = fixture({ verify: () => value }); unchanged(f, () => f.service.createPreparation(principal, selection()));
  });
  it.each([false, "true", 1, Promise.resolve(true)])("权限必须同步严格true并在读私库前拒绝 %s", (value) => {
    const f = fixture(); f.allow(value); const read = vi.spyOn(f.store, "loadProductionImagePreparationByAction");
    unchanged(f, () => f.service.createPreparation(principal, selection())); expect(read).not.toHaveBeenCalled(); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it("价格read Promise拒绝并消化拒绝，不改预算", async () => {
    const f = fixture(); f.pricePort.read.mockImplementation(() => Promise.reject(new Error("private-value")));
    unchanged(f, () => f.service.createPreparation(principal, selection())); await Promise.resolve();
  });
  it.each(["expired", "future-checked", "old-checked", "currency", "fake-kind", "real-enabled"])("价格时间/币种/依据不正确 %s", (kind) => {
    const f = fixture({ mutate: (p) => {
      if (kind === "expired") p.quote.expiresAt = at;
      if (kind === "future-checked") p.evidence.checkedAt = new Date(Date.parse(at) + 1000).toISOString();
      if (kind === "old-checked") p.evidence.checkedAt = new Date(Date.parse(at) - 1000).toISOString();
      if (kind === "currency") p.quote.currency = "USD";
      if (kind === "fake-kind") p.evidence.kind = "server-verified-price";
      if (kind === "real-enabled") p.evidence.realExecutionEnabled = true;
      return p;
    } }); unchanged(f, () => f.service.createPreparation(principal, selection()));
  });
  it("source字符串和完整字段不替代可信verify决策", () => {
    const f = fixture({ verify: () => false }); unchanged(f, () => f.service.createPreparation(principal, selection())); expect(f.pricePort.verify).toHaveBeenCalledTimes(1);
  });
  it("生产合同拒绝夹具证据，即便将端口kind改名", () => {
    const f = fixture(); const service = new ProductionImagePreparations({ ...f.config, pricePort: { ...f.pricePort, kind: "server-pricing" } });
    unchanged(f, () => service.createPreparation(principal, selection()));
  });
  it.each(["connection", "constraint", "permission", "expiration"])("可信回调内漂移%s在提交前拒绝并回滚", (kind) => {
    const f = fixture({ mutate: (p, _context, task) => {
      if (kind === "connection") task.register(connection({ revision: 2 }));
      if (kind === "constraint") task.store.transaction(() => { const c = task.store.loadCatalog()!; c.projects[0].constraints[0].brandRules.changed = "no"; task.store.saveCatalog(c); });
      if (kind === "permission") f.allow(false);
      if (kind === "expiration") { p.quote.expiresAt = new Date(task.clock() + 1000).toISOString(); task.advance(1000); }
      return p;
    } }); unchanged(f, () => f.service.createPreparation(principal, selection()));
  });
  it("verify完成后再次检查撤权", () => {
    const f = fixture({ verify: () => { f.allow(false); return true; } }); unchanged(f, () => f.service.createPreparation(principal, selection()));
  });
  it("保存后最后撤权回滚记录和存在标记", () => {
    const f = fixture(), original = f.store.saveProductionImagePreparation.bind(f.store);
    vi.spyOn(f.store, "saveProductionImagePreparation").mockImplementation((r) => { original(r); f.allow(false); });
    unchanged(f, () => f.service.createPreparation(principal, selection()));
  });
  it("记录写后故障同事务回滚且固定异常不泄密", () => {
    const f = fixture(), original = f.store.saveProductionImagePreparation.bind(f.store);
    vi.spyOn(f.store, "saveProductionImagePreparation").mockImplementation((r) => { original(r); throw new Error("private-key-value"); });
    unchanged(f, () => f.service.createPreparation(principal, selection()));
    expect(() => f.service.createPreparation(principal, selection())).toThrow(expect.objectContaining({ code: "production_image_preparation_unavailable" }));
  });
  it.each(["pixel-exact", "product.pixels", "auto", "4096-square", "unverified-input"])("静态政策%s在询价前拒绝", (kind) => {
    const f = fixture(); const s: any = selection();
    if (kind === "pixel-exact") s.protection = "pixel-exact";
    if (kind === "auto") s.parameters.size = "auto";
    if (kind === "product.pixels" || kind === "4096-square") f.store.transaction(() => {
      const c = f.store.loadCatalog()!; if (kind === "product.pixels") c.projects[0].constraints[0].lockedPaths = ["product.pixels"];
      else { c.projects[0].constraints[0].outputSpec.width = 4096; c.projects[0].constraints[0].outputSpec.height = 4096; s.parameters.size = { width: 4096, height: 4096 }; }
      f.store.saveCatalog(c);
    });
    if (kind === "unverified-input") { s.operation = "edit"; s.inputAssetIds = ["non-existent"]; }
    unchanged(f, () => f.service.createPreparation(principal, s)); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it("冻结权威编辑输入顺序、SHA尺寸以及完整人工约束", () => {
    const f = fixture(); f.source("one"); f.source("two");
    const r = f.service.createPreparation(principal, selection({ operation: "edit", inputAssetIds: ["two", "one"] }));
    expect(r.requestDraft.inputs.map((i) => i.assetId)).toEqual(["two", "one"]);
    expect(r.requestDraft.inputs[0]).toMatchObject({ checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/), width: 1, height: 1 });
    expect(r.constraint.brandRules).toEqual({ style: "人工冻结构图" }); expect(r.requestDraft.constraintChecksumSha256).toBe(createHash("sha256").update(JSON.stringify(r.constraint)).digest("hex"));
  });
  it("同动作一致重放/过期历史/目录停用只恢复原快照不重报价", () => {
    const f = fixture(), r = f.service.createPreparation(principal, selection()); f.advance(70_000); f.register(connection({ revision: 2, enabled: false }));
    expect(f.service.createPreparation(principal, selection())).toEqual(r); expect(f.service.getPreparation(principal, "project-a", r.id)).toEqual(r);
    expect(f.pricePort.read).toHaveBeenCalledTimes(1); expect(f.pricePort.verify).toHaveBeenCalledTimes(1);
    expect(() => f.service.createPreparation(principal, selection({ parameters: { ...selection().parameters, prompt: "changed" } }))).toThrow(expect.objectContaining({ code: "production_image_idempotency_conflict" }));
  });
  it("跨连接重启一致恢复，原准备单不被local确认/生产mode冒充", () => {
    const f = fixture(), r = f.service.createPreparation(principal, selection());
    const other = setupImageTask({ path: f.path }); owned.push(other);
    const restored = new ImageProductionPreparationHarness({ ...f.config, stateStore: other.store }); expect(restored.getPreparation(principal, "project-a", r.id)).toEqual(r);
    const privateRecord = f.store.loadProductionImagePreparation(principal.tenantId, "project-a", "production-contract-fixture", r.id)!;
    expect(ProductionImagePreparationRecordSchema.safeParse({ ...privateRecord, mode: "production" }).success).toBe(false);
    expect(ImagePreparationRecordSchema.safeParse(privateRecord).success).toBe(false);
    expect(ConfirmedImageExecutionSchema.safeParse(privateRecord).success).toBe(false);
    expect(f.store.loadImagePreparation(principal.tenantId, "project-a", r.id)).toBeNull();
    expect(f.config.stateStore.load()).not.toBeNull();
  });
  it("相同local动作编号保持独立，不借用local准备/预留", () => {
    const f = fixture(); const legacy = owned[0].service.createPreparation(principal, selection()); const before = f.store.load();
    const r = f.service.createPreparation(principal, selection()); expect(r.id).not.toBe(legacy.id); expect(f.store.load()).toEqual(before);
    expect(f.store.imagePreparationCount(principal.tenantId, "project-a")).toBe(1); expect(f.store.productionImagePreparationCount(principal.tenantId, "project-a")).toBe(1);
  });
  it.each(["wrong-project", "wrong-tenant", "denied"])("历史读取%s失败关闭", (kind) => {
    const f = fixture(), r = f.service.createPreparation(principal, selection()); if (kind === "denied") f.allow(false);
    expect(() => f.service.getPreparation(kind === "wrong-tenant" ? { ...principal, tenantId: "other" } : principal, kind === "wrong-project" ? "other" : "project-a", r.id)).toThrow();
  });
  it.each(["checksum", "deleted-record", "deleted-marker", "wrong-basis"])("持久化损坏%s不能恢复或同幂等重新创建", (kind) => {
    const f = fixture(), r = f.service.createPreparation(principal, selection()), db = new DatabaseSync(f.path);
    if (kind === "checksum") db.exec("UPDATE production_image_preparations SET record_sha256 = 'broken'");
    if (kind === "deleted-record") db.exec("DELETE FROM production_image_preparations");
    if (kind === "deleted-marker") db.exec("DELETE FROM production_image_preparation_presence");
    if (kind === "wrong-basis") {
      const raw = db.prepare("SELECT record FROM production_image_preparations").get()!.record as string, record = JSON.parse(raw); record.basisFingerprint = "0".repeat(64);
      record.pricing.scope.basisFingerprint = record.basisFingerprint; const { snapshotFingerprint: _hash, ...rest } = record; record.snapshotFingerprint = imageSnapshotFingerprint(rest);
      const payload = JSON.stringify(record); db.prepare("UPDATE production_image_preparations SET record = ?, record_sha256 = ?").run(payload, createHash("sha256").update(payload).digest("hex"));
    }
    db.close(); expect(() => f.service.getPreparation(principal, "project-a", r.id)).toThrow(); expect(() => f.service.createPreparation(principal, selection())).toThrow(); expect(f.pricePort.read).toHaveBeenCalledTimes(1);
  });
  it("逻辑共享容量计入生产准备，不删除历史腾空间", () => {
    const f = fixture({ maxMetadataBytes: 1 }); unchanged(f, () => f.service.createPreparation(principal, selection()));
  });
  it("单份512KiB准备限制并回滚", () => {
    const f = fixture(); f.store.transaction(() => { const c = f.store.loadCatalog()!; c.projects[0].constraints[0].brandRules.huge = "x".repeat(512 * 1024); f.store.saveCatalog(c); });
    unchanged(f, () => f.service.createPreparation(principal, selection()));
  });
  it("生产价格依据与人工上限的kind严格区分", () => {
    const f = fixture({ manual: true });
    const r = f.service.createPreparation(principal, selection()), privateRecord = f.store.loadProductionImagePreparation(principal.tenantId, "project-a", "production-contract-fixture", r.id)!;
    const { realExecutionEnabled: _fixtureOnly, ...evidence } = privateRecord.pricing.evidence;
    expect(ProductionImagePreparationRecordSchema.safeParse({ ...privateRecord, mode: "production", pricing: { ...privateRecord.pricing, evidence: { ...evidence, kind: "server-verified-price" } } }).success).toBe(false);
    // Shape validation is not server price verification or production enablement.
    expect(ProductionImagePreparationRecordSchema.safeParse({ ...privateRecord, mode: "production", pricing: { ...privateRecord.pricing, evidence: { ...evidence, kind: "server-approved-budget" } } }).success).toBe(true);
  });
  it("价格证据引用不能带下载URL/查询凭证", () => {
    const f = fixture({ mutate: (p) => ({ ...p, evidence: { ...p.evidence, evidenceRef: "https://private.invalid/?token=secret" } }) });
    unchanged(f, () => f.service.createPreparation(principal, selection()));
  });
  it("原图权威元数据在价格回调内漂移后拒绝", () => {
    const f = fixture({ mutate: (p, _c, task) => { task.store.transaction(() => {
      const catalog = task.store.loadCatalog()!; catalog.projects[0].assets[0].originalName = "changed.png"; task.store.saveCatalog(catalog);
    }); return p; } }); f.source(); unchanged(f, () => f.service.createPreparation(principal, selection({ operation: "edit", inputAssetIds: ["source"] })));
  });
  it("上限不是可花预算，准备不扩大或消耗预算", () => {
    const f = fixture({ manual: true, mutate: (p) => ({ ...p, quote: { ...p.quote, maxCostMinor: 2000 } }) }), before = f.store.load();
    const r = f.service.createPreparation(principal, selection()); expect(r.pricing.quote.maxCostMinor).toBe(2000); expect(f.store.load()).toEqual(before);
  });
  it("目录满拒绝，历史可读而不删除记录腾空间", () => {
    const f = fixture(), r = f.service.createPreparation(principal, selection()), db = new DatabaseSync(f.path);
    const insert = db.prepare("INSERT INTO production_image_preparation_presence(tenant_id, project_id, mode, id, action_key) VALUES (?, ?, ?, ?, ?)");
    db.exec("BEGIN"); for (let index = 1; index < 1000; index++) insert.run(principal.tenantId, "project-a", "production-contract-fixture", `owned-${index}`, `owned-${index}`); db.exec("COMMIT"); db.close();
    expect(() => f.service.createPreparation(principal, selection({ idempotencyKey: "new-action" }))).toThrow(expect.objectContaining({ code: "production_image_preparation_catalog_full" }));
    expect(f.service.getPreparation(principal, "project-a", r.id)).toEqual(r); expect(f.store.productionImagePreparationCount(principal.tenantId, "project-a")).toBe(1000);
  });
  it("跨SQLite实例同动作恢复一个编号，不重新询价", () => {
    const f = fixture(), other = setupImageTask({ path: f.path }); owned.push(other);
    const second = new ImageProductionPreparationHarness({ ...f.config, stateStore: other.store }), first = f.service.createPreparation(principal, selection());
    expect(second.createPreparation(principal, selection())).toEqual(first); expect(f.pricePort.read).toHaveBeenCalledTimes(1);
  });
  it("保存后越过报价期最终回滚", () => {
    const f = fixture(), save = f.store.saveProductionImagePreparation.bind(f.store);
    vi.spyOn(f.store, "saveProductionImagePreparation").mockImplementation((r) => { save(r); f.advance(60_000); });
    unchanged(f, () => f.service.createPreparation(principal, selection()));
  });
  it("v5增量迁移原图/local确认预算与目录保持不变", async () => {
    const f = fixture(); f.source(); await owned[0].confirm(); const snapshot = f.store.load(), catalog = f.store.loadCatalog();
    const db = new DatabaseSync(f.path); db.exec("DROP TABLE production_image_preparations; DROP TABLE production_image_preparation_presence; PRAGMA user_version = 5"); db.close();
    const other = setupImageTask({ path: f.path }); owned.push(other); expect(other.store.load()).toEqual(snapshot); expect(other.store.loadCatalog()).toEqual(catalog);
    expect(other.store.loadVerifiedImage(principal.tenantId, "project-a", "source")).toBeDefined(); expect(other.store.loadImagePreparationByAction(principal.tenantId, "project-a", "human-action-a")).not.toBeNull();
    const version = new DatabaseSync(f.path); expect(version.prepare("PRAGMA user_version").get()!.user_version).toBe(6); version.close();
  });
  it.each(["production_image_preparations", "production_image_preparation_presence"])("v6缺表%s不静默重建", (table) => {
    const f = fixture(), db = new DatabaseSync(f.path); db.exec(`DROP TABLE ${table}`); db.close();
    expect(() => new SqliteRunKernelStateStore(f.path)).toThrow();
    const check = new DatabaseSync(f.path); expect(check.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(table)).toBeUndefined(); check.close();
  });
});
