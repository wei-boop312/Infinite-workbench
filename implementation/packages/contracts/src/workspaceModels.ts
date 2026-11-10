import {z} from 'zod';
export const WorkspaceModelCostSchema=z.discriminatedUnion('state',[
  z.object({state:z.literal('known'),amount:z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/),currency:z.literal('USD'),basis:z.literal('local-no-provider-charge')}).strict(),
  z.object({state:z.literal('unknown'),reason:z.enum(['provider_not_configured','pricing_not_verified','usage_not_returned'])}).strict(),
]);
export const WorkspaceModelCapabilitySchema=z.object({
  id:z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),version:z.number().int().positive(),
  operation:z.enum(['image.resize','document.extract','text.analyze','plan.draft']),
  provider:z.enum(['owned-cpu-comfy','unconfigured']),model:z.string().min(1).max(160).nullable(),
  readiness:z.enum(['ready','queue_only','not_configured']),inputKinds:z.array(z.enum(['image','document','text','confirmed_facts'])).min(1).max(4),
  outputKind:z.enum(['image','facts','analysis','plan']),cost:WorkspaceModelCostSchema,
}).strict().superRefine((value,ctx)=>{
  const local=value.operation==='image.resize'&&value.provider==='owned-cpu-comfy'&&value.model===null;
  if((value.readiness!=='not_configured'&&!local)||(value.cost.state==='known'&&(!local||value.cost.amount!=='0'))||(!local&&value.cost.state!=='unknown'))ctx.addIssue({code:'custom',message:'Only the verified local resize has an executable zero-provider-cost policy'});
});
export const WorkspaceModelPreflightSchema=z.object({capabilityId:z.string().min(1).max(80),capabilityVersion:z.number().int().positive(),operation:z.enum(['image.resize','document.extract','text.analyze','plan.draft']),parameters:z.record(z.string(),z.unknown())}).strict();
export type WorkspaceModelCapability=z.infer<typeof WorkspaceModelCapabilitySchema>;
