import { createHash, randomUUID } from "node:crypto";
import { ExecuteRunJobRequestSchema, type ConfirmedProductionImageExecution, type ProductionImageDispatchIntent, type ProductionImageLeaseEvidence, type ProductionImageAttempt, type ProductionImageResult } from "@canvas/contracts";
import { imageSnapshotFingerprint } from "./imageProviderContract";
import { productionExpected } from "./productionImageConfirmationIntegrity";
import { prepareProductionImageProtocol } from "./productionImageProtocol";
import { MAX_IMAGE_PROTOCOL_REQUEST_BYTES, type TrustedImageBytes } from "./imageRequestPayload";
import { RunKernelError, type RunPrincipal, type ProductionImageResponsePolicy } from "./runKernel";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import type { ProductionImageLeasePolicy } from "./productionImageLeasePolicy";
import { assertProductionDispatchIntent } from "./productionImageDispatchIntentIntegrity";
import { assertProductionImageAttempt, parseProductionImageResponse, productionImageUnknownOutcome } from "./productionImageResponse";
import { assertProductionImageResult } from "./productionImageResultIntegrity";
import { MAX_IMAGE_PROTOCOL_RESPONSE_BYTES, type ImageProtocolResponse } from "./imageProtocolResponse";

export type ProductionFixtureTransport = { kind: "contract-fixture"; realExecutionEnabled: false;
  send(input: { wire: Awaited<ReturnType<typeof prepareProductionImageProtocol>>["wire"]; signal: AbortSignal; assertCurrent(): void }): Promise<ImageProtocolResponse> };

type Options = { reconstructionEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore;
  runKernel: Pick<SqliteRunKernel, "usesStateStore" | "inspectProductionImageLease"> & Partial<Pick<SqliteRunKernel, "inspectProductionImageStart" | "startProductionImageJob" | "inspectProductionImageAttempt" | "beginProductionImageAttempt" | "assertProductionImageAttemptCurrent" | "recordProductionImageResult">>;
  startEnabled?: true; leasePolicy?: ProductionImageLeasePolicy; clock?: () => number;
  responseHandlingEnabled?: true; fixtureTransport?: ProductionFixtureTransport; timeoutMs?: number };
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
  private readonly attempts = new Map<string, string>();
  private readonly attemptSignals = new Map<string, AbortSignal>();
  private readonly results = new Map<string, string>();
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
  readonly responsePolicy: ProductionImageResponsePolicy = {
    usesStateStore: store => {
      const o = this.options;
      return !!o && o.responseHandlingEnabled === true && this.mode === "production-contract-fixture"
        && o.fixtureTransport?.kind === "contract-fixture" && o.fixtureTransport.realExecutionEnabled === false
        && o.stateStore.supportsProductionImageResponses() && this.usesStateStore(store);
    },
    authorizeScope: (p, project) => !!this.options && this.responsePolicy.usesStateStore(this.options.stateStore) && this.authorizeScope(p, project),
    validateAttempt: (p, e, l, i, a) => {
      if (!this.responsePolicy.authorizeScope(p, e.preparation.projectId) || this.attempts.get(imageSnapshotFingerprint(a)) !== `${p.tenantId}\u0000${p.actorId}`
        || this.attemptSignals.get(imageSnapshotFingerprint(a))?.aborted !== false) return false;
      assertProductionImageAttempt(a, imageSnapshotFingerprint(a), e, l, i);
      return exactTrue(this.options!.leasePolicy!.validate(p, e, "start", 0));
    },
    validateResult: (p, e, l, i, a, r) => {
      if (!this.responsePolicy.authorizeScope(p, e.preparation.projectId) || this.results.get(imageSnapshotFingerprint(r)) !== `${p.tenantId}\u0000${p.actorId}`) return false;
      assertProductionImageAttempt(a, imageSnapshotFingerprint(a), e, l, i); assertProductionImageResult(r, imageSnapshotFingerprint(r), e, a);
      return exactTrue(this.options!.leasePolicy!.validate(p, e, "history", 0));
    },
  };
  reconstruct(principal: RunPrincipal, projectId: string, batchId: string, jobId: string, input: unknown, signal?: AbortSignal) {
    return this.rebuild(principal, projectId, batchId, jobId, input, signal, false).then((result) => result.summary!);
  }
  start(principal: RunPrincipal, projectId: string, batchId: string, jobId: string, input: unknown, signal?: AbortSignal) {
    return this.rebuild(principal, projectId, batchId, jobId, input, signal, true).then((result) => result.start!);
  }
  // Independent zero-cost contract harness only. Production/native wiring is
  // deliberately absent; a later caller cannot turn a B2 started result into a permit.
  async executeFixture(principal: RunPrincipal, projectId: string, batchId: string, jobId: string, input: unknown, signal?: AbortSignal) {
    const o = this.options, timeout = o?.timeoutMs ?? 5_000;
    if (!o || !this.responsePolicy.usesStateStore(o.stateStore) || !o.runKernel.inspectProductionImageAttempt || !o.runKernel.beginProductionImageAttempt
      || !o.runKernel.assertProductionImageAttemptCurrent || !o.runKernel.recordProductionImageResult || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) reject("production_image_response_not_configured", 503);
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(abort, timeout);
    try { return (await this.rebuild(principal, projectId, batchId, jobId, input, controller.signal, true, true)).start!; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }
  }
  private async rebuild(principal: RunPrincipal, projectId: string, batchId: string, jobId: string, input: unknown, signal: AbortSignal | undefined, start: boolean, execute = false) {
    const o = this.options;
    if (!o || o.reconstructionEnabled !== true || !o.tenantId.trim() || o.tenantId !== o.tenantId.trim()) reject("production_image_reconstruction_not_configured", 503);
    if (principal.tenantId !== o.tenantId) reject("production_image_reconstruction_permission_denied", 403);
    const p = { ...principal };
    const images: TrustedImageBytes[] = [];
    let body: Buffer | undefined, occupied = false, continued = false;
    const resource: { pending?: Promise<unknown> } = {};
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
        const previous = execute ? o.runKernel.inspectProductionImageAttempt!(p, projectId, batchId, jobId, leaseInput) : historical(); cancelled();
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
      if (committed) {
        if (execute && committed.started) {
          continued = true;
          const aggregate = await this.continueFixture(p, projectId, batchId, jobId, leaseInput, e, initial.lease, committed.intent, prepared.wire, signal!, resource);
          return { start: { ...committed, aggregate, executionAuthorized: false as const, realExecutionEnabled: false as const } };
        }
        return { start: { ...committed, executionAuthorized: false as const, realExecutionEnabled: false as const } };
      }
      return { summary: { schemaVersion: 1 as const, mode: e.mode, batchId, jobId, executionFingerprint, leaseFingerprint,
        requestFingerprint: original.requestFingerprint, payloadChecksumSha256: original.payloadChecksumSha256,
        payloadByteSize: original.payloadByteSize, contentType: original.contentType,
        transformedInputs: structuredClone(original.transformedInputs), protocolVersion: original.protocolVersion,
        confirmedAt: e.confirmedAt, reconstructedAt: preparedAt, validatedAt,
        executionAuthorized: false as const, realExecutionEnabled: false as const, dispatchIntentRecorded: false as const } };
    } catch (error) {
      // Concurrent live continuations may race. Recover ONLY the same already
      // committed intent under current permissions, never re-run reconstruction.
      if (start && (!execute || !continued) && !signal?.aborted && o.runKernel.inspectProductionImageStart && this.usesStateStore(o.stateStore)) {
        try {
          const history = execute ? o.runKernel.inspectProductionImageAttempt!(p, projectId, batchId, jobId, ExecuteRunJobRequestSchema.parse(input))
            : o.runKernel.inspectProductionImageStart(p, projectId, batchId, jobId, ExecuteRunJobRequestSchema.parse(input));
          if (history.execution.mode === this.mode && history.intent) return { start: { aggregate: history.aggregate, intent: history.intent,
            started: false, executionAuthorized: false as const, realExecutionEnabled: false as const } };
        } catch { /* Failure remains closed; no refresh/retry or private exception. */ }
      }
      if (error instanceof RunKernelError) throw new RunKernelError([403, 409, 413, 422, 429, 503].includes(error.status) ? error.status : 503,
        publicCodes.has(error.code) ? error.code : "production_image_reconstruction_rejected", execute
          ? "生产任务未完成核验；已有尝试不证明接受或零费用，保持原预留" : "生产负载重建未通过核验，未启动或发送请求");
      reject("production_image_reconstruction_unavailable", 503);
    } finally {
      for (const image of images) image.body.fill(0);
      body?.fill(0);
      if (occupied) { if (resource.pending) void resource.pending.then(() => { activeRebuilds--; }, () => { activeRebuilds--; }); else activeRebuilds--; }
    }
  }

  private async continueFixture(p: RunPrincipal, project: string, batch: string, job: string, leaseInput: { workerId: string; leaseId: string },
    e: ConfirmedProductionImageExecution, l: ProductionImageLeaseEvidence, i: ProductionImageDispatchIntent,
    wire: Awaited<ReturnType<typeof prepareProductionImageProtocol>>["wire"], signal: AbortSignal, resource: { pending?: Promise<unknown> }) {
    const o = this.options!;
    let latest = Date.parse(i.recordedAt);
    const at = () => { const now = o.clock?.() ?? Date.now();
      if (!Number.isSafeInteger(now) || now < latest) reject("production_image_reconstruction_clock_invalid");
      latest = now; return new Date(now).toISOString(); };
    const { body: _body, ...metadata } = wire, metadataFingerprint = imageSnapshotFingerprint(metadata);
    const a: ProductionImageAttempt = { schemaVersion: 1, mode: e.mode, state: "attempted", id: `production-image-attempt:${randomUUID()}`,
      tenantId: p.tenantId, projectId: project, jobId: job, batchId: e.batchId, actorId: p.actorId, workerId: l.workerId, leaseId: l.leaseId,
      transport: "contract-fixture", intentFingerprint: imageSnapshotFingerprint(i), executionFingerprint: imageSnapshotFingerprint(e), leaseFingerprint: imageSnapshotFingerprint(l),
      requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256, attemptedAt: at() };
    const hash = imageSnapshotFingerprint(a), identity = `${p.tenantId}\u0000${p.actorId}`;
    this.attempts.set(hash, identity);
    this.attemptSignals.set(hash, signal);
    let raw: Buffer | undefined, open = true, invoked = false, abortListener: (() => void) | undefined;
    const commit = (r: ProductionImageResult, bytes?: Buffer) => {
      const fingerprint = imageSnapshotFingerprint(r); this.results.set(fingerprint, identity);
      try { return o.runKernel.recordProductionImageResult!(p, project, batch, job, leaseInput, r, bytes); }
      finally { this.results.delete(fingerprint); }
    };
    const interrupted = (failureCode: Parameters<typeof productionImageUnknownOutcome>[1]) => commit({ schemaVersion: 1, mode: e.mode, kind: "interrupted",
      attemptId: a.id, attemptFingerprint: hash, intentFingerprint: a.intentFingerprint, executionFingerprint: a.executionFingerprint, interruptedAt: at(), outcome: productionImageUnknownOutcome(e, failureCode) });
    try {
      // Write-ahead record and final SQL policy check complete BEFORE callback.
      if (signal.aborted) reject("production_image_reconstruction_cancelled");
      o.runKernel.beginProductionImageAttempt!(p, project, batch, job, leaseInput, a);
      const assertCurrent = () => {
        if (!open || signal.aborted) reject("production_image_reconstruction_cancelled");
        at();
        const { body: _currentBody, ...currentMetadata } = wire;
        if (imageSnapshotFingerprint(currentMetadata) !== metadataFingerprint) reject("production_image_reconstruction_payload_changed");
        if (wire.body.byteLength !== e.protocol.payloadByteSize || createHash("sha256").update(wire.body).digest("hex") !== e.protocol.payloadChecksumSha256) reject("production_image_reconstruction_payload_changed");
        o.runKernel.assertProductionImageAttemptCurrent!(p, project, batch, job, leaseInput);
      };
      let response: ImageProtocolResponse;
      try {
        assertCurrent(); invoked = true;
        // This trusted callback is NOT a sandbox/network implementation. No
        // credentials are provided. A pending uncooperative callback keeps its slot.
        const operation = Promise.resolve().then(() => { assertCurrent(); return o.fixtureTransport!.send({ wire, signal, assertCurrent }); });
        resource.pending = operation.then(() => undefined, () => undefined);
        void resource.pending.then(() => { resource.pending = undefined; });
        const cancelled = new Promise<never>((_resolve, rejectAbort) => { abortListener = () => rejectAbort(new Error("cancelled"));
          signal.addEventListener("abort", abortListener, { once: true }); if (signal.aborted) abortListener(); });
        response = await Promise.race([operation, cancelled]);
        if (signal.aborted) return interrupted("production-timeout");
      } catch { return interrupted(signal.aborted ? "production-timeout" : "production-transport-error"); }
      open = false;
      let parsed: ReturnType<typeof parseProductionImageResponse>;
      try {
        if (!response || !Buffer.isBuffer(response.body) || response.body.byteLength > MAX_IMAGE_PROTOCOL_RESPONSE_BYTES) throw new Error("invalid");
        raw = Buffer.from(response.body);
        parsed = parseProductionImageResponse(e, l, i, a, { ...response, body: raw }, at());
      } catch { return interrupted("production-response-invalid"); }
      try { return commit(parsed.record, raw); }
      catch { return interrupted("production-response-save-failed"); }
      finally { parsed.candidate?.body.fill(0); }
    } catch (error) {
      // An attempted record is never removed or retried; revocation/storage
      // failure may prevent even interruption persistence. Explicit reconcile
      // still conservatively retains the original max reservation.
      if (invoked) throw new RunKernelError(503, "production_image_response_unavailable", "生产响应未完成保存，保持未知预留且不重发");
      throw error;
    } finally {
      open = false; this.attempts.delete(hash); this.attemptSignals.delete(hash); raw?.fill(0);
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
  }
}
export class ProductionImageTaskReconstruction extends ReconstructionCore {
  constructor(options?: Options) { super("production", options); }
}
export class ImageProductionReconstructionHarness extends ReconstructionCore {
  constructor(options?: Options) { super("production-contract-fixture", options); }
}
