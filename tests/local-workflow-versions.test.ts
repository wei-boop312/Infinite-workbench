import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { LocalWorkspaceDatabase } from '../apps/api/src/localWorkspaceDatabase.ts';
import { LocalWorkflowVersions } from '../apps/api/src/localWorkflowVersions.ts';
import { LocalBoundRuns } from '../apps/api/src/localBoundRuns.ts';
import { LocalRunExecution } from '../apps/api/src/localRunExecution.ts';
import { LocalWorkspaceAssets } from '../apps/api/src/localWorkspaceAssets.ts';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
let db:LocalWorkspaceDatabase,repo:LocalWorkflowVersions;
const actor=randomUUID(),project=randomUUID(),other=randomUUID();
const graph={id:randomUUID(),workflowId:randomUUID(),projectId:project,version:1,nodes:[
  {id:'source',type:'input.asset',config:{}},{id:'resize',type:'comfy.execute',config:{templateId:'core_image_resize_v2'}},{id:'output',type:'output.asset',config:{}}
],edges:[{source:'source',sourcePort:'asset',target:'resize',targetPort:'asset'},{source:'resize',sourcePort:'asset',target:'output',targetPort:'asset'}]};
beforeAll(async()=>{db=await LocalWorkspaceDatabase.open(process.cwd());repo=new LocalWorkflowVersions(db);await db.seedProject(project,'版本测试',[{userId:actor,role:'owner'}]);});
afterAll(async()=>{if(db)await db.close();});
it('实际SQL保存固定版本，新版不覆盖旧图，数据库拒绝历史修改',async()=>{
  await repo.publishWorkflow(actor,project,graph);
  await repo.publishWorkflow(actor,project,{...graph,id:randomUUID(),version:2});
  expect(await repo.readWorkflow(actor,project,graph.id)).toEqual(graph);
  await expect(repo.publishWorkflow(actor,project,graph)).rejects.toThrow();
  await expect(db.asActor(actor,tx=>tx.query("UPDATE workspace.workflow_versions SET payload='{}' WHERE project_id=$1",[project]))).rejects.toThrow('IMMUTABLE_HISTORY');
});
it('模板固定图版本，越权读取及跨项目引用失败',async()=>{
  const template={id:randomUUID(),templateId:randomUUID(),projectId:project,workflowVersionId:graph.id,version:1,operation:'image.resize',parameters:'resize-parameters-v1'};
  await repo.publishTemplate(actor,project,template);
  await expect(repo.publishTemplate(actor,project,{...template,id:randomUUID(),version:2,workflowVersionId:randomUUID()})).rejects.toThrow('NOT_FOUND');
  await expect(repo.readWorkflow(other,project,graph.id)).rejects.toThrow('NOT_FOUND');
  await expect(repo.publishWorkflow(actor,other,graph)).rejects.toThrow('NOT_FOUND');
});
it('绑定固定源修订与资产hash；双向查看一致，源修改只提示变化',async()=>{
  const template={id:randomUUID(),templateId:randomUUID(),projectId:project,workflowVersionId:graph.id,version:1,operation:'image.resize',parameters:'resize-parameters-v1'};
  await repo.publishTemplate(actor,project,template);
  const asset=randomUUID();
  await db.asActor(actor,tx=>tx.query("INSERT INTO workspace.asset_versions VALUES($1,$2,$3,'ready','owned-fixture')",[project,asset,'a'.repeat(64)]));
  const source={id:randomUUID(),projectId:project,revision:1,type:'image',assetVersionId:asset,x:0,y:0,width:100,height:100};
  const tool={id:randomUUID(),projectId:project,revision:1,type:'tool',templateVersionId:template.id,x:200,y:0,width:100,height:100};
  const lease=await db.acquireLease(actor,project);
  await db.saveObject(actor,project,source,0,lease);await db.saveObject(actor,project,tool,1,lease);
  const request={id:randomUUID(),projectId:project,taskLineId:randomUUID(),sourceObjectId:source.id,sourceObjectRevision:1,toolObjectId:tool.id,toolObjectRevision:1,templateVersionId:template.id};
  const bound=await repo.bind(actor,project,request);expect(bound.assetSha256).toBe('a'.repeat(64));
  expect((await repo.references(actor,project,source.id))[0].input_changed).toBe(false);
  expect((await repo.references(actor,project,tool.id))[0].payload.id).toBe(request.id);
  await db.saveObject(actor,project,{...source,revision:2,x:30},2,lease);
  const ref=(await repo.references(actor,project,source.id))[0];expect(ref.input_changed).toBe(true);
  expect((ref.payload.source as {revision:number}).revision).toBe(1);
  await expect(repo.bind(other,project,{...request,id:randomUUID()})).rejects.toThrow('NOT_FOUND');
  await expect(db.asActor(actor,tx=>tx.query("UPDATE workspace.bindings SET payload='{}' WHERE project_id=$1",[project]))).rejects.toThrow('IMMUTABLE_HISTORY');
});
it('从权威绑定冻结运行快照，幂等提交只写一次run/outbox且不读取latest',async()=>{
  const binding=(await db.asActor(actor,tx=>tx.query<{id:string}>('SELECT id FROM workspace.bindings WHERE project_id=$1',[project]))).rows[0];
  const runs=new LocalBoundRuns(db,'b'.repeat(64));
  const results=await Promise.all([1,2,3].map(()=>runs.create(actor,project,binding.id,{width:256,height:256},'owned-once')));
  expect(new Set(results.map(r=>r.id)).size).toBe(1);
  const result=await runs.read(actor,project,results[0].id);
  expect(result.state).toBe('queued');
  const snapshot=result.snapshot as {source:{revision:number;x:number};authorization:{actorId:string;providerCost:string}};
  expect(snapshot.source).toMatchObject({revision:1,x:0});
  expect(snapshot.authorization).toMatchObject({actorId:actor,providerCost:'0'});
  expect((await db.asActor(actor,tx=>tx.query('SELECT * FROM workspace.outbox WHERE project_id=$1',[project]))).rows).toHaveLength(1);
  await expect(runs.create(actor,project,binding.id,{width:512,height:256},'owned-once')).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  await expect(runs.create(other,project,binding.id,{width:256,height:256},'forbidden')).rejects.toThrow('NOT_FOUND');
  await expect(runs.read(other,project,result.id)).rejects.toThrow('NOT_FOUND');
  await expect(runs.create(actor,project,binding.id,{width:256,height:256,authorized:true},'forged')).rejects.toThrow();
  await expect(db.asActor(actor,tx=>tx.query("UPDATE workspace.run_snapshots SET payload='{}' WHERE project_id=$1",[project]))).rejects.toThrow('IMMUTABLE_HISTORY');
});
it('内置缩放模板重复安装只创建一个固定版本，不改变用户已有版本',async()=>{
  const installed=await Promise.all([repo.ensureResizeTemplate(actor,project),repo.ensureResizeTemplate(actor,project)]);
  expect(installed[0]).toEqual(installed[1]);
  expect(installed[0].operation).toBe('image.resize');
  expect(await repo.readWorkflow(actor,project,graph.id)).toEqual(graph);
  const count=(await db.asActor(actor,tx=>tx.query<{count:string}>('SELECT count(*)::text AS count FROM workspace.template_versions WHERE project_id=$1 AND template_id=$2',[project,installed[0].templateId]))).rows[0].count;
  expect(count).toBe('1');
});
it('执行领取只成功一次；提交前持久请求，旧令牌/重复提交被拒绝且事件可追踪',async()=>{
  const binding=(await db.asActor(actor,tx=>tx.query<{id:string}>('SELECT id FROM workspace.bindings WHERE project_id=$1',[project]))).rows[0];
  const runs=new LocalBoundRuns(db,'b'.repeat(64)),execution=new LocalRunExecution(db,'b'.repeat(64));
  const run=await runs.create(actor,project,binding.id,{width:256,height:256},'execution-once'),worker=randomUUID();
  const claims=await Promise.allSettled([execution.claim(actor,project,run.id,worker),execution.claim(actor,project,run.id,worker)]);
  expect(claims.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const claimed=claims.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof execution.claim>>>;
  const lease=claimed.value.lease;
  await expect(execution.beforeSubmit({...lease,token:'wrong'},{owned:true})).rejects.toThrow('EXECUTION_LEASE_INVALID');
  await execution.beforeSubmit(lease,{owned:true});
  await expect(execution.beforeSubmit(lease,{owned:true})).rejects.toThrow('ALREADY_SUBMITTED');
  await execution.recordResponse(lease,'owned-request-1',{output:'not-an-artifact-acceptance'});
  expect((await runs.read(actor,project,run.id)).state).toBe('archiving');
  const events=(await db.asActor(actor,tx=>tx.query<{sequence:number;stage:string}>('SELECT sequence,stage FROM workspace.run_events WHERE project_id=$1 AND run_id=$2 ORDER BY sequence',[project,run.id]))).rows;
  expect(events.map(e=>e.stage)).toEqual(['claimed','submitted','returned']);
  await expect(db.asActor(actor,tx=>tx.query("UPDATE workspace.run_attempts SET request_payload='{}' WHERE project_id=$1 AND run_id=$2",[project,run.id]))).rejects.toThrow('ATTEMPT_REQUEST_IMMUTABLE');
});
it('领取后过期且未提交标失败；已提交后过期标unknown，均不自动重投',async()=>{
  const binding=(await db.asActor(actor,tx=>tx.query<{id:string}>('SELECT id FROM workspace.bindings WHERE project_id=$1',[project]))).rows[0];
  const runs=new LocalBoundRuns(db,'b'.repeat(64)),execution=new LocalRunExecution(db,'b'.repeat(64)),now=new Date(),later=new Date(now.getTime()+61_000);
  const first=await runs.create(actor,project,binding.id,{width:256,height:256},'expire-before');
  const a=await execution.claim(actor,project,first.id,randomUUID(),now);
  await expect(execution.beforeSubmit(a.lease,{},later)).rejects.toThrow('EXECUTION_LEASE_INVALID');
  expect(await execution.recoverExpired(actor,project,first.id,later)).toMatchObject({changed:true,state:'failed'});
  const second=await runs.create(actor,project,binding.id,{width:256,height:256},'expire-after');
  const b=await execution.claim(actor,project,second.id,randomUUID(),now);await execution.beforeSubmit(b.lease,{owned:true},now);
  expect(await execution.recoverExpired(actor,project,second.id,later)).toMatchObject({changed:true,state:'unknown'});
  expect(await execution.recoverExpired(actor,project,second.id,later)).toEqual({changed:false});
  await expect(execution.claim(actor,project,second.id,randomUUID(),later)).rejects.toThrow('RUN_NOT_QUEUED');
  await expect(new LocalRunExecution(db,'c'.repeat(64)).claim(actor,project,(await runs.create(actor,project,binding.id,{width:256,height:256},'wrong-manifest')).id,randomUUID())).rejects.toThrow('SNAPSHOT_INTEGRITY_FAILED');
});
it('领取之后撤销编辑角色，原有效令牌也不能开始提交',async()=>{
  const binding=(await db.asActor(actor,tx=>tx.query<{id:string}>('SELECT id FROM workspace.bindings WHERE project_id=$1',[project]))).rows[0];
  const runs=new LocalBoundRuns(db,'b'.repeat(64)),execution=new LocalRunExecution(db,'b'.repeat(64));
  const run=await runs.create(actor,project,binding.id,{width:256,height:256},'revoked-after-claim');
  const claim=await execution.claim(actor,project,run.id,randomUUID());
  // Fault injection into this owned in-memory database, not a product admin API.
  const admin=(db as unknown as {db:{query:(sql:string,params:unknown[])=>Promise<unknown>}}).db;
  try{
    await admin.query("UPDATE workspace.project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,actor]);
    await expect(execution.beforeSubmit(claim.lease,{owned:true})).rejects.toThrow();
    const attempt=(await db.asActor(actor,tx=>tx.query<{stage:string}>('SELECT stage FROM workspace.run_attempts WHERE project_id=$1 AND run_id=$2',[project,run.id]))).rows[0];
    expect(attempt.stage).toBe('claimed');
  }finally{await admin.query("UPDATE workspace.project_members SET role='owner' WHERE project_id=$1 AND user_id=$2",[project,actor]);}
});
it('ready原字节资产先归档，结果对象/事件/成功同事务；重入不重复卡片',async()=>{
  const binding=(await db.asActor(actor,tx=>tx.query<{id:string}>('SELECT id FROM workspace.bindings WHERE project_id=$1',[project]))).rows[0];
  const runs=new LocalBoundRuns(db,'b'.repeat(64)),execution=new LocalRunExecution(db,'b'.repeat(64));
  const run=await runs.create(actor,project,binding.id,{width:256,height:256},'archive-owned-result');
  const claimed=await execution.claim(actor,project,run.id,randomUUID());
  await execution.beforeSubmit(claimed.lease,{owned:true});await execution.recordResponse(claimed.lease,'owned-archive',{status:'success'});
  const assets=new LocalWorkspaceAssets(db,resolve('work','owned-run-assets-'+randomUUID()));
  const sharp=createRequire(new URL('../apps/api/package.json',import.meta.url))('sharp');
  const bytes=await sharp({create:{width:256,height:256,channels:3,background:{r:51,g:102,b:204}}}).png().toBuffer();
  const asset=await assets.upload(actor,project,bytes,'image/png','owned-result.png');
  const receipt={assetId:asset.id,sha256:asset.sha256,providerRequestId:'owned-archive'};
  await expect(execution.complete(claimed.lease,{...receipt,sha256:'f'.repeat(64)})).rejects.toThrow('OUTPUT_ASSET_NOT_READY');
  expect((await runs.read(actor,project,run.id)).state).toBe('archiving');
  const output=await execution.complete(claimed.lease,receipt);
  expect(await execution.complete(claimed.lease,receipt)).toEqual(output);
  expect((await runs.read(actor,project,run.id))).toMatchObject({state:'succeeded',output:{asset_version_id:asset.id,sha256:asset.sha256}});
  expect((await assets.download(actor,project,asset.id)).bytes).toEqual(bytes);
  const rows=(await db.asActor(actor,tx=>tx.query<{count:string}>('SELECT count(*)::text AS count FROM workspace.object_revisions WHERE project_id=$1 AND asset_version_id=$2',[project,asset.id]))).rows;
  expect(rows[0].count).toBe('1');
  expect((await db.asActor(actor,tx=>tx.query<{stage:string}>('SELECT stage FROM workspace.run_events WHERE project_id=$1 AND run_id=$2 ORDER BY sequence',[project,run.id]))).rows.map(r=>r.stage)).toEqual(['claimed','submitted','returned','completed']);
});
