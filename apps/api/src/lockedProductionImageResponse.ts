import { randomUUID } from "node:crypto";
import { LockedProductionImageAttemptSchema, LockedProductionImageRawResponseSchema, LockedProductionImageResultSchema,
  type ImageProviderOutcome } from "@canvas/contracts";
import { imageSnapshotFingerprint as fp, ImageProviderContractError } from "./imageProviderContract";
import { assertLockedConfirmation } from "./lockedProductionImageProtocol";
import { assertLockedDispatchIntent } from "./lockedProductionImageDispatchIntentIntegrity";
import { imagePayloadSha256 } from "./imageRequestPayload";
import { parseLockedProductionOpenAiImageResponse } from "./openaiImageProtocol";
import { MAX_IMAGE_PROTOCOL_RESPONSE_BYTES, type ImageProtocolResponse } from "./imageProtocolResponse";

function reject(): never { throw new ImageProviderContractError("locked_image_response_evidence_invalid"); }
// Pure historical consistency only, never an actual task or send permit.
export function assertLockedImageAttempt(input: unknown, fingerprint: string, confirmation: unknown, lease: unknown, intentInput: unknown) {
  const e = assertLockedConfirmation(confirmation), a = LockedProductionImageAttemptSchema.parse(input);
  const i = assertLockedDispatchIntent(intentInput, fp(intentInput), e, lease), r = e.protocol.request;
  if (fp(a) !== fingerprint || a.mode !== e.mode || a.tenantId !== r.tenantId || a.projectId !== r.projectId || a.jobId !== r.jobId || a.batchId !== e.batchId
    || a.actorId !== i.actorId || a.workerId !== i.workerId || a.leaseId !== i.leaseId || a.intentFingerprint !== fp(i) || a.executionFingerprint !== fp(e)
    || a.leaseFingerprint !== i.leaseFingerprint || a.protectionPolicyFingerprint !== fp(e.preparation.protectionPolicy)
    || a.requestFingerprint !== i.requestFingerprint || a.payloadChecksumSha256 !== i.payloadChecksumSha256
    || Date.parse(a.attemptedAt) < Date.parse(i.recordedAt) || Date.parse(a.attemptedAt) >= Date.parse((lease as { expiresAt: string }).expiresAt)
    || Date.parse(a.attemptedAt) >= Date.parse(r.quote.expiresAt)) reject();
  return { execution: e, attempt: a, intent: i };
}
export function assertLockedImageResult(input: unknown, fingerprint: string, confirmation: unknown, attemptInput: unknown) {
  const e = assertLockedConfirmation(confirmation), a = LockedProductionImageAttemptSchema.parse(attemptInput), r = LockedProductionImageResultSchema.parse(input), o = r.outcome;
  if (fp(r) !== fingerprint || r.mode !== e.mode || r.attemptId !== a.id || r.attemptFingerprint !== fp(a) || r.intentFingerprint !== a.intentFingerprint
    || r.executionFingerprint !== fp(e) || r.protectionPolicyFingerprint !== a.protectionPolicyFingerprint || o.tenantId !== a.tenantId || o.projectId !== a.projectId
    || o.jobId !== a.jobId || o.connectionId !== e.protocol.request.connectionId || o.requestFingerprint !== a.requestFingerprint
    || Date.parse(r.kind === "returned" ? r.receivedAt : r.interruptedAt) < Date.parse(a.attemptedAt)) reject();
  return r;
}
export function parseLockedImageResponse(confirmation: unknown, lease: unknown, intent: unknown, attempt: unknown, response: ImageProtocolResponse, receivedAt: string) {
  const { execution: e, attempt: a } = assertLockedImageAttempt(attempt, fp(attempt), confirmation, lease, intent);
  if (!response || !Buffer.isBuffer(response.body) || response.body.length > MAX_IMAGE_PROTOCOL_RESPONSE_BYTES || !Number.isInteger(response.status)
    || response.status < 100 || response.status > 599 || typeof response.contentType !== "string" || !/^[\x20-\x7e]{1,256}$/.test(response.contentType)
    || response.requestId !== undefined && (typeof response.requestId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(response.requestId))) reject();
  LockedProductionImageRawResponseSchema.shape.receivedAt.parse(receivedAt);
  if (Date.parse(receivedAt) < Date.parse(a.attemptedAt)) reject();
  const parsed = parseLockedProductionOpenAiImageResponse(e.protocol.request, e.protocol.requestFingerprint, response, e.preparation.connection, e.confirmedAt);
  try { const record = LockedProductionImageRawResponseSchema.parse({ schemaVersion: 2, mode: e.mode, kind: "returned", id: `locked-production-image-response:${randomUUID()}`,
    attemptId: a.id, attemptFingerprint: fp(a), intentFingerprint: a.intentFingerprint, executionFingerprint: a.executionFingerprint,
    protectionPolicyFingerprint: a.protectionPolicyFingerprint, protocol: e.preparation.connection.protocol, receivedAt, status: response.status, contentType: response.contentType,
    ...(response.requestId === undefined ? {} : { requestId: response.requestId }), bodyChecksumSha256: imagePayloadSha256(response.body), bodyByteSize: response.body.length, outcome: parsed.outcome });
    return { record, candidate: parsed.candidate }; } catch (error) { parsed.candidate?.body.fill(0); throw error; }
}
export function assertLockedImageRawResponse(input: unknown, confirmation: unknown, lease: unknown, intent: unknown, attempt: unknown, body: Buffer) {
  const r = LockedProductionImageRawResponseSchema.parse(input), parsed = parseLockedImageResponse(confirmation, lease, intent, attempt,
    { status: r.status, contentType: r.contentType, requestId: r.requestId, body }, r.receivedAt);
  if (fp({ ...parsed.record, id: r.id }) !== fp(r)) { parsed.candidate?.body.fill(0); reject(); }
  return { record: r, candidate: parsed.candidate };
}
export function lockedImageUnknownOutcome(confirmation: unknown, failureCode: "production-timeout" | "production-transport-error" | "production-response-invalid" | "production-response-save-failed"): ImageProviderOutcome {
  if (!["production-timeout", "production-transport-error", "production-response-invalid", "production-response-save-failed"].includes(failureCode)) reject();
  const e = assertLockedConfirmation(confirmation), r = e.protocol.request;
  return { schemaVersion: 1, tenantId: r.tenantId, projectId: r.projectId, jobId: r.jobId, connectionId: r.connectionId,
    requestFingerprint: e.protocol.requestFingerprint, providerStatus: "unknown", artifactStatus: "absent", usage: { source: "unavailable" }, billing: { state: "unknown" }, failureCode };
}
