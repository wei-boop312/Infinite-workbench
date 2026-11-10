import { describe, expect, it } from "vitest";
import { documentToSnapshot, snapshotToDocument } from "../apps/web/src/canvas/document";
import { createHistoryState, historyReducer } from "../apps/web/src/canvas/history";
import { semanticEdges, semanticNodes, type CanvasSnapshot, type GroupNode } from "../apps/web/src/canvas/model";

describe("画布历史与文档", () => {
  it("模拟任务来源经过文档往返后保留且不伪造图片资产", () => {
    const snapshot: CanvasSnapshot = { nodes: [{
      id: "run-result-job-1", type: "studio", position: { x: 0, y: 0 },
      data: { kind: "output", title: "模拟结果", subtitle: "未生成图片", accent: "#34d399", runJobId: "job-1", runBatchId: "batch-1", constraintSnapshotId: "constraint-1" },
    }], edges: [] };
    const restored = documentToSnapshot(snapshotToDocument("canvas-1", "project-1", 0, snapshot, { x: 0, y: 0, zoom: 1 }));
    expect(restored.nodes[0].data).toMatchObject({ runJobId: "job-1", runBatchId: "batch-1", constraintSnapshotId: "constraint-1" });
    expect(restored.nodes[0].data.assetId).toBeUndefined();
  });
  it("一次拖动手势只产生一个撤销点", () => {
    const start: CanvasSnapshot = { nodes: semanticNodes, edges: semanticEdges };
    const middle: CanvasSnapshot = {
      ...start,
      nodes: start.nodes.map((node, index) => index === 0 ? { ...node, position: { x: 100, y: 130 } } : node),
    };
    const end: CanvasSnapshot = {
      ...middle,
      nodes: middle.nodes.map((node, index) => index === 0 ? { ...node, position: { x: 140, y: 170 } } : node),
    };

    let history = createHistoryState(start);
    history = historyReducer(history, { type: "gesture", next: middle });
    history = historyReducer(history, { type: "gesture-commit", next: end });
    expect(history.past).toHaveLength(1);
    history = historyReducer(history, { type: "undo" });
    expect(history.present.nodes[0].position).toEqual(start.nodes[0].position);
    history = historyReducer(history, { type: "redo" });
    expect(history.present.nodes[0].position).toEqual(end.nodes[0].position);
  });

  it("分组父子关系经过 v2 文档往返后保持不变", () => {
    const group: GroupNode = {
      id: "group-1",
      type: "group",
      position: { x: 20, y: 30 },
      data: { kind: "group", title: "测试分组", accent: "#64748b" },
      style: { width: 500, height: 320 },
    };
    const child = { ...semanticNodes[0], parentId: group.id, extent: "parent" as const, position: { x: 40, y: 60 } };
    const snapshot: CanvasSnapshot = { nodes: [group, child], edges: [] };
    const document = snapshotToDocument("canvas-1", "project-1", 0, snapshot, { x: 0, y: 0, zoom: 1 });
    expect(document.schemaVersion).toBe(2);
    expect(document.nodes[1].parentId).toBe("group-1");
    const restored = documentToSnapshot(document);
    expect(restored.nodes[1]).toMatchObject({ parentId: "group-1", extent: "parent", position: { x: 40, y: 60 } });
  });
});
