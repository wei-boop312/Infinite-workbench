import { WorkspaceWorkflowSchema, WorkspaceTemplateSchema, WorkspaceBindingRequestSchema, WorkspaceObjectSchema } from '@canvas/contracts';
import { LocalWorkspaceDatabase } from './localWorkspaceDatabase.ts';
import { contentHash, validateWorkflow } from './workspacePrototype.ts';

/** Immutable version repository; callers supply an authenticated server actor. */
export class LocalWorkflowVersions {
  constructor(private db: LocalWorkspaceDatabase) {}
  async bind(actorId:string,projectId:string,input:unknown){
    const request=WorkspaceBindingRequestSchema.parse(input);
    if(request.projectId!==projectId)throw Error('NOT_FOUND');
    return this.db.asActor(actorId,async tx=>{
      const version=(await tx.query<{payload:unknown;workflow_version_id:string;content_hash:string}>(
        'SELECT payload,workflow_version_id,content_hash FROM workspace.template_versions WHERE project_id=$1 AND id=$2',[projectId,request.templateVersionId])).rows[0];
      if(!version)throw Error('NOT_FOUND');
      const template=WorkspaceTemplateSchema.parse(version.payload);
      if(contentHash(template)!==version.content_hash)throw Error('VERSION_INTEGRITY_FAILED');
      const revision=async(id:string,number:number)=>{
        const row=(await tx.query<{payload:unknown}>('SELECT payload FROM workspace.object_revisions WHERE project_id=$1 AND object_id=$2 AND revision=$3',[projectId,id,number])).rows[0];
        if(!row)throw Error('NOT_FOUND');return WorkspaceObjectSchema.parse(row.payload);
      };
      const source=await revision(request.sourceObjectId,request.sourceObjectRevision);
      const tool=await revision(request.toolObjectId,request.toolObjectRevision);
      if(source.type!=='image'||tool.type!=='tool'||tool.templateVersionId!==template.id)throw Error('INVALID_BINDING');
      const asset=(await tx.query<{sha256:string;state:string}>('SELECT sha256,state FROM workspace.asset_versions WHERE project_id=$1 AND id=$2',[projectId,source.assetVersionId])).rows[0];
      if(!asset||asset.state!=='ready')throw Error('NOT_FOUND');
      const payload={...request,workflowVersionId:version.workflow_version_id,source,tool,assetVersionId:source.assetVersionId,assetSha256:asset.sha256,templateHash:version.content_hash};
      await tx.query('INSERT INTO workspace.bindings(project_id,id,template_version_id,object_id,object_revision,payload) VALUES($1,$2,$3,$4,$5,$6)',
        [projectId,request.id,template.id,source.id,source.revision,JSON.stringify(payload)]);
      return payload;
    });
  }
  async references(actorId:string,projectId:string,objectId:string){
    return this.db.asActor(actorId,async tx=>{
      const object=await tx.query('SELECT id FROM workspace.objects WHERE project_id=$1 AND id=$2',[projectId,objectId]);
      if(!object.rows.length)throw Error('NOT_FOUND');
      return (await tx.query<{payload:Record<string,unknown>;input_changed:boolean}>(
        "SELECT b.payload,(o.current_revision<>b.object_revision) AS input_changed FROM workspace.bindings b JOIN workspace.objects o ON o.project_id=b.project_id AND o.id=b.object_id WHERE b.project_id=$1 AND (b.object_id=$2 OR b.payload->>'toolObjectId'=$2::text)",[projectId,objectId])).rows;
    });
  }
  async publishWorkflow(actorId: string, projectId: string, input: unknown) {
    const graph = WorkspaceWorkflowSchema.parse(input);
    if (graph.projectId !== projectId) throw Error('NOT_FOUND');
    validateWorkflow(graph);
    const hash = contentHash(graph);
    await this.db.asActor(actorId, tx => tx.query(
      'INSERT INTO workspace.workflow_versions(project_id,id,workflow_id,version,payload,content_hash) VALUES($1,$2,$3,$4,$5,$6)',
      [projectId,graph.id,graph.workflowId,graph.version,JSON.stringify(graph),hash]));
    return {id:graph.id,contentHash:hash};
  }
  async publishTemplate(actorId: string, projectId: string, input: unknown) {
    const template = WorkspaceTemplateSchema.parse(input);
    if(template.projectId !== projectId) throw Error('NOT_FOUND');
    const hash = contentHash(template);
    await this.db.asActor(actorId, async tx => {
      // Verify readability too: FK integrity alone does not establish permission.
      const graph = await tx.query('SELECT id FROM workspace.workflow_versions WHERE project_id=$1 AND id=$2',[projectId,template.workflowVersionId]);
      if(!graph.rows.length) throw Error('NOT_FOUND');
      await tx.query('INSERT INTO workspace.template_versions(project_id,id,template_id,workflow_version_id,version,payload,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [projectId,template.id,template.templateId,template.workflowVersionId,template.version,JSON.stringify(template),hash]);
    });
    return {id:template.id,contentHash:hash};
  }
  async readWorkflow(actorId:string,projectId:string,id:string) {
    const row=(await this.db.asActor(actorId,tx=>tx.query<{payload:unknown;content_hash:string}>('SELECT payload,content_hash FROM workspace.workflow_versions WHERE project_id=$1 AND id=$2',[projectId,id]))).rows[0];
    if(!row)throw Error('NOT_FOUND');
    const graph=WorkspaceWorkflowSchema.parse(row.payload);
    if(contentHash(graph)!==row.content_hash)throw Error('VERSION_INTEGRITY_FAILED');
    return graph;
  }
}
