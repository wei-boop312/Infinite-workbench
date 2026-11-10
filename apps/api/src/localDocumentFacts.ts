import {createHash,randomUUID} from 'node:crypto';
import type {Transaction} from '@electric-sql/pglite';
import {WorkspaceFactCommandSchema,WorkspaceFactRevisionSchema,type WorkspaceFactEdit} from '@canvas/contracts';
import {LocalWorkspaceDatabase} from './localWorkspaceDatabase.ts';
import {LocalWorkspaceAssets} from './localWorkspaceAssets.ts';
import {decodeDocument} from './textDocument.ts';
import {contentHash} from './workspacePrototype.ts';

const unknown=(value:string)=>/^(未知|不详|待确认|待提供|暂无|unknown|n\/a|\?)$/i.test(value.trim());
const key=(value:string)=>value.normalize('NFKC').trim().toLowerCase();
type Revision=ReturnType<typeof WorkspaceFactRevisionSchema.parse>;
export function factConflicts(facts:Revision['facts']){
  const groups=new Map<string,Revision['facts']>();
  for(const fact of facts)if(!fact.excluded&&!fact.unknown){const name=key(fact.name);groups.set(name,[...(groups.get(name)??[]),fact]);}
  return [...groups.values()].filter(group=>new Set(group.map(fact=>fact.value+'\0'+fact.unit)).size>1).map(group=>({name:group[0].name,factIds:group.map(fact=>fact.id)}));
}
/** Deterministic text parsing only. Does not call or impersonate a model. */
export function parseDocumentFacts(text:string){
  const facts:Revision['facts']=[],unparsed:Revision['unparsed']=[];let unparsedCount=0,line=0;
  const rows=/([^\r\n]*)(\r\n|\r|\n|$)/g;let match:RegExpExecArray|null;
  while((match=rows.exec(text))&&match[0].length){
    line++;const raw=match[1];if(!raw.trim())continue;
    const candidate=raw.length<=1200?/^\s*(?:[-*]\s+)?([^:：\r\n]{1,80})[:：]\s*(.*?)\s*$/.exec(raw):null;
    const name=candidate?.[1].trim(),value=candidate?.[2].trim();
    if(name&&value&&value.length<=1000&&facts.length<50){facts.push({id:randomUUID(),name,value,unit:'',userConfirmed:false,excluded:false,confidence:null,original:{name,value},source:{line,start:match.index,end:match.index+raw.length,quote:raw},manuallyEdited:false,unknown:unknown(value)});}
    else{unparsedCount++;if(unparsed.length<200)unparsed.push({line,reason:raw.length>1200?'line_too_long':facts.length>=50?'candidate_limit':'no_key_value'});}
  }
  return {facts,unparsed,unparsedCount,conflicts:factConflicts(facts)};
}
export class LocalDocumentFacts {
  constructor(private db:LocalWorkspaceDatabase,private assets:LocalWorkspaceAssets){}
  private async access(tx:Transaction,projectId:string,assetId:string,write=false){
    const row=(await tx.query<{allowed:boolean;sha256:string}>("SELECT workspace.can_edit(d.project_id) AS allowed,a.sha256 FROM workspace.asset_documents d JOIN workspace.asset_versions a ON a.project_id=d.project_id AND a.id=d.id WHERE d.project_id=$1 AND d.id=$2 AND a.state='ready'",[projectId,assetId])).rows[0];
    if(!row)throw Error('NOT_FOUND');if(write&&!row.allowed)throw Error('ACCESS_DENIED');return row;
  }
  private stored(payload:unknown,hash:string,projectId:string,assetId:string,revision:number,sha:string){
    if(contentHash(payload)!==hash)throw Error('FACT_INTEGRITY_FAILED');const value=WorkspaceFactRevisionSchema.parse(payload);
    if(value.projectId.toLowerCase()!==projectId.toLowerCase()||value.assetVersionId.toLowerCase()!==assetId.toLowerCase()||value.revision!==revision||value.sourceSha256!==sha)throw Error('FACT_INTEGRITY_FAILED');return value;
  }
  async read(actorId:string,projectId:string,assetId:string,revision?:number){
    if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))throw Error('INVALID_BODY');
    return this.db.asActor(actorId,async tx=>{
      const asset=await this.access(tx,projectId,assetId),set=(await tx.query<{current_revision:number}>('SELECT current_revision FROM workspace.document_fact_sets WHERE project_id=$1 AND asset_id=$2',[projectId,assetId])).rows[0];
      if(!set){if(revision!==undefined)throw Error('NOT_FOUND');return {currentRevision:0,document:null,canEdit:asset.allowed};}
      const currentRevision=Number(set.current_revision),selected=revision??currentRevision;
      const row=(await tx.query<{payload:unknown;content_hash:string}>('SELECT payload,content_hash FROM workspace.document_fact_revisions WHERE project_id=$1 AND asset_id=$2 AND revision=$3',[projectId,assetId,selected])).rows[0];if(!row)throw Error('NOT_FOUND');
      return {currentRevision,canEdit:asset.allowed,document:this.stored(row.payload,row.content_hash,projectId,assetId,selected,asset.sha256)};
    });
  }
  async command(actorId:string,projectId:string,assetId:string,raw:unknown,lease:{token:string;fencing:number},now=new Date()){
    const input=WorkspaceFactCommandSchema.parse(raw),requestHash=contentHash({assetId:assetId.toLowerCase(),input});
    const receipt=async(tx:Transaction)=>{const row=(await tx.query<{actor_id:string;request_hash:string;result:{assetVersionId:string;revision:number;created:boolean}}>('SELECT actor_id,request_hash,result FROM workspace.document_fact_requests WHERE project_id=$1 AND id=$2',[projectId,input.id])).rows[0];if(!row)return null;if(row.actor_id!==actorId||row.request_hash!==requestHash)throw Error('IDEMPOTENCY_CONFLICT');return {...row.result,reused:true};};
    const previous=await this.db.asActor(actorId,async tx=>{await this.access(tx,projectId,assetId,true);return receipt(tx);});if(previous)return previous;
    const source=input.action==='extract'?await this.assets.downloadDocument(actorId,projectId,assetId):null;
    const candidates=source?parseDocumentFacts(decodeDocument(source.bytes).text):null;
    return this.db.asActor(actorId,async tx=>{
      const asset=await this.access(tx,projectId,assetId,true);
      await tx.query('SELECT project_id FROM workspace.canvases WHERE project_id=$1 FOR UPDATE',[projectId]);
      const prior=await receipt(tx);if(prior)return prior;
      const currentLease=(await tx.query<{holder_id:string;token_hash:string;fencing_token:number;expires_at:Date}>('SELECT * FROM workspace.edit_leases WHERE project_id=$1 FOR UPDATE',[projectId])).rows[0];
      if(!currentLease||currentLease.holder_id!==actorId||currentLease.token_hash!==createHash('sha256').update(lease.token).digest('hex')||Number(currentLease.fencing_token)!==lease.fencing||new Date(currentLease.expires_at).getTime()<=now.getTime())throw Error('LEASE_CONFLICT');
      const set=(await tx.query<{current_revision:number}>('SELECT current_revision FROM workspace.document_fact_sets WHERE project_id=$1 AND asset_id=$2 FOR UPDATE',[projectId,assetId])).rows[0];
      let revision=Number(set?.current_revision??0),document:Revision|undefined,created=false;
      if(input.action==='extract'&&!set){
        if(!source||!candidates||source.asset.sha256!==asset.sha256)throw Error('FACT_INTEGRITY_FAILED');revision=1;created=true;
        document=WorkspaceFactRevisionSchema.parse({projectId,assetVersionId:assetId,revision,sourceSha256:asset.sha256,provenance:'deterministic-local-key-value-v1',coordinateSystem:'decoded-utf8-no-bom-utf16',...candidates,authorId:actorId,createdAt:now.toISOString()});
        await tx.query('INSERT INTO workspace.document_fact_sets VALUES($1,$2,1)',[projectId,assetId]);
      }else if(input.action==='save'){
        if(!set||revision!==input.baseRevision)throw Error('FACT_REVISION_CONFLICT');
        const row=(await tx.query<{payload:unknown;content_hash:string}>('SELECT payload,content_hash FROM workspace.document_fact_revisions WHERE project_id=$1 AND asset_id=$2 AND revision=$3',[projectId,assetId,revision])).rows[0];
        const current=this.stored(row.payload,row.content_hash,projectId,assetId,revision,asset.sha256),edits=new Map<string,WorkspaceFactEdit>(input.facts.map(fact=>[fact.id.toLowerCase(),fact]));
        if(edits.size!==input.facts.length||edits.size!==current.facts.length||current.facts.some(fact=>!edits.has(fact.id.toLowerCase())))throw Error('FACT_IDENTITY_CONFLICT');
        const facts=current.facts.map(fact=>{const edit=edits.get(fact.id.toLowerCase())!;const next={...fact,...edit,id:fact.id,manuallyEdited:edit.name!==fact.original.name||edit.value!==fact.original.value||edit.unit!=='',unknown:unknown(edit.value)};if(next.userConfirmed&&next.unknown)throw Error('FACT_UNKNOWN_UNCONFIRMABLE');return next;});
        const conflicts=factConflicts(facts);if(conflicts.some(conflict=>conflict.factIds.some(id=>facts.find(fact=>fact.id===id)?.userConfirmed)))throw Error('FACT_CONFLICT_UNRESOLVED');
        revision++;document=WorkspaceFactRevisionSchema.parse({...current,revision,facts,conflicts,authorId:actorId,createdAt:now.toISOString()});
        await tx.query('UPDATE workspace.document_fact_sets SET current_revision=$3 WHERE project_id=$1 AND asset_id=$2',[projectId,assetId,revision]);
      }
      if(document)await tx.query('INSERT INTO workspace.document_fact_revisions(project_id,asset_id,revision,payload,content_hash,created_by) VALUES($1,$2,$3,$4,$5,$6)',[projectId,assetId,revision,JSON.stringify(document),contentHash(document),actorId]);
      const result={assetVersionId:assetId,revision,created};await tx.query('INSERT INTO workspace.document_fact_requests VALUES($1,$2,$3,$4,$5)',[projectId,input.id,actorId,requestHash,JSON.stringify(result)]);return {...result,reused:false};
    });
  }
}
