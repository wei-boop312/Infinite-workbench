import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {LocalWorkspaceDatabase} from '../apps/api/src/localWorkspaceDatabase';
import {LocalWorkflowVersions} from '../apps/api/src/localWorkflowVersions';
import {LocalBoundRuns} from '../apps/api/src/localBoundRuns';
import {LocalAgentReview} from '../apps/api/src/localAgentReview';
import {LocalAgentExecution} from '../apps/api/src/localAgentExecution';
import {LocalRunExecution} from '../apps/api/src/localRunExecution';
import {WorkspaceModelGateway} from '../apps/api/src/workspaceModelGateway';
import {createLocalWorkspaceHttp} from '../apps/api/src/localWorkspaceHttp';
import {LocalResizeWorker,type OwnedResizeRuntime} from '../apps/worker/src/localResizeWorker';
import type {LocalWorkspaceAssets} from '../apps/api/src/localWorkspaceAssets';
import type {LocalRunArtifactStore} from '../apps/api/src/localRunArtifactStore';
let db:LocalWorkspaceDatabase,runs:LocalBoundRuns,agent:LocalAgentExecution,worker:LocalRunExecution;
const actor=randomUUID(),other=randomUUID(),gateway=()=>new WorkspaceModelGateway({compilerConfigured:true,localResizeExecutor:false});
beforeAll(async()=>{db=await LocalWorkspaceDatabase.open(process.cwd());runs=new LocalBoundRuns(db,'b'.repeat(64),gateway());agent=new LocalAgentExecution(db,runs,gateway());worker=new LocalRunExecution(db,'b'.repeat(64),gateway());});afterAll(async()=>{await db?.close();});
async function fixture(level:'L0'|'L1'|'L2'|'L3'='L1',ttlSeconds=600,owner=actor){
  const project=randomUUID();await db.seedProject(project,'owned agent execution',[{userId:owner,role:'owner'},{userId:other,role:'designer'}]);const repo=new LocalWorkflowVersions(db),template=await repo.ensureResizeTemplate(owner,project),asset=randomUUID(),lease=await db.acquireLease(owner,project);
  await db.asActor(owner,tx=>tx.query("INSERT INTO workspace.asset_versions VALUES($1,$2,$3,'ready','owned-fixture')",[project,asset,'a'.repeat(64)]));
  const source={id:randomUUID(),projectId:project,revision:1,type:'image',assetVersionId:asset,x:0,y:0,width:100,height:100},tool={id:randomUUID(),projectId:project,revision:1,type:'tool',templateVersionId:template.id,x:200,y:0,width:100,height:100};await db.saveCanvasOperation(owner,project,{id:randomUUID(),baseRevision:0,objects:[source,tool]},lease);
  const binding=await repo.bind(owner,project,{id:randomUUID(),projectId:project,taskLineId:randomUUID(),sourceObjectId:source.id,sourceObjectRevision:1,toolObjectId:tool.id,toolObjectRevision:1,templateVersionId:template.id});
  const grant=(await agent.authority.createGrant(owner,project,{id:randomUUID(),level,bindingIds:[binding.id],ttlSeconds,maxActions:2,maxPixels:65536})).grant,proposal=(await agent.authority.propose(owner,project,grant.id,{id:randomUUID(),bindingId:binding.id,parameters:{width:64,height:64}})).proposal,nonce=randomUUID();
  return {project,source,lease,binding,grant,proposal,nonce,input:{id:randomUUID(),proposalId:proposal.id,hash:proposal.approvalHash,nonce:level==='L1'?nonce:null}};
}
async function approve(f:Awaited<ReturnType<typeof fixture>>){await agent.authority.approve(actor,f.project,f.proposal.id,{hash:f.proposal.approvalHash,nonce:f.nonce});}
async function counts(project:string){return db.asActor(actor,async tx=>{const result:Record<string,number>={};for(const table of ['run_snapshots','runs','outbox','run_attempts','agent_execution_consumptions'])result[table]=(await tx.query(`SELECT * FROM workspace.${table} WHERE project_id=$1`,[project])).rows.length;return result;});}
it('L1 requires exact approval and consumes once with snapshot/run/outbox; retries never enqueue again',async()=>{
  const f=await fixture();await expect(agent.execute(actor,f.project,f.input)).rejects.toThrow('AGENT_APPROVAL_REQUIRED');await approve(f);
  await expect(agent.execute(actor,f.project,{...f.input,hash:'a'.repeat(64)})).rejects.toThrow('AGENT_APPROVAL_CHANGED');
  const results=await Promise.all([1,2,3].map(()=>agent.execute(actor,f.project,f.input)));expect(new Set(results.map(r=>r.id)).size).toBe(1);expect(results.filter(r=>!r.reused)).toHaveLength(1);
  expect(await counts(f.project)).toEqual({run_snapshots:1,runs:1,outbox:1,run_attempts:0,agent_execution_consumptions:1});
  const run=await runs.read(actor,f.project,results[0].id);expect(run.snapshot).toMatchObject({schemaVersion:3,agentExecution:{mode:'local_resize_execute',policyVersion:'local-agent-execute-v1',consumptionId:f.input.id,proposalId:f.proposal.id,nonce:f.nonce}});
  await expect(agent.execute(actor,f.project,{...f.input,id:randomUUID()})).rejects.toThrow('IDEMPOTENCY_CONFLICT');await expect(agent.execute(other,f.project,f.input)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  await agent.authority.revoke(actor,f.project,f.grant.id,'stop');expect(await agent.execute(actor,f.project,f.input)).toMatchObject({id:run.id,reused:true});await expect(worker.claim(actor,f.project,run.id,randomUUID())).rejects.toThrow('AGENT_GRANT_REVOKED');expect((await counts(f.project)).run_attempts).toBe(0);
});
it('failure when inserting consumption rolls back snapshot/run/outbox and preserves approval for explicit retry',async()=>{
  const f=await fixture();await approve(f);const admin=(db as unknown as {db:{exec:(sql:string)=>Promise<unknown>}}).db;
  await admin.exec("CREATE FUNCTION workspace.owned_consume_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OWNED_CONSUMPTION_FAULT'; END $$; CREATE TRIGGER owned_consume_fault BEFORE INSERT ON workspace.agent_execution_consumptions FOR EACH ROW EXECUTE FUNCTION workspace.owned_consume_fault()");
  try{await expect(agent.execute(actor,f.project,f.input)).rejects.toThrow('OWNED_CONSUMPTION_FAULT');expect(Object.values(await counts(f.project))).toEqual([0,0,0,0,0]);}
  finally{await admin.exec('DROP TRIGGER owned_consume_fault ON workspace.agent_execution_consumptions; DROP FUNCTION workspace.owned_consume_fault()');}
  expect((await agent.execute(actor,f.project,f.input)).reused).toBe(false);expect((await counts(f.project)).agent_execution_consumptions).toBe(1);
});
it('L0 cannot execute; L2/L3 require explicit execute grants, and review-only records never upgrade',async()=>{
  const l0=await fixture('L0');await expect(agent.execute(actor,l0.project,l0.input)).rejects.toThrow('AGENT_L0_ADVISORY');
  for(const level of ['L2','L3'] as const){const f=await fixture(level);expect((await agent.execute(actor,f.project,f.input)).reused).toBe(false);expect((await counts(f.project)).runs).toBe(1);}
  const f=await fixture(),review=new LocalAgentReview(db,gateway()),old=(await review.createGrant(actor,f.project,{id:randomUUID(),level:'L1',bindingIds:[f.binding.id],ttlSeconds:600,maxActions:1,maxPixels:4096})).grant,proposal=(await review.propose(actor,f.project,old.id,{id:randomUUID(),bindingId:f.binding.id,parameters:{width:64,height:64}})).proposal;
  await review.approve(actor,f.project,proposal.id,{hash:proposal.approvalHash,nonce:f.nonce});await expect(agent.execute(actor,f.project,{id:randomUUID(),proposalId:proposal.id,hash:proposal.approvalHash,nonce:f.nonce})).rejects.toThrow('AGENT_MODE_MISMATCH');
  expect((await review.list(actor,f.project)).items.map(i=>i.grant.id)).toEqual([old.id]);expect((await agent.authority.list(actor,f.project)).items.map(i=>i.grant.id)).toEqual([f.grant.id]);expect((await counts(f.project)).runs).toBe(0);
});
it('revocation after claim and expiry before submission prevent any persisted submit request',async()=>{
  for(const reason of ['revoke','expire'] as const){const f=await fixture('L1',30);await approve(f);const run=await agent.execute(actor,f.project,f.input),now=new Date(),claim=await worker.claim(actor,f.project,run.id,randomUUID(),now);
    if(reason==='revoke')await agent.authority.revoke(actor,f.project,f.grant.id,'stop before POST');
    await expect(worker.beforeSubmit(claim.lease,{owned:true},reason==='expire'?new Date(now.getTime()+31000):now)).rejects.toThrow(reason==='expire'?'AGENT_GRANT_EXPIRED':'AGENT_GRANT_REVOKED');
    const attempt=(await db.asActor(actor,tx=>tx.query<{stage:string;request_payload:unknown}>('SELECT stage,request_payload FROM workspace.run_attempts WHERE project_id=$1 AND run_id=$2',[f.project,run.id]))).rows[0];expect(attempt).toMatchObject({stage:'claimed',request_payload:null});
  }
});
it('current input, capability and actor permissions are rechecked at claim and beforeSubmit',async()=>{
  const f=await fixture();await approve(f);const run=await agent.execute(actor,f.project,f.input);const changed=new LocalRunExecution(db,'b'.repeat(64),new WorkspaceModelGateway({compilerConfigured:true,localResizeExecutor:true}));await expect(changed.claim(actor,f.project,run.id,randomUUID())).rejects.toThrow('AGENT_CAPABILITY_CHANGED');
  const claim=await worker.claim(actor,f.project,run.id,randomUUID());await db.saveObject(actor,f.project,{...f.source,revision:2,x:20},2,f.lease);await expect(worker.beforeSubmit(claim.lease,{owned:true})).rejects.toThrow('AGENT_INPUT_CHANGED');
  const another=await fixture();await approve(another);const r=await agent.execute(actor,another.project,another.input),c=await worker.claim(actor,another.project,r.id,randomUUID()),admin=(db as unknown as {db:{query:(sql:string,args:unknown[])=>Promise<unknown>}}).db;
  await admin.query("UPDATE workspace.project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[another.project,actor]);await expect(worker.beforeSubmit(c.lease,{owned:true})).rejects.toThrow('EXECUTION_LEASE_INVALID');await expect(agent.execute(actor,another.project,another.input)).rejects.toThrow('ACCESS_DENIED');expect(await agent.authority.revoke(actor,another.project,another.grant.id,'viewer withdraw')).toMatchObject({revoked:true});
});
it('real HTTP has an explicit execution namespace; approval, dedup and revocation cancel a queued run',async()=>{
  const username='execute_'+randomUUID().slice(0,8),password='owned-execution-http-long-password',user=await db.registerLocalUser(username,password),f=await fixture('L1',600,user.id);
  let origin='',cookie='';const server=createLocalWorkspaceHttp(db,{origin:()=>origin,compilerSourceSha256:'b'.repeat(64)});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('NO_ADDRESS');origin=`http://127.0.0.1:${address.port}`;
  const request=(path:string,method='GET',body?:unknown,from=origin)=>fetch(origin+path,{method,headers:{origin:from,cookie,'content-type':'application/json','x-workspace-local':'1'},body:body===undefined?undefined:JSON.stringify(body)});
  try{
    expect((await request('/v1/agent-execution-tools')).status).toBe(401);const login=await request('/v1/auth/login','POST',{username,password});expect(login.status).toBe(200);cookie=login.headers.get('set-cookie')!.split(';')[0];expect((await(await request('/v1/agent-execution-tools')).json()).data).toMatchObject({mode:'local_resize_execute',executionEnabled:true});
    const base=`/v1/projects/${f.project}`,proposalPath=base+`/agent-execution-proposals/${f.proposal.id}`,execute=base+'/agent-executions';
    expect((await request(execute,'POST',f.input,'https://outside.invalid')).status).toBe(403);
    expect((await request(execute,'POST',{...f.input,actorId:user.id})).status).toBe(422);
    expect((await request(execute,'POST',f.input)).status).toBe(409);
    expect((await request(proposalPath+'/approve','POST',{hash:f.proposal.approvalHash,nonce:f.nonce})).status).toBe(200);
    expect((await request(base+`/agent-review-proposals/${f.proposal.id}`)).status).toBe(409);
    const created=await request(execute,'POST',f.input);expect(created.status).toBe(201);const receipt=(await created.json()).data;
    expect((await(await request(execute,'POST',f.input)).json()).data).toMatchObject({id:receipt.id,reused:true});
    const revoked=await request(base+`/agent-execution-grants/${f.grant.id}/revoke`,'POST',{reason:'HTTP撤销'});expect(revoked.status).toBe(200);expect((await revoked.json()).data).toMatchObject({revoked:true,cancellationRequestedCount:1,cancellationUnavailableCount:0});
    expect((await(await request(base+`/runs/${receipt.id}`)).json()).data).toMatchObject({state:'cancelled',attempt:null});
  }finally{server.emit('workspace-shutdown');await new Promise<void>(done=>server.close(()=>done()));}
});
it('revoking a durably submitted action requests cancellation without granting another submit',async()=>{
  const f=await fixture();await approve(f);const run=await agent.execute(actor,f.project,f.input),claim=await worker.claim(actor,f.project,run.id,randomUUID());await worker.beforeSubmit(claim.lease,{owned:true});
  expect(await agent.revoke(actor,f.project,f.grant.id,'already submitted')).toMatchObject({revoked:true,cancellationRequestedCount:1});
  expect(await worker.cancellationRequested(claim.lease)).toBe(true);
  await worker.recordSubmissionReceipt(claim.lease,'owned-already-submitted');
  await expect(worker.beforeSubmit(claim.lease,{owned:true})).rejects.toThrow('ALREADY_SUBMITTED');
  expect((await runs.read(actor,f.project,run.id)).state).toBe('cancel_requested');expect((await counts(f.project)).run_attempts).toBe(1);
});
it('execution UUID spelling is canonical and cannot create a second consumption',async()=>{
  const f=await fixture('L2'),grantId=randomUUID().toUpperCase(),proposalId=randomUUID().toUpperCase(),grant=(await agent.authority.createGrant(actor,f.project,{id:grantId,level:'L2',bindingIds:[f.binding.id.toUpperCase()],ttlSeconds:600,maxActions:1,maxPixels:4096})).grant;
  expect(grant.id).toBe(grantId.toLowerCase());const proposal=(await agent.authority.propose(actor,f.project,grantId,{id:proposalId,bindingId:f.binding.id.toUpperCase(),parameters:{width:64,height:64}})).proposal;
  expect(proposal.id).toBe(proposalId.toLowerCase());const id=randomUUID(),request={id:id.toUpperCase(),proposalId,hash:proposal.approvalHash,nonce:null},first=await agent.execute(actor,f.project,request);
  expect(first.consumptionId).toBe(id);expect(await agent.execute(actor,f.project,{...request,id,proposalId:proposal.id})).toMatchObject({id:first.id,reused:true});expect((await counts(f.project)).agent_execution_consumptions).toBe(1);
});
it('stale proposals create no run, and a snapshot pin without its consumption cannot start',async()=>{
  const f=await fixture();await approve(f);await db.saveObject(actor,f.project,{...f.source,revision:2,x:30},2,f.lease);await expect(agent.execute(actor,f.project,f.input)).rejects.toThrow('AGENT_INPUT_CHANGED');expect(Object.values(await counts(f.project))).toEqual([0,0,0,0,0]);
  const valid=await fixture('L2'),created=await agent.execute(actor,valid.project,valid.input),snapshot=(await runs.read(actor,valid.project,created.id)).snapshot as any,pin={...snapshot.agentExecution,consumptionId:randomUUID()};
  const forged=await db.asActor(actor,tx=>runs.createInTransaction(tx,actor,valid.project,valid.binding.id,{width:64,height:64},'owned-unconsumed-pin',pin));
  await expect(worker.claim(actor,valid.project,forged.id,randomUUID())).rejects.toThrow('AGENT_CONSUMPTION_INTEGRITY_FAILED');expect((await counts(valid.project)).run_attempts).toBe(0);
  const admin=(db as unknown as {db:{query:(sql:string,args:unknown[])=>Promise<unknown>}}).db;await expect(admin.query("UPDATE workspace.agent_execution_consumptions SET request_hash=$1 WHERE project_id=$2",['f'.repeat(64),valid.project])).rejects.toThrow('IMMUTABLE_HISTORY');
});
it('revoked queued work does not even start a runtime or read/upload private source bytes',async()=>{
  const f=await fixture();await approve(f);const run=await agent.execute(actor,f.project,f.input);await agent.authority.revoke(actor,f.project,f.grant.id,'before runtime startup');
  const forbidden=async()=>{throw Error('UNEXPECTED_RUNTIME_CALL');},runtime:OwnedResizeRuntime={start:vi.fn(async()=>{}),upload:vi.fn(forbidden),compile:vi.fn(forbidden),provenance:vi.fn(forbidden),submit:vi.fn(forbidden),result:vi.fn(forbidden),close:vi.fn(async()=>{})},download=vi.fn(forbidden);
  await expect(new LocalResizeWorker(worker,{download} as unknown as LocalWorkspaceAssets,runtime,{} as LocalRunArtifactStore).execute(actor,f.project,run.id)).rejects.toThrow('AGENT_GRANT_REVOKED');
  expect(runtime.start).not.toHaveBeenCalled();expect(download).not.toHaveBeenCalled();expect(runtime.upload).not.toHaveBeenCalled();expect(runtime.submit).not.toHaveBeenCalled();expect(runtime.close).toHaveBeenCalledOnce();expect((await counts(f.project)).run_attempts).toBe(0);
});
