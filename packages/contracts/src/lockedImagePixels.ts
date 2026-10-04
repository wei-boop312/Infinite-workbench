import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().trim().min(1).max(160);
export const LockedImagePixelDraftSchema = z.object({
  schemaVersion: z.literal(1), validation: z.literal("pixel-verified-uncommitted"),
  artifactCommitted: z.literal(false), executionAuthorized: z.literal(false), realExecutionEnabled: z.literal(false), settlementAuthorized: z.literal(false),
  protectionApplied: z.literal("checked-not-applied"), normalizationVersion: z.literal("auto-orient-srgb-rgba8-v1"),
  maskPolicy: z.literal("white-alpha255-edit-otherwise-locked-v1"),
  tenantId: id, projectId: id, sourceAssetId: id, maskAssetId: id, constraintSnapshotId: id, constraintChecksumSha256: hash,
  sourceChecksumSha256: hash, maskChecksumSha256: hash, candidateChecksumSha256: hash,
  sourcePixelsSha256: hash, maskPixelsSha256: hash, candidatePixelsSha256: hash,
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), byteSize: z.number().int().positive().max(20 * 1024 * 1024),
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  lockedPixels: z.number().int().positive(), editablePixels: z.number().int().positive(), lockedPixelsEqual: z.literal(true),
  validatedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((draft, context) => {
  if (draft.sourceAssetId === draft.maskAssetId || draft.width * draft.height > 16_000_000
    || draft.lockedPixels + draft.editablePixels !== draft.width * draft.height) context.addIssue({ code: "custom", message: "Invalid locked pixel draft relationship" });
});
export type LockedImagePixelDraft = z.infer<typeof LockedImagePixelDraftSchema>;
