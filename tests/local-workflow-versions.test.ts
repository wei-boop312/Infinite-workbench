import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { LocalWorkspaceDatabase } from '../apps/api/src/localWorkspaceDatabase.ts';
import { LocalWorkflowVersions } from '../apps/api/src/localWorkflowVersions.ts';
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
