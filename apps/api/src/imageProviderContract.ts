import { createHash } from "node:crypto";
import {
  ImageExecutionRequestSchema, ProductionImageExecutionRequestSchema, ImageProviderConnectionSchema, ImageProviderPublicSchema, VerifiedImageSchema,
  type ImageExecutionRequest, type ProductionImageExecutionRequest, type ImageProviderConnection, type VerifiedImage,
} from "@canvas/contracts";

export class ImageProviderContractError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ImageProviderContractError"; }
}
function reject(code: string): never { throw new ImageProviderContractError(code); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const imageSnapshotFingerprint = hash;

// Fingerprint the WHOLE validated connection including endpoint/reference/evidence:
// any server-side change invalidates a previous confirmation, even with a reused revision.
export function imageConfirmationFingerprint(connection: ImageProviderConnection, request: ImageExecutionRequest): string {
  return hash({ connection: ImageProviderConnectionSchema.parse(connection), request: ImageExecutionRequestSchema.parse(request) });
}

export function validateImageProviderRequest(connectionInput: unknown, requestInput: unknown, now: string): {
  connection: ImageProviderConnection; request: ImageExecutionRequest; fingerprint: string;
} {
  const connection = ImageProviderConnectionSchema.parse(connectionInput);
  const request = ImageExecutionRequestSchema.parse(requestInput);
  return validateRequestPolicy(connection, request, now);
}

// Separate strict entry point: manual-budget has NO estimatedCostMinor. Sharing
// capability checks does not make production requests valid legacy tasks.
export function validateProductionImageProviderRequest(connectionInput: unknown, requestInput: unknown, now: string) {
  const connection = ImageProviderConnectionSchema.parse(connectionInput);
  const request = ProductionImageExecutionRequestSchema.parse(requestInput);
  const size = request.parameters.size;
  if (size === "auto") reject("image_explicit_output_required");
  if (Math.max(size.width, size.height) > 8192 || size.width * size.height > 16_000_000) reject("image_output_dimensions_exceeded");
  return validateRequestPolicy(connection, request, now);
}

// Static preparation-only capability check, never confirmation/protocol/send
// authority. Existing execution entry points remain none-only.
export function validateLockedProductionImagePreparationRequest(connectionInput: unknown, requestInput: unknown, now: string) {
  const connection = ImageProviderConnectionSchema.parse(connectionInput), request = ProductionImageExecutionRequestSchema.parse(requestInput);
  if (request.protection !== "pixel-exact" || request.operation !== "edit" || !request.mask || request.parameters.size === "auto") reject("image_locked_preparation_required");
  // The current native Google protocol cannot carry our bound mask. A catalog
  // declaration cannot manufacture that protocol support just to pass tests.
  if (connection.protocol === "google") reject("image_locked_protocol_mask_unsupported");
  if (Math.max(request.parameters.size.width, request.parameters.size.height) > 8192 || request.parameters.size.width * request.parameters.size.height > 16_000_000) reject("image_output_dimensions_exceeded");
  return { ...validateRequestPolicy(connection, request, now, true), executionAuthorized: false as const, realExecutionEnabled: false as const };
}

function validateRequestPolicy<R extends ImageExecutionRequest | ProductionImageExecutionRequest>(connection: ImageProviderConnection, request: R, now: string, lockedPreparationOnly = false): {
  connection: ImageProviderConnection; request: R; fingerprint: string;
} {
  if (connection.tenantId !== request.tenantId || connection.projectId !== request.projectId || connection.id !== request.connectionId) reject("image_connection_not_found");
  if (!connection.enabled) reject("image_connection_disabled");
  if (connection.revision !== request.connectionRevision || connection.adapterId !== request.adapterId) reject("image_connection_changed");
  const capability = connection.models.find((item) => item.model === request.model);
  if (!capability) reject("image_model_not_declared");
  if (capability.version !== request.capabilityVersion) reject("image_capability_changed");
  if (!capability.operations.includes(request.operation)) reject("image_operation_unsupported");
  if (!Number.isFinite(Date.parse(now)) || Date.parse(request.quote.expiresAt) <= Date.parse(now)) reject("image_quote_expired");
  if (request.protection === "pixel-exact" && !lockedPreparationOnly) reject("image_pixel_protection_not_configured");
  for (const [name, value] of Object.entries(request.providerParameters ?? {})) {
    const rule = connection.protocol === "openai-compatible" ? connection.compatibility?.extraParameters.find((item) => item.name === name) : undefined;
    if (!rule || !rule.operations.includes(request.operation)) reject("image_extra_parameter_unsupported");
    if ((rule.type === "enum" && (typeof value !== "string" || !rule.values.includes(value)))
      || (rule.type === "integer" && (typeof value !== "number" || value < rule.minimum || value > rule.maximum))
      || (rule.type === "boolean" && typeof value !== "boolean")) reject("image_extra_parameter_invalid");
  }

  const params = request.parameters;
  if (params.prompt.length > capability.maxPromptCharacters) reject("image_prompt_too_long");
  if (!capability.outputFormats.includes(params.outputFormat)) reject("image_output_format_unsupported");
  if (!capability.qualities.includes(params.quality)) reject("image_quality_unsupported");
  if (!capability.backgrounds.includes(params.background)) reject("image_background_unsupported");
  if (params.inputFidelity !== undefined && (request.operation !== "edit" || !capability.inputFidelities.includes(params.inputFidelity))) reject("image_fidelity_unsupported");
  if (params.outputCompression !== undefined && !capability.supportsOutputCompression) reject("image_compression_unsupported");
  if (params.size === "auto") {
    if (!capability.sizes.allowAuto) reject("image_size_unsupported");
  } else {
    const { width, height } = params.size;
    const preset = capability.sizes.presets.some((size) => size.width === width && size.height === height);
    const custom = capability.sizes.custom;
    const allowedCustom = custom && Math.min(width, height) >= custom.minEdge && Math.max(width, height) <= custom.maxEdge
      && width % custom.multipleOf === 0 && height % custom.multipleOf === 0
      && width * height >= custom.minPixels && width * height <= custom.maxPixels
      && Math.max(width / height, height / width) <= custom.maxAspectRatio;
    if (!preset && !allowedCustom) reject("image_size_unsupported");
  }
  if (request.operation === "edit") {
    if (request.inputs.length > capability.maxInputImages) reject("image_input_count_exceeded");
    const all = [...request.inputs, ...(request.mask ? [request.mask] : [])];
    if (all.reduce((total, input) => total + input.byteSize, 0) > capability.maxTotalInputBytes) reject("image_input_total_bytes_exceeded");
    for (const input of all) {
      if (input.byteSize > capability.maxInputBytes) reject("image_input_bytes_exceeded");
      if (Math.max(input.width, input.height) > capability.maxInputEdge || input.width * input.height > capability.maxInputPixels) reject("image_input_dimensions_exceeded");
      // Mask is an explicitly supported PNG, separate from source image formats.
      if (input !== request.mask && !capability.inputMimeTypes.includes(input.mimeType)) reject("image_input_mime_unsupported");
    }
    if (request.mask) {
      if (capability.mask.mode === "none" || capability.mask.polarity === "unverified") reject("image_mask_unsupported");
      const source = request.inputs[0];
      if (request.mask.mimeType !== "image/png" || request.mask.width !== source.width || request.mask.height !== source.height
        || request.inputs.some((input) => input.assetId === request.mask?.assetId)) reject("image_mask_invalid");
    }
  }
  return { connection, request, fingerprint: hash({ connection, request }) };
}

// Receipts MUST come from the authoritative server asset service, never HTTP input.
export function validateImageProviderInputs(request: ImageExecutionRequest, trustedReceipts: readonly VerifiedImage[]): void {
  const parsed = ImageExecutionRequestSchema.parse(request);
  validateInputPolicy(parsed, trustedReceipts);
}

export function validateProductionImageProviderInputs(request: ProductionImageExecutionRequest, trustedReceipts: readonly VerifiedImage[]): void {
  validateInputPolicy(ProductionImageExecutionRequestSchema.parse(request), trustedReceipts);
}

// Internal shared payload/asset policy only; callers still use their own strict
// legacy or production entry point before reaching normalization.
export function validateImageProtocolInputs(request: ImageExecutionRequest | ProductionImageExecutionRequest, trustedReceipts: readonly VerifiedImage[]): void {
  const production = ProductionImageExecutionRequestSchema.safeParse(request);
  validateInputPolicy(production.success ? production.data : ImageExecutionRequestSchema.parse(request), trustedReceipts);
}
function validateInputPolicy(parsed: ImageExecutionRequest | ProductionImageExecutionRequest, trustedReceipts: readonly VerifiedImage[]): void {
  const receipts = trustedReceipts.map((receipt) => VerifiedImageSchema.parse(receipt));
  if (parsed.operation === "generate") return;
  for (const input of [...parsed.inputs, ...(parsed.mask ? [parsed.mask] : [])]) {
    const receipt = receipts.find((item) => item.tenantId === parsed.tenantId && item.asset.projectId === parsed.projectId && item.asset.id === input.assetId);
    if (!receipt) reject("image_input_not_verified");
    const asset = receipt.asset;
    if (receipt.checksumSha256 !== input.checksumSha256 || asset.byteSize !== input.byteSize || asset.mimeType !== input.mimeType
      || asset.width !== input.width || asset.height !== input.height) reject("image_input_changed");
    if (input === parsed.mask) {
      if (asset.purpose !== "mask" || asset.sourceAssetId !== parsed.inputs[0].assetId || receipt.sourceChecksumSha256 !== parsed.inputs[0].checksumSha256) reject("image_mask_source_changed");
    } else if (asset.purpose === "mask") reject("image_source_is_mask");
  }
}

export function requireImageConfirmation(connection: ImageProviderConnection, request: ImageExecutionRequest, confirmedFingerprint: string, now: string): void {
  const current = validateImageProviderRequest(connection, request, now);
  if (current.fingerprint !== confirmedFingerprint) reject("image_confirmation_changed");
}

// No enable switch in milestone 1. A later trusted execution service must enforce
// this boundary before resolving credentials or creating a network request.
export function assertRealImageExecutionAllowed(): never { return reject("real_image_execution_disabled"); }

export function imageProviderPublicView(input: ImageProviderConnection) {
  const connection = ImageProviderConnectionSchema.parse(input);
  return ImageProviderPublicSchema.parse({
    id: connection.id, name: connection.name, protocol: connection.protocol, revision: connection.revision,
    enabled: connection.enabled, configuration: "valid" as const, diagnostic: connection.diagnostic,
    realExecutionEnabled: false as const,
    models: connection.models.map(({ version, ...capabilities }) => ({ ...capabilities, capabilityVersion: version })),
    extraParameters: connection.compatibility?.extraParameters ?? [],
  });
}
