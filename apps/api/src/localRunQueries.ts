import type {Transaction} from '@electric-sql/pglite';
import {WorkspaceWorkflowSchema} from '@canvas/contracts';
import {LocalWorkspaceDatabase} from './localWorkspaceDatabase.ts';
import {validateResizeCapabilityPin} from './workspaceModelGateway';
import {contentHash,validateWorkflow} from './workspacePrototype.ts';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const iso=(value:Date|string)=>new Date(typeof value==='string'?value:value.getTime()).toISOString();
type Cursor={projectId:string;createdAt:string;id:string;filter?:'unplaced'};
type RunRow={id:string;state:string;created_at:Date;cursor_created_at:string;event_sequence:number;payload:unknown;content_hash:string;asset_version_id:string|null;object_id:string|null;attempt_stage:string|null;provider_request_id:string|null};
export class LocalRunQueries {
  constructor(private db:LocalWorkspaceDatabase){}
  private async project(tx:Transaction,projectId:string){if(!(await tx.query('SELECT id FROM workspace.projects WHERE id=$1 AND deleted_at IS NULL',[projectId])).rows.length)throw Error('NOT_FOUND');}
  private snapshot(payload:unknown,expectedHash:string){if(contentHash(payload)!==expectedHash)throw Error('SNAPSHOT_INTEGRITY_FAILED');return payload as Record<string,any>;}
  async list(actorId:string,projectId:string,options:{limit?:number;cursor?:string;onlyUnplaced?:boolean}={}){
    const limit=options.limit??30;let cursor:Cursor|undefined;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('INVALID_BODY');
    if(options.cursor){
      if(options.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(options.cursor))throw Error('INVALID_BODY');
      try{cursor=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8'));}catch{throw Error('INVALID_BODY');}
      if(!cursor||Object.keys(cursor).sort().join(',')!==(options.onlyUnplaced?'createdAt,filter,id,projectId':'createdAt,id,projectId')||(options.onlyUnplaced&&cursor.filter!=='unplaced')||cursor.projectId!==projectId||!uuid.test(cursor.id)||typeof cursor.createdAt!=='string'||!Number.isFinite(Date.parse(cursor.createdAt)))throw Error('INVALID_BODY');
    }
    return this.db.asActor(actorId,async tx=>{
      await this.project(tx,projectId);
      const rows=(await tx.query<RunRow>(`SELECT r.id,r.state,r.created_at,r.created_at::text AS cursor_created_at,r.event_sequence,s.payload,s.content_hash,o.asset_version_id,o.object_id,a.stage AS attempt_stage,a.provider_request_id
        FROM workspace.runs r JOIN workspace.run_snapshots s ON s.project_id=r.project_id AND s.id=r.snapshot_id
        LEFT JOIN workspace.current_run_outputs o ON o.project_id=r.project_id AND o.run_id=r.id
        LEFT JOIN workspace.run_attempts a ON a.project_id=r.project_id AND a.run_id=r.id
        WHERE r.project_id=$1 AND (NOT $5::boolean OR (o.asset_version_id IS NOT NULL AND o.object_id IS NULL)) AND ($2::timestamptz IS NULL OR (r.created_at,r.id)<($2::timestamptz,$3::uuid))
        ORDER BY r.created_at DESC,r.id DESC LIMIT $4`,[projectId,cursor?.createdAt??null,cursor?.id??null,limit+1,options.onlyUnplaced===true])).rows;
      const selected=rows.slice(0,limit),items=selected.map(row=>{
        const p=this.snapshot(row.payload,row.content_hash);
        return {id:row.id,state:row.state,eventSequence:Number(row.event_sequence),createdAt:iso(row.created_at),snapshotHash:row.content_hash,
          operation:p?.template?.operation==='image.resize'?'image.resize':'unknown',sourceTitle:typeof p?.source?.title==='string'?p.source.title.slice(0,240):'图片',
          parameters:typeof p?.parameters?.width==='number'&&typeof p?.parameters?.height==='number'?{width:p.parameters.width,height:p.parameters.height}:null,
          output:row.asset_version_id?{assetVersionId:row.asset_version_id,objectId:row.object_id}:null,attempt:row.attempt_stage?{stage:row.attempt_stage,providerRequestId:row.provider_request_id}:null};
      });
      const last=selected.at(-1);
      // Preserve PostgreSQL microseconds in the opaque cursor. Display Dates
      // round to milliseconds and would silently skip same-timestamp rows.
      const nextCursor=rows.length>limit&&last?Buffer.from(JSON.stringify({projectId,createdAt:last.cursor_created_at,id:last.id,...(options.onlyUnplaced?{filter:'unplaced' as const}:{})} satisfies Cursor)).toString('base64url'):null;
      return {items,nextCursor};
    });
  }
  async events(actorId:string,projectId:string,runId:string,afterSequence=0,limit=100){
    if(!Number.isSafeInteger(afterSequence)||afterSequence<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('INVALID_BODY');
    return this.db.asActor(actorId,async tx=>{
      await this.project(tx,projectId);
      const run=(await tx.query<{event_sequence:number}>('SELECT event_sequence FROM workspace.runs WHERE project_id=$1 AND id=$2',[projectId,runId])).rows[0];
      if(!run)throw Error('NOT_FOUND');const latestSequence=Number(run.event_sequence);if(afterSequence>latestSequence)throw Error('INVALID_BODY');
      const rows=(await tx.query<{sequence:number;stage:string;created_at:Date;actor_id:string;attempt_id:string|null}>('SELECT sequence,stage,created_at,actor_id,attempt_id FROM workspace.run_events WHERE project_id=$1 AND run_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4',[projectId,runId,afterSequence,limit])).rows;
      const items=rows.map((row,index)=>{const sequence=Number(row.sequence);if(sequence!==afterSequence+index+1)throw Error('EVENT_HISTORY_INCOMPLETE');return {sequence,stage:row.stage,createdAt:iso(row.created_at),actorId:row.actor_id,attemptId:row.attempt_id};});
      const nextSequence=items.at(-1)?.sequence??afterSequence;if(nextSequence<latestSequence&&!items.length)throw Error('EVENT_HISTORY_INCOMPLETE');
      return {items,nextSequence,latestSequence,hasMore:nextSequence<latestSequence};
    });
  }
  async usage(actorId:string,projectId:string){
    return this.db.asActor(actorId,async tx=>{
      await this.project(tx,projectId);
      const budget=(await tx.query<{currency:string;limit_amount:string;reserved_amount:string;spent_amount:string}>('SELECT currency,limit_amount::text,reserved_amount::text,spent_amount::text FROM workspace.budgets WHERE project_id=$1',[projectId])).rows[0];if(!budget)throw Error('NOT_FOUND');
      const rows=(await tx.query<{state:string;payload:unknown;content_hash:string}>('SELECT r.state,s.payload,s.content_hash FROM workspace.runs r JOIN workspace.run_snapshots s ON s.project_id=r.project_id AND s.id=r.snapshot_id WHERE r.project_id=$1',[projectId])).rows;
      let localZeroCostRuns=0,executionUnknownRuns=0,unknownCostRuns=0,unaccountedRuns=0;
      for(const row of rows){
        const p=this.snapshot(row.payload,row.content_hash);let zero=false;
        if(p?.schemaVersion===2)validateResizeCapabilityPin(p.modelCapability);
        if([1,2].includes(p?.schemaVersion)&&p?.authorization?.scope==='local-resize-only-v1'&&p.authorization.providerCost==='0'&&p.authorization.currency===budget.currency&&p?.template?.operation==='image.resize'){
          try{validateWorkflow(WorkspaceWorkflowSchema.parse(p.workflow));zero=true;}catch{}
        }
        if(row.state==='unknown')executionUnknownRuns++;
        if(zero)localZeroCostRuns++;else{unaccountedRuns++;if(!['queued','cancelled'].includes(row.state))unknownCostRuns++;}
      }
      return {currency:budget.currency,limitAmount:budget.limit_amount,reservedAmount:budget.reserved_amount,
        actual:{knownSettledAmount:budget.spent_amount,unknownRunCount:unknownCostRuns,complete:unaccountedRuns===0},
        localResize:{runCount:localZeroCostRuns,providerCostAmount:'0'},executionUnknownRuns,unaccountedRuns,totalRuns:rows.length};
    });
  }
}
