import { createHash, randomUUID } from "node:crypto";
import { LockedProductionImageArtifactSchema, LockedProductionImageOutputDraftSchema, VerifiedImageSchema,
  type LockedProductionImageArtifact, type ExecuteRunJobRequest } from "@canvas/contracts";
import { RunKernelError, type RunPrincipal, type RunAuthorizer } from "./runKernel";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { lockedExpected, prepareLockedProductionImageProtocol } from "./lockedProductionImageProtocol";
import { assertLockedImageRawResponse } from "./lockedProductionImageResponse";
import { decodeStaticImage } from "./staticImageDecoder";
import { verifyLockedImagePixels } from "./lockedImagePixelValidation";
import { assetMetadataFingerprint } from "./assetMetadata";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";

type Options = { lockedArtifactEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel;
  lockedArtifactPolicy(c: { principal: RunPrincipal; projectId: string; mode: LockedProductionImageArtifact["mode"] }): boolean;
  runAuthorizer: RunAuthorizer; providerAuthorizer: ImageProviderAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
  clock?: () => number; timeoutMs?: number; maxMetadataBytes?: number; maxProjectBytes?: number };
let activeIngestions = 0;
function reject(code: string, status = 409): never { throw new RunKernelError(status, code, "保护产物未提交，原包与未知费用预留保留"); }
function strict(v: unknown) {
  if (v && (typeof v === "object" || typeof v === "function") && "then" in v) void Promise.resolve(v).catch(() => undefined);
  if (v !== true) reject("locked_artifact_permission_denied", 403);
}
class LockedArtifactCore {
  private readonly options?: Options;
  private readonly pending = new Map<string, { actor: string; guard(): number }>();
  constructor(private readonly mode: LockedProductionImageArtifact["mode"], options?: Options) {
    // Capture port/function identities rather than keeping mutable caller config.
    if (options) this.options = { ...options, runAuthorizer: { ...options.runAuthorizer, allows: options.runAuthorizer.allows.bind(options.runAuthorizer) },
      providerAuthorizer: { ...options.providerAuthorizer, allows: options.providerAuthorizer.allows.bind(options.providerAuthorizer) },
      assetAuthorizer: { ...options.assetAuthorizer, allows: options.assetAuthorizer.allows.bind(options.assetAuthorizer) } };
  }
  readonly usesStateStore = (store: unknown) => !!this.options && store === this.options.stateStore;
  readonly authorizeScope = (principal: RunPrincipal, project: string): boolean => {
    const o = this.options;
    if (!o || o.lockedArtifactEnabled !== true || typeof o.lockedArtifactPolicy !== "function" || !o.stateStore.supportsProductionImageArtifacts()
      || !o.stateStore.supportsProductionImageResponses()) reject("locked_artifact_not_configured", 503);
    if (!o.tenantId || o.tenantId !== o.tenantId.trim() || o.tenantId.length > 160 || o.tenantId !== principal.tenantId) reject("locked_artifact_permission_denied", 403);
    const p = structuredClone(principal);
    try {
      strict(o.runKernel.usesStateStore(o.stateStore)); strict(o.lockedArtifactPolicy({ principal: structuredClone(p), projectId: project, mode: this.mode }));
      strict(o.runAuthorizer.allows(structuredClone(p), project, "run:read")); strict(o.runAuthorizer.allows(structuredClone(p), project, "run:execute"));
      strict(o.providerAuthorizer.allows(structuredClone(p), project, "provider:read"));
      strict(o.assetAuthorizer.allows(structuredClone(p), project, "asset:read")); strict(o.assetAuthorizer.allows(structuredClone(p), project, "asset:write")); return true;
    } catch (e) { if (e instanceof RunKernelError) throw e; reject("locked_artifact_policy_unavailable", 503); }
  };
  readonly validateCommit = (p: RunPrincipal, r: LockedProductionImageArtifact): boolean => {
    this.authorizeScope(p, r.projectId); const live = this.pending.get(fp(r));
    return r.mode === this.mode && !!live && live.actor === `${p.tenantId}\0${p.actorId}` && Date.parse(r.committedAt) <= live.guard();
  };
  async ingest(principal: RunPrincipal, project: string, batch: string, job: string, lease: ExecuteRunJobRequest, signal?: AbortSignal) {
    const p = structuredClone(principal), identity = structuredClone(lease); this.authorizeScope(p, project); const o = this.options!;
    const principalFingerprint = fp(p), identityFingerprint = fp(identity);
    const timeout = o.timeoutMs ?? 5000, metadata = o.maxMetadataBytes ?? 16 * 1024 * 1024, binary = o.maxProjectBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000 || !Number.isSafeInteger(metadata) || metadata < 0 || metadata > 16 * 1024 * 1024
      || !Number.isSafeInteger(binary) || binary < 0 || binary > 512 * 1024 * 1024) reject("locked_artifact_configuration_invalid");
    const configGuard = o.runKernel.captureLockedArtifactConfiguration(p, project);
    if (activeIngestions >= 2) reject("locked_artifact_busy", 429); activeIngestions++;
    const controller = new AbortController(), clock = o.clock ?? Date.now, wallStart = performance.now(); let start: number, latest: number;
    try { start = latest = clock(); } catch { activeIngestions--; reject("locked_artifact_clock_invalid"); }
    const cancel = () => controller.abort(); signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    const timeGuard = () => {
      if (fp(p) !== principalFingerprint || fp(identity) !== identityFingerprint) reject("locked_artifact_identity_changed");
      configGuard(); const now = clock();
      if (controller.signal.aborted) reject("locked_artifact_cancelled", 499);
      if (!Number.isSafeInteger(start) || start < 0 || start > 8_640_000_000_000_000 - 30000 || !Number.isSafeInteger(now) || now < latest || now - start >= timeout
        || performance.now() - wallStart >= timeout) reject("locked_artifact_clock_invalid");
      latest = now; return now;
    };
    const guard = () => { configGuard(); this.authorizeScope(p, project); return timeGuard(); };
    const inspect = () => {
      guard(); const c = o.runKernel.inspectLockedProductionImageArtifact(p, project, batch, job, identity), now = guard();
      if (c.execution.mode !== this.mode) reject("locked_artifact_mode_mismatch");
      if (c.result?.kind !== "returned" || now < Date.parse(c.artifact?.committedAt ?? c.result.receivedAt)) reject("locked_artifact_clock_invalid"); return c;
    };
    const work = (async () => {
      let raw: Buffer | undefined, output: Buffer | undefined, wire: Buffer | undefined;
      const originals: { receipt: import("@canvas/contracts").VerifiedImage; body: Buffer }[] = [];
      let registeredAssets: { source: import("@canvas/contracts").Asset; mask: import("@canvas/contracts").Asset } | undefined;
      try {
        const initial = o.stateStore.transaction(() => {
          const c = inspect(); if (c.artifact) return c;
          const policy = c.execution.preparation.protectionPolicy, catalog = o.stateStore.loadCatalog()!.projects.find(v => v.projectId === project)!;
          registeredAssets = structuredClone({ source: catalog.assets.find(a => a.id === policy.source.asset.id)!, mask: catalog.assets.find(a => a.id === policy.mask.asset.id)! });
          const refs = [...c.execution.protocol.request.inputs, c.execution.protocol.request.mask!];
          if (refs.some(r => r.byteSize > 30 * 1024 * 1024) || refs.reduce((n, r) => n + r.byteSize, 0) > 64 * 1024 * 1024) reject("locked_artifact_inputs_too_large", 413);
          for (const ref of refs) { inspect(); const image = o.stateStore.loadVerifiedImageBytes(p.tenantId, project, ref.assetId);
            if (!image) reject("locked_artifact_input_missing"); originals.push(image); inspect(); }
          const response = o.stateStore.loadLockedProductionImageResponse(p.tenantId, project, this.mode, job); raw = response?.body;
          if (!response || fp(response.record) !== fp(c.result)) reject("locked_artifact_response_changed"); inspect(); return c;
        });
        if (initial.artifact) return initial.artifact; // Strict history: no decode, rebuild, pricing or send.
        const e = initial.execution, policy = e.preparation.protectionPolicy;
        const prepared = await prepareLockedProductionImageProtocol(e.preparation, lockedExpected(e.preparation),
          { jobId: e.protocol.request.jobId, idempotencyKey: e.protocol.request.idempotencyKey }, originals, e.confirmedAt);
        wire = prepared.wire.body; inspect();
        if (fp(prepared.snapshot.request) !== fp(e.protocol.request) || prepared.snapshot.requestFingerprint !== e.protocol.requestFingerprint
          || prepared.snapshot.payloadChecksumSha256 !== e.protocol.payloadChecksumSha256 || wire.length !== e.protocol.payloadByteSize
          || prepared.snapshot.contentType !== e.protocol.contentType || fp(prepared.snapshot.transformedInputs) !== fp(e.protocol.transformedInputs)
          || createHash("sha256").update(wire).digest("hex") !== e.protocol.payloadChecksumSha256) reject("locked_artifact_payload_changed");
        wire.fill(0); wire = undefined;
        const parsed = assertLockedImageRawResponse(initial.result, e, initial.lease, initial.intent, initial.attempt, raw!);
        output = parsed.candidate?.body; raw!.fill(0); raw = undefined;
        if (!output || !parsed.candidate || parsed.record.outcome.artifactStatus !== "pending-validation" || parsed.record.outcome.failureCode) reject("locked_artifact_candidate_missing");
        const mime = parsed.candidate.mimeType, decoded = await decodeStaticImage(output, mime); inspect();
        if (mime !== `image/${e.preparation.constraint.outputSpec.format}` || decoded.width !== policy.outputSpec.width || decoded.height !== policy.outputSpec.height
          || (e.protocol.request.parameters.background === "transparent" && !decoded.hasTransparency) || (e.protocol.request.parameters.background === "opaque" && decoded.hasTransparency)) reject("locked_artifact_output_invalid", 422);
        const source = originals.find(i => i.receipt.asset.id === policy.source.asset.id)!, mask = originals.find(i => i.receipt.asset.id === policy.mask.asset.id)!;
        // Unlike none-only ingestion, retain actual source/mask originals until the complete comparison finishes.
        const proof = await verifyLockedImagePixels({ protection: "pixel-exact", source: source.receipt, mask: mask.receipt, registeredAssets,
          constraint: e.preparation.constraint, constraintChecksumSha256: e.protocol.request.constraintChecksumSha256,
          sourceBody: source.body, maskBody: mask.body, candidate: { body: output, mimeType: mime, checksumSha256: parsed.candidate.checksumSha256 } },
          { signal: controller.signal, clock, timeoutMs: timeout }); inspect();
        for (const image of originals) image.body.fill(0);
        return o.stateStore.transaction(() => {
          const current = inspect(); if (current.artifact) return current.artifact;
          if (fp(current.execution) !== fp(e) || fp(current.result) !== fp(initial.result) || fp(current.attempt) !== fp(initial.attempt)) reject("locked_artifact_context_changed");
          const at = new Date(guard()).toISOString(), q = e.protocol.request.quote;
          const draft = LockedProductionImageOutputDraftSchema.parse({ schemaVersion: 2, mode: this.mode, validation: "decoded-uncommitted", artifactCommitted: false,
            executionAuthorized: false, realExecutionEnabled: false, protectionApplied: "checked-not-applied", jobId: job, batchId: batch,
            executionFingerprint: fp(e), leaseFingerprint: fp(current.lease), intentFingerprint: fp(current.intent), attemptFingerprint: fp(current.attempt),
            responseFingerprint: fp(current.result), requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256,
            transformedInputsFingerprint: fp(e.protocol.transformedInputs), constraintChecksumSha256: e.protocol.request.constraintChecksumSha256,
            decoder: "sharp-full-decode-v1", protectionPolicyFingerprint: fp(policy), pixelProof: proof,
            image: { mimeType: mime, byteSize: output!.length, checksumSha256: proof.candidateChecksumSha256, ...decoded },
            money: { currency: q.currency, maxCostMinor: q.maxCostMinor, estimate: q.source === "manual-budget" ? { state: "unknown" } : { state: "known", estimatedCostMinor: q.estimatedCostMinor }, billing: "unknown" }, validatedAt: at });
          const id = `locked-production-generated-${randomUUID()}`, storage = createHash("sha256").update(JSON.stringify([p.tenantId, project, id])).digest("hex");
          const asset = { id, projectId: project, kind: "image" as const, purpose: "generated" as const, sourceAssetId: policy.source.asset.id,
            originalName: `${id}.${e.protocol.request.parameters.outputFormat}`, storageKey: `local-verified:${storage}`, mimeType: mime, byteSize: output!.length,
            width: decoded.width, height: decoded.height, contentFingerprint: `sha256:${proof.candidateChecksumSha256}`, createdAt: at };
          const image = VerifiedImageSchema.parse({ schemaVersion: 1, id: `locked-production-verification-${randomUUID()}`, tenantId: p.tenantId,
            asset, checksumSha256: proof.candidateChecksumSha256, registeredMetadataSha256: assetMetadataFingerprint(asset), decoder: draft.decoder, verifiedBy: p.actorId, verifiedAt: at });
          const record = LockedProductionImageArtifactSchema.parse({ schemaVersion: 2, mode: this.mode, validation: "verified", executionAuthorized: false, realExecutionEnabled: false,
            tenantId: p.tenantId, projectId: project, jobId: job, batchId: batch, draft, draftFingerprint: fp(draft), request: e.protocol.request,
            constraint: e.preparation.constraint, transformedInputs: e.protocol.transformedInputs, protectionPolicy: policy, image, committedBy: p.actorId, committedAt: at });
          const catalog = o.stateStore.loadCatalog()!, target = catalog.projects.find(p => p.projectId === project)!;
          if (target.assets.length >= 10000) reject("locked_artifact_catalog_full", 413);
          const snapshotHash = fp(o.stateStore.load()), catalogHash = fp(catalog), hash = fp(record);
          this.pending.set(hash, { actor: `${p.tenantId}\0${p.actorId}`, guard });
          const checkWriting = (expectedCatalog: string, imageSaved = true) => {
            guard(); o.runKernel.assertLockedProductionImageArtifactWrite(p, record); guard();
            if (imageSaved) {
              const saved = o.stateStore.loadVerifiedImageBytes(p.tenantId, project, image.asset.id);
              try { if (!saved || fp(saved.receipt) !== fp(image) || saved.body.length !== output!.length
                || createHash("sha256").update(saved.body).digest("hex") !== image.checksumSha256) reject("locked_artifact_write_drift"); }
              finally { saved?.body.fill(0); } guard();
            }
            if (fp(o.stateStore.load()) !== snapshotHash || fp(o.stateStore.loadCatalog()) !== expectedCatalog) reject("locked_artifact_write_drift");
          };
          try {
            checkWriting(catalogHash, false);
            o.stateStore.saveLockedProductionImageArtifact(record, output!, { maxMetadataBytes: metadata, maxProjectBytes: binary }, () => checkWriting(catalogHash));
            checkWriting(catalogHash); target.assets.push(image.asset); o.stateStore.saveCatalog(catalog); checkWriting(fp(catalog));
            o.runKernel.attachLockedProductionImageArtifact(p, project, batch, job, identity, record);
            const committedSnapshot = fp(o.stateStore.load());
            const final = inspect();
            if (fp(final.artifact) !== hash || fp(final.execution) !== fp(e) || fp(final.result) !== fp(current.result)
              || fp(o.stateStore.loadCatalog()) !== fp(catalog)) reject("locked_artifact_write_drift");
            if (o.stateStore.imageMetadataBytes(p.tenantId, project) + imageTaskMetadataBytes(o.stateStore.load(), p.tenantId, project) > metadata
              || o.stateStore.localImageBinaryBytes(p.tenantId, project) > binary) reject("locked_artifact_shared_quota", 413);
            guard(); const last = o.runKernel.finishLockedProductionImageArtifactReadback(p, record); configGuard();
            if (last.snapshotFingerprint !== committedSnapshot || last.catalogFingerprint !== fp(catalog)) reject("locked_artifact_write_drift");
            timeGuard(); // Final pure read may consume the deadline or observe cancellation.
            return record;
          } finally { this.pending.delete(hash); }
        });
      } catch (e) { if (e instanceof RunKernelError) throw e; reject("locked_artifact_unavailable", 503); }
      finally { raw?.fill(0); output?.fill(0); wire?.fill(0); for (const image of originals) image.body.fill(0); activeIngestions--; }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<never>((_, fail) => { const abort = () => fail(new RunKernelError(499, "locked_artifact_cancelled", "保护产物取消，原预留保留"));
      controller.signal.addEventListener("abort", abort, { once: true }); if (controller.signal.aborted) abort(); timer = setTimeout(cancel, Math.max(1, timeout - (performance.now() - wallStart))); });
    try { return await Promise.race([work, aborted]); }
    finally { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }
}
export class LockedProductionImageTaskArtifacts extends LockedArtifactCore { constructor(options?: Options) { super("production", options); } }
export class LockedImageProductionArtifactHarness extends LockedArtifactCore { constructor(options?: Options) { super("production-contract-fixture", options); } }
