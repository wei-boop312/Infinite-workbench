import { randomUUID } from "node:crypto";
import { ProductionImageAttemptSchema, ProductionImageRawResponseSchema, type ImageProviderOutcome } from "@canvas/contracts";
import { imageSnapshotFingerprint, ImageProviderContractError } from "./imageProviderContract";
import { assertProductionConfirmation } from "./productionImageConfirmationIntegrity";
import { assertProductionDispatchIntent } from "./productionImageDispatchIntentIntegrity";
import { imagePayloadSha256 } from "./imageRequestPayload";
import { MAX_IMAGE_PROTOCOL_RESPONSE_BYTES, type ImageProtocolResponse } from "./imageProtocolResponse";
import { parseProductionOpenAiImageResponse } from "./openaiImageProtocol";
import { parseProductionCompatibleImageResponse } from "./compatibleImageProtocol";
import { parseProductionGoogleImageResponse } from "./googleImageProtocol";

function reject(): never { throw new ImageProviderContractError("production_image_response_evidence_invalid"); }
// Historical relations ONLY. This function does not load an actual task, check
// current permission/price/budget or prove a callback ran. Never a send permit.
export function assertProductionImageAttempt(input: unknown, fingerprint: string, confirmation: unknown, originalLease: unknown, intentInput: unknown) {
  const e = assertProductionConfirmation(confirmation), a = ProductionImageAttemptSchema.parse(input);
  const intent = assertProductionDispatchIntent(intentInput, imageSnapshotFingerprint(intentInput), e, originalLease), r = e.protocol.request;
  if (imageSnapshotFingerprint(a) !== fingerprint || a.mode !== e.mode || a.tenantId !== r.tenantId || a.projectId !== r.projectId
    || a.jobId !== r.jobId || a.batchId !== e.batchId || a.actorId !== intent.actorId || a.workerId !== intent.workerId || a.leaseId !== intent.leaseId
    || a.intentFingerprint !== imageSnapshotFingerprint(intent) || a.executionFingerprint !== imageSnapshotFingerprint(e)
    || a.leaseFingerprint !== intent.leaseFingerprint || a.requestFingerprint !== intent.requestFingerprint
    || a.payloadChecksumSha256 !== intent.payloadChecksumSha256 || Date.parse(a.attemptedAt) < Date.parse(intent.recordedAt)
    || Date.parse(a.attemptedAt) >= Date.parse((originalLease as { expiresAt: string }).expiresAt)
    || Date.parse(a.attemptedAt) >= Date.parse(r.quote.expiresAt)) reject();
  return { execution: e, attempt: a, intent };
}

// Independent production quote validation, sharing only the unchanged pure
// envelope algorithms. Missing estimates never become zero or the budget cap.
export function parseProductionImageResponse(confirmation: unknown, originalLease: unknown, intent: unknown, attempt: unknown,
  response: ImageProtocolResponse, receivedAt: string) {
  const { execution: e, attempt: a } = assertProductionImageAttempt(attempt, imageSnapshotFingerprint(attempt), confirmation, originalLease, intent);
  if (!response || !Buffer.isBuffer(response.body) || response.body.byteLength > MAX_IMAGE_PROTOCOL_RESPONSE_BYTES
    || !Number.isInteger(response.status) || response.status < 100 || response.status > 599
    || typeof response.contentType !== "string" || !/^[\x20-\x7e]{1,256}$/.test(response.contentType)
    || (response.requestId !== undefined && (typeof response.requestId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(response.requestId)))
    || !Number.isFinite(Date.parse(receivedAt)) || Date.parse(receivedAt) < Date.parse(a.attemptedAt)) reject();
  const protocol = e.preparation.connection.protocol, request = e.protocol.request;
  const parser = protocol === "openai" ? parseProductionOpenAiImageResponse : protocol === "openai-compatible" ? parseProductionCompatibleImageResponse
    : protocol === "google" ? parseProductionGoogleImageResponse : reject();
  ProductionImageRawResponseSchema.shape.receivedAt.parse(receivedAt);
  const parsed = parser(request, e.protocol.requestFingerprint, response, e.preparation.connection);
  try {
    const record = ProductionImageRawResponseSchema.parse({ schemaVersion: 1, mode: e.mode, kind: "returned",
      id: `production-image-response:${randomUUID()}`, attemptId: a.id, attemptFingerprint: imageSnapshotFingerprint(a), intentFingerprint: a.intentFingerprint,
      executionFingerprint: a.executionFingerprint, protocol, receivedAt, status: response.status, contentType: response.contentType,
      ...(response.requestId === undefined ? {} : { requestId: response.requestId }), bodyChecksumSha256: imagePayloadSha256(response.body),
      bodyByteSize: response.body.byteLength, outcome: parsed.outcome });
    return { record, candidate: parsed.candidate };
  } catch (error) { parsed.candidate?.body.fill(0); throw error; }
}

// Recovery re-parses bounded ORIGINAL bytes and compares the whole outcome,
// not merely caller-supplied body SHA or an already-labelled candidate.
export function assertProductionImageRawResponse(input: unknown, confirmation: unknown, originalLease: unknown, intent: unknown, attempt: unknown, body: Buffer) {
  const saved = ProductionImageRawResponseSchema.parse(input);
  const parsed = parseProductionImageResponse(confirmation, originalLease, intent, attempt,
    { status: saved.status, contentType: saved.contentType, requestId: saved.requestId, body }, saved.receivedAt);
  if (imageSnapshotFingerprint({ ...parsed.record, id: saved.id }) !== imageSnapshotFingerprint(saved)) { parsed.candidate?.body.fill(0); reject(); }
  return { record: saved, candidate: parsed.candidate };
}

// No transport exception strings, fabricated usage or zero-cost inference.
export function productionImageUnknownOutcome(confirmation: unknown, failureCode: "production-timeout" | "production-transport-error" | "production-response-invalid" | "production-response-save-failed"): ImageProviderOutcome {
  if (!["production-timeout", "production-transport-error", "production-response-invalid", "production-response-save-failed"].includes(failureCode)) reject();
  const e = assertProductionConfirmation(confirmation), r = e.protocol.request;
  return { schemaVersion: 1, tenantId: r.tenantId, projectId: r.projectId, jobId: r.jobId, connectionId: r.connectionId,
    requestFingerprint: e.protocol.requestFingerprint, providerStatus: "unknown", artifactStatus: "absent", usage: { source: "unavailable" }, billing: { state: "unknown" }, failureCode };
}
