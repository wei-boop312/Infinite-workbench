import { ProductionImageResultSchema, type ProductionImageAttempt, type ConfirmedProductionImageExecution } from "@canvas/contracts";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { productionImageUnknownOutcome } from "./productionImageResponse";

// Metadata relations only. SQLite recovery ALSO reparses the original BLOB.
export function assertProductionImageResult(input: unknown, fingerprint: string, e: ConfirmedProductionImageExecution, a: ProductionImageAttempt) {
  const r = ProductionImageResultSchema.parse(input), outcome = r.outcome, request = e.protocol.request;
  if (fp(r) !== fingerprint || r.mode !== e.mode || r.attemptId !== a.id || r.attemptFingerprint !== fp(a)
    || r.intentFingerprint !== a.intentFingerprint || r.executionFingerprint !== a.executionFingerprint
    || outcome.tenantId !== request.tenantId || outcome.projectId !== request.projectId || outcome.jobId !== request.jobId
    || outcome.connectionId !== request.connectionId || outcome.requestFingerprint !== e.protocol.requestFingerprint
    || Date.parse(r.kind === "returned" ? r.receivedAt : r.interruptedAt) < Date.parse(a.attemptedAt)) throw new Error("生产响应与原尝试不一致");
  if (r.kind === "interrupted") {
    if (fp(outcome) !== fp(productionImageUnknownOutcome(e, outcome.failureCode as Parameters<typeof productionImageUnknownOutcome>[1]))) throw new Error("生产中断证据不一致");
  } else if (r.protocol !== e.preparation.connection.protocol) throw new Error("生产响应协议不一致");
  return r;
}
