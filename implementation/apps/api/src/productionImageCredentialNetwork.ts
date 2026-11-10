import type { ConfirmedProductionImageExecution, ConfirmedLockedProductionImageExecution } from "@canvas/contracts";
import { imageSnapshotFingerprint as fp } from "./imageProviderContract";
import { EncryptedImageCredentials, type EncryptedImageCredentialOptions } from "./encryptedImageCredentials";
import { NativeImageNetworkClient, ImageNetworkDriverHarness, type NativeImageNetworkOptions, type ImageNetworkLocalDrivers } from "./nativeImageNetwork";
import type { ImageCredentialScope } from "./imageEgressContract";
import { parseImageEgressEndpoint } from "./imageEgressPolicy";
import { imagePayloadSha256 } from "./imageRequestPayload";
import type { prepareProductionImageProtocol } from "./productionImageProtocol";
import type { ImageProtocolResponse } from "./imageProtocolResponse";

type Wire = Awaited<ReturnType<typeof prepareProductionImageProtocol>>["wire"];
export type ProductionImageCredentialNetworkOptions = {
  sendingEnabled: true; credentials: EncryptedImageCredentialOptions; network: NativeImageNetworkOptions;
  // Server-managed explicit version, never implicitly choose the newest secret.
  credentialVersion(scope: ImageCredentialScope): number;
  localDrivers?: ImageNetworkLocalDrivers;
};
const fail = (): never => { throw new Error("production_image_credential_network_rejected"); };
function strict(value: unknown) {
  if (value && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => undefined);
  if (value !== true) fail();
}

// Internal transport primitive. It does NOT authorize a caller-supplied task:
// ReconstructionCore supplies its private live attempt and current SQL guards.
// No environment/files/vault, HTTP route, secret importer, or daily wiring.
export class ProductionImageCredentialNetwork {
  private readonly options: ProductionImageCredentialNetworkOptions;
  constructor(private readonly mode: ConfirmedProductionImageExecution["mode"], options: ProductionImageCredentialNetworkOptions) {
    if (!options || options.sendingEnabled !== true || typeof options.credentialVersion !== "function"
      || options.credentials?.tenantId !== options.network?.tenantId
      || (mode === "production" ? options.localDrivers !== undefined : options.localDrivers?.mode !== "local-driver" || options.localDrivers.realExecutionEnabled !== false)) fail();
    // Validate configurations without reading a credential or resolving a name.
    new EncryptedImageCredentials(options.credentials);
    if (mode === "production") new NativeImageNetworkClient(options.network);
    else new ImageNetworkDriverHarness(options.network, options.localDrivers!);
    this.options = { ...options, credentials: { ...options.credentials, writeRoot: { ...options.credentials.writeRoot } },
      network: { ...options.network, allowedTargets: options.network.allowedTargets.map(t => ({ ...t })), additionalDeniedAddresses: options.network.additionalDeniedAddresses?.slice() } };
  }
  // Keep the complete v2 identity; never relabel it as a v1/none execution.
  // Both callers must supply their own actual SQL-backed live attempt guards.
  async send(e: ConfirmedProductionImageExecution | ConfirmedLockedProductionImageExecution, wire: Wire, actorId: string, signal: AbortSignal,
    assertCurrent: () => void, assertHistory: () => void): Promise<ImageProtocolResponse> {
    const o = this.options, connection = e.preparation.connection, request = e.protocol.request;
    if (e.mode !== this.mode || request.tenantId !== o.network.tenantId || !(signal instanceof AbortSignal)) fail();
    assertCurrent();
    const base = new URL(connection.baseUrl);
    // Raw URL checked BEFORE normalization; endpoint/auth remain the frozen protocol.
    parseImageEgressEndpoint(connection.baseUrl.endsWith("/") ? connection.baseUrl : connection.baseUrl + "/");
    const path = connection.protocol === "google" ? `/${connection.googleNative!.apiVersion}/models/${request.model}:generateContent`
      : base.pathname.replace(/\/+$/, "") + (connection.protocol === "openai-compatible" ? connection.compatibility!.endpoints[request.operation]
        : request.operation === "generate" ? "/images/generations" : "/images/edits");
    const endpointUrl = `${base.origin}${path}`;
    parseImageEgressEndpoint(endpointUrl);
    const auth = connection.protocol === "google" ? { scheme: "header" as const, headerName: "x-goog-api-key", credentialRef: connection.credentialRef }
      : connection.protocol === "openai-compatible" ? { ...connection.compatibility!.auth, credentialRef: connection.credentialRef }
        : { scheme: "bearer" as const, credentialRef: connection.credentialRef };
    if (wire.method !== "POST" || wire.requestFingerprint !== e.protocol.requestFingerprint || wire.contentType !== e.protocol.contentType
      || wire.body.byteLength !== e.protocol.payloadByteSize || imagePayloadSha256(wire.body) !== e.protocol.payloadChecksumSha256
      || ("endpointUrl" in wire ? wire.endpointUrl !== endpointUrl || fp(wire.authPlan) !== fp(auth) : wire.path !== `/images/${request.operation === "generate" ? "generations" : "edits"}`)) fail();
    const scope: ImageCredentialScope = { tenantId: request.tenantId, projectId: request.projectId, actorId, connectionId: connection.id,
      connectionRevision: connection.revision, credentialRef: connection.credentialRef, requestFingerprint: e.protocol.requestFingerprint,
      payloadChecksumSha256: e.protocol.payloadChecksumSha256 };
    const version = o.credentialVersion(structuredClone(scope));
    if (version && typeof version === "object" && "then" in version) void Promise.resolve(version).catch(() => undefined);
    if (!Number.isSafeInteger(version) || version < 1) fail();
    assertCurrent();
    let response: ImageProtocolResponse | undefined, received = false, open = true;
    const checkTask = () => { if (!open || signal.aborted) fail(); (received ? assertHistory : assertCurrent)(); };
    const credentials = new EncryptedImageCredentials({ ...o.credentials, authorize: (context, phase) => {
      checkTask();
      if (context.operation !== "consume" || context.expectedVersion !== version || fp(context.execution) !== fp(scope)) fail();
      strict(o.credentials.authorize(context, phase)); checkTask(); return true;
    } });
    try {
      await credentials.consume(scope, version, signal, async lease => {
        checkTask(); lease.assertCurrent();
        if (lease.version !== version || fp(lease.scope) !== fp(scope)) fail();
        const headers: Record<string, string> = { "content-type": wire.contentType, "content-length": String(wire.body.byteLength),
          accept: "application/json", "accept-encoding": "identity" };
        headers[auth.scheme === "bearer" ? "authorization" : auth.headerName] = (auth.scheme === "bearer" ? "Bearer " : "") + lease.secret.toString("ascii");
        try {
          const networkOptions = { ...o.network, authorize: (actual: ImageCredentialScope, phase: Parameters<NativeImageNetworkOptions["authorize"]>[1]) => {
            checkTask(); lease.assertCurrent(); if (fp(actual) !== fp(scope)) fail();
            strict(o.network.authorize(actual, phase)); checkTask(); lease.assertCurrent(); return true;
          } };
          const client = this.mode === "production" ? new NativeImageNetworkClient(networkOptions) : new ImageNetworkDriverHarness(networkOptions, o.localDrivers!);
          response = await client.send({ scope, endpointUrl, body: wire.body, headers }, signal);
          received = true; assertHistory();
        } finally { for (const key of Object.keys(headers)) delete headers[key]; }
      });
      if (!response) return fail(); return response;
    } catch {
      // Rotation/revocation AFTER receipt cannot erase this request's original
      // response. Preserve evidence only under current task/history permissions;
      // this branch never opens another credential/network operation.
      if (response && !signal.aborted) { try { assertHistory(); return response; } catch { response.body.fill(0); return fail(); } }
      response?.body.fill(0); return fail();
    } finally { open = false; }
  }
}
