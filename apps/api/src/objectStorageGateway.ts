import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  ObjectStorageGrantSchema,
  type ObjectStorageGrant,
  type ObjectStorageGrantRequest,
  type ObjectStoragePermission,
} from "@canvas/contracts";

export type StoragePrincipal = {
  tenantId: string;
  actorId: string;
};

export type StaticStorageAccess = StoragePrincipal & {
  bearerToken: string;
  projects: Record<string, readonly ObjectStoragePermission[]>;
};

export interface ObjectStorageAuthorizer {
  authenticate(request: IncomingMessage): StoragePrincipal | null;
  allows(principal: StoragePrincipal, projectId: string, permission: ObjectStoragePermission): boolean;
}

export class StaticObjectStorageAuthorizer implements ObjectStorageAuthorizer {
  private readonly sessions = new Map<string, StaticStorageAccess>();

  constructor(entries: readonly StaticStorageAccess[]) {
    for (const entry of entries) {
      if (!entry.bearerToken || this.sessions.has(entry.bearerToken)) throw new Error("对象存储测试令牌无效或重复");
      this.sessions.set(entry.bearerToken, entry);
    }
  }

  authenticate(request: IncomingMessage): StoragePrincipal | null {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return null;
    const access = this.sessions.get(authorization.slice("Bearer ".length));
    return access ? { tenantId: access.tenantId, actorId: access.actorId } : null;
  }

  allows(principal: StoragePrincipal, projectId: string, permission: ObjectStoragePermission): boolean {
    return [...this.sessions.values()].some((access) => access.tenantId === principal.tenantId
      && access.actorId === principal.actorId
      && (access.projects[projectId]?.includes(permission) ?? false));
  }
}

export class ObjectStorageGatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type StoredObject = {
  objectKey: string;
  tenantId: string;
  projectId: string;
  assetId: string;
  mimeType: string;
  checksumSha256: string;
  body: Buffer;
  createdAt: string;
};

export type ObjectStorageAuditEvent = {
  id: string;
  tenantId: string;
  actorId: string;
  projectId: string;
  assetId: string;
  action: ObjectStorageGrantRequest["action"];
  outcome: "grant-issued" | "permission-denied" | "object-not-found" | "transfer-completed";
  createdAt: string;
};

type GrantRecord = {
  grant: ObjectStorageGrant;
  actorId: string;
  signature: string;
  expiresAtMs: number;
  used: boolean;
  inUse: boolean;
  checksumSha256?: string;
  mimeType?: string;
};

type GatewayOptions = {
  authorizer: ObjectStorageAuthorizer;
  signingSecret: string;
  clock?: () => number;
  ttlMs?: number;
  maxObjectBytes?: number;
};

export interface SignedObjectGateway {
  authenticate(request: IncomingMessage): StoragePrincipal | null;
  issueGrant(principal: StoragePrincipal, request: ObjectStorageGrantRequest): ObjectStorageGrant;
  upload(token: string, request: IncomingMessage): Promise<StoredObject>;
  download(token: string): StoredObject;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.byteLength;
    if (received > maxBytes) throw new ObjectStorageGatewayError(413, "storage_object_too_large", "上传内容超过签名允许的大小");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function safeSegment(value: string): string {
  const encoded = encodeURIComponent(value);
  return encoded.length <= 120
    ? encoded
    : `id-${createHash("sha256").update(value).digest("base64url").slice(0, 32)}`;
}

export class InMemorySignedObjectGateway implements SignedObjectGateway {
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly maxObjectBytes: number;
  private readonly grants = new Map<string, GrantRecord>();
  private readonly objects = new Map<string, StoredObject>();
  private readonly auditEvents: ObjectStorageAuditEvent[] = [];

  constructor(private readonly options: GatewayOptions) {
    if (options.signingSecret.length < 32) throw new Error("对象存储签名密钥至少需要 32 个字符");
    this.clock = options.clock ?? Date.now;
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.maxObjectBytes = options.maxObjectBytes ?? 32 * 1024 * 1024;
    if (this.ttlMs < 1_000 || this.ttlMs > 15 * 60 * 1000) throw new Error("对象存储签名有效期必须在 1 秒到 15 分钟之间");
  }

  authenticate(request: IncomingMessage): StoragePrincipal | null {
    return this.options.authorizer.authenticate(request);
  }

  listAuditEvents(): readonly ObjectStorageAuditEvent[] {
    return this.auditEvents.map((event) => ({ ...event }));
  }

  issueGrant(principal: StoragePrincipal, request: ObjectStorageGrantRequest): ObjectStorageGrant {
    const permission: ObjectStoragePermission = request.action === "upload" ? "asset:write" : "asset:read";
    if (!this.options.authorizer.allows(principal, request.projectId, permission)) {
      this.audit(principal, request, "permission-denied");
      throw new ObjectStorageGatewayError(403, "storage_permission_denied", "当前身份没有该项目的资产权限");
    }

    let objectKey: string;
    let maxBytes: number;
    let mimeType: string | undefined;
    let checksumSha256: string | undefined;
    if (request.action === "upload") {
      if (request.byteSize > this.maxObjectBytes) {
        throw new ObjectStorageGatewayError(413, "storage_object_too_large", "对象超过当前假存储网关的安全上限");
      }
      objectKey = `tenants/${safeSegment(principal.tenantId)}/projects/${safeSegment(request.projectId)}/assets/${safeSegment(request.assetId)}/${randomUUID()}`;
      maxBytes = request.byteSize;
      mimeType = request.mimeType.toLowerCase();
      checksumSha256 = request.checksumSha256;
    } else {
      const object = this.objects.get(request.objectKey);
      if (!object
        || object.tenantId !== principal.tenantId
        || object.projectId !== request.projectId
        || object.assetId !== request.assetId) {
        this.audit(principal, request, "object-not-found");
        throw new ObjectStorageGatewayError(404, "storage_object_not_found", "对象不存在或不属于当前租户项目");
      }
      objectKey = object.objectKey;
      maxBytes = object.body.byteLength;
    }

    const grantId = `storage-grant-${randomUUID()}`;
    const signature = this.sign(grantId);
    const expiresAtMs = this.clock() + this.ttlMs;
    const requiredHeaders = request.action === "upload"
      ? {
          "content-type": mimeType!,
          "x-content-sha256": checksumSha256!,
        }
      : {};
    const grant = ObjectStorageGrantSchema.parse({
      grantId,
      action: request.action,
      method: request.action === "upload" ? "PUT" : "GET",
      tenantId: principal.tenantId,
      projectId: request.projectId,
      assetId: request.assetId,
      objectKey,
      transferPath: `/v1/storage/transfers/${grantId}.${signature}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
      maxBytes,
      requiredHeaders,
      singleUse: true,
    });
    this.grants.set(grantId, {
      grant,
      actorId: principal.actorId,
      signature,
      expiresAtMs,
      used: false,
      inUse: false,
      checksumSha256,
      mimeType,
    });
    this.audit(principal, request, "grant-issued");
    return grant;
  }

  async upload(token: string, request: IncomingMessage): Promise<StoredObject> {
    const record = this.resolveGrant(token, "upload");
    record.inUse = true;
    try {
      for (const [name, expected] of Object.entries(record.grant.requiredHeaders)) {
        if (headerValue(request, name)?.toLowerCase() !== expected.toLowerCase()) {
          throw new ObjectStorageGatewayError(400, "storage_header_mismatch", `缺少或错误的签名请求头：${name}`);
        }
      }
      const declaredLength = headerValue(request, "content-length");
      if (declaredLength !== undefined && declaredLength !== String(record.grant.maxBytes)) {
        throw new ObjectStorageGatewayError(400, "storage_size_mismatch", "上传内容大小与签名不一致");
      }
      const body = await readBody(request, record.grant.maxBytes);
      if (body.byteLength !== record.grant.maxBytes) {
        throw new ObjectStorageGatewayError(400, "storage_size_mismatch", "上传内容大小与签名不一致");
      }
      const checksumSha256 = `sha256:${createHash("sha256").update(body).digest("hex")}`;
      if (checksumSha256 !== record.checksumSha256) {
        throw new ObjectStorageGatewayError(422, "storage_checksum_mismatch", "上传内容摘要与签名不一致");
      }
      const object: StoredObject = {
        objectKey: record.grant.objectKey,
        tenantId: record.grant.tenantId,
        projectId: record.grant.projectId,
        assetId: record.grant.assetId,
        mimeType: record.mimeType!,
        checksumSha256,
        body,
        createdAt: new Date(this.clock()).toISOString(),
      };
      this.objects.set(object.objectKey, object);
      record.used = true;
      this.auditFromRecord(record, "transfer-completed");
      return { ...object, body: Buffer.from(object.body) };
    } finally {
      record.inUse = false;
    }
  }

  download(token: string): StoredObject {
    const record = this.resolveGrant(token, "download");
    const object = this.objects.get(record.grant.objectKey);
    if (!object) throw new ObjectStorageGatewayError(404, "storage_object_not_found", "对象不存在");
    record.used = true;
    this.auditFromRecord(record, "transfer-completed");
    return { ...object, body: Buffer.from(object.body) };
  }

  private resolveGrant(token: string, action: ObjectStorageGrantRequest["action"]): GrantRecord {
    const separator = token.lastIndexOf(".");
    if (separator <= 0) throw new ObjectStorageGatewayError(403, "invalid_storage_grant", "对象存储签名无效");
    const grantId = token.slice(0, separator);
    const suppliedSignature = token.slice(separator + 1);
    const record = this.grants.get(grantId);
    const expectedSignature = this.sign(grantId);
    const suppliedBytes = Buffer.from(suppliedSignature);
    const expectedBytes = Buffer.from(expectedSignature);
    if (!record
      || suppliedBytes.byteLength !== expectedBytes.byteLength
      || !timingSafeEqual(suppliedBytes, expectedBytes)
      || suppliedSignature !== record.signature) {
      throw new ObjectStorageGatewayError(403, "invalid_storage_grant", "对象存储签名无效");
    }
    if (this.clock() >= record.expiresAtMs) throw new ObjectStorageGatewayError(410, "storage_grant_expired", "对象存储签名已过期");
    if (record.used || record.inUse) throw new ObjectStorageGatewayError(409, "storage_grant_consumed", "对象存储签名已使用");
    if (record.grant.action !== action) throw new ObjectStorageGatewayError(405, "storage_grant_action_mismatch", "对象存储签名操作不匹配");
    return record;
  }

  private sign(grantId: string): string {
    return createHmac("sha256", this.options.signingSecret).update(grantId).digest("base64url");
  }

  private audit(
    principal: StoragePrincipal,
    request: ObjectStorageGrantRequest,
    outcome: ObjectStorageAuditEvent["outcome"],
  ): void {
    this.auditEvents.push({
      id: `storage-audit-${randomUUID()}`,
      tenantId: principal.tenantId,
      actorId: principal.actorId,
      projectId: request.projectId,
      assetId: request.assetId,
      action: request.action,
      outcome,
      createdAt: new Date(this.clock()).toISOString(),
    });
  }

  private auditFromRecord(record: GrantRecord, outcome: ObjectStorageAuditEvent["outcome"]): void {
    this.auditEvents.push({
      id: `storage-audit-${randomUUID()}`,
      tenantId: record.grant.tenantId,
      actorId: record.actorId,
      projectId: record.grant.projectId,
      assetId: record.grant.assetId,
      action: record.grant.action,
      outcome,
      createdAt: new Date(this.clock()).toISOString(),
    });
  }
}
