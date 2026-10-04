import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductionImageArtifactSchema, type ConfirmedProductionImageExecution, type ImageProviderConnection } from "../packages/contracts/src/index";
import { ImageProductionPreparationHarness, type ImagePriceContext } from "../apps/api/src/productionImagePreparations";
import { createProductionImageLeaseFixturePolicy, type ProductionImageLeasePolicy } from "../apps/api/src/productionImageLeasePolicy";
import { ImageProductionReconstructionHarness } from "../apps/api/src/productionImageTaskReconstruction";
import { ImageProductionArtifactHarness, ProductionImageTaskArtifacts } from "../apps/api/src/productionImageTaskArtifacts";
import { productionExpected } from "../apps/api/src/productionImageConfirmationIntegrity";
import { imageSnapshotFingerprint as fp } from "../apps/api/src/imageProviderContract";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import type { RunKernelOptions } from "../apps/api/src/runKernel";
import * as decoder from "../apps/api/src/staticImageDecoder";
import * as protocolApi from "../apps/api/src/productionImageProtocol";
import { principal, connection, setupImageTask, sha } from "./helpers/image-task-fixture";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
const owned: ReturnType<typeof setupImageTask>[] = [], stores: SqliteRunKernelStateStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const s of stores.splice(0).reverse()) s.close(); for (const f of owned.splice(0).reverse()) f.cleanup(); });
function db(path: string, action: (d: DatabaseSync) => void) { const d = new DatabaseSync(path); try { action(d); } finally { d.close(); } }

async function fixture(options: { protocol?: ImageProviderConnection["protocol"]; manual?: boolean; edit?: boolean; cap?: number; bad?: boolean; enabled?: boolean } = {}) {
  let preparations: ImageProductionPreparationHarness, policy: ProductionImageLeasePolicy, reconstruction: ImageProductionReconstructionHarness, artifacts: ImageProductionArtifactHarness;
  const denied = new Set<string>(); let allowed = true;
  const auth = { authenticate: () => principal, allows: (p: typeof principal, project: string, permission?: string) => allowed && !denied.has(permission ?? "")
    && p.tenantId === principal.tenantId && [principal.actorId, "other"].includes(p.actorId) && project === "project-a" };
  const gate: ProductionImageLeasePolicy = { usesStateStore: s => policy.usesStateStore(s), authorizeScope: (p, project) => policy.authorizeScope(p, project), validate: (p,e,purpose,bytes) => policy.validate(p,e,purpose,bytes) };
  const kernelOptions: Partial<RunKernelOptions> = { authorizer: auth, validateProductionImageConfirmation: (p,e: ConfirmedProductionImageExecution) => preparations.authorizeConfirmation(p,e), productionImageLeasePolicy: gate,
    productionImageStartPolicy: { usesStateStore: s => reconstruction?.usesStateStore(s) ?? false, authorizeScope: (p,j) => reconstruction?.authorizeScope(p,j) ?? false, validateStart: (p,e,l,i) => reconstruction?.validateStart(p,e,l,i) ?? false },
    productionImageResponsePolicy: { usesStateStore: s => reconstruction?.responsePolicy.usesStateStore(s) ?? false, authorizeScope: (p,j) => reconstruction?.responsePolicy.authorizeScope(p,j) ?? false,
      validateAttempt: (p,e,l,i,a) => reconstruction?.responsePolicy.validateAttempt(p,e,l,i,a) ?? false, validateResult: (p,e,l,i,a,r) => reconstruction?.responsePolicy.validateResult(p,e,l,i,a,r) ?? false },
    productionImageArtifactPolicy: { usesStateStore: s => artifacts?.usesStateStore(s) ?? false, authorizeScope: (p,j) => artifacts?.authorizeScope(p,j) ?? false, validateCommit: (p,r) => artifacts?.validateCommit(p,r) ?? false } };
  const protocol = options.protocol ?? "openai", format = protocol === "google" ? "jpeg" : "png";
  const f = setupImageTask({ productionResponses: true, productionArtifacts: true, format, kernel: kernelOptions }); owned.push(f);
  const model = connection().models[0]; const config = connection({ protocol,
    ...(protocol === "openai-compatible" ? { compatibility: { version: "owned-compat", editEncoding: "multipart-image-array", responseEncoding: "images-b64-json-v1", auth: { scheme: "bearer" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}),
    ...(protocol === "google" ? { baseUrl: "https://generativelanguage.googleapis.com", models: [{ ...model, maxInputImages: 14, outputFormats: ["jpeg"] }], googleNative: { version: "owned-google", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: model.model, sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] } } : {}) });
  f.register(config); if (options.edit) f.source();
  const price = { kind: "contract-fixture" as const, realExecutionEnabled: false as const, read: vi.fn((c: ImagePriceContext) => ({ schemaVersion: 1, scope: c.scope,
    quote: { id: "owned-price", version: "owned-v1", source: options.manual === false ? "server-price-table" : "manual-budget", currency: "CNY", maxCostMinor: options.cap ?? 40,
      ...(options.manual === false ? { estimatedCostMinor: 25 } : {}), expiresAt: new Date(f.clock() + 60_000).toISOString() },
    evidence: { kind: "contract-fixture", realExecutionEnabled: false, sourceRevision: "owned-table", evidenceRef: "no-real-price", checkedBy: "owned-oracle", checkedAt: c.requestedAt } })), verify: vi.fn(() => true) };
  policy = createProductionImageLeaseFixturePolicy({ leasePreparationEnabled: true, tenantId: principal.tenantId, stateStore: f.store, clock: f.clock, runAuthorizer: auth, providerAuthorizer: auth, assetAuthorizer: auth, pricePort: price });
  preparations = new ImageProductionPreparationHarness({ preparationEnabled: true, tenantId: principal.tenantId, stateStore: f.store, clock: f.clock, runKernel: f.kernel, authorizer: auth, runAuthorizer: auth, assetAuthorizer: auth, pricePort: price });
  const output: Buffer = options.bad ? Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) : await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#447799" } }).toFormat(format).toBuffer();
  const json = protocol === "google" ? { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ inlineData: { mimeType: "image/jpeg", data: output.toString("base64") } }] } }], responseId: "owned-google" } : { created: 1, data: [{ b64_json: output.toString("base64") }] };
  const send = vi.fn(async () => ({ status: 200, contentType: "application/json", requestId: "owned-id", body: Buffer.from(JSON.stringify(json)) }));
  reconstruction = new ImageProductionReconstructionHarness({ reconstructionEnabled: true, startEnabled: true, responseHandlingEnabled: true, leasePolicy: gate, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, clock: f.clock, fixtureTransport: { kind: "contract-fixture", realExecutionEnabled: false, send } });
  const artifactOptions = { artifactHandlingEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, clock: f.clock, runAuthorizer: auth, providerAuthorizer: auth, assetAuthorizer: auth };
  artifacts = new ImageProductionArtifactHarness(options.enabled === false ? undefined : artifactOptions);
  const publicPreparation = preparations.createPreparation(principal, { projectId: "project-a", idempotencyKey: "owned-artifact-action", connectionId: config.id, connectionRevision: 1, model: model.model, capabilityVersion: model.version,
    constraintSnapshotId: "constraint-a", protection: "none", operation: options.edit ? "edit" : "generate", inputAssetIds: options.edit ? ["source"] : [], parameters: { prompt: "人工原构图", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", background: "auto", outputFormat: format } });
  const preparation = f.store.loadProductionImagePreparation(principal.tenantId, "project-a", "production-contract-fixture", publicPreparation.id)!;
  const b = (await preparations.confirmPreparation(principal, "project-a", preparation.id, productionExpected(preparation))).aggregate;
  const l = f.kernel.claimProductionImageBatch(principal, "project-a", b.batch.id, { workerId: "owned-worker", maxJobs: 1 }).leases[0];
  const args = [principal, "project-a", b.batch.id, l.jobId, { workerId: l.workerId, leaseId: l.leaseId }] as const;
  await reconstruction.executeFixture(...args);
  const saved = () => f.store.load()!.batches[0];
  return { f, config, price, artifacts, artifactOptions, kernelOptions, auth, output, send, args, saved, denied, revoke: () => { allowed = false; } };
}

describe.each((["openai", "openai-compatible", "google"] as const).flatMap(protocol => [true,false].flatMap(manual => [true,false].map(edit => [protocol,manual,edit] as const))))("6D6B %s unknown=%s edit=%s", (protocol,manual,edit) => {
  let t: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { t = await fixture({ protocol, manual, edit }); });
  it("实际原包到同库产物，估价/未知预留不改；历史不重建或解码", async () => {
    const before = t.saved(), budget = t.f.kernel.getBudget(principal,"project-a"), record = await t.artifacts.ingest(...t.args);
    expect(record.validation).toBe("verified"); expect(record.draft.money.estimate.state).toBe(manual ? "unknown" : "known");
    expect(record.image.checksumSha256).toBe(sha(t.output)); expect(record.image.asset.width).toBe(1024); expect(record.image.asset.sourceAssetId).toBe(edit ? "source" : undefined);
    const body = t.f.store.loadVerifiedImageBytes(principal.tenantId,"project-a",record.image.asset.id)!; expect(body.body.equals(t.output)).toBe(true); body.body.fill(0);
    expect(t.saved().aggregate.jobs[0].outputAssetIds).toEqual([record.image.asset.id]); expect(t.saved().productionImageResult).toEqual(before.productionImageResult);
    expect(t.saved().aggregate.ledger).toEqual(before.aggregate.ledger); expect(t.f.kernel.getBudget(principal,"project-a")).toEqual(budget);
    expect(t.saved().aggregate.batch.status).toBe("billing_unknown"); expect(t.f.store.loadGeneratedImage(principal.tenantId,"project-a",t.args[3])).toBeNull();
    t.f.advance(120_000); t.f.register({ ...t.config, revision: 2, enabled: false });
    const prepare = vi.spyOn(protocolApi,"prepareProductionImageProtocol"), decode = vi.spyOn(decoder,"decodeStaticImage"), reads = t.price.read.mock.calls.length, verifies = t.price.verify.mock.calls.length;
    expect(await t.artifacts.ingest(...t.args)).toEqual(record); expect(prepare).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled();
    expect(t.price.read).toHaveBeenCalledTimes(reads); expect(t.price.verify).toHaveBeenCalledTimes(verifies); expect(t.send).toHaveBeenCalledTimes(1);
    await expect(Promise.resolve().then(() => t.f.kernel.resolveBillingUnknown(principal,t.args[3], { outcome: "not-charged", actualCostMinor: 0, currency: "CNY", evidenceRef: "not-allowed" } as never))).rejects.toThrow();
  });
});

describe("6D6B 关闭、权限、故障、恢复与资源", () => {
  it("缺省关闭/错误命名空间/同路径不同实例不能取得许可", async () => {
    const t = await fixture({ enabled: false }), load = vi.spyOn(t.f.store,"load");
    await expect(t.artifacts.ingest(...t.args)).rejects.toThrow(); await expect(new ProductionImageTaskArtifacts().ingest(...t.args)).rejects.toThrow(); expect(load).not.toHaveBeenCalled();
    const other = new SqliteRunKernelStateStore(t.f.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true }); stores.push(other);
    await expect(new ImageProductionArtifactHarness({ ...t.artifactOptions, stateStore: other }).ingest(...t.args)).rejects.toThrow();
    await expect(new ProductionImageTaskArtifacts(t.artifactOptions).ingest(...t.args)).rejects.toThrow();
  });
  it.each(["run:read","run:execute","provider:read","asset:read","asset:write"])("%s 撤权在私有快照之前", async permission => {
    const t = await fixture(); t.denied.add(permission); const read = vi.spyOn(t.f.store,"load"), raw = vi.spyOn(t.f.store,"loadProductionImageResponse");
    await expect(t.artifacts.ingest(...t.args)).rejects.toThrow(); expect(read).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
  });
  it.each(["false","promise","rejected","private-error"])("同步政策%s失败关闭且不漏秘密", async kind => {
    const t = await fixture(); vi.spyOn(t.auth,"allows").mockImplementation(() => { if(kind === "private-error") throw new Error("owned-private-secret"); return (kind === "false" ? false : kind === "promise" ? Promise.resolve(true) : Promise.reject(new Error("owned-private-secret"))) as never; });
    await expect(t.artifacts.ingest(...t.args)).rejects.not.toThrow("owned-private-secret");
  });
  it.each(["identity","project","tenant","actor"])("实际%s不匹配不能借用原任务", async variant => {
    const t = await fixture(); const args = [...t.args] as unknown as Parameters<typeof t.artifacts.ingest>;
    if (variant === "identity") args[4] = { ...args[4], leaseId: "other-lease" }; if(variant === "project") args[1] = "other-project";
    if(variant === "tenant" || variant === "actor") args[0] = { ...principal, ...(variant === "tenant" ? { tenantId: "other-tenant" } : { actorId: "other" }) };
    await expect(t.artifacts.ingest(...args)).rejects.toThrow(); expect(t.saved().productionImageArtifact).toBeUndefined();
  });
  it.each(["body","catalog","task","revoke","cancel","clock"])("%s 写后整份新资产回滚，原包和max预留保持", async phase => {
    const t = await fixture(), before = t.saved(), originalSave = t.f.store.save.bind(t.f.store), originalCatalog = t.f.store.saveCatalog.bind(t.f.store), originalBody = t.f.store.saveVerifiedImage.bind(t.f.store);
    if(phase === "body") vi.spyOn(t.f.store,"saveVerifiedImage").mockImplementation((r,b) => { originalBody(r,b); throw new Error("owned-private-secret"); });
    if(phase === "catalog") vi.spyOn(t.f.store,"saveCatalog").mockImplementation(c => { originalCatalog(c); throw new Error("owned-private-secret"); });
    if(["task","revoke","cancel","clock"].includes(phase)) vi.spyOn(t.f.store,"save").mockImplementation(s => { originalSave(s); if(phase === "task") throw new Error("owned-private-secret"); if(phase === "revoke") t.revoke(); if(phase === "clock") t.f.advance(-1); });
    const controller = new AbortController(); if(phase === "cancel") vi.spyOn(t.f.store,"saveCatalog").mockImplementation(c => { originalCatalog(c); controller.abort(); });
    await expect(t.artifacts.ingest(...t.args, controller.signal)).rejects.toThrow(); vi.restoreAllMocks();
    expect(t.saved()).toEqual(before); expect(t.f.store.load()!.budgets[0].reservedMinor).toBe(40);
    expect(t.f.store.loadCatalog()!.projects[0].assets.filter(a=>a.purpose === "generated")).toEqual([]);
    expect(t.f.store.loadProductionImageArtifact(principal.tenantId,"project-a","production-contract-fixture",t.args[3])).toBeNull();
  });
  it("坏图不是产物或零费用；zero-cap仍保留关系", async () => {
    const t = await fixture({ bad: true, cap: 0 }); const before=t.saved(); await expect(t.artifacts.ingest(...t.args)).rejects.toThrow(); expect(t.saved()).toEqual(before); expect(t.saved().jobReservations).toEqual([[t.args[3],0]]);
  });
  it.each(["revoke","input","constraint","cancel","time"])("解码await期间%s变更不能提交", async kind => {
    const t=await fixture({edit:true}), original=decoder.decodeStaticImage;
    vi.spyOn(decoder,"decodeStaticImage").mockImplementation(async (...args)=>{
      const value=await original(...args);
      if(kind === "revoke")t.revoke(); if(kind === "time")t.f.advance(-1);
      if(kind === "input" || kind === "constraint"){const c=t.f.store.loadCatalog()!;if(kind === "input")c.projects[0].assets[0].originalName="changed";else c.projects[0].constraints[0].brandRules.style="changed";t.f.store.transaction(()=>t.f.store.saveCatalog(c));}
      return value;
    });
    const controller=new AbortController(); if(kind === "cancel") vi.spyOn(protocolApi,"prepareProductionImageProtocol").mockImplementation(async ()=>{controller.abort();throw new Error("cancel");});
    const before=t.saved();await expect(t.artifacts.ingest(...t.args,controller.signal)).rejects.toThrow();expect(t.saved()).toEqual(before);expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("不合作解码超时占槽，结束后清字节，不提交迟到结果", async () => {
    const t=await fixture();const original=decoder.decodeStaticImage;let releases: (()=>void)[]=[],captured:Buffer[]=[];
    vi.spyOn(decoder,"decodeStaticImage").mockImplementation(async (...args)=>{captured.push(args[0]);await new Promise<void>(r=>releases.push(r));return original(...args);});
    const service=new ImageProductionArtifactHarness({...t.artifactOptions,timeoutMs:200});
    const work=[service.ingest(...t.args).catch(e=>e),service.ingest(...t.args).catch(e=>e)];
    await vi.waitFor(()=>expect(releases).toHaveLength(2));await Promise.all(work);await expect(service.ingest(...t.args)).rejects.toMatchObject({code:"production_image_artifact_busy"});
    releases.forEach(r=>r());await vi.waitFor(()=>expect(captured.every(b=>b.every(v=>v===0))).toBe(true));expect(t.saved().productionImageArtifact).toBeUndefined();expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("同文件第二连接与重启恢复原资产；不重建输入或新报价", async () => {
    const t=await fixture({edit:true}), record=await t.artifacts.ingest(...t.args);
    const store=new SqliteRunKernelStateStore(t.f.path,{productionResponseStorageEnabled:true,productionArtifactStorageEnabled:true});stores.push(store);
    let policy:ProductionImageLeasePolicy, artifacts:ImageProductionArtifactHarness, reconstruction:ImageProductionReconstructionHarness;
    const gate:ProductionImageLeasePolicy={usesStateStore:s=>policy.usesStateStore(s),authorizeScope:(p,j)=>policy.authorizeScope(p,j),validate:(p,e,k,b)=>policy.validate(p,e,k,b)};
    policy=createProductionImageLeaseFixturePolicy({leasePreparationEnabled:true,tenantId:principal.tenantId,stateStore:store,clock:t.f.clock,runAuthorizer:t.auth,providerAuthorizer:t.auth,assetAuthorizer:t.auth,pricePort:t.price});
    const kernel=new SqliteRunKernel({...t.kernelOptions,stateStore:store,clock:t.f.clock,authorizer:t.auth,budgets:store.load()!.budgets,productionImageLeasePolicy:gate,
      productionImageStartPolicy:{usesStateStore:s=>reconstruction?.usesStateStore(s)??false,authorizeScope:(p,j)=>reconstruction?.authorizeScope(p,j)??false,validateStart:(p,e,l,i)=>reconstruction?.validateStart(p,e,l,i)??false},
      productionImageResponsePolicy:{usesStateStore:s=>reconstruction?.responsePolicy.usesStateStore(s)??false,authorizeScope:(p,j)=>reconstruction?.responsePolicy.authorizeScope(p,j)??false,validateAttempt:(p,e,l,i,a)=>reconstruction?.responsePolicy.validateAttempt(p,e,l,i,a)??false,validateResult:(p,e,l,i,a,r)=>reconstruction?.responsePolicy.validateResult(p,e,l,i,a,r)??false},
      productionImageArtifactPolicy:{usesStateStore:s=>artifacts?.usesStateStore(s)??false,authorizeScope:(p,j)=>artifacts?.authorizeScope(p,j)??false,validateCommit:(p,r)=>artifacts?.validateCommit(p,r)??false}});
    reconstruction=new ImageProductionReconstructionHarness({reconstructionEnabled:true,startEnabled:true,responseHandlingEnabled:true,tenantId:principal.tenantId,stateStore:store,runKernel:kernel,clock:t.f.clock,leasePolicy:gate,fixtureTransport:{kind:"contract-fixture",realExecutionEnabled:false,send:t.send}});
    artifacts=new ImageProductionArtifactHarness({...t.artifactOptions,stateStore:store,runKernel:kernel});
    const prepare=vi.spyOn(protocolApi,"prepareProductionImageProtocol"),decode=vi.spyOn(decoder,"decodeStaticImage"),bytes=vi.spyOn(store,"loadVerifiedImageBytes");
    expect(await artifacts.ingest(...t.args)).toEqual(record);expect(prepare).not.toHaveBeenCalled();expect(decode).not.toHaveBeenCalled();expect(bytes.mock.calls.every(c=>c[2]===record.image.asset.id)).toBe(true);
    expect(store.load()!.budgets[0].reservedMinor).toBe(40);expect(t.send).toHaveBeenCalledTimes(1);
  });
  it.each(["missing","promise","rejected"])("存储/同库证明%s不能绕过私有读取", async kind => {
    const t=await fixture();
    if(kind === "missing")vi.spyOn(t.f.store,"supportsProductionImageArtifacts").mockReturnValue(false);
    else vi.spyOn(t.f.kernel,"usesStateStore").mockReturnValue((kind === "promise" ? Promise.resolve(true) : Promise.reject(new Error("owned-private-secret"))) as never);
    const read=vi.spyOn(t.f.store,"load");await expect(t.artifacts.ingest(...t.args)).rejects.toThrow();expect(read).not.toHaveBeenCalled();
  });
  it.each(["production_image_artifacts","production_image_artifact_presence"])("%s SQL实际故障回滚正文和谱系", async table => {
    const t=await fixture();db(t.f.path,d=>d.exec(`CREATE TRIGGER owned_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'owned-private-secret'); END;`));
    const before=t.saved();await expect(t.artifacts.ingest(...t.args)).rejects.not.toThrow("owned-private-secret");expect(t.saved()).toEqual(before);
    expect(t.f.store.verifiedImageBytes(principal.tenantId,"project-a")).toBe(0);expect(t.f.store.loadCatalog()!.projects[0].assets).toEqual([]);
  });
  it("原图读取后撤权清自有副本而不动原文件，不能落产物", async () => {
    const t=await fixture({edit:true}), original=t.f.store.loadVerifiedImageBytes.bind(t.f.store);let borrowed:Buffer|undefined;
    vi.spyOn(t.f.store,"loadVerifiedImageBytes").mockImplementation((...args)=>{const value=original(...args);if(value && args[2]==="source"){borrowed=value.body;t.denied.add("asset:write");}return value;});
    await expect(t.artifacts.ingest(...t.args)).rejects.toThrow();expect(borrowed?.every(v=>v===0)).toBe(true);vi.restoreAllMocks();expect(original(principal.tenantId,"project-a","source")!.body.some(v=>v!==0)).toBe(true);
  });
  it.each(["forward", "backward-after-progress", "deadline"])("同库写后时钟%s：正常推进可提交，倒退/超时回滚", async kind => {
    const t=await fixture(), save=t.f.store.save.bind(t.f.store), catalog=t.f.store.saveCatalog.bind(t.f.store), before=t.saved();
    vi.spyOn(t.f.store,"saveCatalog").mockImplementation(c=>{catalog(c);t.f.advance(10);});
    vi.spyOn(t.f.store,"save").mockImplementation(s=>{save(s);t.f.advance(kind === "forward" ? 1 : kind === "deadline" ? 5000 : -1);});
    if(kind === "forward") {
      const record=await t.artifacts.ingest(...t.args);expect(t.saved().productionImageArtifact).toEqual(record);
      expect(t.saved().productionImageResult).toEqual(before.productionImageResult);expect(t.saved().aggregate.ledger).toEqual(before.aggregate.ledger);
    } else { await expect(t.artifacts.ingest(...t.args)).rejects.toThrow();vi.restoreAllMocks();expect(t.saved()).toEqual(before); }
    expect(t.f.store.load()!.budgets[0].reservedMinor).toBe(40);expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("首时钟无效后恢复正常也拒绝，不读原包或泄漏处理槽", async () => {
    const t=await fixture();let first=true;
    const service=new ImageProductionArtifactHarness({...t.artifactOptions,clock:()=>{if(first){first=false;return NaN;}return t.f.clock();}});
    const read=vi.spyOn(t.f.store,"loadProductionImageResponse");await expect(service.ingest(...t.args)).rejects.toThrow();expect(read).not.toHaveBeenCalled();
    vi.restoreAllMocks();expect((await t.artifacts.ingest(...t.args)).validation).toBe("verified");
  });
  it("删去全部task响应/产物字段仍拒绝孤立谱系，不假装没有历史", async () => {
    const t=await fixture();await t.artifacts.ingest(...t.args);
    const s=t.f.store.load()!,b=s.batches[0];delete b.productionImageArtifact;delete b.productionImageArtifactFingerprint;delete b.productionImageResult;delete b.productionImageResultFingerprint;
    b.aggregate.jobs[0].outputAssetIds=[];b.aggregate.audit=b.aggregate.audit.filter(a=>!["production-image-artifact-verified","production-image-returned"].includes(a.eventType));
    t.f.store.transaction(()=>t.f.store.save(s));db(t.f.path,d=>d.exec("DELETE FROM production_image_responses; DELETE FROM production_image_response_presence"));
    await expect(t.artifacts.ingest(...t.args)).rejects.toThrow();expect(t.send).toHaveBeenCalledTimes(1);
  });
  it.each(["metadata","binary","record","catalog"])("共享%s容量不足不删除历史或释放预算", async kind => {
    const t = await fixture(); let service = t.artifacts;
    if(kind === "metadata" || kind === "binary") service = new ImageProductionArtifactHarness({ ...t.artifactOptions, ...(kind === "metadata" ? { maxMetadataBytes: t.f.store.imageMetadataBytes(principal.tenantId,"project-a") } : { maxProjectBytes: t.f.store.localImageBinaryBytes(principal.tenantId,"project-a") }) });
    if(kind === "record") vi.spyOn(t.f.store,"saveProductionImageArtifact").mockImplementation(()=>{throw new Error("capacity");});
    if(kind === "catalog") { const c=t.f.store.loadCatalog()!; const template={id:"owned",projectId:"project-a",kind:"document" as const,originalName:"owned",storageKey:"owned",mimeType:"text/plain",byteSize:0,createdAt:new Date(t.f.clock()).toISOString()}; c.projects[0].assets=Array.from({length:10000},(_,n)=>({...template,id:`owned-${n}`})); t.f.store.transaction(()=>t.f.store.saveCatalog(c)); }
    const before=t.saved(); await expect(service.ingest(...t.args)).rejects.toThrow(); expect(t.saved()).toEqual(before);
  });
  it("并发一次提交且关闭pending后不能另建许可；原记录不可覆盖", async () => {
    const t = await fixture(), result = await Promise.all([t.artifacts.ingest(...t.args),t.artifacts.ingest(...t.args)]); expect(result[0]).toEqual(result[1]);
    expect(t.saved().aggregate.audit.filter(a=>a.eventType === "production-image-artifact-verified")).toHaveLength(1);
    expect(t.artifacts.validateCommit(principal,result[0])).toBe(false);
    const changed={...result[0],image:{...result[0].image,verifiedBy:"other"}};
    expect(()=>t.f.store.transaction(()=>t.f.store.saveProductionImageArtifact(changed,t.output))).toThrow();
    expect(ProductionImageArtifactSchema.safeParse({...result[0],executionAuthorized:true}).success).toBe(false);
  });
  it.each(["marker","body","lineage","catalog","task","audit","orphan"])("%s损坏/部分重算SHA失败关闭，不重新解码补发", async kind => {
    const t=await fixture(), r=await t.artifacts.ingest(...t.args);
    if(kind === "marker") db(t.f.path,d=>d.exec("DELETE FROM production_image_artifact_presence"));
    if(kind === "body") db(t.f.path,d=>d.prepare("UPDATE verified_images SET body=? WHERE asset_id=?").run(Buffer.from("broken"),r.image.asset.id));
    if(kind === "lineage") db(t.f.path,d=>{ const record={...r,draft:{...r.draft,responseFingerprint:"0".repeat(64)}}; const payload=JSON.stringify(record); d.prepare("UPDATE production_image_artifacts SET record=?,record_sha256=?").run(payload,sha(Buffer.from(payload))); d.prepare("UPDATE production_image_artifact_presence SET record_sha256=?").run(sha(Buffer.from(payload))); });
    if(kind === "catalog") {const c=t.f.store.loadCatalog()!; c.projects[0].assets.find(a=>a.id===r.image.asset.id)!.width=1;t.f.store.transaction(()=>t.f.store.saveCatalog(c));}
    if(["task","audit","orphan"].includes(kind)){const s=t.f.store.load()!,b=s.batches[0];if(kind === "task")b.productionImageArtifactFingerprint="0".repeat(64); if(kind === "audit")b.aggregate.audit=b.aggregate.audit.filter(a=>a.eventType!=="production-image-artifact-verified"); if(kind === "orphan"){delete b.productionImageArtifact;delete b.productionImageArtifactFingerprint;b.aggregate.jobs[0].outputAssetIds=[];b.aggregate.audit=b.aggregate.audit.filter(a=>a.eventType!=="production-image-artifact-verified");} t.f.store.transaction(()=>t.f.store.save(s));}
    const prepare=vi.spyOn(protocolApi,"prepareProductionImageProtocol"),decode=vi.spyOn(decoder,"decodeStaticImage");await expect(t.artifacts.ingest(...t.args)).rejects.toThrow();expect(prepare).not.toHaveBeenCalled();expect(decode).not.toHaveBeenCalled();expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("v7增量迁移保留原包与用户表，v8缺表和未来版本拒绝", async () => {
    const t=await fixture(); db(t.f.path,d=>d.exec("DROP TABLE production_image_artifacts; DROP TABLE production_image_artifact_presence; CREATE TABLE owned_user_data(value TEXT); INSERT INTO owned_user_data VALUES('preserve'); PRAGMA user_version=7"));
    const s=new SqliteRunKernelStateStore(t.f.path,{productionArtifactStorageEnabled:true,productionResponseStorageEnabled:true});stores.push(s);
    expect(s.load()).toEqual(t.f.store.load());db(t.f.path,d=>{expect(d.prepare("PRAGMA user_version").get()!.user_version).toBe(8);expect(d.prepare("SELECT value FROM owned_user_data").get()!.value).toBe("preserve");d.exec("DROP TABLE production_image_artifact_presence");});
    expect(()=>new SqliteRunKernelStateStore(t.f.path)).toThrow();db(t.f.path,d=>d.exec("PRAGMA user_version=9"));expect(()=>new SqliteRunKernelStateStore(t.f.path)).toThrow();
  });
});
