import type { IncomingMessage, ServerResponse } from "node:http";
import { ConfirmProductionImagePreparationSchema, CreateImagePreparationSchema } from "@canvas/contracts";
import { RunKernelError } from "./runKernel";
import type { ProductionImagePublicPort } from "./productionImagePublic";

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "vary": "Authorization",
    "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin", "referrer-policy": "no-referrer" }); response.end(JSON.stringify(body));
}
async function json(request: IncomingMessage, limit: number) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) throw new RunKernelError(400, "production_image_public_request_invalid", "只接受JSON");
  if (request.headers["content-encoding"] !== undefined && request.headers["content-encoding"] !== "identity") throw new RunKernelError(400, "production_image_public_request_invalid", "不接受压缩正文");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new RunKernelError(413, "production_image_public_request_too_large", "请求超过上限");
  const chunks: Buffer[] = []; let bytes = 0, count = 0;
  const deadline = setTimeout(() => request.destroy(), 30_000); deadline.unref();
  try { for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); if (!part.length) continue;
    if (++count > 4096 || (bytes += part.length) > limit) throw new RunKernelError(413, "production_image_public_request_too_large", "请求超过上限"); chunks.push(part);
  } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  finally { clearTimeout(deadline); }
}
// Does not create/configure a production service. Absent injection is still404,
// including in the unchanged daily Vite bridge and default API process.
export async function handleProductionImagePublicHttp(request: IncomingMessage, response: ServerResponse, port?: ProductionImagePublicPort): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1"), match = url.pathname.match(/^\/v1\/projects\/([^/]+)\/production-image-preparations(?:\/([^/]+)(?:\/(confirm|confirmation))?)?$/);
  if (!match) return false;
  try {
    if (!port) { send(response, 404, { error: "not_found" }); return true; }
    const principal = port.authenticate(request); if (!principal) { send(response, 401, { error: "production_image_public_authentication_required" }); return true; }
    const project = decodeURIComponent(match[1]), id = match[2] ? decodeURIComponent(match[2]) : undefined, action = match[3];
    if (![project, ...(id ? [id] : [])].every(v => /^[A-Za-z0-9._:-]{1,160}$/.test(v)) || url.search || request.headers.range !== undefined) throw new RunKernelError(400, "production_image_public_request_invalid", "范围/查询/Range无效");
    const allowed = action === "confirm" || !id ? "POST" : "GET";
    if (request.method !== allowed) { response.setHeader("allow", allowed); send(response, 405, { error: "production_image_public_method_not_allowed" }); return true; }
    if (allowed === "GET" && (request.headers["transfer-encoding"] || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0"))) throw new RunKernelError(400, "production_image_public_request_invalid", "只读请求不接受正文");
    let result: unknown;
    if (!id) result = port.createPreparation(principal, project, CreateImagePreparationSchema.parse(await json(request, 128 * 1024)));
    else if (action === "confirm") result = await port.confirmPreparation(principal, project, id, ConfirmProductionImagePreparationSchema.parse(await json(request, 16 * 1024)));
    else result = action === "confirmation" ? port.getConfirmation(principal, project, id) : port.getPreparation(principal, project, id);
    if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw new RunKernelError(413, "production_image_public_response_too_large", "响应超过上限");
    send(response, id ? 200 : 201, result);
  } catch (error) {
    if (error instanceof RunKernelError) send(response, error.status, { error: error.code });
    else send(response, error instanceof URIError || error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError") ? 400 : 503,
      { error: error instanceof URIError || error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError") ? "production_image_public_request_invalid" : "production_image_public_unavailable" });
  }
  return true;
}
