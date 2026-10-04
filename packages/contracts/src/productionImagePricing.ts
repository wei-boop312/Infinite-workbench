import { z } from "zod";
import { ImageRequestTemplateSchema, ImageInputTransformSchema } from "./imageProviders.ts";

const Id = z.string().trim().min(1).max(160);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const DateTime = z.iso.datetime({ offset: true });
const Money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const QuoteBase = { id: Id, version: Id, currency: z.string().regex(/^[A-Z]{3}$/), maxCostMinor: Money, expiresAt: DateTime };

// A cap is NOT a price estimate; manual-budget deliberately has no estimate.
export const ProductionImageQuoteSchema = z.discriminatedUnion("source", [
  z.object({ ...QuoteBase, source: z.literal("server-price-table"), estimatedCostMinor: Money }).strict()
    .refine((q) => q.estimatedCostMinor <= q.maxCostMinor, { message: "估价不能超过上限" }),
  z.object({ ...QuoteBase, source: z.literal("manual-budget") }).strict(),
]);

// Quote-free, job-free draft. Neither a prepared wire payload nor send authority.
export const ProductionImageRequestDraftSchema = z.discriminatedUnion("operation", [
  ImageRequestTemplateSchema.options[0].omit({ quote: true }).strict(),
  ImageRequestTemplateSchema.options[1].omit({ quote: true }).strict(),
]);
// Syntactic protocol request only: job/key fields do not prove a persisted task,
// human confirmation, budget reservation, lease or permission to send.
export const ProductionImageExecutionRequestSchema = z.discriminatedUnion("operation", [
  ProductionImageRequestDraftSchema.options[0].extend({ jobId: Id, idempotencyKey: Id, quote: ProductionImageQuoteSchema }).strict(),
  ProductionImageRequestDraftSchema.options[1].extend({ jobId: Id, idempotencyKey: Id, quote: ProductionImageQuoteSchema }).strict(),
]);
export const ConfirmProductionImagePreparationSchema = z.object({
  expectedSnapshotFingerprint: Hash, expectedPricingFingerprint: Hash,
  expectedCurrency: z.string().regex(/^[A-Z]{3}$/), expectedMaxCostMinor: Money,
  estimate: z.discriminatedUnion("state", [
    z.object({ state: z.literal("known"), expectedEstimatedCostMinor: Money }).strict(),
    z.object({ state: z.literal("unknown") }).strict(),
  ]),
}).strict();
const Uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
export const ProductionImageTaskIdentitySchema = z.object({
  jobId: z.string().regex(new RegExp(`^production-image-job-${Uuid}$`)),
  idempotencyKey: z.string().regex(new RegExp(`^production-image-execution-${Uuid}$`)),
}).strict();
export const ProductionImageBatchIdSchema = z.string().regex(new RegExp(`^production-image-batch-${Uuid}$`));
export const PreparedProductionImageProtocolSnapshotSchema = z.object({
  schemaVersion: z.literal(1), mode: z.enum(["production", "production-contract-fixture"]),
  preparationId: Id, preparationFingerprint: Hash, pricingFingerprint: Hash,
  protocolVersion: z.literal("production-image-protocol-v1"), protocolPreparation: z.literal("prepared"),
  confirmationState: z.literal("unconfirmed"), executionAuthorized: z.literal(false), realExecutionEnabled: z.literal(false),
  request: ProductionImageExecutionRequestSchema, requestFingerprint: Hash, payloadChecksumSha256: Hash,
  payloadByteSize: z.number().int().positive().max(64 * 1024 * 1024),
  contentType: z.string().regex(/^(application\/json|multipart\/form-data; boundary=canvas-[a-f0-9]{40})$/),
  transformedInputs: z.array(ImageInputTransformSchema).max(21), preparedAt: DateTime, snapshotFingerprint: Hash,
}).strict().superRefine((p, ctx) => {
  if (!ProductionImageTaskIdentitySchema.safeParse({ jobId: p.request.jobId, idempotencyKey: p.request.idempotencyKey }).success
    || Date.parse(p.preparedAt) >= Date.parse(p.request.quote.expiresAt)) ctx.addIssue({ code: "custom", message: "生产候选身份或准备时间不一致" });
});
export const ProductionImagePriceScopeSchema = z.object({
  tenantId: Id, projectId: Id, actorId: Id, connectionId: Id,
  connectionRevision: z.number().int().positive(), model: Id, capabilityVersion: Id,
  operation: z.enum(["generate", "edit"]), basisFingerprint: Hash, selectionFingerprint: Hash,
}).strict();
const EvidenceBase = { sourceRevision: Id, evidenceRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/), checkedBy: Id, checkedAt: DateTime };
const PricingBase = { schemaVersion: z.literal(1), scope: ProductionImagePriceScopeSchema, quote: ProductionImageQuoteSchema };
export const ProductionImagePricingSchema = z.object({
  ...PricingBase,
  evidence: z.object({ ...EvidenceBase, kind: z.enum(["server-verified-price", "server-approved-budget"]) }).strict(),
}).strict().superRefine((p, ctx) => {
  if ((p.quote.source === "server-price-table" ? "server-verified-price" : "server-approved-budget") !== p.evidence.kind
    || Date.parse(p.evidence.checkedAt) >= Date.parse(p.quote.expiresAt)) ctx.addIssue({ code: "custom", message: "价格依据与来源或时间不一致" });
});
// Synthetic oracle tests cannot be promoted merely by changing record.mode.
export const FixtureProductionImagePricingSchema = z.object({
  ...PricingBase,
  evidence: z.object({ ...EvidenceBase, kind: z.literal("contract-fixture"), realExecutionEnabled: z.literal(false) }).strict(),
}).strict().refine((p) => Date.parse(p.evidence.checkedAt) < Date.parse(p.quote.expiresAt), { message: "假依据时间不一致" });

export type ProductionImageQuote = z.infer<typeof ProductionImageQuoteSchema>;
export type ProductionImageExecutionRequest = z.infer<typeof ProductionImageExecutionRequestSchema>;
export type ConfirmProductionImagePreparation = z.infer<typeof ConfirmProductionImagePreparationSchema>;
export type PreparedProductionImageProtocolSnapshot = z.infer<typeof PreparedProductionImageProtocolSnapshotSchema>;
export type ProductionImageRequestDraft = z.infer<typeof ProductionImageRequestDraftSchema>;
export type ProductionImagePriceScope = z.infer<typeof ProductionImagePriceScopeSchema>;
export type ProductionImagePricing = z.infer<typeof ProductionImagePricingSchema>;
export type FixtureProductionImagePricing = z.infer<typeof FixtureProductionImagePricingSchema>;
