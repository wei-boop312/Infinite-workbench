import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { WorkspaceWorkflowSchema,WorkspaceTemplateSchema,WorkspaceObjectSchema,WorkspaceBindingRequestSchema,WorkspaceParametersSchema,WorkspaceRuntimeEvidenceSchema,WorkspaceArtifactManifestSchema } from '@canvas/contracts';
import { LocalWorkspaceDatabase } from './localWorkspaceDatabase.ts';
import { contentHash,validateWorkflow } from './workspacePrototype.ts';
import {isInterruptedWithoutOutput,type OwnedCancellationReceipt} from './ownedCancellationReceipt.ts';
import {matchesOwnedOutputHistory} from './ownedOutputReceipt.ts';
import type {StoredRunArtifact} from './localRunArtifactStore.ts';
import type {Transaction} from '@electric-sql/pglite';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export type LocalExecutionLease={projectId:string;runId:string;attemptId:string;actorId:string;workerId:string;token:string};
export type LocalArchiveLease=LocalExecutionLease&{recoveryId:string};
type OutputReceipt={assetId:string;sha256:string;providerRequestId:string};
type ArchiveClaimRow={id:string;attempt_id:string;actor_id:string;worker_id:string;token_hash:string;expires_at:Date;status:string};
type AttemptRow={id:string;actor_id:string;worker_id:string;token_hash:string;lease_expires_at:Date;execution_fenced:boolean;stage:string;request_hash:string|null;request_payload:Record<string,unknown>|null;provider_request_id:string|null;response_payload:unknown};

/** Internal worker port, never accepts an actor or lease from public HTTP. */
export class LocalRunExecution {
  constructor(private db:LocalWorkspaceDatabase,private compilerSourceSha256:string){}
  private validateSnapshot(raw:unknown,projectId:string,actorId:string,compilerSourceSha256=this.compilerSourceSha256){
    const snapshot=raw as Record<string,any>;
    if(!snapshot||snapshot.schemaVersion!==1)throw Error('SNAPSHOT_INTEGRITY_FAILED');
    const binding=WorkspaceBindingRequestSchema.parse(snapshot.binding),workflow=WorkspaceWorkflowSchema.parse(snapshot.workflow),template=WorkspaceTemplateSchema.parse(snapshot.template),
      source=WorkspaceObjectSchema.parse(snapshot.source),tool=WorkspaceObjectSchema.parse(snapshot.tool),parameters=WorkspaceParametersSchema.parse(snapshot.parameters);
    validateWorkflow(workflow);
    if([binding,workflow,template,source,tool].some(r=>r.projectId!==projectId)||source.type!=='image'||tool.type!=='tool'||
      template.id!==binding.templateVersionId||tool.templateVersionId!==template.id||template.workflowVersionId!==workflow.id||
      source.id!==binding.sourceObjectId||source.revision!==binding.sourceObjectRevision||tool.id!==binding.toolObjectId||tool.revision!==binding.toolObjectRevision||
      contentHash(workflow)!==snapshot.workflowHash||contentHash(template)!==snapshot.templateHash||
      snapshot.asset?.id!==source.assetVersionId||!/^[a-f0-9]{64}$/.test(snapshot.asset?.sha256??'')||
      snapshot.authorization?.actorId!==actorId||snapshot.authorization?.scope!=='local-resize-only-v1'||snapshot.authorization?.providerCost!=='0'||snapshot.authorization?.currency!=='USD'||
      snapshot.compiler?.version!=='2.15.2'||snapshot.compiler?.sourceSha256!==compilerSourceSha256||snapshot.compiler?.registryValidation!=='required-before-worker-execution')throw Error('SNAPSHOT_INTEGRITY_FAILED');
    return {...snapshot,binding,workflow,template,source,tool,parameters,asset:{id:source.assetVersionId,sha256:snapshot.asset.sha256 as string}};
  }
  async claim(actorId:string,projectId:string,runId:string,workerId:string,now=new Date()){
    const token=randomBytes(32).toString('base64url'),attemptId=randomUUID();
    return this.db.asActor(actorId,async tx=>{
      const run=(await tx.query<{state:string;payload:unknown;content_hash:string}>(
        'SELECT r.state,s.payload,s.content_hash FROM workspace.runs r JOIN workspace.run_snapshots s ON s.project_id=r.project_id AND s.id=r.snapshot_id WHERE r.project_id=$1 AND r.id=$2 FOR UPDATE OF r',[projectId,runId])).rows[0];
      if(!run)throw Error('NOT_FOUND');if(run.state!=='queued')throw Error('RUN_NOT_QUEUED');
      if(contentHash(run.payload)!==run.content_hash)throw Error('SNAPSHOT_INTEGRITY_FAILED');
      const snapshot=this.validateSnapshot(run.payload,projectId,actorId);
      const asset=(await tx.query<{sha256:string;state:string}>('SELECT sha256,state FROM workspace.asset_versions WHERE project_id=$1 AND id=$2',[projectId,snapshot.asset.id])).rows[0];
      if(!asset||asset.state!=='ready'||asset.sha256!==snapshot.asset.sha256)throw Error('ASSET_INTEGRITY_FAILED');
      await tx.query("INSERT INTO workspace.run_attempts(project_id,id,run_id,actor_id,worker_id,token_hash,lease_expires_at,stage) VALUES($1,$2,$3,$4,$5,$6,$7,'claimed')",[projectId,attemptId,runId,actorId,workerId,hash(token),new Date(now.getTime()+60_000).toISOString()]);
      const updated=await tx.query("UPDATE workspace.runs SET state='running' WHERE project_id=$1 AND id=$2 AND state='queued' RETURNING id",[projectId,runId]);
      if(!updated.rows.length)throw Error('EXECUTION_PERMISSION_DENIED');
      await tx.query("UPDATE workspace.outbox SET dispatched_at=$1 WHERE project_id=$2 AND run_id=$3 AND event_type='run.created' AND dispatched_at IS NULL",[now.toISOString(),projectId,runId]);
      return {lease:{projectId,runId,attemptId,actorId,workerId,token},snapshot,snapshotHash:run.content_hash};
    });
  }
  async beforeSubmit(lease:LocalExecutionLease,request:unknown,now=new Date()){
    const requestHash=contentHash(request);
    await this.db.asActor(lease.actorId,async tx=>{
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.attemptId,lease.runId])).rows[0];
      this.checkLease(row,lease,now);
      if(row.stage!=='claimed')throw Error('ALREADY_SUBMITTED');
      const run=(await tx.query<{state:string}>('SELECT state FROM workspace.runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[lease.projectId,lease.runId])).rows[0];
      if(run?.state==='cancel_requested')throw Error('RUN_CANCEL_REQUESTED');
      if(run?.state!=='running')throw Error('RUN_NOT_RUNNING');
      const prep=(await tx.query<{request_hash:string;payload:unknown;content_hash:string}>('SELECT request_hash,payload,content_hash FROM workspace.run_preparations WHERE project_id=$1 AND attempt_id=$2',[lease.projectId,lease.attemptId])).rows[0];
      if(prep&&(prep.request_hash!==requestHash||contentHash(prep.payload)!==prep.content_hash))throw Error('PREPARATION_INTEGRITY_FAILED');
      // Persist the exact outbound request before allowing one external POST.
      const updated=await tx.query("UPDATE workspace.run_attempts SET stage='submitted',request_payload=$1,request_hash=$2 WHERE project_id=$3 AND id=$4 RETURNING id",[JSON.stringify(request),requestHash,lease.projectId,lease.attemptId]);
      if(!updated.rows.length)throw Error('EXECUTION_PERMISSION_DENIED');
    });
    return {requestHash};
  }
  async recordPreparation(lease:LocalExecutionLease,request:unknown,raw:unknown,now=new Date()){
    const evidence=WorkspaceRuntimeEvidenceSchema.parse(raw),content_hash=contentHash(evidence),request_hash=contentHash(request);
    if(evidence.compilerSourceSha256!==this.compilerSourceSha256)throw Error('COMPILER_ENVIRONMENT_CHANGED');
    await this.db.asActor(lease.actorId,async tx=>{
      const attempt=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.attemptId,lease.runId])).rows[0];this.checkLease(attempt,lease,now);
      if(attempt.stage!=='claimed')throw Error('INVALID_ATTEMPT_STAGE');
      const prior=(await tx.query<{content_hash:string;request_hash:string}>('SELECT content_hash,request_hash FROM workspace.run_preparations WHERE project_id=$1 AND attempt_id=$2',[lease.projectId,lease.attemptId])).rows[0];
      if(prior){if(prior.content_hash!==content_hash||prior.request_hash!==request_hash)throw Error('PREPARATION_IMMUTABLE_CONFLICT');return;}
      await tx.query('INSERT INTO workspace.run_preparations(project_id,attempt_id,run_id,request_hash,payload,content_hash) VALUES($1,$2,$3,$4,$5,$6)',[lease.projectId,lease.attemptId,lease.runId,request_hash,JSON.stringify(evidence),content_hash]);
    });return {evidenceHash:content_hash,requestHash:request_hash};
  }
  async recordValidatedArtifact(lease:LocalExecutionLease,raw:StoredRunArtifact,now=new Date()){
    const manifest=WorkspaceArtifactManifestSchema.parse(raw.manifest),manifestHash=contentHash(manifest);
    if(manifestHash!==raw.manifestHash||manifest.projectId!==lease.projectId||manifest.runId!==lease.runId||manifest.attemptId!==lease.attemptId)throw Error('ARTIFACT_INTEGRITY_FAILED');
    await this.db.asActor(lease.actorId,async tx=>{
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.attemptId,lease.runId])).rows[0];this.checkLease(row,lease,now);
      if(!['submitted','returned'].includes(row.stage)||!row.request_payload||row.request_hash!==manifest.requestHash||row.provider_request_id!==manifest.providerRequestId||!matchesOwnedOutputHistory(manifest.history,manifest.providerRequestId,row.request_payload.prompt))throw Error('ARTIFACT_RECEIPT_REJECTED');
      const prep=(await tx.query<{content_hash:string;payload:unknown}>('SELECT content_hash,payload FROM workspace.run_preparations WHERE project_id=$1 AND attempt_id=$2 AND run_id=$3',[lease.projectId,lease.attemptId,lease.runId])).rows[0];
      if(!prep||contentHash(prep.payload)!==prep.content_hash||prep.content_hash!==manifest.runtimeEvidenceHash)throw Error('PREPARATION_INTEGRITY_FAILED');
      const run=(await tx.query<{state:string;payload:unknown;content_hash:string}>('SELECT r.state,s.payload,s.content_hash FROM workspace.runs r JOIN workspace.run_snapshots s ON s.project_id=r.project_id AND s.id=r.snapshot_id WHERE r.project_id=$1 AND r.id=$2 FOR UPDATE OF r',[lease.projectId,lease.runId])).rows[0];
      if(!run||!['running','cancel_requested','archiving'].includes(run.state)||contentHash(run.payload)!==run.content_hash||run.content_hash!==manifest.snapshotHash)throw Error('SNAPSHOT_INTEGRITY_FAILED');
      const snapshot=this.validateSnapshot(run.payload,lease.projectId,lease.actorId);if(snapshot.parameters.width!==manifest.width||snapshot.parameters.height!==manifest.height)throw Error('OUTPUT_DIMENSIONS_MISMATCH');
      const prior=(await tx.query<{manifest_hash:string}>('SELECT manifest_hash FROM workspace.run_artifacts WHERE project_id=$1 AND run_id=$2',[lease.projectId,lease.runId])).rows[0];
      if(prior){if(prior.manifest_hash!==manifestHash)throw Error('ARTIFACT_IMMUTABLE_CONFLICT');return;}
      await tx.query('INSERT INTO workspace.run_artifacts(project_id,run_id,attempt_id,manifest,manifest_hash,sha256,byte_size) VALUES($1,$2,$3,$4,$5,$6,$7)',[lease.projectId,lease.runId,lease.attemptId,JSON.stringify(manifest),manifestHash,manifest.sha256,manifest.byteSize]);
      const updated=await tx.query("UPDATE workspace.run_attempts SET stage='returned',response_payload=$1 WHERE project_id=$2 AND id=$3 RETURNING id",[JSON.stringify(manifest.history),lease.projectId,lease.attemptId]);
      if(!updated.rows.length)throw Error('EXECUTION_PERMISSION_DENIED');
      await tx.query("UPDATE workspace.runs SET state='archiving' WHERE project_id=$1 AND id=$2",[lease.projectId,lease.runId]);
    });return {manifestHash};
  }
  private checkLease(row:AttemptRow|undefined,lease:LocalExecutionLease,now:Date){
    if(!row||row.execution_fenced||row.actor_id!==lease.actorId||row.worker_id!==lease.workerId||row.token_hash!==hash(lease.token)||new Date(row.lease_expires_at).getTime()<=now.getTime())throw Error('EXECUTION_LEASE_INVALID');
  }
  async recordResponse(lease:LocalExecutionLease,providerRequestId:string,response:unknown,now=new Date()){
    if(!/^[a-zA-Z0-9_-]{1,160}$/.test(providerRequestId))throw Error('INVALID_PROVIDER_REQUEST_ID');
    await this.db.asActor(lease.actorId,async tx=>{
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.attemptId,lease.runId])).rows[0];this.checkLease(row,lease,now);
      if(row.stage!=='submitted')throw Error('INVALID_ATTEMPT_STAGE');
      const updated=await tx.query("UPDATE workspace.run_attempts SET stage='returned',provider_request_id=$1,response_payload=$2 WHERE project_id=$3 AND id=$4 RETURNING id",[providerRequestId,JSON.stringify(response),lease.projectId,lease.attemptId]);
      if(!updated.rows.length)throw Error('EXECUTION_PERMISSION_DENIED');
      await tx.query("UPDATE workspace.runs SET state='archiving' WHERE project_id=$1 AND id=$2 AND state IN ('running','cancel_requested')",[lease.projectId,lease.runId]);
    });
  }
  async recordSubmissionReceipt(lease:LocalExecutionLease,providerRequestId:string,now=new Date()){
    if(!/^[a-zA-Z0-9_-]{1,160}$/.test(providerRequestId))throw Error('INVALID_PROVIDER_REQUEST_ID');
    await this.db.asActor(lease.actorId,async tx=>{
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.attemptId,lease.runId])).rows[0];this.checkLease(row,lease,now);
      if(row.stage!=='submitted')throw Error('INVALID_ATTEMPT_STAGE');
      const updated=await tx.query('UPDATE workspace.run_attempts SET provider_request_id=$1 WHERE project_id=$2 AND id=$3 RETURNING id',[providerRequestId,lease.projectId,lease.attemptId]);
      if(!updated.rows.length)throw Error('EXECUTION_PERMISSION_DENIED');
    });
  }
  async stopAttempt(lease:LocalExecutionLease,now=new Date()){
    return this.db.asActor(lease.actorId,async tx=>{
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.attemptId,lease.runId])).rows[0];this.checkLease(row,lease,now);
      if(['completed','failed','unknown','cancelled'].includes(row.stage))return;
      const run=(await tx.query<{state:string}>('SELECT state FROM workspace.runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[lease.projectId,lease.runId])).rows[0];
      const state=row.stage==='claimed'?(run?.state==='cancel_requested'?'cancelled':'failed'):'unknown';
      const updated=await tx.query('UPDATE workspace.run_attempts SET stage=$1 WHERE project_id=$2 AND id=$3 RETURNING id',[state,lease.projectId,lease.attemptId]);
      if(!updated.rows.length)throw Error('EXECUTION_PERMISSION_DENIED');
      await tx.query('UPDATE workspace.runs SET state=$1 WHERE project_id=$2 AND id=$3',[state,lease.projectId,lease.runId]);
      return {state};
    });
  }
  async cancellationRequested(lease:LocalExecutionLease,now=new Date()){
    return this.db.asActor(lease.actorId,async tx=>{
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3',[lease.projectId,lease.attemptId,lease.runId])).rows[0];this.checkLease(row,lease,now);
      return (await tx.query<{state:string}>('SELECT state FROM workspace.runs WHERE project_id=$1 AND id=$2',[lease.projectId,lease.runId])).rows[0]?.state==='cancel_requested';
    });
  }
  async confirmCancelled(lease:LocalExecutionLease,raw:OwnedCancellationReceipt,now=new Date()){
    const receipt=structuredClone(raw);
    await this.db.asActor(lease.actorId,async tx=>{
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.attemptId,lease.runId])).rows[0];this.checkLease(row,lease,now);
      const run=(await tx.query<{state:string}>('SELECT state FROM workspace.runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[lease.projectId,lease.runId])).rows[0];
      if(receipt.scope!=='owned-cpu-resize-single-run'||receipt.ownedProcessStopped!==true||
        row.provider_request_id!==receipt.providerRequestId||!row.request_payload||contentHash(row.request_payload)!==row.request_hash||
        !isInterruptedWithoutOutput(receipt.history,receipt.providerRequestId,row.request_payload.prompt))throw Error('CANCELLATION_NOT_CONFIRMED');
      if(row.stage==='cancelled'&&run?.state==='cancelled'&&contentHash(row.response_payload)===contentHash(receipt.history))return;
      if(row.stage!=='submitted'||run?.state!=='cancel_requested'||!(await tx.query('SELECT run_id FROM workspace.run_cancellations WHERE project_id=$1 AND run_id=$2',[lease.projectId,lease.runId])).rows.length)throw Error('CANCELLATION_NOT_CONFIRMED');
      const updated=await tx.query("UPDATE workspace.run_attempts SET stage='cancelled',response_payload=$1 WHERE project_id=$2 AND id=$3 RETURNING id",[JSON.stringify(receipt.history),lease.projectId,lease.attemptId]);
      if(!updated.rows.length)throw Error('EXECUTION_PERMISSION_DENIED');
      await tx.query("UPDATE workspace.runs SET state='cancelled' WHERE project_id=$1 AND id=$2",[lease.projectId,lease.runId]);
    });
  }
  /** Called only after the private asset adapter has decoded and saved bytes. */
  async complete(lease:LocalExecutionLease,receipt:OutputReceipt,now=new Date()){
    return this.db.asActor(lease.actorId,async tx=>{
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.attemptId,lease.runId])).rows[0];
      this.checkLease(row,lease,now);
      return this.finishArtifact(tx,lease,receipt,row);
    });
  }
  private async finishArtifact(tx:Transaction,lease:Pick<LocalExecutionLease,'projectId'|'runId'|'attemptId'|'actorId'>,receipt:OutputReceipt,row:AttemptRow,archiveOnly=false,compilerSourceSha256=this.compilerSourceSha256){
      if(row.provider_request_id!==receipt.providerRequestId)throw Error('OUTPUT_RECEIPT_MISMATCH');
      const prior=(await tx.query<{asset_version_id:string;sha256:string}>('SELECT * FROM workspace.run_outputs WHERE project_id=$1 AND run_id=$2',[lease.projectId,lease.runId])).rows[0];
      if(prior){if(prior.asset_version_id!==receipt.assetId||prior.sha256!==receipt.sha256)throw Error('OUTPUT_RECEIPT_MISMATCH');return prior;}
      if(row.stage!=='returned'&&!(archiveOnly&&row.stage==='unknown'))throw Error('INVALID_ATTEMPT_STAGE');
      const run=(await tx.query<{state:string;payload:unknown;content_hash:string}>('SELECT r.state,s.payload,s.content_hash FROM workspace.runs r JOIN workspace.run_snapshots s ON s.project_id=r.project_id AND s.id=r.snapshot_id WHERE r.project_id=$1 AND r.id=$2 FOR UPDATE OF r',[lease.projectId,lease.runId])).rows[0];
      if(!run||run.state!=='archiving'||contentHash(run.payload)!==run.content_hash)throw Error('SNAPSHOT_INTEGRITY_FAILED');
      const snapshot=this.validateSnapshot(run.payload,lease.projectId,row.actor_id,compilerSourceSha256);
      const asset=(await tx.query<{sha256:string;state:string;width:number;height:number;mime:string}>('SELECT v.sha256,v.state,f.width,f.height,f.mime FROM workspace.asset_versions v JOIN workspace.asset_files f ON f.project_id=v.project_id AND f.id=v.id WHERE v.project_id=$1 AND v.id=$2',[lease.projectId,receipt.assetId])).rows[0];
      if(!asset||asset.state!=='ready'||asset.sha256!==receipt.sha256||asset.width!==snapshot.parameters.width||asset.height!==snapshot.parameters.height||asset.mime!=='image/png'||receipt.assetId===snapshot.asset.id)throw Error('OUTPUT_ASSET_NOT_READY');
      const cached=(await tx.query<{sha256:string;manifest:unknown;manifest_hash:string}>('SELECT sha256,manifest,manifest_hash FROM workspace.run_artifacts WHERE project_id=$1 AND run_id=$2',[lease.projectId,lease.runId])).rows[0];
      if(cached&&(cached.sha256!==receipt.sha256||contentHash(cached.manifest)!==cached.manifest_hash))throw Error('ARTIFACT_INTEGRITY_FAILED');
      // Append under the canvas revision lock; never replace the input or an
      // existing user object, and make concurrent editors reload on conflict.
      const canvas=(await tx.query<{revision:number}>('SELECT revision FROM workspace.canvases WHERE project_id=$1 FOR UPDATE',[lease.projectId])).rows[0];if(!canvas)throw Error('NOT_FOUND');
      const parents=(await tx.query<{payload:{deleted?:boolean}}>('SELECT r.payload FROM workspace.objects o JOIN workspace.object_revisions r ON r.project_id=o.project_id AND r.object_id=o.id AND r.revision=o.current_revision WHERE o.project_id=$1 AND o.id IN ($2,$3)',[lease.projectId,snapshot.source.id,snapshot.tool.id])).rows;
      const unplaced=parents.length!==2||parents.some(parent=>parent.payload.deleted===true);
      let objectId:string|null=null;
      if(!unplaced){
        const object=WorkspaceObjectSchema.parse({id:randomUUID(),projectId:lease.projectId,revision:1,type:'image',assetVersionId:receipt.assetId,title:'缩放结果',x:snapshot.tool.x+snapshot.tool.width+80,y:snapshot.tool.y,width:Math.min(asset.width,480),height:Math.min(asset.width,480)*asset.height/asset.width});objectId=object.id;
        await tx.query('INSERT INTO workspace.objects VALUES($1,$2,1)',[lease.projectId,object.id]);
        await tx.query('INSERT INTO workspace.object_revisions VALUES($1,$2,1,$3,$4,$5)',[lease.projectId,object.id,receipt.assetId,JSON.stringify(object),contentHash(object)]);
        await tx.query('UPDATE workspace.canvases SET revision=revision+1 WHERE project_id=$1',[lease.projectId]);
        await tx.query("INSERT INTO workspace.canvas_changes(project_id,revision,kind,object_id,object_revision,actor_id) VALUES($1,$2,'run_output',$3,1,$4)",[lease.projectId,Number(canvas.revision)+1,object.id,lease.actorId]);
      }
      const output=(await tx.query('INSERT INTO workspace.run_outputs(project_id,run_id,attempt_id,asset_version_id,object_id,object_revision,sha256) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[lease.projectId,lease.runId,lease.attemptId,receipt.assetId,objectId,objectId?1:null,receipt.sha256])).rows[0];
      if(unplaced)await this.archiveEvent(tx,lease,'result_unplaced');
      const updated=await tx.query("UPDATE workspace.run_attempts SET stage='completed' WHERE project_id=$1 AND id=$2 RETURNING id",[lease.projectId,lease.attemptId]);
      if(!updated.rows.length)throw Error('EXECUTION_PERMISSION_DENIED');
      await tx.query("UPDATE workspace.runs SET state='succeeded' WHERE project_id=$1 AND id=$2",[lease.projectId,lease.runId]);
      return output;
  }
  private async trustedArtifact(tx:Transaction,projectId:string,runId:string,row:AttemptRow){
    const artifact=(await tx.query<{manifest:unknown;manifest_hash:string;sha256:string;byte_size:number;payload:unknown;content_hash:string}>(`SELECT a.manifest,a.manifest_hash,a.sha256,a.byte_size,p.payload,p.content_hash FROM workspace.run_artifacts a JOIN workspace.run_preparations p ON p.project_id=a.project_id AND p.attempt_id=a.attempt_id AND p.run_id=a.run_id WHERE a.project_id=$1 AND a.run_id=$2 AND a.attempt_id=$3`,[projectId,runId,row.id])).rows[0];
    if(!artifact)throw Error('NO_VERIFIED_ARTIFACT');
    const manifest=WorkspaceArtifactManifestSchema.parse(artifact.manifest),evidence=WorkspaceRuntimeEvidenceSchema.parse(artifact.payload);
    if(contentHash(manifest)!==artifact.manifest_hash||contentHash(evidence)!==artifact.content_hash||manifest.runtimeEvidenceHash!==artifact.content_hash||
      manifest.projectId!==projectId||manifest.runId!==runId||manifest.attemptId!==row.id||manifest.sha256!==artifact.sha256||manifest.byteSize!==Number(artifact.byte_size)||
      manifest.providerRequestId!==row.provider_request_id||manifest.requestHash!==row.request_hash||!row.request_payload||contentHash(row.request_payload)!==row.request_hash||!matchesOwnedOutputHistory(manifest.history,manifest.providerRequestId,row.request_payload.prompt))throw Error('ARTIFACT_INTEGRITY_FAILED');
    const snapshot=(await tx.query<{payload:unknown;content_hash:string}>('SELECT s.payload,s.content_hash FROM workspace.runs r JOIN workspace.run_snapshots s ON s.project_id=r.project_id AND s.id=r.snapshot_id WHERE r.project_id=$1 AND r.id=$2',[projectId,runId])).rows[0];
    if(!snapshot||contentHash(snapshot.payload)!==snapshot.content_hash||snapshot.content_hash!==manifest.snapshotHash)throw Error('SNAPSHOT_INTEGRITY_FAILED');
    const parsed=this.validateSnapshot(snapshot.payload,projectId,row.actor_id,evidence.compilerSourceSha256);
    if(parsed.parameters.width!==manifest.width||parsed.parameters.height!==manifest.height)throw Error('OUTPUT_DIMENSIONS_MISMATCH');
    return {manifest,manifestHash:artifact.manifest_hash,compilerSourceSha256:evidence.compilerSourceSha256};
  }
  private async archiveEvent(tx:Transaction,lease:Pick<LocalArchiveLease,'projectId'|'runId'|'attemptId'|'actorId'>,stage:string){
    const sequence=(await tx.query<{event_sequence:number}>('UPDATE workspace.runs SET event_sequence=event_sequence+1 WHERE project_id=$1 AND id=$2 RETURNING event_sequence',[lease.projectId,lease.runId])).rows[0];
    if(!sequence)throw Error('EXECUTION_PERMISSION_DENIED');
    await tx.query('INSERT INTO workspace.run_events(project_id,run_id,sequence,actor_id,attempt_id,stage) VALUES($1,$2,$3,$4,$5,$6)',[lease.projectId,lease.runId,sequence.event_sequence,lease.actorId,lease.attemptId,stage]);
  }
  async claimArchive(actorId:string,projectId:string,runId:string,workerId:string,now=new Date()){
    return this.db.asActor(actorId,async tx=>{
      const visible=(await tx.query<{allowed:boolean}>('SELECT workspace.can_edit($1) AS allowed FROM workspace.runs WHERE project_id=$1 AND id=$2',[projectId,runId])).rows[0];
      if(!visible)throw Error('NOT_FOUND');if(!visible.allowed)throw Error('ACCESS_DENIED');
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND run_id=$2 FOR UPDATE',[projectId,runId])).rows[0];if(!row)throw Error('NO_VERIFIED_ARTIFACT');
      const run=(await tx.query<{state:string}>('SELECT state FROM workspace.runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,runId])).rows[0];if(!run)throw Error('NOT_FOUND');
      if(run.state==='succeeded'){const output=(await tx.query('SELECT asset_version_id,object_id,sha256 FROM workspace.run_outputs WHERE project_id=$1 AND run_id=$2',[projectId,runId])).rows[0];if(!output)throw Error('OUTPUT_RECEIPT_MISMATCH');return {alreadyDone:true as const,output};}
      if(!['unknown','archiving'].includes(run.state)||!['unknown','returned'].includes(row.stage))throw Error('ARCHIVE_NOT_RECOVERABLE');
      if(run.state==='archiving'&&new Date(row.lease_expires_at).getTime()>now.getTime())throw Error('ARCHIVE_BUSY');
      const prior=(await tx.query<ArchiveClaimRow>('SELECT * FROM workspace.run_archive_claims WHERE project_id=$1 AND run_id=$2 ORDER BY claim_order DESC LIMIT 1 FOR UPDATE',[projectId,runId])).rows[0];
      if(prior?.status==='claimed'&&new Date(prior.expires_at).getTime()>now.getTime())throw Error('ARCHIVE_BUSY');
      const artifact=await this.trustedArtifact(tx,projectId,runId,row);
      if(prior?.status==='claimed')await tx.query("UPDATE workspace.run_archive_claims SET status='failed' WHERE project_id=$1 AND id=$2",[projectId,prior.id]);
      const recoveryId=randomUUID(),token=randomBytes(32).toString('base64url'),lease={projectId,runId,attemptId:row.id,actorId,workerId,recoveryId,token};
      await tx.query("INSERT INTO workspace.run_archive_claims(project_id,id,run_id,attempt_id,actor_id,worker_id,token_hash,expires_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'claimed')",[projectId,recoveryId,runId,row.id,actorId,workerId,hash(token),new Date(now.getTime()+60_000).toISOString()]);
      // Fence the original execution lease without changing its immutable token.
      await tx.query('UPDATE workspace.run_attempts SET lease_expires_at=$1,execution_fenced=true WHERE project_id=$2 AND id=$3',[now.toISOString(),projectId,row.id]);
      await tx.query("UPDATE workspace.runs SET state='archiving' WHERE project_id=$1 AND id=$2",[projectId,runId]);
      await this.archiveEvent(tx,lease,'archive_recovery_started');return {alreadyDone:false as const,lease,artifact};
    });
  }
  private checkArchive(row:ArchiveClaimRow|undefined,lease:LocalArchiveLease,now:Date){
    if(!row||row.actor_id!==lease.actorId||row.worker_id!==lease.workerId||row.attempt_id!==lease.attemptId||row.token_hash!==hash(lease.token)||row.status!=='claimed'||new Date(row.expires_at).getTime()<=now.getTime())throw Error('ARCHIVE_LEASE_INVALID');
  }
  async completeArchive(lease:LocalArchiveLease,receipt:OutputReceipt,now=new Date()){
    return this.db.asActor(lease.actorId,async tx=>{
      const attempt=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.attemptId,lease.runId])).rows[0];if(!attempt)throw Error('NOT_FOUND');
      await tx.query('SELECT id FROM workspace.runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[lease.projectId,lease.runId]);
      const claim=(await tx.query<ArchiveClaimRow>('SELECT * FROM workspace.run_archive_claims WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.recoveryId,lease.runId])).rows[0];this.checkArchive(claim,lease,now);
      const artifact=await this.trustedArtifact(tx,lease.projectId,lease.runId,attempt);if(receipt.sha256!==artifact.manifest.sha256||receipt.providerRequestId!==artifact.manifest.providerRequestId)throw Error('OUTPUT_RECEIPT_MISMATCH');
      const result=await this.finishArtifact(tx,lease,receipt,attempt,true,artifact.compilerSourceSha256);
      await tx.query("UPDATE workspace.run_archive_claims SET status='completed' WHERE project_id=$1 AND id=$2",[lease.projectId,lease.recoveryId]);return result;
    });
  }
  async failArchive(lease:LocalArchiveLease,now=new Date()){
    await this.db.asActor(lease.actorId,async tx=>{
      const attempt=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.attemptId,lease.runId])).rows[0];if(!attempt)throw Error('NOT_FOUND');
      await tx.query('SELECT id FROM workspace.runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[lease.projectId,lease.runId]);
      const claim=(await tx.query<ArchiveClaimRow>('SELECT * FROM workspace.run_archive_claims WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.recoveryId,lease.runId])).rows[0];this.checkArchive(claim,lease,now);
      await tx.query("UPDATE workspace.run_archive_claims SET status='failed' WHERE project_id=$1 AND id=$2",[lease.projectId,lease.recoveryId]);
      if(attempt.stage==='returned')await tx.query("UPDATE workspace.run_attempts SET stage='unknown' WHERE project_id=$1 AND id=$2",[lease.projectId,lease.attemptId]);
      await tx.query("UPDATE workspace.runs SET state='unknown' WHERE project_id=$1 AND id=$2",[lease.projectId,lease.runId]);await this.archiveEvent(tx,lease,'archive_recovery_failed');
    });
  }
  async recoverExpired(actorId:string,projectId:string,runId:string,now=new Date()){
    return this.db.asActor(actorId,async tx=>{
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND run_id=$2 FOR UPDATE',[projectId,runId])).rows[0];
      if(!row)throw Error('NOT_FOUND');if(new Date(row.lease_expires_at).getTime()>now.getTime()||['completed','unknown','failed','cancelled'].includes(row.stage))return {changed:false};
      if((await tx.query("SELECT id FROM workspace.run_archive_claims WHERE project_id=$1 AND run_id=$2 AND status='claimed' AND expires_at>$3",[projectId,runId,now.toISOString()])).rows.length)return {changed:false};
      // No automatic retry: even a zero-cost resize may have produced an artifact.
      const run=(await tx.query<{state:string}>('SELECT state FROM workspace.runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,runId])).rows[0];
      const state=row.stage==='claimed'?(run?.state==='cancel_requested'?'cancelled':'failed'):'unknown';
      const updated=await tx.query('UPDATE workspace.run_attempts SET stage=$1 WHERE project_id=$2 AND id=$3 RETURNING id',[state,projectId,row.id]);
      if(!updated.rows.length)throw Error('EXECUTION_PERMISSION_DENIED');
      await tx.query('UPDATE workspace.runs SET state=$1 WHERE project_id=$2 AND id=$3',[state,projectId,runId]);
      return {changed:true,state};
    });
  }
}
