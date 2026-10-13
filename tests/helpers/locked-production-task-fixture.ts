import { LockedProductionImageTaskReconstruction, LockedImageProductionReconstructionHarness } from "../../apps/api/src/lockedProductionImageTaskReconstruction";
import { createLockedProductionImageLeaseFixturePolicy, createLockedProductionImageLeasePolicy, type LockedProductionImageLeasePolicy } from "../../apps/api/src/lockedProductionImageLeasePolicy";
import type { RunKernelOptions } from "../../apps/api/src/runKernel";
import { vi } from "vitest";
import { VerifiedImageSchema } from "../../packages/contracts/src/index";
import { LockedImageProductionPreparationHarness, LockedProductionImagePreparations, type LockedImagePriceContext } from "../../apps/api/src/lockedProductionImagePreparations";
import { lockedExpected } from "../../apps/api/src/lockedProductionImageProtocol";
import { assetMetadataFingerprint } from "../../apps/api/src/assetMetadata";
import { at, connection, principal, setupImageTask, sha } from "./image-task-fixture";
import type { ProductionImageCredentialNetworkOptions } from "../../apps/api/src/productionImageCredentialNetwork";

// Only test-owned source/mask bytes, temporary SQLite and explicit fake pricing.
// Shared setup keeps default hook/test deadlines separate from live execution.
export function lockedResponse(source: Buffer) {
  return { status: 200, contentType: "application/json", requestId: "owned-response",
    body: Buffer.from(JSON.stringify({ created: 1, data: [{ b64_json: source.toString("base64") }] })) };
}
export function createLockedTaskFixture(source: Buffer, mask: Buffer, opts: { baseUrl?: string; priceDurationMs?: number; manual?: boolean; cap?: number; protocol?: "openai" | "openai-compatible"; encoding?: "json-images" | "multipart-image-array" | "multipart-image-single"; production?: boolean; timeout?: number; enabled?: boolean; lease?: boolean; quota?: number; start?: boolean; startTimeout?: number; response?: boolean; send?: (c: any) => Promise<any>; kernel?: Partial<RunKernelOptions> } = {}) {
  let service: LockedImageProductionPreparationHarness | LockedProductionImagePreparations;
  let leasePolicy: LockedProductionImageLeasePolicy, leaseAllowed: unknown = true;
  let reconstruction: LockedProductionImageTaskReconstruction | LockedImageProductionReconstructionHarness, startAllowed: unknown = true, responseAllowed: unknown = true;
  const leaseGate: LockedProductionImageLeasePolicy = { usesStateStore: s => leasePolicy.usesStateStore(s), authorizeScope: (p, project, purpose) => leasePolicy.authorizeScope(p, project, purpose),
    validate: (p, e, purpose, bytes) => leasePolicy.validate(p, e, purpose, bytes) };
  const f = setupImageTask({ productionResponses: true, productionArtifacts: true,
    kernel: { validateLockedProductionImageConfirmation: (p, e) => service.authorizeConfirmation(p, e), ...(opts.lease === false ? {} : { lockedProductionImageLeasePolicy: leaseGate }),
      ...(opts.start === false ? {} : { lockedProductionImageStartPolicy: { usesStateStore: s => reconstruction.usesStateStore(s), authorizeScope: (p, project) => reconstruction.authorizeScope(p, project), validateStart: (p, e, l, i) => reconstruction.validateStart(p, e, l, i) } }), lockedProductionImageResponsePolicy: { usesStateStore: s => reconstruction.responsePolicy.usesStateStore(s), authorizeScope: (p,project) => reconstruction.responsePolicy.authorizeScope(p,project), validateAttempt: (p,e,l,i,a) => reconstruction.responsePolicy.validateAttempt(p,e,l,i,a), validateResult: (p,e,l,i,a,r) => reconstruction.responsePolicy.validateResult(p,e,l,i,a,r) }, ...opts.kernel } });
  const denied = new Set<string>(); let policy: unknown = true, allowed: unknown = true;
  const authorizer = { authenticate: () => principal, allows: (p: typeof principal, project: string, permission: string) =>
    p.tenantId === principal.tenantId && ["writer", "reader"].includes(p.actorId) && project === "project-a" && !denied.has(permission) ? allowed as boolean : false };
  const base = connection(), config = connection({ baseUrl: opts.baseUrl ?? base.baseUrl, protocol: opts.protocol ?? "openai", models: [{ ...base.models[0], sizes: { allowAuto: false, presets: [{ width: 2, height: 1 }] },
    mask: { mode: "prompt-guidance", polarity: opts.protocol === "openai-compatible" ? "white-edit" : "transparent-edit" } }],
    ...(opts.protocol === "openai-compatible" ? { compatibility: { version: "owned", editEncoding: opts.encoding ?? "json-images", responseEncoding: "images-b64-json-v1",
      auth: { scheme: "bearer" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}) }); f.register(config);
  for (const [id, body, purpose] of [["source", source, "source"], ["mask", mask, "mask"]] as const) {
    const a = { id, projectId: "project-a", kind: "image", purpose, storageKey: `owned:${id}`, originalName: `${id}.png`, mimeType: "image/png", byteSize: body.length,
      width: 2, height: 1, contentFingerprint: `sha256:${sha(body)}`, createdAt: at, ...(purpose === "mask" ? { sourceAssetId: "source" } : {}) };
    const r = VerifiedImageSchema.parse({ schemaVersion: 1, id: `receipt-${id}`, tenantId: principal.tenantId, asset: a, checksumSha256: sha(body),
      registeredMetadataSha256: assetMetadataFingerprint(a as any), decoder: "sharp-full-decode-v1", verifiedBy: "owned", verifiedAt: at,
      ...(purpose === "mask" ? { sourceChecksumSha256: sha(source) } : {}) });
    f.store.transaction(() => { f.store.saveVerifiedImage(r, body); const c = f.store.loadCatalog()!; c.projects[0].assets.push(r.asset); f.store.saveCatalog(c); });
  }
  f.store.transaction(() => { const c = f.store.loadCatalog()!, x = c.projects[0].constraints[0]; x.lockedPaths = ["product.pixels"];
    x.editableRegions = [{ id: "region", description: "原锁区", maskAssetId: "mask" }]; x.outputSpec = { width: 2, height: 1, format: "png" }; f.store.saveCatalog(c); });
  const pricePort = { kind: opts.production ? "server-pricing" : "contract-fixture", realExecutionEnabled: false,
    read: vi.fn((c: LockedImagePriceContext) => ({ schemaVersion: 1, scope: c.scope, quote: { id: "owned-price", version: "owned-v1", currency: "CNY",
      source: opts.manual ? "manual-budget" : "server-price-table", maxCostMinor: opts.cap ?? 40, ...(opts.manual ? {} : { estimatedCostMinor: 25 }), expiresAt: new Date(f.clock() + (opts.priceDurationMs ?? 60_000)).toISOString() },
      evidence: { kind: opts.production ? opts.manual ? "server-approved-budget" : "server-verified-price" : "contract-fixture", ...(opts.production ? {} : { realExecutionEnabled: false }),
        sourceRevision: "owned", evidenceRef: "owned-price", checkedBy: "owned", checkedAt: c.requestedAt } })), verify: vi.fn((): unknown => true) };
  const options = { preparationEnabled: true as const, lockedPreparationEnabled: true as const, lockedConfirmationEnabled: opts.enabled === false ? undefined : true as const,
    tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, clock: f.clock, timeoutMs: opts.timeout, pricePort: pricePort as any,
    authorizer, runAuthorizer: authorizer, assetAuthorizer: authorizer, lockedPreparationPolicy: () => true, lockedConfirmationPolicy: () => policy as boolean };
  service = opts.production ? new LockedProductionImagePreparations(options) : new LockedImageProductionPreparationHarness(options);
  const leaseOptions = { lockedLeaseEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, pricePort: pricePort as any,
    runAuthorizer: authorizer, providerAuthorizer: authorizer, assetAuthorizer: authorizer, clock: f.clock, maxMetadataBytes: opts.quota,
    lockedLeasePolicy: () => leaseAllowed as boolean };
  leasePolicy = opts.production ? createLockedProductionImageLeasePolicy(leaseOptions) : createLockedProductionImageLeaseFixturePolicy(leaseOptions);
  const rebuildOptions = { lockedReconstructionEnabled: true as const, lockedStartEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel,
    leasePolicy: leaseGate, lockedStartPolicy: () => startAllowed as boolean, clock: f.clock, timeoutMs: opts.startTimeout, lockedResponseEnabled: opts.response === false ? undefined : true as const, lockedResponsePolicy: () => responseAllowed as boolean, fixtureTransport: { mode: "contract-fixture" as const, realExecutionEnabled: false as const, send: vi.fn(opts.send ?? (async () => lockedResponse(source))) } };
  reconstruction = opts.production ? new LockedProductionImageTaskReconstruction(rebuildOptions) : new LockedImageProductionReconstructionHarness(rebuildOptions);
  const select = (action = "locked-owned") => ({ projectId: "project-a", idempotencyKey: action, connectionId: config.id, connectionRevision: 1, model: config.models[0].model,
    capabilityVersion: config.models[0].version, constraintSnapshotId: "constraint-a", operation: "edit", inputAssetIds: ["source"], maskAssetId: "mask", protection: "pixel-exact",
    parameters: { prompt: "原人工锁区指令", n: 1, size: { width: 2, height: 1 }, quality: "auto", background: "auto", outputFormat: "png" } });
  const prepare = async (action = "locked-owned") => { const v = await service.createPreparation(principal, select(action)); return f.store.loadLockedProductionImagePreparation(principal.tenantId, "project-a", v.mode, v.id)!; };
  const confirm = (p: Awaited<ReturnType<typeof prepare>>, actor = principal, expected: unknown = lockedExpected(p), signal?: AbortSignal) => service.confirmPreparation(actor, "project-a", p.id, expected, { signal });
  const connectNetwork = (credentialNetwork: ProductionImageCredentialNetworkOptions) => {
    const networkOptions = { ...rebuildOptions, fixtureTransport: undefined, credentialNetwork };
    reconstruction = opts.production ? new LockedProductionImageTaskReconstruction(networkOptions) : new LockedImageProductionReconstructionHarness(networkOptions);
    return reconstruction;
  };
  return { ...f, reconstruction, connectNetwork, rebuildOptions, send: rebuildOptions.fixtureTransport.send, responseAllow: (v: unknown) => { responseAllowed = v; }, startAllow: (v: unknown) => { startAllowed = v; }, service, options, authorizer, config, select, prepare, confirm, pricePort, leasePolicy, leaseOptions, leaseGate, leaseAllow: (v: unknown) => { leaseAllowed = v; }, deny: (p: string) => denied.add(p), policy: (p: unknown) => { policy = p; }, allow: (v: unknown) => { allowed = v; } };
}
export async function prepareLockedTaskFixture(source: Buffer, mask: Buffer, opts: Parameters<typeof createLockedTaskFixture>[2] = {}) {
  const f = createLockedTaskFixture(source, mask, opts), preparation = await f.prepare(), v = await f.confirm(preparation);
  const l = f.kernel.claimLockedProductionImageBatch(principal, "project-a", v.batchId, { workerId: "owned-worker", maxJobs: 1 }).leases[0], input = { workerId: l.workerId, leaseId: l.leaseId };
  const execute = (signal?: AbortSignal, actor = principal) => f.reconstruction.executeFixture(actor, "project-a", v.batchId, v.jobId, input, { signal });
  const start = () => f.reconstruction.start(principal, "project-a", v.batchId, v.jobId, input);
  const inspect = () => f.kernel.inspectLockedImageAttempt(principal, "project-a", v.batchId, v.jobId, input);
  return { ...f, preparation, v, l, input, execute, start, inspect };
}
