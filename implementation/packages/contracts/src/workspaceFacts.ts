import {z} from 'zod';
const Id=z.uuid();
const FactEditFields={id:Id,name:z.string().trim().min(1).max(80),value:z.string().trim().min(1).max(1000),unit:z.string().trim().max(80),userConfirmed:z.boolean(),excluded:z.boolean()};
export const WorkspaceFactEditSchema=z.object(FactEditFields).strict().refine(value=>!(value.userConfirmed&&value.excluded),'Excluded fact cannot be confirmed');
export const WorkspaceDocumentFactSchema=z.object({...FactEditFields,
  confidence:z.null(),original:z.object({name:z.string().min(1).max(80),value:z.string().min(1).max(1000)}).strict(),
  source:z.object({line:z.number().int().positive(),start:z.number().int().nonnegative(),end:z.number().int().positive(),quote:z.string().min(1).max(1200)}).strict(),
  manuallyEdited:z.boolean(),unknown:z.boolean(),
}).strict().refine(value=>!(value.userConfirmed&&value.excluded),'Excluded fact cannot be confirmed');
export const WorkspaceFactRevisionSchema=z.object({
  projectId:Id,assetVersionId:Id,revision:z.number().int().positive(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),
  provenance:z.literal('deterministic-local-key-value-v1'),coordinateSystem:z.literal('decoded-utf8-no-bom-utf16'),
  facts:z.array(WorkspaceDocumentFactSchema).max(50),
  unparsedCount:z.number().int().nonnegative(),unparsed:z.array(z.object({line:z.number().int().positive(),reason:z.enum(['no_key_value','line_too_long','candidate_limit'])}).strict()).max(200),
  conflicts:z.array(z.object({name:z.string(),factIds:z.array(Id).min(2).max(50)}).strict()).max(50),
  authorId:Id,createdAt:z.iso.datetime(),
}).strict();
export const WorkspaceFactCommandSchema=z.discriminatedUnion('action',[
  z.object({id:Id,action:z.literal('extract')}).strict(),
  z.object({id:Id,action:z.literal('save'),baseRevision:z.number().int().positive(),facts:z.array(WorkspaceFactEditSchema).max(50)}).strict(),
]);
export type WorkspaceFactEdit=z.infer<typeof WorkspaceFactEditSchema>;
