import { ConstraintSnapshotSchema, type ConstraintSnapshot, type ImageExecutionRequest } from "@canvas/contracts";
import { validateImageProviderInputs } from "./imageProviderContract";
import { imagePayloadSha256 } from "./imageRequestPayload";
import { MAX_STATIC_IMAGE_EDGE, MAX_STATIC_IMAGE_PIXELS } from "./staticImageDecoder";
import { assetMetadataFingerprint } from "./verifiedAssets";
import { RunKernelError } from "./runKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";

export function constraintContentChecksum(constraint: ConstraintSnapshot): string {
  return imagePayloadSha256(Buffer.from(JSON.stringify(ConstraintSnapshotSchema.parse(constraint)), "utf8"));
}
function reject(code: string): never { throw new RunKernelError(422, code, "图片输入或输出约束未通过服务端核验"); }

// Called under the caller's transaction after permission checks. Shared by
// preparation and ingestion, and must also run before future confirm/dispatch.
export function validateLocalImageAssetPolicy(store: SqliteRunKernelStateStore, request: ImageExecutionRequest) {
  const catalog = store.loadCatalog();
  const project = catalog?.projects.find((item) => item.projectId === request.projectId);
  const constraint = project?.constraints.find((item) => item.id === request.constraintSnapshotId);
  if (!catalog || !project || !constraint || constraintContentChecksum(constraint) !== request.constraintChecksumSha256) reject("image_output_constraint_changed");
  if (constraint.lockedPaths.includes("product.pixels")) reject("image_pixel_protection_not_configured");
  if (Math.max(constraint.outputSpec.width, constraint.outputSpec.height) > MAX_STATIC_IMAGE_EDGE
    || constraint.outputSpec.width * constraint.outputSpec.height > MAX_STATIC_IMAGE_PIXELS) reject("image_output_dimensions_exceeded");
  if (constraint.outputSpec.format !== request.parameters.outputFormat || (request.parameters.size !== "auto"
    && (constraint.outputSpec.width !== request.parameters.size.width || constraint.outputSpec.height !== request.parameters.size.height))) reject("image_output_spec_changed");
  const masks = [...new Set(constraint.editableRegions.flatMap((region) => region.maskAssetId ? [region.maskAssetId] : []))];
  if (masks.length > 1 || (masks.length && (request.operation !== "edit" || request.mask?.assetId !== masks[0]))
    || (request.operation === "edit" && request.mask && !masks.includes(request.mask.assetId))) reject("image_output_constraint_mask_changed");
  const refs = request.operation === "edit" ? [...request.inputs, ...(request.mask ? [request.mask] : [])] : [];
  const receipts = refs.map((ref) => {
    const receipt = store.loadVerifiedImage(request.tenantId, request.projectId, ref.assetId);
    const registered = project.assets.find((asset) => asset.id === ref.assetId);
    if (!receipt || !registered || receipt.registeredMetadataSha256 !== assetMetadataFingerprint(registered)) reject("image_input_not_verified");
    return receipt;
  });
  validateImageProviderInputs(request, receipts);
  return { catalog, project, constraint, receipts };
}
