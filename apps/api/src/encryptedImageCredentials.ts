import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ImageCredentialScope } from "./imageEgressContract";

const ID = /^[A-Za-z0-9_.:-]{1,160}$/, SHA = /^[a-f0-9]{64}$/;
const MAX_RECORD = 16 * 1024, MAX_BYTES = 8 * 1024 * 1024, MAX_VERSIONS = 32, MAX_REFERENCES = 256;
const APP_ID = 0x49435244;
export class ImageCredentialError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ImageCredentialError"; }
}
const codes = new Set(["not_configured", "configuration_invalid", "permission_denied", "scope_invalid", "secret_invalid", "key_invalid",
  "key_port_invalid", "corrupt", "not_found", "version_conflict", "revoked", "capacity", "cancelled", "storage_failed", "operation_failed"]);
function fail(code: string): never { throw new ImageCredentialError(`image_credential_${code}`); }
function sanitized(error: unknown): never {
  if (error instanceof ImageCredentialError && codes.has(error.code.replace(/^image_credential_/, ""))) throw new ImageCredentialError(error.code);
  fail("operation_failed");
}
export type ImageCredentialBinding = { tenantId: string; projectId: string; connectionId: string; credentialRef: string };
export type ImageRootKeyReference = { id: string; version: number };
export type ImageCredentialContext = {
  binding: ImageCredentialBinding; actorId: string; connectionRevision: number; expectedVersion: number;
  operation: "create" | "rotate" | "revoke" | "consume"; execution?: ImageCredentialScope;
};
export type ImageRootKeyRequest = { context: ImageCredentialContext; root: ImageRootKeyReference; credentialVersion: number };
export interface ImageRootKeyPort {
  // Trusted server implementation; there is deliberately no env/file/vault reader.
  withRootKey(request: ImageRootKeyRequest, signal: AbortSignal, use: (lease: { request: ImageRootKeyRequest; key: Buffer }) => Promise<void>): Promise<void>;
}
type Envelope = {
  schemaVersion: 1; algorithm: "AES-256-GCM"; binding: ImageCredentialBinding; version: number; state: "active" | "revoked";
  root: ImageRootKeyReference; connectionRevision: number; actorId: string; createdAt: number; previousDigest: string | null;
  nonce: string; tag: string; ciphertext: string;
};
export type ImageCredentialMetadata = Pick<Envelope, "schemaVersion" | "binding" | "version" | "state" | "root" | "connectionRevision" | "actorId" | "createdAt">;
export type EncryptedImageCredentialOptions = {
  credentialAccessEnabled: true; tenantId: string; store: SqliteImageCredentialStore; rootKeys: ImageRootKeyPort;
  writeRoot: ImageRootKeyReference;
  // Must verify actual server identity, current connection/ref/revision, and for
  // consume the real production task/confirmation/lease/quote/input permissions.
  // A browser-provided scope or a payload SHA alone is NOT authorization.
  authorize(context: ImageCredentialContext, phase: "before-storage" | "before-key" | "after-key" | "before-commit" | "before-use" | "lease-check"): boolean;
  timeoutMs?: number; clock?: () => number;
};

function validBinding(value: ImageCredentialBinding) {
  return value && Object.keys(value).sort().join(",") === "connectionId,credentialRef,projectId,tenantId"
    && Object.values(value).every(id => typeof id === "string" && ID.test(id));
}
function validRoot(root: ImageRootKeyReference) {
  return root && Object.keys(root).sort().join(",") === "id,version" && typeof root.id === "string" && ID.test(root.id) && Number.isSafeInteger(root.version) && root.version > 0;
}
function bindingKey(binding: ImageCredentialBinding) { return hash(JSON.stringify([binding.tenantId, binding.projectId, binding.connectionId, binding.credentialRef])); }
function hash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function normalizeBinding(binding: ImageCredentialBinding): ImageCredentialBinding {
  if (!validBinding(binding)) fail("scope_invalid");
  return { tenantId: binding.tenantId, projectId: binding.projectId, connectionId: binding.connectionId, credentialRef: binding.credentialRef };
}
function aad(value: Envelope) {
  return Buffer.from(JSON.stringify({ schemaVersion: value.schemaVersion, algorithm: value.algorithm, binding: normalizeBinding(value.binding),
    version: value.version, state: value.state, root: { id: value.root.id, version: value.root.version }, connectionRevision: value.connectionRevision,
    actorId: value.actorId, createdAt: value.createdAt, previousDigest: value.previousDigest }));
}
function base64(value: unknown, min: number, max: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("corrupt");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < min || bytes.length > max || bytes.toString("base64") !== value) fail("corrupt");
  return bytes;
}
function validateEnvelope(value: Envelope) {
  if (!value || Object.keys(value).sort().join(",") !== "actorId,algorithm,binding,ciphertext,connectionRevision,createdAt,nonce,previousDigest,root,schemaVersion,state,tag,version"
    || value.schemaVersion !== 1 || value.algorithm !== "AES-256-GCM" || !validBinding(value.binding) || !validRoot(value.root)
    || !Number.isSafeInteger(value.version) || value.version < 1 || value.version > MAX_VERSIONS
    || !["active", "revoked"].includes(value.state) || typeof value.actorId !== "string" || !ID.test(value.actorId) || !Number.isSafeInteger(value.connectionRevision) || value.connectionRevision < 1
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !(value.previousDigest === null || typeof value.previousDigest === "string" && SHA.test(value.previousDigest))) fail("corrupt");
  base64(value.nonce, 12, 12); base64(value.tag, 16, 16); base64(value.ciphertext, value.state === "active" ? 1 : 0, value.state === "active" ? 4096 : 0);
}
function meta(value: Envelope): ImageCredentialMetadata {
  return structuredClone({ schemaVersion: value.schemaVersion, binding: value.binding, version: value.version, state: value.state,
    root: value.root, connectionRevision: value.connectionRevision, actorId: value.actorId, createdAt: value.createdAt });
}
function validateSecret(secret: Buffer) {
  if (!Buffer.isBuffer(secret) || secret.length < 1 || secret.length > 4096 || secret.some(byte => byte < 0x21 || byte > 0x7e)) fail("secret_invalid");
}

// Internal server-only persistence, NOT an authorization API or a production
// secret vault. Explicit separate file only; never opens the daily task DB.
export class SqliteImageCredentialStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(filepath: string, private readonly limits: { maxBytes?: number; maxReferences?: number; maxVersions?: number } = {}) {
    if (typeof filepath !== "string" || filepath !== ":memory:" && !isAbsolute(filepath)
      || [limits.maxBytes ?? MAX_BYTES, limits.maxReferences ?? MAX_REFERENCES, limits.maxVersions ?? MAX_VERSIONS - 1].some(value => !Number.isSafeInteger(value) || value < 1)
      || (limits.maxBytes ?? MAX_BYTES) > MAX_BYTES || (limits.maxReferences ?? MAX_REFERENCES) > MAX_REFERENCES || (limits.maxVersions ?? (MAX_VERSIONS - 1)) >= MAX_VERSIONS) fail("configuration_invalid");
    this.limits = { ...limits }; // Do not accept later mutation of trusted configuration.
    let opened: DatabaseSync | undefined;
    try {
      opened = new DatabaseSync(filepath, { timeout: 1000, allowExtension: false, enableDoubleQuotedStringLiterals: false }); this.db = opened;
      this.db.exec("BEGIN IMMEDIATE");
      const application = this.db.prepare("PRAGMA application_id").get()!.application_id, version = this.db.prepare("PRAGMA user_version").get()!.user_version;
      if (application === 0 && version === 0) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) fail("configuration_invalid");
        this.db.exec(`CREATE TABLE credential_events (scope_id TEXT NOT NULL, version INTEGER NOT NULL, record TEXT NOT NULL, digest TEXT NOT NULL,
          PRIMARY KEY(scope_id, version)); CREATE TABLE credential_heads (scope_id TEXT PRIMARY KEY, version INTEGER NOT NULL, digest TEXT NOT NULL);
          PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;`);
      } else if (application !== APP_ID || version !== 1) fail("configuration_invalid");
      this.db.exec("COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    } catch (error) {
      try { opened?.exec("ROLLBACK"); } catch { /* No raw SQLite/path diagnostics exposed. */ }
      try { opened?.close(); } catch { /* Best effort constructor cleanup. */ }
      if (error instanceof ImageCredentialError) sanitized(error); fail("storage_failed");
    }
  }
  close() { if (!this.closed) { this.closed = true; try { this.db.close(); } catch { fail("storage_failed"); } } }
  read(binding: ImageCredentialBinding): { envelope: Envelope; digest: string } | null {
    normalizeBinding(binding);
    return this.transaction(() => this.readInside(binding));
  }
  append(binding: ImageCredentialBinding, expectedDigest: string | null, envelope: Envelope, finalCheck: () => void): void {
    this.transaction(() => {
      const current = this.readInside(binding), scope = bindingKey(binding);
      if ((current?.digest ?? null) !== expectedDigest) fail("version_conflict");
      validateEnvelope(envelope);
      if (!same(normalizeBinding(binding), normalizeBinding(envelope.binding)) || envelope.version !== (current?.envelope.version ?? 0) + 1
        || envelope.previousDigest !== expectedDigest || current?.envelope.state === "revoked" || envelope.createdAt < (current?.envelope.createdAt ?? 0)) fail("version_conflict");
      const record = JSON.stringify(envelope), digest = hash(record);
      const maxActiveVersions = this.limits.maxVersions ?? MAX_VERSIONS - 1;
      if (Buffer.byteLength(record) > MAX_RECORD || envelope.version > maxActiveVersions + (envelope.state === "revoked" ? 1 : 0)) fail("capacity");
      // Check under the same writer transaction. Never silently redraw a nonce
      // or retry after a collision; cross-store/root reuse is a deployment duty.
      if (this.db.prepare("SELECT 1 FROM credential_events WHERE json_extract(record,'$.root.id')=? AND json_extract(record,'$.root.version')=? AND json_extract(record,'$.nonce')=? LIMIT 1")
        .get(envelope.root.id, envelope.root.version, envelope.nonce)) fail("corrupt");
      const capacity = this.db.prepare("SELECT COALESCE(SUM(length(CAST(record AS BLOB)) + 64),0) AS bytes FROM credential_events").get()!.bytes as number;
      const count = this.db.prepare("SELECT count(*) AS count FROM credential_heads").get()!.count as number;
      const active = this.db.prepare("SELECT count(*) AS count FROM credential_heads h JOIN credential_events e ON e.scope_id=h.scope_id AND e.version=h.version WHERE json_extract(e.record,'$.state')='active'").get()!.count as number;
      // Reserve one terminal event slot and MAX_RECORD+digest bytes per live
      // reference. Normal capacity exhaustion must not prevent revocation.
      const activeAfter = active + (!current ? 1 : envelope.state === "revoked" ? -1 : 0);
      if (capacity + Buffer.byteLength(record) + 64 + activeAfter * (MAX_RECORD + 64) > (this.limits.maxBytes ?? MAX_BYTES)
        || !current && count >= (this.limits.maxReferences ?? MAX_REFERENCES)) fail("capacity");
      this.db.prepare("INSERT INTO credential_events VALUES(?,?,?,?)").run(scope, envelope.version, record, digest);
      this.db.prepare("INSERT INTO credential_heads VALUES(?,?,?) ON CONFLICT(scope_id) DO UPDATE SET version=excluded.version,digest=excluded.digest").run(scope, envelope.version, digest);
      finalCheck(); // Synchronous policy/cancellation recheck before COMMIT; throws roll back both writes.
    });
  }
  private readInside(binding: ImageCredentialBinding): { envelope: Envelope; digest: string } | null {
    const scope = bindingKey(binding), head = this.db.prepare("SELECT version,digest FROM credential_heads WHERE scope_id=?").get(scope);
    const rows = this.db.prepare("SELECT version,substr(record,1,16385) AS record,length(CAST(record AS BLOB)) AS bytes,digest FROM credential_events WHERE scope_id=? ORDER BY version LIMIT 33").all(scope);
    if (!head && !rows.length) return null;
    if (!head || !rows.length || rows.length > MAX_VERSIONS || head.version !== rows.length) fail("corrupt");
    let previous: string | null = null, latest: Envelope | undefined, latestDigest = "", time = 0, wasRevoked = false;
    for (const [index, row] of rows.entries()) {
      if (typeof row.record !== "string" || (row.bytes as number) > MAX_RECORD || row.version !== index + 1 || typeof row.digest !== "string" || !SHA.test(row.digest) || hash(row.record) !== row.digest) fail("corrupt");
      let value: Envelope; try { value = JSON.parse(row.record); } catch { fail("corrupt"); }
      validateEnvelope(value);
      if (!same(normalizeBinding(value.binding), normalizeBinding(binding)) || value.version !== row.version || value.previousDigest !== previous || value.createdAt < time || wasRevoked) fail("corrupt");
      previous = row.digest; time = value.createdAt; wasRevoked = value.state === "revoked"; latest = value; latestDigest = row.digest;
    }
    if (head.digest !== latestDigest) fail("corrupt");
    return { envelope: latest!, digest: latestDigest };
  }
  private transaction<T>(work: () => T): T {
    if (this.closed) fail("storage_failed");
    try {
      this.db.exec("BEGIN IMMEDIATE"); const value = work(); this.db.exec("COMMIT"); return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Keep the original fixed error only. */ }
      if (error instanceof ImageCredentialError) sanitized(error); fail("storage_failed");
    }
  }
}

let activeCredentialOperations = 0;
export class EncryptedImageCredentials {
  private readonly options?: EncryptedImageCredentialOptions;
  constructor(options?: EncryptedImageCredentialOptions) {
    if (!options) return;
    if (options.credentialAccessEnabled !== true || typeof options.tenantId !== "string" || !ID.test(options.tenantId) || !(options.store instanceof SqliteImageCredentialStore)
      || typeof options.rootKeys?.withRootKey !== "function" || !validRoot(options.writeRoot) || typeof options.authorize !== "function"
      || !Number.isSafeInteger(options.timeoutMs ?? 5000) || (options.timeoutMs ?? 5000) < 1 || (options.timeoutMs ?? 5000) > 30000
      || options.clock !== undefined && typeof options.clock !== "function") fail("configuration_invalid");
    this.options = { ...options, writeRoot: { ...options.writeRoot } };
  }
  create(context: Omit<ImageCredentialContext, "operation" | "execution">, secret: Buffer, signal: AbortSignal) {
    return this.change({ ...context, operation: "create" }, secret, signal);
  }
  rotate(context: Omit<ImageCredentialContext, "operation" | "execution">, secret: Buffer, signal: AbortSignal) {
    return this.change({ ...context, operation: "rotate" }, secret, signal);
  }
  revoke(context: Omit<ImageCredentialContext, "operation" | "execution">, signal: AbortSignal) {
    return this.change({ ...context, operation: "revoke" }, undefined, signal);
  }
  async consume(scope: ImageCredentialScope, expectedVersion: number, signal: AbortSignal,
    use: (lease: { scope: ImageCredentialScope; version: number; secret: Buffer; assertCurrent(): void }) => Promise<void>): Promise<void> {
    const context: ImageCredentialContext = { binding: { tenantId: scope?.tenantId, projectId: scope?.projectId, connectionId: scope?.connectionId, credentialRef: scope?.credentialRef },
      actorId: scope?.actorId, connectionRevision: scope?.connectionRevision, expectedVersion, operation: "consume", execution: scope };
    await this.run(context, signal, async (ctx, guard, withKey, track, abort) => {
      if (typeof use !== "function") fail("configuration_invalid");
      guard("before-storage"); const current = this.options!.store.read(ctx.binding);
      if (!current) fail("not_found");
      if (current.envelope.version !== ctx.expectedVersion) fail("version_conflict");
      if (current.envelope.connectionRevision !== ctx.connectionRevision) fail("version_conflict");
      let plain: Buffer | undefined, live = true;
      const assertCurrent = () => {
        if (!live) fail("cancelled"); guard("lease-check");
        if (this.options!.store.read(ctx.binding)?.digest !== current.digest) fail("version_conflict");
      };
      try {
        plain = await withKey(current.envelope.root, current.envelope.version, key => decrypt(current.envelope, key));
        guard("after-key"); assertCurrent();
        if (current.envelope.state !== "active") fail("revoked"); validateSecret(plain);
        guard("before-use"); assertCurrent();
        await raceAbort(track(Promise.resolve().then(() => { assertCurrent(); return use({ scope: structuredClone(ctx.execution!), version: current.envelope.version, secret: plain!, assertCurrent }); })), abort);
        assertCurrent(); // Does not retroactively revoke an already sent request.
      } finally { live = false; plain?.fill(0); }
    });
  }
  private async change(context: ImageCredentialContext, secret: Buffer | undefined, signal: AbortSignal): Promise<ImageCredentialMetadata> {
    // Copy before the first await so caller mutation cannot change stored bytes.
    let owned: Buffer | undefined;
    try {
      if (context.operation !== "revoke") { validateSecret(secret!); owned = Buffer.from(secret!); }
      return await this.run(context, signal, async (ctx, guard, withKey) => {
        guard("before-storage"); const current = this.options!.store.read(ctx.binding);
        if ((current?.envelope.version ?? 0) !== ctx.expectedVersion || ctx.operation === "create" && current || ctx.operation !== "create" && !current) fail("version_conflict");
        if (current) {
          // Verify the prior authenticated event before writing a successor.
          const previous = await withKey(current.envelope.root, current.envelope.version, key => decrypt(current.envelope, key)); previous.fill(0);
          guard("after-key");
          if (current.envelope.state === "revoked") { if (ctx.operation === "revoke") return meta(current.envelope); fail("revoked"); }
        }
        const now = (this.options!.clock ?? Date.now)();
        if (!Number.isSafeInteger(now) || now < (current?.envelope.createdAt ?? 0)) fail("configuration_invalid");
        const value: Envelope = { schemaVersion: 1, algorithm: "AES-256-GCM", binding: ctx.binding, version: ctx.expectedVersion + 1,
          state: ctx.operation === "revoke" ? "revoked" : "active", root: { ...this.options!.writeRoot }, connectionRevision: ctx.connectionRevision,
          actorId: ctx.actorId, createdAt: now, previousDigest: current?.digest ?? null, nonce: "", tag: "", ciphertext: "" };
        const envelope = await withKey(value.root, value.version, key => encrypt(value, owned ?? Buffer.alloc(0), key));
        guard("after-key"); guard("before-commit");
        this.options!.store.append(ctx.binding, current?.digest ?? null, envelope, () => guard("before-commit"));
        return meta(envelope);
      });
    } catch (error) { return sanitized(error); } finally { owned?.fill(0); }
  }
  private async run<T>(context: ImageCredentialContext, signal: AbortSignal, work: (context: ImageCredentialContext,
    guard: (phase: Parameters<EncryptedImageCredentialOptions["authorize"]>[1]) => void,
    withKey: <R>(root: ImageRootKeyReference, version: number, action: (key: Buffer) => R) => Promise<R>,
    track: <R>(promise: Promise<R>) => Promise<R>, abort: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.options) fail("not_configured");
    if (!(signal instanceof AbortSignal)) fail("configuration_invalid");
    if (activeCredentialOperations >= 2) fail("capacity"); activeCredentialOperations++;
    const abort = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 5000)]), pending = new Set<Promise<unknown>>();
    const track = <R>(promise: Promise<R>) => { const item = Promise.resolve(promise).finally(() => pending.delete(item)); pending.add(item); return item; };
    let open = true;
    try {
      const ctx = structuredClone(context); ctx.binding = normalizeBinding(ctx.binding);
      if (Object.keys(ctx).sort().join(",") !== (ctx.operation === "consume" ? "actorId,binding,connectionRevision,execution,expectedVersion,operation" : "actorId,binding,connectionRevision,expectedVersion,operation")
        || !["create", "rotate", "revoke", "consume"].includes(ctx.operation) || ctx.binding.tenantId !== this.options.tenantId || typeof ctx.actorId !== "string" || !ID.test(ctx.actorId) || !Number.isSafeInteger(ctx.connectionRevision) || ctx.connectionRevision < 1
        || !Number.isSafeInteger(ctx.expectedVersion) || ctx.expectedVersion < (ctx.operation === "create" ? 0 : 1) || ctx.expectedVersion > MAX_VERSIONS
        || ctx.operation === "create" && ctx.expectedVersion !== 0) fail("scope_invalid");
      if (ctx.operation === "consume") {
        const scope = ctx.execution;
        if (!scope || Object.keys(scope).sort().join(",") !== "actorId,connectionId,connectionRevision,credentialRef,payloadChecksumSha256,projectId,requestFingerprint,tenantId"
          || !same(normalizeBinding({ tenantId: scope.tenantId, projectId: scope.projectId, connectionId: scope.connectionId, credentialRef: scope.credentialRef }), ctx.binding)
          || scope.actorId !== ctx.actorId || scope.connectionRevision !== ctx.connectionRevision || typeof scope.requestFingerprint !== "string" || !SHA.test(scope.requestFingerprint)
          || typeof scope.payloadChecksumSha256 !== "string" || !SHA.test(scope.payloadChecksumSha256)) fail("scope_invalid");
      }
      const guard = (phase: Parameters<EncryptedImageCredentialOptions["authorize"]>[1]) => {
        if (!open || abort.aborted) fail("cancelled");
        const decision: unknown = this.options!.authorize(structuredClone(ctx), phase);
        if (decision instanceof Promise) void decision.catch(() => undefined);
        if (decision !== true) fail("permission_denied"); if (abort.aborted || !open) fail("cancelled");
      };
      const withKey = async <R>(root: ImageRootKeyReference, version: number, action: (key: Buffer) => R): Promise<R> => {
        guard("before-key"); const request: ImageRootKeyRequest = { context: structuredClone(ctx), root: { ...root }, credentialVersion: version };
        let calls = 0, accepting = true, result: R | undefined, invalid = false, ran: Promise<void> | undefined, succeeded = false;
        try {
          await raceAbort(track(Promise.resolve().then(() => this.options!.rootKeys.withRootKey(structuredClone(request), abort, lease => {
            if (!accepting || ++calls !== 1) { invalid = true; return Promise.reject(new ImageCredentialError("image_credential_key_port_invalid")); }
            ran = track(Promise.resolve().then(() => {
              guard("before-key");
              if (!lease || !same(lease.request, request) || !Buffer.isBuffer(lease.key) || lease.key.length !== 32) fail("key_invalid");
              const ownedKey = Buffer.from(lease.key);
              try { result = action(ownedKey); } finally { ownedKey.fill(0); }
            }));
            return ran;
          }))), abort);
          if (ran) await raceAbort(ran, abort);
          if (invalid || calls !== 1 || !ran) fail("key_port_invalid"); guard("after-key"); succeeded = true; return result as R;
        } finally { accepting = false; if (!succeeded && Buffer.isBuffer(result)) result.fill(0); }
      };
      return await raceAbort(track(Promise.resolve().then(() => work(ctx, guard, withKey, track, abort))), abort);
    } catch (error) { return sanitized(error); } finally {
      open = false;
      // Uncooperative key/consumer promises retain a slot until they settle.
      if (pending.size) void Promise.allSettled([...pending]).then(() => { activeCredentialOperations--; }); else activeCredentialOperations--;
    }
  }
}
function encrypt(value: Envelope, plain: Buffer, key: Buffer): Envelope {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 }); cipher.setAAD(aad(value));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  try { return { ...value, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64") }; }
  finally { encrypted.fill(0); }
}
function decrypt(value: Envelope, key: Buffer): Buffer {
  validateEnvelope(value);
  const decipher = createDecipheriv("aes-256-gcm", key, base64(value.nonce, 12, 12), { authTagLength: 16 });
  decipher.setAAD(aad(value)); decipher.setAuthTag(base64(value.tag, 16, 16));
  let prefix: Buffer | undefined, suffix: Buffer | undefined;
  try {
    prefix = decipher.update(base64(value.ciphertext, 0, 4096)); suffix = decipher.final();
    const result = Buffer.concat([prefix, suffix]);
    if (value.state === "active") { try { validateSecret(result); } catch { result.fill(0); fail("corrupt"); } }
    else if (result.length) { result.fill(0); fail("corrupt"); }
    return result; // No plaintext is exposed before successful final()/tag verification.
  } catch { return fail("corrupt"); } finally { prefix?.fill(0); suffix?.fill(0); }
}
async function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) fail("cancelled");
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      stop = () => reject(new ImageCredentialError("image_credential_cancelled")); signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    })]);
  } finally { if (stop) signal.removeEventListener("abort", stop); }
}
