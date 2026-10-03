import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  LocalRunCatalogSchema,
  RegisterRunContextRequestSchema,
  type CreateRunBatchRequest,
  type RegisterRunContextRequest,
} from "@canvas/contracts";
import { createApiServer } from "./index";
import { InMemoryRunKernel, RunKernelError, type RunAuthorizer } from "./runKernel";
import { FileRunKernelStateStore } from "./runKernelStore";
import { SqliteRunKernel } from "./sqliteRunKernel";
import { SqliteRunKernelStateStore, SqliteStateStoreError } from "./sqliteRunKernelStore";
import { LocalVerifiedAssets } from "./verifiedAssets";
import { LocalImageProviders } from "./imageProviders";

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

// Development-only role simulation, mock executor, no provider credentials or real multi-user authentication.
export function createLocalStudioMiddleware(directory: string) {
  const stateStore = new SqliteRunKernelStateStore(join(directory, "studio.sqlite"));
  const catalog = () => {
    const saved = stateStore.loadCatalog();
    if (!saved) throw new Error("本地项目目录未初始化");
    return saved;
  };
  const project = (projectId: string) => catalog().projects.find((item) => item.projectId === projectId);
  const token = randomUUID();
  const reviewerToken = randomUUID();
  const tenantId = "local-studio";
  const actorId = "local-designer";
  const authorizer: RunAuthorizer = {
    authenticate: (request) => request.headers.authorization === `Bearer ${token}` ? { tenantId, actorId }
      : request.headers.authorization === `Bearer ${reviewerToken}` ? { tenantId, actorId: "local-reviewer" } : null,
    allows: (principal, projectId, permission) => principal.tenantId === tenantId && Boolean(project(projectId))
      && ((principal.actorId === actorId && permission !== "run:approve-billing-overage")
        || (principal.actorId === "local-reviewer" && ["run:read", "run:approve-billing-overage"].includes(permission))),
  };
  const verifiedAssets = new LocalVerifiedAssets({ stateStore, authorizer: {
    authenticate: authorizer.authenticate,
    allows: (principal, projectId, permission) => principal.tenantId === tenantId && Boolean(project(projectId))
      && (principal.actorId === actorId || (principal.actorId === "local-reviewer" && permission === "asset:read")),
  }, findAsset: (assetTenantId, projectId, assetId) => assetTenantId === tenantId
    ? project(projectId)?.assets.find((item) => item.id === assetId) ?? null : null });
  const validateInputs = (_tenantId: string, request: CreateRunBatchRequest) => {
    const context = project(request.projectId);
    const constraint = context?.constraints.find((item) => item.id === request.constraintSnapshotId);
    if (!constraint) throw new RunKernelError(422, "run_constraint_not_found", "约束快照不属于当前项目");
    if (!constraint.lockedPaths.includes("product.pixels") || constraint.outputSpec.format === "mp4") {
      throw new RunKernelError(422, "run_constraint_unsupported", "产品精修需要锁定商品并使用图片输出");
    }
    for (const id of request.inputAssetIds) {
      const asset = context?.assets.find((item) => item.id === id);
      if (!asset || asset.kind !== "image" || asset.purpose === "mask") {
        throw new RunKernelError(422, "run_input_asset_invalid", "输入必须是当前项目的商品图片");
      }
      verifiedAssets.requireImage(_tenantId, request.projectId, id);
    }
    for (const region of constraint.editableRegions) {
      if (!region.maskAssetId) continue;
      const mask = context?.assets.find((asset) => asset.id === region.maskAssetId);
      if (!mask || mask.purpose !== "mask" || !mask.sourceAssetId || !request.inputAssetIds.includes(mask.sourceAssetId)) {
        throw new RunKernelError(422, "run_mask_source_mismatch", "蒙版必须来自所选商品图片");
      }
      verifiedAssets.requireImage(_tenantId, request.projectId, mask.id);
    }
  };
  const kernelOptions = {
    authorizer,
    budgets: [],
    validateInputs,
    maxConcurrentJobs: 2,
    providerLimits: [{ adapterId: "mock-product-retouch-v1", maxConcurrentJobs: 2, maxStartsPerWindow: 20, windowMs: 60_000 }],
    jobTimeoutMs: 10_000,
    leaseDurationMs: 30_000,
  };
  let kernel: SqliteRunKernel;
  try {
    stateStore.transaction(() => {
      // One-time import only; keep legacy JSON files untouched as recoverable originals.
      // Never fall back to them if the database is damaged or already initialized.
      if (!stateStore.loadCatalog()) {
        const catalogPath = join(directory, "catalog.json");
        stateStore.saveCatalog(existsSync(catalogPath)
          ? LocalRunCatalogSchema.parse(JSON.parse(readFileSync(catalogPath, "utf8")))
          : { schemaVersion: 1, projects: [] });
      }
      if (!stateStore.load()) {
        const saved = new FileRunKernelStateStore(join(directory, "runs.json")).load();
        if (saved) {
          // The old file belonged to one process; conservatively recover interrupted work.
          new InMemoryRunKernel({ ...kernelOptions, budgets: saved.budgets,
            stateStore: { load: () => saved, save: (next) => stateStore.save(next) } });
          if (!stateStore.load()) stateStore.save(saved);
        }
      }
      kernel = new SqliteRunKernel({ ...kernelOptions, stateStore });
      for (const { projectId } of catalog().projects) kernel.registerLocalProject({ tenantId, projectId, currency: "CNY", limitMinor: 10_000 });
    });
  } catch (error) { stateStore.close(); throw error; }
  const registerBudget = (projectId: string) => kernel.registerLocalProject({
    tenantId, projectId, currency: "CNY", limitMinor: 10_000,
  });
  const imageProviders = new LocalImageProviders({ tenantId, stateStore, runAuthorizer: authorizer,
    authorizer: { authenticate: authorizer.authenticate, allows: (principal, projectId, permission) => permission === "provider:read"
      && authorizer.allows(principal, projectId, "run:read") },
    assetAuthorizer: { authenticate: authorizer.authenticate, allows: (principal, projectId, permission) => principal.tenantId === tenantId && Boolean(project(projectId))
      && (principal.actorId === actorId || (principal.actorId === "local-reviewer" && permission === "asset:read")) },
    estimate: (_connection, _selection, at) => ({ mode: "local-fixture", evidenceRef: "local-zero-fee-preparation-v1",
      quote: { id: `fixture-quote-${randomUUID()}`, version: "local-fixture-price-v1", source: "server-price-table", currency: "CNY",
        estimatedCostMinor: 25, maxCostMinor: 25, expiresAt: new Date(Date.parse(at) + 5 * 60_000).toISOString() } }),
  }); // No automatic provider/model seeding or public management permissions.
  const api = createApiServer({ runKernel: kernel!, verifiedAssets, imageProviders });

  const registerContext = (incoming: RegisterRunContextRequest) => {
    for (const asset of incoming.assets) {
      if (asset.projectId !== incoming.projectId) throw new Error("资产项目不一致");
    }
    for (const constraint of incoming.constraints) {
      if (constraint.projectId !== incoming.projectId) throw new Error("约束项目不一致");
    }
    stateStore.transaction(() => {
      const previous = project(incoming.projectId);
      const merge = <T extends { id: string }>(old: T[], next: T[]): T[] => {
        const records = new Map(old.map((record) => [record.id, record]));
        if (new Set(next.map((record) => record.id)).size !== next.length) throw new Error("上下文编号重复");
        for (const record of next) {
          const existing = records.get(record.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("已登记上下文不可覆盖，请创建新版本");
          records.set(record.id, record);
        }
        return [...records.values()];
      };
      const merged = {
        projectId: incoming.projectId,
        assets: merge(previous?.assets ?? [], incoming.assets),
        constraints: merge(previous?.constraints ?? [], incoming.constraints),
      };
      const nextProjects = new Map(catalog().projects.map((item) => [item.projectId, item]));
      nextProjects.set(incoming.projectId, merged);
      const validated = LocalRunCatalogSchema.parse({ schemaVersion: 1, projects: [...nextProjects.values()] });
      stateStore.saveCatalog(validated);
      registerBudget(incoming.projectId);
    });
  };

  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!request.url?.startsWith("/studio-api/")) { next(); return; }
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
      || request.headers["x-canvas-local"] !== "1"
      || (origin !== undefined && origin !== `http://${host}`)
      || request.headers["sec-fetch-site"] === "cross-site") {
      json(response, 403, { error: "local_studio_origin_denied" });
      return;
    }
    if (request.url === "/studio-api/context" && request.method === "POST") {
      void (async () => {
        try {
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of request) {
            const buffer = Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > 2 * 1024 * 1024) throw new Error("上下文数据过大");
            chunks.push(buffer);
          }
          const context = RegisterRunContextRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          registerContext(context);
          json(response, 200, { projectId: context.projectId, mode: "local-mock" });
        } catch (error) {
          if (error instanceof RunKernelError && error.status === 503) json(response, 503, { error: error.code });
          else if (error instanceof SqliteStateStoreError) json(response, 503, { error: error.code });
          else json(response, 400, { error: "invalid_run_context" });
        }
      })();
      return;
    }
    request.url = request.url.slice("/studio-api".length);
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    // Only this development bridge supplies the simulated reviewer identity for explicit review actions.
    const isReview = /^\/v1\/run-jobs\/[^/]+\/billing-overages\/[^/]+\/review$/.test(pathname) && request.method === "POST";
    request.headers.authorization = `Bearer ${isReview ? reviewerToken : token}`;
    api.emit("request", request, response);
  };
  return Object.assign(middleware, { close: () => stateStore.close() });
}
