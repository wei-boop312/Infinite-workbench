import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {createWriteStream,mkdirSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,basename} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {recordedCompilerPin} from './compileResize.ts';
import {contentHash} from '../../api/src/workspacePrototype.ts';
import type {OwnedResizeRuntime} from './localResizeWorker.ts';
import {isInterruptedWithoutOutput} from '../../api/src/ownedCancellationReceipt.ts';
import {OwnedRuntimeCancellation} from './runtimeCancellation.ts';
import {WorkspaceRuntimeEvidenceSchema,type WorkspaceRuntimeEvidence} from '@canvas/contracts';

type Options={root:string;pythonExecutable:string;comfyMain:string;compilerSourceSha256:string};
/** A private CPU-only instance per task; never connects to a daily Comfy URL. */
export class OwnedComfyRuntime implements OwnedResizeRuntime {
  readonly directory:string;
  private child:ChildProcess|undefined;private origin='';private submitted=false;private prompt:unknown;
  private exited:Promise<void>|undefined;private processError:Error|undefined;
  private sourceEvidence:Pick<WorkspaceRuntimeEvidence,'pythonExecutableSha256'|'bridgeSha256'|'coreFiles'>|undefined;
  private registrySha256:string|undefined;private versions:WorkspaceRuntimeEvidence['versions']={python:null,pytorch:null,comfyui:null};
  constructor(private options:Options){
    if(!isAbsolute(options.root)||!isAbsolute(options.pythonExecutable)||!isAbsolute(options.comfyMain))throw Error('EXPLICIT_RUNTIME_PATHS_REQUIRED');
    if(!statSync(options.pythonExecutable).isFile()||!statSync(options.comfyMain).isFile())throw Error('RUNTIME_MISSING');
    this.directory=resolve(options.root,'work','owned-comfy-worker-'+randomUUID());
  }
  private alive(){if(!this.child||this.child.exitCode!==null||this.child.signalCode!==null||this.processError)throw Error('OWNED_COMFY_NOT_RUNNING');}
  private pin(){if(recordedCompilerPin(this.options.root).sourceTreeSha256!==this.options.compilerSourceSha256)throw Error('COMPILER_ENVIRONMENT_CHANGED');}
  private sourceHashes(){
    const hashFile=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
    const paths=['nodes.py','execution.py','server.py','comfy/utils.py','comfy/model_management.py'] as const;
    return {pythonExecutableSha256:hashFile(this.options.pythonExecutable),bridgeSha256:hashFile(resolve(this.options.root,'tools/compile_live_resize.py')),
      coreFiles:paths.map(path=>({path,sha256:hashFile(resolve(dirname(this.options.comfyMain),path))}))};
  }
  private sourceStable(){if(!this.sourceEvidence||contentHash(this.sourceEvidence)!==contentHash(this.sourceHashes()))throw Error('RUNTIME_SOURCE_CHANGED');}
  async provenance(){
    this.alive();this.pin();this.sourceStable();if(!this.registrySha256)throw Error('PREPARATION_NOT_AVAILABLE');
    return WorkspaceRuntimeEvidenceSchema.parse({schemaVersion:1,adapterVersion:'local-owned-resize-v1',runtimeKind:'owned-cpu-comfy',runtimeRef:basename(this.directory),
      compilerSourceSha256:this.options.compilerSourceSha256,registrySha256:this.registrySha256,versions:this.versions,...this.sourceEvidence});
  }
  async start(){
    if(this.child)throw Error('RUNTIME_ALREADY_STARTED');this.pin();this.sourceEvidence=this.sourceHashes();
    mkdirSync(this.directory,{recursive:false});
    for(const name of ['input','output','user','temp','frontend','cache'])mkdirSync(resolve(this.directory,name));
    const probe=createServer();await new Promise<void>((done,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',done);});
    const address=probe.address();if(!address||typeof address==='string')throw Error('NO_OWNED_PORT');
    const port=address.port;await new Promise<void>((done,reject)=>probe.close(error=>error?reject(error):done()));
    this.origin=`http://127.0.0.1:${port}`;
    const args=['-B',this.options.comfyMain,'--cpu','--listen','127.0.0.1','--port',String(port),'--disable-all-custom-nodes','--disable-api-nodes','--base-directory',this.directory,
      '--user-directory',resolve(this.directory,'user'),'--input-directory',resolve(this.directory,'input'),'--output-directory',resolve(this.directory,'output'),
      '--temp-directory',resolve(this.directory,'temp'),'--front-end-root',resolve(this.directory,'frontend')];
    const child=spawn(this.options.pythonExecutable,args,{cwd:this.directory,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:this.environment()});this.child=child;
    child.stdout!.pipe(createWriteStream(resolve(this.directory,'stdout.log'),{flags:'wx'}));child.stderr!.pipe(createWriteStream(resolve(this.directory,'stderr.log'),{flags:'wx'}));
    this.exited=new Promise(done=>{child.once('exit',()=>done());child.once('error',error=>{this.processError=error;done();});});
    const deadline=Date.now()+40_000;
    while(Date.now()<deadline){this.alive();try{const stats=await this.json('/system_stats');const version=(value:unknown)=>typeof value==='string'&&value.length<=256?value:null;this.versions={python:version(stats.system?.python_version),pytorch:version(stats.system?.pytorch_version),comfyui:version(stats.system?.comfyui_version)};return;}catch{await delay(200);}}
    throw Error('OWNED_COMFY_READINESS_TIMEOUT');
  }
  private environment():NodeJS.ProcessEnv{
    return {SystemRoot:'C:/Windows',WINDIR:'C:/Windows',PATH:'C:/Windows/System32',HF_HOME:resolve(this.directory,'cache'),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',
      USERNAME:'owned-workspace-worker',USERPROFILE:resolve(this.directory,'user'),APPDATA:resolve(this.directory,'cache'),LOCALAPPDATA:resolve(this.directory,'cache'),TEMP:resolve(this.directory,'temp'),TMP:resolve(this.directory,'temp')};
  }
  private async json(path:string,body?:BodyInit,allowEmpty=false){
    this.alive();const response=await fetch(this.origin+path,{method:body===undefined?'GET':'POST',body,redirect:'error',signal:AbortSignal.timeout(3000),
      headers:typeof body==='string'?{'content-type':'application/json'}:undefined});
    if(!response.ok)throw Error('OWNED_COMFY_HTTP_'+response.status);
    let size=0;const chunks:Uint8Array[]=[];
    if(!response.body)throw Error('OWNED_COMFY_EMPTY_RESPONSE');
    const reader=response.body.getReader();
    try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>2*1024*1024){await reader.cancel();throw Error('OWNED_COMFY_RESPONSE_TOO_LARGE');}chunks.push(chunk.value);}}finally{reader.releaseLock();}
    if(allowEmpty&&size===0)return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private ownedFile(folder:'input'|'output',subfolder:string,name:string){
    if(!name||/[\\/\x00]/.test(name)||isAbsolute(subfolder))throw Error('OWNED_FILE_PATH_REJECTED');
    const root=realpathSync(resolve(this.directory,folder)),path=realpathSync(resolve(root,subfolder,name)),rel=relative(root,path);
    if(rel.startsWith('..')||isAbsolute(rel)||!statSync(path).isFile()||statSync(path).size>8*1024*1024)throw Error('OWNED_FILE_PATH_REJECTED');
    return path;
  }
  async upload(bytes:Buffer,mime:string,name:string){
    if(!/^[A-Za-z0-9_-]{1,128}\.(png|jpg|jpeg|webp)$/.test(name)||bytes.length>8*1024*1024)throw Error('UPLOAD_REJECTED');
    const body=new FormData();body.append('image',new Blob([new Uint8Array(bytes)],{type:mime}),name);
    const receipt=await this.json('/upload/image',body);
    if(receipt.name!==name||receipt.subfolder!==''||receipt.type!=='input')throw Error('UPLOAD_RECEIPT_REJECTED');
    const actual=readFileSync(this.ownedFile('input','',name));
    if(!actual.equals(bytes))throw Error('UPLOAD_BYTES_MISMATCH');
    return name;
  }
  async compile(parameters:unknown,uploadedFilename:string){
    this.pin();const registry:Record<string,unknown>={};
    for(const name of ['LoadImage','ImageScale','SaveImage'])Object.assign(registry,await this.json('/object_info/'+name));
    this.registrySha256=contentHash(registry);
    const input=JSON.stringify({registry,parameters,source_image:uploadedFilename});
    const result=await new Promise<string>((done,reject)=>{
      const child=spawn(this.options.pythonExecutable,['-B',resolve(this.options.root,'tools/compile_live_resize.py')],{cwd:this.options.root,windowsHide:true,shell:false,env:this.environment(),stdio:['pipe','pipe','pipe']});
      const output:Buffer[]=[],errors:Buffer[]=[];let length=0;
      const timer=setTimeout(()=>{child.kill();reject(Error('COMPILE_TIMEOUT'));},10_000);
      child.stdout.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>2*1024*1024){child.kill();reject(Error('COMPILE_OUTPUT_TOO_LARGE'));}else output.push(chunk);});
      child.stderr.on('data',(chunk:Buffer)=>{if(Buffer.concat(errors).length<4096)errors.push(chunk);});
      child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);code===0?done(Buffer.concat(output).toString('utf8')):reject(Error('COMPILE_FAILED: '+Buffer.concat(errors).toString('utf8').slice(0,300)));});
      child.stdin.on('error',()=>{});child.stdin.end(input);
    });
    this.pin();this.sourceStable();return JSON.parse(result);
  }
  async submit(request:{prompt:unknown;client_id:string}){
    if(this.submitted)throw Error('OWNED_COMFY_ALREADY_SUBMITTED');this.submitted=true;this.prompt=structuredClone(request.prompt);
    const receipt=await this.json('/prompt',JSON.stringify(request));
    if(typeof receipt.prompt_id!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(receipt.prompt_id)||Object.keys(receipt.node_errors??{}).length)throw Error('SUBMISSION_RECEIPT_REJECTED');
    return receipt.prompt_id;
  }
  async result(providerRequestId:string,cancellationRequested?:()=>Promise<boolean>){
    if(!this.submitted||!/^[a-zA-Z0-9_-]{1,160}$/.test(providerRequestId))throw Error('INVALID_PROVIDER_REQUEST_ID');
    const deadline=Date.now()+30_000;let interrupted=false;
    while(Date.now()<deadline){
      const all=await this.json('/history/'+providerRequestId),history=all[providerRequestId];
      if(history){
        if(history.prompt?.[1]!==providerRequestId||!history.prompt?.[2]||contentHash(history.prompt[2])!==contentHash(this.prompt))throw Error('HISTORY_RECEIPT_REJECTED');
        if(interrupted&&isInterruptedWithoutOutput(history,providerRequestId,this.prompt)){
          await this.close();if(!this.evidence.stopped)throw Error('CANCELLATION_NOT_CONFIRMED');
          throw new OwnedRuntimeCancellation({scope:'owned-cpu-resize-single-run',providerRequestId,ownedProcessStopped:true,history});
        }
        const interruptedWithOutput=interrupted&&history.status?.status_str==='error'&&Array.isArray(history.status.messages)&&history.status.messages.some((message:unknown)=>Array.isArray(message)&&message[0]==='execution_interrupted'&&message[1]?.prompt_id===providerRequestId);
        if(history.status?.status_str!=='success'&&!interruptedWithOutput)throw Error('HISTORY_RECEIPT_REJECTED');
        const outputs=history.outputs;
        if(!outputs||Object.keys(outputs).join(',')!=='3'||!Array.isArray(outputs['3'].images)||outputs['3'].images.length!==1)throw Error('OUTPUT_COUNT_REJECTED');
        const image=outputs['3'].images[0];if(image.type!=='output'||typeof image.subfolder!=='string'||typeof image.filename!=='string')throw Error('OUTPUT_RECEIPT_REJECTED');
        const bytes=readFileSync(this.ownedFile('output',image.subfolder,image.filename));
        return {history,bytes};
      }
      if(!interrupted&&cancellationRequested&&await cancellationRequested()){
        // This process owns exactly one prompt. Target it explicitly and never
        // interrupt a daily/shared Comfy instance. A lost reply is not retried.
        interrupted=true;await this.json('/interrupt',JSON.stringify({prompt_id:providerRequestId}),true);
      }
      await delay(200);
    }
    throw Error('OWNED_COMFY_RESULT_TIMEOUT');
  }
  async close(){
    if(!this.child||this.child.exitCode!==null||this.child.signalCode!==null)return;
    this.child.kill('SIGTERM');
    await Promise.race([this.exited,delay(5000)]);
    if(this.child.exitCode===null&&this.child.signalCode===null){this.child.kill('SIGKILL');await Promise.race([this.exited,delay(5000)]);}
    if(this.child.exitCode===null&&this.child.signalCode===null)throw Error('OWNED_COMFY_DID_NOT_STOP');
  }
  get evidence(){return {directory:this.directory,ownedPid:this.child?.pid??null,submitted:this.submitted,stopped:!!this.child&&(this.child.exitCode!==null||this.child.signalCode!==null)};}
}
