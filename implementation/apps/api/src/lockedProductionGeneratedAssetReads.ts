import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { LockedProductionGeneratedAssetMetadataSchema, LockedProductionGeneratedAssetLineageSchema,
  type LockedProductionGeneratedAssetMetadata, type LockedProductionGeneratedAssetLineage, type VerifiedImage } from "@canvas/contracts";
import { RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";
import { readLockedProductionBillingEvidence } from "./lockedProductionImageBillingRead";
import { imageProviderPublicView, imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { imageMagicMime } from "./staticImageDecoder";

type Mode = LockedProductionGeneratedAssetMetadata["mode"];
type Options = { lockedGeneratedReadEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel;
  lockedGeneratedReadPolicy(context: { principal: RunPrincipal; projectId: string; assetId: string; mode: Mode; lineage: boolean }): boolean;
  assetAuthorizer: ObjectStorageAuthorizer; runAuthorizer?: RunAuthorizer; clock?: () => number; timeoutMs?: number; maxMetadataBytes?: number };
export type LockedProductionGeneratedAssetContent = { metadata: LockedProductionGeneratedAssetMetadata; body: Buffer };
function valid(v: unknown): v is string { return typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 160 && !/[\x00-\x1f\x7f]/.test(v); }
function reject(code = "locked_generated_asset_unavailable", status = 503): never { throw new RunKernelError(status, code, "保护原图读取失败关闭，未生成或改变费用"); }
const statuses: Record<string, number> = { locked_generated_asset_not_found: 404, locked_generated_asset_not_configured: 503,
  locked_generated_asset_configuration_invalid: 503, locked_generated_asset_lineage_not_configured: 503, locked_generated_asset_cancelled: 499, locked_generated_asset_busy: 429 };
function strict(v: unknown) {
  if (v && (typeof v === "object" || typeof v === "function") && "then" in v) void Promise.resolve(v).catch(() => undefined);
  if (v !== true) reject("locked_generated_asset_not_found", 404);
}
function inputView(r: VerifiedImage) { return { assetId: r.asset.id, receiptId: r.id, checksumSha256: r.checksumSha256,
  registeredMetadataSha256: r.registeredMetadataSha256, mimeType: r.asset.mimeType, byteSize: r.asset.byteSize, width: r.asset.width, height: r.asset.height }; }
class ReadCore {
  private readonly options?: Options;
  private readonly functions?: unknown[];
  private readonly configurationHash?: string;
  private active = false;
  constructor(private readonly mode: Mode, options?: Options) {
    this.options = options && { ...options };
    if (this.options) { this.config(); this.functions = this.identities(); this.configurationHash = fp(this.configuration()); }
  }
  private identities() { const o = this.options!; return [o.runKernel.usesStateStore, o.runKernel.validateProductionBillingSnapshot,
    o.runKernel.captureLockedProductionBillingReadConfiguration, o.assetAuthorizer.authenticate, o.assetAuthorizer.allows, o.runAuthorizer?.allows,
    o.runKernel, o.stateStore, o.assetAuthorizer, o.runAuthorizer, o.lockedGeneratedReadPolicy, o.clock]; }
  private configuration() { const o = this.options!; return { tenant: o.tenantId, mode: this.mode, enabled: o.lockedGeneratedReadEnabled,
    timeout: o.timeoutMs, metadata: o.maxMetadataBytes }; }
  private config(checkStore = true) {
    const o = this.options;
    if (!o || o.lockedGeneratedReadEnabled !== true || typeof o.lockedGeneratedReadPolicy !== "function") reject("locked_generated_asset_not_configured");
    if (!valid(o.tenantId) || !o.runKernel || !o.stateStore || !o.assetAuthorizer || (checkStore && o.runKernel.usesStateStore(o.stateStore) !== true)
      || o.stateStore.supportsProductionImageResponses() !== true || o.stateStore.supportsProductionImageArtifacts() !== true
      || (this.functions && this.identities().some((f, i) => f !== this.functions![i]))
      || (this.configurationHash && this.configurationHash !== fp(this.configuration()))) reject("locked_generated_asset_configuration_invalid");
    return o;
  }
  private safe<T>(action: () => T): T { try { return action(); } catch (e) {
    if (e instanceof RunKernelError && statuses[e.code] !== undefined) reject(e.code, statuses[e.code]); reject();
  } }
  authenticate(request: IncomingMessage): RunPrincipal | null {
    return this.safe(() => { const o = this.config(), p = o.assetAuthorizer.authenticate(request);
      if (p && (typeof p !== "object" || "then" in p)) { void Promise.resolve(p).catch(() => undefined); reject(); }
      return p && p.tenantId === o.tenantId && valid(p.actorId) ? { tenantId: p.tenantId, actorId: p.actorId } : null;
    });
  }
  private scope(p: RunPrincipal, project: string, asset: string, lineage: boolean) {
    const o = this.config();
    if (!valid(p.actorId) || p.tenantId !== o.tenantId || !valid(project) || !valid(asset)) reject("locked_generated_asset_not_found", 404);
    if (lineage && !o.runAuthorizer) reject("locked_generated_asset_lineage_not_configured");
    strict(o.lockedGeneratedReadPolicy(structuredClone({ principal: p, projectId: project, assetId: asset, mode: this.mode, lineage })));
    strict(o.assetAuthorizer.allows(structuredClone(p), project, "asset:read"));
    if (lineage) strict(o.runAuthorizer!.allows(structuredClone(p), project, "run:read"));
  }
  read(p: RunPrincipal, project: string, asset: string, options: { signal?: AbortSignal } = {}): LockedProductionGeneratedAssetContent {
    return this.verified(p, project, asset, false, options.signal) as LockedProductionGeneratedAssetContent;
  }
  lineage(p: RunPrincipal, project: string, asset: string, options: { signal?: AbortSignal } = {}): LockedProductionGeneratedAssetLineage {
    return this.verified(p, project, asset, true, options.signal) as LockedProductionGeneratedAssetLineage;
  }
  private verified(principal: RunPrincipal, project: string, asset: string, lineage: boolean, signal?: AbortSignal) {
    return this.safe(() => {
      const p = structuredClone(principal), o = this.config(), max = o.maxMetadataBytes ?? 16 * 1024 * 1024, timeout = o.timeoutMs ?? 5000;
      if (!Number.isSafeInteger(max) || max < 0 || max > 16 * 1024 * 1024 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) reject();
      const clock = o.clock ?? Date.now, fixed = o.runKernel.captureLockedProductionBillingReadConfiguration(o.stateStore);
      const kernel = { validateProductionBillingSnapshot: o.runKernel.validateProductionBillingSnapshot.bind(o.runKernel) };
      const start = clock(), wall = performance.now(); let last = start;
      const pure = () => {
        if (signal?.aborted) reject("locked_generated_asset_cancelled", 499);
        this.config(false); fixed(); const now = clock();
        if (!Number.isSafeInteger(start) || start < 0 || start > 8_640_000_000_000_000 - 30000 || !Number.isSafeInteger(now) || now < last
          || now - start >= timeout || performance.now() - wall >= timeout) reject(); last = now; return now;
      };
      const guard = () => { this.scope(p, project, asset, lineage); return pure(); };
      pure(); if (this.active) reject("locked_generated_asset_busy", 429); this.active = true;
      try { return o.stateStore.transaction(() => {
        guard(); const snapshot = o.stateStore.load(); guard(); if (!snapshot) reject("locked_generated_asset_not_found", 404);
        const catalog = fp(o.stateStore.loadCatalog()); guard();
        const matches = snapshot.batches.filter(s => s.aggregate.batch.tenantId === p.tenantId && s.aggregate.batch.projectId === project
          && (s.lockedProductionImageArtifact?.image.asset.id === asset || s.aggregate.jobs.some(j => j.outputAssetIds.includes(asset))));
        if (!matches.length) reject("locked_generated_asset_not_found", 404); if (matches.length !== 1) reject();
        const s = matches[0], e = s.lockedProductionImageExecution, a = s.lockedProductionImageArtifact, j = s.aggregate.jobs[0];
        if (!e || e.mode !== this.mode || !a || a.mode !== this.mode || !s.lockedProductionImageArtifactFingerprint || !["billing_unknown", "succeeded"].includes(j.status)) reject();
        const read = (check: () => number) => readLockedProductionBillingEvidence(o.stateStore, kernel, p, project, e.batchId, j.id, this.mode, check, max);
        const first = read(guard);
        if (first.snapshotFingerprint !== fp(snapshot) || first.catalogFingerprint !== catalog) reject();
        guard(); const image = o.stateStore.loadVerifiedImageBytes(p.tenantId, project, asset); let outgoing: Buffer | undefined;
        try {
          guard(); if (!image || fp(image.receipt) !== fp(a.image) || imageMagicMime(image.body) !== a.image.asset.mimeType
            || image.body.length !== a.image.asset.byteSize || createHash("sha256").update(image.body).digest("hex") !== a.image.checksumSha256) reject();
          const policy = a.protectionPolicy, proof = a.draft.pixelProof;
          const metadata = LockedProductionGeneratedAssetMetadataSchema.parse({ schemaVersion: 2, mode: this.mode, tenantId: p.tenantId, projectId: project,
            executionAuthorized: false, realExecutionEnabled: false, image: a.image, artifactFingerprint: s.lockedProductionImageArtifactFingerprint,
            protection: { schemaVersion: 1, observation: "stored-output-pixel-evidence", policyVersion: policy.policyVersion,
              normalizationVersion: policy.normalizationVersion, maskPolicy: policy.maskPolicy, protectionApplied: "checked-not-applied",
              domain: "fixed-rgba8-only", lockedPixelsEqual: true, policyFingerprint: fp(policy), pixelProofFingerprint: fp(proof),
              source: inputView(policy.source), mask: { ...inputView(policy.mask), sourceAssetId: policy.mask.asset.sourceAssetId, sourceChecksumSha256: policy.mask.sourceChecksumSha256 }, sourcePixelsSha256: policy.sourcePixelsSha256,
              maskPixelsSha256: policy.maskPixelsSha256, candidatePixelsSha256: proof.candidatePixelsSha256, outputChecksumSha256: proof.candidateChecksumSha256,
              lockedPixels: policy.lockedPixels, editablePixels: policy.editablePixels, policyVerifiedAt: policy.verifiedAt, outputValidatedAt: proof.validatedAt } });
          const result = lineage ? LockedProductionGeneratedAssetLineageSchema.parse({ ...metadata, batchId: s.aggregate.batch.id, jobId: j.id, jobStatus: j.status,
            connection: imageProviderPublicView(e.preparation.connection), requestDraft: e.preparation.requestDraft, constraint: a.constraint,
            pricing: { schemaVersion: e.preparation.pricing.schemaVersion, quote: e.preparation.pricing.quote, evidence: e.preparation.pricing.evidence },
            preparationId: e.preparation.id, preparationFingerprint: e.preparation.snapshotFingerprint, pricingFingerprint: e.protocol.pricingFingerprint,
            executionFingerprint: fp(e), requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256,
            transformedInputs: a.transformedInputs, confirmedBy: e.confirmedBy, confirmedAt: e.confirmedAt,
            billing: { state: j.status === "succeeded" ? "settled" : "unknown", currency: s.aggregate.batch.currency, estimatedMinor: j.estimatedCostMinor,
              maxCostMinor: e.protocol.request.quote.maxCostMinor, currentMaxCostMinor: s.aggregate.batch.maxCostMinor,
              reservedMinor: s.jobReservations.find(([id]) => id === j.id)?.[1] ?? 0, ...(j.actualCostMinor === undefined ? {} : { actualMinor: j.actualCostMinor }) } }) : metadata;
          if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) reject();
          if (!lineage) outgoing = Buffer.from(image.body);
          guard(); const final = read(pure); pure();
          if (fp(first) !== fp(final) || fp(o.stateStore.load()) !== fp(snapshot) || fp(o.stateStore.loadCatalog()) !== catalog) reject();
          pure(); return lineage ? result : { metadata, body: outgoing! };
        } catch (error) { outgoing?.fill(0); throw error; } finally { image?.body.fill(0); }
      }); } finally { this.active = false; }
    });
  }
}
export class LockedProductionGeneratedAssetReads extends ReadCore { constructor(options?: Options) { super("production", options); } }
export class LockedImageProductionGeneratedAssetReadHarness extends ReadCore { constructor(options?: Options) { super("production-contract-fixture", options); } }
export type LockedProductionGeneratedAssetReadPort = LockedProductionGeneratedAssetReads | LockedImageProductionGeneratedAssetReadHarness;
