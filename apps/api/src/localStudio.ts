import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

// Development-only role simulation, mock executor, no provider credentials or real multi-user authentication.
export function createLocalStudioMiddleware(directory: string) {
  const catalogPath = join(directory, "catalog.json");
  const catalog = existsSync(catalogPath)
    ? LocalRunCatalogSchema.parse(JSON.parse(readFileSync(catalogPath, "utf8")))
    : LocalRunCatalogSchema.parse({ schemaVersion: 1, projects: [] });
  const projects = new Map(catalog.projects.map((project) => [project.projectId, project]));
  const token = randomUUID();
  const reviewerToken = randomUUID();
  const tenantId = "local-studio";
  const actorId = "local-designer";
  const authorizer: RunAuthorizer = {
    authenticate: (request) => request.headers.authorization === `Bearer ${token}` ? { tenantId, actorId }
      : request.headers.authorization === `Bearer ${reviewerToken}` ? { tenantId, actorId: "local-reviewer" } : null,
    allows: (principal, projectId, permission) => principal.tenantId === tenantId && projects.has(projectId)
      && ((principal.actorId === actorId && permission !== "run:approve-billing-overage")
        || (principal.actorId === "local-reviewer" && ["run:read", "run:approve-billing-overage"].includes(permission))),
  };
  const stateStore = new FileRunKernelStateStore(join(directory, "runs.json"));
  const saved = stateStore.load();
  const validateInputs = (_tenantId: string, request: CreateRunBatchRequest) => {
    const context = projects.get(request.projectId);
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
    }
    for (const region of constraint.editableRegions) {
      if (!region.maskAssetId) continue;
      const mask = context?.assets.find((asset) => asset.id === region.maskAssetId);
      if (!mask || mask.purpose !== "mask" || !mask.sourceAssetId || !request.inputAssetIds.includes(mask.sourceAssetId)) {
        throw new RunKernelError(422, "run_mask_source_mismatch", "蒙版必须来自所选商品图片");
      }
    }
  };
  const kernel = new InMemoryRunKernel({
    authorizer,
    budgets: saved?.budgets ?? [],
    stateStore,
    validateInputs,
    maxConcurrentJobs: 2,
    providerLimits: [{ adapterId: "mock-product-retouch-v1", maxConcurrentJobs: 2, maxStartsPerWindow: 20, windowMs: 60_000 }],
    jobTimeoutMs: 10_000,
    leaseDurationMs: 30_000,
  });
  const registerBudget = (projectId: string) => kernel.registerLocalProject({
    tenantId, projectId, currency: "CNY", limitMinor: 10_000,
  });
  for (const projectId of projects.keys()) registerBudget(projectId);
  const api = createApiServer({ runKernel: kernel });

  const registerContext = (incoming: RegisterRunContextRequest) => {
    for (const asset of incoming.assets) {
      if (asset.projectId !== incoming.projectId) throw new Error("资产项目不一致");
    }
    for (const constraint of incoming.constraints) {
      if (constraint.projectId !== incoming.projectId) throw new Error("约束项目不一致");
    }
    const previous = projects.get(incoming.projectId);
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
    const nextProjects = new Map(projects);
    nextProjects.set(incoming.projectId, merged);
    const validated = LocalRunCatalogSchema.parse({ schemaVersion: 1, projects: [...nextProjects.values()] });
    mkdirSync(directory, { recursive: true });
    const temporaryPath = join(directory, `.catalog-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, JSON.stringify(validated), { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, catalogPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    projects.set(incoming.projectId, merged);
    registerBudget(incoming.projectId);
  };

  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
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
        } catch {
          json(response, 400, { error: "invalid_run_context" });
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
}
