import { createRequire } from "node:module";
import { type ConfirmedProductionImageExecution, type ImageProviderConnection } from "../../packages/contracts/src/index";
import { ImageProductionPreparationHarness, ProductionImagePreparations, type ImagePriceContext } from "../../apps/api/src/productionImagePreparations";
import { createProductionImageLeaseFixturePolicy, createProductionImageLeasePolicy, type ProductionImageLeasePolicy } from "../../apps/api/src/productionImageLeasePolicy";
import { ImageProductionReconstructionHarness, ProductionImageTaskReconstruction } from "../../apps/api/src/productionImageTaskReconstruction";
import { ImageProductionArtifactHarness } from "../../apps/api/src/productionImageTaskArtifacts";
import { productionExpected } from "../../apps/api/src/productionImageConfirmationIntegrity";
import { SqliteRunKernelStateStore } from "../../apps/api/src/sqliteRunKernelStore";
import type { RunKernelOptions } from "../../apps/api/src/runKernel";
import { principal, connection, setupImageTask } from "./image-task-fixture";

const sharp = createRequire(new URL("../../apps/api/package.json", import.meta.url))("sharp");

export async function ownedProductionBillingTask(options: { protocol?: ImageProviderConnection["protocol"]; manual?: boolean; edit?: boolean; cap?: number; bad?: boolean; enabled?: boolean; path?: string; actionId?: string; productionStartOnly?: boolean } = {}, mock: (fn: (...args: any[]) => any) => any = fn => fn) {
  let preparations: ImageProductionPreparationHarness, policy: ProductionImageLeasePolicy, reconstruction: ImageProductionReconstructionHarness, artifacts: ImageProductionArtifactHarness;
  const denied = new Set<string>(); let allowed = true;
  const auth = { authenticate: () => principal, allows: (p: typeof principal, project: string, permission?: string) => allowed && !denied.has(permission ?? "")
    && p.tenantId === principal.tenantId && [principal.actorId, "other"].includes(p.actorId) && project === "project-a" };
  const gate: ProductionImageLeasePolicy = { usesStateStore: s => policy.usesStateStore(s), authorizeScope: (p, project) => policy.authorizeScope(p, project), validate: (p,e,purpose,bytes) => policy.validate(p,e,purpose,bytes) };
  const kernelOptions: Partial<RunKernelOptions> = { authorizer: auth, validateProductionImageConfirmation: (p,e: ConfirmedProductionImageExecution) => preparations.authorizeConfirmation(p,e), productionImageLeasePolicy: gate,
    productionImageStartPolicy: { usesStateStore: s => reconstruction?.usesStateStore(s) ?? false, authorizeScope: (p,j) => reconstruction?.authorizeScope(p,j) ?? false, validateStart: (p,e,l,i) => reconstruction?.validateStart(p,e,l,i) ?? false },
    productionImageResponsePolicy: { usesStateStore: s => reconstruction?.responsePolicy.usesStateStore(s) ?? false, authorizeScope: (p,j) => reconstruction?.responsePolicy.authorizeScope(p,j) ?? false,
      validateAttempt: (p,e,l,i,a) => reconstruction?.responsePolicy.validateAttempt(p,e,l,i,a) ?? false, validateResult: (p,e,l,i,a,r) => reconstruction?.responsePolicy.validateResult(p,e,l,i,a,r) ?? false },
    productionImageArtifactPolicy: { usesStateStore: s => artifacts?.usesStateStore(s) ?? false, authorizeScope: (p,j) => artifacts?.authorizeScope(p,j) ?? false, validateCommit: (p,r) => artifacts?.validateCommit(p,r) ?? false } };
  const protocol = options.protocol ?? "openai", format = protocol === "google" ? "jpeg" : "png";
  const f = setupImageTask({ path: options.path, productionResponses: true, productionArtifacts: true, format, kernel: kernelOptions });
  try {
  const model = connection().models[0]; const config = connection({ protocol,
    ...(protocol === "openai-compatible" ? { compatibility: { version: "owned-compat", editEncoding: "multipart-image-array", responseEncoding: "images-b64-json-v1", auth: { scheme: "bearer" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}),
    ...(protocol === "google" ? { baseUrl: "https://generativelanguage.googleapis.com", models: [{ ...model, maxInputImages: 14, outputFormats: ["jpeg"] }], googleNative: { version: "owned-google", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: model.model, sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] } } : {}) });
  f.register(config); if (options.edit) f.source();
  const price = { kind: options.productionStartOnly ? "server-pricing" as const : "contract-fixture" as const, realExecutionEnabled: false as const, read: mock((c: ImagePriceContext) => ({ schemaVersion: 1, scope: c.scope,
    quote: { id: "owned-price", version: "owned-v1", source: options.manual === false ? "server-price-table" : "manual-budget", currency: "CNY", maxCostMinor: options.cap ?? 40,
      ...(options.manual === false ? { estimatedCostMinor: 25 } : {}), expiresAt: new Date(f.clock() + 60_000).toISOString() },
    evidence: { ...(options.productionStartOnly ? { kind: options.manual === false ? "server-verified-price" : "server-approved-budget" } : { kind: "contract-fixture", realExecutionEnabled: false }), sourceRevision: "owned-table", evidenceRef: "no-real-price", checkedBy: "owned-oracle", checkedAt: c.requestedAt } })), verify: mock(() => true) };
  const policyOptions = { leasePreparationEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, clock: f.clock, runAuthorizer: auth, providerAuthorizer: auth, assetAuthorizer: auth, pricePort: price as never };
  policy = options.productionStartOnly ? createProductionImageLeasePolicy(policyOptions) : createProductionImageLeaseFixturePolicy(policyOptions);
  const preparationOptions = { preparationEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, clock: f.clock, runKernel: f.kernel, authorizer: auth, runAuthorizer: auth, assetAuthorizer: auth, pricePort: price as never };
  preparations = options.productionStartOnly ? new ProductionImagePreparations(preparationOptions) : new ImageProductionPreparationHarness(preparationOptions);
  const output: Buffer = options.bad ? Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) : await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#447799" } }).toFormat(format).toBuffer();
  const json = protocol === "google" ? { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ inlineData: { mimeType: "image/jpeg", data: output.toString("base64") } }] } }], responseId: "owned-google" } : { created: 1, data: [{ b64_json: output.toString("base64") }] };
  const send = mock(async () => ({ status: 200, contentType: "application/json", requestId: "owned-id", body: Buffer.from(JSON.stringify(json)) }));
  const reconstructionOptions = { reconstructionEnabled: true as const, startEnabled: true as const, responseHandlingEnabled: true as const, leasePolicy: gate, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, clock: f.clock };
  reconstruction = options.productionStartOnly ? new ProductionImageTaskReconstruction(reconstructionOptions) : new ImageProductionReconstructionHarness({ ...reconstructionOptions, fixtureTransport: { kind: "contract-fixture", realExecutionEnabled: false, send } });
  const artifactOptions = { artifactHandlingEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, clock: f.clock, runAuthorizer: auth, providerAuthorizer: auth, assetAuthorizer: auth };
  artifacts = new ImageProductionArtifactHarness(options.enabled === false ? undefined : artifactOptions);
  const publicPreparation = preparations.createPreparation(principal, { projectId: "project-a", idempotencyKey: options.actionId ?? "owned-artifact-action", connectionId: config.id, connectionRevision: 1, model: model.model, capabilityVersion: model.version,
    constraintSnapshotId: "constraint-a", protection: "none", operation: options.edit ? "edit" : "generate", inputAssetIds: options.edit ? ["source"] : [], parameters: { prompt: "人工原构图", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", background: "auto", outputFormat: format } });
  const preparation = f.store.loadProductionImagePreparation(principal.tenantId, "project-a", options.productionStartOnly ? "production" : "production-contract-fixture", publicPreparation.id)!;
  const b = (await preparations.confirmPreparation(principal, "project-a", preparation.id, productionExpected(preparation))).aggregate;
  const l = f.kernel.claimProductionImageBatch(principal, "project-a", b.batch.id, { workerId: "owned-worker", maxJobs: 1 }).leases[0];
  const args = [principal, "project-a", b.batch.id, l.jobId, { workerId: l.workerId, leaseId: l.leaseId }] as const;
  if (options.productionStartOnly) { await reconstruction.start(...args); f.advance(30_000); f.kernel.reconcileProductionImageBatch(principal, "project-a", b.batch.id); }
  else await reconstruction.executeFixture(...args);
  const saved = () => f.store.load()!.batches.find(s => s.aggregate.batch.id === b.batch.id)!;
  return { f, config, price, preparations, preparation, artifacts, artifactOptions, kernelOptions, auth, output, send, args, saved, denied, revoke: () => { allowed = false; } };
  } catch (failure) { f.cleanup(); throw failure; }
}
