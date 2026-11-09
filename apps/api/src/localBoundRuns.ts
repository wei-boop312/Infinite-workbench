import { randomUUID } from 'node:crypto';
import { WorkspaceParametersSchema, WorkspaceWorkflowSchema, WorkspaceTemplateSchema, WorkspaceObjectSchema, WorkspaceBindingRequestSchema } from '@canvas/contracts';
import { LocalWorkspaceDatabase } from './localWorkspaceDatabase.ts';
import { contentHash,validateWorkflow } from './workspacePrototype.ts';

/** Only explicitly requested, zero-provider-cost local resize is supported. */
export class LocalBoundRuns {
  constructor(private db:LocalWorkspaceDatabase,private compilerSourceSha256:string|null=null){
    if(compilerSourceSha256!==null&&!/^[a-f0-9]{64}$/.test(compilerSourceSha256))throw Error('INVALID_COMPILER_PIN');
  }
  async create(actorId:string,projectId:string,bindingId:string,input:unknown,key:string){
    if(this.compilerSourceSha256===null)throw Error('COMPILER_NOT_CONFIGURED');
    const parameters=WorkspaceParametersSchema.parse(input);
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(key))throw Error('INVALID_IDEMPOTENCY_KEY');
    const requestHash=contentHash({bindingId,parameters,policy:'local-resize-only-v1'});
    return this.db.asActor(actorId,async tx=>{
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
      const snapshot={schemaVersion:1,binding,workflow,workflowHash:w.content_hash,template,templateHash:t.content_hash,source,tool,
        asset:{id:source.assetVersionId,sha256:asset.sha256},parameters,
        compiler:{version:'2.15.2',sourceSha256:this.compilerSourceSha256,registryValidation:'required-before-worker-execution'},
        authorization:{actorId,scope:'local-resize-only-v1',providerCost:'0',currency:'USD'}};
      const id=randomUUID(),snapshotId=randomUUID();
      await tx.query('INSERT INTO workspace.run_snapshots VALUES($1,$2,$3,$4)',[projectId,snapshotId,JSON.stringify(snapshot),contentHash(snapshot)]);
      await tx.query("INSERT INTO workspace.runs(project_id,id,snapshot_id,state,idempotency_key,request_hash,reserved_amount) VALUES($1,$2,$3,'queued',$4,$5,0)",[projectId,id,snapshotId,key,requestHash]);
      await tx.query("INSERT INTO workspace.outbox(project_id,id,run_id,event_type,payload) VALUES($1,$2,$3,'run.created',$4)",[projectId,randomUUID(),id,JSON.stringify({runId:id,actorId})]);
      return {id,reused:false};
    });
  }
  async read(actorId:string,projectId:string,id:string){
    return this.db.asActor(actorId,async tx=>{
      const r=(await tx.query<{id:string;state:string;payload:unknown;content_hash:string}>('SELECT r.id,r.state,s.payload,s.content_hash FROM workspace.runs r JOIN workspace.run_snapshots s ON s.project_id=r.project_id AND s.id=r.snapshot_id WHERE r.project_id=$1 AND r.id=$2',[projectId,id])).rows[0];
      if(!r)throw Error('NOT_FOUND');if(contentHash(r.payload)!==r.content_hash)throw Error('SNAPSHOT_INTEGRITY_FAILED');
      return {id:r.id,state:r.state,snapshot:r.payload,snapshotHash:r.content_hash};
    });
  }
}
