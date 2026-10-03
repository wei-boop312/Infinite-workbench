import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ClaimRunJobsRequestSchema,
  ConfirmRunBatchRequestSchema,
  CreateRunBatchRequestSchema,
  ExecuteRunJobRequestSchema,
  MockRunRequestSchema,
  ObjectStorageGrantRequestSchema,
  ResolveBillingUnknownRequestSchema,
  RequestBillingOverageSchema,
  ReviewBillingOverageSchema,
  RetryRunJobRequestSchema,
} from "@canvas/contracts";
import type { CanvasDocument } from "@canvas/contracts";
import { migrateCanvasDocument } from "@canvas/canvas-schema";
import { executeMockRun } from "@canvas/testing";
import { ObjectStorageGatewayError, type SignedObjectGateway } from "./objectStorageGateway";
import { RunKernelError, type RunKernelPort } from "./runKernel";
import type { VerifiedAssetPort } from "./verifiedAssets";

const MAX_RUN_BODY_BYTES = 64 * 1024;
const MAX_CANVAS_BODY_BYTES = 2 * 1024 * 1024;
const MAX_STORAGE_GRANT_BODY_BYTES = 16 * 1024;

export type ApiServerOptions = {
  objectStorageGateway?: SignedObjectGateway;
  runKernel?: RunKernelPort;
  verifiedAssets?: VerifiedAssetPort;
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.byteLength;
    if (received > maxBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseExpectedRevision(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/^W\//, "").replaceAll('"', "").trim();
  const revision = Number(normalized);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

export function createApiServer(options: ApiServerOptions = {}) {
  const documents = new Map<string, CanvasDocument>();

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, {
        ok: true,
        mode: "phase-3",
        realExecutorsEnabled: false,
        imageProviderMode: "contracts-only",
        objectStorageSigningEnabled: Boolean(options.objectStorageGateway),
        runKernelEnabled: Boolean(options.runKernel),
        assetVerificationEnabled: Boolean(options.verifiedAssets),
      });
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const verificationMatch = pathname.match(/^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/verification$/);
    if (verificationMatch && ["GET", "POST"].includes(request.method ?? "")) {
      const assets = options.verifiedAssets;
      if (!assets) { sendJson(response, 503, { error: "asset_verification_not_configured" }); return; }
      const principal = assets.authenticate(request);
      if (!principal) { sendJson(response, 401, { error: "asset_authentication_required" }); return; }
      try {
        const projectId = decodeURIComponent(verificationMatch[1]);
        const assetId = decodeURIComponent(verificationMatch[2]);
        const receipt = request.method === "POST"
          ? await assets.verify(principal, projectId, assetId, request)
          : assets.get(principal, projectId, assetId);
        sendJson(response, 200, receipt);
      } catch (error) {
        if (error instanceof RunKernelError) sendJson(response, error.status, { error: error.code });
        else sendJson(response, 503, { error: "run_state_unavailable" });
      }
      return;
    }
    if (pathname === "/v1/run-batches" && request.method === "POST") {
      const kernel = options.runKernel;
      if (!kernel) {
        sendJson(response, 503, { error: "run_kernel_not_configured" });
        return;
      }
      const principal = kernel.authenticate(request);
      if (!principal) {
        sendJson(response, 401, { error: "run_authentication_required" });
        return;
      }
      try {
        const input = CreateRunBatchRequestSchema.parse(await readJson(request, MAX_RUN_BODY_BYTES));
        sendJson(response, 201, kernel.createBatch(principal, input));
      } catch (error) {
        if (error instanceof RunKernelError) {
          sendJson(response, error.status, { error: error.code });
          return;
        }
        const code = error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400;
        sendJson(response, code, { error: code === 413 ? "request_too_large" : "invalid_run_batch_request" });
      }
      return;
    }

    const runActionMatch = pathname.match(/^\/v1\/run-batches\/([^/]+)\/(confirm|cancel|dispatch|reconcile)$/);
    if (runActionMatch && request.method === "POST") {
      const kernel = options.runKernel;
      if (!kernel) {
        sendJson(response, 503, { error: "run_kernel_not_configured" });
        return;
      }
      const principal = kernel.authenticate(request);
      if (!principal) {
        sendJson(response, 401, { error: "run_authentication_required" });
        return;
      }
      try {
        const batchId = decodeURIComponent(runActionMatch[1]);
        const action = runActionMatch[2];
        if (action === "confirm") {
          const confirmation = ConfirmRunBatchRequestSchema.parse(await readJson(request, MAX_RUN_BODY_BYTES));
          sendJson(response, 200, kernel.confirmBatch(principal, batchId, confirmation));
        } else if (action === "dispatch") {
          sendJson(response, 200, kernel.dispatchBatch(principal, batchId));
        } else if (action === "reconcile") {
          sendJson(response, 200, kernel.reconcileBatch(principal, batchId));
        } else {
          sendJson(response, 200, kernel.cancelBatch(principal, batchId));
        }
      } catch (error) {
        if (error instanceof RunKernelError) {
          sendJson(response, error.status, { error: error.code });
          return;
        }
        const code = error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400;
        sendJson(response, code, { error: code === 413 ? "request_too_large" : "invalid_run_batch_action" });
      }
      return;
    }

    const claimJobsMatch = pathname.match(/^\/v1\/run-batches\/([^/]+)\/claims$/);
    if (claimJobsMatch && request.method === "POST") {
      const kernel = options.runKernel;
      if (!kernel) {
        sendJson(response, 503, { error: "run_kernel_not_configured" });
        return;
      }
      const principal = kernel.authenticate(request);
      if (!principal) {
        sendJson(response, 401, { error: "run_authentication_required" });
        return;
      }
      try {
        const input = ClaimRunJobsRequestSchema.parse(await readJson(request, MAX_RUN_BODY_BYTES));
        sendJson(response, 200, kernel.claimBatch(principal, decodeURIComponent(claimJobsMatch[1]), input));
      } catch (error) {
        if (error instanceof RunKernelError) {
          sendJson(response, error.status, { error: error.code });
          return;
        }
        const code = error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400;
        sendJson(response, code, { error: code === 413 ? "request_too_large" : "invalid_run_job_claim" });
      }
      return;
    }

    const executeJobMatch = pathname.match(/^\/v1\/run-jobs\/([^/]+)\/execute$/);
    if (executeJobMatch && request.method === "POST") {
      const kernel = options.runKernel;
      if (!kernel) {
        sendJson(response, 503, { error: "run_kernel_not_configured" });
        return;
      }
      const principal = kernel.authenticate(request);
      if (!principal) {
        sendJson(response, 401, { error: "run_authentication_required" });
        return;
      }
      try {
        const input = ExecuteRunJobRequestSchema.parse(await readJson(request, MAX_RUN_BODY_BYTES));
        sendJson(response, 200, kernel.executeLeasedJob(principal, decodeURIComponent(executeJobMatch[1]), input));
      } catch (error) {
        if (error instanceof RunKernelError) {
          sendJson(response, error.status, { error: error.code });
          return;
        }
        const code = error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400;
        sendJson(response, code, { error: code === 413 ? "request_too_large" : "invalid_run_job_execution" });
      }
      return;
    }

    const billingOverageMatch = pathname.match(/^\/v1\/run-jobs\/([^/]+)\/billing-overages(?:\/([^/]+)\/review)?$/);
    if (billingOverageMatch && request.method === "POST") {
      const kernel = options.runKernel;
      if (!kernel) { sendJson(response, 503, { error: "run_kernel_not_configured" }); return; }
      const principal = kernel.authenticate(request);
      if (!principal) { sendJson(response, 401, { error: "run_authentication_required" }); return; }
      try {
        const body = await readJson(request, MAX_RUN_BODY_BYTES);
        const jobId = decodeURIComponent(billingOverageMatch[1]);
        if (billingOverageMatch[2]) {
          sendJson(response, 200, kernel.reviewBillingOverage(principal, jobId, decodeURIComponent(billingOverageMatch[2]), ReviewBillingOverageSchema.parse(body)));
        } else {
          sendJson(response, 201, kernel.requestBillingOverage(principal, jobId, RequestBillingOverageSchema.parse(body)));
        }
      } catch (error) {
        if (error instanceof RunKernelError) sendJson(response, error.status, { error: error.code });
        else {
          const code = error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400;
          sendJson(response, code, { error: code === 413 ? "request_too_large" : "invalid_billing_overage" });
        }
      }
      return;
    }

    const resolveBillingMatch = pathname.match(/^\/v1\/run-jobs\/([^/]+)\/resolve-billing$/);
    if (resolveBillingMatch && request.method === "POST") {
      const kernel = options.runKernel;
      if (!kernel) {
        sendJson(response, 503, { error: "run_kernel_not_configured" });
        return;
      }
      const principal = kernel.authenticate(request);
      if (!principal) {
        sendJson(response, 401, { error: "run_authentication_required" });
        return;
      }
      try {
        const input = ResolveBillingUnknownRequestSchema.parse(await readJson(request, MAX_RUN_BODY_BYTES));
        sendJson(response, 200, kernel.resolveBillingUnknown(
          principal,
          decodeURIComponent(resolveBillingMatch[1]),
          input,
        ));
      } catch (error) {
        if (error instanceof RunKernelError) {
          sendJson(response, error.status, { error: error.code });
          return;
        }
        const code = error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400;
        sendJson(response, code, { error: code === 413 ? "request_too_large" : "invalid_billing_resolution" });
      }
      return;
    }

    const retryJobMatch = pathname.match(/^\/v1\/run-jobs\/([^/]+)\/retry$/);
    if (retryJobMatch && request.method === "POST") {
      const kernel = options.runKernel;
      if (!kernel) {
        sendJson(response, 503, { error: "run_kernel_not_configured" });
        return;
      }
      const principal = kernel.authenticate(request);
      if (!principal) {
        sendJson(response, 401, { error: "run_authentication_required" });
        return;
      }
      try {
        const input = RetryRunJobRequestSchema.parse(await readJson(request, MAX_RUN_BODY_BYTES));
        sendJson(response, 201, kernel.retryJob(principal, decodeURIComponent(retryJobMatch[1]), input));
      } catch (error) {
        if (error instanceof RunKernelError) {
          sendJson(response, error.status, { error: error.code });
          return;
        }
        const code = error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400;
        sendJson(response, code, { error: code === 413 ? "request_too_large" : "invalid_run_job_retry" });
      }
      return;
    }

    const runBatchMatch = pathname.match(/^\/v1\/run-batches\/([^/]+)$/);
    if (runBatchMatch && request.method === "GET") {
      const kernel = options.runKernel;
      if (!kernel) {
        sendJson(response, 503, { error: "run_kernel_not_configured" });
        return;
      }
      const principal = kernel.authenticate(request);
      if (!principal) {
        sendJson(response, 401, { error: "run_authentication_required" });
        return;
      }
      try {
        sendJson(response, 200, kernel.getBatch(principal, decodeURIComponent(runBatchMatch[1])));
      } catch (error) {
        if (error instanceof RunKernelError) sendJson(response, error.status, { error: error.code });
        else sendJson(response, 400, { error: "invalid_run_batch_request" });
      }
      return;
    }

    const projectBatchesMatch = pathname.match(/^\/v1\/projects\/([^/]+)\/run-batches$/);
    if (projectBatchesMatch && request.method === "GET") {
      const kernel = options.runKernel;
      if (!kernel) {
        sendJson(response, 503, { error: "run_kernel_not_configured" });
        return;
      }
      const principal = kernel.authenticate(request);
      if (!principal) {
        sendJson(response, 401, { error: "run_authentication_required" });
        return;
      }
      try {
        sendJson(response, 200, kernel.listBatches(principal, decodeURIComponent(projectBatchesMatch[1])));
      } catch (error) {
        if (error instanceof RunKernelError) sendJson(response, error.status, { error: error.code });
        else sendJson(response, 400, { error: "invalid_run_batch_request" });
      }
      return;
    }

    const projectBudgetMatch = pathname.match(/^\/v1\/projects\/([^/]+)\/budget$/);
    if (projectBudgetMatch && request.method === "GET") {
      const kernel = options.runKernel;
      if (!kernel) {
        sendJson(response, 503, { error: "run_kernel_not_configured" });
        return;
      }
      const principal = kernel.authenticate(request);
      if (!principal) {
        sendJson(response, 401, { error: "run_authentication_required" });
        return;
      }
      try {
        sendJson(response, 200, kernel.getBudget(principal, decodeURIComponent(projectBudgetMatch[1])));
      } catch (error) {
        if (error instanceof RunKernelError) sendJson(response, error.status, { error: error.code });
        else sendJson(response, 400, { error: "invalid_budget_request" });
      }
      return;
    }

    if (pathname === "/v1/storage/grants" && request.method === "POST") {
      const gateway = options.objectStorageGateway;
      if (!gateway) {
        sendJson(response, 503, { error: "storage_signing_not_configured" });
        return;
      }
      const principal = gateway.authenticate(request);
      if (!principal) {
        sendJson(response, 401, { error: "storage_authentication_required" });
        return;
      }
      try {
        const input = ObjectStorageGrantRequestSchema.parse(await readJson(request, MAX_STORAGE_GRANT_BODY_BYTES));
        sendJson(response, 201, gateway.issueGrant(principal, input));
      } catch (error) {
        if (error instanceof ObjectStorageGatewayError) {
          sendJson(response, error.status, { error: error.code });
          return;
        }
        const code = error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400;
        sendJson(response, code, { error: code === 413 ? "request_too_large" : "invalid_storage_grant_request" });
      }
      return;
    }

    const transferMatch = pathname.match(/^\/v1\/storage\/transfers\/([^/]+)$/);
    if (transferMatch) {
      const gateway = options.objectStorageGateway;
      if (!gateway) {
        sendJson(response, 503, { error: "storage_signing_not_configured" });
        return;
      }
      try {
        const token = decodeURIComponent(transferMatch[1]);
        if (request.method === "PUT") {
          const object = await gateway.upload(token, request);
          response.setHeader("x-object-key", object.objectKey);
          response.setHeader("x-content-sha256", object.checksumSha256);
          response.writeHead(201, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
          response.end();
          return;
        }
        if (request.method === "GET") {
          const object = gateway.download(token);
          response.writeHead(200, {
            "content-type": object.mimeType,
            "content-length": String(object.body.byteLength),
            "x-content-sha256": object.checksumSha256,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(object.body);
          return;
        }
        sendJson(response, 405, { error: "storage_transfer_method_not_allowed" });
      } catch (error) {
        if (error instanceof ObjectStorageGatewayError) {
          sendJson(response, error.status, { error: error.code });
        } else {
          sendJson(response, 400, { error: "invalid_storage_transfer" });
        }
      }
      return;
    }

    const canvasMatch = pathname.match(/^\/v1\/canvases\/([^/]+)$/);
    if (canvasMatch) {
      const documentId = decodeURIComponent(canvasMatch[1]);
      if (request.method === "GET") {
        const document = documents.get(documentId);
        if (!document) {
          sendJson(response, 404, { error: "canvas_not_found" });
          return;
        }
        response.setHeader("etag", `\"${document.revision}\"`);
        sendJson(response, 200, document);
        return;
      }

      if (request.method === "PUT") {
        const expectedRevision = parseExpectedRevision(request.headers["if-match"]);
        if (expectedRevision === null) {
          sendJson(response, 428, { error: "revision_precondition_required" });
          return;
        }

        const remote = documents.get(documentId);
        const remoteRevision = remote?.revision ?? 0;
        if (remoteRevision !== expectedRevision) {
          sendJson(response, 409, { error: "revision_conflict", remote: remote ?? null });
          return;
        }

        try {
          const input = await readJson(request, MAX_CANVAS_BODY_BYTES);
          const saved = migrateCanvasDocument({
            ...(typeof input === "object" && input !== null ? input : {}),
            id: documentId,
            revision: expectedRevision + 1,
            updatedAt: new Date().toISOString(),
          });
          documents.set(documentId, saved);
          response.setHeader("etag", `\"${saved.revision}\"`);
          sendJson(response, 200, saved);
        } catch (error) {
          const code = error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400;
          sendJson(response, code, { error: code === 413 ? "request_too_large" : "invalid_canvas_document" });
        }
        return;
      }
    }

    if (request.method === "POST" && request.url === "/v1/mock-runs") {
      try {
        const input = MockRunRequestSchema.parse(await readJson(request, MAX_RUN_BODY_BYTES));
        sendJson(response, 200, executeMockRun(input));
      } catch (error) {
        const code = error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 400;
        sendJson(response, code, { error: code === 413 ? "request_too_large" : "invalid_request" });
      }
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  });
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  const port = Number(process.env.PORT ?? 4100);
  createApiServer().listen(port, "127.0.0.1", () => {
    console.log(`Phase 3 API listening on http://127.0.0.1:${port}`);
  });
}
