import { vi } from "vitest";
import type { ConfirmedProductionImageExecution, ImageProviderConnection } from "../../packages/contracts/src/index";
import { ImageProductionPreparationHarness, ProductionImagePreparations, type ImagePriceContext } from "../../apps/api/src/productionImagePreparations";
import { ImageProductionPublicHarness, ProductionImagePublicService } from "../../apps/api/src/productionImagePublic";
import { at, connection, principal, setupImageTask } from "./image-task-fixture";

export function productionPublicFixture(options: { protocol?: ImageProviderConnection["protocol"]; manual?: boolean; edit?: boolean; production?: boolean; cap?: number; path?: string } = {}) {
  const denied = new Set<string>(); let permitted: unknown = true, service!: ImageProductionPreparationHarness;
  const auth = { authenticate: (req: { headers: { authorization?: string } }) => req.headers.authorization === "Bearer writer" ? principal
    : req.headers.authorization === "Bearer other" ? { ...principal, actorId: "other" } : null,
    allows: (p: typeof principal, project: string, permission: string) => p.tenantId === principal.tenantId && [principal.actorId, "other"].includes(p.actorId) && project === "project-a" && !denied.has(permission) ? permitted as boolean : false };
  const f = setupImageTask({ path: options.path, productionResponses: true, productionArtifacts: true, format: options.protocol === "google" ? "jpeg" : "png", kernel: { authorizer: auth,
    validateProductionImageConfirmation: (p, e: ConfirmedProductionImageExecution) => service.authorizeConfirmation(p, e) } });
  const base = connection(), model = base.models[0], protocol = options.protocol ?? "openai";
  const config = connection({ protocol,
    ...(protocol === "openai-compatible" ? { compatibility: { version: "owned-compat", editEncoding: "multipart-image-array", responseEncoding: "images-b64-json-v1",
      auth: { scheme: "header", headerName: "x-api-key" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}),
    ...(protocol === "google" ? { baseUrl: "https://generativelanguage.googleapis.com", models: [{ ...model, maxInputImages: 14, outputFormats: ["jpeg"] }],
      googleNative: { version: "owned-google", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: model.model,
        sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] } } : {}) });
  f.register(config); if (options.edit) { f.source("source"); f.source("second"); }
  const price = { kind: options.production ? "server-pricing" : "contract-fixture", realExecutionEnabled: false,
    read: vi.fn((c: ImagePriceContext) => ({ schemaVersion: 1, scope: c.scope,
      quote: { id: "owned-price", version: "owned-v1", source: options.manual ? "manual-budget" : "server-price-table", currency: "CNY",
        maxCostMinor: options.cap ?? 40, ...(options.manual ? {} : { estimatedCostMinor: 25 }), expiresAt: new Date(f.clock() + 60_000).toISOString() },
      evidence: { ...(options.production ? { kind: options.manual ? "server-approved-budget" : "server-verified-price" } : { kind: "contract-fixture", realExecutionEnabled: false }),
        sourceRevision: "owned-table", evidenceRef: "no-real-price", checkedBy: "owned-oracle", checkedAt: c.requestedAt } })), verify: vi.fn((): unknown => true) };
  const serviceOptions = { preparationEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, authorizer: auth, runAuthorizer: auth, assetAuthorizer: auth, clock: f.clock, pricePort: price as never };
  service = options.production ? new ProductionImagePreparations(serviceOptions) : new ImageProductionPreparationHarness(serviceOptions);
  const publicOptions = { publicPreparationEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, preparations: service, runAuthorizer: auth, providerAuthorizer: auth, assetAuthorizer: auth };
  const port = options.production ? new ProductionImagePublicService(publicOptions) : new ImageProductionPublicHarness(publicOptions);
  const selection = (action = "owned-public-action") => ({ projectId: "project-a", idempotencyKey: action, connectionId: config.id, connectionRevision: 1,
    model: model.model, capabilityVersion: model.version, constraintSnapshotId: "constraint-a", protection: "none", operation: options.edit ? "edit" : "generate",
    inputAssetIds: options.edit ? ["source", "second"] : [], parameters: { prompt: "完整人工冻结构图", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", background: "auto", outputFormat: options.protocol === "google" ? "jpeg" : "png" } });
  return { ...f, auth, service, port, config, price, publicOptions, selection, at, deny: (name: string) => denied.add(name), allow: (v: unknown) => { permitted = v; } };
}
