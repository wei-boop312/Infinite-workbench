// Portable historical relationships, never a server permission or execution token.
export type GeneratedCanvasHistory = {
  version: 1;
  evidence: "local-fixture-history" | "imported-copy-history";
  originProjectId: string;
  batchId: string;
  jobId: string;
  assetId: string;
  inputAssetIds: string[];
  constraintSnapshotId: string;
  protocol: "openai" | "openai-compatible" | "google";
  connectionId: string;
  connectionRevision: number;
  model: string;
  capabilityVersion: string;
  preparationId: string;
  generatedRecordFingerprint: string;
  requestFingerprint: string;
  checksumSha256: string;
  confirmedBy: string;
  confirmedAt: string;
  currency: string;
  estimatedCostMinor: number;
  maxCostMinor: number;
  billingState: "unknown" | "settled";
  reservedMinor: number;
  actualMinor?: number;
  observedAt: string;
};
const fields = ["version", "evidence", "originProjectId", "batchId", "jobId", "assetId", "inputAssetIds", "constraintSnapshotId", "protocol", "connectionId", "connectionRevision", "model", "capabilityVersion", "preparationId", "generatedRecordFingerprint", "requestFingerprint", "checksumSha256", "confirmedBy", "confirmedAt", "currency", "estimatedCostMinor", "maxCostMinor", "billingState", "reservedMinor", "actualMinor", "observedAt"];
const id = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 160;
const amount = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const date = (v: unknown) => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
export function parseGeneratedCanvasHistory(value: unknown): GeneratedCanvasHistory {
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !fields.includes(k))
    || v.version !== 1 || !["local-fixture-history", "imported-copy-history"].includes(String(v.evidence))
    || !["originProjectId", "batchId", "jobId", "assetId", "constraintSnapshotId", "connectionId", "model", "capabilityVersion", "preparationId", "confirmedBy"].every(k => id(v[k]))
    || !Array.isArray(v.inputAssetIds) || v.inputAssetIds.length > 21 || !v.inputAssetIds.every(id) || new Set(v.inputAssetIds).size !== v.inputAssetIds.length
    || !["openai", "openai-compatible", "google"].includes(String(v.protocol)) || !Number.isSafeInteger(v.connectionRevision) || Number(v.connectionRevision) < 1
    || !["generatedRecordFingerprint", "requestFingerprint", "checksumSha256"].every(k => typeof v[k] === "string" && /^[a-f0-9]{64}$/.test(v[k] as string))
    // observedAt is the browser clock, not a trusted server time/authorization.
    || !date(v.confirmedAt) || !date(v.observedAt)
    || typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency)
    || !["estimatedCostMinor", "maxCostMinor", "reservedMinor"].every(k => amount(v[k])) || Number(v.estimatedCostMinor) > Number(v.maxCostMinor)
    || (v.billingState === "unknown" ? v.actualMinor !== undefined || v.reservedMinor !== v.maxCostMinor
      : v.billingState !== "settled" || !amount(v.actualMinor) || v.reservedMinor !== 0)) throw new Error("生成结果历史关系无效；历史不构成服务端授权。");
  return structuredClone(v) as GeneratedCanvasHistory;
}
export function assertGeneratedNodeHistory(data: Record<string, unknown>, projectId: string): void {
  if (data.generatedHistory === undefined) return;
  const history = parseGeneratedCanvasHistory(data.generatedHistory);
  if (data.assetId !== history.assetId || data.constraintSnapshotId !== history.constraintSnapshotId
    || data.runJobId !== history.jobId || data.runBatchId !== history.batchId
    || (history.evidence === "local-fixture-history" && history.originProjectId !== projectId)) throw new Error("生成结果节点与历史关系错配");
}
