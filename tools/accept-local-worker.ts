import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {LocalWorkspaceDatabase} from '../apps/api/src/localWorkspaceDatabase.ts';
import {LocalWorkspaceAssets} from '../apps/api/src/localWorkspaceAssets.ts';
import {LocalWorkflowVersions} from '../apps/api/src/localWorkflowVersions.ts';
import {LocalBoundRuns} from '../apps/api/src/localBoundRuns.ts';
import {LocalRunExecution} from '../apps/api/src/localRunExecution.ts';
import {LocalResizeWorker} from '../apps/worker/src/localResizeWorker.ts';
import {OwnedComfyRuntime} from '../apps/worker/src/ownedComfyRuntime.ts';
import {recordedCompilerPin} from '../apps/worker/src/compileResize.ts';

const root=process.cwd(),caseId=randomUUID(),actor=randomUUID(),project=randomUUID();
const directory=resolve('work','owned-worker-acceptance-'+caseId),evidence=resolve('docs/evidence/2026-11-10/owned-worker',caseId);
mkdirSync(directory,{recursive:true});mkdirSync(evidence,{recursive:true});
const pin=recordedCompilerPin(root).sourceTreeSha256;
const runtime=new OwnedComfyRuntime({root,pythonExecutable:process.env.WORKSPACE_COMFY_PYTHON??'',comfyMain:process.env.WORKSPACE_COMFY_MAIN??'',compilerSourceSha256:pin});
const report:Record<string,unknown>={scope:'actual-private-cpu-worker-not-ui-no-model',caseId,project,compilerSourceSha256:pin,status:'starting'};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
let db:LocalWorkspaceDatabase|undefined;
try{
  db=await LocalWorkspaceDatabase.open(root,resolve(directory,'postgres'));await db.seedProject(project,'owned CPU worker acceptance',[{userId:actor,role:'owner'}]);
  const assets=new LocalWorkspaceAssets(db,resolve(directory,'assets')),repo=new LocalWorkflowVersions(db);
  const sharp=createRequire(new URL('../apps/api/package.json',import.meta.url))('sharp');
  const source=await sharp({create:{width:16,height:12,channels:3,background:{r:51,g:102,b:204}}}).png().toBuffer();
  const asset=await assets.upload(actor,project,source,'image/png','owned-blue.png'),template=await repo.ensureResizeTemplate(actor,project);
  const image={id:randomUUID(),projectId:project,revision:1,type:'image',assetVersionId:asset.id,x:0,y:0,width:160,height:120};
  const tool={id:randomUUID(),projectId:project,revision:1,type:'tool',templateVersionId:template.id,x:240,y:0,width:300,height:300};
  const lease=await db.acquireLease(actor,project);await db.saveObject(actor,project,image,0,lease);await db.saveObject(actor,project,tool,1,lease);
  const binding=await repo.bind(actor,project,{id:randomUUID(),projectId:project,taskLineId:randomUUID(),sourceObjectId:image.id,sourceObjectRevision:1,toolObjectId:tool.id,toolObjectRevision:1,templateVersionId:template.id});
  const runs=new LocalBoundRuns(db,pin),execution=new LocalRunExecution(db,pin);
  const run=await runs.create(actor,project,binding.id,{width:256,height:256},'owned-real-worker');report.runId=run.id;
  await new LocalResizeWorker(execution,assets,runtime).execute(actor,project,run.id);
  const saved=await runs.read(actor,project,run.id),output=saved.output as {asset_version_id:string;object_id:string;sha256:string};
  if(saved.state!=='succeeded'||!output)throw Error('RUN_NOT_SUCCEEDED');
  const bytes=(await assets.download(actor,project,output.asset_version_id)).bytes;
  const decoded=await sharp(bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
  if(decoded.info.width!==256||decoded.info.height!==256||decoded.info.channels!==3||!decoded.data.every((value:number,index:number)=>value===[51,102,204][index%3]))throw Error('OUTPUT_PIXELS_MISMATCH');
  if(!(await assets.download(actor,project,asset.id)).bytes.equals(source))throw Error('SOURCE_CHANGED');
  const events=(await db.asActor(actor,tx=>tx.query('SELECT sequence,stage FROM workspace.run_events WHERE project_id=$1 AND run_id=$2 ORDER BY sequence',[project,run.id]))).rows;
  if(events.map(event=>event.stage).join(',')!=='claimed,submitted,returned,completed')throw Error('EVENT_CHAIN_INCOMPLETE');
  const attempt=(await db.asActor(actor,tx=>tx.query('SELECT provider_request_id,stage,request_hash FROM workspace.run_attempts WHERE project_id=$1 AND run_id=$2',[project,run.id]))).rows[0];
  writeFileSync(resolve(evidence,'result.png'),bytes);writeFileSync(resolve(evidence,'snapshot.json'),JSON.stringify(saved.snapshot,null,2));
  writeFileSync(resolve(evidence,'events.json'),JSON.stringify(events,null,2));
  await db.close();db=undefined;
  db=await LocalWorkspaceDatabase.open(root,resolve(directory,'postgres'));
  const reopened=await new LocalBoundRuns(db,pin).read(actor,project,run.id);
  if(reopened.state!=='succeeded'||JSON.stringify(reopened.output)!==JSON.stringify(output))throw Error('REOPEN_FAILED');
  let replayRefused=false;try{await new LocalRunExecution(db,pin).claim(actor,project,run.id,randomUUID());}catch(error){replayRefused=(error as Error).message==='RUN_NOT_QUEUED';}
  if(!replayRefused)throw Error('REPLAY_NOT_REFUSED');
  report.status='passed';Object.assign(report,{state:reopened.state,sourceSha256:sha(source),outputSha256:sha(bytes),output,attempt,sourceUnchanged:true,pixels:'256x256 uniform RGB(51,102,204)',databaseReopened:true,replayRefused:true,providerRequests:0,modelsLoaded:false});
}catch(error){report.status='failed';report.error=(error as Error).message;process.exitCode=1;}
finally{
  try{await runtime.close();}catch(error){report.cleanupError=(error as Error).message;report.status='failed';process.exitCode=1;}
  if(db)await db.close();Object.assign(report,runtime.evidence);writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,evidence},null,2));
}
