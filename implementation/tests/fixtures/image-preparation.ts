import { createHash } from "node:crypto";
import { ConstraintSnapshotSchema, ImageProviderConnectionSchema, ImagePreparationPublicSchema, ImageConfirmationPublicSchema,
  type ConstraintSnapshot, type CreateImagePreparation, type ImageProviderConnection, type ImagePreparationPublic } from "../../packages/contracts/src/index";
import { imageProviderPublicView } from "../../apps/api/src/imageProviderContract";

export const fixtureTime = "2026-10-04T00:00:00.000Z";
// Pure public contract fixtures; never registered in the daily bridge.
export function fixtureConnection(protocol: ImageProviderConnection["protocol"] = "openai"): ImageProviderConnection {
  return ImageProviderConnectionSchema.parse({ schemaVersion: 1, id: `fixture-${protocol}`, tenantId: "local-studio", projectId: "project-a",
    name: `零费用合同 ${protocol}`, revision: 1, protocol, adapterId: "fixture-image-v1", baseUrl: "https://never-called.invalid/v1",
    credentialRef: "opaque-not-resolved", enabled: true, diagnostic: { state: "not-run" },
    ...(protocol === "openai-compatible" ? { compatibility: { version: "relay-v1", endpoints: { generate: "/images/generations", edit: "/images/edits" },
      editEncoding: "multipart-image-array", auth: { scheme: "header", headerName: "x-api-key" }, responseEncoding: "images-b64-json-v1",
      extraParameters: [{ name: "seed", type: "integer", minimum: 0, maximum: 100, operations: ["generate"] },
        { name: "watermark", type: "boolean", operations: ["generate", "edit"] }, { name: "style_hint", type: "enum", values: ["studio", "natural"], operations: ["generate", "edit"] }] } } : {}),
    models: [{ model: "explicit-fixture-model", version: "caps-v1", operations: ["generate", "edit"], inputMimeTypes: ["image/png", "image/jpeg", "image/webp"],
      outputFormats: protocol === "google" ? ["jpeg"] : ["png", "jpeg", "webp"], maxInputImages: 2, maxPromptCharacters: 1000,
      maxInputEdge: 8192, maxInputPixels: 16000000, maxInputBytes: 30 * 1024 * 1024, maxTotalInputBytes: 60 * 1024 * 1024,
      sizes: { allowAuto: protocol !== "google", presets: [{ width: 1024, height: 1024 }, { width: 4096, height: 4096 }] },
      qualities: ["auto", "high"], backgrounds: ["auto", "opaque", "transparent"], inputFidelities: protocol === "google" ? [] : ["low", "high"],
      supportsOutputCompression: protocol !== "google", mask: protocol === "google" ? { mode: "none", polarity: "unsupported" } : { mode: "prompt-guidance", polarity: "transparent-edit" }, evidence: { state: "declared" } }] });
}
export function fixturePublicConfirmation(record = fixturePublicPreparation()) {
  const template = record.requestTemplate, quote = record.pricing.quote;
  const ids = [...template.inputs.map(input => input.assetId), ...(template.operation === "edit" && template.mask ? [template.mask.assetId] : [])];
  return ImageConfirmationPublicSchema.parse({ mode: "local-fixture", realExecutionEnabled: false, executionAuthorized: false,
    executionState: "confirmed-not-dispatchable", protocolPreparation: "prepared", preparationId: record.id, preparationFingerprint: record.snapshotFingerprint,
    executionFingerprint: "d".repeat(64), requestFingerprint: "e".repeat(64), payloadChecksumSha256: "f".repeat(64),
    transformedInputs: [...template.inputs, ...(template.operation === "edit" && template.mask ? [template.mask] : [])].map((ref, index) => ({
      assetId: ref.assetId, originalChecksumSha256: ref.checksumSha256, transmittedChecksumSha256: "9".repeat(64),
      transform: index < template.inputs.length ? "exif-srgb-png-v1" : "internal-white-to-transparent-mask-v1" })),
    confirmedBy: "fixture-designer", confirmedAt: record.createdAt, aggregate: { batch: { id: "batch-a", tenantId: template.tenantId, projectId: record.projectId,
      constraintSnapshotId: record.constraint.id, tool: template.operation === "generate" ? "image-generate" : "image-edit", adapterId: template.adapterId,
      inputAssetIds: ids, idempotencyKey: `image-confirm:${record.id}`, status: "queued", expectedOutputs: 1, estimatedCostMinor: quote.estimatedCostMinor,
      maxCostMinor: quote.maxCostMinor, currency: quote.currency, confirmedBy: "fixture-designer", confirmedAt: record.createdAt, createdAt: record.createdAt },
      jobs: [{ id: "job-a", batchId: "batch-a", outputIndex: 0, attempt: 1, executorKind: "provider", adapterId: template.adapterId, idempotencyKey: "independent-execution-key",
        status: "queued", inputAssetIds: ids, outputAssetIds: [], estimatedCostMinor: quote.estimatedCostMinor, createdAt: record.createdAt }], ledger: [], audit: [], billingOverages: [] } });
}
export function fixtureConstraint(extra: Partial<ConstraintSnapshot> = {}): ConstraintSnapshot {
  return { id: "constraint-a", projectId: "project-a", lockedPaths: [], editableRegions: [{ id: "region-a", description: "人工指定布局" }],
    brandRules: { tone: "人工设计" }, outputSpec: { width: 1024, height: 1024, format: "png" }, createdAt: fixtureTime, ...extra };
}
export function fixtureSelection(): CreateImagePreparation {
  return { projectId: "project-a", idempotencyKey: "human-action", connectionId: "fixture-openai", connectionRevision: 1, model: "explicit-fixture-model",
    capabilityVersion: "caps-v1", constraintSnapshotId: "constraint-a", protection: "none", operation: "generate", inputAssetIds: [],
    parameters: { prompt: "人工设计目标", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", outputFormat: "png", background: "opaque" } };
}
export function fixturePublicPreparation(selection = fixtureSelection(), id = "preparation-a"): ImagePreparationPublic {
  const { inputAssetIds, idempotencyKey: _key, maskAssetId: _mask, ...fields } = { ...selection, maskAssetId: undefined };
  const quote = { id: "fixture-quote", version: "fake-price-v1", source: "server-price-table", currency: "CNY", estimatedCostMinor: 25,
    maxCostMinor: 30, expiresAt: "2099-10-04T00:00:00.000Z" };
  const constraint = ConstraintSnapshotSchema.parse(fixtureConstraint({ projectId: selection.projectId, id: selection.constraintSnapshotId,
    outputSpec: { ...(selection.parameters.size === "auto" ? { width: 1024, height: 1024 } : selection.parameters.size), format: selection.parameters.outputFormat } }));
  return ImagePreparationPublicSchema.parse({ id, projectId: selection.projectId, status: "unconfirmed", executionAuthorized: false,
    protocolPreparation: "not-run", mode: "local-fixture", createdAt: fixtureTime, snapshotFingerprint: "a".repeat(64),
    connection: imageProviderPublicView(fixtureConnection(selection.connectionId.replace("fixture-", "") as ImageProviderConnection["protocol"])),
    constraint,
    requestTemplate: { ...fields, schemaVersion: 1, tenantId: "local-studio", adapterId: "fixture-image-v1", constraintChecksumSha256: createHash("sha256").update(JSON.stringify(constraint)).digest("hex"), quote,
      inputs: inputAssetIds.map(assetId => ({ assetId, checksumSha256: "c".repeat(64), mimeType: "image/png", byteSize: 68, width: 1, height: 1 })) },
    pricing: { mode: "local-fixture", evidenceRef: "not-real-price", quote } });
}
