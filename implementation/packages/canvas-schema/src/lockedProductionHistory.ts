import type { LockedGeneratedAssetProtection } from "@canvas/contracts";
import { parseProductionCanvasHistory, type ProductionCanvasHistory } from "./productionHistory.ts";

// Independent bounded v2 observations, not v1/none records, authority or a ledger.
export type LockedProductionCanvasHistory = Omit<ProductionCanvasHistory, "version" | "evidence" | "protocol"> & {
  version: 2; evidence: "production-locked-history" | "production-contract-fixture-locked-history" | "imported-copy-history";
  protocol: "openai" | "openai-compatible"; protection: LockedGeneratedAssetProtection;
  protectedSourceAssetId: string; protectedMaskAssetId: string;
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown) => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 160 && !/[\x00-\x1f\x7f]/.test(v);
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown, max: number) => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= max;
const date = (v: unknown) => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).sort().join() === fields.sort().join();
const inputFields = ["assetId","receiptId","checksumSha256","registeredMetadataSha256","mimeType","byteSize","width","height"];
const protectionFields = ["schemaVersion","observation","policyVersion","normalizationVersion","maskPolicy","protectionApplied","domain","lockedPixelsEqual",
  "policyFingerprint","pixelProofFingerprint","source","mask","sourcePixelsSha256","maskPixelsSha256","candidatePixelsSha256","outputChecksumSha256",
  "lockedPixels","editablePixels","policyVerifiedAt","outputValidatedAt"];
function validInput(v: unknown, mask = false): v is Record<string, unknown> {
  return record(v) && exact(v, [...inputFields, ...(mask ? ["sourceAssetId","sourceChecksumSha256"] : [])])
    && id(v.assetId) && id(v.receiptId) && hash(v.checksumSha256) && hash(v.registeredMetadataSha256)
    && typeof v.mimeType === "string" && ["image/png","image/jpeg","image/webp"].includes(v.mimeType)
    && integer(v.byteSize, 30 * 1024 * 1024) && integer(v.width,8192) && integer(v.height,8192) && Number(v.width) * Number(v.height) <= 16_000_000;
}
export function parseLockedProductionCanvasHistory(value: unknown): LockedProductionCanvasHistory {
  if (!record(value) || new TextEncoder().encode(JSON.stringify(value)).length > 16 * 1024) throw new Error("保护历史无效或超限。");
  const { version, evidence, protection: p, protectedSourceAssetId: sourceId, protectedMaskAssetId: maskId, ...common } = value;
  // Only share validation of common historical money/IDs, never coerce a task,
  // cache or persisted v2 observation into a v1 record.
  const base = parseProductionCanvasHistory({ ...common, version: 1, evidence: common.mode === "production" ? "production-history" : "production-contract-fixture-history" });
  if (version !== 2 || typeof evidence !== "string" || ![`${base.mode}-locked-history`, "imported-copy-history"].includes(evidence)
    || !["openai","openai-compatible"].includes(base.protocol) || !id(sourceId) || !id(maskId) || sourceId === maskId
    || base.inputAssetIds.length < 2 || base.inputAssetIds[0] !== sourceId || base.inputAssetIds.at(-1) !== maskId
    || !record(p) || !exact(p, [...protectionFields]) || p.schemaVersion !== 1 || p.observation !== "stored-output-pixel-evidence"
    || p.policyVersion !== "locked-image-input-policy-v1" || p.normalizationVersion !== "auto-orient-srgb-rgba8-v1"
    || p.maskPolicy !== "white-alpha255-edit-otherwise-locked-v1" || p.protectionApplied !== "checked-not-applied"
    || p.domain !== "fixed-rgba8-only" || p.lockedPixelsEqual !== true
    || !["policyFingerprint","pixelProofFingerprint","sourcePixelsSha256","maskPixelsSha256","candidatePixelsSha256","outputChecksumSha256"].every(k => hash(p[k]))
    || !validInput(p.source) || !validInput(p.mask,true) || p.mask.mimeType !== "image/png"
    || p.source.assetId === p.mask.assetId || p.mask.sourceAssetId !== p.source.assetId || p.mask.sourceChecksumSha256 !== p.source.checksumSha256
    || p.source.width !== p.mask.width || p.source.height !== p.mask.height
    || !integer(p.lockedPixels,16_000_000) || !integer(p.editablePixels,16_000_000)
    || Number(p.lockedPixels) + Number(p.editablePixels) !== Number(p.source.width) * Number(p.source.height)
    || base.inputChecksums[0] !== p.source.checksumSha256 || base.inputChecksums.at(-1) !== p.mask.checksumSha256
    || p.outputChecksumSha256 !== base.checksumSha256 || !date(p.policyVerifiedAt) || !date(p.outputValidatedAt)
    || Date.parse(p.policyVerifiedAt as string) > Date.parse(base.confirmedAt) || Date.parse(base.confirmedAt) > Date.parse(p.outputValidatedAt as string)
    || (evidence !== "imported-copy-history" && (sourceId !== p.source.assetId || maskId !== p.mask.assetId))) throw new Error("保护历史关系错配；不是服务器许可。");
  return structuredClone(value) as LockedProductionCanvasHistory;
}
export function assertLockedProductionNodeHistory(data: Record<string, unknown>, projectId: string) {
  if (data.lockedProductionGeneratedHistory === undefined) return;
  const h = parseLockedProductionCanvasHistory(data.lockedProductionGeneratedHistory);
  if (data.generatedHistory !== undefined || data.productionGeneratedHistory !== undefined || data.assetId !== h.assetId || data.runJobId !== h.jobId
    || data.runBatchId !== h.batchId || data.constraintSnapshotId !== h.constraintSnapshotId
    || (h.evidence !== "imported-copy-history" && h.originProjectId !== projectId)) throw new Error("保护节点与独立历史范围错配。");
}
