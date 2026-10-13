import { createRequire } from "node:module";
import { request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { LockedProductionGeneratedAssetLineageSchema, ProductionGeneratedAssetLineageSchema, ProductionGeneratedAssetMetadataSchema, GeneratedAssetLineageSchema } from "../packages/contracts/src/index";
import { LockedImageProductionGeneratedAssetReadHarness, LockedProductionGeneratedAssetReads } from "../apps/api/src/lockedProductionGeneratedAssetReads";
import { handleLockedProductionGeneratedAssetHttp } from "../apps/api/src/lockedProductionGeneratedAssetHttp";
import { LockedImageProductionArtifactHarness } from "../apps/api/src/lockedProductionImageTaskArtifacts";
import { LockedImageProductionBillingReviewHarness } from "../apps/api/src/lockedProductionImageBillingReview";
import { LockedImageProductionBillingSettlementHarness } from "../apps/api/src/lockedProductionImageBillingSettlement";
import { ImageProductionGeneratedAssetReadHarness } from "../apps/api/src/productionGeneratedAssetReads";
import { LocalGeneratedAssetReads } from "../apps/api/src/generatedAssetReads";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { createApiServer } from "../apps/api/src/index";
import { acquireGeneratedTransfer } from "../apps/api/src/generatedTransferSlots";
import { prepareLockedTaskFixture } from "./helpers/locked-production-task-fixture";
import { principal, sha } from "./helpers/image-task-fixture";
import { imageSnapshotFingerprint as fp } from "../apps/api/src/imageProviderContract";
import { RunKernelError } from "../apps/api/src/runKernel";
import * as decoder from "../apps/api/src/staticImageDecoder";
import * as wire from "../apps/api/src/lockedProductionImageProtocol";
import * as pixels from "../apps/api/src/lockedImagePixelValidation";
import * as evidence from "../apps/api/src/lockedProductionImageBillingRead";
const sharp=createRequire(new URL("../apps/api/package.json",import.meta.url))("sharp");
const actor={...principal,actorId:"independent-asset-reader"},owned:{cleanup():void}[]=[],servers:Server[]=[],sockets:IncomingMessage[]=[];
let source:Buffer,mask:Buffer;
beforeAll(async()=>{const png=(v:number[])=>sharp(Buffer.from(v),{raw:{width:2,height:1,channels:4}}).png().toBuffer();
  source=await png([40,70,90,255,1,2,3,255]);mask=await png([255,255,255,0,255,255,255,255]);});
afterEach(async()=>{vi.useRealTimers();for(const r of sockets.splice(0))r.destroy();for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}
  vi.restoreAllMocks();for(const f of owned.splice(0).reverse())f.cleanup();});
async function fixture(opts:Parameters<typeof prepareLockedTaskFixture>[2]={},image=true){
  let artifacts:LockedImageProductionArtifactHarness;
  const f=await prepareLockedTaskFixture(source,mask,{...opts,kernel:{lockedProductionImageArtifactPolicy:{usesStateStore:s=>artifacts.usesStateStore(s),
    authorizeScope:(p,j)=>artifacts.authorizeScope(p,j),validateCommit:(p,r)=>artifacts.validateCommit(p,r)}}});owned.push(f);
  artifacts=new LockedImageProductionArtifactHarness({lockedArtifactEnabled:true,tenantId:principal.tenantId,stateStore:f.store,runKernel:f.kernel,clock:f.clock,
    runAuthorizer:f.authorizer,providerAuthorizer:f.authorizer,assetAuthorizer:f.authorizer,lockedArtifactPolicy:()=>true});
  if(opts.production){await f.start();f.advance(30000);f.kernel.reconcileLockedProductionImageBatch(principal,"project-a",f.v.batchId);}
  else {await f.execute();if(image)await artifacts.ingest(principal,"project-a",f.v.batchId,f.v.jobId,f.input);}
  const denied=new Set<string>(),auth={authenticate:()=>actor,allows:(p:typeof principal,project:string,permission:string)=>p.tenantId===principal.tenantId&&[actor.actorId,principal.actorId].includes(p.actorId)&&project==="project-a"&&!denied.has(permission)};
  const saved=()=>f.store.load()!.batches[0],id=()=>saved().lockedProductionImageArtifact!.image.asset.id;
  const options={lockedGeneratedReadEnabled:true as const,tenantId:principal.tenantId,stateStore:f.store,runKernel:f.kernel,clock:f.clock,
    assetAuthorizer:auth,runAuthorizer:auth,lockedGeneratedReadPolicy:vi.fn(()=>true)};
  return {...f,artifacts,denied,auth,saved,id,options};
}
type Task=Awaited<ReturnType<typeof fixture>>;
const reader=(t:Task)=>new LockedImageProductionGeneratedAssetReadHarness(t.options);
function unchanged(t:Task,before:unknown){expect(t.store.load()).toEqual(before);expect(t.send).toHaveBeenCalledTimes(1);}
function sql(t:Task,action:(db:DatabaseSync)=>void){const db=new DatabaseSync(t.path);try{action(db);}finally{db.close();}}
async function api(port?:LockedImageProductionGeneratedAssetReadHarness,configure?:(s:Server)=>void){
  const s=createApiServer({lockedProductionGeneratedAssets:port});servers.push(s);configure?.(s);await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));
  const a=s.address();if(!a||typeof a==="string")throw new Error();return `http://127.0.0.1:${a.port}`;
}
const uri=(asset:string,kind="content")=>`/v1/projects/project-a/locked-production-generated-assets/${asset}/${kind}`;
describe.each((["openai","openai-compatible"] as const).flatMap(protocol=>[false,true].map(manual=>[protocol,manual] as const)))("protected read %s/manual=%s",(protocol,manual)=>{
  let t:Task;beforeEach(async()=>{t=await fixture({protocol,manual});});
  it("原保护字节/完整公开谱系只读，另一身份不借执行核账权限",()=>{
    const r=reader(t),before=t.store.load(),asset=t.id();for(const p of ["run:execute","run:create","run:confirm","provider:read","run:reconcile-billing","run:approve-billing-overage","asset:write"])t.denied.add(p);
    t.pricePort.read.mockClear();t.pricePort.verify.mockClear();const native=vi.spyOn(decoder,"decodeStaticImagePixels"),pixel=vi.spyOn(pixels,"verifyLockedImagePixels"),prepare=vi.spyOn(wire,"prepareLockedProductionImageProtocol"),save=vi.spyOn(t.store,"save");
    const view=r.lineage(actor,"project-a",asset),content=r.read(actor,"project-a",asset);
    expect(content.body).toEqual(source);expect(content.metadata.image).toEqual(t.saved().lockedProductionImageArtifact!.image);
    expect(view).toMatchObject({schemaVersion:2,mode:"production-contract-fixture",jobStatus:"billing_unknown",requestDraft:{operation:"edit",protection:"pixel-exact"},
      protection:{domain:"fixed-rgba8-only",protectionApplied:"checked-not-applied",lockedPixels:1,editablePixels:1,lockedPixelsEqual:true},
      billing:{state:"unknown",estimatedMinor:manual?null:25,maxCostMinor:40,currentMaxCostMinor:40,reservedMinor:40}});
    expect(view.protection.policyFingerprint).toBe(fp(t.preparation.protectionPolicy));expect(view.protection.pixelProofFingerprint).toBe(fp(t.saved().lockedProductionImageArtifact!.draft.pixelProof));
    expect(view.preparationFingerprint).toBe(t.preparation.snapshotFingerprint);expect(view.billing.actualMinor).toBeUndefined();
    for(const schema of [ProductionGeneratedAssetLineageSchema,GeneratedAssetLineageSchema])expect(schema.safeParse(view).success).toBe(false);
    expect(ProductionGeneratedAssetMetadataSchema.safeParse(content.metadata).success).toBe(false);
    expect(JSON.stringify([view,content.metadata])).not.toMatch(/credentialRef|baseUrl|idempotencyKey|workerId|leaseId|leaseOwnerId|b64_json|owned:source|owned:mask/);
    view.constraint.brandRules.style="caller-only";content.body.fill(0);expect(r.read(actor,"project-a",asset).body).toEqual(source);expect(r.lineage(actor,"project-a",asset).constraint).toEqual(t.preparation.constraint);
    for(const spy of [native,pixel,prepare,save,t.pricePort.read,t.pricePort.verify])expect(spy).not.toHaveBeenCalled();unchanged(t,before);
  });
});
describe("protected read permission, whole-chain recovery and final guards",()=>{
  let t:Task;beforeEach(async()=>{t=await fixture({manual:true});});
  it("二进制仅asset:read，谱系另run:read，不改原worker/lease",()=>{
    const r=reader(t),before=t.store.load(),asset=t.id();t.denied.add("run:read");expect(r.read(actor,"project-a",asset).body).toEqual(source);
    expect(()=>r.lineage(actor,"project-a",asset)).toThrow();unchanged(t,before);
  });
  it.each(["asset:read","run:read"])("%s撤权在私有getter前拒绝",permission=>{
    const r=reader(t);t.denied.add(permission);const load=vi.spyOn(t.store,"load"),raw=vi.spyOn(t.store,"loadLockedProductionImageResponse");
    expect(()=>r.lineage(actor,"project-a","arbitrary")).toThrow();expect(load).not.toHaveBeenCalled();expect(raw).not.toHaveBeenCalled();
  });
  it("缺谱系政策不借旧权限，二进制独立可读",()=>{const r=new LockedImageProductionGeneratedAssetReadHarness({...t.options,runAuthorizer:undefined}),asset=t.id(),load=vi.spyOn(t.store,"load");
    expect(()=>r.lineage(actor,"project-a",asset)).toThrow();expect(load).not.toHaveBeenCalled();expect(r.read(actor,"project-a",asset).body).toEqual(source);});
  it.each([false,1,"true","promise","reject"])("同步独立政策%s必须严格true",value=>{
    const r=new LockedImageProductionGeneratedAssetReadHarness({...t.options,lockedGeneratedReadPolicy:()=> (value==="promise"?Promise.resolve(true):value==="reject"?Promise.reject(new Error("owned-private")):value) as never});
    const load=vi.spyOn(t.store,"load");expect(()=>r.read(actor,"project-a","arbitrary")).toThrow();expect(load).not.toHaveBeenCalled();
  });
  it.each(["tenant","project","actor","id"])("%s范围错误失败关闭",bad=>{
    const r=reader(t),load=vi.spyOn(t.store,"load");expect(()=>r.read(bad==="tenant"?{...actor,tenantId:"foreign"}:bad==="actor"?{...actor,actorId:""}:actor,bad==="project"?"foreign":"project-a",bad==="id"?"bad\n":"arbitrary")).toThrow();expect(load).not.toHaveBeenCalled();
  });
  it.each(["supportsProductionImageResponses","supportsProductionImageArtifacts"] as const)("关%s不能跳过原证据",method=>{
    const r=reader(t);vi.spyOn(t.store,method).mockReturnValue(false);const load=vi.spyOn(t.store,"load");expect(()=>r.read(actor,"project-a","any")).toThrow();expect(load).not.toHaveBeenCalled();
  });
  it("无配置/错同库实例/private error失败关闭",()=>{
    const load=vi.spyOn(t.store,"load");expect(()=>new LockedProductionGeneratedAssetReads().read(actor,"project-a","any")).toThrow();expect(load).not.toHaveBeenCalled();
    const second=new SqliteRunKernelStateStore(t.path,{productionResponseStorageEnabled:true,productionArtifactStorageEnabled:true});
    try{expect(()=>new LockedImageProductionGeneratedAssetReadHarness({...t.options,stateStore:second})).toThrow();}finally{second.close();}
    const r=new LockedImageProductionGeneratedAssetReadHarness({...t.options,lockedGeneratedReadPolicy:()=>{throw new RunKernelError(503,"locked_generated_asset_not_found","owned-private-clock-key");}});
    try{r.read(actor,"project-a","any");throw Error("expected failure");}catch(e){expect(String(e)).not.toContain("owned-private");}
  });
  it("外部选项重赋不改固定实例/租户，函数中途替换被拒绝",()=>{
    const opts={...t.options},r=new LockedImageProductionGeneratedAssetReadHarness(opts),asset=t.id();opts.tenantId="foreign";opts.stateStore=undefined as never;expect(r.read(actor,"project-a",asset).body).toEqual(source);
    const original=t.kernel.usesStateStore;t.options.lockedGeneratedReadPolicy.mockImplementation(()=>{t.kernel.usesStateStore=()=>true;return true;});
    expect(()=>r.read(actor,"project-a",asset)).toThrow();t.kernel.usesStateStore=original;
  });
  it("过期停用/第二实际SQLite重启只读，不保存恢复租约或消费价格",()=>{
    t.advance(100000);t.register({...t.config,revision:2,enabled:false});t.pricePort.read.mockClear();t.pricePort.verify.mockClear().mockReturnValue(false);
    const before=t.store.load(),r=reader(t),view=r.lineage(actor,"project-a",t.id()),second=new SqliteRunKernelStateStore(t.path,{productionResponseStorageEnabled:true,productionArtifactStorageEnabled:true});
    try{const kernel=new SqliteRunKernel({stateStore:second,authorizer:t.auth,budgets:before!.budgets,clock:t.clock}),other=new LockedImageProductionGeneratedAssetReadHarness({...t.options,stateStore:second,runKernel:kernel});
      const save=vi.spyOn(second,"save");expect(other.lineage(actor,"project-a",t.id())).toEqual(view);expect(other.read(actor,"project-a",t.id()).body).toEqual(source);expect(save).not.toHaveBeenCalled();}
    finally{second.close();}expect(t.pricePort.read).not.toHaveBeenCalled();expect(t.pricePort.verify).not.toHaveBeenCalled();unchanged(t,before);
  });
  it("production/旧none/local读者不能改标消费保护图",()=>{
    const asset=t.id();expect(()=>new LockedProductionGeneratedAssetReads(t.options).read(actor,"project-a",asset)).toThrow();
    expect(()=>new ImageProductionGeneratedAssetReadHarness({...t.options,generatedReadEnabled:true}).read(actor,"project-a",asset)).toThrow();
    expect(()=>new LocalGeneratedAssetReads({tenantId:principal.tenantId,stateStore:t.store,authorizer:t.auth}).read(actor,"project-a",asset)).toThrow();
  });
  it.each(["raw","raw-marker","artifact-marker","image","policy","proof","proof-sha","result","artifact"])("实际SQLite %s损坏拒绝",bad=>{
    const asset=t.id();
    if(bad==="raw")sql(t,db=>db.prepare("UPDATE production_image_responses SET body = ?").run(Buffer.from("{}")));
    else if(bad==="raw-marker")sql(t,db=>db.exec("DELETE FROM production_image_response_presence"));
    else if(bad==="artifact-marker")sql(t,db=>db.exec("DELETE FROM production_image_artifact_presence"));
    else if(bad==="image")sql(t,db=>db.prepare("UPDATE verified_images SET body = ? WHERE asset_id = ?").run(Buffer.from("bad"),asset));
    else{const s=t.store.load()!,b=s.batches[0];if(bad==="policy")delete (b.lockedProductionImageExecution!.preparation as any).protectionPolicy;
      else if(bad==="proof") {b.lockedProductionImageArtifact!.draft.pixelProof.lockedPixelsEqual=false as never;b.lockedProductionImageArtifactFingerprint=fp(b.lockedProductionImageArtifact);}
      else if(bad==="proof-sha"){b.lockedProductionImageArtifact!.draft.pixelProof.sourcePixelsSha256="b".repeat(64);b.lockedProductionImageArtifact!.draftFingerprint=fp(b.lockedProductionImageArtifact!.draft);b.lockedProductionImageArtifactFingerprint=fp(b.lockedProductionImageArtifact);}
      else if(bad==="result"){delete b.lockedProductionImageResult;delete b.lockedProductionImageResultFingerprint;}
      else{delete b.lockedProductionImageArtifact;delete b.lockedProductionImageArtifactFingerprint;}
      if(bad==="policy"||bad==="proof"){const payload=JSON.stringify(s);sql(t,db=>db.prepare("UPDATE kernel_state SET payload=?,sha256=? WHERE kind='runs'").run(payload,sha(Buffer.from(payload))));}
      else t.store.transaction(()=>t.store.save(s));}
    expect(()=>reader(t).read(actor,"project-a",asset)).toThrow();expect(()=>reader(t).lineage(actor,"project-a",asset)).toThrow();
  });
  it("清全部task产物字段但存有效unknown任务也拒绝孤立产物",()=>{
    const asset=t.id();t.store.transaction(()=>{const s=t.store.load()!,b=s.batches[0];delete b.lockedProductionImageArtifact;delete b.lockedProductionImageArtifactFingerprint;
      b.aggregate.jobs[0].outputAssetIds=[];b.aggregate.audit=b.aggregate.audit.filter(a=>a.eventType!=="production-image-artifact-verified");t.store.save(s);});
    expect(()=>t.kernel.validateProductionBillingSnapshot(t.store.load()!)).not.toThrow();expect(()=>reader(t).read(actor,"project-a",asset)).toThrow();
  });
  it.each(["revoke","constraint","legal-catalog","fault"])("原包getter %s撤权漂移副作用整体回滚并清副本",bad=>{
    const asset=t.id(),r=reader(t),before=t.store.load(),catalog=t.store.loadCatalog(),original=t.store.loadLockedProductionImageResponse.bind(t.store);let body:Buffer|undefined;
    vi.spyOn(t.store,"loadLockedProductionImageResponse").mockImplementationOnce((...args)=>{const raw=original(...args);body=raw?.body;
      if(bad==="revoke")t.denied.add("asset:read");else{const c=t.store.loadCatalog()!;if(bad==="legal-catalog")c.projects[0].assets.push({...c.projects[0].assets[0],id:"unrelated"});else c.projects[0].constraints[0].brandRules.style="callback";t.store.saveCatalog(c);}
      if(bad==="fault"){body?.fill(0);throw Error("owned-private");}return raw;});
    expect(()=>r.read(actor,"project-a",asset)).toThrow();expect(body?.every(n=>n===0)).toBe(true);expect(t.store.loadCatalog()).toEqual(catalog);unchanged(t,before);
  });
  it("输出借出副本修改后不能借收据SHA返回坏字节，所有副本清零",()=>{
    const r=reader(t),asset=t.id(),original=t.store.loadVerifiedImageBytes.bind(t.store),copies:Buffer[]=[];
    vi.spyOn(t.store,"loadVerifiedImageBytes").mockImplementation((...args)=>{const image=original(...args);if(args[2]===asset&&image){copies.push(image.body);image.body[image.body.length-1]^=1;}return image;});
    expect(()=>r.read(actor,"project-a",asset)).toThrow();expect(copies.length).toBeGreaterThan(0);expect(copies.every(b=>b.every(n=>n===0))).toBe(true);
  });
  it.each(["declared-input","metadata-full","kernel-config"])("%s真实边界在二进制读取前拒绝",bad=>{
    const r=reader(t),asset=t.id();
    if(bad==="declared-input")t.store.transaction(()=>{const c=t.store.loadCatalog()!;c.projects[0].assets.find(a=>a.id==="source")!.byteSize=31*1024*1024;t.store.saveCatalog(c);});
    else if(bad==="metadata-full")vi.spyOn(t.store,"imageMetadataBytes").mockReturnValue(16*1024*1024);
    else(t.kernel as any).options.budgets[0].limitMinor+=1;
    const receipt=vi.spyOn(t.store,"loadVerifiedImage"),bytes=vi.spyOn(t.store,"loadVerifiedImageBytes");
    expect(()=>r.read(actor,"project-a",asset)).toThrow();expect(receipt).not.toHaveBeenCalled();expect(bytes).not.toHaveBeenCalled();
  });
  it.each(["deadline","cancel","input"])("最后无授权端口读取后的%s仍拒绝并回滚",bad=>{
    const asset=t.id(),r=reader(t),before=t.store.load(),catalog=t.store.loadCatalog(),controller=new AbortController(),original=evidence.readLockedProductionBillingEvidence;let calls=0;
    vi.spyOn(evidence,"readLockedProductionBillingEvidence").mockImplementation((...args)=>{const v=original(...args);if(++calls===2){if(bad==="deadline")t.advance(5000);else if(bad==="cancel")controller.abort();
      else{const c=t.store.loadCatalog()!;c.projects[0].constraints[0].brandRules.style="last";t.store.saveCatalog(c);}}return v;});
    expect(()=>r.read(actor,"project-a",asset,{signal:controller.signal})).toThrow();expect(t.store.loadCatalog()).toEqual(catalog);unchanged(t,before);
  });
  it.each(["policy-function","store-instance"])("回调更换实际%s不是原配置许可",bad=>{
    const r=reader(t),asset=t.id(),second=new SqliteRunKernelStateStore(t.path,{productionResponseStorageEnabled:true,productionArtifactStorageEnabled:true});
    try{const kernel=new SqliteRunKernel({stateStore:second,authorizer:t.auth,budgets:second.load()!.budgets,clock:t.clock}),load=vi.spyOn(second,"load");
      t.options.lockedGeneratedReadPolicy.mockImplementation(()=>{const o=(r as any).options;
        if(bad==="policy-function")o.lockedGeneratedReadPolicy=()=>true;else{o.stateStore=second;o.runKernel=kernel;}return true;});
      expect(()=>r.read(actor,"project-a",asset)).toThrow();
      if(bad==="store-instance")expect(load).not.toHaveBeenCalled();
    }finally{second.close();}
  });
  it.each(["domain","mask","mask-binding","count","source","estimate","private","version"])("公开严格白名单%s不能升级或篡改",bad=>{
    const view=reader(t).lineage(actor,"project-a",t.id()),x=structuredClone(view);
    if(bad==="domain")x.protection.domain="original-encoded" as never;else if(bad==="mask")x.protection.mask.assetId=x.protection.source.assetId;
    else if(bad==="mask-binding")x.protection.mask.sourceChecksumSha256="0".repeat(64);
    else if(bad==="count")x.protection.lockedPixels=0;else if(bad==="source")x.requestDraft.inputs[0].checksumSha256="0".repeat(64);
    else if(bad==="estimate")x.billing.estimatedMinor=0;else if(bad==="version")x.schemaVersion=1 as never;else(x as any).workerId="owned-private";
    expect(LockedProductionGeneratedAssetLineageSchema.safeParse(x).success).toBe(false);
  });
});
describe("protected read zero-cap, no artifact and actual settled history",()=>{
  it.each([0,40])("manual cap=%s不补估价或实费0",async cap=>{const t=await fixture({manual:true,cap});expect(reader(t).lineage(actor,"project-a",t.id()).billing).toEqual({state:"unknown",currency:"CNY",estimatedMinor:null,maxCostMinor:cap,currentMaxCostMinor:cap,reservedMinor:cap});});
  it.each(["multipart-image-array","multipart-image-single"] as const)("原%s只回读已有图不重建",async encoding=>{
    const t=await fixture({protocol:"openai-compatible",encoding}),prepare=vi.spyOn(wire,"prepareLockedProductionImageProtocol");expect(reader(t).read(actor,"project-a",t.id()).body).toEqual(source);expect(prepare).not.toHaveBeenCalled();
  });
  it("候选/从头生产not-connected无图不是原图读取许可，请求0",async()=>{
    const t=await fixture({},false),p=await fixture({production:true},false);expect(()=>reader(t).read(actor,"project-a","candidate")).toThrow();
    expect(()=>new LockedProductionGeneratedAssetReads(p.options).read(actor,"project-a","none")).toThrow();expect(p.saved().lockedProductionImageExecution!.mode).toBe("production");
    expect(p.saved().lockedProductionImageAttempt).toBeUndefined();expect(p.send).not.toHaveBeenCalled();
  });
  it("真正同库人工结算/超额审批后只读保护原图及当前费用，不再核来源；删全部费用拒绝",async()=>{
    const t=await fixture({manual:true});let billing:LockedImageProductionBillingSettlementHarness;
    const sourcePort={kind:"contract-fixture" as const,realExecutionEnabled:false as const,verify:vi.fn(()=>true)},kernel=new SqliteRunKernel({stateStore:t.store,authorizer:t.auth,budgets:t.store.load()!.budgets,clock:t.clock,
      lockedProductionImageBillingPolicy:{usesStateStore:s=>billing?.billingPolicy.usesStateStore(s)??false,authorizeScope:(p,j,a)=>billing?.billingPolicy.authorizeScope(p,j,a)??false,
        validateCommit:(p,r)=>billing?.billingPolicy.validateCommit(p,r)??false,validateOriginal:(p,r)=>billing?.billingPolicy.validateOriginal(p,r)??false}});
    const opts={...t.options,runKernel:kernel,providerAuthorizer:t.auth,billingSource:sourcePort};
    billing=new LockedImageProductionBillingSettlementHarness({...opts,lockedBillingSettlementEnabled:true,lockedBillingSettlementPolicy:()=>true});
    const review=new LockedImageProductionBillingReviewHarness({...opts,lockedBillingReviewEnabled:true,lockedBillingReviewPolicy:()=>true}),args=[principal,"project-a",t.v.batchId,t.v.jobId] as const,snapshot=review.inspect(...args);
    const pending=billing.settle(...args,{reviewId:"owned-read-fee",expectedSnapshotFingerprint:fp(snapshot),expectedProtectionPolicyFingerprint:snapshot.protectionPolicyFingerprint,expectedCurrency:snapshot.currency,expectedReservedMinor:40,expectedMaxCostMinor:40,actualCostMinor:65,resolution:"charged",
      evidence:{sourceId:"owned",sourceVersion:"1",evidenceRef:"fake-bill",checksumSha256:"a".repeat(64),observedAt:snapshot.unknownAt}});
    billing.decide(actor,...args.slice(1) as [string,string,string],pending.request.reviewId,{decisionId:"owned-independent",expectedRecordFingerprint:fp(pending),expectedSnapshotFingerprint:pending.snapshotFingerprint,
      expectedProtectionPolicyFingerprint:snapshot.protectionPolicyFingerprint,expectedCurrency:"CNY",expectedActualCostMinor:65,expectedReservedMinor:40,decision:"approve",evidenceRef:"owned",note:"独立核对"});
    for(const p of ["run:reconcile-billing","run:approve-billing-overage","run:execute","provider:read","asset:write"])t.denied.add(p);sourcePort.verify.mockClear();
    const r=new LockedImageProductionGeneratedAssetReadHarness(opts),before=t.store.load(),asset=t.id();
    expect(r.lineage(actor,"project-a",asset)).toMatchObject({jobStatus:"succeeded",billing:{state:"settled",actualMinor:65,reservedMinor:0,maxCostMinor:40,currentMaxCostMinor:65,estimatedMinor:null}});
    expect(r.read(actor,"project-a",asset).body).toEqual(source);expect(sourcePort.verify).not.toHaveBeenCalled();unchanged(t,before);
    t.store.transaction(()=>{const s=t.store.load()!,b=s.batches[0];delete b.lockedProductionImageBilling;delete b.lockedProductionImageBillingFingerprint;delete b.aggregate.lockedProductionBilling;t.store.save(s);});
    expect(()=>r.read(actor,"project-a",asset)).toThrow();
  });
});
describe("protected original explicit HTTP, default closed",()=>{
  let t:Task,r:LockedImageProductionGeneratedAssetReadHarness,asset:string;beforeEach(async()=>{t=await fixture();r=reader(t);asset=t.id();});
  it("实际临时SQL与HTTP原字节/完整白名单/v2保护头，日常4次404",async()=>{
    const base=await api(r),before=t.store.load(),response=await fetch(base+uri(asset));expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(source);
    for(const [h,v] of [["content-length",String(source.length)],["content-type","image/png"],["x-content-sha256",t.saved().lockedProductionImageArtifact!.image.checksumSha256],
      ["x-canvas-binary-version","locked-production-generated-image-v2"],["x-canvas-artifact-sha256",t.saved().lockedProductionImageArtifactFingerprint!],
      ["x-canvas-protection-policy-sha256",fp(t.preparation.protectionPolicy)],["x-canvas-pixel-proof-sha256",fp(t.saved().lockedProductionImageArtifact!.draft.pixelProof)],
      ["cache-control","private, no-store"],["vary","Authorization"],["x-content-type-options","nosniff"],["cross-origin-resource-policy","same-origin"],["referrer-policy","no-referrer"]])expect(response.headers.get(h)).toBe(v);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();expect(await(await fetch(base+uri(asset,"lineage"))).json()).toEqual(r.lineage(actor,"project-a",asset));
    const daily=await api();for(const kind of ["lineage","content"])for(const method of ["GET","POST"])expect((await fetch(daily+uri(asset,kind),{method})).status).toBe(404);unchanged(t,before);
  });
  it.each(["query","range","post","head","escaped-id","encoding","get-body","anonymous"])("HTTP%s先于读取拒绝",async bad=>{
    const base=await api(r),read=vi.spyOn(r,"read"),lineage=vi.spyOn(r,"lineage");let status:number;
    if(bad==="anonymous"){vi.spyOn(t.auth,"authenticate").mockReturnValue(null as never);status=(await fetch(base+uri(asset))).status;}
    else if(bad==="get-body")status=await new Promise<number>((resolve,reject)=>{const req=httpRequest(base+uri(asset),{method:"GET",headers:{"content-length":"2"}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode!));});req.on("error",reject);req.end("{}");});
    else status=(await fetch(base+uri(bad==="escaped-id"?"bad%2Fid":asset)+(bad==="query"?"?proof=caller":""),{method:bad==="post"?"POST":bad==="head"?"HEAD":"GET",headers:bad==="range"?{range:"bytes=0-1"}:bad==="encoding"?{"content-encoding":"gzip"}:{}})).status;
    expect(status).toBe(bad==="range"?416:bad==="post"||bad==="head"?405:bad==="anonymous"?503:400);expect(read).not.toHaveBeenCalled();expect(lineage).not.toHaveBeenCalled();
  });
  it.each(["private","scope","checksum","policy","known-private-error"])("坏注入端口%s不给私密异常或坏原图",async bad=>{
    const good=r.read(actor,"project-a",asset),base=await api(r);vi.spyOn(r,"read").mockImplementation(()=>{if(bad==="known-private-error")throw new RunKernelError(418,"locked_generated_asset_not_found","owned-private-key");
      const metadata=structuredClone(good.metadata);if(bad==="private")(metadata as any).workerId="owned-private";else if(bad==="scope")metadata.projectId="foreign";else if(bad==="checksum")metadata.image.checksumSha256="0".repeat(64);else metadata.protection.lockedPixels=0;
      return{metadata,body:Buffer.from(good.body)};});const response=await fetch(base+uri(asset));expect(response.status).toBe(bad==="known-private-error"?404:503);expect(await response.text()).not.toContain("owned-private");good.body.fill(0);
  });
  it("响应生命期两个槽与旧原图共享，关闭只释放一次",async()=>{
    let hold=true;const base=await api(r,s=>s.prependListener("request",(_req,response)=>{const end=response.end.bind(response);response.end=((...args:unknown[])=>{if(hold&&response.statusCode===200){response.flushHeaders();return response;}return(end as any)(...args);}) as ServerResponse["end"];}));
    const pause=()=>new Promise<IncomingMessage>((resolve,reject)=>{const req=httpRequest(base+uri(asset),res=>{res.pause();sockets.push(res);resolve(res);});req.on("error",reject);req.end();});
    const a=await pause(),b=await pause();expect(a.statusCode).toBe(200);expect(b.statusCode).toBe(200);expect((await fetch(base+uri(asset,"lineage"))).status).toBe(429);expect(acquireGeneratedTransfer()).toBeUndefined();
    a.destroy();b.destroy();await new Promise(r=>setTimeout(r,50));hold=false;expect((await fetch(base+uri(asset))).status).toBe(200);
  });
  it.each(["deadline","aborted","backward"])("HTTP末端%s拒绝迟到并清借出副本",bad=>{
    const good=r.read(actor,"project-a",asset),req={url:uri(asset),method:"GET",headers:{},aborted:false},emitter=new EventEmitter();
    const response=Object.assign(emitter,{headersSent:false,writeHead:vi.fn(),setHeader:vi.fn(),end:vi.fn(),destroy:vi.fn(()=>emitter.emit("close")),once:emitter.once.bind(emitter)}) as unknown as ServerResponse;
    vi.spyOn(performance,"now").mockReturnValue(10);vi.spyOn(r,"read").mockImplementation(()=>{if(bad==="aborted")req.aborted=true;else vi.spyOn(performance,"now").mockReturnValue(bad==="deadline"?30010:9);return good;});
    handleLockedProductionGeneratedAssetHttp(req as IncomingMessage,response,r);expect(response.writeHead).toHaveBeenCalledWith(503,expect.anything());expect(good.body.every(n=>n===0)).toBe(true);emitter.emit("close");
  });
  it("绝对30秒结束未送完响应/取消信号并清零释放槽",()=>{
    vi.useFakeTimers();const good=r.read(actor,"project-a",asset),emitter=new EventEmitter(),response=Object.assign(emitter,{headersSent:false,writeHead:vi.fn(),setHeader:vi.fn(),end:vi.fn(),destroy:vi.fn(()=>emitter.emit("close")),once:emitter.once.bind(emitter)}) as unknown as ServerResponse;
    let signal:AbortSignal|undefined;vi.spyOn(r,"read").mockImplementation((_p,_j,_a,o)=>{signal=o?.signal;return good;});
    handleLockedProductionGeneratedAssetHttp({url:uri(asset),method:"GET",headers:{}} as IncomingMessage,response,r);vi.advanceTimersByTime(30000);
    expect(response.destroy).toHaveBeenCalledTimes(1);expect(signal?.aborted).toBe(true);expect(good.body.every(n=>n===0)).toBe(true);const release=acquireGeneratedTransfer();expect(release).toBeDefined();release?.();release?.();
  });
});
