import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ObjectStorageGrant } from "@canvas/contracts";
import { createApiServer } from "../apps/api/src/index";
import {
  InMemorySignedObjectGateway,
  StaticObjectStorageAuthorizer,
} from "../apps/api/src/objectStorageGateway";

const runningServers: Server[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(server: Server): Promise<string> {
  runningServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP 端口");
  return `http://127.0.0.1:${address.port}`;
}

function createGateway(clock: () => number = Date.now) {
  const authorizer = new StaticObjectStorageAuthorizer([
    {
      bearerToken: "owner-token",
      tenantId: "tenant-a",
      actorId: "owner",
      projects: { "project-shared": ["asset:read", "asset:write"] },
    },
    {
      bearerToken: "viewer-token",
      tenantId: "tenant-a",
      actorId: "viewer",
      projects: { "project-shared": ["asset:read"] },
    },
    {
      bearerToken: "other-tenant-token",
      tenantId: "tenant-b",
      actorId: "other-owner",
      projects: { "project-shared": ["asset:read", "asset:write"] },
    },
  ]);
  return new InMemorySignedObjectGateway({
    authorizer,
    signingSecret: "phase-2-local-signing-secret-is-not-a-real-credential",
    clock,
    ttlMs: 60_000,
    maxObjectBytes: 1024 * 1024,
  });
}

async function requestGrant(
  baseUrl: string,
  bearerToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/v1/storage/grants`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function uploadFixture(baseUrl: string, gateway: InMemorySignedObjectGateway) {
  const body = Buffer.from("tenant-scoped-object", "utf8");
  const checksumSha256 = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const grantResponse = await requestGrant(baseUrl, "owner-token", {
    action: "upload",
    projectId: "project-shared",
    assetId: "asset-a",
    mimeType: "image/png",
    byteSize: body.byteLength,
    checksumSha256,
  });
  expect(grantResponse.status).toBe(201);
  const grant = await grantResponse.json() as ObjectStorageGrant;
  const uploadResponse = await fetch(`${baseUrl}${grant.transferPath}`, {
    method: "PUT",
    headers: grant.requiredHeaders,
    body,
  });
  expect(uploadResponse.status).toBe(201);
  expect(uploadResponse.headers.get("x-object-key")).toBe(grant.objectKey);
  expect(uploadResponse.headers.get("x-content-sha256")).toBe(checksumSha256);
  return { body, grant, gateway };
}

describe("对象存储服务端安全边界", () => {
  it("默认不启用签名服务，也不会隐式连接云存储", async () => {
    const baseUrl = await listen(createApiServer());
    const health = await fetch(`${baseUrl}/health`);
    expect(await health.json()).toMatchObject({
      realExecutorsEnabled: false,
      objectStorageSigningEnabled: false,
    });
    const response = await requestGrant(baseUrl, "owner-token", {
      action: "download",
      projectId: "project-shared",
      assetId: "asset-a",
      objectKey: "guessed-key",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "storage_signing_not_configured" });
  });

  it("签发短时单次凭证，并完成受校验的上传和下载", async () => {
    const gateway = createGateway();
    const baseUrl = await listen(createApiServer({ objectStorageGateway: gateway }));
    const anonymous = await fetch(`${baseUrl}/v1/storage/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "download",
        projectId: "project-shared",
        assetId: "asset-a",
        objectKey: "guessed-key",
      }),
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "storage_authentication_required" });

    const { body, grant } = await uploadFixture(baseUrl, gateway);
    expect(grant).toMatchObject({
      action: "upload",
      method: "PUT",
      tenantId: "tenant-a",
      projectId: "project-shared",
      assetId: "asset-a",
      maxBytes: body.byteLength,
      singleUse: true,
    });
    expect(grant.objectKey).toMatch(/^tenants\/tenant-a\/projects\/project-shared\/assets\/asset-a\//);

    const reusedUpload = await fetch(`${baseUrl}${grant.transferPath}`, {
      method: "PUT",
      headers: grant.requiredHeaders,
      body,
    });
    expect(reusedUpload.status).toBe(409);
    expect(await reusedUpload.json()).toEqual({ error: "storage_grant_consumed" });

    const downloadGrantResponse = await requestGrant(baseUrl, "owner-token", {
      action: "download",
      projectId: "project-shared",
      assetId: "asset-a",
      objectKey: grant.objectKey,
    });
    expect(downloadGrantResponse.status).toBe(201);
    const downloadGrant = await downloadGrantResponse.json() as ObjectStorageGrant;
    const downloadResponse = await fetch(`${baseUrl}${downloadGrant.transferPath}`);
    expect(downloadResponse.status).toBe(200);
    expect(Buffer.from(await downloadResponse.arrayBuffer())).toEqual(body);
    expect(gateway.listAuditEvents().map((event) => event.outcome)).toEqual([
      "grant-issued",
      "transfer-completed",
      "grant-issued",
      "transfer-completed",
    ]);
  });

  it("内容摘要不一致时拒绝落盘，但允许用同一未消费签名纠正重试", async () => {
    const gateway = createGateway();
    const baseUrl = await listen(createApiServer({ objectStorageGateway: gateway }));
    const expectedBody = Buffer.from("integrity-a", "utf8");
    const tamperedBody = Buffer.from("integrity-b", "utf8");
    const checksumSha256 = `sha256:${createHash("sha256").update(expectedBody).digest("hex")}`;
    const grantResponse = await requestGrant(baseUrl, "owner-token", {
      action: "upload",
      projectId: "project-shared",
      assetId: "asset-integrity",
      mimeType: "image/png",
      byteSize: expectedBody.byteLength,
      checksumSha256,
    });
    const grant = await grantResponse.json() as ObjectStorageGrant;

    const rejected = await fetch(`${baseUrl}${grant.transferPath}`, {
      method: "PUT",
      headers: grant.requiredHeaders,
      body: tamperedBody,
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toEqual({ error: "storage_checksum_mismatch" });

    const corrected = await fetch(`${baseUrl}${grant.transferPath}`, {
      method: "PUT",
      headers: grant.requiredHeaders,
      body: expectedBody,
    });
    expect(corrected.status).toBe(201);
  });

  it("同名项目也不能跨租户读取对象，且只读成员不能申请上传", async () => {
    const gateway = createGateway();
    const baseUrl = await listen(createApiServer({ objectStorageGateway: gateway }));
    const { grant } = await uploadFixture(baseUrl, gateway);

    const crossTenant = await requestGrant(baseUrl, "other-tenant-token", {
      action: "download",
      projectId: "project-shared",
      assetId: "asset-a",
      objectKey: grant.objectKey,
    });
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.json()).toEqual({ error: "storage_object_not_found" });

    const readOnlyUpload = await requestGrant(baseUrl, "viewer-token", {
      action: "upload",
      projectId: "project-shared",
      assetId: "asset-a",
      mimeType: "image/png",
      byteSize: 1,
      checksumSha256: `sha256:${"0".repeat(64)}`,
    });
    expect(readOnlyUpload.status).toBe(403);
    expect(await readOnlyUpload.json()).toEqual({ error: "storage_permission_denied" });

    const readOnlyDownload = await requestGrant(baseUrl, "viewer-token", {
      action: "download",
      projectId: "project-shared",
      assetId: "asset-a",
      objectKey: grant.objectKey,
    });
    expect(readOnlyDownload.status).toBe(201);
    const viewerGrant = await readOnlyDownload.json() as ObjectStorageGrant;
    expect((await fetch(`${baseUrl}${viewerGrant.transferPath}`)).status).toBe(200);
  });

  it("拒绝过期签名和被篡改的签名", async () => {
    let now = Date.parse("2026-09-27T10:00:00+08:00");
    const gateway = createGateway(() => now);
    const baseUrl = await listen(createApiServer({ objectStorageGateway: gateway }));
    const body = Buffer.from("expires", "utf8");
    const checksumSha256 = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const grantResponse = await requestGrant(baseUrl, "owner-token", {
      action: "upload",
      projectId: "project-shared",
      assetId: "asset-expiring",
      mimeType: "image/png",
      byteSize: body.byteLength,
      checksumSha256,
    });
    const grant = await grantResponse.json() as ObjectStorageGrant;

    const tamperedPath = `${grant.transferPath.slice(0, -1)}${grant.transferPath.endsWith("a") ? "b" : "a"}`;
    const tampered = await fetch(`${baseUrl}${tamperedPath}`, { method: "PUT", headers: grant.requiredHeaders, body });
    expect(tampered.status).toBe(403);
    expect(await tampered.json()).toEqual({ error: "invalid_storage_grant" });

    now += 60_001;
    const expired = await fetch(`${baseUrl}${grant.transferPath}`, { method: "PUT", headers: grant.requiredHeaders, body });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: "storage_grant_expired" });
  });
});
