import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {LocalWorkspaceDatabase} from '../apps/api/src/localWorkspaceDatabase';
import {LocalWorkflowVersions} from '../apps/api/src/localWorkflowVersions';
import {LocalBoundRuns} from '../apps/api/src/localBoundRuns';
import {contentHash} from '../apps/api/src/workspacePrototype';
let db:LocalWorkspaceDatabase,runs:LocalBoundRuns,bindingId:string;
const actor=randomUUID(),other=randomUUID(),viewer=randomUUID(),project=randomUUID();
beforeAll(async()=>{
  db=await LocalWorkspaceDatabase.open(process.cwd());runs=new LocalBoundRuns(db,'b'.repeat(64));
  await db.seedProject(project,'owned run transaction',[{userId:actor,role:'owner'},{userId:other,role:'designer'},{userId:viewer,role:'viewer'}]);
  const repo=new LocalWorkflowVersions(db),template=await repo.ensureResizeTemplate(actor,project),asset=randomUUID(),lease=await db.acquireLease(actor,project);
  await db.asActor(actor,tx=>tx.query("INSERT INTO workspace.asset_versions VALUES($1,$2,$3,'ready','owned-fixture')",[project,asset,'a'.repeat(64)]));
  const source={id:randomUUID(),projectId:project,revision:1,type:'image',assetVersionId:asset,x:0,y:0,width:100,height:100},tool={id:randomUUID(),projectId:project,revision:1,type:'tool',templateVersionId:template.id,x:200,y:0,width:100,height:100};
  await db.saveCanvasOperation(actor,project,{id:randomUUID(),baseRevision:0,objects:[source,tool]},lease);
  bindingId=randomUUID();await repo.bind(actor,project,{id:bindingId,projectId:project,taskLineId:randomUUID(),sourceObjectId:source.id,sourceObjectRevision:1,toolObjectId:tool.id,toolObjectRevision:1,templateVersionId:template.id});
});
afterAll(async()=>{await db?.close();});
async function state(){return db.asActor(actor,async tx=>({
  snapshots:(await tx.query('SELECT * FROM workspace.run_snapshots WHERE project_id=$1',[project])).rows,
  runs:(await tx.query('SELECT * FROM workspace.runs WHERE project_id=$1',[project])).rows,
  outbox:(await tx.query('SELECT * FROM workspace.outbox WHERE project_id=$1',[project])).rows,
  budget:(await tx.query('SELECT * FROM workspace.budgets WHERE project_id=$1',[project])).rows,
}));}
it('caller failure after creating snapshot/run/outbox rolls back the entire transaction',async()=>{
  const before=await state();let generated='';
  await expect(db.asActor(actor,async tx=>{generated=(await runs.createInTransaction(tx,actor,project,bindingId,{width:64,height:64},'owned-rollback')).id;throw Error('OWNED_CALLER_ROLLBACK');})).rejects.toThrow('OWNED_CALLER_ROLLBACK');
  expect(generated).not.toBe('');expect(await state()).toEqual(before);
  const retry=await runs.create(actor,project,bindingId,{width:64,height:64},'owned-rollback');expect(retry.reused).toBe(false);expect(retry.id).not.toBe(generated);
});
it('database failure on final outbox insert cannot leave an orphan snapshot or queued run',async()=>{
  const admin=(db as unknown as {db:{exec:(sql:string)=>Promise<unknown>}}).db,before=await state();
  await admin.exec("CREATE FUNCTION workspace.owned_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OWNED_OUTBOX_FAULT'; END $$; CREATE TRIGGER owned_outbox_fault BEFORE INSERT ON workspace.outbox FOR EACH ROW EXECUTE FUNCTION workspace.owned_reject_outbox()");
  try{await expect(db.asActor(actor,tx=>runs.createInTransaction(tx,actor,project,bindingId,{width:128,height:64},'owned-outbox-fault'))).rejects.toThrow('OWNED_OUTBOX_FAULT');expect(await state()).toEqual(before);}
  finally{await admin.exec('DROP TRIGGER owned_outbox_fault ON workspace.outbox; DROP FUNCTION workspace.owned_reject_outbox()');}
  expect((await runs.create(actor,project,bindingId,{width:128,height:64},'owned-outbox-fault')).reused).toBe(false);
});
it('shared transaction preserves manual request hash/dedup and rejects principal substitution or viewer writes',async()=>{
  const key='owned-transaction-idempotent',parameters={width:64,height:128},first=await db.asActor(actor,tx=>runs.createInTransaction(tx,actor,project,bindingId,parameters,key));
  expect(await runs.create(actor,project,bindingId,parameters,key)).toEqual({id:first.id,reused:true});
  const saved=(await db.asActor(actor,tx=>tx.query<{request_hash:string}>('SELECT request_hash FROM workspace.runs WHERE project_id=$1 AND id=$2',[project,first.id]))).rows[0];
  expect(saved.request_hash).toBe(contentHash({bindingId,parameters,policy:'local-resize-only-v1'}));
  const before=await state();
  await expect(db.asActor(other,tx=>runs.createInTransaction(tx,actor,project,bindingId,parameters,'forged-principal'))).rejects.toThrow('EXECUTION_AUTHORITY_MISMATCH');
  await expect(db.asActor(viewer,tx=>runs.createInTransaction(tx,viewer,project,bindingId,parameters,'viewer-write'))).rejects.toThrow('ACCESS_DENIED');
  await expect(db.asActor(actor,tx=>runs.createInTransaction(tx,actor,project,bindingId,{...parameters,width:128},key))).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  expect(await state()).toEqual(before);
});
