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
let db:LocalWorkspaceDatabase,assets:LocalWorkspaceAssets,runs:LocalBoundRuns,execution:LocalRunExecution,bindingId:string,sourceId:string,sourceBytes:Buffer,resultBytes:Buffer;
const actor=randomUUID(),project=randomUUID(),pin='b'.repeat(64);
beforeAll(async()=>{
  db=await LocalWorkspaceDatabase.open(process.cwd());await db.seedProject(project,'owned mock-runtime worker',[{userId:actor,role:'owner'}]);
  assets=new LocalWorkspaceAssets(db,resolve('work','owned-worker-assets-'+randomUUID()));
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
  return {start:vi.fn(async()=>{}),close:vi.fn(async()=>{}),upload:vi.fn(async(_bytes,_mime,name)=>name),
    compile:vi.fn(async(_parameters,name)=>{const graph=JSON.parse(readFileSync('docs/evidence/2026-11-09/owned-comfy/snapshot.json','utf8')).api_prompt;graph['1'].inputs.image=name;return graph;}),
    submit:vi.fn(async()=>randomUUID()),result:vi.fn(async()=>({history:{status:'mock-only-success'},bytes:resultBytes}))};
}
it('内部worker用mock runtime覆盖真实私有字节→受控提交→ready归档→卡片及下载，保持原件',async()=>{
  const r=runtime(),run=await runs.create(actor,project,bindingId,{width:256,height:256},'mock-runtime-success');
  await new LocalResizeWorker(execution,assets,r).execute(actor,project,run.id);
  const saved=await runs.read(actor,project,run.id);expect(saved.state).toBe('succeeded');
  expect(r.submit).toHaveBeenCalledTimes(1);expect(r.close).toHaveBeenCalledTimes(1);
  expect((await assets.download(actor,project,sourceId)).bytes).toEqual(sourceBytes);
  const output=saved.output as {asset_version_id:string};expect((await assets.download(actor,project,output.asset_version_id)).bytes).toEqual(resultBytes);
});
it('提交回复丢失变unknown，不重试POST，后续领取也不能再次发送',async()=>{
  const r=runtime();r.submit=vi.fn(async()=>{throw Error('owned-lost-reply');});
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'mock-runtime-lost');
  await expect(new LocalResizeWorker(execution,assets,r).execute(actor,project,run.id)).rejects.toThrow('owned-lost-reply');
  expect((await runs.read(actor,project,run.id)).state).toBe('unknown');expect(r.submit).toHaveBeenCalledTimes(1);expect(r.result).not.toHaveBeenCalled();
  await expect(new LocalResizeWorker(execution,assets,r).execute(actor,project,run.id)).rejects.toThrow('RUN_NOT_QUEUED');expect(r.submit).toHaveBeenCalledTimes(1);
});
it('编译图夹带额外节点在提交前拒绝，标failed且关闭runtime',async()=>{
  const r=runtime(),compile=r.compile;r.compile=vi.fn(async(...args)=>{const graph=await compile(...args) as Record<string,unknown>;graph['4']={class_type:'PaidNode'};return graph;});
  const run=await runs.create(actor,project,bindingId,{width:256,height:256},'mock-runtime-injection');
  await expect(new LocalResizeWorker(execution,assets,r).execute(actor,project,run.id)).rejects.toThrow('RESIZE_PROMPT_REJECTED');
  expect((await runs.read(actor,project,run.id)).state).toBe('failed');expect(r.submit).not.toHaveBeenCalled();expect(r.close).toHaveBeenCalledTimes(1);
});
