import { z } from "zod";
import { ProductionImageBillingSnapshotSchema, ReviewProductionImageBillingSchema } from "./productionImageBilling.ts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().min(1).max(160).refine(v => v === v.trim());
// Independent protected namespace. Old none/local snapshots cannot acquire a
// policy or pixel proof by changing a label or filling an unknown estimate.
export const LockedProductionImageBillingSnapshotSchema = z.object({
  ...ProductionImageBillingSnapshotSchema.shape, schemaVersion: z.literal(2),
  protectionPolicyFingerprint: Hash, pixelProofFingerprint: Hash.nullable(),
}).strict().superRefine((v, ctx) => {
  if (v.reservedMinor !== v.maxCostMinor || (v.estimate.state === "known" && v.estimate.estimatedCostMinor > v.maxCostMinor)
    || (!!v.artifactFingerprint !== (v.outputAssetIds.length === 1)) || (!!v.artifactFingerprint !== !!v.pixelProofFingerprint)
    || (v.artifactFingerprint && (!v.resultFingerprint || !v.attemptFingerprint)))
    ctx.addIssue({ code: "custom", message: "保护核账快照的原政策、产物或金额不一致" });
});
export type LockedProductionImageBillingSnapshot = z.infer<typeof LockedProductionImageBillingSnapshotSchema>;

export const ReviewLockedProductionImageBillingSchema = z.object({
  ...ReviewProductionImageBillingSchema.shape, expectedProtectionPolicyFingerprint: Hash,
}).strict().refine(v => v.resolution === "not-charged" ? v.actualCostMinor === 0 : v.actualCostMinor > 0,
  { message: "保护费用结论与人工金额不一致" });
export type ReviewLockedProductionImageBilling = z.infer<typeof ReviewLockedProductionImageBillingSchema>;

// A is a current server-owned read/verification, not a persisted fee or B permit.
export const LockedProductionImageBillingReviewSchema = z.object({
  schemaVersion: z.literal(2), mode: z.enum(["production", "production-contract-fixture"]),
  validation: z.literal("verified-uncommitted"), settlementCommitted: z.literal(false), settlementAuthorized: z.literal(false),
  executionAuthorized: z.literal(false), realExecutionEnabled: z.literal(false),
  snapshot: LockedProductionImageBillingSnapshotSchema, snapshotFingerprint: Hash,
  request: ReviewLockedProductionImageBillingSchema, reviewedBy: Id, reviewedAt: z.iso.datetime({ offset: true }),
  sourceKind: z.enum(["server-billing", "contract-fixture"]), requiresIndependentOverageApproval: z.boolean(),
}).strict().superRefine((v, ctx) => {
  if (v.mode !== v.snapshot.mode || (v.mode === "production" ? v.sourceKind !== "server-billing" : v.sourceKind !== "contract-fixture")
    || v.request.expectedSnapshotFingerprint !== v.snapshotFingerprint || v.request.expectedProtectionPolicyFingerprint !== v.snapshot.protectionPolicyFingerprint
    || v.request.expectedCurrency !== v.snapshot.currency || v.request.expectedReservedMinor !== v.snapshot.reservedMinor
    || v.request.expectedMaxCostMinor !== v.snapshot.maxCostMinor
    || v.requiresIndependentOverageApproval !== (v.request.actualCostMinor > v.snapshot.reservedMinor)
    || Date.parse(v.request.evidence.observedAt) < Date.parse(v.snapshot.unknownAt)
    || Date.parse(v.reviewedAt) < Math.max(Date.parse(v.snapshot.unknownAt), Date.parse(v.request.evidence.observedAt)))
    ctx.addIssue({ code: "custom", message: "保护核账草稿与原人工期待不一致" });
});
export type LockedProductionImageBillingReview = z.infer<typeof LockedProductionImageBillingReviewSchema>;
