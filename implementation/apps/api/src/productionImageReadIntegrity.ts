import type { RunKernelSnapshot } from "@canvas/contracts";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { validateProductionImageAssetPolicy } from "./imageAssetPolicy";
import { assertProductionImageRawResponse } from "./productionImageResponse";
import { assertProductionImageArtifact } from "./productionImageArtifactIntegrity";
import { assetMetadataFingerprint } from "./assetMetadata";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";

// Caller owns the SAME read transaction and independently scoped permissions.
// No task command, price oracle, lease recovery, decode or commit authority.
export function validateProductionImageReadSnapshot(store: SqliteRunKernelStateStore, kernel: SqliteRunKernel,
  tenant: string, project: string, snapshot: RunKernelSnapshot, guard: () => void) {
  guard(); kernel.validateProductionBillingSnapshot(snapshot);
  guard(); if (store.imageMetadataBytes(tenant, project) + imageTaskMetadataBytes(snapshot, tenant, project) > 16 * 1024 * 1024) throw new Error("生产历史元数据超限"); guard();
  guard(); const catalogHash = fp(store.loadCatalog()); guard();
  for (const s of snapshot.batches.filter(b => b.aggregate.batch.tenantId === tenant && b.aggregate.batch.projectId === project && b.productionImageExecution)) {
    const e = s.productionImageExecution!, job = e.protocol.request.jobId; guard();
    const original = store.loadProductionImagePreparation(tenant, project, e.mode, e.preparation.id); guard();
    if (!original || fp(original) !== fp(e.preparation)) throw new Error("原生产准备不一致");
    validateProductionImageAssetPolicy(store, e.protocol.request, guard); guard();
    const artifact = store.loadProductionImageArtifact(tenant, project, e.mode, job); guard();
    const raw = store.loadProductionImageResponse(tenant, project, e.mode, job);
    try { guard();
      if (s.productionImageResult?.kind === "returned") {
        if (!raw || fp(raw.record) !== s.productionImageResultFingerprint || fp(raw.record) !== fp(s.productionImageResult)) throw new Error("原包与实际任务不一致");
        const parsed = assertProductionImageRawResponse(raw.record, e, s.productionImageLeases?.at(-1), s.productionImageDispatchIntent, s.productionImageAttempt, raw.body);
        try {
          if (s.productionImageArtifact) {
            if (!artifact || fp(artifact) !== s.productionImageArtifactFingerprint || fp(artifact) !== fp(s.productionImageArtifact)) throw new Error("产物与实际任务不一致");
            assertProductionImageArtifact(s, artifact); guard();
            const asset = store.loadCatalog()?.projects.find(v => v.projectId === project)?.assets.find(a => a.id === artifact.image.asset.id); guard();
            if (!asset || assetMetadataFingerprint(asset) !== artifact.image.registeredMetadataSha256 || !parsed.candidate
              || parsed.candidate.checksumSha256 !== artifact.image.checksumSha256 || parsed.candidate.mimeType !== asset.mimeType
              || parsed.candidate.body.length !== asset.byteSize) throw new Error("产物目录或完整原包候选不一致");
          } else if (artifact) throw new Error("孤立生产产物");
        } finally { parsed.candidate?.body.fill(0); }
      } else if (raw || artifact || s.productionImageArtifact) throw new Error("孤立生产原包/产物");
    } finally { raw?.body.fill(0); }
    validateProductionImageAssetPolicy(store, e.protocol.request, guard); guard();
  }
  guard();
  if (fp(store.load()) !== fp(snapshot) || fp(store.loadCatalog()) !== catalogHash) throw new Error("读取期间原任务或目录变化"); guard();
}
