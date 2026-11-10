// Independent portable observations. Never a cache marker, server permission or ledger.
export type ProductionCanvasHistory = {
  version: 1; evidence: "production-history" | "production-contract-fixture-history" | "imported-copy-history";
  mode: "production" | "production-contract-fixture"; tenantId: string; originProjectId: string;
  batchId: string; jobId: string; assetId: string; inputAssetIds: string[]; inputChecksums: string[];
  constraintSnapshotId: string; constraintChecksumSha256: string; protocol: "openai" | "openai-compatible" | "google";
  connectionId: string; connectionRevision: number; model: string; capabilityVersion: string; preparationId: string;
  artifactFingerprint: string; preparationFingerprint: string; pricingFingerprint: string; executionFingerprint: string;
  requestFingerprint: string; payloadChecksumSha256: string; checksumSha256: string;
  confirmedBy: string; confirmedAt: string; currency: string; estimateState: "known" | "unknown";
  estimatedCostMinor: number | null; maxCostMinor: number; currentMaxCostMinor: number;
  billingState: "unknown" | "settled"; reservedMinor: number; actualMinor?: number; observedAt: string;
};
const ids = ["tenantId", "originProjectId", "batchId", "jobId", "assetId", "constraintSnapshotId", "connectionId", "model", "capabilityVersion", "preparationId", "confirmedBy"];
const hashes = ["constraintChecksumSha256", "artifactFingerprint", "preparationFingerprint", "pricingFingerprint", "executionFingerprint", "requestFingerprint", "payloadChecksumSha256", "checksumSha256"];
const fields = [...ids, ...hashes, "version", "evidence", "mode", "inputAssetIds", "inputChecksums", "protocol", "connectionRevision", "confirmedAt", "currency", "estimateState", "estimatedCostMinor", "maxCostMinor", "currentMaxCostMinor", "billingState", "reservedMinor", "actualMinor", "observedAt"];
const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 160 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const money = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const date = (v: unknown) => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
export function parseProductionCanvasHistory(value: unknown): ProductionCanvasHistory {
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !fields.includes(k))
    || new TextEncoder().encode(JSON.stringify(v)).length > 16 * 1024 || v.version !== 1
    || typeof v.mode !== "string" || !["production", "production-contract-fixture"].includes(v.mode)
    || typeof v.evidence !== "string" || ![`${v.mode}-history`, "imported-copy-history"].includes(v.evidence)
    || !ids.every(k => id(v[k])) || !hashes.every(k => hash(v[k]))
    || !Array.isArray(v.inputAssetIds) || v.inputAssetIds.length > 21 || !v.inputAssetIds.every(id) || new Set(v.inputAssetIds).size !== v.inputAssetIds.length
    || !Array.isArray(v.inputChecksums) || v.inputChecksums.length !== v.inputAssetIds.length || !v.inputChecksums.every(hash)
    || typeof v.protocol !== "string" || !["openai", "openai-compatible", "google"].includes(v.protocol) || !Number.isSafeInteger(v.connectionRevision) || Number(v.connectionRevision) < 1
    || !date(v.confirmedAt) || !date(v.observedAt) || typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency)
    || !["maxCostMinor", "currentMaxCostMinor", "reservedMinor"].every(k => money(v[k])) || Number(v.currentMaxCostMinor) < Number(v.maxCostMinor)
    || (v.estimateState === "unknown" ? v.estimatedCostMinor !== null : v.estimateState !== "known" || !money(v.estimatedCostMinor) || Number(v.estimatedCostMinor) > Number(v.maxCostMinor))
    || (v.billingState === "unknown" ? v.actualMinor !== undefined || v.reservedMinor !== v.maxCostMinor
      : v.billingState !== "settled" || !money(v.actualMinor) || v.reservedMinor !== 0 || Number(v.actualMinor) > Number(v.currentMaxCostMinor))) throw new Error("独立生产历史关系无效；历史不是服务端授权。");
  return structuredClone(v) as ProductionCanvasHistory;
}
export function assertProductionNodeHistory(data: Record<string, unknown>, projectId: string) {
  if (data.productionGeneratedHistory === undefined) return;
  const h = parseProductionCanvasHistory(data.productionGeneratedHistory);
  if (data.generatedHistory !== undefined || data.assetId !== h.assetId || data.runJobId !== h.jobId || data.runBatchId !== h.batchId
    || data.constraintSnapshotId !== h.constraintSnapshotId || (h.evidence !== "imported-copy-history" && h.originProjectId !== projectId)) throw new Error("生产节点与独立历史范围错配。");
}
