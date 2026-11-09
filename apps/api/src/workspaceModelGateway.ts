import {WorkspaceModelCapabilitySchema,WorkspaceModelPreflightSchema,WorkspaceParametersSchema,type WorkspaceModelCapability} from '@canvas/contracts';
import {contentHash} from './workspacePrototype.ts';

// A server-owned catalog, not a provider-registration or arbitrary URL port.
// The current only execution route remains LocalBoundRuns + its owned worker.
export class WorkspaceModelGateway {
  constructor(private readiness:{compilerConfigured:boolean;localResizeExecutor:boolean}){}
  catalog():WorkspaceModelCapability[]{
    const local:WorkspaceModelCapability={id:'local-comfy-resize',version:1,operation:'image.resize',provider:'owned-cpu-comfy',model:null,readiness:this.readiness.compilerConfigured?(this.readiness.localResizeExecutor?'ready':'queue_only'):'not_configured',inputKinds:['image'],outputKind:'image',cost:{state:'known',amount:'0',currency:'USD',basis:'local-no-provider-charge'}};
    const disabled:WorkspaceModelCapability[]=[
      {id:'document-facts',operation:'document.extract',inputKinds:['document','image','text'],outputKind:'facts'},
      {id:'fact-analysis',operation:'text.analyze',inputKinds:['confirmed_facts'],outputKind:'analysis'},
      {id:'visual-plan',operation:'plan.draft',inputKinds:['confirmed_facts','text'],outputKind:'plan'},
    ].map(item=>({...item,version:1,provider:'unconfigured',model:null,readiness:'not_configured',cost:{state:'unknown',reason:'provider_not_configured'}} as WorkspaceModelCapability));
    return [local,...disabled].map(item=>WorkspaceModelCapabilitySchema.parse(item));
  }
  preflight(raw:unknown){
    const input=WorkspaceModelPreflightSchema.parse(raw),capability=this.catalog().find(item=>item.id===input.capabilityId);
    if(!capability)throw Error('CAPABILITY_NOT_FOUND');
    if(capability.version!==input.capabilityVersion)throw Error('CAPABILITY_CHANGED');
    if(capability.operation!==input.operation)throw Error('CAPABILITY_OPERATION_MISMATCH');
    // Unconfigured capabilities cannot accept arbitrary parameters as a staged
    // execution request. No model receives source data through this port.
    const parameters=input.operation==='image.resize'?WorkspaceParametersSchema.parse(input.parameters):null;
    if(parameters===null&&Object.keys(input.parameters).length)throw Error('CAPABILITY_NOT_CONFIGURED');
    return {capability,capabilityHash:contentHash(capability),parameters,status:capability.readiness==='not_configured'?'needs_configuration':capability.readiness==='queue_only'?'queue_only':'available',submitted:false as const,executionAuthorized:false as const};
  }
  resizeSnapshot(raw:unknown){
    const prepared=this.preflight({capabilityId:'local-comfy-resize',capabilityVersion:1,operation:'image.resize',parameters:raw});
    if(prepared.status==='needs_configuration')throw Error('CAPABILITY_NOT_CONFIGURED');
    return {capability:prepared.capability,capabilityHash:prepared.capabilityHash};
  }
}

export function validateResizeCapabilityPin(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='capability,capabilityHash')throw Error('SNAPSHOT_INTEGRITY_FAILED');
  const pin=raw as {capability:unknown;capabilityHash:unknown};const capability=WorkspaceModelCapabilitySchema.parse(pin.capability);
  const expected=new WorkspaceModelGateway({compilerConfigured:true,localResizeExecutor:capability.readiness==='ready'}).resizeSnapshot({width:64,height:64});
  if(contentHash(capability)!==pin.capabilityHash||contentHash(capability)!==expected.capabilityHash)throw Error('SNAPSHOT_INTEGRITY_FAILED');
  return capability;
}
