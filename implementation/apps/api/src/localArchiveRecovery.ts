import {randomUUID} from 'node:crypto';
import {LocalRunExecution} from './localRunExecution.ts';
import {LocalRunArtifactStore} from './localRunArtifactStore.ts';
import {LocalWorkspaceAssets} from './localWorkspaceAssets.ts';
/** Archive-only: deliberately has no runtime, compiler, URL or prompt port. */
export class LocalArchiveRecovery {
  constructor(private execution:LocalRunExecution,private artifacts:LocalRunArtifactStore,private assets:LocalWorkspaceAssets){}
  async recover(actorId:string,projectId:string,runId:string){
    const claim=await this.execution.claimArchive(actorId,projectId,runId,randomUUID());
    if(claim.alreadyDone)return {state:'succeeded',reused:true,output:claim.output};
    try{
      const cached=await this.artifacts.load({projectId,runId,attemptId:claim.lease.attemptId},claim.artifact.manifestHash);
      const asset=await this.assets.upload(actorId,projectId,cached.bytes,'image/png',`resize-${runId}.png`);
      if(asset.sha256!==claim.artifact.manifest.sha256||asset.width!==claim.artifact.manifest.width||asset.height!==claim.artifact.manifest.height)throw Error('ARTIFACT_INTEGRITY_FAILED');
      const output=await this.execution.completeArchive(claim.lease,{assetId:asset.id,sha256:asset.sha256,providerRequestId:claim.artifact.manifest.providerRequestId});
      return {state:'succeeded',reused:false,output};
    }catch(error){try{await this.execution.failArchive(claim.lease);}catch{/* A revoked/expired lease cannot be reused. */}throw error;}
  }
}
