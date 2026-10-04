import { createHash, randomUUID } from "node:crypto";
import { ExecuteRunJobRequestSchema, type ConfirmedProductionImageExecution, type ProductionImageDispatchIntent, type ProductionImageLeaseEvidence } from "@canvas/contracts";
import { imageSnapshotFingerprint } from "./imageProviderContract";
import { productionExpected } from "./productionImageConfirmationIntegrity";
import { prepareProductionImageProtocol } from "./productionImageProtocol";
import { MAX_IMAGE_PROTOCOL_REQUEST_BYTES, type TrustedImageBytes } from "./imageRequestPayload";
import { RunKernelError, type RunPrincipal } from "./runKernel";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import type { ProductionImageLeasePolicy } from "./productionImageLeasePolicy";
import { assertProductionDispatchIntent } from "./productionImageDispatchIntentIntegrity";

type Options = { reconstructionEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore;
  runKernel: Pick<SqliteRunKernel, "usesStateStore" | "inspectProductionImageLease"> & Partial<Pick<SqliteRunKernel, "inspectProductionImageStart" | "startProductionImageJob">>;
  startEnabled?: true; leasePolicy?: ProductionImageLeasePolicy; clock?: () => number };
let activeRebuilds = 0;
function reject(code: string, status = 409): never { throw new RunKernelError(status, code, "生产负载重建未通过核验，未启动或发送请求"); }
const publicCodes = new Set(["production_image_reconstruction_not_configured", "production_image_reconstruction_permission_denied",
  "production_image_reconstruction_cancelled", "production_image_reconstruction_busy", "production_image_reconstruction_mode_mismatch",
  "production_image_reconstruction_context_changed", "production_image_reconstruction_clock_invalid", "production_image_inputs_too_large",
  "production_image_input_not_verified", "production_image_reconstruction_payload_changed"]);
function exactTrue(value: unknown): boolean {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => undefined);
  return value === true;
}
function strictTrue(value: unknown): void { if (!exactTrue(value)) reject("production_image_reconstruction_not_configured", 503); }

// reconstruct remains read-only. start separately opts into a private live
// continuation and SAME task/lease transaction; neither operation sends.
class ReconstructionCore {
  private readonly options?: Options;
  private readonly pending = new Map<string, string>();
  constructor(private readonly mode: ConfirmedProductionImageExecution["mode"], options?: Options) { this.options = options ? { ...options } : undefined; }
  // A separate kernel start policy. The pending proof exists ONLY during this
  // instance's matched wire continuation, never in a B1 result or HTTP input.
  readonly usesStateStore = (store: unknown): boolean => {
    try { const o = this.options; return !!o && o.startEnabled === true && store === o.stateStore
      && exactTrue(o.runKernel.usesStateStore(o.stateStore)) && exactTrue(o.leasePolicy?.usesStateStore(o.stateStore)); }
    catch { return false; }
  };
  readonly authorizeScope = (p: RunPrincipal, project: string): boolean => {
    const o = this.options;
    if (!o || !this.usesStateStore(o.stateStore) || p.tenantId !== o.tenantId) return false;
    return exactTrue(o.leasePolicy!.authorizeScope(p, project));
  };
  readonly validateStart = (p: RunPrincipal, e: ConfirmedProductionImageExecution, lease: ProductionImageLeaseEvidence, intent: ProductionImageDispatchIntent): boolean => {
    const hash = imageSnapshotFingerprint(intent);
    if (!this.authorizeScope(p, e.preparation.projectId) || e.mode !== this.mode
      || this.pending.get(hash) !== `${p.tenantId}\u0000${p.actorId}`) return false;
    assertProductionDispatchIntent(intent, hash, e, lease);
    return exactTrue(this.options!.leasePolicy!.validate(p, e, "start", 0));
  };
  reconstruct(principal: RunPrincipal, projectId: string, batchId: string, jobId: string, input: unknown, signal?: AbortSignal) {
    return this.rebuild(principal, projectId, batchId, jobId, input, signal, false).then((result) => result.summary!);
  }
  start(principal: RunPrincipal, projectId: string, batchId: string, jobId: string, input: unknown, signal?: AbortSignal) {
    return this.rebuild(principal, projectId, batchId, jobId, input, signal, true).then((result) => result.start!);
  }
  private async rebuild(principal: RunPrincipal, projectId: string, batchId: string, jobId: string, input: unknown, signal: AbortSignal | undefined, start: boolean) {
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
      const historical = () => {
        const current = o.runKernel.inspectProductionImageStart!(p, projectId, batchId, jobId, leaseInput);
        if (current.execution.mode !== this.mode) reject("production_image_reconstruction_mode_mismatch");
        return current;
      };
      if (start) {
        if (!this.usesStateStore(o.stateStore) || !o.runKernel.inspectProductionImageStart || !o.runKernel.startProductionImageJob) reject("production_image_reconstruction_not_configured", 503);
        const previous = historical(); cancelled();
        if (previous.intent) return { start: { aggregate: previous.aggregate, intent: previous.intent, started: false,
          executionAuthorized: false as const, realExecutionEnabled: false as const } };
      }
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
      let committed: ReturnType<SqliteRunKernel["startProductionImageJob"]> | undefined;
      const validatedAt = o.stateStore.transaction(() => {
        const at = guard();
        if (start) {
          const intent: ProductionImageDispatchIntent = { schemaVersion: 1, mode: e.mode, transport: "not-connected", id: `production-image-intent:${randomUUID()}`,
            jobId, batchId, actorId: p.actorId, workerId: initial.lease.workerId, leaseId: initial.lease.leaseId, executionFingerprint, leaseFingerprint,
            requestFingerprint: original.requestFingerprint, payloadChecksumSha256: original.payloadChecksumSha256, payloadByteSize: original.payloadByteSize,
            contentType: original.contentType, transformedInputsFingerprint: imageSnapshotFingerprint(original.transformedInputs), protocolVersion: original.protocolVersion,
            confirmedAt: e.confirmedAt, reconstructedAt: preparedAt, recordedAt: at };
          const hash = imageSnapshotFingerprint(intent); this.pending.set(hash, `${p.tenantId}\u0000${p.actorId}`);
          try { committed = o.runKernel.startProductionImageJob!(p, projectId, batchId, jobId, leaseInput, intent); cancelled(); }
          finally { this.pending.delete(hash); }
        }
        return at;
      });
      if (committed) return { start: { ...committed, executionAuthorized: false as const, realExecutionEnabled: false as const } };
      return { summary: { schemaVersion: 1 as const, mode: e.mode, batchId, jobId, executionFingerprint, leaseFingerprint,
        requestFingerprint: original.requestFingerprint, payloadChecksumSha256: original.payloadChecksumSha256,
        payloadByteSize: original.payloadByteSize, contentType: original.contentType,
        transformedInputs: structuredClone(original.transformedInputs), protocolVersion: original.protocolVersion,
        confirmedAt: e.confirmedAt, reconstructedAt: preparedAt, validatedAt,
        executionAuthorized: false as const, realExecutionEnabled: false as const, dispatchIntentRecorded: false as const } };
    } catch (error) {
      // Concurrent live continuations may race. Recover ONLY the same already
      // committed intent under current permissions, never re-run reconstruction.
      if (start && !signal?.aborted && o.runKernel.inspectProductionImageStart && this.usesStateStore(o.stateStore)) {
        try {
          const history = o.runKernel.inspectProductionImageStart(p, projectId, batchId, jobId, ExecuteRunJobRequestSchema.parse(input));
          if (history.execution.mode === this.mode && history.intent) return { start: { aggregate: history.aggregate, intent: history.intent,
            started: false, executionAuthorized: false as const, realExecutionEnabled: false as const } };
        } catch { /* Failure remains closed; no refresh/retry or private exception. */ }
      }
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
