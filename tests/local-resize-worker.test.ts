import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {LocalWorkspaceDatabase} from '../apps/api/src/localWorkspaceDatabase';
import {LocalWorkspaceAssets} from '../apps/api/src/localWorkspaceAssets';
import {LocalWorkflowVersions} from '../apps/api/src/localWorkflowVersions';
import {LocalBoundRuns} from '../apps/api/src/localBoundRuns';
import {LocalRunExecution} from '../apps/api/src/localRunExecution';
import {LocalResizeWorker,type OwnedResizeRuntime} from '../apps/worker/src/localResizeWorker';
import {LocalRunDispatcher} from '../apps/worker/src/localRunDispatcher';
import {setTimeout as delay} from 'node:timers/promises';
import {OwnedRuntimeCancellation} from '../apps/worker/src/runtimeCancellation';
import {LocalRunArtifactStore} from '../apps/api/src/localRunArtifactStore';
import {LocalArchiveRecovery} from '../apps/api/src/localArchiveRecovery';
let db:LocalWorkspaceDatabase,assets:LocalWorkspaceAssets,artifacts:LocalRunArtifactStore,artifactDirectory:string,runs:LocalBoundRuns,execution:LocalRunExecution,bindingId:string,sourceId:string,sourceBytes:Buffer,resultBytes:Buffer;
const actor=randomUUID(),viewer=randomUUID(),project=randomUUID(),pin='b'.repeat(64);
beforeAll(async()=>{
  db=await LocalWorkspaceDatabase.open(process.cwd());await db.seedProject(project,'owned mock-runtime worker',[{userId:actor,role:'owner'},{userId:viewer,role:'viewer'}]);
  assets=new LocalWorkspaceAssets(db,resolve('work','owned-worker-assets-'+randomUUID()));
  artifactDirectory=resolve('work','owned-worker-artifacts-'+randomUUID());artifacts=new LocalRunArtifactStore(artifactDirectory);
  const sharp=createRequire(new URL('../apps/api/package.json',import.meta.url))('sharp');
  sourceBytes=await sharp({create:{width:16,height:12,channels:3,background:{r:51,g:102,b:204}}}).png().toBuffer();
  resultBytes=await sharp(sourceBytes).resize(256,256).png().toBuffer();
  const source=await assets.upload(actor,project,sourceBytes,'image/png','owned-source.png');sourceId=source.id;
  const repo=new LocalWorkflowVersions(db),template=await repo.ensureResizeTemplate(actor,project);
  const image={id:randomUUID(),projectId:project,revision:1,type:'image',assetVersionId:source.id,x:0,y:0,width:160,height:120};
  const tool={id:randomUUID(),projectId:project,revision:1,type:'tool',templateVersionId:template.id,x:200,y:0,width:100,height:100};
  const lease=await db.acquireLease(actor,project);await db.saveObject(actor,project,image,0,lease);await db.saveObject(actor,project,tool,1,lease);
  bindingId=randomUUID();await repo.bind(actor,project,{id:bindingId,projectId:project,taskLineId:randomUUID(),sourceObjectId:image.id,sourceObjectRevision:1,toolObjectId:tool.id,toolObjectRevision:1,templateVersionId:template.id});
  runs=new LocalBoundRuns(db,pin);execution=new LocalRunExecution(db,pin);
});
afterAll(async()=>{if(db)await db.close();});
function runtime():OwnedResizeRuntime{
  let compiled:unknown;
  return {start:vi.fn(async()=>{}),close:vi.fn(async()=>{}),upload:vi.fn(async(_bytes,_mime,name)=>name),
    compile:vi.fn(async(_parameters,name)=>{const graph=JSON.parse(readFileSync('docs/evidence/2026-11-09/owned-comfy/snapshot.json','utf8')).api_prompt;graph['1'].inputs.image=name;compiled=graph;return graph;}),
    provenance:vi.fn(async()=>({schemaVersion:1,adapterVersion:'local-owned-resize-v1',runtimeKind:'contract-fixture-not-real',runtimeRef:'owned-fixture-'+randomUUID(),compilerSourceSha256:pin,registrySha256:'c'.repeat(64),pythonExecutableSha256:'d'.repeat(64),bridgeSha256:'e'.repeat(64),versions:{python:null,pytorch:null,comfyui:null},coreFiles:['nodes.py','execution.py','server.py','comfy/utils.py','comfy/model_management.py'].map(path=>({path,sha256:'f'.repeat(64)}))})),
    submit:vi.fn(async()=>randomUUID()),result:vi.fn(async providerId=>({history:{prompt:[0,providerId,compiled],status:{status_str:'success',messages:[]},outputs:{'3':{images:[{filename:'owned.png',subfolder:'workflow_architect',type:'output'}]}}},bytes:resultBytes}))};
}
it('内部worker用mock runtime覆盖真实私有字节→受控提交→ready归档→卡片及下载，保持原件',async()=>{
  const r=runtime(),run=await runs.create(actor,project,bindingId,{width:256,height:256},'mock-runtime-success');
  await new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id);
  const saved=await runs.read(actor,project,run.id);expect(saved.state).toBe('succeeded');
  expect(r.submit).toHaveBeenCalledTimes(1);expect(r.close).toHaveBeenCalledTimes(1);
  expect((await assets.download(actor,project,sourceId)).bytes).toEqual(sourceBytes);
  const output=saved.output as {asset_version_id:string};expect((await assets.download(actor,project,output.asset_version_id)).bytes).toEqual(resultBytes);
});
it('提交回复丢失变unknown，不重试POST，后续领取也不能再次发送',async()=>{
  const r=runtime();r.submit=vi.fn(async()=>{throw Error('owned-lost-reply');});
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'mock-runtime-lost');
  await expect(new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id)).rejects.toThrow('owned-lost-reply');
  expect((await runs.read(actor,project,run.id)).state).toBe('unknown');expect(r.submit).toHaveBeenCalledTimes(1);expect(r.result).not.toHaveBeenCalled();
  await expect(new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id)).rejects.toThrow('RUN_NOT_QUEUED');expect(r.submit).toHaveBeenCalledTimes(1);
});
it('编译图夹带额外节点在提交前拒绝，标failed且关闭runtime',async()=>{
  const r=runtime(),compile=r.compile;r.compile=vi.fn(async(...args)=>{const graph=await compile(...args) as Record<string,unknown>;graph['4']={class_type:'PaidNode'};return graph;});
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'mock-runtime-injection');
  await expect(new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id)).rejects.toThrow('RESIZE_PROMPT_REJECTED');
  expect((await runs.read(actor,project,run.id)).state).toBe('failed');expect(r.submit).not.toHaveBeenCalled();expect(r.close).toHaveBeenCalledTimes(1);
});
it('自有runtime启动失败写failed，不能伪装成已提交或无限留在queued',async()=>{
  const r=runtime();r.start=vi.fn(async()=>{throw Error('owned-start-failed');});
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'mock-runtime-start-failed');
  await expect(new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id)).rejects.toThrow('owned-start-failed');
  expect((await runs.read(actor,project,run.id)).state).toBe('failed');expect(r.submit).not.toHaveBeenCalled();
});
it('dispatcher启动消费持久outbox，领取同事务标记dispatched；重启不重投完成任务',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'mock-dispatch-pending');
  const factory=vi.fn(()=>new LocalResizeWorker(execution,assets,runtime(),artifacts)),errors=vi.fn();
  const dispatcher=new LocalRunDispatcher(db,factory,errors);dispatcher.start();
  try{const deadline=Date.now()+1500;while((await runs.read(actor,project,run.id)).state!=='succeeded'&&Date.now()<deadline)await delay(5);}
  finally{await dispatcher.close();}
  expect((await runs.read(actor,project,run.id)).state).toBe('succeeded');expect(factory).toHaveBeenCalledTimes(1);expect(errors).not.toHaveBeenCalled();
  const row=(await db.asActor(actor,tx=>tx.query<{dispatched_at:Date}>('SELECT dispatched_at FROM workspace.outbox WHERE project_id=$1 AND run_id=$2',[project,run.id]))).rows[0];expect(row.dispatched_at).not.toBeNull();
  const restarted=new LocalRunDispatcher(db,factory,errors);restarted.start();await delay(10);await restarted.close();expect(factory).toHaveBeenCalledTimes(1);
});
it('dispatcher恢复过期attempt：未提交failed、已提交unknown，不启动runtime或重发请求',async()=>{
  const past=new Date(Date.now()-61_000),ids:string[]=[];
  for(const submitted of [false,true]){
    const run=await runs.create(actor,project,bindingId,{width:256,height:256},'mock-recover-'+submitted);ids.push(run.id);
    const claim=await execution.claim(actor,project,run.id,randomUUID(),past);if(submitted)await execution.beforeSubmit(claim.lease,{owned:true},past);
  }
  const factory=vi.fn(()=>new LocalResizeWorker(execution,assets,runtime(),artifacts)),errors=vi.fn();
  const dispatcher=new LocalRunDispatcher(db,factory,errors,(a,p,r)=>execution.recoverExpired(a,p,r));dispatcher.start();
  try{const deadline=Date.now()+1500;while((await runs.read(actor,project,ids[1])).state==='running'&&Date.now()<deadline)await delay(5);}
  finally{await dispatcher.close();}
  expect((await runs.read(actor,project,ids[0])).state).toBe('failed');expect((await runs.read(actor,project,ids[1])).state).toBe('unknown');expect(factory).not.toHaveBeenCalled();expect(errors).not.toHaveBeenCalled();
});
it('排队取消幂等，只记一次原因/事件；viewer与跨项目请求不能取消',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'cancel-queued');
  await expect(runs.cancel(viewer,project,run.id,'forbidden')).rejects.toThrow('ACCESS_DENIED');
  await expect(runs.cancel(randomUUID(),project,run.id,'forbidden')).rejects.toThrow('NOT_FOUND');
  expect(await runs.cancel(actor,project,run.id,'原始取消原因')).toMatchObject({state:'cancelled',reused:false});
  expect(await runs.cancel(actor,project,run.id,'重复不得覆盖原因')).toMatchObject({state:'cancelled',reused:true});
  const saved=await runs.read(actor,project,run.id);expect(saved.cancellation).toMatchObject({reason:'原始取消原因'});
  expect((await db.pendingLocalRuns()).some(row=>row.run_id===run.id)).toBe(false);
  await expect(execution.claim(actor,project,run.id,randomUUID())).rejects.toThrow('RUN_NOT_QUEUED');
  expect((await db.asActor(actor,tx=>tx.query('SELECT * FROM workspace.run_events WHERE run_id=$1',[run.id]))).rows).toHaveLength(1);
  expect((await db.asActor(actor,tx=>tx.query('SELECT * FROM workspace.run_attempts WHERE run_id=$1',[run.id]))).rows).toHaveLength(0);
});
it('领取后提交前取消，worker结束为cancelled且从未POST',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'cancel-before-post'),r=runtime();
  r.upload=vi.fn(async(_bytes,_mime,name)=>{await runs.cancel(actor,project,run.id,'取消未提交任务');return name;});
  expect(await new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id)).toEqual({cancelled:true});
  expect((await runs.read(actor,project,run.id)).state).toBe('cancelled');expect(r.submit).not.toHaveBeenCalled();expect(r.close).toHaveBeenCalled();
});
async function interruptedHistory(runId:string,providerId:string){
  const row=(await db.asActor(actor,tx=>tx.query<{request_payload:{prompt:unknown}}>('SELECT request_payload FROM workspace.run_attempts WHERE project_id=$1 AND run_id=$2',[project,runId]))).rows[0];
  return {prompt:[0,providerId,row.request_payload.prompt],outputs:{},status:{status_str:'error',messages:[['execution_interrupted',{prompt_id:providerId}]]}};
}
it('匹配已存图和request ID、无产物且自有进程已停，才确认提交后取消',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'cancel-confirmed'),r=runtime();
  r.result=vi.fn(async(providerId,cancelRequested)=>{
    await runs.cancel(actor,project,run.id,'中断自有进程');expect(await cancelRequested!()).toBe(true);
    const history=await interruptedHistory(run.id,providerId);await r.close();
    throw new OwnedRuntimeCancellation({scope:'owned-cpu-resize-single-run',providerRequestId:providerId,ownedProcessStopped:true,history});
  });
  expect(await new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id)).toEqual({cancelled:true});
  const saved=await runs.read(actor,project,run.id);expect(saved.state).toBe('cancelled');expect(saved.output).toBeNull();expect(r.submit).toHaveBeenCalledTimes(1);
});
it('错误图、request ID、有产物或未停进程不能伪装取消成功，保留unknown',async()=>{
  for(const bad of ['graph','request-id','output','process','message']){
    const run=await runs.create(actor,project,bindingId,{width:256,height:256},'cancel-invalid-'+bad),r=runtime();
    r.result=vi.fn(async(providerId)=>{
      await runs.cancel(actor,project,run.id,'待核查');const history:any=await interruptedHistory(run.id,providerId);
      const receipt:any={scope:'owned-cpu-resize-single-run',providerRequestId:providerId,ownedProcessStopped:true,history};
      if(bad==='graph')history.prompt[2]={tampered:true};if(bad==='request-id')receipt.providerRequestId='other-request';
      if(bad==='output')history.outputs={'3':{images:[{filename:'possibly-produced.png'}]}};if(bad==='process')receipt.ownedProcessStopped=false;
      if(bad==='message')history.status.messages[0][1].prompt_id='other-request';throw new OwnedRuntimeCancellation(receipt);
    });
    await expect(new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id)).rejects.toThrow('CANCELLATION_NOT_CONFIRMED');
    expect((await runs.read(actor,project,run.id)).state).toBe('unknown');expect(r.submit).toHaveBeenCalledTimes(1);
  }
});
it('取消与完成竞争时保留已产生结果，不能把ready产物改成cancelled',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'cancel-output-wins'),r=runtime();
  r.result=vi.fn(async providerId=>{await runs.cancel(actor,project,run.id,'结果可能已产生');const history=await interruptedHistory(run.id,providerId);history.status={status_str:'success',messages:[]};history.outputs={'3':{images:[{filename:'owned.png',subfolder:'workflow_architect',type:'output'}]}};return {history,bytes:resultBytes};});
  await new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id);
  const saved=await runs.read(actor,project,run.id);expect(saved.state).toBe('succeeded');expect(saved.output).not.toBeNull();expect(saved.cancellation).not.toBeNull();
});
it('提交回复丢失且已请求取消仍是unknown，不得记为已取消或重发',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'cancel-lost-reply'),r=runtime();
  r.submit=vi.fn(async()=>{await runs.cancel(actor,project,run.id,'提交不明');throw Error('lost-submission-reply');});
  await expect(new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id)).rejects.toThrow('lost-submission-reply');
  expect((await runs.read(actor,project,run.id)).state).toBe('unknown');expect(r.submit).toHaveBeenCalledTimes(1);expect(r.result).not.toHaveBeenCalled();
});
it('已完成后取消不新建请求/事件，不改变ready结果',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'cancel-after-completed'),r=runtime();
  await new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id);const before=await runs.read(actor,project,run.id);
  expect(await runs.cancel(actor,project,run.id,'太晚的取消')).toMatchObject({state:'succeeded',requested:false});
  const after=await runs.read(actor,project,run.id);expect(after).toEqual(before);expect(after.cancellation).toBeNull();
});
it('领取与取消竞争不绕过提交边界，不生成第二条attempt',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'cancel-claim-race');
  const [claim]=await Promise.allSettled([execution.claim(actor,project,run.id,randomUUID()),runs.cancel(actor,project,run.id,'竞争取消')]);
  if(claim.status==='fulfilled'){
    await expect(execution.beforeSubmit(claim.value.lease,{owned:true})).rejects.toThrow('RUN_CANCEL_REQUESTED');await execution.stopAttempt(claim.value.lease);
  }
  expect((await runs.read(actor,project,run.id)).state).toBe('cancelled');
  expect((await db.asActor(actor,tx=>tx.query('SELECT * FROM workspace.run_attempts WHERE run_id=$1',[run.id]))).rows.length).toBeLessThanOrEqual(1);
});
it('取消请求过期恢复仍区分未提交和已提交，不凭取消意愿清除提交不明',async()=>{
  const past=new Date(Date.now()-61_000);
  for(const submitted of [false,true]){
    const run=await runs.create(actor,project,bindingId,{width:256,height:256},'cancel-expired-'+submitted),claim=await execution.claim(actor,project,run.id,randomUUID(),past);
    if(submitted)await execution.beforeSubmit(claim.lease,{owned:true},past);await runs.cancel(actor,project,run.id,'等待恢复');
    expect(await execution.recoverExpired(actor,project,run.id)).toMatchObject({state:submitted?'unknown':'cancelled'});
  }
});
it('确证取消的回执重入不重复事件，终态不能回到submitted',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'cancel-proof-idempotent'),claim=await execution.claim(actor,project,run.id,randomUUID());
  await execution.beforeSubmit(claim.lease,{prompt:{owned:'bound-graph'},client_id:'owned'});await execution.recordSubmissionReceipt(claim.lease,'owned-proof-request');await runs.cancel(actor,project,run.id,'确证取消');
  const receipt={scope:'owned-cpu-resize-single-run' as const,providerRequestId:'owned-proof-request',ownedProcessStopped:true as const,history:await interruptedHistory(run.id,'owned-proof-request')};
  await execution.confirmCancelled(claim.lease,receipt);await execution.confirmCancelled(claim.lease,receipt);
  const events=(await db.asActor(actor,tx=>tx.query<{stage:string}>('SELECT stage FROM workspace.run_events WHERE run_id=$1',[run.id]))).rows;
  expect(events.filter(event=>event.stage==='cancelled')).toHaveLength(1);
  await expect(db.asActor(actor,tx=>tx.query("UPDATE workspace.run_attempts SET stage='submitted' WHERE run_id=$1",[run.id]))).rejects.toThrow('ATTEMPT_TRANSITION_INVALID');
  expect(await execution.recoverExpired(actor,project,run.id,new Date(Date.now()+61_000))).toEqual({changed:false});
});
it('编译来源与确切出站请求绑定且不可改写，异参提交仍处于claimed',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'prepared-bound-request'),claim=await execution.claim(actor,project,run.id,randomUUID()),r=runtime();
  const request={prompt:await r.compile({width:256,height:256},'owned.png'),client_id:'owned'},evidence=await r.provenance();
  const prepared=await execution.recordPreparation(claim.lease,request,evidence);expect(await execution.recordPreparation(claim.lease,request,evidence)).toEqual(prepared);
  await expect(execution.recordPreparation(claim.lease,{...request,client_id:'changed'},evidence)).rejects.toThrow('PREPARATION_IMMUTABLE_CONFLICT');
  await expect(execution.beforeSubmit(claim.lease,{...request,client_id:'changed'})).rejects.toThrow('PREPARATION_INTEGRITY_FAILED');
  await expect(db.asActor(actor,tx=>tx.query("UPDATE workspace.run_preparations SET payload='{}' WHERE run_id=$1",[run.id]))).rejects.toThrow();
  await execution.stopAttempt(claim.lease);expect(r.submit).not.toHaveBeenCalled();
});
it('资产转存失败仍保留已验证缓存与数据库证据，不能通过再执行来重发prompt',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'verified-artifact-before-archive'),r=runtime();
  const upload=vi.spyOn(assets,'upload').mockRejectedValueOnce(Error('owned-storage-down'));
  try{await expect(new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id)).rejects.toThrow('owned-storage-down');}finally{upload.mockRestore();}
  expect((await runs.read(actor,project,run.id)).state).toBe('unknown');
  const record=(await db.asActor(actor,tx=>tx.query<{attempt_id:string;manifest_hash:string}>('SELECT attempt_id,manifest_hash FROM workspace.run_artifacts WHERE project_id=$1 AND run_id=$2',[project,run.id]))).rows[0];expect(record).toBeTruthy();
  const cached=await new LocalRunArtifactStore(artifactDirectory).load({projectId:project,runId:run.id,attemptId:record.attempt_id},record.manifest_hash);expect(cached.bytes).toEqual(resultBytes);
  expect((await db.asActor(actor,tx=>tx.query('SELECT run_id FROM workspace.run_outputs WHERE run_id=$1',[run.id]))).rows).toHaveLength(0);
  await expect(new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id)).rejects.toThrow('RUN_NOT_QUEUED');expect(r.submit).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(cached.manifest)).not.toContain('token_hash');
  const recovery=new LocalArchiveRecovery(new LocalRunExecution(db,'a'.repeat(64)),new LocalRunArtifactStore(artifactDirectory),assets);
  await expect(recovery.recover(viewer,project,run.id)).rejects.toThrow('ACCESS_DENIED');
  await expect(recovery.recover(randomUUID(),project,run.id)).rejects.toThrow('NOT_FOUND');
  expect(await recovery.recover(actor,project,run.id)).toMatchObject({state:'succeeded',reused:false});
  expect(await recovery.recover(actor,project,run.id)).toMatchObject({state:'succeeded',reused:true});
  const recovered=await runs.read(actor,project,run.id);expect(recovered.state).toBe('succeeded');
  expect((await assets.download(actor,project,(recovered.output as {asset_version_id:string}).asset_version_id)).bytes).toEqual(resultBytes);
  expect(r.submit).toHaveBeenCalledTimes(1);
  expect((await db.asActor(actor,tx=>tx.query('SELECT id FROM workspace.run_attempts WHERE run_id=$1',[run.id]))).rows).toHaveLength(1);
  expect((await db.asActor(actor,tx=>tx.query('SELECT run_id FROM workspace.run_outputs WHERE run_id=$1',[run.id]))).rows).toHaveLength(1);
});
it('归档独立租约排斥重复领取、错误令牌和过期完成，失败后可重新恢复且不能解除旧执行围栏',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'archive-fresh-lease'),r=runtime();
  const upload=vi.spyOn(assets,'upload').mockRejectedValueOnce(Error('archive-storage-down'));
  try{await expect(new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id)).rejects.toThrow('archive-storage-down');}finally{upload.mockRestore();}
  const claim=await execution.claimArchive(actor,project,run.id,randomUUID());if(claim.alreadyDone)throw Error('unexpected-done');
  await expect(execution.claimArchive(actor,project,run.id,randomUUID())).rejects.toThrow('ARCHIVE_BUSY');
  expect(await execution.recoverExpired(actor,project,run.id)).toEqual({changed:false});
  const asset=await assets.upload(actor,project,resultBytes,'image/png','recovered.png');
  const receipt={assetId:asset.id,sha256:asset.sha256,providerRequestId:claim.artifact.manifest.providerRequestId};
  await expect(execution.completeArchive({...claim.lease,token:'incorrect'},receipt)).rejects.toThrow('ARCHIVE_LEASE_INVALID');
  await expect(execution.completeArchive(claim.lease,receipt,new Date(Date.now()+61_000))).rejects.toThrow('ARCHIVE_LEASE_INVALID');
  await expect(db.asActor(actor,tx=>tx.query('UPDATE workspace.run_attempts SET execution_fenced=false WHERE run_id=$1',[run.id]))).rejects.toThrow('ATTEMPT_FENCE_IMMUTABLE');
  await execution.failArchive(claim.lease);
  await expect(db.asActor(actor,tx=>tx.query("UPDATE workspace.run_attempts SET stage='completed' WHERE run_id=$1",[run.id]))).rejects.toThrow('ATTEMPT_TRANSITION_INVALID');
  await expect(new LocalArchiveRecovery(execution,artifacts,assets).recover(actor,project,run.id)).resolves.toMatchObject({state:'succeeded',reused:false});
  expect(r.submit).toHaveBeenCalledTimes(1);
});
it('提交回复丢失没有持久产物证据，归档恢复不能猜测生成结果',async()=>{
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'archive-no-artifact'),r=runtime();r.submit=vi.fn(async()=>{throw Error('unknown-reply');});
  await expect(new LocalResizeWorker(execution,assets,r,artifacts).execute(actor,project,run.id)).rejects.toThrow('unknown-reply');
  await expect(new LocalArchiveRecovery(execution,artifacts,assets).recover(actor,project,run.id)).rejects.toThrow('NO_VERIFIED_ARTIFACT');
  expect((await runs.read(actor,project,run.id)).state).toBe('unknown');expect(r.submit).toHaveBeenCalledTimes(1);
});
