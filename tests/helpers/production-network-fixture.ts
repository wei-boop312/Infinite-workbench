import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { IncomingMessage, type ClientRequest } from "node:http";
import type { RequestOptions } from "node:https";
import { Socket } from "node:net";
import { vi } from "vitest";
import { EncryptedImageCredentials, SqliteImageCredentialStore } from "../../apps/api/src/encryptedImageCredentials";
import type { ProductionImageCredentialNetworkOptions } from "../../apps/api/src/productionImageCredentialNetwork";
import type { ImageProviderConnection } from "../../packages/contracts/src/index";
import type { ImageProtocolResponse } from "../../apps/api/src/imageProtocolResponse";

// Owned random material, independent memory credential SQLite, local drivers.
// No real DNS/request/root reader. Not a production network/price fixture.
export async function ownedProductionNetwork(config: ImageProviderConnection, clock: () => number, response: ImageProtocolResponse) {
  const store = new SqliteImageCredentialStore(":memory:"), root = randomBytes(32), secret = Buffer.from(randomBytes(24).toString("hex"));
  const context = { binding: { tenantId: config.tenantId, projectId: config.projectId, connectionId: config.id, credentialRef: config.credentialRef },
    actorId: "owned-credential-administrator", connectionRevision: config.revision, expectedVersion: 0 };
  const captures: Array<RequestOptions & { sentBody?: Buffer }> = [];
  const hooks = { dns: () => {}, tls: () => {}, write: () => {}, root: () => {} };
  const options: ProductionImageCredentialNetworkOptions = { sendingEnabled: true,
    credentials: { credentialAccessEnabled: true, tenantId: config.tenantId, store, writeRoot: { id: "owned-random-root", version: 1 }, clock,
      authorize: vi.fn(() => true), rootKeys: { withRootKey: vi.fn(async (request, _signal, use) => { hooks.root(); await use({ request: structuredClone(request), key: root }); }) } },
    credentialVersion: vi.fn(() => 1), network: { networkEnabled: true, tenantId: config.tenantId,
      allowedTargets: [{ hostname: new URL(config.baseUrl).hostname, port: 443 }], clock, authorize: vi.fn(() => true) },
    localDrivers: { mode: "local-driver", realExecutionEnabled: false,
      createResolver: vi.fn(() => ({ resolve4: vi.fn((_host, _opts, done) => { hooks.dns(); done(null, [{ address: "8.8.8.8", ttl: 60 }]); }),
        resolve6: vi.fn((_host, _opts, done) => done({ code: "ENODATA" }, [])), cancel: vi.fn() })),
      request: vi.fn((input, callback) => {
        const capture = { ...input, headers: { ...input.headers } }; captures.push(capture);
        const req = new EventEmitter() as ClientRequest; let closed = false;
        req.destroy = vi.fn(() => { if (!closed) { closed = true; setImmediate(() => req.emit("close")); } return req; });
        req.end = vi.fn(body => { capture.sentBody = Buffer.from(body as Buffer); hooks.write(); setImmediate(() => {
          if (closed) return; const message = new IncomingMessage(new Socket()); message.statusCode = response.status; message.complete = true;
          message.rawHeaders = ["Content-Type", response.contentType, "Content-Length", String(response.body.length)]; message.rawTrailers = [];
          callback(message); message.push(response.body); message.push(null);
        }); return req; }) as typeof req.end;
        setImmediate(async () => { try { if (!closed) { const socket = Object.assign(new EventEmitter(), { encrypted: true, authorized: true });
          req.emit("socket", socket); await hooks.tls(); if (!closed) socket.emit("secureConnect"); } } catch { req.emit("error", new Error("owned-driver-failed")); } }); return req;
      }) } };
  const credentials = new EncryptedImageCredentials(options.credentials);
  await credentials.create(context, secret, new AbortController().signal);
  vi.mocked(options.credentials.rootKeys.withRootKey).mockClear(); vi.mocked(options.credentials.authorize).mockClear();
  return { options, credentials, context, captures, hooks, root, secret,
    cleanup: () => { store.close(); root.fill(0); secret.fill(0); } };
}
