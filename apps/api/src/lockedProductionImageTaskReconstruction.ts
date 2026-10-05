import { createHash, randomUUID } from "node:crypto";
import { ExecuteRunJobRequestSchema, type ConfirmedLockedProductionImageExecution, type LockedProductionImageDispatchIntent, type LockedProductionImageLeaseEvidence } from "@canvas/contracts";
import type { LockedProductionImageAttempt, LockedProductionImageResult } from "@canvas/contracts";
import { assertLockedImageAttempt, assertLockedImageResult, parseLockedImageResponse, lockedImageUnknownOutcome } from "./lockedProductionImageResponse";
import type { ImageProtocolResponse } from "./imageProtocolResponse";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { lockedExpected, prepareLockedProductionImageProtocol } from "./lockedProductionImageProtocol";
import { assertLockedDispatchIntent } from "./lockedProductionImageDispatchIntentIntegrity";
import type { LockedProductionImageLeasePolicy } from "./lockedProductionImageLeasePolicy";
import type { TrustedImageBytes } from "./imageRequestPayload";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import { RunKernelError, type LockedProductionImageStartPolicy, type LockedProductionImageResponsePolicy, type RunPrincipal } from "./runKernel";

type Options = { lockedReconstructionEnabled: true; lockedStartEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore;
  runKernel: Pick<SqliteRunKernel, "usesStateStore" | "inspectLockedProductionImageLease" | "inspectLockedProductionImageStart" | "startLockedProductionImageJob"> & Partial<Pick<SqliteRunKernel, "inspectLockedImageAttempt" | "beginLockedImageAttempt" | "assertLockedImageAttemptCurrent" | "recordLockedImageResult">>;
  leasePolicy: LockedProductionImageLeasePolicy; lockedStartPolicy(scope: { principal: RunPrincipal; projectId: string }): boolean;
  lockedResponseEnabled?: true; lockedResponsePolicy?(scope: { principal: RunPrincipal; projectId: string }): boolean;
  fixtureTransport?: { mode: "contract-fixture"; realExecutionEnabled: false; send(context: { wire: Awaited<ReturnType<typeof prepareLockedProductionImageProtocol>>["wire"]; signal: AbortSignal; assertCurrent(): void }): Promise<ImageProtocolResponse> };
  clock?: () => number; timeoutMs?: number };
let active = 0;
function reject(code: string, status = 409): never { throw new RunKernelError(status, code, "保护启动未完成；保留原编号和预留核对，不授权发送"); }
function synchronousTrue(v: unknown) { if (v && (typeof v === "object" || typeof v === "function") && "then" in v) void Promise.resolve(v).catch(() => undefined); return v === true; }
function strict(f: () => unknown) { if (!synchronousTrue(f())) reject("locked_start_permission_denied", 403); }
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const publicCodes = new Set(["locked_start_not_configured", "locked_start_permission_denied", "locked_start_clock_invalid", "locked_start_configuration_changed",
  "locked_start_task_changed", "locked_start_input_missing", "locked_start_inputs_too_large", "locked_start_payload_changed", "locked_start_cancelled",
  "locked_start_expired", "locked_start_busy", "locked_start_mode_mismatch", "locked_start_identity_mismatch", "locked_start_live_proof_missing"]);

class Core implements LockedProductionImageStartPolicy {
  private readonly options?: Options;
  private readonly pending = new Map<string, { identity: string; execution: string; lease: string; check(): void }>();
  private readonly attempts = new Map<string, { identity: string; execution: string; lease: string; intent: string; check(): void }>();
  private readonly results = new Map<string, { identity: string; execution: string; lease: string; intent: string; attempt: string; check(): void }>();
  readonly responsePolicy: LockedProductionImageResponsePolicy = { usesStateStore: s => this.usesStateStore(s), authorizeScope: (p, project) => this.authorizeResponseScope(p, project),
    validateAttempt: (p,e,l,i,a) => this.validateAttempt(p,e,l,i,a), validateResult: (p,e,l,i,a,r) => this.validateResult(p,e,l,i,a,r) };
  constructor(private readonly mode: ConfirmedLockedProductionImageExecution["mode"], options?: Options) {
    this.options = options && { ...options, fixtureTransport: options.fixtureTransport && { ...options.fixtureTransport, send: options.fixtureTransport.send.bind(options.fixtureTransport) }, leasePolicy: { timeoutMs: options.leasePolicy?.timeoutMs,
      usesStateStore: options.leasePolicy?.usesStateStore.bind(options.leasePolicy), authorizeScope: options.leasePolicy?.authorizeScope.bind(options.leasePolicy),
      validate: options.leasePolicy?.validate.bind(options.leasePolicy) } };
  }
  usesStateStore(store: unknown) { const o = this.options; return !!o && o.lockedReconstructionEnabled === true && o.lockedStartEnabled === true && o.stateStore === store
    && synchronousTrue(o.runKernel.usesStateStore(o.stateStore)) && synchronousTrue(o.leasePolicy.usesStateStore(o.stateStore)); }
  authorizeScope(p: RunPrincipal, projectId: string) {
    const o = this.options;
    if (!o || o.lockedReconstructionEnabled !== true || o.lockedStartEnabled !== true || !o.tenantId || p.tenantId !== o.tenantId
      || !p.actorId || !projectId || typeof o.lockedStartPolicy !== "function") reject("locked_start_not_configured", 503);
    strict(() => this.usesStateStore(o.stateStore));
    strict(() => o.lockedStartPolicy(structuredClone({ principal: p, projectId })));
    strict(() => o.leasePolicy.authorizeScope(structuredClone(p), projectId, "start-history")); return true;
  }
  validateStart(p: RunPrincipal, e: ConfirmedLockedProductionImageExecution, l: LockedProductionImageLeaseEvidence, i: LockedProductionImageDispatchIntent) {
    this.authorizeScope(p, e.preparation.projectId);
    const live = this.pending.get(fp(i));
    if (!live || live.identity !== fp(p) || live.execution !== fp(e) || live.lease !== fp(l) || e.mode !== this.mode) reject("locked_start_live_proof_missing");
    assertLockedDispatchIntent(i, fp(i), e, l); live.check(); return true;
  }
  authorizeResponseScope(p: RunPrincipal, project: string) {
    const o = this.options;
    if (!o || o.lockedResponseEnabled !== true || typeof o.lockedResponsePolicy !== "function" || !o.runKernel.inspectLockedImageAttempt || !o.runKernel.beginLockedImageAttempt
      || !o.runKernel.assertLockedImageAttemptCurrent || !o.runKernel.recordLockedImageResult) reject("locked_response_not_configured", 503);
    this.authorizeScope(p, project); strict(() => o.lockedResponsePolicy!(structuredClone({ principal: p, projectId: project }))); return true;
  }
  validateAttempt(p: RunPrincipal, e: ConfirmedLockedProductionImageExecution, l: LockedProductionImageLeaseEvidence, i: LockedProductionImageDispatchIntent, a: LockedProductionImageAttempt) {
    this.authorizeResponseScope(p, e.preparation.projectId); const live = this.attempts.get(fp(a));
    if (!live || live.identity !== fp(p) || live.execution !== fp(e) || live.lease !== fp(l) || live.intent !== fp(i) || e.mode !== this.mode) reject("locked_attempt_live_proof_missing");
    assertLockedImageAttempt(a, fp(a), e, l, i); live.check(); return true;
  }
  validateResult(p: RunPrincipal, e: ConfirmedLockedProductionImageExecution, l: LockedProductionImageLeaseEvidence, i: LockedProductionImageDispatchIntent, a: LockedProductionImageAttempt, r: LockedProductionImageResult) {
    this.authorizeResponseScope(p, e.preparation.projectId); const live = this.results.get(fp(r));
    if (!live || live.identity !== fp(p) || live.execution !== fp(e) || live.lease !== fp(l) || live.intent !== fp(i) || live.attempt !== fp(a) || e.mode !== this.mode) reject("locked_result_live_proof_missing");
    assertLockedImageAttempt(a, fp(a), e, l, i); assertLockedImageResult(r, fp(r), e, a); live.check(); return true;
  }
  async start(principal: RunPrincipal, projectId: string, batchId: string, jobId: string, input: unknown, options: { signal?: AbortSignal } = {}) {
    return this.run(principal, projectId, batchId, jobId, input, options, false);
  }
  async executeFixture(principal: RunPrincipal, projectId: string, batchId: string, jobId: string, input: unknown, options: { signal?: AbortSignal } = {}) {
    this.authorizeResponseScope(principal, projectId); const o = this.options!;
    if (this.mode !== "production-contract-fixture" || o.fixtureTransport?.mode !== "contract-fixture" || o.fixtureTransport.realExecutionEnabled !== false) reject("locked_fixture_transport_rejected", 503);
    return this.run(principal, projectId, batchId, jobId, input, options, true);
  }
  private async run(principal: RunPrincipal, projectId: string, batchId: string, jobId: string, input: unknown, options: { signal?: AbortSignal }, execute: boolean) {
    const p = structuredClone(principal), o = this.options!, controller = new AbortController(), signal = controller.signal;
    const userAbort = () => controller.abort(); if (options.signal?.aborted) controller.abort();
    this.authorizeScope(p, projectId); const leaseInput = ExecuteRunJobRequestSchema.parse(input);
    const kernel = o.runKernel, funcs = () => [kernel.usesStateStore, kernel.inspectLockedProductionImageLease, kernel.inspectLockedProductionImageStart, kernel.startLockedProductionImageJob,
      kernel.inspectLockedImageAttempt, kernel.beginLockedImageAttempt, kernel.assertLockedImageAttemptCurrent, kernel.recordLockedImageResult], captured = funcs();
    const fixed = () => { if (captured.some((f, n) => f !== funcs()[n])) reject("locked_start_configuration_changed"); };
    const timeout = o.timeoutMs ?? 5000; let last = o.clock?.() ?? Date.now(), closed = false;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000 || !Number.isSafeInteger(last) || last < 0 || last > 8_640_000_000_000_000 - 30000) reject("locked_start_clock_invalid");
    const deadline = last + timeout;
    const clock = () => { fixed(); if (closed || signal?.aborted) reject("locked_start_cancelled", 408); const t = o.clock?.() ?? Date.now();
      if (!Number.isSafeInteger(t) || t < last || t >= deadline) reject("locked_start_expired", 408); last = t; this.authorizeScope(p, projectId); return new Date(t).toISOString(); };
    clock();
    const old = kernel.inspectLockedProductionImageStart(p, projectId, batchId, jobId, leaseInput);
    if (old.execution.mode !== this.mode) reject("locked_start_mode_mismatch");
    if (old.intent) { clock(); return { aggregate: old.aggregate, intent: old.intent, started: false, executionAuthorized: false as const, realExecutionEnabled: false as const }; }
    if (active >= 2) reject("locked_start_busy", 429); active++;
    options.signal?.addEventListener("abort", userAbort, { once: true }); if (options.signal?.aborted) controller.abort();
    const images: TrustedImageBytes[] = []; let body: Buffer | undefined, continued = false; const resource: { pending?: Promise<unknown> } = {};
    const work = (async () => { try {
      const initial = kernel.inspectLockedProductionImageLease(p, projectId, batchId, jobId, leaseInput), e = initial.execution, l = initial.lease;
      const executionFingerprint = fp(e), leaseFingerprint = fp(l);
      const guard = () => { const time = clock(), current = kernel.inspectLockedProductionImageLease(p, projectId, batchId, jobId, leaseInput);
        if (fp(current.execution) !== executionFingerprint || fp(current.lease) !== leaseFingerprint) reject("locked_start_task_changed"); return time; };
      const r = e.protocol.request, refs = [...r.inputs, r.mask!];
      if (refs.reduce((n, r) => n + r.byteSize, 0) > 64 * 1024 * 1024) reject("locked_start_inputs_too_large", 413);
      o.stateStore.transaction(() => { for (const r of refs) { guard(); const image = o.stateStore.loadVerifiedImageBytes(p.tenantId, projectId, r.assetId);
        if (!image) reject("locked_start_input_missing"); images.push(image); guard(); } });
      const reconstructedAt = guard();
      // Native normalization and wire construction occur OUTSIDE SQL locks.
      const prepared = await prepareLockedProductionImageProtocol(e.preparation, lockedExpected(e.preparation), { jobId: r.jobId, idempotencyKey: r.idempotencyKey }, images, reconstructedAt);
      body = prepared.wire.body; guard(); const s = prepared.snapshot, original = e.protocol;
      const unsignedIdentity = (s: typeof original) => { const { preparedAt: _at, snapshotFingerprint: _fp, ...identity } = s; return identity; };
      const { body: _bytes, ...wireMetadata } = prepared.wire, wireFingerprint = fp(wireMetadata);
      if (fp(unsignedIdentity(s)) !== fp(unsignedIdentity(original)) || prepared.wire.requestFingerprint !== original.requestFingerprint
        || prepared.wire.contentType !== original.contentType || prepared.wire.payloadChecksumSha256 !== original.payloadChecksumSha256
        || body.length !== original.payloadByteSize || sha(body) !== original.payloadChecksumSha256) reject("locked_start_payload_changed");
      const started = o.stateStore.transaction(() => {
        const recordedAt = guard();
        const intent: LockedProductionImageDispatchIntent = { schemaVersion: 2, mode: e.mode, transport: "not-connected", id: `locked-production-image-intent:${randomUUID()}`,
          jobId, batchId, actorId: p.actorId, workerId: l.workerId, leaseId: l.leaseId, executionFingerprint, leaseFingerprint,
          protectionPolicyFingerprint: fp(e.preparation.protectionPolicy), requestFingerprint: original.requestFingerprint,
          payloadChecksumSha256: original.payloadChecksumSha256, payloadByteSize: original.payloadByteSize, contentType: original.contentType,
          transformedInputsFingerprint: fp(original.transformedInputs), protocolVersion: original.protocolVersion, confirmedAt: e.confirmedAt, reconstructedAt, recordedAt };
        const fingerprint = fp(intent), check = () => { clock();
          const { body: _now, ...metadata } = prepared.wire;
          if (fp(metadata) !== wireFingerprint || !body || prepared.wire.body !== body || sha(body) !== original.payloadChecksumSha256 || body.length !== original.payloadByteSize) reject("locked_start_payload_changed");
          const actual = o.stateStore.load()?.batches.find(b => b.aggregate.batch.id === batchId);
          strict(() => o.leasePolicy.validate(p, e, actual?.lockedProductionImageDispatchIntent ? "start-commit" : "start", 0)); clock(); };
        this.pending.set(fingerprint, { identity: fp(p), execution: executionFingerprint, lease: leaseFingerprint, check });
        try { check(); const result = kernel.startLockedProductionImageJob(p, projectId, batchId, jobId, leaseInput, intent); check();
          return { ...result, executionAuthorized: false as const, realExecutionEnabled: false as const }; }
        finally { this.pending.delete(fingerprint); }
      });
      if (execute && started.started) { continued = true;
        const aggregate = await this.continueAttempt(p, projectId, batchId, jobId, leaseInput, e, l, started.intent, prepared.wire, signal, clock, fixed, resource);
        return { ...started, aggregate }; }
      return started;
    } catch (error) {
      // Concurrent first actions may lose to an already committed intent. Restore
      // ONLY that original identity; never refresh, normalize or resend.
      if (!continued && !closed && !signal?.aborted) { try { clock(); const history = kernel.inspectLockedProductionImageStart(p, projectId, batchId, jobId, leaseInput);
        if (history.execution.mode === this.mode && history.intent) return { aggregate: history.aggregate, intent: history.intent, started: false, executionAuthorized: false as const, realExecutionEnabled: false as const }; } catch { /* keep failure closed */ } }
      if (error instanceof RunKernelError) throw new RunKernelError([403,408,409,413,422,429,503].includes(error.status) ? error.status : 503, publicCodes.has(error.code) ? error.code : "locked_start_rejected", "保护启动未完成；保留原编号核对，不能推断未扣费");
      reject("locked_start_unavailable", 503);
    } finally { body?.fill(0); images.forEach(i => i.body.fill(0)); if (resource.pending) void resource.pending.then(() => active--, () => active--); else active--; } })();
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, fail) => { timer = setTimeout(() => { closed = true; controller.abort(); fail(new RunKernelError(408, "locked_start_expired", "保护重建期限耗尽，保留预留")); }, timeout);
      abort = () => { closed = true; fail(new RunKernelError(408, "locked_start_cancelled", "保护重建取消，保留预留")); };
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); });
    try { return await Promise.race([work, interrupted]); } finally { closed = true; controller.abort(); clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); options.signal?.removeEventListener("abort", userAbort); }
  }
  private async continueAttempt(p: RunPrincipal, project: string, batch: string, job: string, input: { workerId: string; leaseId: string },
    e: ConfirmedLockedProductionImageExecution, l: LockedProductionImageLeaseEvidence, i: LockedProductionImageDispatchIntent,
    wire: Awaited<ReturnType<typeof prepareLockedProductionImageProtocol>>["wire"], signal: AbortSignal, clock: () => string, fixed: () => void, resource: { pending?: Promise<unknown> }) {
    const o = this.options!, k = o.runKernel, at = clock(); let latest = Date.parse(at), open = true, raw: Buffer | undefined, abortListener: (() => void) | undefined;
    const a: LockedProductionImageAttempt = { schemaVersion: 2, mode: e.mode, state: "attempted", id: `locked-production-image-attempt:${randomUUID()}`, tenantId: p.tenantId,
      projectId: project, jobId: job, batchId: batch, actorId: p.actorId, workerId: l.workerId, leaseId: l.leaseId, transport: "contract-fixture",
      intentFingerprint: fp(i), executionFingerprint: fp(e), leaseFingerprint: fp(l), protectionPolicyFingerprint: fp(e.preparation.protectionPolicy),
      requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256, attemptedAt: at };
    const hash = fp(a), { body: bytes, ...meta } = wire, metadata = fp(meta);
    const current = () => { clock(); const { body: now, ...m } = wire;
      if (!open || signal.aborted || now !== bytes || fp(m) !== metadata || bytes.length !== e.protocol.payloadByteSize || sha(bytes) !== e.protocol.payloadChecksumSha256) reject("locked_start_payload_changed"); };
    this.attempts.set(hash, { identity: fp(p), execution: fp(e), lease: fp(l), intent: fp(i), check: current });
    const observe = (interrupted: boolean) => { fixed(); const t = o.clock?.() ?? Date.now();
      if (!Number.isSafeInteger(t) || t < latest || t > 8_640_000_000_000_000 - 30000) reject("locked_start_clock_invalid"); latest = t;
      if (!interrupted) clock(); this.authorizeResponseScope(p, project); return new Date(t).toISOString(); };
    const commit = (r: LockedProductionImageResult, body?: Buffer) => { const at = observe(r.kind === "interrupted"), deadline = Date.parse(at) + (o.timeoutMs ?? 5000), resultHash = fp(r);
      this.results.set(resultHash, { identity: fp(p), execution: fp(e), lease: fp(l), intent: fp(i), attempt: hash, check: () => {
        if (Date.parse(observe(r.kind === "interrupted")) >= deadline) reject("locked_start_expired", 408);
        strict(() => o.leasePolicy.validate(structuredClone(p), structuredClone(e), "start-history", 0));
        const actual = o.stateStore.load()?.batches.find(b => b.aggregate.batch.id === batch);
        if (fp(actual?.lockedProductionImageAttempt) !== hash || actual?.lockedProductionImageResult && fp(actual.lockedProductionImageResult) !== resultHash) reject("locked_start_task_changed");
        observe(r.kind === "interrupted"); } });
      try { return k.recordLockedImageResult!(p, project, batch, job, input, r, body); } finally { this.results.delete(resultHash); } };
    const interrupted = (code: Parameters<typeof lockedImageUnknownOutcome>[1]) => commit({ schemaVersion: 2, mode: e.mode, kind: "interrupted", attemptId: a.id,
      attemptFingerprint: hash, intentFingerprint: a.intentFingerprint, executionFingerprint: a.executionFingerprint, protectionPolicyFingerprint: a.protectionPolicyFingerprint,
      interruptedAt: observe(true), outcome: lockedImageUnknownOutcome(e, code) });
    try {
      current(); k.beginLockedImageAttempt!(p, project, batch, job, input, a);
      const assertCurrent = () => { current(); k.assertLockedImageAttemptCurrent!(p, project, batch, job, input); current(); };
      let response: ImageProtocolResponse;
      try { assertCurrent(); const operation = Promise.resolve().then(() => { assertCurrent(); return o.fixtureTransport!.send({ wire, signal, assertCurrent }); });
        resource.pending = operation.then(() => undefined, () => undefined); void resource.pending.then(() => { resource.pending = undefined; });
        const cancelled = new Promise<never>((_, fail) => { abortListener = () => fail(new Error("cancelled")); signal.addEventListener("abort", abortListener, { once: true }); if (signal.aborted) abortListener(); });
        response = await Promise.race([operation, cancelled]); if (signal.aborted) return interrupted("production-timeout");
      } catch { return interrupted(signal.aborted ? "production-timeout" : "production-transport-error"); }
      open = false; let parsed: ReturnType<typeof parseLockedImageResponse>;
      try { if (!response || !Buffer.isBuffer(response.body) || response.body.length > 32 * 1024 * 1024) throw new Error("invalid");
        raw = Buffer.from(response.body); parsed = parseLockedImageResponse(e, l, i, a, { ...response, body: raw }, observe(false)); }
      catch { return interrupted("production-response-invalid"); }
      try { return commit(parsed.record, raw); } catch { return interrupted("production-response-save-failed"); } finally { parsed.candidate?.body.fill(0); }
    } finally { open = false; this.attempts.delete(hash); raw?.fill(0); if (abortListener) signal.removeEventListener("abort", abortListener); }
  }
}
export class LockedProductionImageTaskReconstruction extends Core { constructor(options?: Options) { super("production", options); } }
export class LockedImageProductionReconstructionHarness extends Core { constructor(options?: Options) { super("production-contract-fixture", options); } }
