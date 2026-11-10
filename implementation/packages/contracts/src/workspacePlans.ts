import {z} from 'zod';
import {WorkspaceDocumentFactSchema} from './workspaceFacts.ts';
const Id=z.uuid(),Revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const WorkspacePlanFactRefSchema=z.object({assetVersionId:Id,revision:Revision,factId:Id}).strict();
export const WorkspacePlanShotSchema=z.object({
  id:Id,title:z.string().trim().min(1).max(120),description:z.string().max(1000),copy:z.string().max(1000),angleConstraints:z.string().max(500),
  assetVersionIds:z.array(Id).max(10),output:z.object({width:z.number().int().min(64).max(8192),height:z.number().int().min(64).max(8192),format:z.enum(['png','jpeg','webp'])}).strict().refine(value=>value.width*value.height<=16000000,'Output pixel limit exceeded'),
}).strict();
export const WorkspacePlanDraftSchema=z.object({
  title:z.string().trim().min(1).max(240),goal:z.string().trim().min(1).max(2000),audience:z.string().max(1000),style:z.string().max(1000),
  assumptions:z.array(z.string().trim().min(1).max(500)).max(20),shots:z.array(WorkspacePlanShotSchema).min(1).max(20),
  factRefs:z.array(WorkspacePlanFactRefSchema).min(1).max(50),
}).strict();
export const WorkspacePlanCommandSchema=z.object({id:Id,baseRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),draft:WorkspacePlanDraftSchema}).strict();
export const WorkspacePlanRevisionSchema=z.object({
  id:Id,projectId:Id,revision:Revision,provenance:z.literal('manual-authoring-v1'),draft:WorkspacePlanDraftSchema,
  confirmedFacts:z.array(z.object({ref:WorkspacePlanFactRefSchema,sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),revisionHash:z.string().regex(/^[a-f0-9]{64}$/),factRevisionAuthorId:Id,fact:WorkspaceDocumentFactSchema}).strict()).min(1).max(50),
  assets:z.array(z.object({id:Id,sha256:z.string().regex(/^[a-f0-9]{64}$/),name:z.string(),mime:z.enum(['image/png','image/jpeg','image/webp'])}).strict()).max(50),
  authorId:Id,createdAt:z.iso.datetime(),
}).strict();
export type WorkspacePlanRevision=z.infer<typeof WorkspacePlanRevisionSchema>;
