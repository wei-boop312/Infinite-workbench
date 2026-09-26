import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MockRunRequestSchema } from "@canvas/contracts";
import { executeMockRun } from "@canvas/testing";

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.byteLength;
    if (received > MAX_BODY_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createApiServer() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { ok: true, mode: "phase-0", realExecutorsEnabled: false });
      return;
    }

    if (request.method === "POST" && request.url === "/v1/mock-runs") {
      try {
        const input = MockRunRequestSchema.parse(await readJson(request));
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
    console.log(`Phase 0 API listening on http://127.0.0.1:${port}`);
  });
}

