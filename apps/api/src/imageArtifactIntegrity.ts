import type { GeneratedImageRecord, RunKernelSnapshot } from "@canvas/contracts";
import { imageSnapshotFingerprint } from "./imageProviderContract";

// Shared persisted cross-record checks, independent of write/execute permission.
export function assertImageArtifactRecord(stored: RunKernelSnapshot["batches"][number], generated: GeneratedImageRecord | null): asserts generated is GeneratedImageRecord {
  const artifact = stored.imageTaskArtifact, execution = stored.imageExecution, result = stored.imageFixtureResult;
  if (!artifact || !generated || imageSnapshotFingerprint(generated) !== artifact.generatedRecordFingerprint
    || generated.image.asset.id !== artifact.assetId || generated.image.checksumSha256 !== artifact.checksumSha256) throw new Error("任务产物与生成记录不一致");
  if (!execution || result?.kind !== "returned" || imageSnapshotFingerprint(generated.request) !== imageSnapshotFingerprint(execution.request)
    || generated.requestFingerprint !== execution.requestFingerprint || generated.payloadChecksumSha256 !== execution.payloadChecksumSha256
    || generated.confirmedAt !== execution.confirmedAt || generated.protocol !== execution.preparation.connection.protocol
    || imageSnapshotFingerprint(generated.constraint) !== imageSnapshotFingerprint(execution.preparation.constraint)
    || imageSnapshotFingerprint(generated.transformedInputs) !== imageSnapshotFingerprint(execution.transformedInputs)
    || imageSnapshotFingerprint(generated.providerOutcome) !== imageSnapshotFingerprint(result.outcome)
    || generated.image.verifiedAt !== artifact.committedAt) throw new Error("任务产物谱系与完整确认或原始响应不一致");
}
