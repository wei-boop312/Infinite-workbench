import {LocalArchiveRecovery} from '../apps/api/src/localArchiveRecovery.ts';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {LocalWorkspaceDatabase} from '../apps/api/src/localWorkspaceDatabase.ts';
import {LocalWorkspaceAssets} from '../apps/api/src/localWorkspaceAssets.ts';
import {LocalWorkflowVersions} from '../apps/api/src/localWorkflowVersions.ts';
import {LocalBoundRuns} from '../apps/api/src/localBoundRuns.ts';
import {LocalAgentExecution} from '../apps/api/src/localAgentExecution.ts';
import {LocalRunExecution} from '../apps/api/src/localRunExecution.ts';
import {LocalRunQueries} from '../apps/api/src/localRunQueries.ts';
import {LocalRunArtifactStore} from '../apps/api/src/localRunArtifactStore.ts';
import {WorkspaceModelGateway} from '../apps/api/src/workspaceModelGateway.ts';
import {LocalResizeWorker} from '../apps/worker/src/localResizeWorker.ts';
import {OwnedComfyRuntime} from '../apps/worker/src/ownedComfyRuntime.ts';
import {recordedCompilerPin} from '../apps/worker/src/compileResize.ts';
const caseId=randomUUID(),directory=resolve('work','owned-agent-execution-'+caseId),evidence=resolve('docs/evidence/2026-11-10/agent-execution',caseId),actor=randomUUID(),recoveryActor=randomUUID(),project=randomUUID();
const archiveFailure=process.env.WORKSPACE_ACCEPT_AGENT_ARCHIVE_FAILURE==='1';
mkdirSync(directory,{recursive:true});mkdirSync(evidence,{recursive:true});let db:LocalWorkspaceDatabase|undefined,runtime:OwnedComfyRuntime|undefined;
const report:Record<string,unknown>={caseId,status:'starting',scope:'actual-disk-restart-and-owned-cpu-agent-action-no-model'};
try{
  const pythonExecutable=process.env.WORKSPACE_COMFY_PYTHON,comfyMain=process.env.WORKSPACE_COMFY_MAIN;if(!pythonExecutable||!comfyMain)throw Error('EXPLICIT_OWNED_RUNTIME_REQUIRED');
  const gateway=new WorkspaceModelGateway({compilerConfigured:true,localResizeExecutor:true}),pin=recordedCompilerPin(process.cwd()).sourceTreeSha256,open=()=>LocalWorkspaceDatabase.open(process.cwd(),resolve(directory,'postgres'));
  db=await open();await db.seedProject(project,'owned explicit agent action',[{userId:actor,role:'owner'},{userId:recoveryActor,role:'designer'}]);let assets=new LocalWorkspaceAssets(db,resolve(directory,'assets')),runs=new LocalBoundRuns(db,pin,gateway),agent=new LocalAgentExecution(db,runs,gateway);
  const repo=new LocalWorkflowVersions(db),template=await repo.ensureResizeTemplate(actor,project),sharp=createRequire(new URL('../apps/api/package.json',import.meta.url))('sharp'),sourceBytes=await sharp({create:{width:16,height:12,channels:3,background:'#3366cc'}}).png().toBuffer(),asset=await assets.upload(actor,project,sourceBytes,'image/png','owned-agent.png'),lease=await db.acquireLease(actor,project),source={id:randomUUID(),projectId:project,revision:1,type:'image',assetVersionId:asset.id,x:0,y:0,width:260,height:180},tool={id:randomUUID(),projectId:project,revision:1,type:'tool',templateVersionId:template.id,x:300,y:0,width:330,height:510};
  await db.saveCanvasOperation(actor,project,{id:randomUUID(),baseRevision:0,objects:[source,tool]},lease);
  const binding=await repo.bind(actor,project,{id:randomUUID(),projectId:project,taskLineId:randomUUID(),sourceObjectId:source.id,sourceObjectRevision:1,toolObjectId:tool.id,toolObjectRevision:1,templateVersionId:template.id}),grant=(await agent.authority.createGrant(actor,project,{id:randomUUID(),level:'L1',bindingIds:[binding.id],ttlSeconds:600,maxActions:1,maxPixels:4096})).grant,proposal=(await agent.authority.propose(actor,project,grant.id,{id:randomUUID(),bindingId:binding.id,parameters:{width:64,height:64}})).proposal,nonce=randomUUID(),request={id:randomUUID(),proposalId:proposal.id,hash:proposal.approvalHash,nonce};
  await agent.authority.approve(actor,project,proposal.id,{hash:proposal.approvalHash,nonce});const created=await agent.execute(actor,project,request),before=await runs.read(actor,project,created.id);
  await db.close();db=undefined;db=await open();assets=new LocalWorkspaceAssets(db,resolve(directory,'assets'));runs=new LocalBoundRuns(db,pin,gateway);agent=new LocalAgentExecution(db,runs,gateway);
  const retry=await agent.execute(actor,project,request);if(!retry.reused||retry.id!==created.id||(await runs.read(actor,project,created.id)).snapshotHash!==before.snapshotHash)throw Error('CONSUMPTION_RESTART_FAILED');
  runtime=new OwnedComfyRuntime({root:process.cwd(),pythonExecutable,comfyMain,compilerSourceSha256:pin});
  if(archiveFailure){const upload=assets.upload.bind(assets);let failed=false;assets.upload=async(...args)=>{if(!failed&&String(args[4]).startsWith('resize-')){failed=true;throw Error('OWNED_AGENT_ARCHIVE_FAULT');}return upload(...args);};}
  const worker=new LocalResizeWorker(new LocalRunExecution(db,pin,gateway),assets,runtime,new LocalRunArtifactStore(resolve(directory,'artifacts')));
  try{await worker.execute(actor,project,created.id);}catch(error){if(!archiveFailure||(error as Error).message!=='OWNED_AGENT_ARCHIVE_FAULT')throw error;}
  if(archiveFailure){
    if((await runs.read(actor,project,created.id)).state!=='unknown')throw Error('ARCHIVE_FAULT_NOT_UNKNOWN');
    await agent.revoke(actor,project,grant.id,'revoke before archive recovery');
    const admin=(db as unknown as {db:{query:(sql:string,args:unknown[])=>Promise<unknown>}}).db;
    await admin.query("UPDATE workspace.project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,actor]);
    await new LocalArchiveRecovery(new LocalRunExecution(db,pin,gateway),new LocalRunArtifactStore(resolve(directory,'artifacts')),assets).recover(recoveryActor,project,created.id);
    await admin.query("UPDATE workspace.project_members SET role='owner' WHERE project_id=$1 AND user_id=$2",[project,actor]);
  }
  const completed=await runs.read(actor,project,created.id);if(completed.state!=='succeeded'||!completed.output)throw Error('AGENT_RESULT_NOT_READY');
  const downloaded=await assets.download(actor,project,String(completed.output.asset_version_id)),decoded=await sharp(downloaded.bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
  if(decoded.info.width!==64||decoded.info.height!==64||!decoded.data.every((v:number,i:number)=>v===[51,102,204][i%3]))throw Error('AGENT_OUTPUT_PIXELS_CHANGED');
  const revocation=await agent.revoke(actor,project,grant.id,archiveFailure?'revoke before archive recovery':'after ready');if((await runs.read(actor,project,created.id)).state!=='succeeded'||revocation.cancellationRequestedCount!==0)throw Error('READY_RESULT_CHANGED');
  if(!(await agent.execute(actor,project,request)).reused)throw Error('OLD_RECEIPT_NOT_REUSED');
  const usage=await new LocalRunQueries(db).usage(actor,project);if(usage.localResize.runCount!==1||!usage.actual.complete)throw Error('AGENT_USAGE_NOT_ACCOUNTED');
  const counts=await db.asActor(actor,async tx=>{const result:Record<string,number>={};for(const table of ['runs','run_snapshots','outbox','run_attempts','agent_execution_consumptions','run_outputs'])result[table]=(await tx.query(`SELECT * FROM workspace.${table} WHERE project_id=$1`,[project])).rows.length;return result;});
  if(Object.values(counts).some(n=>n!==1)||!runtime.evidence.stopped)throw Error('AGENT_EXECUTION_NOT_SINGLE');
  if(!(await assets.download(actor,project,asset.id)).bytes.equals(sourceBytes))throw Error('SOURCE_CHANGED');
  writeFileSync(resolve(evidence,'result.png'),downloaded.bytes);writeFileSync(resolve(evidence,'runtime-evidence.json'),JSON.stringify(runtime.evidence,null,2));
  Object.assign(report,{status:'passed',databaseReopened:true,snapshotVersion:3,snapshotHash:completed.snapshotHash,approvalConsumedOnce:true,requestRetryReused:true,counts,resultSha256:createHash('sha256').update(downloaded.bytes).digest('hex'),resultDimensions:[64,64],originalBytesUnchanged:true,readyResultPreservedAfterRevoke:true,runtimeStopped:true,archiveRecoveredAfterRevoke:archiveFailure,archiveRecoveredByDifferentEditor:archiveFailure,noSecondGeneration:true,modelRequests:0,providerCost:'0'});
}catch(error){report.status='failed';report.error=(error as Error).message;process.exitCode=1;}
finally{if(runtime)await runtime.close();if(db)await db.close();writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,evidence},null,2));}
