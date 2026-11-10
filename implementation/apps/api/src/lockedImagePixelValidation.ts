import { createHash } from "node:crypto";
import { ConstraintSnapshotSchema, LockedImagePixelDraftSchema, VerifiedImageSchema, type ConstraintSnapshot, type VerifiedImage, type LockedImagePixelDraft, type Asset } from "@canvas/contracts";
import { verifiedImageMatchesRegistration } from "./assetMetadata";
import { decodeStaticImagePixels, MAX_STATIC_IMAGE_EDGE, MAX_STATIC_IMAGE_PIXELS } from "./staticImageDecoder";
import { RunKernelError } from "./runKernel";

const hash = (body: Buffer | string) => createHash("sha256").update(body).digest("hex");
let activeChecks = 0;
function reject(code: string, status = 422): never { throw new RunKernelError(status, code, "锁区完整像素核验失败，未授权提交或执行"); }
export interface LockedImagePixelInput {
  protection: "pixel-exact"; source: VerifiedImage; mask: VerifiedImage; constraint: ConstraintSnapshot;
  constraintChecksumSha256: string; sourceBody: Buffer; maskBody: Buffer;
  registeredAssets?: { source: Asset; mask: Asset };
  candidate: { body: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp"; checksumSha256: string };
}

// PURE draft only: supplied receipts/hashes are NOT current task/permission proof.
// No SQL, prices, network, composite/re-encode, storage, task or financial writes.
export async function verifyLockedImagePixels(input: LockedImagePixelInput, options: { signal?: AbortSignal; clock?: () => number; timeoutMs?: number } = {}): Promise<LockedImagePixelDraft> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) reject("image_locked_timeout_invalid");
  const clock = options.clock ?? Date.now;
  const signal = options.signal;
  let last = clock();
  if (!Number.isSafeInteger(last) || last < 0 || !Number.isSafeInteger(last + timeoutMs)) reject("image_locked_clock_invalid");
  const deadline = last + timeoutMs;
  let closed = false;
  const guard = () => {
    if (closed || signal?.aborted) reject("image_locked_cancelled");
    const now = clock();
    if (!Number.isSafeInteger(now) || now < last) reject("image_locked_clock_invalid");
    last = now;
    if (now >= deadline) reject("image_locked_expired");
  };
  guard();
  if (activeChecks >= 2) reject("image_locked_busy", 429);
  activeChecks++;
  const bodies: Buffer[] = [];
  const pixels: Buffer[] = [];
  const work = (async () => { try {
    const metadata = JSON.stringify({ protection: input.protection, source: input.source, mask: input.mask, registeredAssets: input.registeredAssets, constraint: input.constraint, constraintChecksumSha256: input.constraintChecksumSha256 });
    if (Buffer.byteLength(metadata) > 512 * 1024) reject("image_locked_metadata_too_large");
    const frozen = JSON.parse(metadata);
    const source = VerifiedImageSchema.parse(frozen.source), mask = VerifiedImageSchema.parse(frozen.mask), c = ConstraintSnapshotSchema.parse(frozen.constraint);
    const candidate = { mimeType: input.candidate.mimeType, checksumSha256: input.candidate.checksumSha256 };
    if (frozen.protection !== "pixel-exact" || !c.lockedPaths.includes("product.pixels") || c.outputSpec.format === "mp4"
      || candidate.mimeType !== `image/${c.outputSpec.format}` || frozen.constraintChecksumSha256 !== hash(JSON.stringify(c))) reject("image_locked_constraint_mismatch");
    if (source.tenantId !== mask.tenantId || source.asset.projectId !== mask.asset.projectId || source.asset.projectId !== c.projectId
      || source.asset.id === mask.asset.id || source.asset.purpose !== "source" || mask.asset.purpose !== "mask"
      || mask.asset.sourceAssetId !== source.asset.id || mask.sourceChecksumSha256 !== source.checksumSha256
      || mask.asset.mimeType !== "image/png" || source.sourceChecksumSha256 !== undefined
      || !verifiedImageMatchesRegistration(source, frozen.registeredAssets?.source ?? source.asset) || !verifiedImageMatchesRegistration(mask, frozen.registeredAssets?.mask ?? mask.asset)) reject("image_locked_receipt_mismatch");
    if (!c.editableRegions.length || c.editableRegions.some(region => region.maskAssetId !== mask.asset.id)
      || new Set(c.editableRegions.map(region => region.id)).size !== c.editableRegions.length) reject("image_locked_mask_unbound");
    const width = source.asset.width, height = source.asset.height;
    if (width !== mask.asset.width || height !== mask.asset.height || width !== c.outputSpec.width || height !== c.outputSpec.height
      || width > MAX_STATIC_IMAGE_EDGE || height > MAX_STATIC_IMAGE_EDGE || width * height > MAX_STATIC_IMAGE_PIXELS) reject("image_locked_dimensions_mismatch");
    // All declared/actual byte guards run BEFORE copying or decoding any original.
    if (source.asset.byteSize > 30 * 1024 * 1024 || mask.asset.byteSize > 30 * 1024 * 1024
      || source.asset.byteSize + mask.asset.byteSize > 64 * 1024 * 1024) reject("image_locked_inputs_too_large");
    const originals = [input.sourceBody, input.maskBody, input.candidate.body];
    if (originals.some(body => !Buffer.isBuffer(body)) || originals[0].length !== source.asset.byteSize || originals[1].length !== mask.asset.byteSize
      || !originals[2].length || originals[2].length > 20 * 1024 * 1024) reject("image_locked_bytes_mismatch");
    for (const original of originals) bodies.push(Buffer.from(original));
    if (hash(bodies[0]) !== source.checksumSha256 || hash(bodies[1]) !== mask.checksumSha256 || hash(bodies[2]) !== candidate.checksumSha256) reject("image_locked_bytes_mismatch");
    for (let index = 0; index < bodies.length; index++) {
      guard();
      const result = await decodeStaticImagePixels(bodies[index], [source.asset.mimeType, mask.asset.mimeType, candidate.mimeType][index]);
      pixels.push(result.pixels); guard();
      if (result.width !== width || result.height !== height) reject("image_locked_dimensions_mismatch");
    }
    let lockedPixels = 0, editablePixels = 0;
    for (let offset = 0; offset < pixels[0].length; offset += 4) {
      if (offset % 16384 === 0) guard();
      const alpha = pixels[1][offset + 3];
      if (alpha > 0 && (pixels[1][offset] !== 255 || pixels[1][offset + 1] !== 255 || pixels[1][offset + 2] !== 255)) reject("image_locked_mask_invalid");
      if (alpha === 255) editablePixels++;
      else {
        lockedPixels++;
        for (let channel = 0; channel < 4; channel++) if (pixels[0][offset + channel] !== pixels[2][offset + channel]) reject("image_locked_pixels_changed");
      }
    }
    if (!lockedPixels || !editablePixels) reject("image_locked_mask_vacuous");
    guard();
    const draft = LockedImagePixelDraftSchema.parse({ schemaVersion: 1, validation: "pixel-verified-uncommitted", artifactCommitted: false, executionAuthorized: false,
      realExecutionEnabled: false, settlementAuthorized: false, protectionApplied: "checked-not-applied", normalizationVersion: "auto-orient-srgb-rgba8-v1",
      maskPolicy: "white-alpha255-edit-otherwise-locked-v1", tenantId: source.tenantId, projectId: c.projectId, sourceAssetId: source.asset.id, maskAssetId: mask.asset.id,
      constraintSnapshotId: c.id, constraintChecksumSha256: hash(JSON.stringify(c)), sourceChecksumSha256: source.checksumSha256, maskChecksumSha256: mask.checksumSha256,
      candidateChecksumSha256: candidate.checksumSha256, sourcePixelsSha256: hash(pixels[0]), maskPixelsSha256: hash(pixels[1]), candidatePixelsSha256: hash(pixels[2]),
      mimeType: candidate.mimeType, byteSize: bodies[2].length, width, height, lockedPixels, editablePixels, lockedPixelsEqual: true, validatedAt: new Date(last).toISOString() });
    guard();
    draft.validatedAt = new Date(last).toISOString();
    return draft;
  } finally { bodies.forEach(body => body.fill(0)); pixels.forEach(body => body.fill(0)); activeChecks--; } })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, fail) => {
    timer = setTimeout(() => { closed = true; fail(new RunKernelError(408, "image_locked_expired", "锁区核验期限耗尽")); }, timeoutMs);
    onAbort = () => { closed = true; fail(new RunKernelError(408, "image_locked_cancelled", "锁区核验已取消")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try { return await Promise.race([work, interrupted]); }
  finally { closed = true; clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); }
}
