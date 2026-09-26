import { describe, expect, it } from "vitest";
import {
  CanvasDocumentSchema,
  LineageEdgeSchema,
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
});
