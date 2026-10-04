import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ReviewProductionImageBillingSchema, ProductionImageBillingReviewSchema, type ReviewProductionImageBilling } from "../packages/contracts/src/index";
import { ImageProductionBillingReviewHarness, ProductionImageBillingReviewService, type ProductionBillingSourceContext } from "../apps/api/src/productionImageBillingReview";
import { productionBillingTaskFixture as fixture } from "./helpers/production-billing-task-fixture";
import { principal } from "./helpers/image-task-fixture";
import { imageSnapshotFingerprint as fp } from "../apps/api/src/imageProviderContract";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import * as decoder from "../apps/api/src/staticImageDecoder";
import * as protocol from "../apps/api/src/productionImageProtocol";

const reviewer = { ...principal, actorId: "other" };
type Task = Awaited<ReturnType<typeof fixture>>;
function service(t: Task, extra: Record<string, unknown> = {}) {
  const source = { kind: "contract-fixture" as const, realExecutionEnabled: false as const,
    verify: vi.fn((c: ProductionBillingSourceContext) => c.principal.actorId === reviewer.actorId && c.snapshotFingerprint === fp(c.snapshot)
      && c.request.evidence.sourceId === "owned-billing" && c.request.evidence.sourceVersion === "v1" && c.request.evidence.evidenceRef === "owned-no-real-bill") };
  const options = { billingReviewEnabled: true as const, tenantId: principal.tenantId, stateStore: t.f.store, runKernel: t.f.kernel,
    runAuthorizer: t.auth, providerAuthorizer: t.auth, assetAuthorizer: t.auth, clock: t.f.clock, billingSource: source, ...extra };
  return { review: new ImageProductionBillingReviewHarness(options), options, source,
    args: [reviewer, "project-a", t.args[2], t.args[3]] as const };
}
function request(s: ReturnType<ImageProductionBillingReviewHarness["inspect"]>, actual = 25): ReviewProductionImageBilling {
  return { reviewId: "owned-review", expectedSnapshotFingerprint: fp(s), expectedCurrency: s.currency, expectedReservedMinor: s.reservedMinor,
    expectedMaxCostMinor: s.maxCostMinor, resolution: actual ? "charged" : "not-charged", actualCostMinor: actual,
    evidence: { sourceId: "owned-billing", sourceVersion: "v1", evidenceRef: "owned-no-real-bill", checksumSha256: "1".repeat(64), observedAt: s.unknownAt } };
}
function sql(t: Task, code: (d: DatabaseSync) => void) { const d = new DatabaseSync(t.f.path); try { code(d); } finally { d.close(); } }

describe.each((["openai", "openai-compatible", "google"] as const).flatMap(protocol => [true,false].flatMap(manual => [true,false].map(artifact => [protocol,manual,artifact] as const))))(
  "6D7A %s unknown=%s artifact=%s", (protocolName,manual,artifact) => {
    it("独立核账人只读实际完整关系，人工核验不结算或借用原发送身份", async () => {
      const t = await fixture({ protocol: protocolName, manual, edit: true, bad: !artifact });
      if (artifact) await t.artifacts.ingest(...t.args);
      const { review, args, source } = service(t), before = t.f.store.load(), catalog = t.f.store.loadCatalog();
      t.denied.add("run:execute"); t.denied.add("asset:write"); // Billing has neither permission and does not borrow the original actor.
      const save = vi.spyOn(t.f.store,"save"), normalize = vi.spyOn(protocol,"prepareProductionImageProtocol"), decode = vi.spyOn(decoder,"decodeStaticImage");
      const s = review.inspect(...args), r = review.verify(...args,request(s));
      expect(s.estimate).toEqual(manual ? { state:"unknown" } : { state:"known", estimatedCostMinor:25 });
      expect(s.originalActorId).toBe(principal.actorId); expect(r.reviewedBy).toBe(reviewer.actorId);
      expect(r).toMatchObject({validation:"verified-uncommitted",settlementCommitted:false,settlementAuthorized:false,executionAuthorized:false,realExecutionEnabled:false});
      expect(s.outputAssetIds).toEqual(artifact ? [t.saved().productionImageArtifact!.image.asset.id] : []);
      expect(source.verify).toHaveBeenCalledTimes(1); expect(source.verify.mock.calls[0][0].request.actualCostMinor).toBe(25);
      expect(t.f.store.load()).toEqual(before); expect(t.f.store.loadCatalog()).toEqual(catalog); expect(save).not.toHaveBeenCalled();
      expect(normalize).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); expect(t.send).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(s)).not.toMatch(/https:|data:|base64|authRef|idempotencyKey|人工原构图/);
    });
  });

describe("6D7A 权限、费用来源、故障及历史隔离", () => {
  it("缺省/错误模式/同路径不同实例在私有读取前关闭", async () => {
    const t = await fixture(), {review,args,options} = service(t), read = vi.spyOn(t.f.store,"load");
    expect(()=>new ImageProductionBillingReviewHarness().inspect(...args)).toThrow(); expect(()=>new ProductionImageBillingReviewService().inspect(...args)).toThrow();
    expect(()=>new ProductionImageBillingReviewService(options as never).inspect(...args)).toThrow();
    expect(()=>new ImageProductionBillingReviewHarness({...options,billingReviewEnabled:false} as never).inspect(...args)).toThrow();
    expect(read).not.toHaveBeenCalled();
    const other = new SqliteRunKernelStateStore(t.f.path,{productionArtifactStorageEnabled:true,productionResponseStorageEnabled:true});
    try { const oread=vi.spyOn(other,"load"); expect(()=>new ImageProductionBillingReviewHarness({...options,stateStore:other}).inspect(...args)).toThrow();expect(oread).not.toHaveBeenCalled(); }
    finally { other.close(); } expect(()=>review.inspect(...args)).not.toThrow();
  });
  it.each(["run:read","run:reconcile-billing","provider:read","asset:read"])("%s 当前撤权在私有任务和BLOB前拒绝", async permission => {
    const t=await fixture(),{review,args}=service(t);t.denied.add(permission);const read=vi.spyOn(t.f.store,"load"),raw=vi.spyOn(t.f.store,"loadProductionImageResponse");
    expect(()=>review.inspect(...args)).toThrow(); expect(read).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
  });
  it.each(["promise","rejected","truthy","private-error"])("范围政策%s不当同步许可，不泄秘密", async kind => {
    const t=await fixture(),{review,args}=service(t); vi.spyOn(t.auth,"allows").mockImplementation(()=>{if(kind==="private-error")throw new Error("owned-secret"); return (kind==="truthy"?1:kind==="promise"?Promise.resolve(true):Promise.reject(new Error("owned-secret"))) as never;});
    const read=vi.spyOn(t.f.store,"load");expect(()=>review.inspect(...args)).not.toThrow("owned-secret");expect(()=>review.inspect(...args)).toThrow();expect(read).not.toHaveBeenCalled();
  });
  it.each(["tenant","project","job","batch"])("实际%s错配不能借用核账证据", async kind => {
    const t=await fixture(),{review,args}=service(t);const a=[...args] as unknown as Parameters<typeof review.inspect>;
    if(kind==="tenant")a[0]={...reviewer,tenantId:"other-tenant"};if(kind==="project")a[1]="other-project";if(kind==="job")a[3]="mock-job";if(kind==="batch")a[2]="mock-batch";
    expect(()=>review.inspect(...a)).toThrow();
  });
  it.each(["hash","currency","reserved","cap"])("人工期待%s漂移在费用端口前拒绝", async kind => {
    const t=await fixture(),{review,args,source}=service(t),s=review.inspect(...args),r=request(s);
    if(kind==="hash")r.expectedSnapshotFingerprint="0".repeat(64);if(kind==="currency")r.expectedCurrency="USD";if(kind==="reserved")r.expectedReservedMinor++;if(kind==="cap")r.expectedMaxCostMinor++;
    expect(()=>review.verify(...args,r)).toThrow();expect(source.verify).not.toHaveBeenCalled();
  });
  it.each(["false","promise","rejected","truthy","private-error","wrong-source"])("费用来源%s不能由标签/usage/图片证明", async kind => {
    const t=await fixture(),{review,args,source}=service(t),s=review.inspect(...args),r=request(s),before=t.f.store.load();
    if(kind==="wrong-source")r.evidence.sourceId="self-reported";
    else source.verify.mockImplementation(()=>{if(kind==="private-error")throw new Error("owned-secret");return(kind==="false"?false:kind==="truthy"?1:kind==="promise"?Promise.resolve(true):Promise.reject(new Error("owned-secret"))) as never;});
    expect(()=>review.verify(...args,r)).toThrow();expect(()=>review.verify(...args,r)).not.toThrow("owned-secret");expect(t.f.store.load()).toEqual(before);
  });
  it("端口只接深拷贝，不能修改人工原请求或任务",async()=>{
    const t=await fixture(),{review,args,source}=service(t),s=review.inspect(...args),r=request(s),before=t.f.store.load();
    source.verify.mockImplementation(c=>{c.request.actualCostMinor=999;c.snapshot.originalActorId="forged";c.principal.actorId="forged";return true;});
    expect(review.verify(...args,r).request).toEqual(r);expect(r.actualCostMinor).toBe(25);expect(t.f.store.load()).toEqual(before);
  });
  it.each(["revoke","input","constraint","task","backward","future-evidence"])("费用verify期间%s复查并保持原任务",async kind=>{
    const t=await fixture({edit:true}),{review,args,source}=service(t),s=review.inspect(...args),r=request(s),before=t.f.store.load(),catalog=t.f.store.loadCatalog();
    if(kind==="future-evidence")r.evidence.observedAt=new Date(t.f.clock()+1).toISOString();
    source.verify.mockImplementation(()=>{if(kind==="revoke")t.denied.add("run:reconcile-billing");if(kind==="backward")t.f.advance(-1);
      if(kind==="input"||kind==="constraint"){const c=t.f.store.loadCatalog()!;if(kind==="input")c.projects[0].assets[0].originalName="changed";else c.projects[0].constraints[0].brandRules.style="changed";t.f.store.saveCatalog(c);}
      if(kind==="task"){const x=t.f.store.load()!;x.batches[0].aggregate.jobs[0].leaseOwnerId="changed";t.f.store.save(x);}return true;});
    expect(()=>review.verify(...args,r)).toThrow();expect(t.f.store.load()).toEqual(before);expect(t.f.store.loadCatalog()).toEqual(catalog);
    if(kind==="future-evidence")expect(source.verify).not.toHaveBeenCalled();
  });
  it("0费用/0上限与超预留核验均不释放，超额明确需要独立审批",async()=>{
    const t=await fixture({cap:0,bad:true}),{review,args}=service(t),s=review.inspect(...args),before=t.f.store.load();
    expect(review.verify(...args,request(s,0)).requiresIndependentOverageApproval).toBe(false);
    expect(review.verify(...args,request(s,1)).requiresIndependentOverageApproval).toBe(true);
    expect(t.f.store.load()).toEqual(before);expect(t.saved().jobReservations).toEqual([[t.args[3],0]]);
  });
  it("过期报价/停用目录/正常时钟推进仍可核原历史，不询价或新发送",async()=>{
    const t=await fixture(),{review,args,source}=service(t);await t.artifacts.ingest(...t.args);const original=review.inspect(...args),calls=t.price.verify.mock.calls.length;
    t.f.advance(120000);t.f.register({...t.config,revision:2,enabled:false});source.verify.mockImplementation(()=>{t.f.advance(1);return true;});
    expect(review.inspect(...args)).toEqual(original);expect(review.verify(...args,request(original)).reviewedAt).toBe(new Date(t.f.clock()).toISOString());
    expect(t.price.verify).toHaveBeenCalledTimes(calls);expect(t.price.read).toHaveBeenCalledTimes(1);expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("重放/第二连接重启只读同一证据，不结算、不占发送身份",async()=>{
    const t=await fixture(),{review,args,options}=service(t);await t.artifacts.ingest(...t.args);const s=review.inspect(...args),r=request(s),before=t.f.store.load();
    expect(review.verify(...args,r)).toEqual(review.verify(...args,r));
    const other=new SqliteRunKernelStateStore(t.f.path,{productionArtifactStorageEnabled:true,productionResponseStorageEnabled:true});
    try {const k=new SqliteRunKernel({...t.kernelOptions,stateStore:other,authorizer:t.auth,budgets:[{tenantId:principal.tenantId,projectId:"project-a",currency:"CNY",limitMinor:1000}],clock:t.f.clock});
      const service2=new ImageProductionBillingReviewHarness({...options,stateStore:other,runKernel:k});expect(service2.inspect(...args)).toEqual(s);expect(service2.verify(...args,r)).toEqual(review.verify(...args,r));}
    finally{other.close();}expect(t.f.store.load()).toEqual(before);expect(t.send).toHaveBeenCalledTimes(1);
  });
  it.each(["raw-marker","raw-body","artifact-marker","artifact-body","task","audit","orphan"])("%s损坏不能由纯SHA补成核账依据",async kind=>{
    const t=await fixture(),{review,args}=service(t);const artifact=await t.artifacts.ingest(...t.args);
    if(kind==="raw-marker")sql(t,d=>d.exec("DELETE FROM production_image_response_presence"));
    if(kind==="raw-body")sql(t,d=>d.prepare("UPDATE production_image_responses SET body=?").run(Buffer.from("broken")));
    if(kind==="artifact-marker")sql(t,d=>d.exec("DELETE FROM production_image_artifact_presence"));
    if(kind==="artifact-body")sql(t,d=>d.prepare("UPDATE verified_images SET body=? WHERE asset_id=?").run(Buffer.from("broken"),artifact.image.asset.id));
    if(["task","audit","orphan"].includes(kind)){const x=t.f.store.load()!,b=x.batches[0];if(kind==="task")b.productionImageAttemptFingerprint="0".repeat(64);
      if(kind==="audit")b.aggregate.audit=b.aggregate.audit.filter(a=>a.eventType!=="billing-unknown");
      if(kind==="orphan"){delete b.productionImageArtifact;delete b.productionImageArtifactFingerprint;b.aggregate.jobs[0].outputAssetIds=[];b.aggregate.audit=b.aggregate.audit.filter(a=>a.eventType!=="production-image-artifact-verified");}t.f.store.transaction(()=>t.f.store.save(x));}
    expect(()=>review.inspect(...args)).toThrow();expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("原包读取后撤权清自有BLOB副本，持久原包不改",async()=>{
    const t=await fixture(),{review,args}=service(t),read=t.f.store.loadProductionImageResponse.bind(t.f.store);let body:Buffer|undefined;
    vi.spyOn(t.f.store,"loadProductionImageResponse").mockImplementation((...a)=>{const r=read(...a);body=r?.body;t.denied.add("asset:read");return r;});
    expect(()=>review.inspect(...args)).toThrow();expect(body?.every(v=>v===0)).toBe(true);vi.restoreAllMocks();const original=read(principal.tenantId,"project-a","production-contract-fixture",t.args[3])!;expect(original.body.some(v=>v!==0)).toBe(true);original.body.fill(0);
  });
  it.each(["NaN","quota"])("%s失效不能读取并处理原包",async kind=>{
    const t=await fixture(),{review,args}=service(t,kind==="NaN"?{clock:()=>NaN}:{maxMetadataBytes:0}),raw=vi.spyOn(t.f.store,"loadProductionImageResponse");
    expect(()=>review.inspect(...args)).toThrow();expect(raw).not.toHaveBeenCalled();
  });
  it("草稿/客户端字段不能打开旧生产核账或结算路径",async()=>{
    const t=await fixture(),{review,args}=service(t),s=review.inspect(...args),r=request(s),draft=review.verify(...args,r);
    expect(ProductionImageBillingReviewSchema.safeParse({...draft,settlementCommitted:true}).success).toBe(false);
    expect(ReviewProductionImageBillingSchema.safeParse({...r,confirmed:true}).success).toBe(false);
    expect(ReviewProductionImageBillingSchema.safeParse({...r,resolution:"not-charged"}).success).toBe(false);
    expect(ReviewProductionImageBillingSchema.safeParse({...r,actualCostMinor:Number.MAX_SAFE_INTEGER+1}).success).toBe(false);
    expect(ReviewProductionImageBillingSchema.safeParse({...r,evidence:{...r.evidence,evidenceRef:"https://private.invalid/bill"}}).success).toBe(false);
    const before=t.f.store.load();expect(()=>t.f.kernel.resolveBillingUnknown(principal,t.args[3],{resolutionId:"legacy",resolution:"not-charged",expectedReservedMinor:40,expectedCurrency:"CNY",evidenceRef:"not-authorized"} as never)).toThrow();expect(t.f.store.load()).toEqual(before);
  });
  it("生产server-billing标签不能把实际合同夹具改标为生产",async()=>{
    const t=await fixture(),{args,options}=service(t);const verify=vi.fn(()=>true);
    const production=new ProductionImageBillingReviewService({...options,billingSource:{kind:"server-billing",verify}});
    expect(()=>production.inspect(...args)).toThrow();expect(verify).not.toHaveBeenCalled();
  });
  it("原包读取后当前约束漂移阻断只读快照，而不接受先前目录",async()=>{
    const t=await fixture(),{review,args}=service(t),read=t.f.store.loadProductionImageResponse.bind(t.f.store),catalog=t.f.store.loadCatalog();
    vi.spyOn(t.f.store,"loadProductionImageResponse").mockImplementation((...a)=>{const r=read(...a),c=t.f.store.loadCatalog()!;c.projects[0].constraints[0].brandRules.style="changed";t.f.store.saveCatalog(c);return r;});
    expect(()=>review.inspect(...args)).toThrow();expect(t.f.store.loadCatalog()).toEqual(catalog);
  });
  it("删全部实际result字段且重算有效未知恢复关系，也不能忽略孤立原包",async()=>{
    const t=await fixture(),{review,args}=service(t),x=t.f.store.load()!,b=x.batches[0],j=b.aggregate.jobs[0];
    t.f.advance(30000);j.finishedAt=new Date(t.f.clock()).toISOString();j.failureCode="production-lease-expired-after-intent";
    delete b.productionImageResult;delete b.productionImageResultFingerprint;
    b.aggregate.audit=b.aggregate.audit.filter(a=>a.eventType!=="production-image-returned");
    const unknown=b.aggregate.audit.find(a=>a.eventType==="billing-unknown")!;unknown.createdAt=j.finishedAt;unknown.metadata.reason=j.failureCode;
    b.aggregate.ledger.find(l=>l.settlement==="unknown")!.createdAt=j.finishedAt;t.f.store.transaction(()=>t.f.store.save(x));
    expect(()=>t.f.kernel.validateProductionBillingSnapshot(x)).not.toThrow();expect(()=>review.inspect(...args)).toThrow();expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("原租约期限须匹配实际内核，不能用只读默认期限覆盖配置",async()=>{
    const t=await fixture(),before=t.f.store.load()!;
    expect(()=>t.f.kernel.validateProductionBillingSnapshot(before)).not.toThrow();
    const isolated=new SqliteRunKernelStateStore(":memory:");
    try {
      // Only exercise the pure configured validator on an unmodified complete
      // snapshot. This other store cannot authorize an actual billing review.
      const alternate=new SqliteRunKernel({...t.kernelOptions,stateStore:isolated,leaseDurationMs:60000,authorizer:t.auth,
        budgets:[{tenantId:principal.tenantId,projectId:"project-a",currency:"CNY",limitMinor:1000}],clock:t.f.clock});
      expect(()=>alternate.validateProductionBillingSnapshot(before)).toThrow("原租约期限与实际内核配置不一致");
    } finally {isolated.close();}
    expect(t.f.store.load()).toEqual(before);
  });
});
