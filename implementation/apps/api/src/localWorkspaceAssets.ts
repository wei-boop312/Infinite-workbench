import { mkdirSync,readFileSync,writeFileSync,realpathSync,statSync } from 'node:fs';
import { resolve,relative,isAbsolute } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { decodeStaticImage,imageMagicMime } from './staticImageDecoder.ts';
import {WorkspaceDocumentAssetSchema} from '@canvas/contracts';
import {decodeDocument,documentMime} from './textDocument.ts';
import { LocalWorkspaceDatabase } from './localWorkspaceDatabase.ts';
export class LocalWorkspaceAssets{
  private root:string;
  constructor(private db:LocalWorkspaceDatabase,directory:string){mkdirSync(directory,{recursive:true});this.root=realpathSync(directory);}
  private path(projectId:string,id:string){
    if(!/^[0-9a-f-]{36}$/i.test(projectId)||!/^[0-9a-f-]{36}$/i.test(id))throw Error('NOT_FOUND');
    const directory=resolve(this.root,projectId);mkdirSync(directory,{recursive:true});
    const rel=relative(this.root,realpathSync(directory));if(rel.startsWith('..')||isAbsolute(rel))throw Error('INVALID_STORAGE_PATH');
    return resolve(directory,`${id}.bin`);
  }
  async upload(actorId:string,projectId:string,bytes:Buffer,declaredMime:string,name:string){
    if(!bytes.length||bytes.length>8*1024*1024)throw Error('ASSET_SIZE_EXCEEDED');
    const mime=imageMagicMime(bytes);
    if(!mime||!['image/png','image/jpeg','image/webp'].includes(mime)||mime!==declaredMime)throw Error('ASSET_TYPE_REJECTED');
    if(!name||name.length>240||/[\x00-\x1f]/.test(name))throw Error('INVALID_ASSET_NAME');
    const decoded=await decodeStaticImage(bytes,mime),id=randomUUID(),sha256=createHash('sha256').update(bytes).digest('hex');
    const asset={id,sha256,byteSize:bytes.length,mime,name,width:decoded.width,height:decoded.height};
    await this.db.registerLocalAsset(actorId,projectId,asset,()=>writeFileSync(this.path(projectId,id),bytes,{flag:'wx',mode:0o600}));
    return {...asset,projectId,state:'ready' as const};
  }
  async uploadDocument(actorId:string,projectId:string,bytes:Buffer,declaredMime:string,name:string){
    const mime=documentMime(name,declaredMime),decoded=decodeDocument(bytes),id=randomUUID(),sha256=createHash('sha256').update(bytes).digest('hex');
    const asset={id,sha256,byteSize:bytes.length,mime,name,characterCount:decoded.characterCount,lineCount:decoded.lineCount,hasBom:decoded.hasBom};
    await this.db.registerLocalDocument(actorId,projectId,asset,()=>writeFileSync(this.path(projectId,id),bytes,{flag:'wx',mode:0o600,flush:true}));return WorkspaceDocumentAssetSchema.parse({...asset,projectId,state:'ready',encoding:'utf-8'});
  }
  async downloadDocument(actorId:string,projectId:string,id:string){
    const asset=await this.db.readLocalDocument(actorId,projectId,id),path=this.path(projectId,id),rel=relative(this.root,realpathSync(path));if(rel.startsWith('..')||isAbsolute(rel))throw Error('INVALID_STORAGE_PATH');
    if(statSync(path).size!==Number(asset.byte_size))throw Error('ASSET_INTEGRITY_FAILED');const bytes=readFileSync(path);
    if(bytes.length!==Number(asset.byte_size)||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('ASSET_INTEGRITY_FAILED');return {asset,bytes};
  }
  async previewDocument(actorId:string,projectId:string,id:string){
    const {asset,bytes}=await this.downloadDocument(actorId,projectId,id),decoded=decodeDocument(bytes);let text=decoded.text.slice(0,20000);if(/[\uD800-\uDBFF]/.test(text.at(-1)??''))text=text.slice(0,-1);
    return {assetId:asset.id,sha256:asset.sha256,name:asset.original_name,mime:asset.mime,byteSize:Number(asset.byte_size),characterCount:decoded.characterCount,lineCount:decoded.lineCount,hasBom:decoded.hasBom,encoding:'utf-8',text,truncated:text.length<decoded.text.length};
  }
  async download(actorId:string,projectId:string,id:string){
    const asset=await this.db.readLocalAsset(actorId,projectId,id),path=this.path(projectId,id),rel=relative(this.root,realpathSync(path));
    if(rel.startsWith('..')||isAbsolute(rel))throw Error('INVALID_STORAGE_PATH');
    const bytes=readFileSync(path);
    if(bytes.length!==Number(asset.byte_size)||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('ASSET_INTEGRITY_FAILED');
    return {asset,bytes};
  }
}
