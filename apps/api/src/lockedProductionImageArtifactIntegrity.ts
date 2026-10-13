import { LockedProductionImageArtifactSchema, type RunKernelStoredBatch } from "@canvas/contracts";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { assetMetadataFingerprint } from "./assetMetadata";

type Stored = Pick<RunKernelStoredBatch, "lockedProductionImageExecution" | "lockedProductionImageLeases" | "lockedProductionImageDispatchIntent" | "lockedProductionImageAttempt" | "lockedProductionImageResult">;
// Pure complete relationship validation, not current SQL or permission authority.
export function assertLockedProductionImageArtifact(s: Stored, input: unknown) {
  const r = LockedProductionImageArtifactSchema.parse(input), d = r.draft, e = s.lockedProductionImageExecution,
    a = s.lockedProductionImageAttempt, response = s.lockedProductionImageResult, l = s.lockedProductionImageLeases?.at(-1), i = s.lockedProductionImageDispatchIntent;
  if (!e || !a || !i || !l || response?.kind !== "returned" || response.outcome.artifactStatus !== "pending-validation" || response.outcome.failureCode
    || r.mode !== e.mode || r.tenantId !== e.protocol.request.tenantId || r.projectId !== e.protocol.request.projectId
    || r.jobId !== e.protocol.request.jobId || r.batchId !== e.batchId || d.mode !== r.mode || d.jobId !== r.jobId || d.batchId !== r.batchId
    || fp(d) !== r.draftFingerprint || d.executionFingerprint !== fp(e) || d.leaseFingerprint !== fp(l) || d.intentFingerprint !== fp(i)
    || d.attemptFingerprint !== fp(a) || d.responseFingerprint !== fp(response) || d.requestFingerprint !== e.protocol.requestFingerprint
    || d.payloadChecksumSha256 !== e.protocol.payloadChecksumSha256 || d.transformedInputsFingerprint !== fp(e.protocol.transformedInputs)
    || d.constraintChecksumSha256 !== e.protocol.request.constraintChecksumSha256 || fp(r.request) !== fp(e.protocol.request)
    || fp(r.constraint) !== fp(e.preparation.constraint) || fp(r.transformedInputs) !== fp(e.protocol.transformedInputs)
    || fp(r.protectionPolicy) !== fp(e.preparation.protectionPolicy) || d.protectionPolicyFingerprint !== fp(r.protectionPolicy)
    || fp(d.money) !== fp({ currency: e.protocol.request.quote.currency, maxCostMinor: e.protocol.request.quote.maxCostMinor,
      estimate: e.protocol.request.quote.source === "manual-budget" ? { state: "unknown" } : { state: "known", estimatedCostMinor: e.protocol.request.quote.estimatedCostMinor }, billing: "unknown" })
    || r.committedBy !== a.actorId || r.committedAt !== d.validatedAt || Date.parse(r.committedAt) < Date.parse(response.receivedAt)) throw new Error("保护产物缺少完整原任务证据");
  const p = r.protectionPolicy, proof = d.pixelProof, image = r.image, asset = image.asset, c = r.constraint;
  if (proof.tenantId !== r.tenantId || proof.projectId !== r.projectId || proof.constraintSnapshotId !== c.id || proof.constraintChecksumSha256 !== d.constraintChecksumSha256
    || proof.sourceAssetId !== p.source.asset.id || proof.maskAssetId !== p.mask.asset.id || proof.sourceChecksumSha256 !== p.source.checksumSha256
    || proof.maskChecksumSha256 !== p.mask.checksumSha256 || proof.sourcePixelsSha256 !== p.sourcePixelsSha256 || proof.maskPixelsSha256 !== p.maskPixelsSha256
    || proof.normalizationVersion !== p.normalizationVersion || proof.maskPolicy !== p.maskPolicy || proof.lockedPixels !== p.lockedPixels || proof.editablePixels !== p.editablePixels
    || proof.candidateChecksumSha256 !== d.image.checksumSha256 || proof.mimeType !== d.image.mimeType || proof.byteSize !== d.image.byteSize
    || proof.width !== d.image.width || proof.height !== d.image.height || Date.parse(proof.validatedAt) > Date.parse(r.committedAt) || Date.parse(proof.validatedAt) < Date.parse(response.receivedAt)
    || asset.purpose !== "generated" || asset.projectId !== r.projectId || image.tenantId !== r.tenantId || asset.sourceAssetId !== p.source.asset.id
    || image.verifiedBy !== r.committedBy || image.verifiedAt !== r.committedAt || asset.createdAt !== r.committedAt || image.decoder !== d.decoder
    || image.registeredMetadataSha256 !== assetMetadataFingerprint(asset) || image.checksumSha256 !== d.image.checksumSha256
    || asset.byteSize !== d.image.byteSize || asset.mimeType !== d.image.mimeType || asset.width !== d.image.width || asset.height !== d.image.height
    || asset.width !== c.outputSpec.width || asset.height !== c.outputSpec.height || asset.mimeType !== `image/${c.outputSpec.format}`
    || r.request.protection !== "pixel-exact" || !c.lockedPaths.includes("product.pixels")
    || (r.request.parameters.background === "transparent" && !d.image.hasTransparency) || (r.request.parameters.background === "opaque" && d.image.hasTransparency)) throw new Error("保护产物收据或固定像素证据不一致");
  return r;
}
