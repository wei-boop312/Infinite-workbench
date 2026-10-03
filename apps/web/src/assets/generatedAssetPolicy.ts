import type { VerifiedImage } from "@canvas/contracts";
export const MAX_GENERATED_CACHE_BYTES = 20 * 1024 * 1024;
export function assertGeneratedReceipt(receipt: VerifiedImage, projectId: string, assetId: string): void {
  const a = receipt.asset;
  if (receipt.tenantId !== "local-studio" || a.projectId !== projectId || a.id !== assetId || a.purpose !== "generated"
    || !["image/png", "image/jpeg", "image/webp"].includes(a.mimeType) || a.byteSize > MAX_GENERATED_CACHE_BYTES
    || a.width * a.height > 16_000_000 || Math.max(a.width, a.height) > 8192) throw new Error("生成资产收据与本项目或容量政策不一致。");
}
export async function blobSha256(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
