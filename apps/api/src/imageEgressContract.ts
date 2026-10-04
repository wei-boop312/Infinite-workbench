import { isIP } from "node:net";
import type { ImageExecutionRequest, ImageProviderConnection } from "@canvas/contracts";
import { imageSnapshotFingerprint, validateImageProviderRequest } from "./imageProviderContract";
import { imagePayloadSha256, MAX_IMAGE_PROTOCOL_REQUEST_BYTES } from "./imageRequestPayload";
import { MAX_IMAGE_PROTOCOL_RESPONSE_BYTES, type ImageProtocolResponse } from "./imageProtocolResponse";
import type { PreparedImageProtocolRequest } from "./openaiImageProtocol";
import type { CompatibleImagePreparedRequest } from "./compatibleImageProtocol";
import type { GoogleImagePreparedRequest } from "./googleImageProtocol";
import type { RunPrincipal } from "./runKernel";
import { MAX_STATIC_IMAGE_EDGE, MAX_STATIC_IMAGE_PIXELS } from "./staticImageDecoder";

type Prepared = PreparedImageProtocolRequest | CompatibleImagePreparedRequest | GoogleImagePreparedRequest;
type Auth = { scheme: "bearer"; credentialRef: string } | { scheme: "header"; headerName: "x-api-key" | "api-key" | "x-access-token" | "x-goog-api-key"; credentialRef: string };
export type ImageCredentialScope = {
  tenantId: string; projectId: string; actorId: string; connectionId: string; connectionRevision: number;
  credentialRef: string; requestFingerprint: string; payloadChecksumSha256: string;
};
export type ImageCredentialLease = { scope: ImageCredentialScope; secret: Buffer };
// Trusted server-only ports. No environment/file/key-store reader is provided.
export type ImageCredentialPort = {
  mode: "contract-fixture"; realExecutionEnabled: false;
  withCredential<T>(scope: ImageCredentialScope, signal: AbortSignal, use: (lease: ImageCredentialLease) => Promise<T>): Promise<T>;
};
export type ImageDnsPort = {
  mode: "contract-fixture";
  resolveAll(hostname: string, signal: AbortSignal): Promise<Array<{ address: string; family: 4 | 6 }>>;
};
export type PinnedImageDestination = {
  hostname: string; port: number; path: string; address: string; family: 4 | 6;
  servername: string; rejectUnauthorized: true; redirects: "error"; retries: 0; proxy: "disabled";
};
export type ImageEgressFixtureTransport = {
  mode: "contract-fixture"; realExecutionEnabled: false;
  send(input: { destination: PinnedImageDestination; method: "POST"; headers: Readonly<Record<string, string>>; body: Buffer }, signal: AbortSignal): Promise<{
    status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array>;
  }>;
};
export class ImageEgressContractError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ImageEgressContractError"; }
}
const errorCodes = new Set(["url_invalid", "protocol_unsupported", "explicit_size_required", "dimensions_exceeded", "endpoint_mismatch", "payload_mismatch", "content_type_invalid",
  "configuration_invalid", "not_configured", "fixture_consumed", "capacity", "request_too_large", "permission_denied", "cancelled", "target_not_allowed", "dns_rejected",
  "dns_expired", "credential_reused", "credential_invalid", "response_invalid", "response_headers_invalid", "redirect_rejected", "response_encoding_invalid", "response_too_large",
  "response_chunks_invalid", "response_length_mismatch", "contract_failed"].map(code => `image_egress_${code}`));
function reject(code: string): never { throw new ImageEgressContractError(code); }
const domain = (host: string) => host.length <= 253 && host === host.toLowerCase() && host.includes(".") && !isIP(host)
  && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  && !/\.(?:localhost|local|internal|home|lan|arpa)$/.test(host);
function endpoint(input: string) {
  if (typeof input !== "string" || input.length > 2048 || !/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9/_:.-]*$/.test(input)) reject("image_egress_url_invalid");
  let url: URL; try { url = new URL(input); } catch { return reject("image_egress_url_invalid"); }
  const rawPath = input.slice(input.indexOf("/", 8));
  if (!domain(url.hostname) || url.username || url.password || url.search || url.hash || rawPath !== url.pathname
    || rawPath.includes("//") || rawPath.split("/").some(part => part === "." || part === "..")) reject("image_egress_url_invalid");
  return { hostname: url.hostname, port: Number(url.port || 443), path: url.pathname };
}
function v4(address: string) { return address.split(".").reduce((value, octet) => (value << 8n) + BigInt(octet), 0n); }
function v6(address: string) {
  const halves = address.split("::"), left = halves[0] ? halves[0].split(":") : [], right = halves[1] ? halves[1].split(":") : [];
  const parts = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return parts.reduce((value, part) => (value << 16n) + BigInt(`0x${part}`), 0n);
}
function inPrefix(value: bigint, base: bigint, prefix: number, bits: number) { return value >> BigInt(bits - prefix) === base >> BigInt(bits - prefix); }
// Conservative profile: deny ALL listed IPv4 special-purpose blocks (including
// globally reachable protocol exceptions), multicast and reserved. IPv6 admits
// only 2000::/3 minus special/transition/documentation blocks. Not a route proof.
const deniedV4 = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4], ["168.63.129.16", 32]]
  .map(([base, prefix]) => [v4(base as string), prefix as number] as const);
const deniedV6 = [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48], ["3fff::", 20]]
  .map(([base, prefix]) => [v6(base as string), prefix as number] as const);
export function isAllowedImageEgressAddress(address: string, family: 4 | 6): boolean {
  if (typeof address !== "string" || isIP(address) !== family || address.includes("%")) return false;
  if (family === 4) return !deniedV4.some(([base, prefix]) => inPrefix(v4(address), base, prefix, 32));
  // Reject dotted IPv4 embeddings as well as mapped, NAT64, ULA, link-local etc.
  if (address.includes(".")) return false;
  const value = v6(address);
  return inPrefix(value, v6("2000::"), 3, 128) && !deniedV6.some(([base, prefix]) => inPrefix(value, base, prefix, 128));
}
function bindWire(connection: ImageProviderConnection, request: ImageExecutionRequest, prepared: Prepared, now: string) {
  const checked = validateImageProviderRequest(connection, request, now);
  // The controlled egress profile has an explicit human output specification;
  // an auto-size wire cannot prove it will fit the shared asset ceiling.
  const size = checked.request.parameters.size;
  if (size === "auto") reject("image_egress_explicit_size_required");
  if (Math.max(size.width, size.height) > MAX_STATIC_IMAGE_EDGE || size.width * size.height > MAX_STATIC_IMAGE_PIXELS
    || [...checked.request.inputs, ...(checked.request.operation === "edit" && checked.request.mask ? [checked.request.mask] : [])]
      .some(input => Math.max(input.width, input.height) > MAX_STATIC_IMAGE_EDGE || input.width * input.height > MAX_STATIC_IMAGE_PIXELS)) reject("image_egress_dimensions_exceeded");
  if (connection.protocol === "custom") reject("image_egress_protocol_unsupported");
  const base = new URL(checked.connection.baseUrl);
  let path: string, auth: Auth;
  if (connection.protocol === "google") {
    const profile = connection.googleNative, model = profile?.modelMappings.find(item => item.model === request.model);
    if (!profile || !model || base.origin !== "https://generativelanguage.googleapis.com" || base.pathname !== "/") reject("image_egress_endpoint_mismatch");
    path = `/${profile.apiVersion}/models/${model.model}:generateContent`;
    auth = { scheme: "header", headerName: "x-goog-api-key", credentialRef: connection.credentialRef };
  } else {
    const operationPath = request.operation === "generate" ? "/images/generations" : "/images/edits";
    const profile = connection.compatibility;
    if (connection.protocol === "openai-compatible" && !profile) reject("image_egress_endpoint_mismatch");
    path = base.pathname.replace(/\/+$/, "") + (connection.protocol === "openai-compatible" ? profile!.endpoints[request.operation] : operationPath);
    auth = connection.protocol === "openai-compatible" ? { ...profile!.auth, credentialRef: connection.credentialRef } : { scheme: "bearer", credentialRef: connection.credentialRef };
    if (connection.protocol === "openai" && (!("path" in prepared) || prepared.path !== operationPath)) reject("image_egress_endpoint_mismatch");
  }
  const endpointUrl = `${base.origin}${path}`;
  if (connection.protocol !== "openai" && (!("endpointUrl" in prepared) || !("authPlan" in prepared))) reject("image_egress_endpoint_mismatch");
  // Check raw base before URL normalization can hide dot paths or unusual hosts.
  endpoint(connection.baseUrl.endsWith("/") ? connection.baseUrl : connection.baseUrl + "/");
  const target = endpoint(endpointUrl);
  if (("endpointUrl" in prepared && prepared.endpointUrl !== endpointUrl)
    || ("authPlan" in prepared && imageSnapshotFingerprint(prepared.authPlan) !== imageSnapshotFingerprint(auth))) reject("image_egress_endpoint_mismatch");
  if (prepared.method !== "POST" || prepared.requestFingerprint !== checked.fingerprint || !Buffer.isBuffer(prepared.body)
    || !prepared.body.length || prepared.body.length > MAX_IMAGE_PROTOCOL_REQUEST_BYTES
    || prepared.payloadChecksumSha256 !== imagePayloadSha256(prepared.body)) reject("image_egress_payload_mismatch");
  if (!(prepared.contentType === "application/json" || /^multipart\/form-data; boundary=canvas-[a-f0-9]{40}$/.test(prepared.contentType))
    || (prepared.contentType !== "application/json" && connection.protocol !== "openai-compatible")) reject("image_egress_content_type_invalid");
  return { target, auth, fingerprint: checked.fingerprint, body: Buffer.from(prepared.body), contentType: prepared.contentType };
}
type Options = {
  tenantId: string; allowedTargets: ReadonlyArray<{ hostname: string; port: number }>;
  additionalDeniedAddresses?: readonly string[];
  authorize: (scope: ImageCredentialScope) => boolean;
  dns: ImageDnsPort; credentials: ImageCredentialPort; transport: ImageEgressFixtureTransport;
  timeoutMs?: number; maxRequestBytes?: number; maxResponseBytes?: number; clock?: () => number;
};
let activeFixtures = 0;
// Explicit, ONE-SHOT trusted test harness, NOT a production sender, task lease,
// credential store or execution authorization. Never wired to the daily API.
export class ImageEgressFixtureHarness {
  private used = false;
  private readonly options?: Options;
  constructor(options?: Options) {
    if (!options) return;
    const limits = [options.timeoutMs ?? 5000, options.maxRequestBytes ?? MAX_IMAGE_PROTOCOL_REQUEST_BYTES, options.maxResponseBytes ?? MAX_IMAGE_PROTOCOL_RESPONSE_BYTES];
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(options.tenantId) || !Array.isArray(options.allowedTargets) || !options.allowedTargets.length || options.allowedTargets.length > 100
      || options.allowedTargets.some(target => !domain(target.hostname) || !Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535)
      || limits.some(limit => !Number.isSafeInteger(limit) || limit < 1) || limits[0] > 30000 || limits[1] > MAX_IMAGE_PROTOCOL_REQUEST_BYTES || limits[2] > MAX_IMAGE_PROTOCOL_RESPONSE_BYTES
      || options.additionalDeniedAddresses && (!Array.isArray(options.additionalDeniedAddresses) || options.additionalDeniedAddresses.length > 1024
        || options.additionalDeniedAddresses.some(address => !isIP(address) || address.includes("%") || isIP(address) === 6 && address.includes(".")))
      || typeof options.authorize !== "function" || options.dns?.mode !== "contract-fixture" || options.credentials?.mode !== "contract-fixture"
      || options.credentials.realExecutionEnabled !== false || options.transport?.mode !== "contract-fixture" || options.transport.realExecutionEnabled !== false) reject("image_egress_configuration_invalid");
    this.options = { ...options, allowedTargets: options.allowedTargets.map(target => ({ ...target })), additionalDeniedAddresses: options.additionalDeniedAddresses?.map(address => canonicalAddress(address)) };
  }
  async run(principal: RunPrincipal, connectionInput: ImageProviderConnection, requestInput: ImageExecutionRequest, preparedInput: Prepared, signal: AbortSignal): Promise<ImageProtocolResponse> {
    if (!this.options) reject("image_egress_not_configured");
    if (this.used) reject("image_egress_fixture_consumed");
    this.used = true;
    if (activeFixtures >= 2) reject("image_egress_capacity");
    activeFixtures++;
    const options = this.options, clock = options.clock ?? Date.now;
    const local = new AbortController(), abort = AbortSignal.any([signal, local.signal, AbortSignal.timeout(options.timeoutMs ?? 5000)]);
    const pending = new Set<Promise<unknown>>();
    const track = <T>(work: Promise<T>) => {
      const tracked = Promise.resolve(work).finally(() => pending.delete(tracked)); pending.add(tracked); return tracked;
    };
    let body: Buffer | undefined;
    try {
      const connection = structuredClone(connectionInput), request = structuredClone(requestInput);
      const wire = bindWire(connection, request, preparedInput, new Date(clock()).toISOString()); body = wire.body;
      if (wire.body.length > (options.maxRequestBytes ?? MAX_IMAGE_PROTOCOL_REQUEST_BYTES)) reject("image_egress_request_too_large");
      if (principal.tenantId !== options.tenantId || request.tenantId !== options.tenantId || !/^[A-Za-z0-9_.:-]{1,160}$/.test(principal.actorId)) reject("image_egress_permission_denied");
      const scope: ImageCredentialScope = { tenantId: request.tenantId, projectId: request.projectId, actorId: principal.actorId, connectionId: connection.id,
        connectionRevision: connection.revision, credentialRef: wire.auth.credentialRef, requestFingerprint: wire.fingerprint, payloadChecksumSha256: preparedInput.payloadChecksumSha256 };
      const guard = () => {
        if (abort.aborted) reject("image_egress_cancelled");
        const decision: unknown = options.authorize(structuredClone(scope));
        if (decision instanceof Promise) void decision.catch(() => undefined);
        if (decision !== true) reject("image_egress_permission_denied");
        validateImageProviderRequest(connection, request, new Date(clock()).toISOString());
        if (!options.allowedTargets.some(target => target.hostname === wire.target.hostname && target.port === wire.target.port)) reject("image_egress_target_not_allowed");
      };
      guard(); const resolvedAt = clock();
      const records = await raceAbort(track(options.dns.resolveAll(wire.target.hostname, abort)), abort);
      if (!Array.isArray(records) || !records.length || records.length > 32 || records.some(record => !record || !isAllowedImageEgressAddress(record.address, record.family)
        || options.additionalDeniedAddresses?.includes(canonicalAddress(record.address)))) reject("image_egress_dns_rejected");
      const pinned = { ...records[0] }; guard(); let consumed = false, verifiedResponse: ImageProtocolResponse | undefined;
      const result = await raceAbort(track(options.credentials.withCredential(structuredClone(scope), abort, async lease => {
        if (consumed) reject("image_egress_credential_reused"); consumed = true;
        guard();
        if (clock() < resolvedAt || clock() - resolvedAt >= 30000) reject("image_egress_dns_expired");
        if (!lease || imageSnapshotFingerprint(lease.scope) !== imageSnapshotFingerprint(scope) || !Buffer.isBuffer(lease.secret)
          || !lease.secret.length || lease.secret.length > 4096 || [...lease.secret].some(byte => byte < 33 || byte > 126)) reject("image_egress_credential_invalid");
        const secret = Buffer.from(lease.secret), headers: Record<string, string> = { "content-type": wire.contentType, "content-length": String(wire.body.length), "accept": "application/json", "accept-encoding": "identity" };
        try {
          headers[wire.auth.scheme === "bearer" ? "authorization" : wire.auth.headerName] = (wire.auth.scheme === "bearer" ? "Bearer " : "") + secret.toString("ascii");
          const transmitted = Buffer.from(wire.body);
          let sending: ReturnType<ImageEgressFixtureTransport["send"]>;
          try { sending = Promise.resolve(options.transport.send({ destination: { ...wire.target, ...pinned, servername: wire.target.hostname,
            rejectUnauthorized: true, redirects: "error", retries: 0, proxy: "disabled" }, method: "POST", headers, body: transmitted }, abort)); }
          catch (error) { transmitted.fill(0); throw error; }
          const response = await raceAbort(track(sending.finally(() => transmitted.fill(0))), abort);
          verifiedResponse = await readResponse(response, abort, options.maxResponseBytes ?? MAX_IMAGE_PROTOCOL_RESPONSE_BYTES, track);
          return verifiedResponse;
        } finally { secret.fill(0); for (const key of Object.keys(headers)) delete headers[key]; }
      })), abort);
      if (!consumed || !result || result !== verifiedResponse) reject("image_egress_credential_invalid");
      return result;
    } catch (error) {
      if (error instanceof ImageEgressContractError && errorCodes.has(error.code)) return reject(error.code);
      // Do not propagate vendor/DNS/credential exception messages or causes.
      return reject(abort.aborted ? "image_egress_cancelled" : "image_egress_contract_failed");
    } finally {
      local.abort(); body?.fill(0);
      // A trusted port that ignores cancellation keeps its slot until settlement;
      // timing out the caller must not create unlimited background operations.
      if (pending.size) void Promise.allSettled([...pending]).then(() => { activeFixtures--; }); else activeFixtures--;
    }
  }
}
async function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) reject("image_egress_cancelled");
  let listener: (() => void) | undefined;
  try { return await Promise.race([work, new Promise<never>((_, rejectPromise) => {
    listener = () => rejectPromise(new ImageEgressContractError("image_egress_cancelled")); signal.addEventListener("abort", listener, { once: true });
  })]); } finally { if (listener) signal.removeEventListener("abort", listener); }
}
function canonicalAddress(address: string) { return isIP(address) === 4 ? `v4:${v4(address)}` : `v6:${v6(address)}`; }
async function readResponse(response: Awaited<ReturnType<ImageEgressFixtureTransport["send"]>>, signal: AbortSignal, maximum: number, track: <T>(work: Promise<T>) => Promise<T>): Promise<ImageProtocolResponse> {
  if (!response?.body || typeof response.body[Symbol.asyncIterator] !== "function") reject("image_egress_response_invalid");
  const iterator = response.body[Symbol.asyncIterator](), chunks: Buffer[] = []; let size = 0, count = 0, done = false;
  try {
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status > 599 || !response.headers || typeof response.headers !== "object") reject("image_egress_response_invalid");
  const entries = Object.entries(response.headers), headers: Record<string, string> = {};
  if (entries.length > 100 || entries.reduce((sum, [key, value]) => sum + Buffer.byteLength(key + value), 0) > 16 * 1024) reject("image_egress_response_headers_invalid");
  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(lower) || typeof value !== "string" || /[^\x20-\x7e]/.test(value) || lower in headers) reject("image_egress_response_headers_invalid");
    headers[lower] = value;
  }
  // Never follow Location or fetch artifact URLs. A rejected response is not
  // evidence of zero billing; this harness does not touch any ledger.
  if (response.status >= 300 && response.status < 400 || headers.location !== undefined) reject("image_egress_redirect_rejected");
  if (!/^application\/json(?:\s*;|$)/i.test(headers["content-type"] ?? "") || headers["content-encoding"] && headers["content-encoding"].toLowerCase() !== "identity") reject("image_egress_response_encoding_invalid");
  const declared = headers["content-length"];
  if (declared !== undefined && (!/^(0|[1-9][0-9]{0,8})$/.test(declared) || Number(declared) > maximum)) reject("image_egress_response_too_large");
    while (true) {
      const next = await raceAbort(track(Promise.resolve(iterator.next())), signal);
      if (next.done) { done = true; break; }
      if (!(next.value instanceof Uint8Array) || ++count > 4096 || !next.value.length || next.value.length > 8 * 1024 * 1024) reject("image_egress_response_chunks_invalid");
      size += next.value.length; if (size > maximum || declared !== undefined && size > Number(declared)) reject("image_egress_response_too_large");
      chunks.push(Buffer.from(next.value));
    }
    if (declared !== undefined && size !== Number(declared)) reject("image_egress_response_length_mismatch");
    const requestId = headers["x-request-id"];
    return { status: response.status, contentType: headers["content-type"], body: Buffer.concat(chunks, size),
      ...(requestId && /^[A-Za-z0-9_.:-]{1,160}$/.test(requestId) ? { requestId } : {}) };
  } finally {
    if (!done && iterator.return) void track(Promise.resolve(iterator.return())).catch(() => undefined);
    for (const chunk of chunks) chunk.fill(0);
  }
}
