import { ProductionImageDispatchIntentSchema, ProductionImageLeaseEvidenceSchema } from "@canvas/contracts";
import { imageSnapshotFingerprint } from "./imageProviderContract";
import { assertProductionConfirmation } from "./productionImageConfirmationIntegrity";

// Pure historical consistency, NOT authorization. The caller must obtain the
// confirmation and original lease from the actual server store. A matching
// digest cannot prove permission, a current lease, budget or rebuilt bytes.
// No task/ledger storage, execution policy, credentials or network is accessed.
export function assertProductionDispatchIntent(input: unknown, fingerprint: string, confirmation: unknown, originalLease: unknown) {
  const intent = ProductionImageDispatchIntentSchema.parse(input);
  const e = assertProductionConfirmation(confirmation), lease = ProductionImageLeaseEvidenceSchema.parse(originalLease);
  const protocol = e.protocol, request = protocol.request;
  if (imageSnapshotFingerprint(intent) !== fingerprint || intent.mode !== e.mode || lease.mode !== e.mode
    || intent.executionFingerprint !== imageSnapshotFingerprint(e) || lease.executionFingerprint !== intent.executionFingerprint
    || intent.leaseFingerprint !== imageSnapshotFingerprint(lease)
    || intent.batchId !== e.batchId || lease.batchId !== e.batchId || intent.jobId !== request.jobId || lease.jobId !== request.jobId
    || intent.actorId !== lease.actorId || intent.workerId !== lease.workerId || intent.leaseId !== lease.leaseId
    || intent.requestFingerprint !== protocol.requestFingerprint || intent.payloadChecksumSha256 !== protocol.payloadChecksumSha256
    || intent.payloadByteSize !== protocol.payloadByteSize || intent.contentType !== protocol.contentType
    || intent.transformedInputsFingerprint !== imageSnapshotFingerprint(protocol.transformedInputs) || intent.protocolVersion !== protocol.protocolVersion
    || intent.confirmedAt !== e.confirmedAt || Date.parse(lease.leasedAt) < Date.parse(e.confirmedAt)
    || Date.parse(intent.reconstructedAt) < Date.parse(lease.leasedAt) || Date.parse(intent.recordedAt) >= Date.parse(lease.expiresAt)
    || Date.parse(intent.recordedAt) >= Date.parse(request.quote.expiresAt)) throw new Error("生产意图与原确认或运行租约关系不一致");
  return intent;
}
