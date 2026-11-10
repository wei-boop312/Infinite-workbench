import {z} from 'zod';
export const WorkspaceParametersSchema=z.object({
  width:z.number().int().min(64).max(8192),height:z.number().int().min(64).max(8192),
}).strict().refine(p=>p.width*p.height<=16_000_000,'Output pixel limit exceeded');
