import { LockedProductionGeneratedAssetLineageSchema, LockedProductionGeneratedReadScopeSchema,
  type LockedProductionGeneratedAssetLineage, type LockedProductionGeneratedReadScope } from "@canvas/contracts";
import { blobSha256 } from "./generatedAssetPolicy";
export type LockedProductionCacheRecord = { version: 2; namespace: "locked-production-generated-image-v2"; assetId: string; tenantId: string; projectId: string;
  mode: LockedProductionGeneratedAssetLineage["mode"]; identity: string; lineage: LockedProductionGeneratedAssetLineage;
  proxy: { checksumSha256: string; byteSize: number; mimeType: "image/webp"; width: number; height: number } };
// Only the current financial projection is excluded, never the protection
// policy, original inputs or immutable pixel observation. This is not authority.
export function lockedProductionCacheIdentity(value: LockedProductionGeneratedAssetLineage): string {
  const { billing: _billing, jobStatus: _status, ...frozen } = LockedProductionGeneratedAssetLineageSchema.parse(value);
  return JSON.stringify(frozen);
}
export function lockedProductionMarkerMatches(marker: LockedProductionCacheRecord | undefined, view: LockedProductionGeneratedAssetLineage) {
  try {
    const p = marker?.proxy, a = view.image.asset, scale = Math.min(1, 480 / Math.max(a.width, a.height));
    return !!marker && Object.keys(marker).sort().join() === ["version", "namespace", "assetId", "tenantId", "projectId", "mode", "identity", "lineage", "proxy"].sort().join()
      && marker.version === 2 && marker.namespace === "locked-production-generated-image-v2" && marker.assetId === a.id && marker.tenantId === view.tenantId
      && marker.projectId === view.projectId && marker.mode === view.mode && new TextEncoder().encode(JSON.stringify(marker)).length <= 512 * 1024
      && marker.identity === lockedProductionCacheIdentity(view) && lockedProductionCacheIdentity(marker.lineage) === marker.identity
      && !!p && Object.keys(p).sort().join() === ["checksumSha256", "byteSize", "mimeType", "width", "height"].sort().join()
      && /^[a-f0-9]{64}$/.test(p.checksumSha256) && Number.isSafeInteger(p.byteSize) && p.byteSize > 0 && p.byteSize <= 20 * 1024 * 1024 && p.mimeType === "image/webp"
      && p.width === Math.max(1, Math.round(a.width * scale)) && p.height === Math.max(1, Math.round(a.height * scale));
  } catch { return false; }
}
export async function assertLockedProductionLineage(value: unknown, scope: LockedProductionGeneratedReadScope, projectId: string, assetId: string) {
  LockedProductionGeneratedReadScopeSchema.parse(scope);
  const view = LockedProductionGeneratedAssetLineageSchema.parse(value);
  if (view.mode !== scope.mode || view.tenantId !== scope.tenantId || view.projectId !== projectId || view.image.asset.id !== assetId
    || view.image.asset.contentFingerprint !== `sha256:${view.image.checksumSha256}`) throw new Error("保护原图范围或原指纹错配。");
  if (await blobSha256(new Blob([JSON.stringify(view.constraint)])) !== view.requestDraft.constraintChecksumSha256) throw new Error("保护原完整约束 SHA 错配。");
  return view;
}
