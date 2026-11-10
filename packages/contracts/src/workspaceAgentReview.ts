import {z} from 'zod';
import {WorkspaceParametersSchema} from './workspaceParameters.ts';
const Id=z.uuid(),Sha=z.string().regex(/^[a-f0-9]{64}$/),Revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const AgentReviewGrantRequestSchema=z.object({id:Id,level:z.enum(['L0','L1','L2','L3']),bindingIds:z.array(Id).min(1).max(20),ttlSeconds:z.number().int().min(30).max(600),maxActions:z.number().int().min(1).max(8),maxPixels:z.number().int().min(4096).max(16000000)}).strict();
export const AgentReviewScopeSchema=z.object({bindingId:Id,bindingHash:Sha,source:z.object({id:Id,revision:Revision,hash:Sha}).strict(),tool:z.object({id:Id,revision:Revision,hash:Sha}).strict(),asset:z.object({id:Id,sha256:Sha}).strict(),templateVersionId:Id,templateHash:Sha,workflowVersionId:Id,workflowHash:Sha}).strict();
export const AgentReviewGrantSchema=z.object({id:Id,projectId:Id,actorId:Id,mode:z.literal('review_only'),policyVersion:z.literal('local-agent-review-v1'),level:z.enum(['L0','L1','L2','L3']),scopes:z.array(AgentReviewScopeSchema).min(1).max(20),capabilityHash:Sha,maxActions:z.number().int().min(1).max(8),maxPixels:z.number().int().min(4096).max(16000000),maxProviderCost:z.literal('0'),currency:z.literal('USD'),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
export const AgentReviewProposalRequestSchema=z.object({id:Id,bindingId:Id,parameters:WorkspaceParametersSchema}).strict();
export const AgentReviewProposalSchema=z.object({
  id:Id,projectId:Id,grantId:Id,grantHash:Sha,actorId:Id,mode:z.literal('review_only'),policyVersion:z.literal('local-agent-review-v1'),toolName:z.literal('invoke_template'),toolVersion:z.literal('local-comfy-resize-v1'),
  arguments:z.object({bindingId:Id,parameters:WorkspaceParametersSchema}).strict(),argumentsHash:Sha,inputScope:AgentReviewScopeSchema,capabilityHash:Sha,maxProviderCost:z.literal('0'),currency:z.literal('USD'),expiresAt:z.iso.datetime(),approvalHash:Sha,
}).strict();
export const AgentReviewApprovalRequestSchema=z.object({hash:Sha,nonce:Id}).strict();
