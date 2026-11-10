import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {LocalWorkspaceDatabase} from '../apps/api/src/localWorkspaceDatabase.ts';
import {LocalWorkspaceAssets} from '../apps/api/src/localWorkspaceAssets.ts';
import {LocalWorkflowVersions} from '../apps/api/src/localWorkflowVersions.ts';
import {LocalBoundRuns} from '../apps/api/src/localBoundRuns.ts';
const caseId=randomUUID(),directory=resolve('work','owned-run-transaction-'+caseId),evidence=resolve('docs/evidence/2026-11-10/run-transaction',caseId),actor=randomUUID(),project=randomUUID();
mkdirSync(directory,{recursive:true});mkdirSync(evidence,{recursive:true});let db:LocalWorkspaceDatabase|undefined;
const report:Record<string,unknown>={caseId,status:'starting',scope:'actual-disk-transaction-rollback-and-queued-run-dedup-no-dispatch'};
try{
  const open=()=>LocalWorkspaceDatabase.open(process.cwd(),resolve(directory,'postgres'));
  db=await open();await db.seedProject(project,'owned transaction restart',[{userId:actor,role:'owner'}]);
  const assets=new LocalWorkspaceAssets(db,resolve(directory,'assets')),repo=new LocalWorkflowVersions(db),template=await repo.ensureResizeTemplate(actor,project),sharp=createRequire(new URL('../apps/api/package.json',import.meta.url))('sharp'),bytes=await sharp({create:{width:8,height:8,channels:3,background:'#3366cc'}}).png().toBuffer(),asset=await assets.upload(actor,project,bytes,'image/png','owned-transaction.png'),lease=await db.acquireLease(actor,project);
  const source={id:randomUUID(),projectId:project,revision:1,type:'image',assetVersionId:asset.id,x:0,y:0,width:260,height:180},tool={id:randomUUID(),projectId:project,revision:1,type:'tool',templateVersionId:template.id,x:300,y:0,width:330,height:510};
  await db.saveCanvasOperation(actor,project,{id:randomUUID(),baseRevision:0,objects:[source,tool]},lease);
  const binding=await repo.bind(actor,project,{id:randomUUID(),projectId:project,taskLineId:randomUUID(),sourceObjectId:source.id,sourceObjectRevision:1,toolObjectId:tool.id,toolObjectRevision:1,templateVersionId:template.id});
  let runs=new LocalBoundRuns(db,'b'.repeat(64));const key='owned-transaction-restart',parameters={width:64,height:64};let failedId='';
  try{await db.asActor(actor,async tx=>{failedId=(await runs.createInTransaction(tx,actor,project,binding.id,parameters,key)).id;throw Error('OWNED_ABORT');});throw Error('ROLLBACK_EXPECTED');}catch(error){if((error as Error).message!=='OWNED_ABORT')throw error;}
  await db.close();db=undefined;db=await open();
  const counts=()=>db!.asActor(actor,async tx=>{const result:Record<string,number>={};for(const table of ['run_snapshots','runs','outbox','run_attempts'])result[table]=(await tx.query(`SELECT * FROM workspace.${table} WHERE project_id=$1`,[project])).rows.length;return result;});
  const rolledBack=await counts();if(Object.values(rolledBack).some(Boolean))throw Error('ROLLBACK_NOT_DURABLE');
  runs=new LocalBoundRuns(db,'b'.repeat(64));const created=await db.asActor(actor,tx=>runs.createInTransaction(tx,actor,project,binding.id,parameters,key));if(created.reused||created.id===failedId)throw Error('ROLLBACK_RECEIPT_REUSED');const original=await runs.read(actor,project,created.id);
  await db.close();db=undefined;db=await open();runs=new LocalBoundRuns(db,'b'.repeat(64));
  const retry=await runs.create(actor,project,binding.id,parameters,key),reopened=await runs.read(actor,project,created.id),committed=await counts();
  if(!retry.reused||retry.id!==created.id||reopened.snapshotHash!==original.snapshotHash||reopened.state!=='queued'||committed.run_snapshots!==1||committed.runs!==1||committed.outbox!==1||committed.run_attempts!==0)throw Error('COMMIT_NOT_DURABLE');
  Object.assign(report,{status:'passed',databaseReopens:2,rolledBack,committed,snapshotHashUnchanged:true,requestRetryReused:true,executed:false,modelRequests:0});
}catch(error){report.status='failed';report.error=(error as Error).message;process.exitCode=1;}
finally{if(db)await db.close();writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,evidence},null,2));}
