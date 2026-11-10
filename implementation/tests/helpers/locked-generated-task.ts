import { createRequire } from "node:module";
import { prepareLockedTaskFixture } from "./locked-production-task-fixture";
import { principal } from "./image-task-fixture";
import { LockedImageProductionArtifactHarness } from "../../apps/api/src/lockedProductionImageTaskArtifacts";
import { LockedImageProductionGeneratedAssetReadHarness } from "../../apps/api/src/lockedProductionGeneratedAssetReads";
import { LockedImageProductionBillingReviewHarness } from "../../apps/api/src/lockedProductionImageBillingReview";
import { LockedImageProductionBillingSettlementHarness } from "../../apps/api/src/lockedProductionImageBillingSettlement";
import { SqliteRunKernel } from "../../apps/api/src/sqliteRunKernel";
import { imageSnapshotFingerprint as fp } from "../../apps/api/src/imageProviderContract";
const sharp = createRequire(new URL("../../apps/api/package.json", import.meta.url))("sharp");
export async function ownedLockedGeneratedTask(opts: Parameters<typeof prepareLockedTaskFixture>[2] = {}) {
  const png = (v: number[]) => sharp(Buffer.from(v), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const source = await png([40,70,90,255,1,2,3,255]), mask = await png([255,255,255,0,255,255,255,255]);
  let artifacts: LockedImageProductionArtifactHarness;
  const f = await prepareLockedTaskFixture(source, mask, { ...opts, kernel: { ...opts.kernel, lockedProductionImageArtifactPolicy: {
    usesStateStore: s => artifacts.usesStateStore(s), authorizeScope: (p,j) => artifacts.authorizeScope(p,j), validateCommit: (p,r) => artifacts.validateCommit(p,r),
  } } });
  try {
    artifacts = new LockedImageProductionArtifactHarness({ lockedArtifactEnabled:true, tenantId:principal.tenantId, stateStore:f.store, runKernel:f.kernel, clock:f.clock,
      runAuthorizer:f.authorizer, providerAuthorizer:f.authorizer, assetAuthorizer:f.authorizer, lockedArtifactPolicy:()=>true });
    await f.execute(); await artifacts.ingest(principal,"project-a",f.v.batchId,f.v.jobId,f.input);
    const actor={...principal,actorId:"owned-read-only"}, denied=new Set<string>(), auth={authenticate:()=>actor,
      allows:(p:typeof principal,project:string,permission:string)=>p.tenantId===principal.tenantId&&project==="project-a"&&!denied.has(permission)};
    let kernel=f.kernel;
    const reader=()=>new LockedImageProductionGeneratedAssetReadHarness({lockedGeneratedReadEnabled:true,tenantId:principal.tenantId,stateStore:f.store,runKernel:kernel,
      clock:f.clock,assetAuthorizer:auth,runAuthorizer:auth,lockedGeneratedReadPolicy:()=>true});
    const saved=()=>f.store.load()!.batches[0],id=saved().lockedProductionImageArtifact!.image.asset.id;
    const settle=(cost=25)=>{
      let service:LockedImageProductionBillingSettlementHarness;
      const policy={usesStateStore:(s:unknown)=>service.billingPolicy.usesStateStore(s),authorizeScope:(p:typeof principal,j:string,a:boolean)=>service.billingPolicy.authorizeScope(p,j,a),
        validateCommit:(p:typeof principal,r:any)=>service.billingPolicy.validateCommit(p,r),validateOriginal:(p:typeof principal,r:any)=>service.billingPolicy.validateOriginal(p,r)};
      kernel=new SqliteRunKernel({stateStore:f.store,authorizer:auth,budgets:f.store.load()!.budgets,clock:f.clock,lockedProductionImageBillingPolicy:policy});
      const options={tenantId:principal.tenantId,stateStore:f.store,runKernel:kernel,clock:f.clock,runAuthorizer:auth,providerAuthorizer:auth,assetAuthorizer:auth,
        billingSource:{kind:"contract-fixture" as const,realExecutionEnabled:false as const,verify:()=>true}};
      service=new LockedImageProductionBillingSettlementHarness({...options,lockedBillingSettlementEnabled:true,lockedBillingSettlementPolicy:()=>true});
      const review=new LockedImageProductionBillingReviewHarness({...options,lockedBillingReviewEnabled:true,lockedBillingReviewPolicy:()=>true});
      const reviewer={...actor,actorId:"owned-fee-reviewer"},approver={...actor,actorId:"owned-fee-approver"},args=[reviewer,"project-a",f.v.batchId,f.v.jobId] as const;
      const snapshot=review.inspect(...args),record=service.settle(...args,{reviewId:"owned-cache-fee",expectedSnapshotFingerprint:fp(snapshot),
        expectedProtectionPolicyFingerprint:snapshot.protectionPolicyFingerprint,expectedCurrency:snapshot.currency,expectedReservedMinor:snapshot.reservedMinor,expectedMaxCostMinor:snapshot.maxCostMinor,
        resolution:cost?"charged":"not-charged",actualCostMinor:cost,evidence:{sourceId:"owned-fake-billing",sourceVersion:"v1",evidenceRef:"owned-fake-bill",checksumSha256:"a".repeat(64),observedAt:snapshot.unknownAt}});
      if(record.status==="pending") service.decide(approver,"project-a",f.v.batchId,f.v.jobId,record.request.reviewId,{decisionId:"owned-cache-approval",
        expectedRecordFingerprint:fp(record),expectedSnapshotFingerprint:record.snapshotFingerprint,expectedProtectionPolicyFingerprint:record.snapshot.protectionPolicyFingerprint,
        expectedCurrency:snapshot.currency,expectedReservedMinor:snapshot.reservedMinor,expectedActualCostMinor:cost,decision:"approve",evidenceRef:"owned-approval",note:"自有假费用"});
      return saved();
    };
    return {...f,artifacts,source,mask,actor,auth,denied,reader,saved,id,settle};
  } catch(e) {f.cleanup();throw e;}
}
