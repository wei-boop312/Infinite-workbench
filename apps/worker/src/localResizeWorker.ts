import {createHash,randomUUID} from 'node:crypto';
import {LocalRunExecution,type LocalExecutionLease} from '../../api/src/localRunExecution.ts';
import {LocalWorkspaceAssets} from '../../api/src/localWorkspaceAssets.ts';
import {validateResizePrompt} from './validateResizePrompt.ts';

/** Implementations must own an isolated CPU Comfy process; no user-supplied URL. */
export interface OwnedResizeRuntime {
  start():Promise<void>;
  upload(bytes:Buffer,mime:string,name:string):Promise<string>;
  compile(parameters:unknown,uploadedFilename:string):Promise<unknown>;
  submit(request:{prompt:unknown;client_id:string}):Promise<string>;
  result(providerRequestId:string):Promise<{history:unknown;bytes:Buffer}>;
  close():Promise<void>;
}
export class LocalResizeWorker {
  private workerId=randomUUID();
  constructor(private execution:LocalRunExecution,private assets:LocalWorkspaceAssets,private runtime:OwnedResizeRuntime){}
  async execute(actorId:string,projectId:string,runId:string){
    let lease:LocalExecutionLease|undefined;
    try{
      // Startup precedes the short execution lease and cannot submit a graph.
      await this.runtime.start();
      const claim=await this.execution.claim(actorId,projectId,runId,this.workerId);lease=claim.lease;
      const source=await this.assets.download(actorId,projectId,claim.snapshot.asset.id);
      if(source.asset.sha256!==claim.snapshot.asset.sha256)throw Error('ASSET_INTEGRITY_FAILED');
      const extension=source.asset.mime==='image/png'?'png':source.asset.mime==='image/jpeg'?'jpg':'webp';
      const filename=await this.runtime.upload(source.bytes,source.asset.mime,`input-${claim.snapshot.asset.id}.${extension}`);
      const prompt=validateResizePrompt(await this.runtime.compile(claim.snapshot.parameters,filename),claim.snapshot.parameters,filename);
      const request={prompt,client_id:this.workerId};
      await this.execution.beforeSubmit(lease,request);
      // Exactly one call. A thrown/lost reply is never resubmitted.
      const providerRequestId=await this.runtime.submit(request);
      await this.execution.recordSubmissionReceipt(lease,providerRequestId);
      const result=await this.runtime.result(providerRequestId);
      await this.execution.recordResponse(lease,providerRequestId,result.history);
      const asset=await this.assets.upload(actorId,projectId,result.bytes,'image/png',`resize-${runId}.png`);
      if(asset.width!==claim.snapshot.parameters.width||asset.height!==claim.snapshot.parameters.height)throw Error('OUTPUT_DIMENSIONS_MISMATCH');
      // Re-read immutable bytes before the final database transaction.
      const archived=await this.assets.download(actorId,projectId,asset.id);
      if(createHash('sha256').update(archived.bytes).digest('hex')!==asset.sha256)throw Error('ASSET_INTEGRITY_FAILED');
      return await this.execution.complete(lease,{assetId:asset.id,sha256:asset.sha256,providerRequestId});
    }catch(error){
      if(lease){try{await this.execution.stopAttempt(lease);}catch{/* Lease/permission loss must not permit a replay. */}}
      throw error;
    }finally{await this.runtime.close();}
  }
}
