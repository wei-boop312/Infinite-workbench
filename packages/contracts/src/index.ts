import { z } from "zod";

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

export const RunBatchSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  projectId: IdSchema,
  constraintSnapshotId: IdSchema,
  tool: z.literal("product-retouch"),
  adapterId: IdSchema,
  inputAssetIds: z.array(IdSchema).min(1).max(20),
  idempotencyKey: IdSchema,
  mockScenario: z.enum(["success", "slow", "partial-failure", "failed", "billing-unknown"]),
  status: z.enum(["draft", "awaiting_confirmation", "queued", "running", "partial", "succeeded", "failed", "billing_unknown", "cancelled"]),
  expectedOutputs: z.number().int().positive(),
  estimatedCostMinor: z.number().int().nonnegative(),
  maxCostMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  confirmedBy: IdSchema.optional(),
  confirmedAt: IsoDateSchema.optional(),
  createdAt: IsoDateSchema,
}).strict();

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
    "job-succeeded",
    "job-failed",
    "job-timed-out",
    "billing-unknown",
    "billing-resolution-rejected",
    "billing-resolved-charged",
    "billing-resolved-not-charged",
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
export type RunAuditEvent = z.infer<typeof RunAuditEventSchema>;
export type ProjectBudgetSnapshot = z.infer<typeof ProjectBudgetSnapshotSchema>;
export type RunBatchAggregate = z.infer<typeof RunBatchAggregateSchema>;
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
