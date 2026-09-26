import type { Edge, Node, XYPosition } from "@xyflow/react";

export type StudioKind = "image" | "video" | "constraint" | "action" | "output" | "text";

export type StudioNodeData = {
  kind: StudioKind;
  title: string;
  subtitle: string;
  badge?: string;
  accent: string;
  assetId?: string;
  body?: string;
};

export type GroupNodeData = {
  kind: "group";
  title: string;
  accent: string;
};

export type StudioNode = Node<StudioNodeData, "studio">;
export type GroupNode = Node<GroupNodeData, "group">;
export type CanvasNode = StudioNode | GroupNode;

export type CanvasEdgeData = {
  kind: "workflow" | "lineage";
  runJobId?: string;
};

export type CanvasEdge = Edge<CanvasEdgeData>;

export type CanvasSnapshot = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
};

export const semanticNodes: CanvasNode[] = [
  { id: "product", type: "studio", position: { x: 80, y: 120 }, data: { kind: "image", title: "商品原图", subtitle: "asset-product-demo · 不存 Base64", badge: "已锁定", accent: "#60a5fa", assetId: "asset-product-demo" }, style: { width: 210, height: 160 } },
  { id: "brand", type: "studio", position: { x: 90, y: 360 }, data: { kind: "constraint", title: "品牌与文案约束", subtitle: "人决定不可修改项", badge: "人工确认", accent: "#f59e0b" }, style: { width: 220, height: 148 } },
  { id: "retouch", type: "studio", position: { x: 430, y: 220 }, data: { kind: "action", title: "产品精修", subtitle: "模型、预算和范围执行前确认", badge: "假执行器", accent: "#a78bfa" }, style: { width: 250, height: 180 } },
  { id: "output-a", type: "studio", position: { x: 820, y: 100 }, data: { kind: "output", title: "精修结果 A", subtitle: "不可变生成谱系", badge: "版本 1", accent: "#34d399" }, style: { width: 220, height: 160 } },
  { id: "output-b", type: "studio", position: { x: 820, y: 330 }, data: { kind: "output", title: "精修结果 B", subtitle: "可继续局部修改", badge: "版本 2", accent: "#34d399" }, style: { width: 220, height: 160 } },
  { id: "video", type: "studio", position: { x: 1180, y: 230 }, data: { kind: "video", title: "视频镜头占位", subtitle: "时长、帧率与代理文件", badge: "阶段 7", accent: "#fb7185" }, style: { width: 230, height: 170 } },
];

export const semanticEdges: CanvasEdge[] = [
  { id: "workflow-product", source: "product", target: "retouch", targetHandle: "product", type: "smoothstep", animated: true, className: "edge-workflow", data: { kind: "workflow" } },
  { id: "workflow-brand", source: "brand", target: "retouch", targetHandle: "constraint", type: "smoothstep", animated: true, className: "edge-workflow", data: { kind: "workflow" } },
  { id: "lineage-a", source: "retouch", sourceHandle: "output", target: "output-a", targetHandle: "input", type: "smoothstep", deletable: false, selectable: false, className: "edge-lineage", data: { kind: "lineage", runJobId: "mock-job-a" } },
  { id: "lineage-b", source: "retouch", sourceHandle: "output", target: "output-b", targetHandle: "input", type: "smoothstep", deletable: false, selectable: false, className: "edge-lineage", data: { kind: "lineage", runJobId: "mock-job-b" } },
  { id: "workflow-video", source: "output-b", sourceHandle: "output", target: "video", targetHandle: "input", type: "smoothstep", className: "edge-workflow", data: { kind: "workflow" } },
];

export function createId(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

export function createImageNode(position: XYPosition): StudioNode {
  const id = createId("image");
  return {
    id,
    type: "studio",
    position,
    selected: true,
    data: {
      kind: "image",
      title: "新图片资产",
      subtitle: "轻量 assetId 引用",
      badge: "本地占位",
      accent: "#60a5fa",
      assetId: `asset-${id}`,
    },
    style: { width: 220, height: 160 },
  };
}

export function createTextNode(position: XYPosition): StudioNode {
  return {
    id: createId("text"),
    type: "studio",
    position,
    selected: true,
    data: {
      kind: "text",
      title: "文案节点",
      subtitle: "双击选择后在右侧编辑",
      accent: "#22d3ee",
      body: "输入由人确认的文案与设计意图。",
    },
    style: { width: 240, height: 168 },
  };
}

export function createStressNodes(count: number): CanvasNode[] {
  const columns = Math.ceil(Math.sqrt(count));
  const kinds: StudioKind[] = ["image", "constraint", "action", "output", "video", "text"];
  const accents = ["#60a5fa", "#f59e0b", "#a78bfa", "#34d399", "#fb7185", "#22d3ee"];
  return Array.from({ length: count }, (_, index) => {
    const kind = kinds[index % kinds.length];
    return {
      id: `stress-${count}-${index}`,
      type: "studio",
      position: { x: (index % columns) * 230, y: Math.floor(index / columns) * 165 },
      data: { kind, title: `节点 ${index + 1}`, subtitle: index % 3 === 0 ? "仅渲染视口内元素" : "轻量验证数据", accent: accents[index % accents.length] },
      style: { width: 190, height: 126 },
    } satisfies StudioNode;
  });
}

