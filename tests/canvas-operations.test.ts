import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {LocalWorkspaceDatabase} from '../apps/api/src/localWorkspaceDatabase';
import {BoundedEditHistory,expandedSelection,boxSelection,translatedSelection,copiedSelection,sameEdit} from '../apps/web/workspace-editor.js';
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
it('锁定规则覆盖两条保存入口，解锁必须独立修订；混合批次失败整体回滚',async()=>{
  const p=randomUUID();await db.seedProject(p,'owned locked geometry',[{userId:owner,role:'owner'}]);const lease=await db.acquireLease(owner,p);
  const a={...object(),projectId:p,locked:true},b={...object(),projectId:p};
  await db.saveCanvasOperation(owner,p,{id:randomUUID(),baseRevision:0,objects:[a,b]},lease);
  for(const change of [{x:80},{width:900},{deleted:true},{groupId:randomUUID()},{locked:false,x:90}]){
    await expect(db.saveCanvasOperation(owner,p,{id:randomUUID(),baseRevision:2,objects:[{...b,revision:2,x:50},{...a,revision:2,...change}]},lease)).rejects.toThrow('OBJECT_LOCKED');
  }
  await expect(db.saveObject(owner,p,{...a,revision:2,x:90},2,lease)).rejects.toThrow('OBJECT_LOCKED');
  const {text:omittedText,...imageBase}=b;await expect(db.saveObject(owner,p,{...imageBase,revision:2,type:'image',assetVersionId:randomUUID()},2,lease)).rejects.toThrow('OBJECT_IDENTITY_CONFLICT');
  expect((await db.asActor(owner,tx=>tx.query<{current_revision:number}>('SELECT current_revision FROM workspace.objects WHERE project_id=$1 ORDER BY id',[p]))).rows.map(row=>row.current_revision)).toEqual([1,1]);
  await db.saveCanvasOperation(owner,p,{id:randomUUID(),baseRevision:2,objects:[{...a,revision:2,locked:false}]},lease);
  const groupId=randomUUID();await db.saveCanvasOperation(owner,p,{id:randomUUID(),baseRevision:3,objects:[{...a,revision:3,locked:false,groupId,x:60},{...b,revision:2,groupId,x:320}]},lease);
  expect((await db.asActor(owner,tx=>tx.query<{payload:{groupId:string;x:number}}>('SELECT r.payload FROM workspace.objects o JOIN workspace.object_revisions r ON r.project_id=o.project_id AND r.object_id=o.id AND r.revision=o.current_revision WHERE o.project_id=$1',[p]))).rows.map(row=>row.payload.groupId)).toEqual([groupId,groupId]);
});
it('平面组合选择展开、反向框选、整体移动和复制保留成员身份关系但派生新ID',()=>{
  const groupId=randomUUID(),a={...object(),groupId},b={...object(),groupId,x:300},c={...object(),x:700},all=[a,b,c];
  const selection=expandedSelection(all,[a.id]);expect([...selection]).toEqual([a.id,b.id]);expect([...boxSelection(all,{x:20,y:20,width:-20,height:-20})]).toEqual([a.id,b.id]);
  expect(translatedSelection(all,selection,40,50).map(o=>({id:o.id,x:o.x,y:o.y}))).toEqual([{id:a.id,x:40,y:50},{id:b.id,x:340,y:50}]);
  expect(()=>translatedSelection([{...a,locked:true},b],selection,1,1)).toThrow('OBJECT_LOCKED');
  const copies=copiedSelection(all,selection,randomUUID);expect(copies).toHaveLength(2);expect(copies[0].groupId).toBe(copies[1].groupId);expect(copies[0].groupId).not.toBe(groupId);expect(copies.every(o=>!selection.has(o.id)&&o.revision===0&&!o.locked)).toBe(true);
  expect(sameEdit({x:1,y:2,revision:1},{y:2,x:1,revision:8})).toBe(true);
});
