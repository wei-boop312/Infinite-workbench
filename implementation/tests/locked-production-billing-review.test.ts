import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { LockedProductionImageBillingReviewSchema, LockedProductionImageBillingSnapshotSchema, ReviewLockedProductionImageBillingSchema,
  ProductionImageBillingReviewSchema, ProductionImageBillingSnapshotSchema, ReviewProductionImageBillingSchema,
  type LockedProductionImageBillingSnapshot } from "../packages/contracts/src/index";
import { LockedImageProductionBillingReviewHarness, LockedProductionImageBillingReviewService, type LockedBillingSourceContext } from "../apps/api/src/lockedProductionImageBillingReview";
import { LockedImageProductionArtifactHarness } from "../apps/api/src/lockedProductionImageTaskArtifacts";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { createLockedTaskFixture, prepareLockedTaskFixture, lockedResponse } from "./helpers/locked-production-task-fixture";
import { assetMetadataFingerprint } from "../apps/api/src/assetMetadata";
import { principal, sha } from "./helpers/image-task-fixture";
import { imageSnapshotFingerprint as fp } from "../apps/api/src/imageProviderContract";
import * as decoder from "../apps/api/src/staticImageDecoder";
import * as protocol from "../apps/api/src/lockedProductionImageProtocol";
import * as pixels from "../apps/api/src/lockedImagePixelValidation";
import * as reads from "../apps/api/src/lockedProductionImageBillingRead";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp"), reviewer = { ...principal, actorId: "independent-billing-reader" };
let source: Buffer, mask: Buffer;
const owned: { cleanup(): void }[] = [], stores: SqliteRunKernelStateStore[] = [];
beforeAll(async () => { const png = (v: number[]) => sharp(Buffer.from(v), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  source = await png([40,70,90,255,1,2,3,255]); mask = await png([255,255,255,0,255,255,255,255]); });
afterEach(() => { vi.restoreAllMocks(); for (const s of stores.splice(0).reverse()) s.close(); for (const f of owned.splice(0).reverse()) f.cleanup(); });
async function fixture(opts: Parameters<typeof prepareLockedTaskFixture>[2] = {}, image = true, bad = false) {
  let artifact: LockedImageProductionArtifactHarness;
  const policy = { usesStateStore: (s: unknown) => artifact.usesStateStore(s), authorizeScope: (p: typeof principal, j: string) => artifact.authorizeScope(p,j),
    validateCommit: (p: typeof principal, r: any) => artifact.validateCommit(p,r) };
  const f = await prepareLockedTaskFixture(source,mask,{...opts,send: async () => bad ? { ...lockedResponse(source), body: Buffer.from("{broken") } : lockedResponse(source),
    kernel: { lockedProductionImageArtifactPolicy: policy } }); owned.push(f);
  artifact = new LockedImageProductionArtifactHarness({lockedArtifactEnabled:true,tenantId:principal.tenantId,stateStore:f.store,runKernel:f.kernel,clock:f.clock,
    runAuthorizer:f.authorizer,providerAuthorizer:f.authorizer,assetAuthorizer:f.authorizer,lockedArtifactPolicy:()=>true});
  if (opts.production) { await f.start(); f.advance(30000); f.kernel.reconcileLockedProductionImageBatch(principal,"project-a",f.v.batchId); }
  else { await f.execute(); if(image && !bad) await artifact.ingest(principal,"project-a",f.v.batchId,f.v.jobId,f.input); }
  const denied = new Set<string>(); let allow: unknown = true, gate: unknown = true;
  const auth = { authenticate:()=>reviewer, allows: (p: typeof principal, project: string, permission: string) =>
    p.tenantId === principal.tenantId && p.actorId === reviewer.actorId && project === "project-a" && !denied.has(permission) ? allow as boolean : false };
  const billingSource = { kind: opts.production ? "server-billing" : "contract-fixture", realExecutionEnabled:false,
    verify:vi.fn((c: LockedBillingSourceContext): unknown => c.principal.actorId === reviewer.actorId && c.request.evidence.sourceId === "owned-billing"
      && c.request.evidence.sourceVersion === "owned-v1" && c.request.evidence.evidenceRef === "owned-not-real-bill" && c.snapshotFingerprint === fp(c.snapshot)) };
  const options = {lockedBillingReviewEnabled:true as const,tenantId:principal.tenantId,stateStore:f.store,runKernel:f.kernel,clock:f.clock,
    runAuthorizer:auth,providerAuthorizer:auth,assetAuthorizer:auth,billingSource:billingSource as any,lockedBillingReviewPolicy:()=>gate as boolean};
  const review = opts.production ? new LockedProductionImageBillingReviewService(options) : new LockedImageProductionBillingReviewHarness(options);
  return {...f,review,options,billingSource,denied,gate:(v:unknown)=>{gate=v;},allow:(v:unknown)=>{allow=v;},args:[reviewer,"project-a",f.v.batchId,f.v.jobId] as const};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function request(s: LockedProductionImageBillingSnapshot, cost=25) {
  return {reviewId:"owned-review",expectedSnapshotFingerprint:fp(s),expectedProtectionPolicyFingerprint:s.protectionPolicyFingerprint,
    expectedCurrency:s.currency,expectedReservedMinor:s.reservedMinor,expectedMaxCostMinor:s.maxCostMinor,resolution:cost ? "charged" as const : "not-charged" as const,actualCostMinor:cost,
    evidence:{sourceId:"owned-billing",sourceVersion:"owned-v1",evidenceRef:"owned-not-real-bill",checksumSha256:"1".repeat(64),observedAt:s.unknownAt}};
}
function sql(t:Fixture, action:(d:DatabaseSync)=>void) { const d=new DatabaseSync(t.path);try{action(d);}finally{d.close();} }
const combinations = (["openai","openai-compatible"] as const).flatMap(p=>[false,true].flatMap(manual=>[false,true].map(image=>[p,manual,image] as const)));
describe.each(combinations)("protected billing read %s/manual=%s/image=%s",(p,manual,image)=>{
  let t:Fixture; beforeEach(async()=>{t=await fixture({protocol:p,manual},image);});
  it("完整原保护证据与人工来源核验，不结算或借运行权限",()=>{
    for(const p of ["run:execute","run:create","run:confirm","asset:write","run:approve-billing-overage"])t.denied.add(p);
    const before=t.store.load(),cat=t.store.loadCatalog(),save=vi.spyOn(t.store,"save"),decode=vi.spyOn(decoder,"decodeStaticImage"),native=vi.spyOn(decoder,"decodeStaticImagePixels"),
      wire=vi.spyOn(protocol,"prepareLockedProductionImageProtocol"),pixel=vi.spyOn(pixels,"verifyLockedImagePixels");
    t.pricePort.read.mockClear();t.pricePort.verify.mockClear();
    const s=t.review.inspect(...t.args),r=t.review.verify(...t.args,request(s));
    expect(s.estimate).toEqual(manual?{state:"unknown"}:{state:"known",estimatedCostMinor:25});
    expect(s.protectionPolicyFingerprint).toBe(fp(t.preparation.protectionPolicy));expect(s.originalActorId).toBe("writer");expect(r.reviewedBy).toBe(reviewer.actorId);
    expect(s.artifactFingerprint).toBe(image?fp(before!.batches[0].lockedProductionImageArtifact):null);expect(!!s.pixelProofFingerprint).toBe(image);
    expect(r).toMatchObject({schemaVersion:2,validation:"verified-uncommitted",settlementCommitted:false,settlementAuthorized:false,executionAuthorized:false,realExecutionEnabled:false});
    expect(LockedProductionImageBillingReviewSchema.parse(r)).toEqual(r);expect(ProductionImageBillingReviewSchema.safeParse(r).success).toBe(false);
    expect(ProductionImageBillingSnapshotSchema.safeParse(s).success).toBe(false);expect(t.billingSource.verify).toHaveBeenCalledTimes(1);
    expect(t.store.load()).toEqual(before);expect(t.store.loadCatalog()).toEqual(cat);expect(save).not.toHaveBeenCalled();expect(decode).not.toHaveBeenCalled();expect(native).not.toHaveBeenCalled();
    expect(wire).not.toHaveBeenCalled();expect(pixel).not.toHaveBeenCalled();expect(t.pricePort.read).not.toHaveBeenCalled();expect(t.pricePort.verify).not.toHaveBeenCalled();expect(t.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s)).not.toMatch(/https:|data:|base64|credentialRef|idempotencyKey|原人工锁区指令/);
  });
});
describe("protected billing actual authority and recovery",()=>{
  let t:Fixture;beforeEach(async()=>{t=await fixture({manual:true});});
  it.each(["run:read","run:reconcile-billing","provider:read","asset:read"])("%s读取前拒绝",p=>{
    t.denied.add(p);const read=vi.spyOn(t.store,"load"),raw=vi.spyOn(t.store,"loadLockedProductionImageResponse");expect(()=>t.review.inspect(...t.args)).toThrow();expect(read).not.toHaveBeenCalled();expect(raw).not.toHaveBeenCalled();
  });
  it.each([false,undefined,1,Promise.resolve(true)])("独立范围政策严格同步true %s",v=>{t.gate(v);const read=vi.spyOn(t.store,"load");expect(()=>t.review.inspect(...t.args)).toThrow();expect(read).not.toHaveBeenCalled();});
  it("默认关闭/模式/错误同路径实例/关闭原包与产物开关",()=>{
    const read=vi.spyOn(t.store,"load");expect(()=>new LockedProductionImageBillingReviewService().inspect(...t.args)).toThrow();
    expect(()=>new LockedImageProductionBillingReviewHarness().inspect(...t.args)).toThrow();
    expect(()=>new LockedImageProductionBillingReviewHarness({...t.options,lockedBillingReviewEnabled:false} as never).inspect(...t.args)).toThrow();
    expect(()=>new LockedProductionImageBillingReviewService(t.options).inspect(...t.args)).toThrow();expect(read).not.toHaveBeenCalled();
    const other=new SqliteRunKernelStateStore(t.path,{productionResponseStorageEnabled:true,productionArtifactStorageEnabled:true});stores.push(other);
    const privateRead=vi.spyOn(other,"load");expect(()=>new LockedImageProductionBillingReviewHarness({...t.options,stateStore:other}).inspect(...t.args)).toThrow();expect(privateRead).not.toHaveBeenCalled();
    vi.spyOn(t.store,"supportsProductionImageArtifacts").mockReturnValue(false);expect(()=>t.review.inspect(...t.args)).toThrow();expect(read).not.toHaveBeenCalled();
    vi.restoreAllMocks();vi.spyOn(t.store,"supportsProductionImageResponses").mockReturnValue(false);expect(()=>t.review.inspect(...t.args)).toThrow();
  });
  it.each(["tenant","project","batch","job"])("%s范围错配不能获取完整核账证据",kind=>{
    const a=[...t.args] as unknown as Parameters<typeof t.review.inspect>;
    if(kind==="tenant")a[0]={...reviewer,tenantId:"other"};if(kind==="project")a[1]="other";if(kind==="batch")a[2]="other";if(kind==="job")a[3]="other";
    expect(()=>t.review.inspect(...a)).toThrow();expect(t.billingSource.verify).not.toHaveBeenCalled();
  });
  it.each(["hash","policy","currency","reserved","max"])("人工%s期待漂移不调用费用来源",kind=>{
    const r=request(t.review.inspect(...t.args));if(kind==="hash")r.expectedSnapshotFingerprint="0".repeat(64);if(kind==="policy")r.expectedProtectionPolicyFingerprint="0".repeat(64);
    if(kind==="currency")r.expectedCurrency="USD";if(kind==="reserved")r.expectedReservedMinor++;if(kind==="max")r.expectedMaxCostMinor++;
    expect(()=>t.review.verify(...t.args,r)).toThrow();expect(t.billingSource.verify).not.toHaveBeenCalled();
  });
  it.each(["false","promise","rejected","truthy","private-error","source"])("可信来源%s不能由图片/标签证明",kind=>{
    const r=request(t.review.inspect(...t.args)),before=t.store.load();
    t.billingSource.verify.mockImplementation(()=>{if(kind==="private-error")throw new Error("owned-secret");return kind==="false"?false:kind==="truthy"?1:kind==="promise"?Promise.resolve(true):kind==="rejected"?Promise.reject(new Error("owned-secret")):true;});
    if(kind==="source"){r.evidence.sourceId="not-authorized";t.billingSource.verify.mockImplementation(c=>c.request.evidence.sourceId==="owned-billing");}
    expect(()=>t.review.verify(...t.args,r)).toThrow();expect(()=>t.review.verify(...t.args,r)).not.toThrow("owned-secret");expect(t.store.load()).toEqual(before);
  });
  it("来源只获得深复制完整上下文",()=>{
    const s=t.review.inspect(...t.args),r=request(s),before=t.store.load();t.billingSource.verify.mockImplementation(c=>{c.snapshot.originalActorId="forged";c.snapshot.protectionPolicyFingerprint="0".repeat(64);c.request.actualCostMinor=999;c.principal.actorId="forged";return true;});
    expect(t.review.verify(...t.args,r).request).toEqual(r);expect(r.actualCostMinor).toBe(25);expect(t.store.load()).toEqual(before);
  });
  it.each(["revoke","constraint","input","task","budget","backward","deadline","kernel-function","kernel-store","kernel-config"])("来源后%s漂移回滚同库副作用",kind=>{
    const r=request(t.review.inspect(...t.args)),before=t.store.load(),cat=t.store.loadCatalog();
    t.billingSource.verify.mockImplementation(()=>{
      if(kind==="revoke")t.denied.add("run:reconcile-billing");if(kind==="backward")t.advance(-1);if(kind==="deadline")t.advance(5000);
      if(kind==="constraint"||kind==="input"){const c=t.store.loadCatalog()!;if(kind==="input")c.projects[0].assets[0].originalName="changed";else c.projects[0].constraints[0].brandRules.style="changed";t.store.saveCatalog(c);}
      if(kind==="task"||kind==="budget"){const x=t.store.load()!;if(kind==="task")x.batches[0].aggregate.jobs[0].leaseOwnerId="changed";else x.budgets[0].limitMinor++;t.store.save(x);}
      if(kind==="kernel-function")t.kernel.usesStateStore=()=>true;
      if(kind==="kernel-store")(t.kernel as any).options.stateStore=new SqliteRunKernelStateStore(":memory:");
      if(kind==="kernel-config")(t.kernel as any).options.leaseDurationMs=60000;
      return true;});
    try{expect(()=>t.review.verify(...t.args,r)).toThrow();expect(t.store.load()).toEqual(before);expect(t.store.loadCatalog()).toEqual(cat);}
    finally{if(kind==="kernel-store"){(t.kernel as any).options.stateStore.close();(t.kernel as any).options.stateStore=t.store;}}
  });
  it.each(["raw-marker","raw-body","artifact-marker","artifact-body","policy","proof","audit","orphan-artifact"])("%s损坏拒绝",kind=>{
    const x=t.store.load()!,s=x.batches[0],a=s.lockedProductionImageArtifact!;
    if(kind==="raw-marker")sql(t,d=>d.exec("DELETE FROM production_image_response_presence"));if(kind==="raw-body")sql(t,d=>d.prepare("UPDATE production_image_responses SET body=?").run(Buffer.from("broken")));
    if(kind==="artifact-marker")sql(t,d=>d.exec("DELETE FROM production_image_artifact_presence"));if(kind==="artifact-body")sql(t,d=>d.prepare("UPDATE verified_images SET body=? WHERE asset_id=?").run(Buffer.from("broken"),a.image.asset.id));
    if(["policy","proof","audit","orphan-artifact"].includes(kind)){
      if(kind==="policy")delete (s.lockedProductionImageExecution!.preparation as any).protectionPolicy;
      if(kind==="proof"){delete (a.draft as any).pixelProof;s.lockedProductionImageArtifactFingerprint=fp(a);}
      if(kind==="audit")s.aggregate.audit=s.aggregate.audit.filter(a=>a.eventType!=="billing-unknown");
      if(kind==="orphan-artifact"){delete s.lockedProductionImageArtifact;delete s.lockedProductionImageArtifactFingerprint;s.aggregate.jobs[0].outputAssetIds=[];s.aggregate.audit=s.aggregate.audit.filter(a=>a.eventType!=="production-image-artifact-verified");}
      if(kind==="proof"||kind==="policy"){const json=JSON.stringify(x);sql(t,d=>d.prepare("UPDATE kernel_state SET payload=?,sha256=? WHERE kind='runs'").run(json,sha(Buffer.from(json))));}
      else t.store.transaction(()=>t.store.save(x));
    }expect(()=>t.review.inspect(...t.args)).toThrow();expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("原包读后撤权清零自有副本，不改持久原包",()=>{
    const original=t.store.loadLockedProductionImageResponse.bind(t.store);let body:Buffer|undefined;
    vi.spyOn(t.store,"loadLockedProductionImageResponse").mockImplementation((...a)=>{const r=original(...a);body=r?.body;t.denied.add("asset:read");return r;});
    expect(()=>t.review.inspect(...t.args)).toThrow();expect(body!.every(v=>v===0)).toBe(true);vi.restoreAllMocks();const r=original(principal.tenantId,"project-a","production-contract-fixture",t.v.jobId)!;expect(r.body.some(v=>v!==0)).toBe(true);r.body.fill(0);
  });
  it("读后当前输入约束漂移整体回滚",()=>{
    const original=t.store.loadLockedProductionImageResponse.bind(t.store),cat=t.store.loadCatalog();
    vi.spyOn(t.store,"loadLockedProductionImageResponse").mockImplementation((...a)=>{const r=original(...a),c=t.store.loadCatalog()!;c.projects[0].constraints[0].brandRules.style="changed";t.store.saveCatalog(c);return r;});
    expect(()=>t.review.inspect(...t.args)).toThrow();expect(t.store.loadCatalog()).toEqual(cat);
  });
  it("历史过期停用/第二实际SQLite重启，不重新价格/解码/发送",()=>{
    const s=t.review.inspect(...t.args),before=t.store.load();t.advance(90000);t.register({...t.config,revision:2,enabled:false});t.pricePort.read.mockClear();t.pricePort.verify.mockClear();
    expect(t.review.inspect(...t.args)).toEqual(s);const second=new SqliteRunKernelStateStore(t.path,{productionArtifactStorageEnabled:true,productionResponseStorageEnabled:true});stores.push(second);
    const kernel=new SqliteRunKernel({stateStore:second,authorizer:t.options.runAuthorizer,budgets:[{tenantId:principal.tenantId,projectId:"project-a",currency:"CNY",limitMinor:1000}],clock:t.clock});
    const reader=new LockedImageProductionBillingReviewHarness({...t.options,stateStore:second,runKernel:kernel});expect(reader.inspect(...t.args)).toEqual(s);
    expect(reader.verify(...t.args,request(s))).toEqual(t.review.verify(...t.args,request(s)));expect(t.store.load()).toEqual(before);expect(t.pricePort.read).not.toHaveBeenCalled();expect(t.pricePort.verify).not.toHaveBeenCalled();expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("元数据及无效时钟在原包前拒绝",()=>{
    const raw=vi.spyOn(t.store,"loadLockedProductionImageResponse");for(const extra of [{maxMetadataBytes:0},{clock:()=>NaN}])expect(()=>new LockedImageProductionBillingReviewHarness({...t.options,...extra}).inspect(...t.args)).toThrow();expect(raw).not.toHaveBeenCalled();
  });
  it("旧草稿/客户端确认/空证据/非法费用不能授权或变成旧核账",()=>{
    const s=t.review.inspect(...t.args),r=request(s),draft=t.review.verify(...t.args,r),before=t.store.load();
    expect(ReviewProductionImageBillingSchema.safeParse(r).success).toBe(false);expect(LockedProductionImageBillingReviewSchema.safeParse({...draft,settlementCommitted:true}).success).toBe(false);
    for(const v of [{...r,confirmed:true},{...r,resolution:"not-charged"},{...r,actualCostMinor:Number.MAX_SAFE_INTEGER+1},{...r,evidence:{...r.evidence,evidenceRef:"https://private.invalid/bill"}}])expect(ReviewLockedProductionImageBillingSchema.safeParse(v).success).toBe(false);
    expect(LockedProductionImageBillingSnapshotSchema.safeParse({...s,pixelProofFingerprint:null}).success).toBe(false);
    expect(()=>t.kernel.resolveBillingUnknown(principal,t.v.jobId,{resolutionId:"legacy",resolution:"not-charged",expectedReservedMinor:40,expectedCurrency:"CNY",evidenceRef:"not-authorized"})).toThrow();expect(t.store.load()).toEqual(before);
  });
  it.each(["before-unknown","future"])("人工观察%s在费用端口前拒绝",kind=>{
    const s=t.review.inspect(...t.args),r=request(s);r.evidence.observedAt=new Date(kind==="future"?t.clock()+1:Date.parse(s.unknownAt)-1).toISOString();
    expect(()=>t.review.verify(...t.args,r)).toThrow();expect(t.billingSource.verify).not.toHaveBeenCalled();
  });
  it.each(["single","edge","pixels"])("当前权威%s声明在原图BLOB前拒绝",kind=>{
    const cat=t.store.loadCatalog()!,a=cat.projects[0].assets;
    if(kind==="single")a[0].byteSize=30*1024*1024+1;
    if(kind==="edge")a[0].width=8193;if(kind==="pixels"){a[0].width=4096;a[0].height=4096;}
    t.store.transaction(()=>t.store.saveCatalog(cat));const blob=vi.spyOn(t.store,"loadVerifiedImage"),raw=vi.spyOn(t.store,"loadLockedProductionImageResponse");
    expect(()=>t.review.inspect(...t.args)).toThrow();expect(blob).not.toHaveBeenCalled();expect(raw).not.toHaveBeenCalled();
  });
  it("三实际原输入各低于30MiB但合计超过64MiB仍在BLOB前拒绝",async()=>{
    const f=createLockedTaskFixture(source,mask,{manual:true});owned.push(f);
    const original=f.store.loadVerifiedImage(principal.tenantId,"project-a","source")!,asset={...original.asset,id:"source-b",storageKey:"owned:source-b"};
    const receipt={...original,id:"receipt-source-b",asset,registeredMetadataSha256:assetMetadataFingerprint(asset)};
    f.store.transaction(()=>{f.store.saveVerifiedImage(receipt,source);const c=f.store.loadCatalog()!;c.projects[0].assets.push(asset);f.store.saveCatalog(c);});
    const prep=await f.service.createPreparation(principal,{...f.select(),inputAssetIds:["source","source-b"]}),
      p=f.store.loadLockedProductionImagePreparation(principal.tenantId,"project-a","production-contract-fixture",prep.id)!,v=await f.confirm(p);
    const l=f.kernel.claimLockedProductionImageBatch(principal,"project-a",v.batchId,{workerId:"owned-worker",maxJobs:1}).leases[0];
    await f.reconstruction.executeFixture(principal,"project-a",v.batchId,v.jobId,{workerId:l.workerId,leaseId:l.leaseId});
    f.store.transaction(()=>{const c=f.store.loadCatalog()!;for(const a of c.projects[0].assets)a.byteSize=22*1024*1024;f.store.saveCatalog(c);});
    const blob=vi.spyOn(f.store,"loadVerifiedImage"),raw=vi.spyOn(f.store,"loadLockedProductionImageResponse"),read=new LockedImageProductionBillingReviewHarness({...t.options,stateStore:f.store,runKernel:f.kernel,clock:f.clock});
    expect(()=>read.inspect(reviewer,"project-a",v.batchId,v.jobId)).toThrow();expect(blob).not.toHaveBeenCalled();expect(raw).not.toHaveBeenCalled();
  });
  it("删全部task result重算合法unknown仍拒绝孤立原包",()=>{
    const x=t.store.load()!,s=x.batches[0],j=s.aggregate.jobs[0];t.advance(30000);
    delete s.lockedProductionImageArtifact;delete s.lockedProductionImageArtifactFingerprint;j.outputAssetIds=[];
    delete s.lockedProductionImageResult;delete s.lockedProductionImageResultFingerprint;j.finishedAt=new Date(t.clock()).toISOString();j.failureCode="locked-lease-expired-after-intent";
    s.aggregate.audit=s.aggregate.audit.filter(a=>!["production-image-returned","production-image-artifact-verified"].includes(a.eventType));
    const unknown=s.aggregate.audit.find(a=>a.eventType==="billing-unknown")!;unknown.createdAt=j.finishedAt;unknown.metadata.reason=j.failureCode;
    s.aggregate.ledger.find(l=>l.settlement==="unknown")!.createdAt=j.finishedAt;t.store.transaction(()=>t.store.save(x));
    expect(()=>t.kernel.validateProductionBillingSnapshot(x)).not.toThrow();expect(()=>t.review.inspect(...t.args)).toThrow();
  });
  it("最后权限回调漂移不能绕过最后纯读取",()=>{
    const original=reads.readLockedProductionBillingEvidence;let ready=false;
    vi.spyOn(reads,"readLockedProductionBillingEvidence").mockImplementation((...args)=>{const r=original(...args);ready=true;return r;});
    const cat=t.store.loadCatalog(),read=new LockedImageProductionBillingReviewHarness({...t.options,lockedBillingReviewPolicy:()=>{
      if(ready){const c=t.store.loadCatalog()!;c.projects[0].constraints[0].brandRules.style="changed-after-last-auth";t.store.saveCatalog(c);}return true;}});
    expect(()=>read.inspect(...t.args)).toThrow();expect(t.store.loadCatalog()).toEqual(cat);
  });
  it.each(["deadline","cancel"])("最后纯读取%s不能成功返回证据",kind=>{
    const original=reads.readLockedProductionBillingEvidence,controller=new AbortController();let calls=0;
    vi.spyOn(reads,"readLockedProductionBillingEvidence").mockImplementation((...args)=>{const r=original(...args);if(++calls===2){if(kind==="deadline")t.advance(5000);else controller.abort();}return r;});
    const before=t.store.load();expect(()=>t.review.inspect(...t.args,controller.signal)).toThrow();expect(t.store.load()).toEqual(before);
  });
  it("可信来源期间取消，原请求/任务/预留保持",()=>{
    const s=t.review.inspect(...t.args),r=request(s),controller=new AbortController(),before=t.store.load();
    t.billingSource.verify.mockImplementation(()=>{controller.abort();return true;});expect(()=>t.review.verify(...t.args,r,controller.signal)).toThrow();expect(t.store.load()).toEqual(before);
  });
  it("正常毫秒推进允许，纯历史恢复不核像素或保存",()=>{
    const s=t.review.inspect(...t.args);t.billingSource.verify.mockImplementation(()=>{t.advance(1);return true;});
    expect(t.review.verify(...t.args,request(s)).reviewedAt).toBe(new Date(t.clock()).toISOString());
  });
});
describe("protected known/unknown non-connected production and zero-cap",()=>{
  it.each(["multipart-image-array","multipart-image-single"] as const)("原%s完整历史可独立核账，不重建wire",async encoding=>{
    const t=await fixture({protocol:"openai-compatible",encoding,manual:true}),before=t.store.load(),wire=vi.spyOn(protocol,"prepareLockedProductionImageProtocol");
    const s=t.review.inspect(...t.args),r=t.review.verify(...t.args,request(s));expect(r.snapshot.taskEvidenceFingerprint).toBe(fp(before!.batches[0]));
    expect(wire).not.toHaveBeenCalled();expect(t.store.load()).toEqual(before);expect(t.send).toHaveBeenCalledTimes(1);
  });
  it.each([false,true])("从头生产工厂manual=%s，只凭独立假来源核费用，不推零费",async manual=>{
    const t=await fixture({production:true,manual},false),s=t.review.inspect(...t.args),before=t.store.load();
    expect(s).toMatchObject({mode:"production",attemptFingerprint:null,resultFingerprint:null,artifactFingerprint:null,pixelProofFingerprint:null});
    const r=t.review.verify(...t.args,request(s,0));expect(r.sourceKind).toBe("server-billing");expect(r.settlementCommitted).toBe(false);expect(t.store.load()).toEqual(before);expect(t.send).not.toHaveBeenCalled();
  });
  it("zero-cap无图好坏图与超预留，不结算或推估价0",async()=>{
    const t=await fixture({manual:true,cap:0},false,true),s=t.review.inspect(...t.args),before=t.store.load();
    expect(s.estimate).toEqual({state:"unknown"});expect(s.pixelProofFingerprint).toBeNull();expect(t.review.verify(...t.args,request(s,0)).requiresIndependentOverageApproval).toBe(false);
    expect(t.review.verify(...t.args,request(s,1)).requiresIndependentOverageApproval).toBe(true);expect(t.store.load()).toEqual(before);expect(before!.batches[0].jobReservations).toEqual([[t.v.jobId,0]]);
  });
});
