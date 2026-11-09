import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { WorkspaceWorkflowSchema,WorkspaceTemplateSchema,WorkspaceObjectSchema,WorkspaceBindingRequestSchema,WorkspaceParametersSchema } from '@canvas/contracts';
import { LocalWorkspaceDatabase } from './localWorkspaceDatabase.ts';
import { contentHash,validateWorkflow } from './workspacePrototype.ts';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export type LocalExecutionLease={projectId:string;runId:string;attemptId:string;actorId:string;workerId:string;token:string};
type AttemptRow={id:string;actor_id:string;worker_id:string;token_hash:string;lease_expires_at:Date;stage:string;request_hash:string|null;provider_request_id:string|null;response_payload:unknown};

/** Internal worker port, never accepts an actor or lease from public HTTP. */
export class LocalRunExecution {
  constructor(private db:LocalWorkspaceDatabase,private compilerSourceSha256:string){}
  private validateSnapshot(raw:unknown,projectId:string,actorId:string){
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
      snapshot.compiler?.version!=='2.15.2'||snapshot.compiler?.sourceSha256!==this.compilerSourceSha256||snapshot.compiler?.registryValidation!=='required-before-worker-execution')throw Error('SNAPSHOT_INTEGRITY_FAILED');
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
      return {lease:{projectId,runId,attemptId,actorId,workerId,token},snapshot,snapshotHash:run.content_hash};
    });
  }
  async beforeSubmit(lease:LocalExecutionLease,request:unknown,now=new Date()){
    const requestHash=contentHash(request);
    await this.db.asActor(lease.actorId,async tx=>{
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.attemptId,lease.runId])).rows[0];
      this.checkLease(row,lease,now);
      if(row.stage!=='claimed')throw Error('ALREADY_SUBMITTED');
      // Persist the exact outbound request before allowing one external POST.
      const updated=await tx.query("UPDATE workspace.run_attempts SET stage='submitted',request_payload=$1,request_hash=$2 WHERE project_id=$3 AND id=$4 RETURNING id",[JSON.stringify(request),requestHash,lease.projectId,lease.attemptId]);
      if(!updated.rows.length)throw Error('EXECUTION_PERMISSION_DENIED');
    });
    return {requestHash};
  }
  private checkLease(row:AttemptRow|undefined,lease:LocalExecutionLease,now:Date){
    if(!row||row.actor_id!==lease.actorId||row.worker_id!==lease.workerId||row.token_hash!==hash(lease.token)||new Date(row.lease_expires_at).getTime()<=now.getTime())throw Error('EXECUTION_LEASE_INVALID');
  }
  async recordResponse(lease:LocalExecutionLease,providerRequestId:string,response:unknown,now=new Date()){
    if(!/^[a-zA-Z0-9_-]{1,160}$/.test(providerRequestId))throw Error('INVALID_PROVIDER_REQUEST_ID');
    await this.db.asActor(lease.actorId,async tx=>{
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND id=$2 AND run_id=$3 FOR UPDATE',[lease.projectId,lease.attemptId,lease.runId])).rows[0];this.checkLease(row,lease,now);
      if(row.stage!=='submitted')throw Error('INVALID_ATTEMPT_STAGE');
      const updated=await tx.query("UPDATE workspace.run_attempts SET stage='returned',provider_request_id=$1,response_payload=$2 WHERE project_id=$3 AND id=$4 RETURNING id",[providerRequestId,JSON.stringify(response),lease.projectId,lease.attemptId]);
      if(!updated.rows.length)throw Error('EXECUTION_PERMISSION_DENIED');
      await tx.query("UPDATE workspace.runs SET state='archiving' WHERE project_id=$1 AND id=$2 AND state='running'",[lease.projectId,lease.runId]);
    });
  }
  async recoverExpired(actorId:string,projectId:string,runId:string,now=new Date()){
    return this.db.asActor(actorId,async tx=>{
      const row=(await tx.query<AttemptRow>('SELECT * FROM workspace.run_attempts WHERE project_id=$1 AND run_id=$2 FOR UPDATE',[projectId,runId])).rows[0];
      if(!row)throw Error('NOT_FOUND');if(new Date(row.lease_expires_at).getTime()>now.getTime()||['completed','unknown','failed'].includes(row.stage))return {changed:false};
      // No automatic retry: even a zero-cost resize may have produced an artifact.
      const state=row.stage==='claimed'?'failed':'unknown';
      const updated=await tx.query('UPDATE workspace.run_attempts SET stage=$1 WHERE project_id=$2 AND id=$3 RETURNING id',[state,projectId,row.id]);
      if(!updated.rows.length)throw Error('EXECUTION_PERMISSION_DENIED');
      await tx.query('UPDATE workspace.runs SET state=$1 WHERE project_id=$2 AND id=$3',[state,projectId,runId]);
      return {changed:true,state};
    });
  }
}
