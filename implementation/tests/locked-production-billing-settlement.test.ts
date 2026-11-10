import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { LockedProductionImageBillingRecordSchema, ProductionImageBillingRecordSchema, DecideProductionImageBillingSchema,
  type LockedProductionImageBillingRecord, type LockedProductionImageBillingSnapshot, type DecideLockedProductionImageBilling } from "../packages/contracts/src/index";
import { LockedImageProductionBillingSettlementHarness, LockedProductionImageBillingSettlementService } from "../apps/api/src/lockedProductionImageBillingSettlement";
import { LockedImageProductionBillingReviewHarness, LockedProductionImageBillingReviewService, type LockedBillingSourceContext } from "../apps/api/src/lockedProductionImageBillingReview";
import { LockedImageProductionArtifactHarness } from "../apps/api/src/lockedProductionImageTaskArtifacts";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { prepareLockedTaskFixture, lockedResponse } from "./helpers/locked-production-task-fixture";
import { principal, sha } from "./helpers/image-task-fixture";
import { imageSnapshotFingerprint as fp } from "../apps/api/src/imageProviderContract";
import { imageTaskMetadataBytes } from "../apps/api/src/imageTaskMetadata";
import { RunKernelError } from "../apps/api/src/runKernel";
import * as reads from "../apps/api/src/lockedProductionImageBillingRead";
import * as decoder from "../apps/api/src/staticImageDecoder";
import * as wire from "../apps/api/src/lockedProductionImageProtocol";
import * as pixels from "../apps/api/src/lockedImagePixelValidation";
const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
const reviewer = { ...principal, actorId: "fee-reviewer" }, approver = { ...principal, actorId: "fee-approver" };
let source: Buffer, mask: Buffer;
const owned: { cleanup(): void }[] = [], connections: SqliteRunKernelStateStore[] = [];
const children: ChildProcess[] = [];
beforeAll(async () => { const png = (v: number[]) => sharp(Buffer.from(v), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  source = await png([40,70,90,255,1,2,3,255]); mask = await png([255,255,255,0,255,255,255,255]); });
afterEach(async () => { vi.restoreAllMocks(); for(const c of children.splice(0)) if(c.exitCode===null&&c.signalCode===null) {
  const exited=new Promise<void>(resolve=>c.once("exit",()=>resolve()));c.kill();await exited;
} for(const c of connections.splice(0).reverse()) c.close(); for(const f of owned.splice(0).reverse()) f.cleanup(); });
async function fixture(opts: Parameters<typeof prepareLockedTaskFixture>[2] = {}, image = true) {
  let artifact: LockedImageProductionArtifactHarness;
  const f = await prepareLockedTaskFixture(source,mask,{...opts,kernel:{...opts.kernel,lockedProductionImageArtifactPolicy:{usesStateStore:s=>artifact.usesStateStore(s),
    authorizeScope:(p,j)=>artifact.authorizeScope(p,j),validateCommit:(p,r)=>artifact.validateCommit(p,r)}}}); owned.push(f);
  artifact = new LockedImageProductionArtifactHarness({lockedArtifactEnabled:true,tenantId:principal.tenantId,stateStore:f.store,runKernel:f.kernel,clock:f.clock,
    runAuthorizer:f.authorizer,providerAuthorizer:f.authorizer,assetAuthorizer:f.authorizer,lockedArtifactPolicy:()=>true});
  if(opts.production){await f.start();f.advance(opts.kernel?.jobTimeoutMs??30000);f.kernel.reconcileLockedProductionImageBatch(principal,"project-a",f.v.batchId);}
  else {await f.execute();if(image)await artifact.ingest(principal,"project-a",f.v.batchId,f.v.jobId,f.input);}
  return {...f,artifact};
}
type Task = Awaited<ReturnType<typeof fixture>>;
function setup(t:Task,store=t.store,extra:Record<string,unknown>={},kernelConfig:{jobTimeoutMs?:number}={}) {
  let service: LockedImageProductionBillingSettlementHarness | LockedProductionImageBillingSettlementService;
  const denied=new Set<string>(),auth={authenticate:()=>reviewer,allows:(p:typeof principal,j:string,permission:string)=>p.tenantId===principal.tenantId
    && [reviewer.actorId,approver.actorId,principal.actorId].includes(p.actorId)&&j==="project-a"&&!denied.has(permission)};
  const source={kind:t.options.pricePort.kind==="server-pricing"?"server-billing":"contract-fixture",realExecutionEnabled:false,
    verify:vi.fn((_c:LockedBillingSourceContext):unknown=>true)};
  const policy={usesStateStore:(s:unknown)=>service?.billingPolicy.usesStateStore(s)??false,
    authorizeScope:(p:typeof principal,j:string,a:boolean)=>service?.billingPolicy.authorizeScope(p,j,a)??false,
    validateCommit:(p:typeof principal,r:LockedProductionImageBillingRecord)=>service?.billingPolicy.validateCommit(p,r)??false,
    validateOriginal:(p:typeof principal,r:LockedProductionImageBillingRecord)=>service?.billingPolicy.validateOriginal(p,r)??false};
  const kernelOptions={stateStore:store,authorizer:auth,budgets:store.load()!.budgets,clock:t.clock,lockedProductionImageBillingPolicy:policy,...kernelConfig};
  const kernel=new SqliteRunKernel(kernelOptions),options={lockedBillingSettlementEnabled:true as const,tenantId:principal.tenantId,stateStore:store,runKernel:kernel,
    runAuthorizer:auth,providerAuthorizer:auth,assetAuthorizer:auth,clock:t.clock,billingSource:source as any,lockedBillingSettlementPolicy:()=>true,...extra};
  service=source.kind==="server-billing"?new LockedProductionImageBillingSettlementService(options):new LockedImageProductionBillingSettlementHarness(options);
  const rOptions={...options,lockedBillingReviewEnabled:true as const,lockedBillingReviewPolicy:()=>true};
  const read=source.kind==="server-billing"?new LockedProductionImageBillingReviewService(rOptions):new LockedImageProductionBillingReviewHarness(rOptions);
  const args=[reviewer,"project-a",t.v.batchId,t.v.jobId] as const,approveArgs=[approver,...args.slice(1)] as [typeof principal,string,string,string];
  const snapshot=read.inspect(...args);
  const request=(cost=25,id="owned-review")=>({reviewId:id,expectedSnapshotFingerprint:fp(snapshot),expectedProtectionPolicyFingerprint:snapshot.protectionPolicyFingerprint,
    expectedCurrency:snapshot.currency,expectedReservedMinor:snapshot.reservedMinor,expectedMaxCostMinor:snapshot.maxCostMinor,
    resolution:cost?"charged" as const:"not-charged" as const,actualCostMinor:cost,
    evidence:{sourceId:"owned-billing",sourceVersion:"v1",evidenceRef:"owned-fake-bill",checksumSha256:"a".repeat(64),observedAt:snapshot.unknownAt}});
  const decision=(r:LockedProductionImageBillingRecord,choice:"approve"|"reject"="approve",id="owned-decision"):DecideLockedProductionImageBilling=>({decisionId:id,
    expectedRecordFingerprint:fp(r),expectedSnapshotFingerprint:r.snapshotFingerprint,expectedProtectionPolicyFingerprint:r.snapshot.protectionPolicyFingerprint,
    expectedCurrency:r.snapshot.currency,expectedReservedMinor:r.snapshot.reservedMinor,expectedActualCostMinor:r.request.actualCostMinor,
    decision:choice,evidenceRef:"owned-approval",note:"独立人工核对"});
  return {service,read,options,kernel,kernelOptions,policy,source,auth,denied,args,approveArgs,snapshot,request,decision};
}
function sql(t:Task,action:(d:DatabaseSync)=>void){const d=new DatabaseSync(t.path);try{action(d);}finally{d.close();}}
function spawnBilling(t:Task,input:Record<string,unknown>) {
  const child=fork(fileURLToPath(new URL("./fixtures/locked-production-billing-process.ts",import.meta.url)),[],{execArgv:["--import","tsx"],stdio:["ignore","ignore","ignore","ipc"]});children.push(child);
  let response:{ok:boolean;result?:LockedProductionImageBillingRecord}|undefined,readyResolve:()=>void,readyReject:(e:Error)=>void,resultReject:(e:Error)=>void;
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const result=new Promise<NonNullable<typeof response>>((resolve,reject)=>{resultReject=reject;child.once("exit",()=>{if(response)resolve(response);else reject(new Error("owned fee process exited without evidence"));});});
  child.once("error",e=>{readyReject(e);resultReject(e);});child.on("message",(m:any)=>{if(m.ready)readyResolve();else response=m;});
  child.once("exit",()=>readyReject(new Error("owned fee process exited before ready")));child.send({path:t.path,now:t.clock(),batch:t.v.batchId,job:t.v.jobId,...input});
  return {child,ready,result};
}
const combos=(["openai","openai-compatible"] as const).flatMap(protocol=>[false,true].flatMap(manual=>[false,true].map(image=>[protocol,manual,image] as const)));
describe.each(combos)("protected fees %s/manual=%s/image=%s",(protocol,manual,image)=>{
  let t:Task;beforeEach(async()=>{t=await fixture({protocol,manual},image);});
  it("完整保护原链一次结算，重复与另一连接重启不再核来源/报价/输出",()=>{
    const s=setup(t),before=t.store.load()!.batches[0];
    for(const p of ["run:execute","run:create","run:confirm","asset:write","run:approve-billing-overage"])s.denied.add(p);
    const r=s.service.settle(...s.args,s.request()),after=t.store.load()!.batches[0];
    expect(r.status).toBe("settled");expect(r.snapshot.estimate).toEqual(manual?{state:"unknown"}:{state:"known",estimatedCostMinor:25});
    expect(after.aggregate.jobs[0]).toMatchObject({status:image?"succeeded":"failed",actualCostMinor:25,finishedAt:before.aggregate.jobs[0].finishedAt,leaseId:before.aggregate.jobs[0].leaseId,leaseOwnerId:before.aggregate.jobs[0].leaseOwnerId});
    for(const key of ["lockedProductionImageExecution","lockedProductionImageLeases","lockedProductionImageDispatchIntent","lockedProductionImageAttempt","lockedProductionImageResult","lockedProductionImageArtifact"] as const)expect(after[key]).toEqual(before[key]);
    expect(after.aggregate.ledger.map(l=>l.settlement)).toEqual(["reserved","unknown","settled"]);expect(after.jobReservations).toEqual([]);
    expect(s.kernel.getBudget(reviewer,"project-a")).toMatchObject({spentMinor:25,reservedMinor:0,limitMinor:1000});
    t.pricePort.read.mockClear();t.pricePort.verify.mockClear();const native=vi.spyOn(decoder,"decodeStaticImagePixels"),rebuild=vi.spyOn(wire,"prepareLockedProductionImageProtocol"),pixel=vi.spyOn(pixels,"verifyLockedImagePixels");
    expect(s.service.settle(...s.args,s.request())).toEqual(r);expect(s.service.inspect(...s.args)).toEqual([r]);expect(s.read.inspect(...s.args)).toEqual(s.snapshot);
    const connection=new SqliteRunKernelStateStore(t.path,{productionResponseStorageEnabled:true,productionArtifactStorageEnabled:true});connections.push(connection);
    const second=setup(t,connection);expect(second.service.settle(...second.args,second.request())).toEqual(r);expect(second.source.verify).not.toHaveBeenCalled();
    expect(s.source.verify).toHaveBeenCalledTimes(2);expect(native).not.toHaveBeenCalled();expect(rebuild).not.toHaveBeenCalled();expect(pixel).not.toHaveBeenCalled();
    expect(t.pricePort.read).not.toHaveBeenCalled();expect(t.pricePort.verify).not.toHaveBeenCalled();expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.service.getConfirmation(principal,"project-a",t.preparation.id)).toMatchObject({status:image?"succeeded":"failed",reservedMinor:0});
    expect(ProductionImageBillingRecordSchema.safeParse(r).success).toBe(false);expect(LockedProductionImageBillingRecordSchema.parse(r)).toEqual(r);
  });
});
describe("protected fees independent permissions, atomic rollback and recovery",()=>{
  let t:Task,s:ReturnType<typeof setup>;beforeEach(async()=>{t=await fixture({manual:true});s=setup(t);});
  it("超额待审批/另一人批准只扩批次上限，不增项目预算或改quote",()=>{
    const before=t.store.load()!.batches[0],pending=s.service.settle(...s.args,s.request(65));expect(pending.status).toBe("pending");expect(t.store.load()!.batches[0].reservedMinor).toBe(40);
    expect(()=>s.service.decide(...s.args,pending.request.reviewId,s.decision(pending))).toThrow();
    const settled=s.service.decide(...s.approveArgs,pending.request.reviewId,s.decision(pending));expect(settled.status).toBe("settled");
    expect(t.store.load()!.batches[0].aggregate.batch.maxCostMinor).toBe(65);expect(t.store.load()!.batches[0].lockedProductionImageExecution).toEqual(before.lockedProductionImageExecution);
    expect(s.kernel.getBudget(reviewer,"project-a")).toMatchObject({limitMinor:1000,spentMinor:65,reservedMinor:0});
    expect(s.service.decide(...s.approveArgs,pending.request.reviewId,s.decision(pending))).toEqual(settled);expect(s.source.verify).toHaveBeenCalledTimes(4);
  });
  it("拒绝保留原预留和不可变历史，另一新动作可以核验结算",()=>{
    const p=s.service.settle(...s.args,s.request(65)),r=s.service.decide(...s.approveArgs,p.request.reviewId,s.decision(p,"reject"));
    expect(r.status).toBe("rejected");expect(t.store.load()!.batches[0].reservedMinor).toBe(40);
    expect(s.service.settle(...s.args,s.request(25,"new-review")).status).toBe("settled");expect(s.service.inspect(...s.args)[0]).toEqual(r);
  });
  it.each(["run:read","run:reconcile-billing","provider:read","asset:read"])("%s在私有读取前核验",permission=>{
    s.denied.add(permission);const load=vi.spyOn(t.store,"load"),raw=vi.spyOn(t.store,"loadLockedProductionImageResponse");
    expect(()=>s.service.settle(...s.args,s.request())).toThrow();expect(load).not.toHaveBeenCalled();expect(raw).not.toHaveBeenCalled();expect(s.source.verify).not.toHaveBeenCalled();
  });
  it("没有独立审批权限不能提交决定",()=>{const p=s.service.settle(...s.args,s.request(65)),before=t.store.load();s.denied.add("run:approve-billing-overage");
    expect(()=>s.service.decide(...s.approveArgs,p.request.reviewId,s.decision(p))).toThrow();expect(t.store.load()).toEqual(before);});
  it.each(["expectedRecordFingerprint","expectedSnapshotFingerprint","expectedProtectionPolicyFingerprint","expectedCurrency","expectedReservedMinor","expectedActualCostMinor"] as const)("第二人%s期待不能漂移",field=>{
    const p=s.service.settle(...s.args,s.request(65)),request=s.decision(p),before=t.store.load();(request as any)[field]=field.includes("Fingerprint")?"b".repeat(64):field==="expectedCurrency"?"USD":64;
    s.source.verify.mockClear();expect(()=>s.service.decide(...s.approveArgs,p.request.reviewId,request)).toThrow();expect(s.source.verify).not.toHaveBeenCalled();expect(t.store.load()).toEqual(before);
  });
  it("已保存动作身份/参数漂移和第二结算不能覆写",()=>{
    const r=s.service.settle(...s.args,s.request()),before=t.store.load();s.source.verify.mockClear();
    expect(()=>s.service.settle(...s.args,s.request(24))).toThrow();expect(()=>s.service.settle(...s.approveArgs,s.request())).toThrow();
    expect(()=>s.service.settle(...s.args,s.request(25,"another"))).toThrow();expect(s.service.inspect(...s.args)).toEqual([r]);expect(t.store.load()).toEqual(before);expect(s.source.verify).not.toHaveBeenCalled();
  });
  it("费用/指纹/公开摘要/审计账本计原共享元数据，实际SQL后超限回滚",()=>{
    const before=t.store.load(),max=t.store.imageMetadataBytes(principal.tenantId,"project-a")+imageTaskMetadataBytes(before,principal.tenantId,"project-a");
    const limited=setup(t,t.store,{maxMetadataBytes:max+1}),save=vi.spyOn(t.store,"save");
    expect(()=>limited.service.settle(...limited.args,limited.request())).toThrow();expect(save).toHaveBeenCalled();expect(t.store.load()).toEqual(before);
  });
  it("取消/无效配置时限在来源或实际保存前拒绝",()=>{
    const before=t.store.load(),controller=new AbortController();controller.abort();expect(()=>s.service.settle(...s.args,s.request(),controller.signal)).toThrow();
    for(const timeoutMs of [0,30001,NaN]){const limited=new LockedImageProductionBillingSettlementHarness({...s.options,timeoutMs});expect(()=>limited.settle(...s.args,s.request())).toThrow();}
    expect(t.store.load()).toEqual(before);expect(s.source.verify).not.toHaveBeenCalled();
  });
  it.each(["source","policy"])("%s私密RunKernelError不能透传",kind=>{
    const before=t.store.load(),secret=()=>{throw new RunKernelError(500,"owned-private-code","owned-private-bill");};
    if(kind==="source")s.source.verify.mockImplementation(secret);
    else s=setup(t,t.store,{lockedBillingSettlementPolicy:secret});
    expect(()=>s.service.settle(...s.args,s.request())).toThrow();expect(()=>s.service.settle(...s.args,s.request())).not.toThrow("owned-private-bill");expect(t.store.load()).toEqual(before);
  });
  it("历史报价过期目录停用仍核实际费用/原输入，不重报价重发",()=>{
    const r=s.service.settle(...s.args,s.request()),before=t.store.load();t.advance(90000);t.register({...t.config,revision:2,enabled:false});t.pricePort.read.mockClear();t.pricePort.verify.mockClear();s.source.verify.mockClear();
    expect(s.service.settle(...s.args,s.request())).toEqual(r);expect(s.service.inspect(...s.args)).toEqual([r]);expect(t.service.getConfirmation(principal,"project-a",t.preparation.id)).toMatchObject({status:"succeeded"});
    expect(t.store.load()).toEqual(before);expect(s.source.verify).not.toHaveBeenCalled();expect(t.pricePort.read).not.toHaveBeenCalled();expect(t.pricePort.verify).not.toHaveBeenCalled();
  });
  it("最后授权回调写目录之后必须纯读取，整体回滚",()=>{
    const original=reads.readLockedProductionBillingEvidence,cat=t.store.loadCatalog(),before=t.store.load();let afterRead=false;
    vi.spyOn(reads,"readLockedProductionBillingEvidence").mockImplementation((...args)=>{const r=original(...args);if(r.records.length)afterRead=true;return r;});
    s=setup(t,t.store,{lockedBillingSettlementPolicy:()=>{if(afterRead){const c=t.store.loadCatalog()!;c.projects[0].constraints[0].brandRules.style="changed-after-final-auth";t.store.saveCatalog(c);}return true;}});
    expect(()=>s.service.settle(...s.args,s.request())).toThrow();expect(t.store.load()).toEqual(before);expect(t.store.loadCatalog()).toEqual(cat);
  });
  it.each(["catalog","budget"])("完整冻结%s不能接受内核活回调新增合法但非预期状态",kind=>{
    const before=t.store.load(),cat=t.store.loadCatalog(),original=s.policy.validateCommit;let changed=false;
    s.policy.validateCommit=(p,r)=>{const allowed=original(p,r);if(!changed){changed=true;
      if(kind==="catalog"){const c=t.store.loadCatalog()!;c.projects[0].assets.push({...c.projects[0].assets[0],id:"owned-unrelated"});t.store.saveCatalog(c);}
      else {const x=t.store.load()!;x.budgets.push({tenantId:principal.tenantId,projectId:"owned-unrelated",currency:"CNY",limitMinor:0,reservedMinor:0,spentMinor:0});t.store.save(x);}}
      return allowed;};
    expect(()=>s.service.settle(...s.args,s.request())).toThrow();expect(changed).toBe(true);expect(t.store.load()).toEqual(before);expect(t.store.loadCatalog()).toEqual(cat);
  });
  it.each(["off","tenant","mode","store","policy"])("配置%s失败在私有读取前关闭",kind=>{
    const options={...s.options,...(kind==="off"?{lockedBillingSettlementEnabled:false}:kind==="tenant"?{tenantId:"another"}:kind==="mode"?{billingSource:{...s.source,kind:"server-billing"}}:kind==="store"?{runKernel:{usesStateStore:()=>false}}:{lockedBillingSettlementPolicy:()=>Promise.resolve(true)})};
    const service=new LockedImageProductionBillingSettlementHarness(options as never),load=vi.spyOn(t.store,"load");expect(()=>service.settle(...s.args,s.request())).toThrow();expect(load).not.toHaveBeenCalled();
    expect(()=>new LockedImageProductionBillingSettlementHarness().settle(...s.args,s.request())).toThrow();
  });
  it.each(["expectedSnapshotFingerprint","expectedProtectionPolicyFingerprint","expectedCurrency","expectedReservedMinor","expectedMaxCostMinor"] as const)("人工%s期待不匹配不能核来源",field=>{
    const request=s.request();(request as any)[field]=field.includes("Fingerprint")?"b".repeat(64):field==="expectedCurrency"?"USD":39;const before=t.store.load();
    expect(()=>s.service.settle(...s.args,request)).toThrow();expect(s.source.verify).not.toHaveBeenCalled();expect(t.store.load()).toEqual(before);
  });
  it.each(["false","promise","rejected","truthy","private-error"])("来源%s不是费用许可",kind=>{
    s.source.verify.mockImplementation(()=>{if(kind==="private-error")throw new Error("owned-private-bill");return kind==="false"?false:kind==="truthy"?1:kind==="promise"?Promise.resolve(true):Promise.reject(new Error("owned-private-bill"));});
    const before=t.store.load();expect(()=>s.service.settle(...s.args,s.request())).toThrow();expect(()=>s.service.settle(...s.args,s.request())).not.toThrow("owned-private-bill");expect(t.store.load()).toEqual(before);
  });
  it("来源只获得完整上下文深复制，纯A/客户端对象不获得提交证明",()=>{
    const r=s.request();s.source.verify.mockImplementation(c=>{c.snapshot.originalActorId="changed";c.snapshot.protectionPolicyFingerprint="0".repeat(64);c.request.actualCostMinor=999;c.principal.actorId="changed";return true;});
    const record=s.service.settle(...s.args,r);expect(record.request).toEqual(r);expect(s.source.verify).toHaveBeenCalledTimes(2);
    expect(()=>s.kernel.commitLockedProductionImageBilling(reviewer,record)).toThrow();expect(DecideProductionImageBillingSchema.safeParse(s.decision(record)).success).toBe(false);
  });
  it.each(["revoke","constraint","input","task","backward","deadline","kernel-function","kernel-policy"])("写前来源后%s漂移整体回滚",kind=>{
    const before=t.store.load(),catalog=t.store.loadCatalog();s.source.verify.mockImplementation(()=>{
      if(kind==="revoke")s.denied.add("asset:read");if(kind==="backward")t.advance(-1);if(kind==="deadline")t.advance(5000);
      if(kind==="constraint"||kind==="input"){const c=t.store.loadCatalog()!;if(kind==="input")c.projects[0].assets[0].originalName="changed";else c.projects[0].constraints[0].brandRules.style="changed";t.store.saveCatalog(c);}
      if(kind==="task"){const x=t.store.load()!;x.batches[0].aggregate.jobs[0].leaseOwnerId="changed";t.store.save(x);}
      if(kind==="kernel-function")s.kernel.commitLockedProductionImageBilling=()=>({} as any);
      if(kind==="kernel-policy")s.kernelOptions.lockedProductionImageBillingPolicy={...s.policy,validateCommit:()=>true};return true;});
    expect(()=>s.service.settle(...s.args,s.request())).toThrow();expect(t.store.load()).toEqual(before);expect(t.store.loadCatalog()).toEqual(catalog);
  });
  it.each(["source-withdraw","revoke","clock","fault","directory"])("实际SQL写后%s回滚费用任务预算",kind=>{
    const before=t.store.load(),catalog=t.store.loadCatalog(),save=t.store.save.bind(t.store);let written=false;
    vi.spyOn(t.store,"save").mockImplementation(x=>{save(x);if(x.batches[0].lockedProductionImageBilling){written=true;if(kind==="revoke")s.denied.add("run:reconcile-billing");if(kind==="clock")t.advance(5000);
      if(kind==="fault")throw new Error("owned-private-write");if(kind==="directory"){const c=t.store.loadCatalog()!;c.projects[0].constraints[0].brandRules.style="changed";t.store.saveCatalog(c);}}});
    s.source.verify.mockImplementation(()=>kind!=="source-withdraw"||!written);expect(()=>s.service.settle(...s.args,s.request())).toThrow();expect(written).toBe(true);expect(t.store.load()).toEqual(before);expect(t.store.loadCatalog()).toEqual(catalog);
  });
  it.each(["fees","summary","audit","amount","proof","raw"])("已结算%s删除或部分重算不能通过恢复",kind=>{
    s.service.settle(...s.args,s.request());const x=t.store.load()!,b=x.batches[0];
    if(kind==="fees"){delete b.lockedProductionImageBilling;delete b.lockedProductionImageBillingFingerprint;}if(kind==="summary")delete b.aggregate.lockedProductionBilling;
    if(kind==="audit")b.aggregate.audit=b.aggregate.audit.filter(a=>a.eventType!=="locked-billing-settled");
    if(kind==="amount"){b.lockedProductionImageBilling![0].request.actualCostMinor=24;b.lockedProductionImageBillingFingerprint=fp(b.lockedProductionImageBilling);}
    if(kind==="proof"){delete (b.lockedProductionImageArtifact!.draft as any).pixelProof;b.lockedProductionImageArtifactFingerprint=fp(b.lockedProductionImageArtifact);}
    if(kind==="raw")sql(t,d=>d.exec("DELETE FROM production_image_response_presence"));
    else {const json=JSON.stringify(x);sql(t,d=>d.prepare("UPDATE kernel_state SET payload=?,sha256=? WHERE kind='runs'").run(json,sha(Buffer.from(json))));}
    expect(()=>s.service.inspect(...s.args)).toThrow();expect(()=>s.kernel.getBudget(reviewer,"project-a")).toThrow();
  });
  it.each(["deadline","cancel"])("最后纯读取%s不能误提交",kind=>{
    const original=reads.readLockedProductionBillingEvidence,controller=new AbortController(),before=t.store.load();
    vi.spyOn(reads,"readLockedProductionBillingEvidence").mockImplementation((...args)=>{const r=original(...args);if(r.records.length){if(kind==="deadline")t.advance(5000);else controller.abort();}return r;});
    expect(()=>s.service.settle(...s.args,s.request(),controller.signal)).toThrow();expect(t.store.load()).toEqual(before);
  });
});
describe("protected no-image production, zero-cap and original multipart",()=>{
  it("两个独立OS进程同时结算只有原一笔结论/账本",async()=>{
    const t=await fixture({manual:true},false),s=setup(t),processes=[1,2].map(()=>spawnBilling(t,{request:s.request()}));
    await Promise.all(processes.map(p=>p.ready));processes.forEach(p=>p.child.send("go"));
    const results=await Promise.all(processes.map(p=>p.result));expect(results.every(r=>r.ok)).toBe(true);expect(results[0].result).toEqual(results[1].result);
    expect(t.store.load()!.batches[0].aggregate.audit.filter(a=>a.eventType==="locked-billing-settled")).toHaveLength(1);
    expect(s.kernel.getBudget(reviewer,"project-a")).toMatchObject({spentMinor:25,reservedMinor:0});
  });
  it("两个独立OS进程同时独立审批只有一次结算",async()=>{
    const t=await fixture({manual:true},false),s=setup(t),pending=s.service.settle(...s.args,s.request(65)),processes=[1,2].map(()=>spawnBilling(t,{reviewId:pending.request.reviewId,decision:s.decision(pending)}));
    await Promise.all(processes.map(p=>p.ready));processes.forEach(p=>p.child.send("go"));const results=await Promise.all(processes.map(p=>p.result));
    expect(results.every(r=>r.ok)).toBe(true);expect(results[0].result).toEqual(results[1].result);expect(t.store.load()!.batches[0].aggregate.audit.filter(a=>a.eventType==="locked-billing-approved")).toHaveLength(1);
    expect(s.kernel.getBudget(reviewer,"project-a")).toMatchObject({spentMinor:65,reservedMinor:0,limitMinor:1000});
  });
});
describe("protected shared project budget competition",()=>{
  let t:Task,other:Task,one:ReturnType<typeof setup>,two:ReturnType<typeof setup>;
  beforeEach(async()=>{
    t=await fixture({manual:true},false);const p2=await t.prepare("owned-second"),v2=await t.confirm(p2),l=t.kernel.claimLockedProductionImageBatch(principal,"project-a",v2.batchId,{workerId:"owned-worker",maxJobs:1}).leases[0];
    await t.reconstruction.executeFixture(principal,"project-a",v2.batchId,v2.jobId,{workerId:l.workerId,leaseId:l.leaseId});
    other={...t,v:v2};one=setup(t);two=setup(other);
  });
  it("同一1000预算两600实费各40预留竞争只有一笔，审批不足不消耗决定",async()=>{
    const pending1=one.service.settle(...one.args,one.request(600)),pending2=two.service.settle(...two.args,two.request(600));
    const processes=[spawnBilling(t,{reviewId:pending1.request.reviewId,decision:one.decision(pending1)}),spawnBilling(other,{reviewId:pending2.request.reviewId,decision:two.decision(pending2)})];
    await Promise.all(processes.map(p=>p.ready));processes.forEach(p=>p.child.send("go"));const results=await Promise.all(processes.map(p=>p.result));expect(results.filter(r=>r.ok)).toHaveLength(1);
    expect(one.kernel.getBudget(reviewer,"project-a")).toMatchObject({limitMinor:1000,spentMinor:600,reservedMinor:40,availableMinor:360});
    const pending=t.store.load()!.batches.find(b=>b.reservedMinor===40)!;expect(pending.lockedProductionImageBilling![0].status).toBe("pending");expect(pending.lockedProductionImageBilling![0].decision).toBeUndefined();
    expect(pending.aggregate.audit.filter(a=>a.eventType==="locked-billing-approved")).toHaveLength(0);
  });
});
describe("protected production zero-cap and multipart fees",()=>{
  it("结算后仍核历史原jobTimeout与实际配置，不借新失败原因跳过",async()=>{
    const t=await fixture({production:true,kernel:{jobTimeoutMs:1000}},false),s=setup(t,t.store,{}, {jobTimeoutMs:1000});
    expect(s.snapshot.unknownReason).toBe("locked-job-timeout-after-intent");s.service.settle(...s.args,s.request(0));
    expect(t.store.load()!.batches[0].aggregate.jobs[0].failureCode).toBe("locked-billing-settled-no-artifact");
    s.kernelOptions.jobTimeoutMs=2000;
    expect(()=>s.kernel.validateProductionBillingSnapshot(t.store.load()!)).toThrow();
    expect(()=>s.service.inspect(...s.args)).toThrow();
  });
  it.each([false,true])("从头production manual=%s假来源，不从not-connected推零费",async manual=>{
    const t=await fixture({production:true,manual},false),s=setup(t),r=s.service.settle(...s.args,s.request(0));expect(r.mode).toBe("production");
    expect(r.snapshot).toMatchObject({attemptFingerprint:null,resultFingerprint:null,artifactFingerprint:null,pixelProofFingerprint:null});
    expect(t.store.load()!.batches[0].aggregate.jobs[0]).toMatchObject({status:"failed",actualCostMinor:0});expect(t.send).not.toHaveBeenCalled();expect(s.source.verify).toHaveBeenCalledTimes(2);
  });
  it.each([0,40])("manual cap=%s必须独立来源才能释放，不把上限变成估价",async cap=>{
    const t=await fixture({manual:true,cap},false),s=setup(t),r=s.service.settle(...s.args,s.request(0));expect(r.snapshot.estimate).toEqual({state:"unknown"});
    expect(t.store.load()!.batches[0].aggregate.ledger.at(-1)).toMatchObject({settlement:"released",estimatedMinor:null,actualMinor:0,reservedMinor:0});
    expect(t.store.load()!.batches[0].jobReservations).toEqual([]);expect(s.kernel.getBudget(reviewer,"project-a")).toMatchObject({spentMinor:0,reservedMinor:0});
    await expect(t.artifact.ingest(principal,"project-a",t.v.batchId,t.v.jobId,t.input)).rejects.toThrow();
  });
  it.each(["multipart-image-array","multipart-image-single"] as const)("原%s受保护费用不重建请求",async encoding=>{
    const t=await fixture({protocol:"openai-compatible",encoding,manual:true}),s=setup(t),rebuild=vi.spyOn(wire,"prepareLockedProductionImageProtocol");
    expect(s.service.settle(...s.args,s.request()).status).toBe("settled");expect(rebuild).not.toHaveBeenCalled();expect(t.send).toHaveBeenCalledTimes(1);
  });
});
describe("protected immutable rejected history capacity",()=>{
  let t:Task,s:ReturnType<typeof setup>;
  beforeEach(async()=>{t=await fixture({manual:true},false);s=setup(t);});
  // Separate bounded synchronous stages retain the default 5s for every hook.
  for(let group=0;group<4;group++)beforeEach(()=>{for(let index=group*4;index<(group+1)*4;index++){
    const p=s.service.settle(...s.args,s.request(65,`history-${index}`));s.service.decide(...s.approveArgs,p.request.reviewId,s.decision(p,"reject",`decision-${index}`));
  }});
  it("16份历史不删除腾空间，第17动作拒绝且预留守恒",()=>{
    const before=t.store.load(),records=s.service.inspect(...s.args);expect(records).toHaveLength(16);expect(records.every(r=>r.status==="rejected")).toBe(true);
    s.source.verify.mockClear();expect(()=>s.service.settle(...s.args,s.request(25,"history-17"))).toThrow();expect(t.store.load()).toEqual(before);
    expect(s.kernel.getBudget(reviewer,"project-a")).toMatchObject({spentMinor:0,reservedMinor:40,availableMinor:960});expect(s.source.verify).not.toHaveBeenCalled();
  });
});
