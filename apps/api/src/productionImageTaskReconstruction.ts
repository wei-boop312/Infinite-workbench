import { createHash } from "node:crypto";
import { ExecuteRunJobRequestSchema, type ConfirmedProductionImageExecution } from "@canvas/contracts";
import { imageSnapshotFingerprint } from "./imageProviderContract";
import { productionExpected } from "./productionImageConfirmationIntegrity";
import { prepareProductionImageProtocol } from "./productionImageProtocol";
import { MAX_IMAGE_PROTOCOL_REQUEST_BYTES, type TrustedImageBytes } from "./imageRequestPayload";
import { RunKernelError, type RunPrincipal } from "./runKernel";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";

type Options = { reconstructionEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore;
  runKernel: Pick<SqliteRunKernel, "usesStateStore" | "inspectProductionImageLease">; clock?: () => number };
let activeRebuilds = 0;
function reject(code: string, status = 409): never { throw new RunKernelError(status, code, "生产负载重建未通过核验，未启动或发送请求"); }
const publicCodes = new Set(["production_image_reconstruction_not_configured", "production_image_reconstruction_permission_denied",
  "production_image_reconstruction_cancelled", "production_image_reconstruction_busy", "production_image_reconstruction_mode_mismatch",
  "production_image_reconstruction_context_changed", "production_image_reconstruction_clock_invalid", "production_image_inputs_too_large",
  "production_image_input_not_verified", "production_image_reconstruction_payload_changed"]);
function strictTrue(value: unknown): void {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => undefined);
  if (value !== true) reject("production_image_reconstruction_not_configured", 503);
}

// Internal validation only. No wire, continuation token or caller-supplied
// confirmed/prepared context can authorize a start. The next SAME task/lease
// transaction must repeat these checks before recording its independent intent.
class ReconstructionCore {
  private readonly options?: Options;
  constructor(private readonly mode: ConfirmedProductionImageExecution["mode"], options?: Options) { this.options = options ? { ...options } : undefined; }
  async reconstruct(principal: RunPrincipal, projectId: string, batchId: string, jobId: string, input: unknown, signal?: AbortSignal) {
    const o = this.options;
    if (!o || o.reconstructionEnabled !== true || !o.tenantId.trim() || o.tenantId !== o.tenantId.trim()) reject("production_image_reconstruction_not_configured", 503);
    if (principal.tenantId !== o.tenantId) reject("production_image_reconstruction_permission_denied", 403);
    const p = { ...principal };
    const images: TrustedImageBytes[] = [];
    let body: Buffer | undefined, occupied = false;
    try {
      strictTrue(o.runKernel.usesStateStore(o.stateStore));
      const leaseInput = ExecuteRunJobRequestSchema.parse(input);
      const cancelled = () => { if (signal?.aborted) reject("production_image_reconstruction_cancelled"); };
      cancelled();
      if (activeRebuilds >= 2) reject("production_image_reconstruction_busy", 429);
      activeRebuilds++; occupied = true;
      const initial = o.runKernel.inspectProductionImageLease(p, projectId, batchId, jobId, leaseInput);
      if (initial.execution.mode !== this.mode) reject("production_image_reconstruction_mode_mismatch");
      const e = initial.execution, request = e.protocol.request;
      const executionFingerprint = imageSnapshotFingerprint(e), leaseFingerprint = imageSnapshotFingerprint(initial.lease);
      let lastTime = Date.parse(initial.lease.leasedAt);
      const guard = () => {
        cancelled();
        // This command verifies actual SQLite task/lease identity, current
        // authority/inputs/constraints/connection/pricing/budget, never just IDs.
        const current = o.runKernel.inspectProductionImageLease(p, projectId, batchId, jobId, leaseInput);
        if (imageSnapshotFingerprint(current.execution) !== executionFingerprint || imageSnapshotFingerprint(current.lease) !== leaseFingerprint) reject("production_image_reconstruction_context_changed");
        const now = o.clock?.() ?? Date.now();
        if (!Number.isSafeInteger(now) || now < lastTime || now >= Date.parse(initial.lease.expiresAt)
          || now >= Date.parse(request.quote.expiresAt)) reject("production_image_reconstruction_clock_invalid");
        lastTime = now; cancelled(); return new Date(now).toISOString();
      };
      const refs = request.operation === "edit" ? [...request.inputs, ...(request.mask ? [request.mask] : [])] : [];
      if (refs.reduce((total, ref) => total + ref.byteSize, 0) > MAX_IMAGE_PROTOCOL_REQUEST_BYTES) reject("production_image_inputs_too_large", 413);
      // Only owned SQLite byte copies leave the synchronous transaction. Each
      // actual read has checks on BOTH sides, including concurrent cancellation.
      o.stateStore.transaction(() => {
        for (const ref of refs) {
          guard();
          const image = o.stateStore.loadVerifiedImageBytes(p.tenantId, projectId, ref.assetId);
          if (!image) reject("production_image_input_not_verified");
          images.push(image); guard();
        }
      });
      const preparedAt = guard();
      // Deliberately outside SQL locks. Shared full decode/normalization slots
      // remain in the pure protocol implementation; no unbounded wait queue.
      const prepared = await prepareProductionImageProtocol(e.preparation, productionExpected(e.preparation),
        { jobId: request.jobId, idempotencyKey: request.idempotencyKey }, images, preparedAt);
      body = prepared.wire.body;
      const rebuilt = prepared.snapshot, original = e.protocol;
      if (rebuilt.mode !== e.mode || rebuilt.preparationId !== original.preparationId
        || rebuilt.preparationFingerprint !== original.preparationFingerprint || rebuilt.pricingFingerprint !== original.pricingFingerprint
        || rebuilt.protocolVersion !== original.protocolVersion || rebuilt.requestFingerprint !== original.requestFingerprint
        || imageSnapshotFingerprint(rebuilt.request) !== imageSnapshotFingerprint(original.request)
        || rebuilt.payloadChecksumSha256 !== original.payloadChecksumSha256 || rebuilt.payloadByteSize !== original.payloadByteSize
        || rebuilt.contentType !== original.contentType || imageSnapshotFingerprint(rebuilt.transformedInputs) !== imageSnapshotFingerprint(original.transformedInputs)
        || prepared.wire.requestFingerprint !== original.requestFingerprint || prepared.wire.payloadChecksumSha256 !== original.payloadChecksumSha256
        || prepared.wire.contentType !== original.contentType || body.byteLength !== original.payloadByteSize
        || createHash("sha256").update(body).digest("hex") !== original.payloadChecksumSha256) reject("production_image_reconstruction_payload_changed");
      // preparedAt is now, not the original confirmation time; comparing whole
      // snapshot hashes would incorrectly equate reconstruction with confirmation.
      const validatedAt = o.stateStore.transaction(guard);
      return { schemaVersion: 1 as const, mode: e.mode, batchId, jobId, executionFingerprint, leaseFingerprint,
        requestFingerprint: original.requestFingerprint, payloadChecksumSha256: original.payloadChecksumSha256,
        payloadByteSize: original.payloadByteSize, contentType: original.contentType,
        transformedInputs: structuredClone(original.transformedInputs), protocolVersion: original.protocolVersion,
        confirmedAt: e.confirmedAt, reconstructedAt: preparedAt, validatedAt,
        executionAuthorized: false as const, realExecutionEnabled: false as const, dispatchIntentRecorded: false as const };
    } catch (error) {
      if (error instanceof RunKernelError) throw new RunKernelError([403, 409, 413, 422, 429, 503].includes(error.status) ? error.status : 503,
        publicCodes.has(error.code) ? error.code : "production_image_reconstruction_rejected", "生产负载重建未通过核验，未启动或发送请求");
      reject("production_image_reconstruction_unavailable", 503);
    } finally {
      for (const image of images) image.body.fill(0);
      body?.fill(0); if (occupied) activeRebuilds--;
    }
  }
}
export class ProductionImageTaskReconstruction extends ReconstructionCore {
  constructor(options?: Options) { super("production", options); }
}
export class ImageProductionReconstructionHarness extends ReconstructionCore {
  constructor(options?: Options) { super("production-contract-fixture", options); }
}
