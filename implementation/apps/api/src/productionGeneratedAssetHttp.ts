import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { ProductionGeneratedAssetLineageSchema, ProductionGeneratedAssetMetadataSchema } from "@canvas/contracts";
import { RunKernelError } from "./runKernel";
import { imageMagicMime } from "./staticImageDecoder";
import { acquireGeneratedTransfer } from "./generatedTransferSlots";
import type { ProductionGeneratedAssetReadPort } from "./productionGeneratedAssetReads";

const headers = { "cache-control": "private, no-store", "vary": "Authorization", "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin", "referrer-policy": "no-referrer" };
function send(response: ServerResponse, status: number, error: string) {
  response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ error }));
}
const known = new Set(["production_generated_asset_not_found", "production_generated_asset_not_configured", "production_generated_asset_configuration_invalid",
  "production_generated_asset_lineage_not_configured", "production_generated_asset_unavailable"]);
// Only explicit server injection. No daily routes or execution/write policy.
export function handleProductionGeneratedAssetHttp(request: IncomingMessage, response: ServerResponse, port?: ProductionGeneratedAssetReadPort): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1"), match = url.pathname.match(/^\/v1\/projects\/([^/]+)\/production-generated-assets\/([^/]+)\/(lineage|content)$/);
  if (!match) return false;
  let cleanup: (() => void) | undefined;
  try {
    if (!port) { send(response, 404, "not_found"); return true; }
    const principal = port.authenticate(request);
    if (!principal || typeof principal !== "object" || "then" in principal || typeof principal.tenantId !== "string" || typeof principal.actorId !== "string") {
      if (principal && "then" in Object(principal)) void Promise.resolve(principal).catch(() => undefined);
      send(response, 401, "production_generated_asset_authentication_required"); return true;
    }
    const project = decodeURIComponent(match[1]), asset = decodeURIComponent(match[2]);
    if (![project, asset].every(v => /^[A-Za-z0-9._:-]{1,160}$/.test(v)) || url.search || request.headers["transfer-encoding"]
      || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") || request.headers["content-encoding"] !== undefined) {
      response.setHeader("connection", "close"); send(response, 400, "production_generated_asset_request_invalid"); return true;
    }
    if (request.headers.range !== undefined) { send(response, 416, "production_generated_asset_range_not_supported"); return true; }
    if (request.method !== "GET") { response.setHeader("allow", "GET"); send(response, 405, "production_generated_asset_method_not_allowed"); return true; }
    const release = acquireGeneratedTransfer();
    if (!release) { send(response, 429, "production_generated_asset_read_busy"); return true; }
    let owned: Buffer | undefined, borrowed: Buffer | undefined;
    const started = performance.now();
    const current = () => { if (request.aborted || response.destroyed || performance.now() - started >= 30_000) throw new Error(); };
    const deadline = setTimeout(() => response.destroy(), 30_000); deadline.unref();
    cleanup = () => { clearTimeout(deadline); owned?.fill(0); borrowed?.fill(0); release(); };
    response.once("finish", cleanup); response.once("close", cleanup);
    current();
    if (match[3] === "lineage") {
      const view = ProductionGeneratedAssetLineageSchema.parse(port.lineage(principal, project, asset));
      current();
      if (view.tenantId !== principal.tenantId || view.projectId !== project || view.image.asset.id !== asset) throw new Error();
      const json = JSON.stringify(view); if (Buffer.byteLength(json) > 512 * 1024) throw new Error();
      owned = Buffer.from(json); current(); response.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8", "content-length": String(owned.length) });
    } else {
      const content = port.read(principal, project, asset); borrowed = Buffer.isBuffer(content.body) ? content.body : undefined;
      current();
      const view = ProductionGeneratedAssetMetadataSchema.parse(content.metadata);
      if (view.tenantId !== principal.tenantId || view.projectId !== project || view.image.asset.id !== asset || !borrowed
        || borrowed.length !== view.image.asset.byteSize || borrowed.length > 20 * 1024 * 1024) throw new Error();
      owned = Buffer.from(borrowed);
      if (createHash("sha256").update(owned).digest("hex") !== view.image.checksumSha256 || imageMagicMime(owned) !== view.image.asset.mimeType) throw new Error();
      current();
      response.writeHead(200, { ...headers, "content-type": view.image.asset.mimeType, "content-length": String(owned.length), "x-content-sha256": view.image.checksumSha256,
        "x-canvas-binary-version": "production-generated-image-v1", "x-canvas-image-mode": view.mode, "x-canvas-artifact-sha256": view.artifactFingerprint,
        "content-security-policy": "default-src 'none'; sandbox", "accept-ranges": "none" });
    }
    response.end(owned);
  } catch (error) {
    cleanup?.();
    if (response.headersSent) response.destroy();
    else if (error instanceof RunKernelError && known.has(error.code)) send(response, error.status, error.code);
    else send(response, error instanceof URIError ? 400 : 503, error instanceof URIError ? "production_generated_asset_request_invalid" : "production_generated_asset_unavailable");
  }
  return true;
}
