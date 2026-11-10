import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrateLegacyObjects } from "../apps/api/src/legacyWorkspaceMigration.ts";

function fixture() {
  const projectId = randomUUID();
  const mapping = { objectIds: { image: randomUUID(), tool: randomUUID(), text: randomUUID() },
    assetVersions: { "old-asset": randomUUID() }, templateVersions: { "old-tool": randomUUID() } };
  const legacy = { schemaVersion: 2, id: "old-canvas", projectId: "old-project", revision: 12,
    updatedAt: "2026-11-09T00:00:00Z", viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: "image", type: "image", position: { x: 10, y: 20 }, data: { title: "产品", assetId: "old-asset" } },
      { id: "tool", type: "tool", position: { x: 400, y: 20 }, data: { title: "工具", toolId: "old-tool" } },
      { id: "text", type: "text", position: { x: 20, y: 400 }, data: { title: "说明", body: "用户确认事实" } },
    ], edges: [{ id: "old-edge", source: "image", target: "tool", kind: "workflow", editable: true, deletable: true }],
  };
  return { projectId, mapping, legacy };
}
describe("旧对象到双层协议的显式迁移", () => {
  it("保留文字和位置、映射固定资产，旧工作流边隔离且原文档不变", () => {
    const f = fixture(), before = structuredClone(f.legacy);
    const result = migrateLegacyObjects(f.legacy, f.projectId, f.mapping);
    expect(result.objects).toHaveLength(3);
    expect(result.objects[0]).toMatchObject({ id: f.mapping.objectIds.image, x: 10, y: 20, assetVersionId: f.mapping.assetVersions["old-asset"] });
    expect(result.quarantinedEdges).toEqual(f.legacy.edges);
    expect(result.objects[2]).toMatchObject({ title: "说明", text: "用户确认事实" });
    expect(result.sourceDocument).toEqual(f.legacy);
    expect(result.executionAuthorized).toBe(false); expect(f.legacy).toEqual(before);
  });
  it("缺少资产映射、对象重复映射和未知类型拒绝整份迁移", () => {
    const f = fixture();
    expect(() => migrateLegacyObjects(f.legacy, f.projectId, { ...f.mapping, assetVersions: {} })).toThrow();
    expect(() => migrateLegacyObjects(f.legacy, f.projectId, { ...f.mapping, objectIds: { ...f.mapping.objectIds, tool: f.mapping.objectIds.image } })).toThrow("EXPLICIT_UNIQUE");
    f.legacy.nodes[0].type = "video";
    expect(() => migrateLegacyObjects(f.legacy, f.projectId, f.mapping)).toThrow("UNSUPPORTED_LEGACY_OBJECT");
  });
  it("未知未来文档版本拒绝，不默认降级", () => {
    const f = fixture();
    expect(() => migrateLegacyObjects({ ...f.legacy, schemaVersion: 999 }, f.projectId, f.mapping)).toThrow("高于");
  });
});
