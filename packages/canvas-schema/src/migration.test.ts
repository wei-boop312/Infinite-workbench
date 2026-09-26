import { describe, expect, it } from "vitest";
import { migrateCanvasDocument } from "./index";

const legacy = {
  id: "canvas-legacy",
  projectId: "project-1",
  nodes: [],
  edges: [{ id: "edge-1", source: "a", target: "b" }],
  viewport: { x: 0, y: 0, zoom: 1 },
  updatedAt: "2026-09-27T00:00:00+08:00",
};

describe("画布迁移器", () => {
  it("将无版本旧文档迁移到 v1，并保留旧连线为工作流边", () => {
    const migrated = migrateCanvasDocument(legacy);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.revision).toBe(0);
    expect(migrated.edges[0]).toMatchObject({ kind: "workflow", editable: true, deletable: true });
  });

  it("拒绝未来版本，避免旧客户端静默破坏数据", () => {
    expect(() => migrateCanvasDocument({ ...legacy, schemaVersion: 99 })).toThrow(/高于当前支持版本/);
  });
});

