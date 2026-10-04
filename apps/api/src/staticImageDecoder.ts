import sharp from "sharp";
import { RunKernelError } from "./runKernel";

export const MAX_STATIC_IMAGE_PIXELS = 16_000_000;
export const MAX_STATIC_IMAGE_EDGE = 8192;
let activeDecodes = 0;
function reject(code: string, message: string, status = 422): never { throw new RunKernelError(status, code, message); }
// Verification and protocol input normalization share this same process slot.
export async function withStaticImageDecodeSlot<T>(action: () => Promise<T>): Promise<T> {
  if (activeDecodes >= 2) reject("verified_asset_busy", "本机正在核验其他图片，请稍后重试", 429);
  activeDecodes++;
  try { return await action(); }
  finally { activeDecodes--; }
}
export function imageMagicMime(body: Buffer): string | null {
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (["GIF87a", "GIF89a"].includes(body.toString("ascii", 0, 6))) return "image/gif";
  if (body.toString("ascii", 4, 8) === "ftyp") {
    const length = body.readUInt32BE(0);
    if (length >= 16 && length <= Math.min(body.length, 256)) {
      for (let offset = 8; offset + 4 <= length; offset += 4) {
        if (offset !== 12 && ["avif", "avis"].includes(body.toString("ascii", offset, offset + 4))) return "image/avif";
      }
    }
  }
  return null;
}
export function rejectStaticImageAnimation(body: Buffer, mime: string): void {
  // APNG may otherwise expose only its fallback frame.
  if (mime === "image/png") {
    for (let offset = 8; offset + 12 <= body.length;) {
      const length = body.readUInt32BE(offset);
      if (body.toString("ascii", offset + 4, offset + 8) === "acTL") reject("verified_asset_animated", "请先选择静态帧");
      if (length > body.length - offset - 12) break;
      offset += length + 12;
    }
  }
  if (mime === "image/avif") {
    const length = Math.min(body.readUInt32BE(0), body.length, 256);
    for (let offset = 8; offset + 4 <= length; offset += 4) {
      if (offset !== 12 && body.toString("ascii", offset, offset + 4) === "avis") reject("verified_asset_animated", "请先选择静态帧");
    }
  }
}

// Shared source/output decoder; original bytes are NOT rewritten. This is local
// in-process verification, not the production isolated malicious-file sandbox.
export async function decodeStaticImage(body: Buffer, mime: string): Promise<{ width: number; height: number; hasAlpha: boolean; hasTransparency: boolean }> {
  const decoded = await decodeStaticImagePixels(body, mime);
  try { return { width: decoded.width, height: decoded.height, hasAlpha: decoded.hasAlpha, hasTransparency: decoded.hasTransparency }; }
  finally { decoded.pixels.fill(0); }
}

// Internal owned RGBA8 buffer. Callers MUST clear it, including late results.
// Canonical decoded equality is not encoded-byte/ICC/high-bit-depth equality.
export async function decodeStaticImagePixels(body: Buffer, mime: string): Promise<{ width: number; height: number; hasAlpha: boolean; hasTransparency: boolean; pixels: Buffer }> {
  if (imageMagicMime(body) !== mime) reject("verified_asset_mime_mismatch", "图片魔数与文件类型不一致");
  rejectStaticImageAnimation(body, mime);
  return withStaticImageDecodeSlot(async () => { let pixels: Buffer | undefined; try {
    const image = sharp(body, { failOn: "warning", limitInputPixels: MAX_STATIC_IMAGE_PIXELS, sequentialRead: true });
    const metadata = await image.metadata();
    const expectedFormat = mime === "image/avif" ? "heif" : mime.slice(6);
    if (metadata.format !== expectedFormat) reject("verified_asset_mime_mismatch", "图片解码格式不一致");
    if ((metadata.pages ?? 1) > 1) reject("verified_asset_animated", "动态图暂不支持图片任务，请先选择静态帧");
    if (!metadata.width || !metadata.height || metadata.width > MAX_STATIC_IMAGE_EDGE || metadata.height > MAX_STATIC_IMAGE_EDGE
      || metadata.width * metadata.height > MAX_STATIC_IMAGE_PIXELS) reject("verified_asset_dimensions_exceeded", "图片像素或边长超出校验上限");
    const decoded = await image.autoOrient().toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" }).timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
    pixels = decoded.data;
    const { width, height, channels } = decoded.info;
    if (channels !== 4 || decoded.data.byteLength !== width * height * 4) reject("verified_asset_decode_failed", "图片像素数据不完整");
    let hasTransparency = false;
    if (metadata.hasAlpha) {
      for (let index = 3; index < decoded.data.byteLength; index += 4) {
        if (decoded.data[index] < 255) { hasTransparency = true; break; }
      }
    }
    return { width, height, hasAlpha: metadata.hasAlpha, hasTransparency, pixels };
  } catch (error) {
    pixels?.fill(0);
    if (error instanceof RunKernelError) throw error;
    return reject("verified_asset_decode_failed", "无法完整解码图片，拒绝伪造或截断文件");
  } });
}
