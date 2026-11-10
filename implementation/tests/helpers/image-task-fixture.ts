import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageProviderConnectionSchema, VerifiedImageSchema, type Asset, type ImageProviderConnection } from "../../packages/contracts/src/index";
import { LocalImageProviders } from "../../apps/api/src/imageProviders";
import { LocalImageTaskLeases } from "../../apps/api/src/imageTaskLeases";
import { createImageTaskValidator } from "../../apps/api/src/imageTaskPolicy";
import { createImageArtifactValidator } from "../../apps/api/src/imageArtifactPolicy";
import { SqliteRunKernel } from "../../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../../apps/api/src/sqliteRunKernelStore";
import { assetMetadataFingerprint } from "../../apps/api/src/verifiedAssets";
import type { RunKernelOptions, RunPermission, RunPrincipal } from "../../apps/api/src/runKernel";

export const at = "2026-10-03T18:00:00.000Z";
export const principal = { tenantId: "tenant-a", actorId: "writer" };
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
export const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
export function connection(extra: Partial<ImageProviderConnection> = {}): ImageProviderConnection {
  return ImageProviderConnectionSchema.parse({ schemaVersion: 1, id: "fixture-provider", tenantId: principal.tenantId, projectId: "project-a", name: "零费用租约夹具",
    revision: 1, protocol: "openai", adapterId: "fixture-image-v1", baseUrl: "https://never-called.invalid/v1", credentialRef: "opaque-never-resolved", enabled: true,
    diagnostic: { state: "not-run" }, models: [{ model: "explicit-fixture-model", version: "caps-fixture-v1", operations: ["generate", "edit"], inputMimeTypes: ["image/png"],
      outputFormats: ["png"], maxInputImages: 20, maxPromptCharacters: 32000, maxInputEdge: 8192, maxInputPixels: 16000000, maxInputBytes: 30 * 1024 * 1024,
      maxTotalInputBytes: 100 * 1024 * 1024, sizes: { allowAuto: true, presets: [{ width: 1024, height: 1024 }] }, qualities: ["auto"], backgrounds: ["auto"], inputFidelities: [],
      supportsOutputCompression: false, mask: { mode: "none", polarity: "unsupported" }, evidence: { state: "declared" } }], ...extra });
}
export function setupImageTask(options: { path?: string; policy?: boolean; quota?: number; format?: "png" | "jpeg"; kernel?: Partial<RunKernelOptions>; productionResponses?: true; productionArtifacts?: true } = {}) {
  const directory = options.path ? undefined : mkdtempSync(join(tmpdir(), "canvas-image-lease-"));
  const path = options.path ?? join(directory!, "state.sqlite");
  const store = new SqliteRunKernelStateStore(path, { productionResponseStorageEnabled: options.productionResponses, productionArtifactStorageEnabled: options.productionArtifacts });
  if (!store.loadCatalog()) store.transaction(() => store.saveCatalog({ schemaVersion: 1, projects: [{ projectId: "project-a", assets: [], constraints: [{
    id: "constraint-a", projectId: "project-a", lockedPaths: [], editableRegions: [], brandRules: { style: "人工冻结构图" },
    outputSpec: { width: 1024, height: 1024, format: options.format ?? "png" }, createdAt: at,
  }] }] }));
  let now = Date.parse(at), providerAllowed = true, assetAllowed = true;
  const denied = new Set<RunPermission>();
  const scope = (actor: RunPrincipal, id: string) => actor.tenantId === principal.tenantId && ["writer", "other", "reviewer"].includes(actor.actorId) && id === "project-a";
  const authenticate = (request: { headers: { authorization?: string } }) => request.headers.authorization === "Bearer writer" ? principal : null;
  const runAuthorizer = { authenticate, allows: (actor: RunPrincipal, id: string, permission: RunPermission) => !denied.has(permission) && scope(actor, id) };
  const assetAuthorizer = { authenticate, allows: (actor: RunPrincipal, id: string) => assetAllowed && scope(actor, id) };
  const authorizer = { authenticate, allows: (actor: RunPrincipal, id: string) => providerAllowed && scope(actor, id) };
  const clock = () => now;
  const kernel = new SqliteRunKernel({ stateStore: store, authorizer: runAuthorizer,
    budgets: [{ tenantId: principal.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }], clock,
    ...(options.policy === false ? {} : { validateImageTask: createImageTaskValidator({ tenantId: principal.tenantId, stateStore: store, providerAuthorizer: authorizer, assetAuthorizer, maxMetadataBytes: options.quota }),
      validateImageArtifact: createImageArtifactValidator({ tenantId: principal.tenantId, stateStore: store, providerAuthorizer: authorizer, assetAuthorizer, maxMetadataBytes: options.quota }) }),
    ...options.kernel });
  const service = new LocalImageProviders({ tenantId: principal.tenantId, stateStore: store, authorizer, assetAuthorizer, runAuthorizer, runKernel: kernel, clock,
    estimate: (_config, _request, time) => ({ mode: "local-fixture", evidenceRef: "no-real-price-or-call", quote: {
      id: "fixture-quote", version: "price-fixture-v1", source: "server-price-table", currency: "CNY", estimatedCostMinor: 25, maxCostMinor: 30,
      expiresAt: new Date(Date.parse(time) + 60_000).toISOString(),
    } }) });
  const leases = new LocalImageTaskLeases({ stateStore: store, runKernel: kernel, clock });
  const register = (config = connection()) => service.registerRevision(principal, config, config.revision - 1);
  const confirm = async (id = "human-action-a", extra: Record<string, unknown> = {}) => {
    const prepared = service.createPreparation(principal, { projectId: "project-a", idempotencyKey: id, connectionId: "fixture-provider", connectionRevision: 1,
      model: "explicit-fixture-model", capabilityVersion: "caps-fixture-v1", constraintSnapshotId: "constraint-a", protection: "none", operation: "generate", inputAssetIds: [],
      parameters: { prompt: "人工指定构图", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", background: "auto", outputFormat: options.format ?? "png" }, ...extra });
    return (await service.confirmPreparation(principal, "project-a", prepared.id, { expectedSnapshotFingerprint: prepared.snapshotFingerprint,
      expectedEstimatedCostMinor: 25, expectedMaxCostMinor: 30, expectedCurrency: "CNY" })).aggregate;
  };
  const source = (id = "source") => {
    const asset: Asset = { id, projectId: "project-a", kind: "image", purpose: "source", originalName: `${id}.png`, storageKey: `local-verified:${id}`,
      mimeType: "image/png", byteSize: png.length, width: 1, height: 1, contentFingerprint: `sha256:${sha(png)}`, createdAt: at };
    const receipt = VerifiedImageSchema.parse({ schemaVersion: 1, id: `proof-${id}`, tenantId: principal.tenantId, asset, checksumSha256: sha(png),
      registeredMetadataSha256: assetMetadataFingerprint(asset), decoder: "sharp-full-decode-v1", verifiedAt: at, verifiedBy: "trusted-fixture" });
    store.transaction(() => { store.saveVerifiedImage(receipt, png); const catalog = store.loadCatalog()!; catalog.projects[0].assets.push(asset); store.saveCatalog(catalog); });
  };
  return { store, path, kernel, service, leases, assetAuthorizer, register, confirm, source, clock, advance: (ms: number) => { now += ms; },
    revokeProvider: () => { providerAllowed = false; }, revokeAsset: () => { assetAllowed = false; }, denyRun: (permission: RunPermission) => denied.add(permission),
    cleanup: () => { store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); } };
}
