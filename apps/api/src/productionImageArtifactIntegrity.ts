import { ProductionImageArtifactSchema, type RunKernelSnapshot } from "@canvas/contracts";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { assetMetadataFingerprint } from "./assetMetadata";

type Stored = Pick<RunKernelSnapshot["batches"][number], "productionImageExecution" | "productionImageLeases" | "productionImageDispatchIntent" | "productionImageAttempt" | "productionImageResult">;
// Pure relationship validation. No current permission or commit authority.
export function assertProductionImageArtifact(stored: Stored, incoming: unknown) {
  const record = ProductionImageArtifactSchema.parse(incoming), d = record.draft, e = stored.productionImageExecution,
    a = stored.productionImageAttempt, r = stored.productionImageResult, l = stored.productionImageLeases?.at(-1), i = stored.productionImageDispatchIntent;
  if (!e || !a || !i || !l || r?.kind !== "returned" || r.outcome.artifactStatus !== "pending-validation" || r.outcome.failureCode
    || record.mode !== e.mode || record.tenantId !== e.protocol.request.tenantId || record.projectId !== e.protocol.request.projectId
    || record.jobId !== e.protocol.request.jobId || record.batchId !== e.batchId || d.mode !== record.mode || d.jobId !== record.jobId || d.batchId !== record.batchId
    || fp(d) !== record.draftFingerprint || d.executionFingerprint !== fp(e) || d.leaseFingerprint !== fp(l) || d.intentFingerprint !== fp(i)
    || d.attemptFingerprint !== fp(a) || d.responseFingerprint !== fp(r) || d.requestFingerprint !== e.protocol.requestFingerprint
    || d.payloadChecksumSha256 !== e.protocol.payloadChecksumSha256 || d.transformedInputsFingerprint !== fp(e.protocol.transformedInputs)
    || d.constraintChecksumSha256 !== e.protocol.request.constraintChecksumSha256 || fp(record.request) !== fp(e.protocol.request)
    || fp(record.constraint) !== fp(e.preparation.constraint) || fp(record.transformedInputs) !== fp(e.protocol.transformedInputs)
    || fp(d.money) !== fp({ currency: e.protocol.request.quote.currency, maxCostMinor: e.protocol.request.quote.maxCostMinor,
      estimate: e.protocol.request.quote.source === "manual-budget" ? { state: "unknown" } : { state: "known", estimatedCostMinor: e.protocol.request.quote.estimatedCostMinor }, billing: "unknown" })
    || record.committedBy !== a.actorId || record.committedAt !== d.validatedAt || Date.parse(record.committedAt) < Date.parse(r.receivedAt)) throw new Error("生产产物缺少完整原任务证据");
  const image = record.image, asset = image.asset, c = record.constraint;
  if (asset.purpose !== "generated" || asset.projectId !== record.projectId || image.tenantId !== record.tenantId
    || image.verifiedBy !== record.committedBy || image.verifiedAt !== record.committedAt || asset.createdAt !== record.committedAt
    || image.decoder !== d.decoder || image.registeredMetadataSha256 !== assetMetadataFingerprint(asset)
    || image.checksumSha256 !== d.image.checksumSha256 || asset.byteSize !== d.image.byteSize || asset.mimeType !== d.image.mimeType
    || asset.width !== d.image.width || asset.height !== d.image.height || asset.width !== c.outputSpec.width || asset.height !== c.outputSpec.height
    || asset.mimeType !== `image/${c.outputSpec.format}` || record.request.protection !== "none" || c.lockedPaths.includes("product.pixels")
    || asset.sourceAssetId !== (record.request.operation === "edit" ? record.request.inputs[0].assetId : undefined)
    || (record.request.parameters.background === "transparent" && !d.image.hasTransparency)
    || (record.request.parameters.background === "opaque" && d.image.hasTransparency)) throw new Error("生产产物收据与校验/约束不一致");
  return record;
}
