import type { RunKernelSnapshot } from "@canvas/contracts";
export function imageTaskMetadataBytes(snapshot: RunKernelSnapshot | null, tenantId: string, projectId: string): number {
  return (snapshot?.batches ?? []).filter((item) => item.aggregate.batch.tenantId === tenantId && item.aggregate.batch.projectId === projectId)
    .reduce((total, item) => total + [item.productionImageExecution, item.productionImageLeases,
      ...(item.productionImageExecution ? [item.aggregate.audit.filter((a) => ["job-leased", "job-lease-expired"].includes(a.eventType))] : []),
      item.imageExecution, item.imageDispatchIntent, item.imageFixtureAttempt, item.imageFixtureResult, item.imageTaskArtifact, item.imageTaskArtifactFailures]
      .reduce((bytes, record) => bytes + (record ? Buffer.byteLength(JSON.stringify(record), "utf8") : 0), 0), 0);
}
