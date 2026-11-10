import { Resolver, type RecordWithTtl } from "node:dns";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { checkServerIdentity, type ConnectionOptions, type TLSSocket } from "node:tls";
import { ImageEgressContractError, canonicalImageEgressAddress, isAllowedImageEgressAddress, isImageEgressDomain,
  parseImageEgressEndpoint, rejectImageEgress as reject } from "./imageEgressPolicy";
import { raceImageEgressAbort, readBoundedImageEgressResponse, type ImageCredentialScope } from "./imageEgressContract";
import { imagePayloadSha256, MAX_IMAGE_PROTOCOL_REQUEST_BYTES } from "./imageRequestPayload";
import { MAX_IMAGE_PROTOCOL_RESPONSE_BYTES, type ImageProtocolResponse } from "./imageProtocolResponse";

type ResolverDriver = {
  resolve4(hostname: string, options: { ttl: true }, callback: (error: NodeJS.ErrnoException | null, records: RecordWithTtl[]) => void): void;
  resolve6(hostname: string, options: { ttl: true }, callback: (error: NodeJS.ErrnoException | null, records: RecordWithTtl[]) => void): void;
  cancel(): void;
};
type Drivers = {
  createResolver(options: { timeout: number; tries: number }): ResolverDriver;
  request(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest;
};
export type ImageNetworkLocalDrivers = Drivers & { mode: "local-driver"; realExecutionEnabled: false };
export type NativeImageNetworkOptions = {
  networkEnabled: true; tenantId: string; allowedTargets: ReadonlyArray<{ hostname: string; port: number }>;
  additionalDeniedAddresses?: readonly string[];
  // Trusted synchronous server policy, NOT a caller/browser confirmation flag.
  // Integration must prove actual production task/lease/quote/input permission.
  authorize(scope: ImageCredentialScope, phase: "before-dns" | "before-connect" | "before-write"): boolean;
  timeoutMs?: number; maxRequestBytes?: number; maxResponseBytes?: number; clock?: () => number;
};
export type NativeImageNetworkInput = {
  scope: ImageCredentialScope; endpointUrl: string; body: Buffer; headers: Readonly<Record<string, string>>;
};
const nativeDrivers: Drivers = { createResolver: options => new Resolver(options), request: (options, callback) => httpsRequest(options, callback) };
const allowedErrors = new Set(["url_invalid", "configuration_invalid", "not_configured", "network_consumed", "capacity", "request_too_large", "payload_mismatch",
  "request_headers_invalid", "permission_denied", "target_not_allowed", "dns_rejected", "dns_expired", "dns_failed", "cancelled", "network_failed",
  "response_invalid", "response_headers_invalid", "redirect_rejected", "response_encoding_invalid", "response_too_large", "response_chunks_invalid", "response_length_mismatch"].map(code => `image_egress_${code}`));
let activeNetworks = 0;

// Actual native implementation; default closed, no credential reader or HTTP
// route. A transport primitive, not a production Worker or task authorization.
export class NativeImageNetworkClient {
  private readonly core: NetworkCore;
  constructor(options?: NativeImageNetworkOptions) { this.core = new NetworkCore(options, nativeDrivers); }
  send(input: NativeImageNetworkInput, signal: AbortSignal) { return this.core.send(input, signal); }
}
// Local-only alternative constructor. No fake/native mode relabeling and no
// injected request/CA/lookup options accepted by NativeImageNetworkClient.
export class ImageNetworkDriverHarness {
  private readonly core: NetworkCore;
  readonly realExecutionEnabled = false;
  constructor(options: NativeImageNetworkOptions, drivers: ImageNetworkLocalDrivers) {
    if (drivers?.mode !== "local-driver" || drivers.realExecutionEnabled !== false) reject("image_egress_configuration_invalid");
    this.core = new NetworkCore(options, drivers);
  }
  send(input: NativeImageNetworkInput, signal: AbortSignal) { return this.core.send(input, signal); }
}

class NetworkCore {
  private used = false;
  private readonly options?: NativeImageNetworkOptions;
  constructor(options: NativeImageNetworkOptions | undefined, private readonly drivers: Drivers) {
    if (!options) return;
    const limits = [options.timeoutMs ?? 5000, options.maxRequestBytes ?? MAX_IMAGE_PROTOCOL_REQUEST_BYTES, options.maxResponseBytes ?? MAX_IMAGE_PROTOCOL_RESPONSE_BYTES];
    if (options.networkEnabled !== true || !/^[A-Za-z0-9_.:-]{1,160}$/.test(options.tenantId) || typeof options.authorize !== "function"
      || !Array.isArray(options.allowedTargets) || !options.allowedTargets.length || options.allowedTargets.length > 100
      || options.allowedTargets.some(target => !target || !isImageEgressDomain(target.hostname) || !Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535)
      || limits.some(limit => !Number.isSafeInteger(limit) || limit < 1) || limits[0] > 30000 || limits[1] > MAX_IMAGE_PROTOCOL_REQUEST_BYTES || limits[2] > MAX_IMAGE_PROTOCOL_RESPONSE_BYTES
      || options.additionalDeniedAddresses && (!Array.isArray(options.additionalDeniedAddresses) || options.additionalDeniedAddresses.length > 1024)
      || options.clock !== undefined && typeof options.clock !== "function" || typeof drivers.createResolver !== "function" || typeof drivers.request !== "function") reject("image_egress_configuration_invalid");
    this.options = { ...options, allowedTargets: options.allowedTargets.map(target => ({ ...target })),
      additionalDeniedAddresses: options.additionalDeniedAddresses?.map(canonicalImageEgressAddress) };
  }
  async send(input: NativeImageNetworkInput, signal: AbortSignal): Promise<ImageProtocolResponse> {
    if (!this.options) reject("image_egress_not_configured");
    if (this.used) reject("image_egress_network_consumed"); this.used = true;
    if (!(signal instanceof AbortSignal)) reject("image_egress_configuration_invalid");
    if (activeNetworks >= 2) reject("image_egress_capacity"); activeNetworks++;
    const options = this.options, clock = options.clock ?? Date.now; let start = 0;
    const local = new AbortController(), abort = AbortSignal.any([signal, local.signal, AbortSignal.timeout(options.timeoutMs ?? 5000)]);
    const pending = new Set<Promise<unknown>>();
    const track = <T>(work: Promise<T>) => { const item = Promise.resolve(work).finally(() => pending.delete(item)); pending.add(item); return item; };
    let body: Buffer | undefined, headers: Record<string, string> | undefined, resolver: ResolverDriver | undefined, req: ClientRequest | undefined,
      response: IncomingMessage | undefined, agent: Agent | undefined;
    const destroy = () => { for (const close of [() => resolver?.cancel(), () => response?.destroy(), () => req?.destroy(), () => agent?.destroy()]) { try { close(); } catch { /* Trusted-driver failure must not leak or skip other cleanup. */ } } };
    try {
      start = clock(); if (!Number.isFinite(start)) reject("image_egress_configuration_invalid");
      const now = () => { const value = clock(); if (!Number.isFinite(value) || value < start) reject("image_egress_cancelled"); return value; };
      const scope = structuredClone(input.scope), target = parseImageEgressEndpoint(input.endpointUrl);
      validateScope(scope, options.tenantId);
      if (!Buffer.isBuffer(input.body) || !input.body.length || input.body.length > (options.maxRequestBytes ?? MAX_IMAGE_PROTOCOL_REQUEST_BYTES)) reject("image_egress_request_too_large");
      body = Buffer.from(input.body); if (imagePayloadSha256(body) !== scope.payloadChecksumSha256) reject("image_egress_payload_mismatch");
      headers = requestHeaders(input.headers, body.length);
      headers.host = target.hostname + (target.port === 443 ? "" : `:${target.port}`); headers.connection = "close";
      const guard = (phase: "before-dns" | "before-connect" | "before-write") => {
        if (abort.aborted) reject("image_egress_cancelled"); now();
        const decision: unknown = options.authorize(structuredClone(scope), phase);
        if (decision instanceof Promise) void decision.catch(() => undefined);
        if (decision !== true) reject("image_egress_permission_denied");
        if (abort.aborted) reject("image_egress_cancelled");
        if (!options.allowedTargets.some(item => item.hostname === target.hostname && item.port === target.port)) reject("image_egress_target_not_allowed");
      };
      guard("before-dns");
      // c-ares DNS, not OS lookup/hosts. One resolver, one query per family; one
      // try per configured name server (not a promise of one DNS packet total).
      resolver = this.drivers.createResolver({ timeout: options.timeoutMs ?? 5000, tries: 1 });
      abort.addEventListener("abort", destroy, { once: true });
      if (abort.aborted) reject("image_egress_cancelled");
      const resolvedAt = now();
      const records = (await raceImageEgressAbort(track(Promise.all([resolveFamily(resolver, target.hostname, 4, track), resolveFamily(resolver, target.hostname, 6, track)])), abort)).flat();
      if (!records.length || records.length > 32 || records.some(record => !record || !Number.isSafeInteger(record.ttl) || record.ttl < 1 || record.ttl > 0xffffffff
        || !isAllowedImageEgressAddress(record.address, record.family) || options.additionalDeniedAddresses?.includes(canonicalImageEgressAddress(record.address)))) reject("image_egress_dns_rejected");
      const expiry = resolvedAt + Math.min(30000, ...records.map(record => record.ttl * 1000)), pinned = { ...records[0] };
      guard("before-connect"); if (now() < resolvedAt || now() >= expiry) reject("image_egress_dns_expired");
      // Private disposable agent: no global proxy, pool or TLS session cache.
      // Empty proxyEnv explicitly excludes environment-based proxy inheritance.
      agent = new Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1, maxCachedSessions: 0, proxyEnv: {} });
      let lookupUsed = false;
      const requestOptions: RequestOptions & Pick<ConnectionOptions, "ALPNProtocols"> & { autoSelectFamily: false } = { protocol: "https:", hostname: target.hostname, port: target.port, path: target.path, method: "POST", headers,
        agent, family: pinned.family, autoSelectFamily: false, servername: target.hostname, rejectUnauthorized: true,
        checkServerIdentity, minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"], maxHeaderSize: 16 * 1024, insecureHTTPParser: false,
        lookup: (hostname, _options, callback) => {
          // Fixed address only; reject fallback/repeated lookup/expiry. No DNS
          // resolution or address cycling is allowed inside socket creation.
          try {
            if (lookupUsed || hostname !== target.hostname) reject("image_egress_dns_rejected"); lookupUsed = true;
            guard("before-connect"); if (now() < resolvedAt || now() >= expiry) reject("image_egress_dns_expired");
            callback(null, pinned.address, pinned.family);
          } catch { callback(new ImageEgressContractError("image_egress_dns_rejected"), "", 0); }
        } };
      const incoming = track(new Promise<IncomingMessage>((resolve, rejectPromise) => {
        req = this.drivers.request(requestOptions, value => { response = value; resolve(value); });
        req.maxHeadersCount = 0; // Never silently truncate headers before validation.
        const closed = new Promise<void>(resolveClose => req!.once("close", resolveClose)); void track(closed);
        req.on("error", () => rejectPromise(new ImageEgressContractError(abort.aborted ? "image_egress_cancelled" : "image_egress_network_failed")));
        req.once("upgrade", (_value, socket) => { socket.destroy(); rejectPromise(new ImageEgressContractError("image_egress_response_invalid")); });
        req.once("connect", (_value, socket) => { socket.destroy(); rejectPromise(new ImageEgressContractError("image_egress_response_invalid")); });
        req.once("socket", socket => {
          const tls = socket as TLSSocket;
          if (tls.encrypted !== true) { rejectPromise(new ImageEgressContractError("image_egress_network_failed")); req?.destroy(); return; }
          // No HTTP headers/body queued until certificate-verified TLS completes
          // and final policy/TTL recheck passes. No reused sockets from a pool.
          tls.once("secureConnect", () => {
            try {
              guard("before-write"); if (tls.authorized !== true) reject("image_egress_network_failed");
              if (now() < resolvedAt || now() >= expiry) reject("image_egress_dns_expired");
              req!.end(body); // One write; no redirect/retry/SDK/artifact GET.
            } catch (error) { rejectPromise(error); req?.destroy(); }
          });
        });
      }));
      response = await raceImageEgressAbort(incoming, abort);
      const responseHeaders = rawResponseHeaders(response);
      const result = await readBoundedImageEgressResponse({ status: response.statusCode ?? 0, headers: responseHeaders, body: response }, abort, options.maxResponseBytes ?? MAX_IMAGE_PROTOCOL_RESPONSE_BYTES, track);
      if (!response.complete || response.rawTrailers.length) { result.body.fill(0); reject("image_egress_response_invalid"); }
      return result;
    } catch (error) {
      if (error instanceof ImageEgressContractError && allowedErrors.has(error.code)) return reject(error.code);
      return reject(abort.aborted ? "image_egress_cancelled" : "image_egress_network_failed");
    } finally {
      abort.removeEventListener("abort", destroy); local.abort(); destroy(); body?.fill(0);
      if (headers) for (const name of Object.keys(headers)) delete headers[name];
      // A non-cooperating local driver keeps the shared slot until its tracked
      // DNS/iterator/request close settles. Native cancel/destroy closes these.
      if (pending.size) void Promise.allSettled([...pending]).then(() => { activeNetworks--; }); else activeNetworks--;
    }
  }
}

function validateScope(scope: ImageCredentialScope, tenantId: string) {
  if (!scope || scope.tenantId !== tenantId || [scope.tenantId, scope.projectId, scope.actorId, scope.connectionId, scope.credentialRef].some(value => typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value))
    || !Number.isSafeInteger(scope.connectionRevision) || scope.connectionRevision < 1 || !/^[a-f0-9]{64}$/.test(scope.requestFingerprint) || !/^[a-f0-9]{64}$/.test(scope.payloadChecksumSha256)) reject("image_egress_permission_denied");
}
function requestHeaders(input: Readonly<Record<string, string>>, length: number) {
  if (!input || typeof input !== "object") reject("image_egress_request_headers_invalid");
  const headers: Record<string, string> = {}, authNames = ["authorization", "x-api-key", "api-key", "x-access-token", "x-goog-api-key"];
  for (const [name, value] of Object.entries(input)) {
    if (!["content-type", "content-length", "accept", "accept-encoding", ...authNames].includes(name) || typeof value !== "string" || !value.length || value.length > 4103 || /[^\x20-\x7e]/.test(value)) reject("image_egress_request_headers_invalid");
    headers[name] = value;
  }
  if (Object.keys(headers).length !== 5 || authNames.filter(name => headers[name] !== undefined).length !== 1 || headers["content-length"] !== String(length)
    || headers.accept !== "application/json" || headers["accept-encoding"] !== "identity"
    || !(headers["content-type"] === "application/json" || /^multipart\/form-data; boundary=canvas-[a-f0-9]{40}$/.test(headers["content-type"] ?? ""))
    || authNames.some(name => headers[name] !== undefined && !(name === "authorization" ? /^Bearer [\x21-\x7e]{1,4096}$/.test(headers[name]) : /^[\x21-\x7e]{1,4096}$/.test(headers[name])))) reject("image_egress_request_headers_invalid");
  return headers;
}
function resolveFamily(resolver: ResolverDriver, hostname: string, family: 4 | 6, track: <T>(work: Promise<T>) => Promise<T>) {
  return track(new Promise<Array<RecordWithTtl & { family: 4 | 6 }>>((resolve, rejectPromise) => {
    resolver[family === 4 ? "resolve4" : "resolve6"](hostname, { ttl: true }, (error, records) => {
      if (error) { if (error.code === "ENODATA") resolve([]); else rejectPromise(new ImageEgressContractError("image_egress_dns_failed")); return; }
      if (!Array.isArray(records) || records.length > 32) { rejectPromise(new ImageEgressContractError("image_egress_dns_rejected")); return; }
      resolve(records.map(record => ({ ...record, family })));
    });
  }));
}
function rawResponseHeaders(response: IncomingMessage) {
  const raw = response.rawHeaders, headers: Record<string, string> = {};
  if (!Array.isArray(raw) || raw.length % 2 || raw.length > 200 || raw.reduce((sum, part) => sum + Buffer.byteLength(part), 0) > 16 * 1024) reject("image_egress_response_headers_invalid");
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase(), value = raw[i + 1];
    if (!/^[a-z0-9-]+$/.test(name) || /[^\x20-\x7e]/.test(value) || Object.hasOwn(headers, name)) reject("image_egress_response_headers_invalid");
    headers[name] = value;
  }
  return headers;
}
