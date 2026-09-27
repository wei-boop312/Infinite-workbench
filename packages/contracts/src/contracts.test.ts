import { describe, expect, it } from "vitest";
import {
  CanvasDocumentSchema,
  LineageEdgeSchema,
  ObjectStorageGrantSchema,
  ObjectStorageGrantRequestSchema,
  ProviderConnectionSchema,
} from "./index";

const validDocument = {
  schemaVersion: 2,
  id: "canvas-1",
  projectId: "project-1",
  revision: 0,
  nodes: [{
    id: "node-1",
    type: "image",
    position: { x: 0, y: 0 },
    data: { title: "商品原图", assetId: "asset-1" },
  }],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  updatedAt: "2026-09-27T00:00:00+08:00",
} as const;

describe("阶段 0 数据合同", () => {
  it("接受通过 assetId 引用媒体的画布", () => {
    expect(CanvasDocumentSchema.parse(validDocument).nodes[0].data.assetId).toBe("asset-1");
  });

  it("拒绝把 Base64 媒体写入画布 JSON", () => {
    const unsafe = structuredClone(validDocument) as Record<string, unknown>;
    const nodes = unsafe.nodes as Array<Record<string, unknown>>;
    nodes[0].data = { title: "错误节点", src: "data:image/png;base64,AAAA" };
    expect(() => CanvasDocumentSchema.parse(unsafe)).toThrow(/Data URL/);
  });

  it("拒绝把生成谱系改成可编辑关系", () => {
    expect(() => LineageEdgeSchema.parse({
      id: "edge-1",
      source: "node-1",
      target: "node-2",
      kind: "lineage",
      runJobId: "job-1",
      editable: true,
      deletable: false,
    })).toThrow();
  });

  it("拒绝在供应商连接中直接保存 API Key", () => {
    expect(() => ProviderConnectionSchema.parse({
      id: "provider-1",
      name: "兼容接口",
      protocol: "openai-compatible",
      baseUrl: "https://example.com/v1",
      authRef: "secret-ref-1",
      apiKey: "should-not-be-here",
      capabilities: ["image-generate"],
      enabled: true,
    })).toThrow();
  });

  it("对象存储上传签名必须绑定项目、资产、大小和完整摘要", () => {
    expect(ObjectStorageGrantRequestSchema.parse({
      action: "upload",
      projectId: "project-1",
      assetId: "asset-1",
      mimeType: "image/png",
      byteSize: 4,
      checksumSha256: `sha256:${"a".repeat(64)}`,
    })).toMatchObject({ action: "upload", byteSize: 4 });
    expect(() => ObjectStorageGrantRequestSchema.parse({
      action: "upload",
      projectId: "project-1",
      assetId: "asset-1",
      mimeType: "image/png",
      byteSize: 4,
    })).toThrow();
  });

  it("下载签名不接受客户端伪造上传元数据", () => {
    expect(() => ObjectStorageGrantRequestSchema.parse({
      action: "download",
      projectId: "project-1",
      assetId: "asset-1",
      objectKey: "tenants/t-1/projects/project-1/assets/asset-1/object",
      byteSize: 1,
    })).toThrow();
  });

  it("上传和下载凭证的方法不能互换", () => {
    expect(() => ObjectStorageGrantSchema.parse({
      grantId: "grant-1",
      action: "upload",
      method: "GET",
      tenantId: "tenant-1",
      projectId: "project-1",
      assetId: "asset-1",
      objectKey: "tenants/tenant-1/projects/project-1/assets/asset-1/object",
      transferPath: "/v1/storage/transfers/grant.signature",
      expiresAt: "2026-09-27T00:00:00+08:00",
      maxBytes: 1,
      requiredHeaders: {},
      singleUse: true,
    })).toThrow();
  });
});
