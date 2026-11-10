import { VerifiedImageSchema, type Asset, type VerifiedImage } from "@canvas/contracts";
import { assetRepository } from "./assetRepository";
import { localStudioFetch } from "../runs/runClient";
import { assertGeneratedReceipt, blobSha256, MAX_GENERATED_CACHE_BYTES } from "./generatedAssetPolicy";

export { MAX_GENERATED_CACHE_BYTES };
let activeCaches = 0;
export type GeneratedCachePort = { cacheGenerated(receipt: VerifiedImage, original: Blob, signal: AbortSignal): Promise<Asset> };
function validId(id: string) { return id.length > 0 && id.length <= 160 && id.trim() === id && !/[\x00-\x1f\x7f]/.test(id); }
async function boundedBody(response: Response, max: number, signal: AbortSignal): Promise<Blob> {
  if (!response.body) throw new Error("生成资产响应缺少正文。");
  const reader = response.body.getReader(), parts: Uint8Array<ArrayBuffer>[] = [];
  let count = 0, complete = false;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read(); signal.throwIfAborted();
      if (done) { complete = true; break; }
      if (!value.byteLength || parts.length >= 4096) throw new Error("生成资产响应分片无效或过多。");
      count += value.byteLength;
      if (count > max) throw new Error("生成资产响应超过容量限制。");
      parts.push(Uint8Array.from(value));
    }
    return new Blob(parts);
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// Explicit local read only. Always reauthorize through the server; a cached blob
// is not a credential, and this has no task mutation or provider execution port.
export async function cacheGeneratedAsset(projectId: string, assetId: string, options: { signal: AbortSignal; repository?: GeneratedCachePort }): Promise<Asset> {
  if (!validId(projectId) || !validId(assetId)) throw new Error("生成资产编号无效。");
  options.signal.throwIfAborted();
  if (activeCaches >= 2) throw new Error("正在缓存其他生成图片，请稍后再试。");
  activeCaches++;
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(new Error("生成图片缓存超时，未重新生成。")), 30_000);
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  const base = `/v1/projects/${encodeURIComponent(projectId)}`;
  const fetchRead = async (path: string) => {
    signal.throwIfAborted();
    const response = await localStudioFetch(path, { method: "GET", headers: { "x-canvas-local": "1" }, credentials: "same-origin", mode: "same-origin",
      cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal });
    if (response.status !== 200 || response.redirected || !response.headers.get("cache-control")?.split(",").map((part) => part.trim()).includes("no-store")) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("生成资产读取被拒绝或响应合同无效，未缓存图片或更改费用。");
    }
    return response;
  };
  try {
    // Existing receipt endpoint supplies canonical immutable metadata. Never
    // replace server metadata with local thumbnail paths or client timestamps.
    const metadata = await fetchRead(`${base}/assets/${encodeURIComponent(assetId)}/verification`);
    const receipt = VerifiedImageSchema.parse(JSON.parse(await (await boundedBody(metadata, 32 * 1024, signal)).text()));
    assertGeneratedReceipt(receipt, projectId, assetId);
    const response = await fetchRead(`${base}/generated-assets/${encodeURIComponent(assetId)}/content`);
    if (response.headers.get("content-type") !== receipt.asset.mimeType
      || response.headers.get("content-length") !== String(receipt.asset.byteSize)
      || response.headers.get("x-content-sha256") !== receipt.checksumSha256
      || response.headers.get("x-canvas-binary-version") !== "generated-image-v1"
      || response.headers.get("content-encoding")) {
      await response.body?.cancel().catch(() => undefined); throw new Error("生成资产长度、类型、版本或摘要不匹配。");
    }
    const bytes = await boundedBody(response, receipt.asset.byteSize, signal);
    if (bytes.size !== receipt.asset.byteSize || await blobSha256(bytes) !== receipt.checksumSha256) throw new Error("生成资产原文件不完整或摘要不匹配。");
    signal.throwIfAborted();
    return await (options.repository ?? assetRepository).cacheGenerated(receipt, bytes.slice(0, bytes.size, receipt.asset.mimeType), signal);
  } finally { clearTimeout(timer); activeCaches--; }
}
