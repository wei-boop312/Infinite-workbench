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
import {contentHash} from '../apps/api/src/workspacePrototype.ts';
import {isInterruptedWithoutOutput} from '../apps/api/src/ownedCancellationReceipt.ts';
import {LocalRunArtifactStore} from '../apps/api/src/localRunArtifactStore.ts';
import {LocalArchiveRecovery} from '../apps/api/src/localArchiveRecovery.ts';

const root=process.cwd(),caseId=randomUUID(),actor=randomUUID(),project=randomUUID();
const cancelAfterSubmission=process.env.WORKSPACE_ACCEPT_CANCEL==='1',parameters=cancelAfterSubmission?{width:4096,height:3906}:{width:256,height:256};
const recoverArchive=process.env.WORKSPACE_ACCEPT_ARCHIVE_FAILURE==='1';
if(recoverArchive&&cancelAfterSubmission)throw Error('INCOMPATIBLE_ACCEPTANCE_MODES');
const directory=resolve('work','owned-worker-acceptance-'+caseId),evidence=resolve('docs/evidence/2026-11-10',cancelAfterSubmission?'owned-cancellation':'owned-worker',caseId);
mkdirSync(directory,{recursive:true});mkdirSync(evidence,{recursive:true});
const pin=recordedCompilerPin(root).sourceTreeSha256;
let requestCancellation:(()=>Promise<unknown>)|undefined;
const options={root,pythonExecutable:process.env.WORKSPACE_COMFY_PYTHON??'',comfyMain:process.env.WORKSPACE_COMFY_MAIN??'',compilerSourceSha256:pin};
const runtime=cancelAfterSubmission?new class extends OwnedComfyRuntime{
  async submit(request:{prompt:unknown;client_id:string}){const id=await super.submit(request);if(!requestCancellation)throw Error('CANCEL_FIXTURE_NOT_READY');await requestCancellation();return id;}
}(options):new OwnedComfyRuntime(options);
const report:Record<string,unknown>={scope:cancelAfterSubmission?'actual-owned-post-submit-cancellation-no-model':'actual-private-cpu-worker-not-ui-no-model',caseId,project,parameters,compilerSourceSha256:pin,status:'starting'};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
let db:LocalWorkspaceDatabase|undefined;
try{
  db=await LocalWorkspaceDatabase.open(root,resolve(directory,'postgres'));await db.seedProject(project,'owned CPU worker acceptance',[{userId:actor,role:'owner'}]);
  let assets=new LocalWorkspaceAssets(db,resolve(directory,'assets'));const repo=new LocalWorkflowVersions(db);
  const sharp=createRequire(new URL('../apps/api/package.json',import.meta.url))('sharp');
  const source=await sharp({create:{width:16,height:12,channels:3,background:{r:51,g:102,b:204}}}).png().toBuffer();
  const asset=await assets.upload(actor,project,source,'image/png','owned-blue.png'),template=await repo.ensureResizeTemplate(actor,project);
  const image={id:randomUUID(),projectId:project,revision:1,type:'image',assetVersionId:asset.id,x:0,y:0,width:160,height:120};
  const tool={id:randomUUID(),projectId:project,revision:1,type:'tool',templateVersionId:template.id,x:240,y:0,width:300,height:300};
  const lease=await db.acquireLease(actor,project);await db.saveObject(actor,project,image,0,lease);await db.saveObject(actor,project,tool,1,lease);
  const binding=await repo.bind(actor,project,{id:randomUUID(),projectId:project,taskLineId:randomUUID(),sourceObjectId:image.id,sourceObjectRevision:1,toolObjectId:tool.id,toolObjectRevision:1,templateVersionId:template.id});
  let runs=new LocalBoundRuns(db,pin);const execution=new LocalRunExecution(db,pin);
  const run=await runs.create(actor,project,binding.id,parameters,'owned-real-worker');report.runId=run.id;
  requestCancellation=()=>runs.cancel(actor,project,run.id,'自有CPU验收：提交后取消');
  const artifactStore=new LocalRunArtifactStore(resolve(directory,'run-artifacts'));
  if(recoverArchive){
    assets.upload=async()=>{throw Error('acceptance-private-storage-unavailable');};
    let failedAsExpected=false;
    try{await new LocalResizeWorker(execution,assets,runtime,artifactStore).execute(actor,project,run.id);}catch(error){failedAsExpected=(error as Error).message==='acceptance-private-storage-unavailable';}
    if(!failedAsExpected||(await runs.read(actor,project,run.id)).state!=='unknown'||!runtime.evidence.stopped)throw Error('ARCHIVE_FAILURE_NOT_RETAINED');
    await db.close();db=undefined;db=await LocalWorkspaceDatabase.open(root,resolve(directory,'postgres'));
    assets=new LocalWorkspaceAssets(db,resolve(directory,'assets'));runs=new LocalBoundRuns(db,pin);
    const recovery=new LocalArchiveRecovery(new LocalRunExecution(db,'a'.repeat(64)),new LocalRunArtifactStore(resolve(directory,'run-artifacts')),assets);
    const recovered=await recovery.recover(actor,project,run.id),repeated=await recovery.recover(actor,project,run.id);
    if(recovered.reused||!repeated.reused)throw Error('ARCHIVE_RECOVERY_IDEMPOTENCY_FAILED');
    Object.assign(report,{archiveRecoveredAfterDatabaseRestart:true,historicalCompilerAccepted:true,archiveRecoveryRepeatedWithoutDuplicate:true});
  }else await new LocalResizeWorker(execution,assets,runtime,artifactStore).execute(actor,project,run.id);
  const saved=await runs.read(actor,project,run.id),output=saved.output as {asset_version_id:string;object_id:string;sha256:string};
  if(!(await assets.download(actor,project,asset.id)).bytes.equals(source))throw Error('SOURCE_CHANGED');
  const events=(await db.asActor(actor,tx=>tx.query('SELECT sequence,stage FROM workspace.run_events WHERE project_id=$1 AND run_id=$2 ORDER BY sequence',[project,run.id]))).rows;
  if(events.filter(event=>event.stage==='submitted').length!==1)throw Error('SUBMISSION_COUNT_MISMATCH');
  const attempt=(await db.asActor(actor,tx=>tx.query<{provider_request_id:string;stage:string;request_hash:string;request_payload:{prompt:unknown};response_payload:unknown}>('SELECT provider_request_id,stage,request_hash,request_payload,response_payload FROM workspace.run_attempts WHERE project_id=$1 AND run_id=$2',[project,run.id]))).rows[0];
  const preparation=(await db.asActor(actor,tx=>tx.query<{payload:unknown;content_hash:string;request_hash:string}>('SELECT payload,content_hash,request_hash FROM workspace.run_preparations WHERE project_id=$1 AND run_id=$2',[project,run.id]))).rows[0];
  if(!preparation||contentHash(preparation.payload)!==preparation.content_hash||preparation.request_hash!==attempt.request_hash)throw Error('PREPARATION_NOT_PERSISTED');
  writeFileSync(resolve(evidence,'runtime-evidence.json'),JSON.stringify(preparation,null,2));report.runtimeEvidencePersisted=true;
  const cachedRecord=(await db.asActor(actor,tx=>tx.query<{attempt_id:string;manifest:unknown;manifest_hash:string;sha256:string}>('SELECT attempt_id,manifest,manifest_hash,sha256 FROM workspace.run_artifacts WHERE project_id=$1 AND run_id=$2',[project,run.id]))).rows[0];
  if(cancelAfterSubmission&&!saved.cancellation)throw Error('CANCEL_REQUEST_NOT_RECORDED');
  if(saved.state==='cancelled'&&cancelAfterSubmission){
    if(output||attempt.stage!=='cancelled'||!isInterruptedWithoutOutput(attempt.response_payload,attempt.provider_request_id,attempt.request_payload.prompt)||!runtime.evidence.stopped)throw Error('CANCELLATION_NOT_PROVEN');
    Object.assign(report,{outcome:'confirmed_cancelled',output:null});
  }else{
    if(saved.state!=='succeeded'||!output)throw Error('RUN_NOT_SUCCEEDED');
    if(!cachedRecord||cachedRecord.sha256!==output.sha256||contentHash(cachedRecord.manifest)!==cachedRecord.manifest_hash)throw Error('ARTIFACT_NOT_PERSISTED');
    writeFileSync(resolve(evidence,'artifact-evidence.json'),JSON.stringify(cachedRecord,null,2));
    const bytes=(await assets.download(actor,project,output.asset_version_id)).bytes;
    const decoded=await sharp(bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
    if(decoded.info.width!==parameters.width||decoded.info.height!==parameters.height||decoded.info.channels!==3||!decoded.data.every((value:number,index:number)=>value===[51,102,204][index%3]))throw Error('OUTPUT_PIXELS_MISMATCH');
    writeFileSync(resolve(evidence,'result.png'),bytes);Object.assign(report,{outcome:cancelAfterSubmission?'completion_won_race':'completed',outputSha256:sha(bytes),output,pixels:`${parameters.width}x${parameters.height} uniform RGB(51,102,204)`});
  }
  writeFileSync(resolve(evidence,'snapshot.json'),JSON.stringify(saved.snapshot,null,2));
  writeFileSync(resolve(evidence,'history.json'),JSON.stringify(attempt.response_payload,null,2));
  writeFileSync(resolve(evidence,'events.json'),JSON.stringify(events,null,2));
  await db.close();db=undefined;
  db=await LocalWorkspaceDatabase.open(root,resolve(directory,'postgres'));
  const reopened=await new LocalBoundRuns(db,pin).read(actor,project,run.id);
  if(reopened.state!==saved.state||contentHash(reopened.output)!==contentHash(saved.output))throw Error('REOPEN_FAILED');
  if(cachedRecord){const recovered=await new LocalRunArtifactStore(resolve(directory,'run-artifacts')).load({projectId:project,runId:run.id,attemptId:cachedRecord.attempt_id},cachedRecord.manifest_hash);if(recovered.manifest.sha256!==cachedRecord.sha256)throw Error('CACHE_REOPEN_FAILED');report.cachedArtifactReopened=true;}
  let replayRefused=false;try{await new LocalRunExecution(db,pin).claim(actor,project,run.id,randomUUID());}catch(error){replayRefused=(error as Error).message==='RUN_NOT_QUEUED';}
  if(!replayRefused)throw Error('REPLAY_NOT_REFUSED');
  report.status='passed';Object.assign(report,{state:reopened.state,sourceSha256:sha(source),attempt:{provider_request_id:attempt.provider_request_id,stage:attempt.stage,request_hash:attempt.request_hash},sourceUnchanged:true,databaseReopened:true,replayRefused:true,providerRequests:0,modelsLoaded:false});
}catch(error){report.status='failed';report.error=(error as Error).message;process.exitCode=1;}
finally{
  try{await runtime.close();}catch(error){report.cleanupError=(error as Error).message;report.status='failed';process.exitCode=1;}
  if(db)await db.close();Object.assign(report,runtime.evidence);writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,evidence},null,2));
}
