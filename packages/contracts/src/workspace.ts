import { z } from "zod";

// A separate protocol: legacy CanvasDocument v2 is never silently reinterpreted.
const Id = z.uuid();
const Revision = z.number().int().positive();
export const WorkspaceParametersSchema = z.object({
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
}).strict().refine(p => p.width * p.height <= 16_000_000, "Output pixel limit exceeded");

export const WorkspaceAssetSchema = z.object({
  id: Id, projectId: Id, sha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.literal("ready"), mime: z.enum(["image/png","image/jpeg","image/webp"]),
}).strict();

const ObjectBase = {
  id: Id, projectId: Id, revision: Revision,
  title: z.string().max(240).optional(),
  deleted: z.boolean().optional(),
  locked: z.boolean().optional(), groupId: Id.nullable().optional(),
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().positive().finite(), height: z.number().positive().finite(),
};
export const WorkspaceObjectSchema = z.discriminatedUnion("type", [
  z.object({ ...ObjectBase, type: z.literal("image"), assetVersionId: Id }).strict(),
  z.object({ ...ObjectBase, type: z.literal("text"), text: z.string().max(100_000) }).strict(),
  z.object({ ...ObjectBase, type: z.literal("tool"), templateVersionId: Id }).strict(),
]);

export const WorkspaceCanvasOperationSchema=z.object({id:Id,baseRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),objects:z.array(WorkspaceObjectSchema).min(1).max(100)}).strict();
export const WorkspaceResultPlacementSchema=z.object({id:Id,baseRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),x:z.number().finite(),y:z.number().finite()}).strict();
export const DisplayEdgeSchema = z.object({
  id: Id, projectId: Id, sourceObjectId: Id, targetObjectId: Id,
  kind: z.literal("display"),
}).strict();

// Only the first three-node vertical slice is enabled. Other official node
// types will be added with their own port contracts, not accepted as arbitrary JSON.
export const WorkspaceWorkflowSchema = z.object({
  id: Id, projectId: Id, workflowId: Id, version: Revision,
  nodes: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    type: z.enum(["input.asset", "comfy.execute", "output.asset"]),
    config: z.object({ templateId: z.literal("core_image_resize_v2").optional() }).strict(),
  }).strict()).min(1).max(50),
  edges: z.array(z.object({
    source: z.string(), sourcePort: z.literal("asset"),
    target: z.string(), targetPort: z.literal("asset"),
  }).strict()).max(100),
}).strict();

export const WorkspaceTemplateSchema = z.object({
  id: Id, projectId: Id, templateId: Id, workflowVersionId: Id, version: Revision,
  operation: z.literal("image.resize"),
  parameters: z.literal("resize-parameters-v1"),
}).strict();

export const WorkspaceBindingRequestSchema = z.object({
  id: Id, projectId: Id, taskLineId: Id,
  sourceObjectId: Id, sourceObjectRevision: Revision,
  toolObjectId: Id, toolObjectRevision: Revision, templateVersionId: Id,
}).strict();

export type WorkspaceAsset = z.infer<typeof WorkspaceAssetSchema>;
export type WorkspaceObject = z.infer<typeof WorkspaceObjectSchema>;
export type WorkspaceWorkflow = z.infer<typeof WorkspaceWorkflowSchema>;
export type WorkspaceTemplate = z.infer<typeof WorkspaceTemplateSchema>;
export type WorkspaceBindingRequest = z.infer<typeof WorkspaceBindingRequestSchema>;
export type WorkspaceParameters = z.infer<typeof WorkspaceParametersSchema>;

const Sha256=z.string().regex(/^[a-f0-9]{64}$/);
export const WorkspaceRuntimeEvidenceSchema=z.object({
  schemaVersion:z.literal(1),adapterVersion:z.literal('local-owned-resize-v1'),
  runtimeKind:z.enum(['owned-cpu-comfy','contract-fixture-not-real']),
  runtimeRef:z.string().regex(/^(owned-comfy-worker|owned-fixture)-[a-f0-9-]{36}$/),
  compilerSourceSha256:Sha256,registrySha256:Sha256,pythonExecutableSha256:Sha256,bridgeSha256:Sha256,
  versions:z.object({python:z.string().max(256).nullable(),pytorch:z.string().max(256).nullable(),comfyui:z.string().max(256).nullable()}).strict(),
  coreFiles:z.array(z.object({path:z.enum(['nodes.py','execution.py','server.py','comfy/utils.py','comfy/model_management.py']),sha256:Sha256}).strict()).length(5),
}).strict().refine(value=>new Set(value.coreFiles.map(file=>file.path)).size===5,'Duplicate core source paths');
export type WorkspaceRuntimeEvidence=z.infer<typeof WorkspaceRuntimeEvidenceSchema>;
export const WorkspaceArtifactManifestSchema=z.object({
  schemaVersion:z.literal(1),projectId:Id,runId:Id,attemptId:Id,
  snapshotHash:Sha256,requestHash:Sha256,runtimeEvidenceHash:Sha256,
  providerRequestId:z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  sha256:Sha256,byteSize:z.number().int().min(1).max(8*1024*1024),mime:z.literal('image/png'),
  width:z.number().int().min(64).max(8192),height:z.number().int().min(64).max(8192),history:z.unknown(),
}).strict().refine(value=>value.width*value.height<=16_000_000,'Output pixel limit exceeded');
export type WorkspaceArtifactManifest=z.infer<typeof WorkspaceArtifactManifestSchema>;

export const ResizeParameterJsonSchema = z.toJSONSchema(WorkspaceParametersSchema, {
  unrepresentable: "any",
});
// The cross-field pixel rule must also be applied by WorkspaceParametersSchema.
export function workspaceJsonSchemas() {
  return {
    "resize-parameters.schema": ResizeParameterJsonSchema,
    "canvas-operation.schema":z.toJSONSchema(WorkspaceCanvasOperationSchema),
    "result-placement.schema":z.toJSONSchema(WorkspaceResultPlacementSchema),
    "object-revision.schema": z.toJSONSchema(WorkspaceObjectSchema),
    "workflow-version.schema": z.toJSONSchema(WorkspaceWorkflowSchema),
    "binding-request.schema": z.toJSONSchema(WorkspaceBindingRequestSchema),
    "runtime-evidence.schema":z.toJSONSchema(WorkspaceRuntimeEvidenceSchema),
    "artifact-manifest.schema":z.toJSONSchema(WorkspaceArtifactManifestSchema),
  };
}
