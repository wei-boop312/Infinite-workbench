import { createHash } from "node:crypto";
import { AssetSchema, type Asset, type VerifiedImage } from "@canvas/contracts";

// Canonical metadata hashing must not depend on task execution or image decoding.
export function assetMetadataFingerprint(asset: Asset): string {
  return createHash("sha256").update(JSON.stringify(AssetSchema.parse(asset))).digest("hex");
}

// Registration and server receipt are separate identities. LocalVerifiedAssets
// replaces only its private storage key and drops the browser proxy reference.
// Do not erase either SHA or accept arbitrary metadata drift as normalization.
export function verifiedImageMatchesRegistration(receipt: VerifiedImage, registration: Asset): boolean {
  const original = AssetSchema.parse(registration);
  if (receipt.registeredMetadataSha256 !== assetMetadataFingerprint(original)) return false;
  if (assetMetadataFingerprint(receipt.asset) === assetMetadataFingerprint(original)) return true;
  const { proxyStorageKey: _proxy, ...base } = original;
  const storage = createHash("sha256").update(JSON.stringify([receipt.tenantId, original.projectId, original.id])).digest("hex");
  const expected = { ...base, storageKey: `local-verified:${storage}`, contentFingerprint: `sha256:${receipt.checksumSha256}` };
  return assetMetadataFingerprint(receipt.asset) === assetMetadataFingerprint(expected);
}
