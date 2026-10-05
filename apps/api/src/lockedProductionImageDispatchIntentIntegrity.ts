import { ConfirmedLockedProductionImageExecutionSchema, LockedProductionImageDispatchIntentSchema, LockedProductionImageLeaseEvidenceSchema, type ConfirmedLockedProductionImageExecution } from "@canvas/contracts";
import { ImageProviderContractError, imageSnapshotFingerprint as fp } from "./imageProviderContract";

// Pure historical consistency only; no current task, permission or live proof.
export function assertLockedDispatchIntent(input: unknown, fingerprint: string, confirmation: ConfirmedLockedProductionImageExecution, originalLease: unknown) {
  const i = LockedProductionImageDispatchIntentSchema.parse(input), e = ConfirmedLockedProductionImageExecutionSchema.parse(confirmation), l = LockedProductionImageLeaseEvidenceSchema.parse(originalLease), s = e.protocol;
  if (fp(i) !== fingerprint || i.mode !== e.mode || i.executionFingerprint !== fp(e) || i.leaseFingerprint !== fp(l)
    || i.protectionPolicyFingerprint !== fp(e.preparation.protectionPolicy) || l.protectionPolicyFingerprint !== i.protectionPolicyFingerprint
    || l.executionFingerprint !== fp(e) || l.mode !== e.mode || l.jobId !== s.request.jobId || l.batchId !== e.batchId
    || i.batchId !== e.batchId || i.jobId !== s.request.jobId || i.actorId !== l.actorId || i.workerId !== l.workerId || i.leaseId !== l.leaseId
    || i.requestFingerprint !== s.requestFingerprint || i.payloadChecksumSha256 !== s.payloadChecksumSha256 || i.payloadByteSize !== s.payloadByteSize
    || i.contentType !== s.contentType || i.transformedInputsFingerprint !== fp(s.transformedInputs) || i.protocolVersion !== s.protocolVersion
    || i.confirmedAt !== e.confirmedAt || Date.parse(l.leasedAt) < Date.parse(e.confirmedAt) || Date.parse(i.reconstructedAt) < Date.parse(l.leasedAt)
    || Date.parse(i.recordedAt) >= Date.parse(l.expiresAt) || Date.parse(i.recordedAt) >= Date.parse(s.request.quote.expiresAt)) throw new ImageProviderContractError("locked_intent_corrupt");
  return i;
}
