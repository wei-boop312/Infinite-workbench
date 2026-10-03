import { z } from "zod";
import { CreateImagePreparationSchema, ImageExecutionRequestSchema, ImageInputTransformSchema, ImageProtocolSchema, ImageProviderConnectionSchema, ImageProviderOutcomeSchema, ImageRequestTemplateSchema, LocalImageQuoteSchema } from "./imageProviders.ts";

export * from "./imageProviders.ts";

export const CURRENT_CANVAS_SCHEMA_VERSION = 2 as const;

const IdSchema = z.string().trim().min(1).max(160);
const IsoDateSchema = z.iso.datetime({ offset: true });

function containsDataUrl(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") return /^data:/i.test(value.trim());
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((entry) => containsDataUrl(entry, seen));
}

export const CanvasNodeDataSchema = z.object({
  title: z.string().max(240),
  assetId: IdSchema.optional(),
  constraintSnapshotId: IdSchema.optional(),
  toolId: IdSchema.optional(),
}).catchall(z.unknown());

export const CanvasNodeSchema = z.object({
  id: IdSchema,
  type: z.enum(["image", "video", "text", "constraint", "tool", "output", "group", "note"]),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  size: z.object({ width: z.number().positive(), height: z.number().positive() }).strict().optional(),
  parentId: IdSchema.optional(),
  data: CanvasNodeDataSchema,
}).strict();

const EdgeBase = {
  id: IdSchema,
  source: IdSchema,
  target: IdSchema,
  sourceHandle: IdSchema.optional(),
  targetHandle: IdSchema.optional(),
};

export const WorkflowEdgeSchema = z.object({
  ...EdgeBase,
  kind: z.literal("workflow"),
  editable: z.literal(true),
  deletable: z.boolean(),
  dataType: z.enum(["image", "video", "text", "constraint"]).optional(),
}).strict();

export const LineageEdgeSchema = z.object({
  ...EdgeBase,
  kind: z.literal("lineage"),
  runJobId: IdSchema,
  editable: z.literal(false),
  deletable: z.literal(false),
}).strict();

export const CanvasEdgeSchema = z.discriminatedUnion("kind", [WorkflowEdgeSchema, LineageEdgeSchema]);

export const CanvasDocumentSchema = z.object({
  schemaVersion: z.literal(CURRENT_CANVAS_SCHEMA_VERSION),
  id: IdSchema,
  projectId: IdSchema,
  revision: z.number().int().nonnegative(),
  nodes: z.array(CanvasNodeSchema).max(10_000),
  edges: z.array(CanvasEdgeSchema).max(20_000),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().positive().max(8),
  }).strict(),
  updatedAt: IsoDateSchema,
}).strict().superRefine((document, context) => {
  if (containsDataUrl(document)) {
    context.addIssue({
      code: "custom",
      message: "画布文档禁止保存 Data URL；媒体必须通过 assetId 引用",
    });
  }
});

export const AssetSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  kind: z.enum(["image", "video", "audio", "document"]),
  purpose: z.enum(["source", "mask", "generated"]).optional(),
  sourceAssetId: IdSchema.optional(),
  originalName: z.string().trim().min(1).max(260),
  contentFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  storageKey: z.string().min(1),
  proxyStorageKey: z.string().min(1).optional(),
  mimeType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  createdAt: IsoDateSchema,
}).strict();

export const ObjectStoragePermissionSchema = z.enum(["asset:read", "asset:write"]);

// A server-issued receipt, never accepted as proof from a client request.
export const VerifiedImageSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  tenantId: IdSchema,
  asset: AssetSchema.extend({
    kind: z.literal("image"),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]),
    byteSize: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    contentFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
  registeredMetadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  decoder: z.literal("sharp-full-decode-v1"),
  verifiedBy: IdSchema,
  verifiedAt: IsoDateSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.asset.contentFingerprint !== `sha256:${receipt.checksumSha256}`) context.addIssue({ code: "custom", message: "图片摘要不一致", path: ["asset", "contentFingerprint"] });
  if (receipt.asset.purpose === "mask" && (!receipt.sourceChecksumSha256 || !receipt.asset.sourceAssetId || receipt.asset.mimeType !== "image/png")) {
    context.addIssue({ code: "custom", message: "蒙版缺少已验证底图", path: ["sourceChecksumSha256"] });
  }
});

const UploadObjectGrantRequestSchema = z.object({
  action: z.literal("upload"),
  projectId: IdSchema,
  assetId: IdSchema,
  mimeType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i),
  byteSize: z.number().int().nonnegative(),
  checksumSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

const DownloadObjectGrantRequestSchema = z.object({
  action: z.literal("download"),
  projectId: IdSchema,
  assetId: IdSchema,
  objectKey: z.string().trim().min(1).max(1024),
}).strict();

export const ObjectStorageGrantRequestSchema = z.discriminatedUnion("action", [
  UploadObjectGrantRequestSchema,
  DownloadObjectGrantRequestSchema,
]);

const ObjectStorageGrantBaseSchema = z.object({
  grantId: IdSchema,
  tenantId: IdSchema,
  projectId: IdSchema,
  assetId: IdSchema,
  objectKey: z.string().trim().min(1).max(1024),
  transferPath: z.string().startsWith("/v1/storage/transfers/"),
  expiresAt: IsoDateSchema,
  maxBytes: z.number().int().nonnegative(),
  requiredHeaders: z.record(z.string(), z.string()),
  singleUse: z.literal(true),
}).strict();

export const ObjectStorageGrantSchema = z.discriminatedUnion("action", [
  ObjectStorageGrantBaseSchema.extend({ action: z.literal("upload"), method: z.literal("PUT") }).strict(),
  ObjectStorageGrantBaseSchema.extend({ action: z.literal("download"), method: z.literal("GET") }).strict(),
]);

export const ConstraintSnapshotSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  lockedPaths: z.array(z.string().min(1)),
  editableRegions: z.array(z.object({
    id: IdSchema,
    description: z.string().min(1),
    maskAssetId: IdSchema.optional(),
  }).strict()),
  brandRules: z.record(z.string(), z.string()),
  outputSpec: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: z.enum(["png", "jpeg", "webp", "mp4"]),
  }).strict(),
  createdAt: IsoDateSchema,
}).strict();

export const ImagePreparationRecordSchema = z.object({
  schemaVersion: z.literal(1), id: IdSchema, tenantId: IdSchema, projectId: IdSchema,
  status: z.literal("unconfirmed"), executionAuthorized: z.literal(false), protocolPreparation: z.literal("not-run"),
  selection: CreateImagePreparationSchema, selectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  connection: ImageProviderConnectionSchema, requestTemplate: ImageRequestTemplateSchema,
  constraint: ConstraintSnapshotSchema, pricing: LocalImageQuoteSchema, createdBy: IdSchema, createdAt: IsoDateSchema,
}).strict().superRefine((record, context) => {
  const { selection, requestTemplate: template, connection, constraint, pricing } = record;
  const model = connection.models.find((item) => item.model === selection.model);
  if (record.tenantId !== connection.tenantId || template.tenantId !== record.tenantId
    || [selection.projectId, connection.projectId, template.projectId, constraint.projectId].some((id) => id !== record.projectId)
    || selection.connectionId !== connection.id || template.connectionId !== connection.id
    || selection.connectionRevision !== connection.revision || template.connectionRevision !== connection.revision
    || !model || model.version !== selection.capabilityVersion || template.capabilityVersion !== selection.capabilityVersion
    || template.adapterId !== connection.adapterId || template.model !== selection.model || !connection.enabled
    || selection.constraintSnapshotId !== constraint.id || template.constraintSnapshotId !== constraint.id
    || template.protection !== "none" || selection.protection !== "none" || constraint.lockedPaths.includes("product.pixels")
    || template.operation !== selection.operation || JSON.stringify(template.parameters) !== JSON.stringify(selection.parameters)
    || template.parameters.outputFormat !== constraint.outputSpec.format
    || (template.parameters.size !== "auto" && (template.parameters.size.width !== constraint.outputSpec.width || template.parameters.size.height !== constraint.outputSpec.height))
    || JSON.stringify(template.providerParameters) !== JSON.stringify(selection.providerParameters)
    || JSON.stringify(template.quote) !== JSON.stringify(pricing.quote)
    || JSON.stringify(template.inputs.map((item) => item.assetId)) !== JSON.stringify(selection.inputAssetIds)
    || (template.operation === "edit" ? template.mask?.assetId : undefined) !== (selection.operation === "edit" ? selection.maskAssetId : undefined)
    || Date.parse(record.createdAt) >= Date.parse(template.quote.expiresAt)) context.addIssue({ code: "custom", message: "图片准备单的冻结快照不一致" });
});

export const ConfirmImagePreparationSchema = z.object({
  expectedSnapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expectedEstimatedCostMinor: z.number().int().nonnegative(),
  expectedMaxCostMinor: z.number().int().nonnegative(),
  expectedCurrency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

// Private server evidence, not a confirmation payload accepted from the browser.
// Prepared wire bytes are rebuilt from immutable inputs before any future send.
export const ConfirmedImageExecutionSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal("local-fixture"), realExecutionEnabled: z.literal(false),
  batchId: IdSchema, preparation: ImagePreparationRecordSchema, request: ImageExecutionRequestSchema,
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  payloadChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/), payloadByteSize: z.number().int().positive().max(64 * 1024 * 1024),
  contentType: z.string().regex(/^(application\/json|multipart\/form-data; boundary=canvas-[a-f0-9]{40})$/),
  protocolVersion: z.literal("pure-image-protocol-v1"), transformedInputs: z.array(ImageInputTransformSchema).max(21),
  confirmedBy: IdSchema, confirmedAt: IsoDateSchema,
}).strict().superRefine((record, context) => {
  const { jobId: _job, idempotencyKey: _key, ...template } = record.request;
  const refs = record.request.operation === "edit" ? [...record.request.inputs, ...(record.request.mask ? [record.request.mask] : [])] : [];
  if (JSON.stringify(template) !== JSON.stringify(record.preparation.requestTemplate)
    || Date.parse(record.confirmedAt) < Date.parse(record.preparation.createdAt)
    || Date.parse(record.confirmedAt) >= Date.parse(record.request.quote.expiresAt)
    || refs.length !== record.transformedInputs.length
    || refs.some((ref, index) => record.transformedInputs[index]?.assetId !== ref.assetId
      || record.transformedInputs[index]?.originalChecksumSha256 !== ref.checksumSha256
      || (ref !== (record.request.operation === "edit" ? record.request.mask : undefined)
        ? record.transformedInputs[index]?.transform !== "exif-srgb-png-v1"
        : record.transformedInputs[index]?.transform === "exif-srgb-png-v1"))) {
    context.addIssue({ code: "custom", message: "图片确认、输入转换或执行快照不一致" });
  }
});
export type ConfirmImagePreparation = z.infer<typeof ConfirmImagePreparationSchema>;
export type ConfirmedImageExecution = z.infer<typeof ConfirmedImageExecutionSchema>;

// Durable write-ahead intent, NOT evidence of transport/response or asset authority.
export const ImageDispatchIntentSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal("local-fixture"), transport: z.literal("not-connected"),
  id: IdSchema, jobId: IdSchema, batchId: IdSchema, actorId: IdSchema, workerId: IdSchema, leaseId: IdSchema,
  executionFingerprint: z.string().regex(/^[a-f0-9]{64}$/), requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  payloadChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/), payloadByteSize: z.number().int().positive().max(64 * 1024 * 1024),
  contentType: z.string().regex(/^(application\/json|multipart\/form-data; boundary=canvas-[a-f0-9]{40})$/),
  inputTransformsFingerprint: z.string().regex(/^[a-f0-9]{64}$/), recordedAt: IsoDateSchema,
}).strict();
export type ImageDispatchIntent = z.infer<typeof ImageDispatchIntentSchema>;

// Server-only append-only evidence. "attempted" is not delivered/accepted.
export const ImageFixtureAttemptSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal("local-fixture"), transport: z.literal("local-fixture"), status: z.literal("attempted"),
  id: IdSchema, jobId: IdSchema, batchId: IdSchema, intentId: IdSchema, actorId: IdSchema, workerId: IdSchema, leaseId: IdSchema,
  executionFingerprint: z.string().regex(/^[a-f0-9]{64}$/), payloadChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/), attemptedAt: IsoDateSchema,
}).strict();
export type ImageFixtureAttempt = z.infer<typeof ImageFixtureAttemptSchema>;
const ImageFixtureResultBaseSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal("local-fixture"), id: IdSchema, attemptId: IdSchema, receivedAt: IsoDateSchema,
  outcome: ImageProviderOutcomeSchema,
}).strict();
export const ImageFixtureResultSchema = z.discriminatedUnion("kind", [
  ImageFixtureResultBaseSchema.extend({ kind: z.literal("returned"), status: z.number().int().min(100).max(599),
    contentType: z.string().min(1).max(256).regex(/^[\x20-\x7e]+$/), requestId: IdSchema.optional(),
    bodyChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/), bodyByteSize: z.number().int().nonnegative().max(32 * 1024 * 1024),
  }).strict(),
  ImageFixtureResultBaseSchema.extend({ kind: z.literal("interrupted"), failureCode: z.enum(["fixture-timeout", "fixture-transport-error", "fixture-response-invalid", "fixture-response-save-failed"]) }).strict(),
]);
export type ImageFixtureResult = z.infer<typeof ImageFixtureResultSchema>;

// Private artifact evidence; billing remains a separate, append-only decision.
export const ImageTaskArtifactSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal("local-fixture"), jobId: IdSchema, batchId: IdSchema,
  attemptId: IdSchema, resultId: IdSchema, assetId: IdSchema,
  executionFingerprint: z.string().regex(/^[a-f0-9]{64}$/), resultFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  generatedRecordFingerprint: z.string().regex(/^[a-f0-9]{64}$/), checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  committedBy: IdSchema, committedAt: IsoDateSchema,
}).strict();
export type ImageTaskArtifact = z.infer<typeof ImageTaskArtifactSchema>;
export const ImageTaskArtifactFailureSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal("local-fixture"), jobId: IdSchema, resultId: IdSchema,
  resultFingerprint: z.string().regex(/^[a-f0-9]{64}$/), stage: z.enum(["validation", "commit"]),
  code: z.string().regex(/^image_output_[a-z_]+$/).max(160), recordedBy: IdSchema, recordedAt: IsoDateSchema,
}).strict();
export type ImageTaskArtifactFailure = z.infer<typeof ImageTaskArtifactFailureSchema>;

// Immutable server output/provenance, never a client-submitted verification.
export const GeneratedImageRecordSchema = z.object({
  schemaVersion: z.literal(1),
  validation: z.literal("verified"), protectionApplied: z.literal("none"),
  protocol: ImageProtocolSchema,
  request: ImageExecutionRequestSchema,
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  payloadChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  transformedInputs: z.array(ImageInputTransformSchema).max(21),
  constraint: ConstraintSnapshotSchema,
  confirmedAt: IsoDateSchema,
  // Original protocol outcome is retained; it alone was NOT asset verification.
  providerOutcome: ImageProviderOutcomeSchema,
  image: VerifiedImageSchema,
}).strict().superRefine((record, context) => {
  const { request, providerOutcome: outcome, image, constraint } = record;
  const refs = request.operation === "edit" ? [...request.inputs, ...(request.mask ? [request.mask] : [])] : [];
  if (request.protection !== "none" || image.asset.purpose !== "generated" || image.sourceChecksumSha256 !== undefined
    || image.tenantId !== request.tenantId || image.asset.projectId !== request.projectId
    || outcome.tenantId !== request.tenantId || outcome.projectId !== request.projectId || outcome.jobId !== request.jobId
    || outcome.connectionId !== request.connectionId || outcome.requestFingerprint !== record.requestFingerprint
    || outcome.providerStatus !== "returned" || outcome.artifactStatus !== "pending-validation" || outcome.failureCode !== undefined || outcome.billing.state !== "unknown"
    || constraint.id !== request.constraintSnapshotId || constraint.projectId !== request.projectId || constraint.lockedPaths.includes("product.pixels")
    || image.asset.mimeType !== `image/${request.parameters.outputFormat}` || image.asset.mimeType !== `image/${constraint.outputSpec.format}`
    || image.asset.width !== constraint.outputSpec.width || image.asset.height !== constraint.outputSpec.height
    || (request.parameters.size !== "auto" && (image.asset.width !== request.parameters.size.width || image.asset.height !== request.parameters.size.height))
    || image.asset.sourceAssetId !== (request.operation === "edit" ? request.inputs[0].assetId : undefined)
    || Date.parse(record.confirmedAt) >= Date.parse(request.quote.expiresAt) || Date.parse(record.confirmedAt) > Date.parse(image.verifiedAt)
    || record.transformedInputs.length !== refs.length
    || refs.some((ref, index) => record.transformedInputs[index]?.assetId !== ref.assetId || record.transformedInputs[index]?.originalChecksumSha256 !== ref.checksumSha256
      || (ref !== (request.operation === "edit" ? request.mask : undefined) && record.transformedInputs[index]?.transform !== "exif-srgb-png-v1")
      || (ref === (request.operation === "edit" ? request.mask : undefined) && record.transformedInputs[index]?.transform === "exif-srgb-png-v1"))) {
    context.addIssue({ code: "custom", message: "生成图片的资产、确认、约束或谱系不一致" });
  }
});

export const RunBatchSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  projectId: IdSchema,
  constraintSnapshotId: IdSchema,
  tool: z.enum(["product-retouch", "image-generate", "image-edit"]),
  adapterId: IdSchema,
  inputAssetIds: z.array(IdSchema).max(21),
  idempotencyKey: IdSchema,
  mockScenario: z.enum(["success", "slow", "partial-failure", "failed", "billing-unknown"]).optional(),
  status: z.enum(["draft", "awaiting_confirmation", "queued", "running", "partial", "succeeded", "failed", "billing_unknown", "cancelled"]),
  expectedOutputs: z.number().int().positive(),
  estimatedCostMinor: z.number().int().nonnegative(),
  maxCostMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  confirmedBy: IdSchema.optional(),
  confirmedAt: IsoDateSchema.optional(),
  createdAt: IsoDateSchema,
}).strict().superRefine((batch, context) => {
  if (batch.tool === "product-retouch" ? (!batch.mockScenario || !batch.inputAssetIds.length || batch.inputAssetIds.length > 20)
    : (batch.mockScenario !== undefined || batch.expectedOutputs !== 1 || (batch.tool === "image-generate" ? batch.inputAssetIds.length !== 0 : batch.inputAssetIds.length === 0))) {
    context.addIssue({ code: "custom", message: "任务工具与输入或模拟场景不一致" });
  }
});

export const RunJobSchema = z.object({
  id: IdSchema,
  batchId: IdSchema,
  outputIndex: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  executorKind: z.enum(["provider", "mcp", "mock"]),
  adapterId: IdSchema,
  idempotencyKey: IdSchema,
  status: z.enum(["queued", "leased", "running", "succeeded", "failed", "timed_out", "cancelled", "billing_unknown"]),
  retryOf: IdSchema.optional(),
  inputAssetIds: z.array(IdSchema),
  outputAssetIds: z.array(IdSchema),
  estimatedCostMinor: z.number().int().nonnegative(),
  actualCostMinor: z.number().int().nonnegative().optional(),
  providerRequestId: z.string().min(1).optional(),
  leaseId: IdSchema.optional(),
  leaseOwnerId: IdSchema.optional(),
  leasedAt: IsoDateSchema.optional(),
  leaseExpiresAt: IsoDateSchema.optional(),
  billingResolutionId: IdSchema.optional(),
  billingResolvedAt: IsoDateSchema.optional(),
  billingResolvedBy: IdSchema.optional(),
  billingEvidenceRef: IdSchema.optional(),
  failureCode: IdSchema.optional(),
  startedAt: IsoDateSchema.optional(),
  finishedAt: IsoDateSchema.optional(),
  createdAt: IsoDateSchema,
}).strict();

export const ProviderConnectionSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  protocol: z.enum(["openai", "openai-compatible", "google", "custom"]),
  baseUrl: z.url(),
  authRef: IdSchema,
  capabilities: z.array(z.enum(["text", "image-generate", "image-edit", "video-generate", "embedding"])),
  enabled: z.boolean(),
}).strict();

export const McpConnectionSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  transport: z.enum(["stdio", "http", "sse"]),
  encryptedConfigRef: IdSchema,
  allowedTools: z.array(z.string().min(1)),
  writePolicy: z.enum(["deny", "confirm-each", "allow-scoped"]),
  enabled: z.boolean(),
}).strict();

export const CostLedgerSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  projectId: IdSchema,
  batchId: IdSchema,
  jobId: IdSchema.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  estimatedMinor: z.number().int().nonnegative(),
  reservedMinor: z.number().int().nonnegative(),
  actualMinor: z.number().int().nonnegative().optional(),
  settlement: z.enum(["estimated", "reserved", "settled", "released", "unknown"]),
  createdAt: IsoDateSchema,
}).strict();

export const CreateRunBatchRequestSchema = z.object({
  projectId: IdSchema,
  constraintSnapshotId: IdSchema,
  tool: z.literal("product-retouch"),
  inputAssetIds: z.array(IdSchema).min(1).max(20).refine((items) => new Set(items).size === items.length, "输入资产不能重复"),
  expectedOutputs: z.number().int().min(1).max(20),
  maxCostMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  idempotencyKey: IdSchema,
  mockScenario: z.enum(["success", "slow", "partial-failure", "failed", "billing-unknown"]).default("success"),
}).strict();

export const ConfirmRunBatchRequestSchema = z.object({
  expectedEstimatedCostMinor: z.number().int().nonnegative(),
  expectedCurrency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const RetryRunJobRequestSchema = z.object({
  expectedEstimatedCostMinor: z.number().int().nonnegative(),
  expectedCurrency: z.string().regex(/^[A-Z]{3}$/),
  mockScenario: z.enum(["success", "slow", "partial-failure", "failed", "billing-unknown"]).default("success"),
}).strict();

export const ClaimRunJobsRequestSchema = z.object({
  workerId: IdSchema,
  maxJobs: z.number().int().min(1).max(20).default(1),
}).strict();

export const ExecuteRunJobRequestSchema = z.object({
  workerId: IdSchema,
  leaseId: IdSchema,
}).strict();

const ResolveBillingUnknownBaseSchema = z.object({
  resolutionId: IdSchema,
  expectedReservedMinor: z.number().int().nonnegative(),
  expectedCurrency: z.string().regex(/^[A-Z]{3}$/),
  evidenceRef: IdSchema,
}).strict();

export const ResolveBillingUnknownRequestSchema = z.discriminatedUnion("resolution", [
  ResolveBillingUnknownBaseSchema.extend({
    resolution: z.literal("charged"),
    actualCostMinor: z.number().int().positive(),
  }).strict(),
  ResolveBillingUnknownBaseSchema.extend({
    resolution: z.literal("not-charged"),
  }).strict(),
]);

export const RequestBillingOverageSchema = z.object({
  requestId: IdSchema,
  expectedReservedMinor: z.number().int().nonnegative(),
  expectedCurrency: z.string().regex(/^[A-Z]{3}$/),
  expectedBatchMaxCostMinor: z.number().int().nonnegative(),
  actualCostMinor: z.number().int().positive(),
  requestedBatchMaxCostMinor: z.number().int().nonnegative(),
  evidenceRef: IdSchema,
  reason: IdSchema,
}).strict();

export const ReviewBillingOverageSchema = z.object({
  reviewId: IdSchema,
  decision: z.enum(["approve", "reject"]),
  expectedReservedMinor: z.number().int().nonnegative(),
  expectedCurrency: z.string().regex(/^[A-Z]{3}$/),
  expectedActualCostMinor: z.number().int().positive(),
  expectedBatchMaxCostMinor: z.number().int().nonnegative(),
  expectedRequestedBatchMaxCostMinor: z.number().int().nonnegative(),
  evidenceRef: IdSchema,
  note: IdSchema,
}).strict();

const BillingOverageBaseSchema = z.object({
  id: IdSchema,
  jobId: IdSchema,
  requestId: IdSchema,
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requestedBy: IdSchema,
  requestedAt: IsoDateSchema,
  reservedMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  actualCostMinor: z.number().int().positive(),
  batchMaxCostMinor: z.number().int().nonnegative(),
  requestedBatchMaxCostMinor: z.number().int().nonnegative(),
  evidenceRef: IdSchema,
  reason: IdSchema,
}).strict();
const ReviewedBillingOverageFields = {
  reviewId: IdSchema,
  reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedBy: IdSchema,
  reviewedAt: IsoDateSchema,
  reviewEvidenceRef: IdSchema,
  reviewNote: IdSchema,
};
export const BillingOverageSchema = z.discriminatedUnion("status", [
  BillingOverageBaseSchema.extend({ status: z.literal("pending") }).strict(),
  BillingOverageBaseSchema.extend({ status: z.literal("approved"), ...ReviewedBillingOverageFields }).strict(),
  BillingOverageBaseSchema.extend({ status: z.literal("rejected"), ...ReviewedBillingOverageFields }).strict(),
]);

export const RunAuditEventSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  projectId: IdSchema,
  batchId: IdSchema,
  actorId: IdSchema,
  eventType: z.enum([
    "batch-created",
    "confirmation-rejected",
    "batch-confirmed",
    "budget-reserved",
    "jobs-created",
    "batch-dispatched",
    "job-leased",
    "job-lease-expired",
    "dispatch-throttled",
    "job-started",
    "image-fixture-attempted",
    "image-fixture-returned",
    "image-fixture-interrupted",
    "image-artifact-verified",
    "image-artifact-rejected",
    "job-succeeded",
    "job-failed",
    "job-timed-out",
    "billing-unknown",
    "billing-resolution-rejected",
    "billing-resolved-charged",
    "billing-resolved-not-charged",
    "billing-overage-requested",
    "billing-overage-approved",
    "billing-overage-rejected",
    "billing-overage-review-blocked",
    "cost-settled",
    "job-retry-created",
    "batch-cancelled",
    "budget-released",
  ]),
  metadata: z.record(z.string(), z.string()),
  createdAt: IsoDateSchema,
}).strict();

export const ProjectBudgetSnapshotSchema = z.object({
  tenantId: IdSchema,
  projectId: IdSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  limitMinor: z.number().int().nonnegative(),
  reservedMinor: z.number().int().nonnegative(),
  spentMinor: z.number().int().nonnegative(),
  availableMinor: z.number().int().nonnegative(),
}).strict();

export const RunBatchAggregateSchema = z.object({
  batch: RunBatchSchema,
  jobs: z.array(RunJobSchema),
  ledger: z.array(CostLedgerSchema),
  audit: z.array(RunAuditEventSchema),
  billingOverages: z.array(BillingOverageSchema).default([]),
}).strict();

export const RunBatchListSchema = z.array(RunBatchAggregateSchema);

export const RegisterRunContextRequestSchema = z.object({
  projectId: IdSchema,
  assets: z.array(AssetSchema).max(10_000),
  constraints: z.array(ConstraintSnapshotSchema).max(10_000),
}).strict();

export const LocalRunCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(RegisterRunContextRequestSchema),
}).strict();

export const RunJobLeaseSchema = z.object({
  jobId: IdSchema,
  batchId: IdSchema,
  leaseId: IdSchema,
  workerId: IdSchema,
  leasedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
}).strict();

export const RunJobClaimResultSchema = z.object({
  aggregate: RunBatchAggregateSchema,
  leases: z.array(RunJobLeaseSchema),
  throttledBy: z.enum(["project-concurrency", "provider-concurrency", "provider-rate"]).optional(),
  retryAfterMs: z.number().int().positive().optional(),
}).strict();

export const RunKernelBudgetStateSchema = z.object({
  tenantId: IdSchema,
  projectId: IdSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  limitMinor: z.number().int().nonnegative(),
  reservedMinor: z.number().int().nonnegative(),
  spentMinor: z.number().int().nonnegative(),
}).strict();

export const RunKernelStoredBatchSchema = z.object({
  aggregate: RunBatchAggregateSchema,
  imageExecution: ConfirmedImageExecutionSchema.optional(),
  imageDispatchIntent: ImageDispatchIntentSchema.optional(),
  imageDispatchIntentFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  imageFixtureAttempt: ImageFixtureAttemptSchema.optional(),
  imageFixtureAttemptFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  imageFixtureResult: ImageFixtureResultSchema.optional(),
  imageFixtureResultFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  imageTaskArtifact: ImageTaskArtifactSchema.optional(),
  imageTaskArtifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  imageTaskArtifactFailures: z.array(ImageTaskArtifactFailureSchema).max(16).optional(),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reservedMinor: z.number().int().nonnegative(),
  actualMinor: z.number().int().nonnegative(),
  jobReservations: z.array(z.tuple([IdSchema, z.number().int().nonnegative()])),
  jobScenarios: z.array(z.tuple([
    IdSchema,
    z.enum(["success", "slow", "partial-failure", "failed", "billing-unknown"]),
  ])),
}).strict();

export const RunKernelSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  savedAt: IsoDateSchema,
  budgets: z.array(RunKernelBudgetStateSchema),
  batches: z.array(RunKernelStoredBatchSchema),
}).strict();

export const MockRunRequestSchema = z.object({
  projectId: IdSchema,
  tool: z.literal("product-retouch"),
  inputAssetIds: z.array(IdSchema).min(1),
  constraints: z.object({
    productLocked: z.literal(true),
    brandLocked: z.boolean(),
    editableRegion: z.string().min(1),
  }).strict(),
  maxCost: z.literal(0),
}).strict();

export const MockRunResultSchema = z.object({
  executor: z.literal("mock"),
  status: z.literal("succeeded"),
  estimatedCost: z.literal(0),
  actualCost: z.literal(0),
  networkCalls: z.literal(0),
  outputAssetIds: z.array(IdSchema).min(1),
}).strict();

export type CanvasDocument = z.infer<typeof CanvasDocumentSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type VerifiedImage = z.infer<typeof VerifiedImageSchema>;
export type GeneratedImageRecord = z.infer<typeof GeneratedImageRecordSchema>;
export type ImagePreparationRecord = z.infer<typeof ImagePreparationRecordSchema>;
export type ObjectStoragePermission = z.infer<typeof ObjectStoragePermissionSchema>;
export type ObjectStorageGrantRequest = z.infer<typeof ObjectStorageGrantRequestSchema>;
export type ObjectStorageGrant = z.infer<typeof ObjectStorageGrantSchema>;
export type ConstraintSnapshot = z.infer<typeof ConstraintSnapshotSchema>;
export type RunBatch = z.infer<typeof RunBatchSchema>;
export type RunJob = z.infer<typeof RunJobSchema>;
export type CreateRunBatchRequest = z.infer<typeof CreateRunBatchRequestSchema>;
export type ConfirmRunBatchRequest = z.infer<typeof ConfirmRunBatchRequestSchema>;
export type RetryRunJobRequest = z.infer<typeof RetryRunJobRequestSchema>;
export type ClaimRunJobsRequest = z.infer<typeof ClaimRunJobsRequestSchema>;
export type ExecuteRunJobRequest = z.infer<typeof ExecuteRunJobRequestSchema>;
export type ResolveBillingUnknownRequest = z.infer<typeof ResolveBillingUnknownRequestSchema>;
export type RequestBillingOverage = z.infer<typeof RequestBillingOverageSchema>;
export type ReviewBillingOverage = z.infer<typeof ReviewBillingOverageSchema>;
export type BillingOverage = z.infer<typeof BillingOverageSchema>;
export type RunAuditEvent = z.infer<typeof RunAuditEventSchema>;
export type ProjectBudgetSnapshot = z.infer<typeof ProjectBudgetSnapshotSchema>;
export type RunBatchAggregate = z.infer<typeof RunBatchAggregateSchema>;
export type RegisterRunContextRequest = z.infer<typeof RegisterRunContextRequestSchema>;
export type RunJobLease = z.infer<typeof RunJobLeaseSchema>;
export type RunJobClaimResult = z.infer<typeof RunJobClaimResultSchema>;
export type RunKernelBudgetState = z.infer<typeof RunKernelBudgetStateSchema>;
export type RunKernelStoredBatch = z.infer<typeof RunKernelStoredBatchSchema>;
export type RunKernelSnapshot = z.infer<typeof RunKernelSnapshotSchema>;
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;
export type McpConnection = z.infer<typeof McpConnectionSchema>;
export type CostLedger = z.infer<typeof CostLedgerSchema>;
export type MockRunRequest = z.infer<typeof MockRunRequestSchema>;
export type MockRunResult = z.infer<typeof MockRunResultSchema>;
