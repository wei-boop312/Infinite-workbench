import { describe, expect, it } from "vitest";
import { layoutCanvas } from "../apps/web/src/canvas/autoLayout";
import { validateConnection, wouldCreateWorkflowCycle } from "../apps/web/src/canvas/graphRules";
import { semanticEdges, semanticNodes, type CanvasEdge, type CanvasNode } from "../apps/web/src/canvas/model";

describe("端口规则与自动布局", () => {
  it("允许图片进入产品端口，并拒绝约束进入产品端口", () => {
    expect(validateConnection({ source: "product", sourceHandle: "output", target: "retouch", targetHandle: "product" }, semanticNodes, []).valid).toBe(true);
    const invalid = validateConnection({ source: "brand", sourceHandle: "output", target: "retouch", targetHandle: "product" }, semanticNodes, []);
    expect(invalid).toMatchObject({ valid: false, reason: expect.stringContaining("不兼容") });
  });

  it("拒绝重复连接和循环连接", () => {
    const duplicate = validateConnection({ source: "product", sourceHandle: "output", target: "retouch", targetHandle: "product" }, semanticNodes, semanticEdges);
    expect(duplicate).toMatchObject({ valid: false, reason: "相同端口已经连接" });

    const edges: CanvasEdge[] = [
      { id: "a-b", source: "a", target: "b", data: { kind: "workflow" } },
      { id: "b-c", source: "b", target: "c", data: { kind: "workflow" } },
    ];
    expect(wouldCreateWorkflowCycle("c", "a", edges)).toBe(true);
  });

  it("自动布局按依赖分列且不改变分组子节点的相对坐标", () => {
    const group: CanvasNode = {
      id: "group-1",
      type: "group",
      position: { x: 0, y: 0 },
      data: { kind: "group", title: "组", accent: "#64748b" },
    };
    const child: CanvasNode = { ...semanticNodes[0], id: "child", parentId: "group-1", extent: "parent", position: { x: 25, y: 35 } };
    const action: CanvasNode = { ...semanticNodes[2], id: "action" };
    const laidOut = layoutCanvas([group, child, action], [{ id: "edge", source: "child", target: "action", data: { kind: "workflow" } }]);
    expect(laidOut.find((node) => node.id === "child")?.position).toEqual({ x: 25, y: 35 });
    expect(laidOut.find((node) => node.id === "action")!.position.x).toBeGreaterThan(laidOut.find((node) => node.id === "group-1")!.position.x);
  });
});

