import { createHash } from "node:crypto";
import sharp from "sharp";
import { ImageInputTransformSchema, type ImageExecutionRequest, type ImageModelCapability, type VerifiedImage } from "@canvas/contracts";
import { ImageProviderContractError, validateImageProviderInputs } from "./imageProviderContract";
import { withStaticImageDecodeSlot } from "./staticImageDecoder";

export const MAX_IMAGE_PROTOCOL_REQUEST_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_REFERENCE_CHARACTERS = 20 * 1024 * 1024;
export const imagePayloadSha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function reject(code: string): never { throw new ImageProviderContractError(code); }
export type TrustedImageBytes = { receipt: VerifiedImage; body: Buffer };
export type ImageInputTransform = ReturnType<typeof ImageInputTransformSchema.parse>;
type NormalizedImage = { assetId: string; body: Buffer };
export type ImagePayloadParts = { fields: Record<string, string | number>; images: NormalizedImage[]; mask?: NormalizedImage; transformedInputs: ImageInputTransform[] };

async function normalizedPixels(body: Buffer, width: number, height: number) {
  return withStaticImageDecodeSlot(async () => { try {
    const decoded = await sharp(body, { failOn: "warning", limitInputPixels: 16_000_000 })
      .timeout({ seconds: 5 }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== width || decoded.info.height !== height || decoded.info.channels !== 4) reject("image_normalized_dimensions_changed");
    return decoded;
  } catch (error) {
    if (error instanceof ImageProviderContractError) throw error;
    return reject("image_input_decode_failed");
  } });
}

// Called only with a request/capability already checked by the provider contract.
export async function prepareImagePayloadParts(request: ImageExecutionRequest, capability: ImageModelCapability, trustedImages: readonly TrustedImageBytes[], allowedMaskPolarity: "transparent-edit" | "declared"): Promise<ImagePayloadParts> {
  validateImageProviderInputs(request, trustedImages.map((image) => image.receipt));
  const params = request.parameters;
  const fields: ImagePayloadParts["fields"] = { model: request.model, prompt: params.prompt, n: 1,
    size: params.size === "auto" ? "auto" : `${params.size.width}x${params.size.height}`,
    quality: params.quality, output_format: params.outputFormat, background: params.background };
  if (params.inputFidelity !== undefined) fields.input_fidelity = params.inputFidelity;
  if (params.outputCompression !== undefined) fields.output_compression = params.outputCompression;
  const parts: ImagePayloadParts = { fields, images: [], transformedInputs: [] };
  if (request.operation !== "edit") return parts;
  if (!capability.inputMimeTypes.includes("image/png")) reject("image_normalization_format_unsupported");
  let transformedBytes = 0;
  async function normalize(assetId: string, mask = false): Promise<NormalizedImage> {
    const image = trustedImages.find((item) => item.receipt.tenantId === request.tenantId && item.receipt.asset.projectId === request.projectId && item.receipt.asset.id === assetId);
    if (!image) return reject("image_input_not_verified");
    const originalChecksumSha256 = imagePayloadSha256(image.body);
    if (image.body.byteLength !== image.receipt.asset.byteSize || originalChecksumSha256 !== image.receipt.checksumSha256) reject("image_input_bytes_changed");
    const pixels = await normalizedPixels(image.body, image.receipt.asset.width, image.receipt.asset.height);
    if (mask) {
      const polarity = capability.mask.polarity;
      if (polarity !== "transparent-edit" && !(allowedMaskPolarity === "declared" && polarity === "white-edit")) reject("image_mask_conversion_unsupported");
      for (let index = 0; index < pixels.data.length; index += 4) {
        if (pixels.data[index + 3] > 0 && (pixels.data[index] !== 255 || pixels.data[index + 1] !== 255 || pixels.data[index + 2] !== 255)) reject("image_internal_mask_invalid");
        if (polarity === "transparent-edit") {
          pixels.data[index] = 0; pixels.data[index + 1] = 0; pixels.data[index + 2] = 0;
          pixels.data[index + 3] = 255 - pixels.data[index + 3];
        }
      }
    }
    const body = await sharp(pixels.data, { raw: { width: pixels.info.width, height: pixels.info.height, channels: 4 } }).timeout({ seconds: 5 }).png().toBuffer();
    if (body.byteLength > capability.maxInputBytes) reject("image_transformed_bytes_exceeded");
    transformedBytes += body.byteLength;
    if (transformedBytes > capability.maxTotalInputBytes) reject("image_transformed_total_bytes_exceeded");
    if (transformedBytes > MAX_IMAGE_PROTOCOL_REQUEST_BYTES) reject("image_request_too_large");
    parts.transformedInputs.push({ assetId, originalChecksumSha256, transmittedChecksumSha256: imagePayloadSha256(body), transform: !mask ? "exif-srgb-png-v1"
      : capability.mask.polarity === "transparent-edit" ? "internal-white-to-transparent-mask-v1" : "internal-white-mask-v1" });
    return { assetId, body };
  }
  // Decode sequentially; actual workers must additionally bound global concurrency.
  for (const input of request.inputs) parts.images.push(await normalize(input.assetId));
  if (request.mask) parts.mask = await normalize(request.mask.assetId, true);
  return parts;
}

export function encodeImageJson(parts: ImagePayloadParts, extraParameters: Record<string, string | number | boolean> = {}): Buffer {
  const protectedNames = new Set([...Object.keys(parts.fields), "images", "image", "mask", "stream", "response_format", "__proto__", "constructor", "prototype"]);
  if (Object.keys(extraParameters).some((name) => protectedNames.has(name))) reject("image_extra_parameter_reserved");
  const wire: Record<string, unknown> = { ...parts.fields, ...extraParameters };
  let referenceCharacters = Buffer.byteLength(JSON.stringify(wire), "utf8") + 4096;
  function reference(image: NormalizedImage) {
    const characters = 4 * Math.ceil(image.body.byteLength / 3) + 22;
    if (characters > MAX_IMAGE_REFERENCE_CHARACTERS) reject("image_reference_too_large");
    referenceCharacters += characters + 128;
    if (referenceCharacters > MAX_IMAGE_PROTOCOL_REQUEST_BYTES) reject("image_request_too_large");
    return { image_url: `data:image/png;base64,${image.body.toString("base64")}` };
  }
  if (parts.images.length) wire.images = parts.images.map(reference);
  if (parts.mask) wire.mask = reference(parts.mask);
  const body = Buffer.from(JSON.stringify(wire), "utf8");
  if (body.byteLength > MAX_IMAGE_PROTOCOL_REQUEST_BYTES) reject("image_request_too_large");
  return body;
}
