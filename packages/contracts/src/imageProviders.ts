import { z } from "zod";

// These contracts describe server-managed configuration, not client authority.
const Id = z.string().trim().min(1).max(160);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const DateTime = z.iso.datetime({ offset: true });
const Integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Edge = z.number().int().min(1).max(8192);
const Mime = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const Format = z.enum(["png", "jpeg", "webp"]);
const Dimensions = z.object({ width: Edge, height: Edge }).strict();
const unique = <T>(values: T[]) => new Set(values).size === values.length;

const reservedParameters = new Set(["model", "prompt", "n", "size", "quality", "background", "input_fidelity", "output_format", "output_compression", "image", "images", "mask", "stream", "response_format", "user", "url", "base_url", "headers", "authorization", "api_key", "apikey", "credential", "constructor", "prototype"]);
const ExtraName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).refine((value) => !reservedParameters.has(value), "不能覆盖受保护参数");
const ProviderParameters = z.preprocess((value, context) => {
  // Zod intentionally ignores prototype-related record keys; reject them before
  // parsing so they cannot be silently discarded from a confirmation snapshot.
  if (value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).some((key) => !ExtraName.safeParse(key).success)) {
    context.addIssue({ code: "custom", message: "额外参数包含受保护或不合法的键" });
    return z.NEVER;
  }
  return value;
}, z.record(ExtraName, z.union([z.string().min(1).max(120), z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 16, "额外参数过多"));
const ExtraBase = { name: ExtraName, operations: z.array(z.enum(["generate", "edit"])).min(1).max(2).refine(unique) };
export const ImageExtraParameterRuleSchema = z.discriminatedUnion("type", [
  z.object({ ...ExtraBase, type: z.literal("enum"), values: z.array(z.string().min(1).max(120)).min(1).max(20).refine(unique) }).strict(),
  z.object({ ...ExtraBase, type: z.literal("integer"), minimum: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), maximum: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }).strict().refine((value) => value.minimum <= value.maximum, "参数区间无效"),
  z.object({ ...ExtraBase, type: z.literal("boolean") }).strict(),
]);
const RelativeEndpoint = z.string().max(160).regex(/^\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/);
export const ImageCompatibilityProfileSchema = z.object({
  version: Id,
  endpoints: z.object({ generate: RelativeEndpoint, edit: RelativeEndpoint }).strict(),
  editEncoding: z.enum(["json-images", "multipart-image-array", "multipart-image-single"]),
  auth: z.discriminatedUnion("scheme", [
    z.object({ scheme: z.literal("bearer") }).strict(),
    z.object({ scheme: z.literal("header"), headerName: z.enum(["x-api-key", "api-key", "x-access-token"]) }).strict(),
  ]),
  // Only the explicitly supported response shape; no scripts/JSONPath/eval.
  responseEncoding: z.literal("images-b64-json-v1"),
  extraParameters: z.array(ImageExtraParameterRuleSchema).max(16).refine((rules) => unique(rules.map((rule) => rule.name))),
}).strict();

export const ImageProtocolSchema = z.enum(["openai", "openai-compatible", "google", "custom"]);
export const ImageCapabilityEvidenceSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("declared") }).strict(),
  z.object({ state: z.literal("local-fixture-passed"), evidenceRef: Id, checkedAt: DateTime }).strict(),
  z.object({ state: z.literal("live-request-accepted"), evidenceRef: Id, checkedAt: DateTime }).strict(),
]);

export const ImageModelCapabilitySchema = z.object({
  model: Id,
  version: Id,
  operations: z.array(z.enum(["generate", "edit"])).min(1).max(2).refine(unique),
  inputMimeTypes: z.array(Mime).min(1).max(5).refine(unique),
  outputFormats: z.array(Format).min(1).max(3).refine(unique),
  maxInputImages: z.number().int().min(1).max(20),
  maxPromptCharacters: z.number().int().min(1).max(32_000),
  maxInputEdge: Edge,
  maxInputPixels: z.number().int().min(1).max(16_000_000),
  maxInputBytes: z.number().int().min(1).max(30 * 1024 * 1024),
  maxTotalInputBytes: z.number().int().min(1).max(100 * 1024 * 1024),
  sizes: z.object({
    allowAuto: z.boolean(),
    presets: z.array(Dimensions).max(100),
    custom: z.object({
      minEdge: Edge, maxEdge: Edge,
      multipleOf: z.number().int().min(1).max(8192),
      minPixels: Integer, maxPixels: Integer,
      maxAspectRatio: z.number().finite().min(1).max(100),
    }).strict().optional(),
  }).strict().superRefine((value, ctx) => {
    const custom = value.custom;
    if ((!value.allowAuto && !value.presets.length && !custom)
      || (custom && (custom.minEdge > custom.maxEdge || custom.minPixels > custom.maxPixels))
      || !unique(value.presets.map((size) => `${size.width}x${size.height}`))) {
      ctx.addIssue({ code: "custom", message: "无效尺寸能力" });
    }
  }),
  // Lists are per-model declarations; no protocol-wide implicit defaults.
  qualities: z.array(Id).min(1).max(20).refine(unique),
  backgrounds: z.array(z.enum(["auto", "opaque", "transparent"])).min(1).max(3).refine(unique),
  inputFidelities: z.array(z.enum(["low", "high"])).max(2).refine(unique),
  supportsOutputCompression: z.boolean(),
  mask: z.object({
    mode: z.enum(["none", "prompt-guidance"]),
    polarity: z.enum(["unsupported", "unverified", "transparent-edit", "white-edit"]),
  }).strict(),
  evidence: ImageCapabilityEvidenceSchema,
}).strict().superRefine((value, ctx) => {
  if ((value.mask.mode === "none") !== (value.mask.polarity === "unsupported")
    || (value.mask.mode !== "none" && !value.operations.includes("edit"))) {
    ctx.addIssue({ code: "custom", message: "蒙版能力不一致", path: ["mask"] });
  }
});

const Endpoint = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}, "供应商基础地址须为无凭证、查询参数和片段的 HTTPS 地址");

export const ImageProviderConnectionSchema = z.object({
  schemaVersion: z.literal(1),
  id: Id, tenantId: Id, projectId: Id, name: z.string().trim().min(1).max(120),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  protocol: ImageProtocolSchema,
  adapterId: Id,
  baseUrl: Endpoint,
  // Opaque server-side reference only. Never expose it through a public view.
  credentialRef: Id,
  enabled: z.boolean(),
  compatibility: ImageCompatibilityProfileSchema.optional(),
  models: z.array(ImageModelCapabilitySchema).min(1).max(100),
  diagnostic: z.discriminatedUnion("state", [
    z.object({ state: z.literal("not-run") }).strict(),
    z.object({ state: z.literal("reachable"), evidenceRef: Id, checkedAt: DateTime }).strict(),
    z.object({ state: z.literal("failed"), errorCode: Id, checkedAt: DateTime }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  if (!unique(value.models.map((model) => model.model))) context.addIssue({ code: "custom", message: "模型不能重复", path: ["models"] });
  if (value.compatibility && value.protocol !== "openai-compatible") context.addIssue({ code: "custom", message: "兼容差异配置仅适用于中转协议", path: ["compatibility"] });
});

export const ImageInputReferenceSchema = z.object({
  assetId: Id, checksumSha256: Hash, mimeType: Mime,
  byteSize: z.number().int().min(1).max(30 * 1024 * 1024),
  width: Edge, height: Edge,
}).strict();
export const ImageParametersSchema = z.object({
  prompt: z.string().trim().min(1).max(32_000),
  n: z.literal(1),
  size: z.union([z.literal("auto"), Dimensions]),
  quality: Id,
  outputFormat: Format,
  background: z.enum(["auto", "opaque", "transparent"]),
  inputFidelity: z.enum(["low", "high"]).optional(),
  outputCompression: z.number().int().min(0).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.background === "transparent" && value.outputFormat === "jpeg") ctx.addIssue({ code: "custom", message: "JPEG 不支持透明输出" });
  if (value.outputCompression !== undefined && value.outputFormat === "png") ctx.addIssue({ code: "custom", message: "PNG 不接受有损压缩参数" });
});

export const ImageQuoteSchema = z.object({
  id: Id, version: Id, source: z.enum(["server-price-table", "manual-budget"]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  estimatedCostMinor: Integer, maxCostMinor: Integer,
  expiresAt: DateTime,
}).strict().refine((value) => value.estimatedCostMinor <= value.maxCostMinor, "估算超过授权上限");

const RequestBase = {
  schemaVersion: z.literal(1), tenantId: Id, projectId: Id, jobId: Id, idempotencyKey: Id,
  connectionId: Id, connectionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  adapterId: Id, model: Id, capabilityVersion: Id,
  constraintSnapshotId: Id, constraintChecksumSha256: Hash,
  protection: z.enum(["none", "pixel-exact"]),
  parameters: ImageParametersSchema,
  providerParameters: ProviderParameters.optional(),
  quote: ImageQuoteSchema,
};
export const ImageExecutionRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...RequestBase, operation: z.literal("generate"), inputs: z.tuple([]) }).strict(),
  z.object({ ...RequestBase, operation: z.literal("edit"), inputs: z.array(ImageInputReferenceSchema).min(1).max(20).refine((inputs) => unique(inputs.map((input) => input.assetId))), mask: ImageInputReferenceSchema.optional() }).strict(),
]);

const Metrics = z.object({ inputTokens: Integer.optional(), outputTokens: Integer.optional(), totalTokens: Integer.optional(), images: Integer.optional() })
  .strict().refine((value) => Object.keys(value).length > 0, "实报用量不能为空");
export const ImageUsageSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("unavailable") }).strict(),
  z.object({ source: z.literal("provider-reported"), metrics: Metrics }).strict(),
  z.object({ source: z.literal("estimated"), quoteId: Id, quoteVersion: Id, currency: z.string().regex(/^[A-Z]{3}$/), estimatedCostMinor: Integer }).strict(),
]);
export const ImageBillingSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unknown") }).strict(),
  z.object({ state: z.literal("unbilled"), evidenceRef: Id }).strict(),
  z.object({ state: z.literal("charged"), costMinor: Integer, currency: z.string().regex(/^[A-Z]{3}$/), evidenceRef: Id, source: z.enum(["provider-reported", "human-reconciled"]) }).strict(),
]);
// An adapter returning bytes does not yet mean the job has a verified asset.
export const ImageProviderOutcomeSchema = z.object({
  schemaVersion: z.literal(1), tenantId: Id, projectId: Id, jobId: Id,
  connectionId: Id, requestFingerprint: Hash,
  providerRequestId: Id.optional(),
  providerStatus: z.enum(["returned", "rejected", "unknown"]),
  artifactStatus: z.enum(["pending-validation", "invalid", "absent"]),
  failureCode: Id.optional(),
  usage: ImageUsageSchema, billing: ImageBillingSchema,
}).strict().superRefine((value, ctx) => {
  if (value.artifactStatus === "pending-validation" && value.providerStatus !== "returned") ctx.addIssue({ code: "custom", message: "尚未返回的响应不能包含待验证产物" });
});

export type ImageProviderConnection = z.infer<typeof ImageProviderConnectionSchema>;
export type ImageModelCapability = z.infer<typeof ImageModelCapabilitySchema>;
export type ImageExecutionRequest = z.infer<typeof ImageExecutionRequestSchema>;
export type ImageProviderOutcome = z.infer<typeof ImageProviderOutcomeSchema>;
export type ImageCompatibilityProfile = z.infer<typeof ImageCompatibilityProfileSchema>;
