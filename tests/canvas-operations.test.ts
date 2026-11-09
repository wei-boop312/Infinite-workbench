import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {LocalWorkspaceDatabase} from '../apps/api/src/localWorkspaceDatabase';
import {BoundedEditHistory} from '../apps/web/workspace-editor.js';
import {contentHash} from '../apps/api/src/workspacePrototype';
let db:LocalWorkspaceDatabase;const owner=randomUUID(),viewer=randomUUID(),project=randomUUID();
beforeAll(async()=>{db=await LocalWorkspaceDatabase.open(process.cwd());await db.seedProject(project,'owned canvas operations',[{userId:owner,role:'owner'},{userId:viewer,role:'viewer'}]);});
afterAll(async()=>{await db?.close();});
const object=()=>({id:randomUUID(),projectId:project,revision:1,type:'text' as const,text:'原事实',x:0,y:0,width:260,height:180});
it('批量原子保存、同ID响应丢失重试不追加修订；异参及viewer拒绝',async()=>{
  const lease=await db.acquireLease(owner,project),a=object(),b=object(),input={id:randomUUID(),baseRevision:0,objects:[a,b]};
  expect(await db.saveCanvasOperation(owner,project,input,lease)).toMatchObject({revision:2,reused:false});
  expect(await db.saveCanvasOperation(owner,project,input,{token:'expired-response-recovery',fencing:0})).toMatchObject({revision:2,reused:true});
  await expect(db.saveCanvasOperation(owner,project,{...input,objects:[{...a,text:'changed'},b]},lease)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  await expect(db.saveCanvasOperation(viewer,project,input,lease)).rejects.toThrow('ACCESS_DENIED');
  expect((await db.asActor(owner,tx=>tx.query('SELECT * FROM workspace.object_revisions'))).rows).toHaveLength(2);
  await expect(db.asActor(owner,tx=>tx.query("UPDATE workspace.canvas_operations SET request_hash=$1 WHERE project_id=$2",['f'.repeat(64),project]))).rejects.toThrow();
});
it('第二对象冲突回滚整个批次；软删与恢复追加修订且不改历史',async()=>{
  const lease=await db.acquireLease(owner,project,true),a=object(),b=object();
  await expect(db.saveCanvasOperation(owner,project,{id:randomUUID(),baseRevision:2,objects:[a,{...b,revision:2}]},lease)).rejects.toThrow('OBJECT_REVISION_CONFLICT');
  expect((await db.asActor(owner,tx=>tx.query('SELECT id FROM workspace.objects WHERE id=$1',[a.id]))).rows).toEqual([]);
  await db.saveCanvasOperation(owner,project,{id:randomUUID(),baseRevision:2,objects:[a]},lease);
  await db.saveCanvasOperation(owner,project,{id:randomUUID(),baseRevision:3,objects:[{...a,revision:2,deleted:true}]},lease);
  await db.saveCanvasOperation(owner,project,{id:randomUUID(),baseRevision:4,objects:[{...a,revision:3,text:'恢复事实'}]},lease);
  expect((await db.asActor(owner,tx=>tx.query<{payload:unknown}>('SELECT payload FROM workspace.object_revisions WHERE object_id=$1 ORDER BY revision',[a.id]))).rows.map(r=>r.payload)).toEqual([a,{...a,revision:2,deleted:true},{...a,revision:3,text:'恢复事实'}]);
});
it('旧基准仅跨后台结果追加可重基；用户编辑仍冲突，失效租约不能产生新操作',async()=>{
  const lease=await db.acquireLease(owner,project,true),a=object();
  const output=object();
  await db.asActor(owner,async tx=>{await tx.query('INSERT INTO workspace.objects VALUES($1,$2,1)',[project,output.id]);await tx.query('INSERT INTO workspace.object_revisions VALUES($1,$2,1,NULL,$3,$4)',[project,output.id,JSON.stringify(output),contentHash(output)]);await tx.query('UPDATE workspace.canvases SET revision=revision+1 WHERE project_id=$1',[project]);await tx.query("INSERT INTO workspace.canvas_changes(project_id,revision,kind,object_id,object_revision,actor_id) VALUES($1,6,'run_output',$2,1,$3)",[project,output.id,owner]);});
  expect(await db.saveCanvasOperation(owner,project,{id:randomUUID(),baseRevision:5,objects:[a]},lease)).toMatchObject({revision:7});
  await expect(db.saveCanvasOperation(owner,project,{id:randomUUID(),baseRevision:6,objects:[{...a,revision:2}]},lease)).rejects.toThrow('REVISION_CONFLICT');
  await expect(db.saveCanvasOperation(owner,project,{id:randomUUID(),baseRevision:7,objects:[{...a,revision:2}]},{...lease,token:'incorrect'})).rejects.toThrow('LEASE_CONFLICT');
});
it('命令历史精确保留20步，只提供用户对象逆操作，创建撤销为软删、分支清空redo',()=>{
  const history=new BoundedEditHistory(),a=object();history.record([{before:null,after:a}]);expect(history.values('undo')).toEqual([{...a,revision:undefined,deleted:true}].map(({revision,...v})=>v));
  history.accept('undo');expect(history.values('redo')[0]).toMatchObject({id:a.id,text:'原事实'});history.accept('redo');
  for(let n=0;n<25;n++)history.record([{before:{...a,text:String(n)},after:{...a,text:String(n+1)}}]);
  expect(history.past).toHaveLength(20);for(let n=0;n<20;n++)history.accept('undo');expect(history.peek('undo')).toBeNull();expect(history.future).toHaveLength(20);
  history.record([{before:a,after:{...a,x:90}}]);expect(history.future).toEqual([]);expect(history.values('undo').map(v=>v.id)).toEqual([a.id]);
});
