import { createHash, randomUUID } from "node:crypto";
import { ProductionImageArtifactSchema, VerifiedImageSchema, type ProductionImageArtifact, type ExecuteRunJobRequest } from "@canvas/contracts";
import { RunKernelError, type RunPrincipal, type RunAuthorizer } from "./runKernel";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { prepareProductionImageProtocol } from "./productionImageProtocol";
import { productionExpected } from "./productionImageConfirmationIntegrity";
import { validateProductionImageOutput } from "./productionImageOutputValidation";
import { assetMetadataFingerprint } from "./assetMetadata";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";

type Options = { artifactHandlingEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel;
  runAuthorizer: RunAuthorizer; providerAuthorizer: ImageProviderAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
  clock?: () => number; timeoutMs?: number; maxMetadataBytes?: number; maxProjectBytes?: number };
let activeIngestions = 0;
function reject(code: string, status = 409): never { throw new RunKernelError(status, code, "生产产物未提交，原响应与未知费用预留保留"); }
function strict(value: unknown) {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => undefined);
  if (value !== true) reject("production_image_artifact_permission_denied", 403);
}
class ArtifactCore {
  private readonly pending = new Map<string, { actor: string; guard(): number }>();
  constructor(private readonly mode: ProductionImageArtifact["mode"], private readonly options?: Options) {}
  readonly usesStateStore = (store: unknown) => !!this.options && store === this.options.stateStore;
  readonly authorizeScope = (p: RunPrincipal, project: string): boolean => {
    const o = this.options;
    if (!o || o.artifactHandlingEnabled !== true || !o.stateStore.supportsProductionImageArtifacts() || !o.stateStore.supportsProductionImageResponses()) reject("production_image_artifact_not_configured", 503);
    if (!o.tenantId.trim() || o.tenantId !== p.tenantId) reject("production_image_artifact_permission_denied", 403);
    try {
      strict(o.runKernel.usesStateStore(o.stateStore));
      strict(o.runAuthorizer.allows(p, project, "run:read")); strict(o.runAuthorizer.allows(p, project, "run:execute"));
      strict(o.providerAuthorizer.allows(p, project, "provider:read"));
      strict(o.assetAuthorizer.allows(p, project, "asset:read")); strict(o.assetAuthorizer.allows(p, project, "asset:write")); return true;
    } catch (error) { if (error instanceof RunKernelError) throw error; reject("production_image_artifact_policy_unavailable", 503); }
  };
  readonly validateCommit = (p: RunPrincipal, record: ProductionImageArtifact): boolean => {
    this.authorizeScope(p, record.projectId);
    const live = this.pending.get(fp(record));
    if (record.mode !== this.mode || !live || live.actor !== `${p.tenantId}\0${p.actorId}`) return false;
    return Date.parse(record.committedAt) <= live.guard();
  };
  async ingest(p: RunPrincipal, project: string, batch: string, job: string, lease: ExecuteRunJobRequest, signal?: AbortSignal) {
    this.authorizeScope(p, project); const o = this.options!;
    const timeout = o.timeoutMs ?? 5_000, metadata = o.maxMetadataBytes ?? 16 * 1024 * 1024, binary = o.maxProjectBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000 || !Number.isSafeInteger(metadata) || metadata < 0 || metadata > 16 * 1024 * 1024
      || !Number.isSafeInteger(binary) || binary < 0 || binary > 512 * 1024 * 1024) reject("production_image_artifact_configuration_invalid");
    if (activeIngestions >= 2) reject("production_image_artifact_busy", 429);
    activeIngestions++;
    const actor = { ...p }, identity = { ...lease }, controller = new AbortController(), start = (o.clock ?? Date.now)();
    let latest = start;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => controller.abort(); signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    const guard = () => {
      this.authorizeScope(actor, project);
      const now = (o.clock ?? Date.now)();
      if (controller.signal.aborted) reject("production_image_artifact_cancelled", 499);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(now) || now < latest || now - start >= timeout) reject("production_image_artifact_clock_invalid");
      latest = now; return now;
    };
    const inspect = () => {
      guard(); const c = o.runKernel.inspectProductionImageArtifact(actor, project, batch, job, identity), now = guard();
      if (c.execution.mode !== this.mode) reject("production_image_artifact_mode_mismatch");
      if (c.result?.kind !== "returned" || now < Date.parse(c.artifact?.committedAt ?? c.result.receivedAt)) reject("production_image_artifact_clock_invalid"); return c;
    };
    const work = (async () => {
      let raw: Buffer | undefined, output: Buffer | undefined, wire: Buffer | undefined;
      const originals: { receipt: import("@canvas/contracts").VerifiedImage; body: Buffer }[] = [];
      try {
        const initial = o.stateStore.transaction(() => {
          const c = inspect();
          if (c.artifact) return c;
          const e = c.execution, refs = e.protocol.request.operation === "edit" ? [...e.protocol.request.inputs, ...(e.protocol.request.mask ? [e.protocol.request.mask] : [])] : [];
          if (refs.reduce((n, ref) => n + ref.byteSize, 0) > 64 * 1024 * 1024) reject("production_image_inputs_too_large", 413);
          for (const ref of refs) {
            inspect(); const image = o.stateStore.loadVerifiedImageBytes(actor.tenantId, project, ref.assetId);
            if (!image) reject("production_image_artifact_input_missing"); originals.push(image); inspect();
          }
          inspect(); const response = o.stateStore.loadProductionImageResponse(actor.tenantId, project, this.mode, job);
          raw = response?.body;
          if (!response || fp(response.record) !== fp(c.result)) reject("production_image_artifact_response_changed"); inspect(); return c;
        });
        if (initial.artifact) return initial.artifact; // No decode/wire/price/send on history.
        const e = initial.execution;
        const prepared = await prepareProductionImageProtocol(e.preparation, productionExpected(e.preparation),
          { jobId: e.protocol.request.jobId, idempotencyKey: e.protocol.request.idempotencyKey }, originals, e.confirmedAt);
        wire = prepared.wire.body; inspect();
        if (fp(prepared.snapshot.request) !== fp(e.protocol.request) || prepared.snapshot.requestFingerprint !== e.protocol.requestFingerprint
          || prepared.snapshot.payloadChecksumSha256 !== e.protocol.payloadChecksumSha256 || wire.byteLength !== e.protocol.payloadByteSize
          || prepared.snapshot.contentType !== e.protocol.contentType || fp(prepared.snapshot.transformedInputs) !== fp(e.protocol.transformedInputs)
          || createHash("sha256").update(wire).digest("hex") !== e.protocol.payloadChecksumSha256) reject("production_image_artifact_payload_changed");
        wire.fill(0); wire = undefined; for (const image of originals) image.body.fill(0);
        const decoded = await validateProductionImageOutput(e, initial.lease, initial.intent, initial.attempt, initial.result, raw!, new Date(guard()).toISOString());
        output = decoded.body; raw!.fill(0); raw = undefined; inspect();
        return o.stateStore.transaction(() => {
          const current = inspect();
          if (current.artifact) return current.artifact;
          if (fp(current.execution) !== fp(e) || fp(current.result) !== decoded.draft.responseFingerprint || fp(current.attempt) !== decoded.draft.attemptFingerprint) reject("production_image_artifact_context_changed");
          const at = new Date(guard()).toISOString(), draft = { ...decoded.draft, validatedAt: at };
          const id = `production-generated-${randomUUID()}`, storage = createHash("sha256").update(JSON.stringify([actor.tenantId, project, id])).digest("hex");
          const asset = { id, projectId: project, kind: "image" as const, purpose: "generated" as const,
            ...(e.protocol.request.operation === "edit" ? { sourceAssetId: e.protocol.request.inputs[0].assetId } : {}),
            originalName: `${id}.${e.protocol.request.parameters.outputFormat}`, storageKey: `local-verified:${storage}`,
            mimeType: draft.image.mimeType, byteSize: output!.length, width: draft.image.width, height: draft.image.height,
            contentFingerprint: `sha256:${draft.image.checksumSha256}`, createdAt: at };
          const image = VerifiedImageSchema.parse({ schemaVersion: 1, id: `production-verification-${randomUUID()}`, tenantId: actor.tenantId,
            asset, checksumSha256: draft.image.checksumSha256, registeredMetadataSha256: assetMetadataFingerprint(asset), decoder: draft.decoder, verifiedBy: actor.actorId, verifiedAt: at });
          const record = ProductionImageArtifactSchema.parse({ schemaVersion: 1, mode: this.mode, validation: "verified", executionAuthorized: false, realExecutionEnabled: false,
            tenantId: actor.tenantId, projectId: project, jobId: job, batchId: batch, draft, draftFingerprint: fp(draft),
            request: e.protocol.request, constraint: e.preparation.constraint, transformedInputs: e.protocol.transformedInputs, image, committedBy: actor.actorId, committedAt: at });
          const catalog = o.stateStore.loadCatalog()!, target = catalog.projects.find(p => p.projectId === project)!;
          if (target.assets.length >= 10_000) reject("production_image_artifact_catalog_full", 413);
          const hash = fp(record); this.pending.set(hash, { actor: `${actor.tenantId}\0${actor.actorId}`, guard });
          try {
            // Pending is only live around actual matched bytes + SAME transaction.
            o.stateStore.saveProductionImageArtifact(record, output!, { maxMetadataBytes: metadata, maxProjectBytes: binary }); guard();
            target.assets.push(image.asset); o.stateStore.saveCatalog(catalog); guard();
            o.runKernel.attachProductionImageArtifact(actor, project, batch, job, identity, record); inspect();
            if (o.stateStore.imageMetadataBytes(actor.tenantId, project) + imageTaskMetadataBytes(o.stateStore.load(), actor.tenantId, project) > metadata
              || o.stateStore.localImageBinaryBytes(actor.tenantId, project) > binary) reject("production_image_artifact_shared_quota", 413);
            guard(); return record;
          } finally { this.pending.delete(hash); }
        });
      } catch (error) { if (error instanceof RunKernelError) throw error; reject("production_image_artifact_unavailable", 503); }
      finally { raw?.fill(0); output?.fill(0); wire?.fill(0); for (const image of originals) image.body.fill(0); activeIngestions--; }
    })();
    const aborted = new Promise<never>((_resolve, rejectPromise) => {
      const onAbort = () => rejectPromise(new RunKernelError(499, "production_image_artifact_cancelled", "产物处理已取消，预留不释放"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort(); timer = setTimeout(() => controller.abort(), timeout);
    });
    try { return await Promise.race([work, aborted]); }
    finally { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }
}
// Both default closed. A fixture cannot relabel its actual task as production.
export class ProductionImageTaskArtifacts extends ArtifactCore { constructor(options?: Options) { super("production", options); } }
export class ImageProductionArtifactHarness extends ArtifactCore { constructor(options?: Options) { super("production-contract-fixture", options); } }
