import type {Transaction} from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { WorkspaceParametersSchema, WorkspaceWorkflowSchema, WorkspaceTemplateSchema, WorkspaceObjectSchema, WorkspaceBindingRequestSchema } from '@canvas/contracts';
import { LocalWorkspaceDatabase } from './localWorkspaceDatabase.ts';
import {WorkspaceModelGateway} from './workspaceModelGateway.ts';
import { contentHash,validateWorkflow } from './workspacePrototype.ts';

/** Only explicitly requested, zero-provider-cost local resize is supported. */
export class LocalBoundRuns {
  constructor(private db:LocalWorkspaceDatabase,private compilerSourceSha256:string|null=null,private gateway=new WorkspaceModelGateway({compilerConfigured:compilerSourceSha256!==null,localResizeExecutor:false})){
    if(compilerSourceSha256!==null&&!/^[a-f0-9]{64}$/.test(compilerSourceSha256))throw Error('INVALID_COMPILER_PIN');
  }
  async create(actorId:string,projectId:string,bindingId:string,input:unknown,key:string){
    return this.db.asActor(actorId,tx=>this.createInTransaction(tx,actorId,projectId,bindingId,input,key));
  }
  /** Internal server port: caller owns the transaction, including any future
   * one-time action consumption. No commit, nested transaction or client scope.
   * Review-only records are not an execution authority accepted by this port. */
  async createInTransaction(tx:Transaction,actorId:string,projectId:string,bindingId:string,input:unknown,key:string){
    if(this.compilerSourceSha256===null)throw Error('COMPILER_NOT_CONFIGURED');
    const parameters=WorkspaceParametersSchema.parse(input),modelCapability=this.gateway.resizeSnapshot(input);
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(key))throw Error('INVALID_IDEMPOTENCY_KEY');
    const requestHash=contentHash({bindingId,parameters,policy:'local-resize-only-v1'});
    const principal=(await tx.query<{actor:string;allowed:boolean}>('SELECT workspace.actor_id()::text AS actor,workspace.can_edit(project_id) AS allowed FROM workspace.canvases WHERE project_id=$1',[projectId])).rows[0];
    if(!principal)throw Error('NOT_FOUND');
    if(principal.actor.toLowerCase()!==actorId.toLowerCase())throw Error('EXECUTION_AUTHORITY_MISMATCH');
    if(!principal.allowed)throw Error('ACCESS_DENIED');
      // Serialize creation and deduplication with the same budget lock as the
      // existing run kernel. Snapshot/run/reservation/outbox commit together.
      if(!(await tx.query('SELECT project_id FROM workspace.budgets WHERE project_id=$1 FOR UPDATE',[projectId])).rows.length)throw Error('NOT_FOUND');
      const previous=(await tx.query<{id:string;request_hash:string}>('SELECT id,request_hash FROM workspace.runs WHERE project_id=$1 AND idempotency_key=$2',[projectId,key])).rows[0];
      if(previous){if(previous.request_hash!==requestHash)throw Error('IDEMPOTENCY_CONFLICT');return {id:previous.id,reused:true};}
      const row=(await tx.query<{payload:Record<string,unknown>}>('SELECT payload FROM workspace.bindings WHERE project_id=$1 AND id=$2',[projectId,bindingId])).rows[0];
      if(!row)throw Error('NOT_FOUND');
      const p=row.payload;
      const binding=WorkspaceBindingRequestSchema.parse(Object.fromEntries(['id','projectId','taskLineId','sourceObjectId','sourceObjectRevision','toolObjectId','toolObjectRevision','templateVersionId'].map(k=>[k,p[k]])));
      if(binding.id!==bindingId||binding.projectId!==projectId)throw Error('BINDING_INTEGRITY_FAILED');
      const t=(await tx.query<{payload:unknown;content_hash:string;workflow_version_id:string}>('SELECT payload,content_hash,workflow_version_id FROM workspace.template_versions WHERE project_id=$1 AND id=$2',[projectId,binding.templateVersionId])).rows[0];
      if(!t)throw Error('NOT_FOUND');
      const template=WorkspaceTemplateSchema.parse(t.payload);
      if(contentHash(template)!==t.content_hash||p.templateHash!==t.content_hash||template.workflowVersionId!==t.workflow_version_id||p.workflowVersionId!==t.workflow_version_id)throw Error('VERSION_INTEGRITY_FAILED');
      const w=(await tx.query<{payload:unknown;content_hash:string}>('SELECT payload,content_hash FROM workspace.workflow_versions WHERE project_id=$1 AND id=$2',[projectId,t.workflow_version_id])).rows[0];
      if(!w)throw Error('NOT_FOUND');
      const workflow=WorkspaceWorkflowSchema.parse(w.payload);validateWorkflow(workflow);
      if(contentHash(workflow)!==w.content_hash)throw Error('VERSION_INTEGRITY_FAILED');
      const revision=async(id:string,number:number)=>{
        const r=(await tx.query<{payload:unknown;content_hash:string}>('SELECT payload,content_hash FROM workspace.object_revisions WHERE project_id=$1 AND object_id=$2 AND revision=$3',[projectId,id,number])).rows[0];
        if(!r)throw Error('NOT_FOUND');const object=WorkspaceObjectSchema.parse(r.payload);
        if(contentHash(object)!==r.content_hash||object.id!==id||object.revision!==number||object.projectId!==projectId)throw Error('OBJECT_INTEGRITY_FAILED');return object;
      };
      const source=await revision(binding.sourceObjectId,binding.sourceObjectRevision),tool=await revision(binding.toolObjectId,binding.toolObjectRevision);
      if(source.type!=='image'||tool.type!=='tool'||tool.templateVersionId!==template.id||contentHash(source)!==contentHash(p.source)||contentHash(tool)!==contentHash(p.tool))throw Error('BINDING_INTEGRITY_FAILED');
      const asset=(await tx.query<{sha256:string;state:string}>('SELECT sha256,state FROM workspace.asset_versions WHERE project_id=$1 AND id=$2',[projectId,source.assetVersionId])).rows[0];
      if(!asset||asset.state!=='ready'||asset.sha256!==p.assetSha256||source.assetVersionId!==p.assetVersionId)throw Error('ASSET_INTEGRITY_FAILED');
      const snapshot={schemaVersion:2,modelCapability,binding,workflow,workflowHash:w.content_hash,template,templateHash:t.content_hash,source,tool,
        asset:{id:source.assetVersionId,sha256:asset.sha256},parameters,
        compiler:{version:'2.15.2',sourceSha256:this.compilerSourceSha256,registryValidation:'required-before-worker-execution'},
        authorization:{actorId,scope:'local-resize-only-v1',providerCost:'0',currency:'USD'}};
      const id=randomUUID(),snapshotId=randomUUID();
      await tx.query('INSERT INTO workspace.run_snapshots VALUES($1,$2,$3,$4)',[projectId,snapshotId,JSON.stringify(snapshot),contentHash(snapshot)]);
      await tx.query("INSERT INTO workspace.runs(project_id,id,snapshot_id,state,idempotency_key,request_hash,reserved_amount) VALUES($1,$2,$3,'queued',$4,$5,0)",[projectId,id,snapshotId,key,requestHash]);
      await tx.query("INSERT INTO workspace.outbox(project_id,id,run_id,event_type,payload) VALUES($1,$2,$3,'run.created',$4)",[projectId,randomUUID(),id,JSON.stringify({runId:id,actorId})]);
      return {id,reused:false};
  }
  async read(actorId:string,projectId:string,id:string){
    return this.db.asActor(actorId,async tx=>{
      const r=(await tx.query<{id:string;state:string;event_sequence:number;payload:unknown;content_hash:string}>('SELECT r.id,r.state,r.event_sequence,s.payload,s.content_hash FROM workspace.runs r JOIN workspace.run_snapshots s ON s.project_id=r.project_id AND s.id=r.snapshot_id WHERE r.project_id=$1 AND r.id=$2',[projectId,id])).rows[0];
      if(!r)throw Error('NOT_FOUND');if(contentHash(r.payload)!==r.content_hash)throw Error('SNAPSHOT_INTEGRITY_FAILED');
      const output=(await tx.query('SELECT asset_version_id,object_id,object_revision,sha256,unplaced FROM workspace.current_run_outputs WHERE project_id=$1 AND run_id=$2',[projectId,id])).rows[0]??null;
      const cancellation=(await tx.query('SELECT requested_by,reason,created_at FROM workspace.run_cancellations WHERE project_id=$1 AND run_id=$2',[projectId,id])).rows[0]??null;
      const a=(await tx.query<{stage:string;provider_request_id:string|null}>('SELECT stage,provider_request_id FROM workspace.run_attempts WHERE project_id=$1 AND run_id=$2',[projectId,id])).rows[0];
      const attempt=a?{stage:a.stage,providerRequestId:a.provider_request_id}:null;
      const archiveRecoveryAvailable=['unknown','archiving'].includes(r.state)&&(await tx.query<{available:boolean}>("SELECT workspace.can_edit($1) AND EXISTS(SELECT 1 FROM workspace.run_artifacts WHERE project_id=$1 AND run_id=$2) AS available",[projectId,id])).rows[0].available;
      const canPlaceOutput=!!output&&(await tx.query<{allowed:boolean}>('SELECT workspace.can_edit($1) AS allowed',[projectId])).rows[0].allowed;
      return {canPlaceOutput,id:r.id,state:r.state,eventSequence:Number(r.event_sequence),snapshot:r.payload,snapshotHash:r.content_hash,output,cancellation,attempt,archiveRecoveryAvailable};
    });
  }
  async cancel(actorId:string,projectId:string,id:string,reason:string){
    if(typeof reason!=='string'||reason.length>500)throw Error('INVALID_BODY');
    return this.db.asActor(actorId,async tx=>{
      const visible=(await tx.query<{allowed:boolean}>('SELECT workspace.can_edit($1) AS allowed FROM workspace.runs WHERE project_id=$1 AND id=$2',[projectId,id])).rows[0];
      if(!visible)throw Error('NOT_FOUND');if(!visible.allowed)throw Error('ACCESS_DENIED');
      const run=(await tx.query<{state:string}>('SELECT state FROM workspace.runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,id])).rows[0];
      if(!run)throw Error('NOT_FOUND');
      if(!(await tx.query<{allowed:boolean}>('SELECT workspace.can_edit($1) AS allowed',[projectId])).rows[0].allowed)throw Error('ACCESS_DENIED');
      const prior=(await tx.query('SELECT run_id FROM workspace.run_cancellations WHERE project_id=$1 AND run_id=$2',[projectId,id])).rows[0];
      if(prior)return {state:run.state,requested:true,reused:true};
      if(['succeeded','failed','cancelled','unknown'].includes(run.state))return {state:run.state,requested:false,reused:false};
      const state=run.state==='queued'?'cancelled':run.state==='running'?'cancel_requested':run.state;
      const changed=(await tx.query<{event_sequence:number}>('UPDATE workspace.runs SET state=$1,event_sequence=event_sequence+1 WHERE project_id=$2 AND id=$3 RETURNING event_sequence',[state,projectId,id])).rows[0];
      if(!changed)throw Error('ACCESS_DENIED');
      await tx.query('INSERT INTO workspace.run_cancellations(project_id,run_id,requested_by,reason) VALUES($1,$2,$3,$4)',[projectId,id,actorId,reason]);
      await tx.query('INSERT INTO workspace.run_events(project_id,run_id,sequence,actor_id,attempt_id,stage) VALUES($1,$2,$3,$4,NULL,$5)',[projectId,id,changed.event_sequence,actorId,state==='cancelled'?'cancelled':'cancel_requested']);
      if(state==='cancelled')await tx.query("UPDATE workspace.outbox SET dispatched_at=now() WHERE project_id=$1 AND run_id=$2 AND dispatched_at IS NULL",[projectId,id]);
      return {state,requested:true,reused:false};
    });
  }
}
