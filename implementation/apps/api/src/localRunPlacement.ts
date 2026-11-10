import {createHash,randomUUID} from 'node:crypto';
import {WorkspaceObjectSchema,WorkspaceResultPlacementSchema,type WorkspaceObject} from '@canvas/contracts';
import type {Transaction} from '@electric-sql/pglite';
import {LocalWorkspaceDatabase} from './localWorkspaceDatabase.ts';
import {LocalWorkspaceAssets} from './localWorkspaceAssets.ts';
import {contentHash} from './workspacePrototype.ts';
type Result={revision:number;objectId:string;assetVersionId:string;object:WorkspaceObject;alreadyPlaced:boolean};
type RequestRow={run_id:string;actor_id:string;request_hash:string;result:Result};
/** Placement only: no runtime, compiler, provider URL or generation port. */
export class LocalRunPlacement {
  constructor(private db:LocalWorkspaceDatabase,private assets:LocalWorkspaceAssets){}
  private async permission(tx:Transaction,projectId:string){
    const visible=(await tx.query<{allowed:boolean}>('SELECT workspace.can_edit(id) AS allowed FROM workspace.projects WHERE id=$1 AND deleted_at IS NULL',[projectId])).rows[0];
    if(!visible)throw Error('NOT_FOUND');if(!visible.allowed)throw Error('ACCESS_DENIED');
  }
  private async receipt(tx:Transaction,actorId:string,projectId:string,runId:string,id:string,requestHash:string){
    const prior=(await tx.query<RequestRow>('SELECT run_id,actor_id,request_hash,result FROM workspace.run_placement_requests WHERE project_id=$1 AND id=$2',[projectId,id])).rows[0];
    if(prior&&(prior.run_id!==runId||prior.actor_id!==actorId||prior.request_hash!==requestHash))throw Error('IDEMPOTENCY_CONFLICT');return prior?.result;
  }
  async place(actorId:string,projectId:string,runId:string,raw:unknown,lease:{token:string;fencing:number},now=new Date()){
    const input=WorkspaceResultPlacementSchema.parse(raw),requestHash=contentHash({runId,...input});
    const read=await this.db.asActor(actorId,async tx=>{
      await this.permission(tx,projectId);const prior=await this.receipt(tx,actorId,projectId,runId,input.id,requestHash);if(prior)return {prior};
      const row=(await tx.query<{state:string;asset_version_id:string|null;sha256:string|null;payload:unknown;content_hash:string}>('SELECT r.state,o.asset_version_id,o.sha256,s.payload,s.content_hash FROM workspace.runs r JOIN workspace.run_snapshots s ON s.project_id=r.project_id AND s.id=r.snapshot_id LEFT JOIN workspace.run_outputs o ON o.project_id=r.project_id AND o.run_id=r.id WHERE r.project_id=$1 AND r.id=$2',[projectId,runId])).rows[0];
      if(!row)throw Error('NOT_FOUND');if(row.state!=='succeeded'||!row.asset_version_id||!row.sha256)throw Error('RESULT_NOT_READY');
      if(contentHash(row.payload)!==row.content_hash)throw Error('SNAPSHOT_INTEGRITY_FAILED');return {output:{assetId:row.asset_version_id,sha256:row.sha256}};
    });
    if(read.prior)return {...read.prior,reused:true};
    // Re-read private immutable bytes under current authorization before any edit.
    const downloaded=await this.assets.download(actorId,projectId,read.output!.assetId);
    if(downloaded.asset.sha256!==read.output!.sha256||downloaded.asset.mime!=='image/png')throw Error('OUTPUT_ASSET_NOT_READY');
    return this.db.asActor(actorId,async tx=>{
      await this.permission(tx,projectId);
      // All user placements serialize on the canvas. An in-flight worker is
      // excluded by the committed succeeded receipt checked above.
      const canvas=(await tx.query<{revision:number}>('SELECT revision FROM workspace.canvases WHERE project_id=$1 FOR UPDATE',[projectId])).rows[0];if(!canvas)throw Error('NOT_FOUND');
      const prior=await this.receipt(tx,actorId,projectId,runId,input.id,requestHash);if(prior)return {...prior,reused:true};
      const current=(await tx.query<{holder_id:string;token_hash:string;fencing_token:number;expires_at:Date}>('SELECT * FROM workspace.edit_leases WHERE project_id=$1 FOR UPDATE',[projectId])).rows[0];
      if(!current||current.holder_id!==actorId||current.token_hash!==createHash('sha256').update(lease.token).digest('hex')||Number(current.fencing_token)!==lease.fencing||new Date(current.expires_at).getTime()<=now.getTime())throw Error('LEASE_CONFLICT');
      const output=(await tx.query<{asset_version_id:string;object_id:string|null;sha256:string}>('SELECT asset_version_id,object_id,sha256 FROM workspace.current_run_outputs WHERE project_id=$1 AND run_id=$2',[projectId,runId])).rows[0];
      if(!output||output.asset_version_id!==downloaded.asset.id||output.sha256!==downloaded.asset.sha256)throw Error('OUTPUT_RECEIPT_MISMATCH');
      let result:Result;
      if(output.object_id){
        const live=(await tx.query<{payload:unknown;content_hash:string}>('SELECT r.payload,r.content_hash FROM workspace.objects o JOIN workspace.object_revisions r ON r.project_id=o.project_id AND r.object_id=o.id AND r.revision=o.current_revision WHERE o.project_id=$1 AND o.id=$2',[projectId,output.object_id])).rows[0];
        if(!live||contentHash(live.payload)!==live.content_hash)throw Error('OBJECT_INTEGRITY_FAILED');
        result={revision:Number(canvas.revision),objectId:output.object_id,assetVersionId:output.asset_version_id,object:WorkspaceObjectSchema.parse(live.payload),alreadyPlaced:true};
      }else{
        const start=Number(canvas.revision);
        if(start!==input.baseRevision){const changes=(await tx.query<{count:string;only_outputs:boolean}>("SELECT count(*)::text AS count,bool_and(kind='run_output') AS only_outputs FROM workspace.canvas_changes WHERE project_id=$1 AND revision>$2 AND revision<=$3",[projectId,input.baseRevision,start])).rows[0];if(Number(changes.count)!==start-input.baseRevision||changes.only_outputs!==true)throw Error('REVISION_CONFLICT');}
        const object=WorkspaceObjectSchema.parse({id:randomUUID(),projectId,revision:1,type:'image',title:'缩放结果',assetVersionId:output.asset_version_id,x:input.x,y:input.y,width:Math.min(downloaded.asset.width,480),height:Math.min(downloaded.asset.width,480)*downloaded.asset.height/downloaded.asset.width});
        await tx.query('INSERT INTO workspace.objects VALUES($1,$2,1)',[projectId,object.id]);
        await tx.query('INSERT INTO workspace.object_revisions VALUES($1,$2,1,$3,$4,$5)',[projectId,object.id,output.asset_version_id,JSON.stringify(object),contentHash(object)]);
        await tx.query('UPDATE workspace.canvases SET revision=revision+1 WHERE project_id=$1',[projectId]);
        await tx.query("INSERT INTO workspace.canvas_changes(project_id,revision,kind,object_id,object_revision,actor_id) VALUES($1,$2,'editor',$3,1,$4)",[projectId,start+1,object.id,actorId]);
        await tx.query('INSERT INTO workspace.run_output_placements(project_id,id,run_id,asset_version_id,object_id,object_revision,actor_id) VALUES($1,$2,$3,$4,$5,1,$6)',[projectId,randomUUID(),runId,output.asset_version_id,object.id,actorId]);
        const seq=(await tx.query<{event_sequence:number}>('UPDATE workspace.runs SET event_sequence=event_sequence+1 WHERE project_id=$1 AND id=$2 RETURNING event_sequence',[projectId,runId])).rows[0];
        await tx.query("INSERT INTO workspace.run_events(project_id,run_id,sequence,actor_id,attempt_id,stage) VALUES($1,$2,$3,$4,NULL,'output_placed')",[projectId,runId,seq.event_sequence,actorId]);
        result={revision:start+1,objectId:object.id,assetVersionId:output.asset_version_id,object,alreadyPlaced:false};
      }
      await tx.query('INSERT INTO workspace.run_placement_requests(project_id,id,run_id,actor_id,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)',[projectId,input.id,runId,actorId,requestHash,JSON.stringify(result)]);
      return {...result,reused:false};
    });
  }
}
