import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {LocalWorkspaceDatabase} from '../apps/api/src/localWorkspaceDatabase.ts';
import {LocalWorkspaceAssets} from '../apps/api/src/localWorkspaceAssets.ts';
const root=process.cwd(),caseId=randomUUID(),directory=resolve('work','owned-document-acceptance-'+caseId),evidence=resolve('docs/evidence/2026-11-10/documents',caseId);
mkdirSync(directory,{recursive:true});mkdirSync(evidence,{recursive:true});
const actor=randomUUID(),outside=randomUUID(),project=randomUUID(),bytes=Buffer.from('\ufeff产品资料：白色杯子\r\n保持原件与版本。\n<script>never_execute()</script>','utf8');
const report:Record<string,unknown>={scope:'actual-private-document-disk-restart-no-model',caseId,status:'starting'};let db:LocalWorkspaceDatabase|undefined;
try{
  db=await LocalWorkspaceDatabase.open(root,resolve(directory,'postgres'));await db.seedProject(project,'owned document restart',[{userId:actor,role:'owner'}]);let assets=new LocalWorkspaceAssets(db,resolve(directory,'assets'));
  const asset=await assets.uploadDocument(actor,project,bytes,'text/plain','owned-product.md'),lease=await db.acquireLease(actor,project);
  const original={id:randomUUID(),projectId:project,revision:1,type:'file',assetVersionId:asset.id,title:'产品资料',x:0,y:0,width:300,height:190},copy={...original,id:randomUUID(),x:340};
  await db.saveCanvasOperation(actor,project,{id:randomUUID(),baseRevision:0,objects:[original,copy]},lease);
  await db.saveCanvasOperation(actor,project,{id:randomUUID(),baseRevision:2,objects:[{...copy,revision:2,deleted:true}]},lease);
  let imageRejected=false;try{await db.saveObject(actor,project,{...original,id:randomUUID(),type:'image'},3,lease);}catch(error){imageRejected=(error as Error).message==='ASSET_KIND_MISMATCH';}if(!imageRejected)throw Error('DOCUMENT_IMAGE_BOUNDARY_FAILED');
  await db.close();db=undefined;db=await LocalWorkspaceDatabase.open(root,resolve(directory,'postgres'));assets=new LocalWorkspaceAssets(db,resolve(directory,'assets'));
  const downloaded=await assets.downloadDocument(actor,project,asset.id),preview=await assets.previewDocument(actor,project,asset.id);
  if(!downloaded.bytes.equals(bytes)||preview.sha256!==createHash('sha256').update(bytes).digest('hex')||preview.text!==bytes.toString('utf8').slice(1))throw Error('DOCUMENT_REOPEN_INTEGRITY_FAILED');
  const state=await db.asActor(actor,async tx=>({
    active:(await tx.query<{id:string}>('SELECT o.id FROM workspace.objects o JOIN workspace.object_revisions r ON r.project_id=o.project_id AND r.object_id=o.id AND r.revision=o.current_revision WHERE o.project_id=$1 AND coalesce((r.payload->>\'deleted\')::boolean,false)=false',[project])).rows,
    revisions:(await tx.query<{revision:number;asset_kind:string}>('SELECT revision,asset_kind FROM workspace.object_revisions WHERE project_id=$1 ORDER BY object_id,revision',[project])).rows,
    documents:(await tx.query('SELECT id FROM workspace.asset_documents WHERE project_id=$1',[project])).rows,
  }));
  if(state.active.length!==1||state.active[0].id!==original.id||state.documents.length!==1||state.revisions.length!==3||state.revisions.some(row=>row.asset_kind!=='document'))throw Error('DOCUMENT_REVISIONS_NOT_RETAINED');
  let denied=false;try{await assets.downloadDocument(outside,project,asset.id);}catch(error){denied=(error as Error).message==='NOT_FOUND';}if(!denied)throw Error('DOCUMENT_SCOPE_FAILED');
  Object.assign(report,{status:'passed',projectId:project,assetId:asset.id,sha256:asset.sha256,byteSize:bytes.length,mime:asset.mime,characterCount:asset.characterCount,lineCount:asset.lineCount,originalBytesUnchanged:true,databaseReopened:true,activeCards:state.active.length,immutableRevisions:state.revisions.length,storedDocumentVersions:state.documents.length,documentRejectedAsImage:imageRejected,outsiderDenied:denied,modelRequests:0});
}catch(error){report.status='failed';report.error=(error as Error).message;process.exitCode=1;}
finally{if(db)await db.close();writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,evidence},null,2));}
