import { z } from "zod";
import { ProductionImageBatchIdSchema } from "./productionImagePricing.ts";

const Id = z.string().min(1).max(160).refine(v => v === v.trim());
const Reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const DateTime = z.iso.datetime({ offset: true });
const Mode = z.enum(["production", "production-contract-fixture"]);
const Job = z.string().regex(/^production-image-job-[0-9a-f-]{36}$/);

// Human review of actual server-owned evidence. Neither this view nor its SHA
// grants settlement, execution, or access to the private request/response body.
export const ProductionImageBillingSnapshotSchema = z.object({
  schemaVersion: z.literal(1), mode: Mode, billing: z.literal("unknown"),
  settlementAuthorized: z.literal(false), executionAuthorized: z.literal(false), realExecutionEnabled: z.literal(false),
  tenantId: Id, projectId: Id, batchId: ProductionImageBatchIdSchema, jobId: Job,
  taskEvidenceFingerprint: Hash, executionFingerprint: Hash, preparationFingerprint: Hash,
  requestFingerprint: Hash, payloadChecksumSha256: Hash, transformedInputsFingerprint: Hash, constraintChecksumSha256: Hash,
  leaseFingerprint: Hash, leaseId: Id, workerId: Id, originalActorId: Id,
  intentFingerprint: Hash, attemptFingerprint: Hash.nullable(), resultFingerprint: Hash.nullable(), artifactFingerprint: Hash.nullable(),
  outputAssetIds: z.array(Id).max(1), unknownAt: DateTime, unknownReason: Id,
  currency: z.string().regex(/^[A-Z]{3}$/), reservedMinor: Money, maxCostMinor: Money,
  estimate: z.discriminatedUnion("state", [
    z.object({ state: z.literal("known"), estimatedCostMinor: Money }).strict(),
    z.object({ state: z.literal("unknown") }).strict(),
  ]),
}).strict().superRefine((v, ctx) => {
  if (v.reservedMinor !== v.maxCostMinor || (v.estimate.state === "known" && v.estimate.estimatedCostMinor > v.maxCostMinor)
    || (!!v.artifactFingerprint !== (v.outputAssetIds.length === 1)) || (v.artifactFingerprint && (!v.resultFingerprint || !v.attemptFingerprint)))
    ctx.addIssue({ code: "custom", message: "生产核账快照的金额或原产物关系不一致" });
});
export type ProductionImageBillingSnapshot = z.infer<typeof ProductionImageBillingSnapshotSchema>;

export const ReviewProductionImageBillingSchema = z.object({
  reviewId: Reference, expectedSnapshotFingerprint: Hash,
  expectedCurrency: z.string().regex(/^[A-Z]{3}$/), expectedReservedMinor: Money, expectedMaxCostMinor: Money,
  resolution: z.enum(["charged", "not-charged"]), actualCostMinor: Money,
  evidence: z.object({ sourceId: Reference, sourceVersion: Reference, evidenceRef: Reference,
    checksumSha256: Hash, observedAt: DateTime }).strict(),
}).strict().refine(v => v.resolution === "not-charged" ? v.actualCostMinor === 0 : v.actualCostMinor > 0,
  { message: "费用结论与人工核实金额不一致" });
export type ReviewProductionImageBilling = z.infer<typeof ReviewProductionImageBillingSchema>;

// Ephemeral result only. B must re-read the actual task and independently
// validate the configured billing source inside its final task transaction.
export const ProductionImageBillingReviewSchema = z.object({
  schemaVersion: z.literal(1), mode: Mode, validation: z.literal("verified-uncommitted"),
  settlementCommitted: z.literal(false), settlementAuthorized: z.literal(false),
  executionAuthorized: z.literal(false), realExecutionEnabled: z.literal(false),
  snapshot: ProductionImageBillingSnapshotSchema, snapshotFingerprint: Hash,
  request: ReviewProductionImageBillingSchema, reviewedBy: Id, reviewedAt: DateTime,
  sourceKind: z.enum(["server-billing", "contract-fixture"]),
  requiresIndependentOverageApproval: z.boolean(),
}).strict().superRefine((v, ctx) => {
  if (v.mode !== v.snapshot.mode || (v.mode === "production" ? v.sourceKind !== "server-billing" : v.sourceKind !== "contract-fixture")
    || v.request.expectedSnapshotFingerprint !== v.snapshotFingerprint || v.request.expectedCurrency !== v.snapshot.currency
    || v.request.expectedReservedMinor !== v.snapshot.reservedMinor || v.request.expectedMaxCostMinor !== v.snapshot.maxCostMinor
    || v.requiresIndependentOverageApproval !== (v.request.actualCostMinor > v.snapshot.reservedMinor)
    || Date.parse(v.reviewedAt) < Date.parse(v.snapshot.unknownAt) || Date.parse(v.reviewedAt) < Date.parse(v.request.evidence.observedAt))
    ctx.addIssue({ code: "custom", message: "生产费用核验草稿与原人工期待不一致" });
});
export type ProductionImageBillingReview = z.infer<typeof ProductionImageBillingReviewSchema>;

export const DecideProductionImageBillingSchema = z.object({
  decisionId: Reference, expectedRecordFingerprint: Hash, expectedSnapshotFingerprint: Hash,
  expectedCurrency: z.string().regex(/^[A-Z]{3}$/), expectedReservedMinor: Money, expectedActualCostMinor: Money,
  decision: z.enum(["approve", "reject"]), evidenceRef: Reference, note: z.string().min(1).max(240),
}).strict();
export type DecideProductionImageBilling = z.infer<typeof DecideProductionImageBillingSchema>;

// Persisted human conclusion, separate from the uncommitted A review and from
// the provider response/price. Only a current actual task transaction commits it.
export const ProductionImageBillingRecordSchema = z.object({
  schemaVersion: z.literal(1), mode: Mode, snapshot: ProductionImageBillingSnapshotSchema, snapshotFingerprint: Hash,
  request: ReviewProductionImageBillingSchema, reviewedBy: Id, reviewedAt: DateTime,
  sourceKind: z.enum(["server-billing", "contract-fixture"]),
  status: z.enum(["pending", "rejected", "settled"]),
  decision: z.object({ request: DecideProductionImageBillingSchema, decidedBy: Id, decidedAt: DateTime }).strict().optional(),
  executionAuthorized: z.literal(false), realExecutionEnabled: z.literal(false),
}).strict().superRefine((v, ctx) => {
  const over = v.request.actualCostMinor > v.snapshot.reservedMinor;
  if (v.mode !== v.snapshot.mode || (v.mode === "production" ? v.sourceKind !== "server-billing" : v.sourceKind !== "contract-fixture")
    || v.request.expectedSnapshotFingerprint !== v.snapshotFingerprint || v.request.expectedCurrency !== v.snapshot.currency
    || v.request.expectedReservedMinor !== v.snapshot.reservedMinor || v.request.expectedMaxCostMinor !== v.snapshot.maxCostMinor
    || Date.parse(v.reviewedAt) < Math.max(Date.parse(v.snapshot.unknownAt), Date.parse(v.request.evidence.observedAt))
    || Date.parse(v.request.evidence.observedAt) < Date.parse(v.snapshot.unknownAt)
    || (!over && (v.status !== "settled" || v.decision)) || (over && (v.status === "pending" ? !!v.decision : !v.decision))
    || (v.decision && (v.decision.decidedBy === v.reviewedBy || Date.parse(v.decision.decidedAt) < Date.parse(v.reviewedAt)
      || v.decision.request.expectedSnapshotFingerprint !== v.snapshotFingerprint || v.decision.request.expectedCurrency !== v.snapshot.currency
      || v.decision.request.expectedReservedMinor !== v.snapshot.reservedMinor || v.decision.request.expectedActualCostMinor !== v.request.actualCostMinor
      || v.status !== (v.decision.request.decision === "approve" ? "settled" : "rejected"))))
    ctx.addIssue({ code: "custom", message: "生产核账结论、原期待或独立审批关系不一致" });
});
export type ProductionImageBillingRecord = z.infer<typeof ProductionImageBillingRecordSchema>;

export const ProductionImageBillingSummarySchema = z.object({
  reviewId: Reference, status: z.enum(["pending", "rejected", "settled"]), currency: z.string().regex(/^[A-Z]{3}$/),
  originalMaxCostMinor: Money, actualCostMinor: Money, reviewedBy: Id, reviewedAt: DateTime,
  decisionId: Reference.optional(), decidedBy: Id.optional(), decidedAt: DateTime.optional(),
}).strict();
