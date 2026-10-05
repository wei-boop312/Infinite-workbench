import { LockedProductionImageTaskReconstruction, LockedImageProductionReconstructionHarness } from "../apps/api/src/lockedProductionImageTaskReconstruction";
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
function fixture(opts: { manual?: boolean; cap?: number; protocol?: "openai" | "openai-compatible"; encoding?: "json-images" | "multipart-image-array" | "multipart-image-single"; production?: boolean; timeout?: number; enabled?: boolean; lease?: boolean; quota?: number; start?: boolean; startTimeout?: number; kernel?: Partial<RunKernelOptions> } = {}) {
  let service: LockedImageProductionPreparationHarness | LockedProductionImagePreparations;
  let leasePolicy: LockedProductionImageLeasePolicy, leaseAllowed: unknown = true;
  let reconstruction: LockedProductionImageTaskReconstruction | LockedImageProductionReconstructionHarness, startAllowed: unknown = true;
  const leaseGate: LockedProductionImageLeasePolicy = { usesStateStore: s => leasePolicy.usesStateStore(s), authorizeScope: (p, project, purpose) => leasePolicy.authorizeScope(p, project, purpose),
    validate: (p, e, purpose, bytes) => leasePolicy.validate(p, e, purpose, bytes) };
  const f = setupImageTask({ productionResponses: true, productionArtifacts: true,
    kernel: { validateLockedProductionImageConfirmation: (p, e) => service.authorizeConfirmation(p, e), ...(opts.lease === false ? {} : { lockedProductionImageLeasePolicy: leaseGate }),
      ...(opts.start === false ? {} : { lockedProductionImageStartPolicy: { usesStateStore: s => reconstruction.usesStateStore(s), authorizeScope: (p, project) => reconstruction.authorizeScope(p, project), validateStart: (p, e, l, i) => reconstruction.validateStart(p, e, l, i) } }), ...opts.kernel } }); owned.push(f);
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
  const rebuildOptions = { lockedReconstructionEnabled: true as const, lockedStartEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel,
    leasePolicy: leaseGate, lockedStartPolicy: () => startAllowed as boolean, clock: f.clock, timeoutMs: opts.startTimeout };
  reconstruction = opts.production ? new LockedProductionImageTaskReconstruction(rebuildOptions) : new LockedImageProductionReconstructionHarness(rebuildOptions);
  const select = (action = "locked-owned") => ({ projectId: "project-a", idempotencyKey: action, connectionId: config.id, connectionRevision: 1, model: config.models[0].model,
    capabilityVersion: config.models[0].version, constraintSnapshotId: "constraint-a", operation: "edit", inputAssetIds: ["source"], maskAssetId: "mask", protection: "pixel-exact",
    parameters: { prompt: "原人工锁区指令", n: 1, size: { width: 2, height: 1 }, quality: "auto", background: "auto", outputFormat: "png" } });
  const prepare = async (action = "locked-owned") => { const v = await service.createPreparation(principal, select(action)); return f.store.loadLockedProductionImagePreparation(principal.tenantId, "project-a", v.mode, v.id)!; };
  const confirm = (p: Awaited<ReturnType<typeof prepare>>, actor = principal, expected: unknown = lockedExpected(p), signal?: AbortSignal) => service.confirmPreparation(actor, "project-a", p.id, expected, { signal });
  return { ...f, reconstruction, rebuildOptions, startAllow: (v: unknown) => { startAllowed = v; }, service, options, authorizer, config, select, prepare, confirm, pricePort, leasePolicy, leaseOptions, leaseGate, leaseAllow: (v: unknown) => { leaseAllowed = v; }, deny: (p: string) => denied.add(p), policy: (p: unknown) => { policy = p; }, allow: (v: unknown) => { allowed = v; } };
}
async function unchanged(f: ReturnType<typeof fixture>, action: () => unknown) {
  const s = f.store.load(), c = f.store.loadCatalog(); await expect(Promise.resolve().then(action)).rejects.toThrow(); expect(f.store.load()).toEqual(s); expect(f.store.loadCatalog()).toEqual(c);
}


async function ready(opts: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(opts), p = await f.prepare(), v = await f.confirm(p), l = f.kernel.claimLockedProductionImageBatch(principal, "project-a", v.batchId, { workerId: "owned-worker", maxJobs: 1 }).leases[0];
  const input = { workerId: l.workerId, leaseId: l.leaseId };
  const start = (signal?: AbortSignal, actor = principal) => f.reconstruction.start(actor, "project-a", v.batchId, v.jobId, input, { signal });
  const inspect = (actor = principal, request = input) => f.kernel.inspectLockedProductionImageStart(actor, "project-a", v.batchId, v.jobId, request);
  const reconcile = () => f.kernel.reconcileLockedProductionImageBatch(principal, "project-a", v.batchId);
  return { ...f, p, v, l, input, start, inspect, reconcile };
}
describe("原锁区B4实际wire/同库永久not-connected意图", () => {
  it.each(["fault","revoke","deadline","lease","price","catalog","port","cancel"])("实际SQL写后%s整体回滚意图/任务/副作用，原预留保留", async kind => {
    const f = await ready(), save = f.store.save.bind(f.store), control = new AbortController();
    vi.spyOn(f.store,"save").mockImplementation(s => { save(s); if (!s.batches[0].lockedProductionImageDispatchIntent) return;
      if (kind === "fault") throw new Error("owned-private-secret"); if (kind === "revoke") f.deny("asset:read");
      if (kind === "deadline") f.advance(5000); if (kind === "lease") f.advance(30000); if (kind === "price") f.pricePort.verify.mockReturnValue(false);
      if (kind === "catalog") { const c = f.store.loadCatalog()!; c.projects[0].constraints[0].brandRules = { changed:"owned" }; f.store.saveCatalog(c); }
      if (kind === "port") (f.kernel as any).options.lockedProductionImageStartPolicy.validateStart = () => true;
      if (kind === "cancel") control.abort(); });
    await unchanged(f, () => f.start(control.signal)); expect(f.store.load()!.batches[0].reservedMinor).toBe(40);
  });
  it.each(["payload","metadata","request","transform"])("实际重建%s不匹配不能只重算摘要放行", async kind => {
    const f = await ready(), original = protocol.prepareLockedProductionImageProtocol;
    vi.spyOn(protocol,"prepareLockedProductionImageProtocol").mockImplementation(async (...args) => { const r = await original(...args);
      if (kind === "payload") r.wire.body[0] ^= 1; if (kind === "metadata") r.wire.contentType = "application/not-json";
      if (kind === "request") r.snapshot.request.parameters.prompt += "changed"; if (kind === "transform") r.snapshot.transformedInputs[0].originalChecksumSha256 = "0".repeat(64);
      return r; }); await unchanged(f, () => f.start());
  });
  it.each(["cancel","permission","price","connection"])("SQL外await期间%s不允许迟到启动", async kind => {
    const f = await ready(), original = protocol.prepareLockedProductionImageProtocol, control = new AbortController();
    vi.spyOn(protocol,"prepareLockedProductionImageProtocol").mockImplementation(async (...args) => { const result = await original(...args);
      if (kind === "cancel") control.abort(); if (kind === "permission") f.deny("run:execute"); if (kind === "price") f.pricePort.verify.mockReturnValue(false);
      if (kind === "connection") f.register({ ...f.config, revision:2, enabled:false }); return result; });
    const snapshot = f.store.load(); await expect(f.start(control.signal)).rejects.toThrow(); expect(f.store.load()).toEqual(snapshot);
  });
  it("两槽及绝对取消，不合作协议未结清仍占槽且迟到不写，清自有字节", async () => {
    const f = await ready({startTimeout:15}), original = protocol.prepareLockedProductionImageProtocol;
    const releases: Array<() => void> = [], inputs: Buffer[] = []; let arrived!: () => void; const both = new Promise<void>(r => { arrived = r; });
    vi.spyOn(protocol,"prepareLockedProductionImageProtocol").mockImplementation(async (...args) => { inputs.push(...args[3].map(i => i.body));
      await new Promise<void>(r => { releases.push(r); if (releases.length === 2) arrived(); }); return original(...args); });
    const before = f.store.load(), first = f.start(), second = f.start(); const failure = Promise.allSettled([first,second]); await both;
    expect((await failure).every(r => r.status === "rejected")).toBe(true); await expect(f.start()).rejects.toThrow(); expect(releases).toHaveLength(2);
    const done = new Promise<void>(r => setTimeout(r,25)); releases.forEach(r => r()); await done;
    expect(f.store.load()).toEqual(before); expect(inputs.every(b => b.every(v => v === 0))).toBe(true);
  });
  it.each(["intent","fingerprint","policy","lease","actor","audit","ledger"])("重启缺失或部分重算%s拒绝", async kind => {
    const f = await ready(); await f.start(); f.advance(30000); f.reconcile(); const s = f.store.load()!, b = s.batches[0];
    if (kind === "intent") delete b.lockedProductionImageDispatchIntent; if (kind === "fingerprint") delete b.lockedProductionImageDispatchIntentFingerprint;
    if (kind === "policy") { b.lockedProductionImageDispatchIntent!.protectionPolicyFingerprint = "0".repeat(64); b.lockedProductionImageDispatchIntentFingerprint = fp(b.lockedProductionImageDispatchIntent); }
    if (kind === "lease") delete b.lockedProductionImageLeases; if (kind === "actor") { b.lockedProductionImageDispatchIntent!.actorId = "reader"; b.lockedProductionImageDispatchIntentFingerprint = fp(b.lockedProductionImageDispatchIntent); }
    if (kind === "audit") b.aggregate.audit = b.aggregate.audit.filter(a => a.eventType !== "job-started"); if (kind === "ledger") b.aggregate.ledger.pop();
    f.store.transaction(() => f.store.save(s)); expect(() => f.kernel.getBudget(principal,"project-a")).toThrow(); await expect(f.start()).rejects.toThrow();
  });
  it("旧none/local/mock/核账/通用取消/重试不消费新意图", async () => {
    const f = await ready(); await f.start(); f.advance(30000); f.reconcile();
    for (const action of [() => f.kernel.cancelBatch(principal,f.v.batchId), () => f.kernel.claimBatch(principal,f.v.batchId,{workerId:"wrong",maxJobs:1}),
      () => f.kernel.executeLeasedJob(principal,f.v.jobId,f.input), () => f.kernel.retryJob(principal,f.v.jobId,{expectedEstimatedCostMinor:25,expectedMaxCostMinor:40,expectedCurrency:"CNY"})]) await unchanged(f, action);
  });
  it.each([[false,false],[false,true],[true,false],[true,true]])("从头独立production=%s unknown=%s不改政策/费用", async (production, manual) => {
    const f = await ready({ production, manual }), before = f.store.load()!, result = await f.start(), s = f.store.load()!.batches[0];
    expect(result).toMatchObject({ started: true, executionAuthorized: false, realExecutionEnabled: false, intent: { schemaVersion: 2, transport: "not-connected" } });
    expect(result.intent.protectionPolicyFingerprint).toBe(fp(f.p.protectionPolicy));
    expect(s.lockedProductionImageExecution).toEqual(before.batches[0].lockedProductionImageExecution); expect(s.aggregate.ledger).toEqual(before.batches[0].aggregate.ledger);
    expect(s.aggregate.jobs[0]).toMatchObject({ status: "running", estimatedCostMinor: manual ? null : 25, startedAt: result.intent.recordedAt });
    expect(s.jobReservations).toEqual(before.batches[0].jobReservations); expect(f.store.load()!.budgets).toEqual(before.budgets);
    expect(f.inspect().intent).toEqual(result.intent); expect(s.aggregate.jobs[0].actualCostMinor).toBeUndefined();
    expect(f.service.getConfirmation(principal, "project-a", f.p.id)).toMatchObject({ status: "running", reservedMinor: 40 });
  });
  it.each(["json-images", "multipart-image-array", "multipart-image-single"] as const)("实际%s原boundary/转换/wire SHA匹配而非新确认", async encoding => {
    const f = await ready({ protocol: "openai-compatible", encoding }); f.advance(3); const result = await f.start(), e = f.store.load()!.batches[0].lockedProductionImageExecution!;
    expect(result.intent.reconstructedAt).not.toBe(e.confirmedAt); expect(result.intent).toMatchObject({ requestFingerprint: e.protocol.requestFingerprint,
      payloadChecksumSha256: e.protocol.payloadChecksumSha256, payloadByteSize: e.protocol.payloadByteSize, contentType: e.protocol.contentType,
      transformedInputsFingerprint: fp(e.protocol.transformedInputs), protocolVersion: e.protocol.protocolVersion });
  });
  it.each([false,true])("并发首次只一个意图/审计，unknown=%s", async manual => {
    const f = await ready({ manual }), r = await Promise.all([f.start(), f.start()]);
    expect(r.filter(r => r.started)).toHaveLength(1); expect(r[0].intent).toEqual(r[1].intent);
    expect(f.store.load()!.batches[0].aggregate.audit.filter(a => a.eventType === "job-started")).toHaveLength(1);
  });
  it.each([false,true])("历史过期停用只恢复，不解码/重建/报价/预留 unknown=%s", async manual => {
    const f = await ready({ manual }), r = await f.start(); f.advance(60000); f.register({ ...f.config, revision: 2, enabled: false });
    const before = f.store.load(), spy = vi.spyOn(protocol, "prepareLockedProductionImageProtocol"), decode = vi.spyOn(decoder, "decodeStaticImage");
    f.pricePort.verify.mockClear(); f.pricePort.read.mockClear();
    expect(await f.start()).toMatchObject({ started: false, intent: r.intent }); expect(f.store.load()).toEqual(before);
    expect(spy).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); expect(f.pricePort.verify).not.toHaveBeenCalled(); expect(f.pricePort.read).not.toHaveBeenCalled();
    const other = new SqliteRunKernelStateStore(f.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true }); connections.push(other);
    let rebuild!: LockedImageProductionReconstructionHarness;
    const policy = createLockedProductionImageLeaseFixturePolicy({ ...f.leaseOptions, stateStore: other });
    const kernel = new SqliteRunKernel({ stateStore: other, clock: f.clock, authorizer: f.authorizer, budgets: before!.budgets, lockedProductionImageLeasePolicy: policy,
      lockedProductionImageStartPolicy: { usesStateStore: s => rebuild.usesStateStore(s), authorizeScope: (p, project) => rebuild.authorizeScope(p, project), validateStart: (p,e,l,i) => rebuild.validateStart(p,e,l,i) } });
    rebuild = new LockedImageProductionReconstructionHarness({ ...f.rebuildOptions, stateStore: other, runKernel: kernel, leasePolicy: policy });
    expect(await rebuild.start(principal, "project-a", f.v.batchId, f.v.jobId, f.input)).toMatchObject({ started: false, intent: r.intent }); expect(other.load()).toEqual(before);
  });
  it.each([false,true])("明确到期恢复unknown/max一次，未知估价=%s不能取消释放", async manual => {
    const f = await ready({ manual }), started = await f.start(), before = f.store.load(); f.advance(30000);
    f.kernel.getBudget(principal, "project-a"); new SqliteRunKernel({ stateStore: f.store, authorizer: f.authorizer, budgets: before!.budgets, clock: f.clock });
    expect(f.store.load()).toEqual(before); const result = f.reconcile(), s = f.store.load()!.batches[0];
    expect(result.jobs[0]).toMatchObject({ status: "billing_unknown", failureCode: "locked-lease-expired-after-intent", estimatedCostMinor: manual ? null : 25 });
    expect(s.lockedProductionImageDispatchIntent).toEqual(started.intent); expect(s.reservedMinor).toBe(40); expect(f.store.load()!.budgets).toEqual(before!.budgets);
    expect(result.ledger[1]).toMatchObject({ settlement: "unknown", reservedMinor: 40, estimatedMinor: manual ? null : 25 }); expect(result.ledger[1].actualMinor).toBeUndefined();
    expect(f.reconcile()).toEqual(result); expect(await f.start()).toMatchObject({ started: false, intent: started.intent });
    await unchanged(f, () => f.kernel.cancelLockedProductionImageBatch(principal, "project-a", f.v.batchId));
  });
  it("实际非默认任务期限优先到期，零上限仍保存完整unknown关系", async () => {
    const f = await ready({ manual: true, cap: 0, kernel: { leaseDurationMs: 90000, jobTimeoutMs: 1000 } }); await f.start(); f.advance(1000);
    expect(f.reconcile().jobs[0].failureCode).toBe("locked-job-timeout-after-intent");
    expect(f.store.load()!.batches[0]).toMatchObject({ reservedMinor: 0, jobReservations: [[f.v.jobId,0]] }); expect(f.kernel.getBudget(principal,"project-a").reservedMinor).toBe(0);
  });
  it.each(["run:read","run:execute","provider:read","asset:read"])("缺%s读取前拒绝", async permission => {
    const f = await ready(); f.deny(permission); const read = vi.spyOn(f.store, "loadVerifiedImageBytes"); await unchanged(f, () => f.start()); expect(read).not.toHaveBeenCalled();
  });
  it.each([false, Promise.resolve(true), "true", null])("启动政策非同步true关闭 %s", async value => { const f = await ready(); f.startAllow(value); await unchanged(f, () => f.start()); });
  it("默认关闭与不同实际store在私有读取前拒绝", async () => {
    const f = await ready({ start: false }), read = vi.spyOn(f.store, "loadVerifiedImageBytes"); await unchanged(f, () => f.start()); expect(read).not.toHaveBeenCalled();
    await expect(new LockedImageProductionReconstructionHarness().start(principal,"project-a",f.v.batchId,f.v.jobId,f.input)).rejects.toThrow();
    const other = new SqliteRunKernelStateStore(f.path,{ productionResponseStorageEnabled:true,productionArtifactStorageEnabled:true }); connections.push(other);
    const wrong = new LockedImageProductionReconstructionHarness({ ...f.rebuildOptions, stateStore: other });
    await expect(wrong.start(principal,"project-a",f.v.batchId,f.v.jobId,f.input)).rejects.toThrow();
  });
  it.each(["actor","worker","lease","job","project","mode"])("原%s错配不读原图", async kind => {
    const f = await ready(), read = vi.spyOn(f.store,"loadVerifiedImageBytes");
    const actor = kind === "actor" ? { ...principal,actorId:"reader" } : principal, input = { ...f.input, ...(kind === "worker" ? {workerId:"wrong"} : {}), ...(kind === "lease" ? {leaseId:"wrong"} : {}) };
    const rebuild = kind === "mode" ? new LockedProductionImageTaskReconstruction(f.rebuildOptions) : f.reconstruction;
    await unchanged(f, () => rebuild.start(actor,kind === "project" ? "wrong":"project-a",f.v.batchId,kind === "job" ? "wrong":f.v.jobId,input)); expect(read).not.toHaveBeenCalled();
  });
  it("纯schema/摘要/租约或关闭的live pending不能提交", async () => {
    const f = await ready(), r = await f.start(); expect(() => f.reconstruction.validateStart(principal,f.inspect().execution,f.inspect().lease,r.intent)).toThrow();
    const g = await ready(); const forged = { ...r.intent, batchId:g.v.batchId,jobId:g.v.jobId,leaseId:g.l.leaseId,executionFingerprint:g.inspect().lease.executionFingerprint,leaseFingerprint:fp(g.inspect().lease) };
    await unchanged(g, () => g.kernel.startLockedProductionImageJob(principal,"project-a",g.v.batchId,g.v.jobId,g.input,forged));
  });
  it("独立OS进程同时重建只提交一个原意图，预算和租约不改", async () => {
    const f = await ready(), before = f.store.load()!;
    const running = await Promise.all([1,2].map(() => new Promise<{start():void;result:Promise<any>}>((resolve,reject) => {
      const child = fork(fileURLToPath(new URL("./fixtures/locked-production-start-process.ts",import.meta.url)),[],{execArgv:["--import","tsx"],stdio:["ignore","ignore","pipe","ipc"]}); children.push(child);
      let done!: (value:any) => void, fail!: (error:Error) => void; const result = new Promise((r,j) => {done=r;fail=j;}); void result.catch(() => undefined);
      child.on("error",e => {reject(e);fail(e);}); child.on("exit",code => {if(code !== 0){const e=new Error("owned child failed");reject(e);fail(e);}});
      child.on("message",(m:any) => m.ready ? resolve({start:() => child.send("go"),result}) : done(m));
      child.send({path:f.path,batch:f.v.batchId,job:f.v.jobId,now:f.clock(),input:f.input});
    })));
    running.forEach(r => r.start()); const results = await Promise.all(running.map(r => r.result));
    expect(results.every(r => r.ok)).toBe(true); expect(results.filter(r => r.result.started)).toHaveLength(1); expect(results[0].result.intent).toEqual(results[1].result.intent);
    expect(f.store.load()!.budgets).toEqual(before.budgets); expect(f.store.load()!.batches[0].lockedProductionImageLeases).toEqual(before.batches[0].lockedProductionImageLeases);
  });
  it("正常毫秒推进允许，但写后观察时钟倒退回滚", async () => {
    const f = await ready(); f.pricePort.verify.mockImplementation(() => {f.advance(1);return true;}); expect((await f.start()).started).toBe(true);
    const g = await ready(), save = g.store.save.bind(g.store); vi.spyOn(g.store,"save").mockImplementation(s => {save(s);g.advance(-1);}); await unchanged(g,() => g.start());
  });
  it("首无效时钟不占槽且不读取原字节", async () => {
    const f = await ready(), read = vi.spyOn(f.store,"loadVerifiedImageBytes"), r = new LockedImageProductionReconstructionHarness({...f.rebuildOptions,clock:() => NaN});
    await unchanged(f,() => r.start(principal,"project-a",f.v.batchId,f.v.jobId,f.input)); expect(read).not.toHaveBeenCalled(); expect((await f.start()).started).toBe(true);
  });
  it("权威声明先于任何收据/BLOB getter，无删历史腾空间", async () => {
    const f = await ready(); f.store.transaction(() => {const c=f.store.loadCatalog()!;c.projects[0].assets.find(a => a.id === "source")!.byteSize=30*1024*1024+1;f.store.saveCatalog(c);});
    const read = vi.spyOn(f.store,"loadVerifiedImage"); await unchanged(f,() => f.start()); expect(read).not.toHaveBeenCalled();
  });
  it("重建后容量不足拒绝意图，原预留原文件保留", async () => {
    const f = await ready(), original = protocol.prepareLockedProductionImageProtocol;
    vi.spyOn(protocol,"prepareLockedProductionImageProtocol").mockImplementation(async (...args) => {const r=await original(...args);vi.spyOn(f.store,"imageMetadataBytes").mockReturnValue(16*1024*1024);return r;});
    await unchanged(f,() => f.start()); expect(f.store.load()!.batches[0].reservedMinor).toBe(40);
  });
});
