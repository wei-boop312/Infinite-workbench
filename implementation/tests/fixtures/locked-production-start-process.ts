import { SqliteRunKernel } from "../../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../../apps/api/src/sqliteRunKernelStore";
import { createLockedProductionImageLeaseFixturePolicy } from "../../apps/api/src/lockedProductionImageLeasePolicy";
import { LockedImageProductionReconstructionHarness } from "../../apps/api/src/lockedProductionImageTaskReconstruction";

// Only a test-owned path and previously persisted actual lease; no network port.
let command: { path: string; batch: string; job: string; now: number; input: {workerId:string;leaseId:string} };
process.on("message", async message => {
  if (message !== "go") { command = message as typeof command; process.send?.({ready:true}); return; }
  const store = new SqliteRunKernelStateStore(command.path,{productionResponseStorageEnabled:true,productionArtifactStorageEnabled:true});
  try {
    const principal = {tenantId:"tenant-a",actorId:"writer"}, clock = () => command.now;
    const authorizer = {authenticate:() => principal,allows:(p:typeof principal, project:string) => p.tenantId === principal.tenantId && p.actorId === principal.actorId && project === "project-a"};
    const policy = createLockedProductionImageLeaseFixturePolicy({lockedLeaseEnabled:true,tenantId:principal.tenantId,stateStore:store,clock,
      pricePort:{kind:"contract-fixture",realExecutionEnabled:false,verify:() => true},runAuthorizer:authorizer,providerAuthorizer:authorizer,assetAuthorizer:authorizer,lockedLeasePolicy:() => true});
    let rebuild!: LockedImageProductionReconstructionHarness;
    const kernel = new SqliteRunKernel({stateStore:store,authorizer,clock,budgets:[{tenantId:principal.tenantId,projectId:"project-a",currency:"CNY",limitMinor:1000}],
      lockedProductionImageLeasePolicy:policy,lockedProductionImageStartPolicy:{usesStateStore:s => rebuild.usesStateStore(s),authorizeScope:(p,project) => rebuild.authorizeScope(p,project),validateStart:(p,e,l,i) => rebuild.validateStart(p,e,l,i)}});
    rebuild = new LockedImageProductionReconstructionHarness({lockedReconstructionEnabled:true,lockedStartEnabled:true,tenantId:principal.tenantId,stateStore:store,runKernel:kernel,leasePolicy:policy,clock,lockedStartPolicy:() => true});
    const result = await rebuild.start(principal,"project-a",command.batch,command.job,command.input);
    store.close(); process.send?.({ok:true,result}); process.disconnect();
  } catch { store.close(); process.send?.({ok:false}); process.disconnect(); }
});
