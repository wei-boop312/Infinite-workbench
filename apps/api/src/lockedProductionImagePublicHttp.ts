import type { IncomingMessage, ServerResponse } from "node:http";
import { CreateImagePreparationSchema, ConfirmLockedProductionImagePreparationSchema, LockedProductionImagePreparationPublicSchema,
  LockedProductionImageConfirmationPublicSchema, LockedProductionImageConfirmationHistorySchema } from "@canvas/contracts";
import { RunKernelError } from "./runKernel";
import type { LockedProductionImagePublicPort } from "./lockedProductionImagePublic";

const headers = { "cache-control": "private, no-store", vary: "Authorization", "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin", "referrer-policy": "no-referrer" };
const known: Record<string, number> = { locked_public_not_configured: 503, locked_public_configuration_invalid: 503, locked_public_permission_denied: 403,
  locked_public_preparation_missing: 404, locked_public_response_too_large: 413, locked_public_request_invalid: 400, locked_public_unavailable: 503,
  locked_public_expired: 408, locked_public_cancelled: 499, locked_preparation_permission_denied: 403, locked_confirmation_permission_denied: 403,
  locked_preparation_idempotency_conflict: 409, locked_preparation_busy: 429, locked_confirmation_busy: 429, locked_public_request_too_large: 413 };
function fail(code = "locked_public_request_invalid", status = 400): never { throw new RunKernelError(status, code, "保护公开请求拒绝"); }
function send(response: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body); response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(json)) }); response.end(json);
}
async function json(request: IncomingMessage, limit: number, check: () => void) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")
    || request.headers["content-encoding"] !== undefined && request.headers["content-encoding"] !== "identity") fail();
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) fail("locked_public_request_too_large", 413);
  const chunks: Buffer[] = []; let bytes = 0, count = 0; let body: Buffer | undefined;
  try { for await (const chunk of request) {
    check(); const part = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk); if (!part.length) continue;
    if (++count > 4096 || (bytes += part.length) > limit) { part.fill(0); fail("locked_public_request_too_large", 413); } chunks.push(part);
  } check(); if (declared !== undefined && Number(declared) !== bytes) fail(); body = Buffer.concat(chunks);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } finally { chunks.forEach(b => b.fill(0)); body?.fill(0); }
}
// Four routes ONLY with explicit trusted service injection. No daily bridge,
// credential, attempted/raw, artifact write, billing or execution endpoint.
export async function handleLockedProductionImagePublicHttp(request: IncomingMessage, response: ServerResponse, port?: LockedProductionImagePublicPort): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1"), match = url.pathname.match(/^\/v1\/projects\/([^/]+)\/locked-production-image-preparations(?:\/([^/]+)(?:\/(confirm|confirmation))?)?$/);
  if (!match) return false;
  let cleanup: (() => void) | undefined;
  try {
    if (!port) { send(response, 404, { error: "not_found" }); return true; }
    const principal = port.authenticate(request);
    if (!principal || typeof principal !== "object" || "then" in principal || typeof principal.tenantId !== "string" || typeof principal.actorId !== "string") {
      if (principal && "then" in Object(principal)) void Promise.resolve(principal).catch(() => undefined);
      send(response, 401, { error: "locked_public_authentication_required" }); return true;
    }
    const project = decodeURIComponent(match[1]), id = match[2] ? decodeURIComponent(match[2]) : undefined, action = match[3];
    if (![project, ...(id ? [id] : [])].every(v => /^[A-Za-z0-9._:-]{1,160}$/.test(v)) || url.search || request.headers.range !== undefined) fail();
    if (request.headers.origin !== undefined && request.headers.origin !== `http://${request.headers.host}` || request.headers["sec-fetch-site"] === "cross-site") fail();
    const method = !id || action === "confirm" ? "POST" : "GET";
    if (request.method !== method) { response.setHeader("allow", method); send(response, 405, { error: "locked_public_method_not_allowed" }); return true; }
    if (method === "GET" && (request.headers["transfer-encoding"] || request.headers["content-encoding"] !== undefined
      || request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) fail();
    const controller = new AbortController(), start = performance.now(); let last = start;
    const abort = () => controller.abort(), timer = setTimeout(() => { controller.abort(); request.destroy(); response.destroy(); }, 30_000); timer.unref();
    request.once("aborted", abort); response.once("close", abort);
    cleanup = () => { clearTimeout(timer); request.off("aborted", abort); response.off("close", abort); };
    const check = () => { const t = performance.now(); if (!Number.isFinite(t) || t < last || t - start >= 30_000) fail("locked_public_expired", 408);
      last = t; if (controller.signal.aborted || request.aborted || response.destroyed) fail("locked_public_cancelled", 499); };
    const options = { signal: controller.signal }; check(); let result;
    if (!id) result = LockedProductionImagePreparationPublicSchema.parse(await port.createPreparation(principal, project, CreateImagePreparationSchema.parse(await json(request, 128 * 1024, check)), options));
    else if (action === "confirm") result = LockedProductionImageConfirmationPublicSchema.parse(await port.confirmPreparation(principal, project, id, ConfirmLockedProductionImagePreparationSchema.parse(await json(request, 16 * 1024, check)), options));
    else result = action === "confirmation" ? LockedProductionImageConfirmationHistorySchema.parse(port.getConfirmation(principal, project, id, options))
      : LockedProductionImagePreparationPublicSchema.parse(port.getPreparation(principal, project, id, options));
    check(); if (result.tenantId !== principal.tenantId || result.projectId !== project || (id && ("id" in result ? result.id : result.preparationId) !== id)) throw new Error();
    if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) fail("locked_public_response_too_large", 413); check(); send(response, id ? 200 : 201, result);
  } catch (e) {
    if (!response.destroyed) {
      if (response.headersSent) response.destroy();
      else {
        response.setHeader("connection", "close");
        if (e instanceof RunKernelError && known[e.code] !== undefined) send(response, known[e.code], { error: e.code });
        else { const invalid = e instanceof URIError || e instanceof SyntaxError || e instanceof TypeError || e instanceof Error && e.name === "ZodError";
          send(response, invalid ? 400 : 503, { error: invalid ? "locked_public_request_invalid" : "locked_public_unavailable" }); }
      }
    }
  } finally { cleanup?.(); }
  return true;
}
