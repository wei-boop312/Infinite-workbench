import type { RunKernelSnapshot } from "@canvas/contracts";
export function imageTaskMetadataBytes(snapshot: RunKernelSnapshot | null, tenantId: string, projectId: string): number {
  return (snapshot?.batches ?? []).filter((item) => item.aggregate.batch.tenantId === tenantId && item.aggregate.batch.projectId === projectId)
    .reduce((total, item) => total + [item.productionImageExecution, item.lockedProductionImageExecution,
      ...(item.lockedProductionImageExecution ? [item.requestFingerprint, item.aggregate.audit, item.aggregate.ledger] : []), item.lockedProductionImageLeases, item.productionImageLeases, item.productionImageDispatchIntent,
      item.productionImageDispatchIntentFingerprint,
      item.productionImageAttempt, item.productionImageAttemptFingerprint, item.productionImageResult, item.productionImageResultFingerprint,
      item.productionImageArtifact, item.productionImageArtifactFingerprint,
      item.productionImageBilling, item.productionImageBillingFingerprint, item.aggregate.productionBilling,
      ...(item.productionImageExecution ? [item.aggregate.audit.filter((a) => ["job-leased", "job-lease-expired", "job-started", "billing-unknown", "production-image-attempted", "production-image-returned", "production-image-interrupted", "production-image-artifact-verified"].includes(a.eventType)),
        item.aggregate.audit.filter(a => a.eventType.startsWith("production-billing-")), item.aggregate.ledger.filter((l) => l.settlement !== "reserved")] : []),
      item.imageExecution, item.imageDispatchIntent, item.imageFixtureAttempt, item.imageFixtureResult, item.imageTaskArtifact, item.imageTaskArtifactFailures]
      .reduce((bytes, record) => bytes + (record ? Buffer.byteLength(JSON.stringify(record), "utf8") : 0), 0), 0);
}
