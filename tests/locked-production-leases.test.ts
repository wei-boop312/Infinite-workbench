import { createLockedProductionImageLeaseFixturePolicy, createLockedProductionImageLeasePolicy, type LockedProductionImageLeasePolicy } from "../apps/api/src/lockedProductionImageLeasePolicy";
import type { RunKernelOptions } from "../apps/api/src/runKernel";
import { createRequire } from "node:module";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
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
const children: ChildProcess[] = [];
beforeAll(async () => { const png = (p: number[]) => sharp(Buffer.from(p), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  source = await png([10,20,30,255,40,50,60,255]); mask = await png([0,0,0,0,255,255,255,255]); });
afterEach(() => { vi.restoreAllMocks(); children.splice(0).forEach(c => { if (c.exitCode === null) c.kill(); }); connections.splice(0).forEach(c => c.close()); owned.splice(0).forEach(f => f.cleanup()); });
function fixture(opts: { manual?: boolean; cap?: number; protocol?: "openai" | "openai-compatible"; encoding?: "json-images" | "multipart-image-array" | "multipart-image-single"; production?: boolean; timeout?: number; enabled?: boolean; lease?: boolean; quota?: number; kernel?: Partial<RunKernelOptions> } = {}) {
  let service: LockedImageProductionPreparationHarness | LockedProductionImagePreparations;
  let leasePolicy: LockedProductionImageLeasePolicy, leaseAllowed: unknown = true;
  const leaseGate: LockedProductionImageLeasePolicy = { usesStateStore: s => leasePolicy.usesStateStore(s), authorizeScope: (p, project, purpose) => leasePolicy.authorizeScope(p, project, purpose),
    validate: (p, e, purpose, bytes) => leasePolicy.validate(p, e, purpose, bytes) };
  const f = setupImageTask({ productionResponses: true, productionArtifacts: true,
    kernel: { validateLockedProductionImageConfirmation: (p, e) => service.authorizeConfirmation(p, e), ...(opts.lease === false ? {} : { lockedProductionImageLeasePolicy: leaseGate }), ...opts.kernel } }); owned.push(f);
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
  const leaseOptions = { lockedLeaseEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, pricePort: pricePort as any,
    runAuthorizer: authorizer, providerAuthorizer: authorizer, assetAuthorizer: authorizer, clock: f.clock, maxMetadataBytes: opts.quota,
    lockedLeasePolicy: () => leaseAllowed as boolean };
  leasePolicy = opts.production ? createLockedProductionImageLeasePolicy(leaseOptions) : createLockedProductionImageLeaseFixturePolicy(leaseOptions);
  const select = (action = "locked-owned") => ({ projectId: "project-a", idempotencyKey: action, connectionId: config.id, connectionRevision: 1, model: config.models[0].model,
    capabilityVersion: config.models[0].version, constraintSnapshotId: "constraint-a", operation: "edit", inputAssetIds: ["source"], maskAssetId: "mask", protection: "pixel-exact",
    parameters: { prompt: "原人工锁区指令", n: 1, size: { width: 2, height: 1 }, quality: "auto", background: "auto", outputFormat: "png" } });
  const prepare = async (action = "locked-owned") => { const v = await service.createPreparation(principal, select(action)); return f.store.loadLockedProductionImagePreparation(principal.tenantId, "project-a", v.mode, v.id)!; };
  const confirm = (p: Awaited<ReturnType<typeof prepare>>, actor = principal, expected: unknown = lockedExpected(p), signal?: AbortSignal) => service.confirmPreparation(actor, "project-a", p.id, expected, { signal });
  return { ...f, service, options, authorizer, config, select, prepare, confirm, pricePort, leasePolicy, leaseOptions, leaseGate, leaseAllow: (v: unknown) => { leaseAllowed = v; }, deny: (p: string) => denied.add(p), policy: (p: unknown) => { policy = p; }, allow: (v: unknown) => { allowed = v; } };
}
async function unchanged(f: ReturnType<typeof fixture>, action: () => unknown) {
  const s = f.store.load(), c = f.store.loadCatalog(); await expect(Promise.resolve().then(action)).rejects.toThrow(); expect(f.store.load()).toEqual(s); expect(f.store.loadCatalog()).toEqual(c);
}

const worker = { workerId: "owned-worker", maxJobs: 2 };
async function processes(f: Awaited<ReturnType<typeof ready>>, operation: "claim" | "cancel") {
  const running = await Promise.all(["owned-1", "owned-2"].map(worker => new Promise<{ start(): void; result: Promise<any> }>((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./fixtures/locked-production-lease-process.ts", import.meta.url)), [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(child);
    let done!: (value: unknown) => void, fail!: (error: Error) => void; const result = new Promise((r, j) => { done = r; fail = j; }); void result.catch(() => undefined);
    child.on("error", e => { reject(e); fail(e); }); child.on("exit", code => { if (code !== 0) { const e = new Error("owned child failed"); reject(e); fail(e); } });
    child.on("message", (m: any) => m.ready ? resolve({ start: () => child.send("go"), result }) : done(m));
    child.send({ path: f.path, batch: f.v.batchId, operation, now: f.clock(), worker });
  })));
  running.forEach(c => c.start()); return Promise.all(running.map(c => c.result));
}
async function ready(opts: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(opts), p = await f.prepare(), v = await f.confirm(p);
  const claim = (actor = principal, request = worker) => f.kernel.claimLockedProductionImageBatch(actor, "project-a", v.batchId, request);
  const cancel = (actor = principal) => f.kernel.cancelLockedProductionImageBatch(actor, "project-a", v.batchId);
  const reconcile = () => f.kernel.reconcileLockedProductionImageBatch(principal, "project-a", v.batchId);
  const inspect = (l: { leaseId: string; workerId: string }, actor = principal) => f.kernel.inspectLockedProductionImageLease(actor, "project-a", v.batchId, v.jobId, { leaseId: l.leaseId, workerId: l.workerId });
  return { ...f, p, v, claim, cancel, reconcile, inspect };
}
describe("原锁区B3实际租约及未发送安全取消", () => {
  it.each([[false,false],[false,true],[true,false],[true,true]])("独立工厂 production=%s unknown=%s 原政策/确认/预算不变", async (production, manual) => {
    const f = await ready({ production, manual }), before = f.store.load()!, first = f.claim(), l = first.leases[0], actual = f.store.load()!.batches[0];
    expect(first.leases).toHaveLength(1); expect(actual.lockedProductionImageExecution).toEqual(before.batches[0].lockedProductionImageExecution);
    expect(actual.lockedProductionImageLeases).toEqual([{ ...l, schemaVersion: 2, mode: production ? "production" : "production-contract-fixture", actorId: principal.actorId,
      executionFingerprint: actual.requestFingerprint, protectionPolicyFingerprint: fp(f.p.protectionPolicy) }]);
    expect(actual.aggregate.jobs[0]).toMatchObject({ status: "leased", estimatedCostMinor: manual ? null : 25 });
    expect(actual.aggregate.audit.filter(a => a.eventType === "batch-dispatched")).toEqual([]); expect(actual.aggregate.ledger).toEqual(before.batches[0].aggregate.ledger);
    expect(f.inspect(l).lease).toEqual(actual.lockedProductionImageLeases![0]); expect(f.store.load()!.budgets).toEqual(before.budgets);
    expect(f.pricePort.verify.mock.calls.at(-1)![0]).toMatchObject({ purpose: "lease", scope: f.p.pricing.scope, protectionPolicy: f.p.protectionPolicy });
    expect(f.claim().leases).toEqual([]); expect(f.service.getConfirmation(principal, "project-a", f.p.id)).toMatchObject({ status: "queued", reservedMinor: 40 });
  });
  it.each(["json-images", "multipart-image-array", "multipart-image-single"] as const)("兼容原%s协议确认完整保留，不重建wire", async encoding => {
    const f = await ready({ protocol: "openai-compatible", encoding }), e = f.store.load()!.batches[0].lockedProductionImageExecution;
    const spy = vi.spyOn(protocol, "prepareLockedProductionImageProtocol"); f.claim(); expect(spy).not.toHaveBeenCalled(); expect(f.store.load()!.batches[0].lockedProductionImageExecution).toEqual(e);
  });
  it.each([false, true])("明确恢复到期，unknown=%s预留保持，再领取独立历史", async manual => {
    const f = await ready({ manual }), l = f.claim().leases[0]; f.advance(30000); const before = f.store.load();
    f.kernel.getBudget(principal, "project-a"); f.service.getConfirmation(principal, "project-a", f.p.id); expect(f.store.load()).toEqual(before);
    f.pricePort.verify.mockClear(); f.reconcile(); expect(f.pricePort.verify).not.toHaveBeenCalled();
    expect(f.store.load()!.batches[0].aggregate.jobs[0]).toMatchObject({ status: "queued" }); expect(f.store.load()!.batches[0].aggregate.jobs[0].leaseId).toBeUndefined();
    expect(() => f.inspect(l)).toThrow(); const next = f.claim().leases[0]; expect(next.leaseId).not.toBe(l.leaseId);
    expect(f.store.load()!.batches[0].lockedProductionImageLeases).toHaveLength(2); expect(f.kernel.getBudget(principal, "project-a").reservedMinor).toBe(40);
  });
  it("报价过期和目录停用不阻止到期恢复/只读/安全取消，不核价或发送", async () => {
    const f = await ready(), l = f.claim().leases[0]; f.advance(60000); f.register(connection({ ...f.config, revision: 2, enabled: false }));
    f.pricePort.read.mockClear(); f.pricePort.verify.mockClear(); f.reconcile(); const v = f.service.getConfirmation(principal, "project-a", f.p.id);
    expect(v.status).toBe("queued"); await unchanged(f, () => f.claim()); expect(() => f.inspect(l)).toThrow();
    f.cancel(); expect(f.pricePort.read).not.toHaveBeenCalled(); expect(f.pricePort.verify).not.toHaveBeenCalled(); expect(f.kernel.getBudget(principal, "project-a").reservedMinor).toBe(0);
  });
  it.each([[false,40],[true,40],[true,0]])("未发送cancel unknown=%s cap=%s，单笔释放/零cap关系清除、实费仍无结论", async (manual, cap) => {
    const f = await ready({ manual, cap }), l = f.claim().leases[0], e = f.store.load()!.batches[0].lockedProductionImageExecution;
    f.pricePort.verify.mockClear(); f.cancel(); const s = f.store.load()!, b = s.batches[0];
    expect(b.reservedMinor).toBe(0); expect(b.jobReservations).toEqual([]); expect(b.aggregate.jobs[0].actualCostMinor).toBeUndefined();
    expect(b.aggregate.jobs[0]).toMatchObject({ status: "cancelled", leaseId: l.leaseId }); expect(b.lockedProductionImageExecution).toEqual(e);
    expect(b.aggregate.ledger).toHaveLength(cap ? 2 : 1); expect(b.aggregate.ledger[0].estimatedMinor).toBe(manual ? null : 25);
    expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 0, availableMinor: 1000 });
    expect(f.cancel()).toEqual(b.aggregate); expect(f.store.load()).toEqual(s); expect(f.service.getConfirmation(principal, "project-a", f.p.id)).toMatchObject({ status: "cancelled", reservedMinor: 0 });
    expect(f.claim().leases).toEqual([]); expect(f.pricePort.verify).not.toHaveBeenCalled(); expect(f.store.load()).toEqual(s);
  });
  it("仅cancel独立权限无需execute/create/confirm/billing/assetwrite，原领取人不改", async () => {
    const f = await ready(); f.claim(); for (const permission of ["run:execute", "run:create", "run:confirm", "run:reconcile-billing", "asset:write"]) f.deny(permission);
    f.cancel(); expect(f.store.load()!.batches[0].lockedProductionImageLeases![0].actorId).toBe(principal.actorId);
  });
  it.each(["provider:read", "asset:read", "run:read", "run:execute"])("领取前%s撤权不私读或写", async permission => {
    const f = await ready(); f.deny(permission); const read = vi.spyOn(f.store, "loadLockedProductionImagePreparation");
    await unchanged(f, () => f.claim()); expect(read).not.toHaveBeenCalled();
  });
  it.each(["provider:read", "asset:read", "run:read", "run:cancel"])("取消前%s撤权保留预留", async permission => {
    const f = await ready(); f.claim(); f.deny(permission); await unchanged(f, () => f.cancel());
  });
  it.each([false, undefined, 1, "true", "promise", "rejected"])("独立政策严格同步true，%s关闭", async value => {
    const f = await ready(); const v = () => value === "promise" ? Promise.resolve(true) : value === "rejected" ? Promise.reject(new Error("owned")) : value;
    f.leaseOptions.lockedLeasePolicy = () => v() as boolean;
    // The factory captures identity; create a new explicit policy instead of mutating its old options.
    const policy = createLockedProductionImageLeaseFixturePolicy(f.leaseOptions); f.leaseGate.authorizeScope = (p, project, purpose) => policy.authorizeScope(p, project, purpose);
    await unchanged(f, () => f.claim());
  });
  it("默认关闭、模式与实际store不匹配在私有读取前拒绝", async () => {
    const f = await ready({ lease: false }); await unchanged(f, () => f.claim());
    expect(() => createLockedProductionImageLeasePolicy()).toThrow(); expect(() => createLockedProductionImageLeaseFixturePolicy()).toThrow();
    expect(() => createLockedProductionImageLeasePolicy(f.leaseOptions)).toThrow();
  });
  it.each(["actor", "worker", "lease", "project", "tenant"])("检查原%s身份，不能借相同worker复用", async kind => {
    const f = await ready(), l = f.claim().leases[0], actor = kind === "actor" ? { ...principal, actorId: "reader" } : kind === "tenant" ? { ...principal, tenantId: "other" } : principal;
    const read = vi.spyOn(f.store, "loadVerifiedImage");
    await unchanged(f, () => f.kernel.inspectLockedProductionImageLease(actor, kind === "project" ? "other" : "project-a", f.v.batchId, f.v.jobId,
      { workerId: kind === "worker" ? "other" : l.workerId, leaseId: kind === "lease" ? "other" : l.leaseId })); expect(read).not.toHaveBeenCalled();
  });
  it.each(["denied", "promise", "rejected"])("原可信verify %s拒绝且不重新read价格", async value => {
    const f = await ready(); f.pricePort.read.mockClear(); f.pricePort.verify.mockImplementation(() => value === "denied" ? false : value === "promise" ? Promise.resolve(true) : Promise.reject(new Error("owned")));
    await unchanged(f, () => f.claim()); expect(f.pricePort.read).not.toHaveBeenCalled();
  });
  it.each(["lease", "cancel", "reconcile"])("实际SQL %s写后撤权整体回滚", async command => {
    const f = await ready(); if (command !== "lease") f.claim(); if (command === "reconcile") f.advance(30000);
    const save = f.store.save.bind(f.store); vi.spyOn(f.store, "save").mockImplementation(s => { save(s); f.leaseAllow(false); });
    await unchanged(f, () => command === "lease" ? f.claim() : command === "cancel" ? f.cancel() : f.reconcile());
  });
  it.each(["source", "mask", "constraint", "connection"])("当前原%s漂移拒绝", async kind => {
    const f = await ready(); f.store.transaction(() => { const c = f.store.loadCatalog()!;
      if (kind === "constraint") c.projects[0].constraints[0].brandRules = { style: "changed" };
      else if (kind !== "connection") c.projects[0].assets.find(a => a.id === kind)!.byteSize! += 1; f.store.saveCatalog(c); });
    if (kind === "connection") f.register(connection({ ...f.config, revision: 2, enabled: false })); await unchanged(f, () => f.claim());
  });
  it("verify回调写入同库目录并撤权，整个副作用回滚", async () => {
    const f = await ready(); f.pricePort.verify.mockImplementation(() => { const c = f.store.loadCatalog()!; c.projects[0].constraints[0].lockedPaths = []; f.store.saveCatalog(c); return true; });
    await unchanged(f, () => f.claim());
  });
  it.each(["expired", "backwards", "timeout", "fault", "valid-drift"])("实际SQL写后%s失败保留原确认/预留", async kind => {
    const f = await ready(), save = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementation(s => { save(s); if (kind === "fault") throw new Error("owned-private-no-leak");
      if (kind === "valid-drift") { const c = f.store.loadCatalog()!; c.projects[0].constraints[0].brandRules = { changed: "owned" }; f.store.saveCatalog(c); }
      else f.advance(kind === "backwards" ? -1 : kind === "timeout" ? 5000 : 30000); });
    await unchanged(f, () => f.claim());
  });
  it("完整新元数据计原共享容量，不删除历史腾空间", async () => {
    const f = await ready({ quota: 0 }); await unchanged(f, () => f.claim()); await unchanged(f, () => f.cancel());
  });
  it("持久项目/供应商并发与窗口共用，不另造调度许可", async () => {
    const f = await ready({ kernel: { maxConcurrentJobs: 1, providerLimits: [{ adapterId: "fixture-image-v1", maxConcurrentJobs: 1, maxStartsPerWindow: 1, windowMs: 60000 }] } });
    const p = await f.prepare("other-action"), v = await f.confirm(p); f.claim();
    expect(f.kernel.claimLockedProductionImageBatch(principal, "project-a", v.batchId, worker)).toMatchObject({ leases: [], throttledBy: "project-concurrency" });
    f.cancel(); expect(f.kernel.claimLockedProductionImageBatch(principal, "project-a", v.batchId, worker)).toMatchObject({ leases: [], throttledBy: "provider-rate" });
  });
  it("两实际SQLite连接争抢与重启只一份租约，历史不重价/解码/预留", async () => {
    const f = await ready(), store = new SqliteRunKernelStateStore(f.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true }); connections.push(store);
    const policy = createLockedProductionImageLeaseFixturePolicy({ ...f.leaseOptions, stateStore: store });
    const k = new SqliteRunKernel({ stateStore: store, authorizer: f.authorizer, clock: f.clock,
      budgets: [{ tenantId: principal.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }], lockedProductionImageLeasePolicy: policy });
    const first = f.claim(); expect(k.claimLockedProductionImageBatch(principal, "project-a", f.v.batchId, worker).leases).toEqual([]);
    f.pricePort.verify.mockClear(); const before = store.load(); new SqliteRunKernel({ stateStore: store, authorizer: f.authorizer, clock: f.clock,
      budgets: [{ tenantId: principal.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }] });
    expect(store.load()).toEqual(before); expect(f.pricePort.verify).not.toHaveBeenCalled(); expect(store.load()!.batches[0].lockedProductionImageLeases).toHaveLength(1);
    expect(k.inspectLockedProductionImageLease(principal, "project-a", f.v.batchId, f.v.jobId, { workerId: worker.workerId, leaseId: first.leases[0].leaseId }).lease).toEqual(store.load()!.batches[0].lockedProductionImageLeases![0]);
  });
  it.each(["policy", "lease", "actor", "audit", "expiry", "delete-confirmation", "old-evidence"])("部分重算/删除%s恢复失败关闭", async kind => {
    const f = await ready(); f.claim(); const s = f.store.load()!, b = s.batches[0];
    if (kind === "policy") b.lockedProductionImageLeases![0].protectionPolicyFingerprint = "0".repeat(64);
    if (kind === "lease") b.aggregate.jobs[0].leaseId = "changed";
    if (kind === "actor") b.lockedProductionImageLeases![0].actorId = "reader";
    if (kind === "audit") b.aggregate.audit.pop();
    if (kind === "expiry") b.lockedProductionImageLeases![0].expiresAt = new Date(Date.parse(b.lockedProductionImageLeases![0].expiresAt) + 1000).toISOString();
    if (kind === "delete-confirmation") delete b.lockedProductionImageExecution;
    if (kind === "old-evidence") { b.productionImageLeases = [{ ...b.lockedProductionImageLeases![0], schemaVersion: 1 } as any]; delete (b.productionImageLeases[0] as any).protectionPolicyFingerprint; }
    f.store.transaction(() => f.store.save(s)); expect(() => f.kernel.getBudget(principal, "project-a")).toThrow();
  });
  it("非默认租约期限纯只读与实际配置一致，不能默认30秒覆盖", async () => {
    const f = await ready({ kernel: { leaseDurationMs: 5000 } }); f.claim(); expect(f.service.getConfirmation(principal, "project-a", f.p.id)).not.toBeNull();
    f.advance(5000); f.reconcile(); expect(f.store.load()!.batches[0].aggregate.jobs[0].status).toBe("queued");
  });
  it("首无效时钟随后正常仍拒绝，不留下新租约", async () => {
    let calls = 0, bad = false; const clock = () => bad && calls++ === 0 ? NaN : Date.parse(at);
    const f = await ready({ kernel: { clock } }); bad = true; await unchanged(f, () => f.claim());
  });
  it("权威目录大声明在任何收据/BLOB getter之前拦截", async () => {
    const f = await ready(); f.store.transaction(() => { const c = f.store.loadCatalog()!; c.projects[0].assets[0].byteSize = 30 * 1024 * 1024 + 1; f.store.saveCatalog(c); });
    const read = vi.spyOn(f.store, "loadVerifiedImage"); await unchanged(f, () => f.claim()); expect(read).not.toHaveBeenCalled();
  });
  it("活历史重复领取已过期报价/停用仍纯恢复，不核价/重解码/保存", async () => {
    const f = await ready({ kernel: { leaseDurationMs: 90000 } }); f.claim(); f.advance(60000); f.register(connection({ ...f.config, revision: 2, enabled: false }));
    f.pricePort.read.mockClear(); f.pricePort.verify.mockClear(); const save = vi.spyOn(f.store, "save"), decode = vi.spyOn(decoder, "decodeStaticImagePixels");
    const before = f.store.load(); expect(f.claim().leases).toEqual([]); expect(f.pricePort.verify).not.toHaveBeenCalled(); expect(f.pricePort.read).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); expect(f.store.load()).toEqual(before);
  });
  it("实际写后替换政策函数不是新许可，整体回滚", async () => {
    const f = await ready(), save = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementation(s => { save(s); f.leaseGate.validate = () => true; }); await unchanged(f, () => f.claim());
  });
  it("政策回调不能修改实际操作者，私有输入读取前拒绝且不改调用者", async () => {
    const f = await ready(), authorize = f.leaseGate.authorizeScope, actor = { ...principal };
    f.leaseGate.authorizeScope = (p, project, purpose) => { p.actorId = "reader"; return authorize(p, project, purpose); };
    const read = vi.spyOn(f.store, "loadLockedProductionImagePreparation"); await unchanged(f, () => f.claim(actor));
    expect(read).not.toHaveBeenCalled(); expect(actor).toEqual(principal);
  });
  it("独立OS进程实际同时领取只一个胜者，预留和原任务不二次创建", async () => {
    const f = await ready(), before = f.store.load()!.budgets, results = await processes(f, "claim");
    expect(results.every(r => r.ok)).toBe(true); expect(results.reduce((n, r) => n + r.result.leases.length, 0)).toBe(1);
    expect(f.store.load()!.batches[0].lockedProductionImageLeases).toHaveLength(1); expect(f.store.load()!.budgets).toEqual(before);
  });
  it("独立OS进程实际同时取消单笔释放，max不被重复减去", async () => {
    const f = await ready(); f.claim(); const results = await processes(f, "cancel"); expect(results.every(r => r.ok)).toBe(true);
    expect(results[0].result).toEqual(results[1].result); const b = f.store.load()!.batches[0];
    expect(b.aggregate.ledger).toHaveLength(2); expect(b.aggregate.audit.filter(a => a.eventType === "budget-released")).toHaveLength(1);
    expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
  });
  it("另获read身份不借execute读完整历史，保留原价格scope/领取人", async () => {
    const f = await ready(); f.claim(); f.deny("run:execute"); f.pricePort.verify.mockClear();
    const state = f.store.load()!; expect(f.leasePolicy.validate({ ...principal, actorId: "reader" }, state.batches[0].lockedProductionImageExecution!, "history", 0)).toBe(true);
    expect(f.pricePort.verify).not.toHaveBeenCalled(); expect(f.store.load()).toEqual(state);
  });
  it("同路径第二连接政策不能给原实例授权，私有准备读取前拒绝", async () => {
    const f = await ready(), store = new SqliteRunKernelStateStore(f.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true }); connections.push(store);
    const wrong = createLockedProductionImageLeaseFixturePolicy({ ...f.leaseOptions, stateStore: store }); f.leaseGate.usesStateStore = s => wrong.usesStateStore(s);
    const read = vi.spyOn(f.store, "loadLockedProductionImagePreparation"); await unchanged(f, () => f.claim()); expect(read).not.toHaveBeenCalled();
  });
  it("存储开关关闭不能跳过完整证据检查", async () => {
    const f = await ready(), store = new SqliteRunKernelStateStore(f.path); connections.push(store);
    const policy = createLockedProductionImageLeaseFixturePolicy({ ...f.leaseOptions, stateStore: store });
    expect(() => policy.validate(principal, f.store.load()!.batches[0].lockedProductionImageExecution!, "history", 0)).toThrow();
  });
  it("旧local/生产/模拟执行、通用取消和费用仍拒绝受保护租约", async () => {
    const f = await ready(), l = f.claim().leases[0], input = { workerId: l.workerId, leaseId: l.leaseId };
    for (const action of [() => f.kernel.claimProductionImageBatch(principal, "project-a", f.v.batchId, worker), () => f.kernel.claimImageBatch(principal, f.v.batchId, worker),
      () => f.kernel.claimBatch(principal, f.v.batchId, worker), () => f.kernel.cancelBatch(principal, f.v.batchId), () => f.kernel.dispatchBatch(principal, f.v.batchId),
      () => f.kernel.executeJob(principal, f.v.jobId, input)]) await unchanged(f, action);
  });
});
