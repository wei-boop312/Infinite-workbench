import {existsSync,mkdirSync,readFileSync,writeFileSync,realpathSync,statSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {WorkspaceArtifactManifestSchema,WorkspaceParametersSchema,type WorkspaceArtifactManifest} from '@canvas/contracts';
import {contentHash} from './workspacePrototype.ts';
import {decodeStaticImage} from './staticImageDecoder.ts';

type Scope={projectId:string;runId:string;attemptId:string};
type Context=Scope&{snapshotHash:string;requestHash:string;runtimeEvidenceHash:string;providerRequestId:string;history:unknown};
export type StoredRunArtifact={manifest:WorkspaceArtifactManifest;manifestHash:string};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** Private immutable cache; not exposed by static routes or project exports. */
export class LocalRunArtifactStore {
  private root:string;
  constructor(directory:string){mkdirSync(directory,{recursive:true});this.root=realpathSync(directory);}
  private contained(path:string){const rel=relative(this.root,path);if(rel.startsWith('..')||isAbsolute(rel))throw Error('INVALID_ARTIFACT_PATH');return path;}
  private directory(scope:Scope,create=false){
    let path=this.root;
    for(const id of [scope.projectId,scope.runId,scope.attemptId]){
      if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))throw Error('INVALID_ARTIFACT_PATH');
      const next=resolve(path,id);if(!existsSync(next)){if(!create)throw Error('ARTIFACT_NOT_FOUND');mkdirSync(next);}
      path=this.contained(realpathSync(next));if(!statSync(path).isDirectory())throw Error('INVALID_ARTIFACT_PATH');
    }
    return path;
  }
  private file(directory:string,name:'output.png'|'manifest.json'){
    const path=resolve(directory,name);if(existsSync(path)){const actual=this.contained(realpathSync(path));if(relative(directory,actual).startsWith('..')||!statSync(actual).isFile())throw Error('INVALID_ARTIFACT_PATH');return actual;}return path;
  }
  async stage(context:Context,bytes:Buffer,parameters:unknown):Promise<StoredRunArtifact>{
    if(!bytes.length||bytes.length>8*1024*1024)throw Error('ASSET_SIZE_EXCEEDED');
    const size=WorkspaceParametersSchema.parse(parameters),decoded=await decodeStaticImage(bytes,'image/png');
    if(decoded.width!==size.width||decoded.height!==size.height)throw Error('OUTPUT_DIMENSIONS_MISMATCH');
    const manifest=WorkspaceArtifactManifestSchema.parse({schemaVersion:1,projectId:context.projectId,runId:context.runId,attemptId:context.attemptId,
      snapshotHash:context.snapshotHash,requestHash:context.requestHash,runtimeEvidenceHash:context.runtimeEvidenceHash,providerRequestId:context.providerRequestId,
      history:structuredClone(context.history),sha256:sha(bytes),byteSize:bytes.length,mime:'image/png',width:size.width,height:size.height});
    const manifestHash=contentHash(manifest),directory=this.directory(manifest,true),output=this.file(directory,'output.png'),metadata=this.file(directory,'manifest.json');
    if(existsSync(output)){if(statSync(output).size!==bytes.length||!readFileSync(output).equals(bytes))throw Error('ARTIFACT_IMMUTABLE_CONFLICT');}
    else writeFileSync(output,bytes,{flag:'wx',mode:0o600,flush:true});
    const serialized=JSON.stringify(manifest);if(Buffer.byteLength(serialized)>2*1024*1024)throw Error('ARTIFACT_MANIFEST_TOO_LARGE');
    if(existsSync(metadata)){if(statSync(metadata).size>2*1024*1024||contentHash(JSON.parse(readFileSync(metadata,'utf8')))!==manifestHash)throw Error('ARTIFACT_IMMUTABLE_CONFLICT');}
    else writeFileSync(metadata,serialized,{flag:'wx',mode:0o600,flush:true});
    return {manifest,manifestHash};
  }
  async load(scope:Scope,expectedManifestHash:string){
    if(!/^[a-f0-9]{64}$/.test(expectedManifestHash))throw Error('ARTIFACT_INTEGRITY_FAILED');
    const directory=this.directory(scope),metadata=this.file(directory,'manifest.json');if(!existsSync(metadata)||statSync(metadata).size>2*1024*1024)throw Error('ARTIFACT_INTEGRITY_FAILED');
    let manifest:WorkspaceArtifactManifest;try{manifest=WorkspaceArtifactManifestSchema.parse(JSON.parse(readFileSync(metadata,'utf8')));}catch{throw Error('ARTIFACT_INTEGRITY_FAILED');}
    if(contentHash(manifest)!==expectedManifestHash||manifest.projectId!==scope.projectId||manifest.runId!==scope.runId||manifest.attemptId!==scope.attemptId)throw Error('ARTIFACT_INTEGRITY_FAILED');
    const path=this.file(directory,'output.png');if(!existsSync(path)||statSync(path).size!==manifest.byteSize)throw Error('ARTIFACT_INTEGRITY_FAILED');
    const bytes=readFileSync(path);if(sha(bytes)!==manifest.sha256)throw Error('ARTIFACT_INTEGRITY_FAILED');
    const decoded=await decodeStaticImage(bytes,'image/png');if(decoded.width!==manifest.width||decoded.height!==manifest.height)throw Error('ARTIFACT_INTEGRITY_FAILED');
    return {manifest,manifestHash:expectedManifestHash,bytes};
  }
}
