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
  projectId: IdSchema,
  constraintSnapshotId: IdSchema,
  status: z.enum(["draft", "awaiting_confirmation", "queued", "running", "partial", "succeeded", "failed", "cancelled"]),
  expectedOutputs: z.number().int().positive(),
  maxCostMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  confirmedBy: IdSchema.optional(),
  confirmedAt: IsoDateSchema.optional(),
  createdAt: IsoDateSchema,
}).strict();

export const RunJobSchema = z.object({
  id: IdSchema,
  batchId: IdSchema,
  executorKind: z.enum(["provider", "mcp", "mock"]),
  adapterId: IdSchema,
  idempotencyKey: IdSchema,
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "billing_unknown"]),
  retryOf: IdSchema.optional(),
  inputAssetIds: z.array(IdSchema),
  outputAssetIds: z.array(IdSchema),
  providerRequestId: z.string().min(1).optional(),
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
  projectId: IdSchema,
  batchId: IdSchema,
  jobId: IdSchema.optional(),
  currency: z.string().length(3),
  estimatedMinor: z.number().int().nonnegative(),
  reservedMinor: z.number().int().nonnegative(),
  actualMinor: z.number().int().nonnegative().optional(),
  settlement: z.enum(["reserved", "settled", "released", "unknown"]),
  createdAt: IsoDateSchema,
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
export type ConstraintSnapshot = z.infer<typeof ConstraintSnapshotSchema>;
export type RunBatch = z.infer<typeof RunBatchSchema>;
export type RunJob = z.infer<typeof RunJobSchema>;
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;
export type McpConnection = z.infer<typeof McpConnectionSchema>;
export type CostLedger = z.infer<typeof CostLedgerSchema>;
export type MockRunRequest = z.infer<typeof MockRunRequestSchema>;
export type MockRunResult = z.infer<typeof MockRunResultSchema>;
