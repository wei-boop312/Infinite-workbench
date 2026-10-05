import { LockedProductionImageExecutionRequestSchema, ProductionImageTaskIdentitySchema } from "@canvas/contracts";
import { imageSnapshotFingerprint, validateLockedProductionImagePreparationRequest } from "./imageProviderContract";

// Encoder-only projection. The actual v2 request is hashed in full; policies
// never become arbitrary provider fields or pass through the old send gate.
export function validateLockedProtocolRequest(connection: unknown, input: unknown, now: string) {
  const request = LockedProductionImageExecutionRequestSchema.parse(input);
  ProductionImageTaskIdentitySchema.parse({ jobId: request.jobId, idempotencyKey: request.idempotencyKey });
  const { protectionPolicy: _policy, schemaVersion: _version, ...fields } = request;
  const validated = validateLockedProductionImagePreparationRequest(connection, { schemaVersion: 1, ...fields }, now);
  return { ...validated, fingerprint: imageSnapshotFingerprint({ connection: validated.connection, request }) };
}
