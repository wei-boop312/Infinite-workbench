import { createHash } from "node:crypto";
import { AssetSchema, type Asset } from "@canvas/contracts";

// Canonical metadata hashing must not depend on task execution or image decoding.
export function assetMetadataFingerprint(asset: Asset): string {
  return createHash("sha256").update(JSON.stringify(AssetSchema.parse(asset))).digest("hex");
}
