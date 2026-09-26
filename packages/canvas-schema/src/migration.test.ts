import { describe, expect, it } from "vitest";
import { migrateCanvasDocument } from "./index";
import { migrateCanvasDocumentLight } from "./light";

const legacy = {
  id: "canvas-legacy",
  projectId: "project-1",
  nodes: [],
  edges: [{ id: "edge-1", source: "a", target: "b" }],
  viewport: { x: 0, y: 0, zoom: 1 },
  updatedAt: "2026-09-27T00:00:00+08:00",
};

describe("画布迁移器", () => {
  it("将无版本旧文档迁移到当前版本，并保留旧连线为工作流边", () => {
    const migrated = migrateCanvasDocument(legacy);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.revision).toBe(0);
    expect(migrated.edges[0]).toMatchObject({ kind: "workflow", editable: true, deletable: true });
  });

  it("将 v1 文档迁移到支持分组关系的 v2", () => {
    const migrated = migrateCanvasDocument({
      ...legacy,
      schemaVersion: 1,
      revision: 3,
      edges: [],
    });
    expect(migrated).toMatchObject({ schemaVersion: 2, revision: 3 });
  });

  it("拒绝未来版本，避免旧客户端静默破坏数据", () => {
    expect(() => migrateCanvasDocument({ ...legacy, schemaVersion: 99 })).toThrow(/高于当前支持版本/);
  });

  it("浏览器轻量迁移器保持同一版本语义并拒绝内嵌媒体", () => {
    expect(migrateCanvasDocumentLight(legacy)).toMatchObject({ schemaVersion: 2, revision: 0 });
    expect(() => migrateCanvasDocumentLight({
      ...legacy,
      nodes: [{ id: "image", type: "image", position: { x: 0, y: 0 }, data: { title: "图片", src: "data:image/png;base64,AAAA" } }],
    })).toThrow(/禁止保存 Data URL/);
  });
});
