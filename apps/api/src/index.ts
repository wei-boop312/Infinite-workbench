import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MockRunRequestSchema } from "@canvas/contracts";
import type { CanvasDocument } from "@canvas/contracts";
import { migrateCanvasDocument } from "@canvas/canvas-schema";
import { executeMockRun } from "@canvas/testing";

const MAX_RUN_BODY_BYTES = 64 * 1024;
const MAX_CANVAS_BODY_BYTES = 2 * 1024 * 1024;

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

export function createApiServer() {
  const documents = new Map<string, CanvasDocument>();

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { ok: true, mode: "phase-1", realExecutorsEnabled: false });
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
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
    console.log(`Phase 1 API listening on http://127.0.0.1:${port}`);
  });
}
