import type { IncomingMessage } from "node:http";
import { CreateImagePreparationSchema, ConfirmLockedProductionImagePreparationSchema, LockedProductionImagePreparationPublicSchema,
  LockedProductionImageConfirmationPublicSchema, LockedProductionImageConfirmationHistorySchema, type LockedProductionImagePreparationRecord, type VerifiedImage } from "@canvas/contracts";
import { LockedProductionImagePreparations, LockedImageProductionPreparationHarness } from "./lockedProductionImagePreparations";
import { imageProviderPublicView, imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { readLockedPublicEvidence } from "./lockedProductionImagePublicRead";
import { RunKernelError, type RunAuthorizer, type RunPrincipal } from "./runKernel";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";

type Mode = LockedProductionImagePreparationRecord["mode"];
type Action = "read" | "prepare" | "confirm";
interface Base { lockedPublicPreparationEnabled: true; tenantId: string; stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel;
  runAuthorizer: RunAuthorizer; providerAuthorizer: ImageProviderAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
  lockedPublicPreparationPolicy(scope: { principal: RunPrincipal; projectId: string; mode: Mode; action: Action }): boolean;
  clock?: () => number; timeoutMs?: number }
type Options = Base & { preparations: LockedProductionImagePreparations | LockedImageProductionPreparationHarness };
const valid = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(v);
const statuses: Record<string, number> = { locked_public_not_configured: 503, locked_public_configuration_invalid: 503, locked_public_permission_denied: 403,
  locked_public_preparation_missing: 404, locked_public_response_too_large: 413, locked_public_request_invalid: 400, locked_public_expired: 408,
  locked_public_cancelled: 499, locked_preparation_permission_denied: 403, locked_confirmation_permission_denied: 403,
  locked_preparation_idempotency_conflict: 409, locked_preparation_busy: 429, locked_confirmation_busy: 429 };
function reject(code = "locked_public_unavailable", status = 503): never { throw new RunKernelError(status, code, "保护准备/确认失败关闭，请保留原编号只读核对；不授权发送"); }
function strict(v: unknown) {
  if (v && (typeof v === "object" || typeof v === "function") && "then" in v) void Promise.resolve(v).catch(() => undefined);
  if (v !== true) reject("locked_public_permission_denied", 403);
}
const pricing = (r: LockedProductionImagePreparationRecord) => ({ schemaVersion: r.pricing.schemaVersion, quote: r.pricing.quote, evidence: r.pricing.evidence });
const inputView = (r: VerifiedImage) => ({ assetId: r.asset.id, receiptId: r.id, checksumSha256: r.checksumSha256, registeredMetadataSha256: r.registeredMetadataSha256,
  mimeType: r.asset.mimeType, byteSize: r.asset.byteSize, width: r.asset.width, height: r.asset.height });
function policyView(r: LockedProductionImagePreparationRecord) {
  const p = r.protectionPolicy;
  return { schemaVersion: p.schemaVersion, policyVersion: p.policyVersion, normalizationVersion: p.normalizationVersion, maskPolicy: p.maskPolicy,
    domain: "fixed-rgba8-only", validation: "input-verified-output-unchecked", executionAuthorized: false, realExecutionEnabled: false,
    tenantId: p.tenantId, projectId: p.projectId, constraintSnapshotId: p.constraintSnapshotId, constraintChecksumSha256: p.constraintChecksumSha256,
    source: inputView(p.source), mask: { ...inputView(p.mask), sourceAssetId: p.mask.asset.sourceAssetId, sourceChecksumSha256: p.mask.sourceChecksumSha256 },
    inputAssetIds: p.inputAssetIds, outputSpec: p.outputSpec, sourcePixelsSha256: p.sourcePixelsSha256, maskPixelsSha256: p.maskPixelsSha256,
    lockedPixels: p.lockedPixels, editablePixels: p.editablePixels, verifiedAt: p.verifiedAt };
}
class PublicCore {
  private readonly options?: Options;
  private readonly functions?: unknown[];
  private readonly configurationHash?: string;
  constructor(private readonly mode: Mode, options?: Options) { this.options = options && { ...options }; if (options) {
    this.config(); this.functions = this.identities(); this.configurationHash = fp(this.configuration());
  } }
  private configuration() { const o = this.options!; return { tenantId: o.tenantId, mode: this.mode,
    lockedPublicPreparationEnabled: o.lockedPublicPreparationEnabled, timeoutMs: o.timeoutMs ?? 5000 }; }
  private identities() { const o = this.options!; return [o.stateStore, o.runKernel, o.preparations, o.runAuthorizer, o.providerAuthorizer, o.assetAuthorizer, o.runKernel.usesStateStore, o.runKernel.validateProductionBillingSnapshot,
    o.runKernel.captureLockedProductionBillingReadConfiguration, o.preparations.usesStateStore, o.preparations.createPreparation, o.preparations.confirmPreparation,
    o.runAuthorizer.authenticate, o.runAuthorizer.allows, o.providerAuthorizer.allows, o.assetAuthorizer.allows, o.lockedPublicPreparationPolicy, o.clock]; }
  private config(checkStore = true) {
    const o = this.options;
    if (!o || o.lockedPublicPreparationEnabled !== true || typeof o.lockedPublicPreparationPolicy !== "function") reject("locked_public_not_configured");
    if (this.configurationHash && fp(this.configuration()) !== this.configurationHash || !valid(o.tenantId)
      || (checkStore && (o.runKernel.usesStateStore(o.stateStore) !== true || o.preparations.usesStateStore(o.stateStore) !== true))
      || o.stateStore.supportsProductionImageResponses() !== true || o.stateStore.supportsProductionImageArtifacts() !== true
      || (this.mode === "production" ? !(o.preparations instanceof LockedProductionImagePreparations) : !(o.preparations instanceof LockedImageProductionPreparationHarness))
      || this.functions && this.identities().some((f, i) => f !== this.functions![i])) reject("locked_public_configuration_invalid");
    return o;
  }
  private error(e: unknown): never {
    if (e instanceof RunKernelError && statuses[e.code] !== undefined) reject(e.code, statuses[e.code]);
    if (e instanceof Error && e.name === "ZodError") reject("locked_public_request_invalid", 400); reject();
  }
  authenticate(request: IncomingMessage): RunPrincipal | null {
    try { const o = this.config(), p = o.runAuthorizer.authenticate(request);
      if (p && (typeof p !== "object" || "then" in p)) { void Promise.resolve(p).catch(() => undefined); reject(); }
      return p && p.tenantId === o.tenantId && valid(p.actorId) ? { tenantId: p.tenantId, actorId: p.actorId } : null;
    } catch (e) { this.error(e); }
  }
  private scope(p: RunPrincipal, project: string, action: Action) {
    const o = this.config(); if (p.tenantId !== o.tenantId || !valid(p.actorId) || !valid(project)) reject("locked_public_permission_denied", 403);
    strict(o.lockedPublicPreparationPolicy(structuredClone({ principal: p, projectId: project, mode: this.mode, action })));
    strict(o.runAuthorizer.allows(structuredClone(p), project, "run:read")); strict(o.providerAuthorizer.allows(structuredClone(p), project, "provider:read"));
    strict(o.assetAuthorizer.allows(structuredClone(p), project, "asset:read"));
    if (action !== "read") strict(o.runAuthorizer.allows(structuredClone(p), project, "run:create"));
    if (action === "confirm") strict(o.runAuthorizer.allows(structuredClone(p), project, "run:confirm"));
  }
  private view(r: LockedProductionImagePreparationRecord) {
    return LockedProductionImagePreparationPublicSchema.parse({ schemaVersion: 2, id: r.id, tenantId: r.tenantId, projectId: r.projectId, mode: r.mode,
      status: r.status, executionAuthorized: false, realExecutionEnabled: false, protocolPreparation: r.protocolPreparation,
      snapshotFingerprint: r.snapshotFingerprint, basisFingerprint: r.basisFingerprint, pricingFingerprint: fp(r.pricing), protectionPolicyFingerprint: fp(r.protectionPolicy),
      createdBy: r.createdBy, createdAt: r.createdAt, connection: imageProviderPublicView(r.connection), requestDraft: r.requestDraft, constraint: r.constraint,
      pricing: pricing(r), protectionPolicy: policyView(r) });
  }
  private read(principal: RunPrincipal, project: string, id: string, confirmation: boolean, signal?: AbortSignal) {
    try {
      const p = structuredClone(principal), o = this.config(), clock = o.clock ?? Date.now, timeout = o.timeoutMs ?? 5000;
      if (!valid(id) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) reject("locked_public_request_invalid", 400);
      const fixed = o.runKernel.captureLockedProductionBillingReadConfiguration(o.stateStore), start = clock(), wall = performance.now(); let last = start;
      const kernel = { validateProductionBillingSnapshot: o.runKernel.validateProductionBillingSnapshot.bind(o.runKernel) };
      const pure = () => { this.config(false); fixed(); const t = clock();
        if (signal?.aborted) reject("locked_public_cancelled", 499);
        if (!Number.isSafeInteger(start) || start < 0 || start > 8_640_000_000_000_000 - 30000 || !Number.isSafeInteger(t) || t < last
          || t - start >= timeout || performance.now() - wall >= timeout) reject("locked_public_expired", 408); last = t; };
      const guard = () => { this.scope(p, project, "read"); pure(); };
      pure(); return o.stateStore.transaction(() => {
        guard(); const r = o.stateStore.loadLockedProductionImagePreparation(p.tenantId, project, this.mode, id); guard();
        if (!r) reject("locked_public_preparation_missing", 404);
        const snapshot = o.stateStore.load(); guard(); if (!snapshot) reject(); const catalog = fp(o.stateStore.loadCatalog()); guard();
        const s = readLockedPublicEvidence(o.stateStore, kernel, r, snapshot, guard);
        let result: unknown = this.view(r);
        if (confirmation) {
          let c = null;
          if (s) { const e = s.lockedProductionImageExecution!, j = s.aggregate.jobs[0], b = s.aggregate.batch;
            c = LockedProductionImageConfirmationPublicSchema.parse({ schemaVersion: 2, tenantId: r.tenantId, projectId: r.projectId, mode: r.mode,
              executionState: e.executionState, executionAuthorized: false, realExecutionEnabled: false, protocolPreparation: "prepared",
              preparationId: id, preparationFingerprint: r.snapshotFingerprint, pricingFingerprint: fp(r.pricing), protectionPolicyFingerprint: fp(r.protectionPolicy), protectionPolicy: policyView(r),
              executionFingerprint: fp(e), requestFingerprint: e.protocol.requestFingerprint, payloadChecksumSha256: e.protocol.payloadChecksumSha256,
              payloadByteSize: e.protocol.payloadByteSize, contentType: e.protocol.contentType, transformedInputs: e.protocol.transformedInputs,
              confirmedBy: e.confirmedBy, confirmedAt: e.confirmedAt, pricing: pricing(r), task: { batchId: b.id, jobId: j.id, tool: b.tool, adapterId: b.adapterId,
                constraintSnapshotId: b.constraintSnapshotId, inputAssetIds: j.inputAssetIds, outputAssetIds: j.outputAssetIds, batchStatus: b.status, jobStatus: j.status,
                estimatedCostMinor: j.estimatedCostMinor, currentMaxCostMinor: b.maxCostMinor, reservedMinor: s.reservedMinor,
                ...(j.actualCostMinor === undefined ? {} : { actualCostMinor: j.actualCostMinor }) } }); }
          result = LockedProductionImageConfirmationHistorySchema.parse({ schemaVersion: 2, mode: r.mode, tenantId: r.tenantId, projectId: r.projectId,
            preparationId: id, preparationFingerprint: r.snapshotFingerprint, pricingFingerprint: fp(r.pricing), protectionPolicyFingerprint: fp(r.protectionPolicy), confirmation: c });
        }
        if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) reject("locked_public_response_too_large", 413);
        guard(); // The LAST authority callback is followed by a port-free full read.
        readLockedPublicEvidence(o.stateStore, kernel, r, snapshot, pure);
        if (fp(o.stateStore.load()) !== fp(snapshot) || fp(o.stateStore.loadCatalog()) !== catalog) reject(); pure(); return result;
      });
    } catch (e) { this.error(e); }
  }
  getPreparation(p: RunPrincipal, project: string, id: string, options: { signal?: AbortSignal } = {}) {
    return LockedProductionImagePreparationPublicSchema.parse(this.read(p, project, id, false, options.signal));
  }
  getConfirmation(p: RunPrincipal, project: string, id: string, options: { signal?: AbortSignal } = {}) {
    return LockedProductionImageConfirmationHistorySchema.parse(this.read(p, project, id, true, options.signal));
  }
  async createPreparation(principal: RunPrincipal, project: string, incoming: unknown, options: { signal?: AbortSignal } = {}) {
    try { const p = structuredClone(principal), o = this.config(); this.scope(p, project, "prepare");
      const input = CreateImagePreparationSchema.parse(incoming); if (input.projectId !== project) reject("locked_public_request_invalid", 400);
      // Native work is deliberately OUTSIDE the wrapper SQL transaction.
      const created = await o.preparations.createPreparation(p, input, options); this.scope(p, project, "prepare");
      return this.getPreparation(p, project, created.id, options);
    } catch (e) { this.error(e); }
  }
  async confirmPreparation(principal: RunPrincipal, project: string, id: string, incoming: unknown, options: { signal?: AbortSignal } = {}) {
    try { const p = structuredClone(principal), o = this.config(); this.scope(p, project, "confirm");
      const input = ConfirmLockedProductionImagePreparationSchema.parse(incoming);
      await o.preparations.confirmPreparation(p, project, id, input, options); this.scope(p, project, "confirm");
      const result = this.getConfirmation(p, project, id, options).confirmation; if (!result) reject(); return result;
    } catch (e) { this.error(e); }
  }
}
export class LockedProductionImagePublicService extends PublicCore { constructor(o?: Base & { preparations: LockedProductionImagePreparations }) { super("production", o); } }
export class LockedImageProductionPublicHarness extends PublicCore { constructor(o?: Base & { preparations: LockedImageProductionPreparationHarness }) { super("production-contract-fixture", o); } }
export type LockedProductionImagePublicPort = LockedProductionImagePublicService | LockedImageProductionPublicHarness;
