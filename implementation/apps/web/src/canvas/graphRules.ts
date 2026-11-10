import type { CanvasEdge, CanvasNode, StudioKind } from "./model";

export type PortDataType = "image" | "video" | "text" | "constraint";
export type ConnectionValidation = { valid: true; dataType: PortDataType } | { valid: false; reason: string };
type GraphConnection = {
  source: string | null;
  target: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

function nodeKind(node: CanvasNode): StudioKind | "group" {
  return node.data.kind;
}

function outputType(kind: StudioKind | "group", handle: string | null | undefined): PortDataType | null {
  if (handle !== "output") return null;
  if (kind === "image" || kind === "action" || kind === "output") return "image";
  if (kind === "video") return "video";
  if (kind === "text") return "text";
  if (kind === "constraint") return "constraint";
  return null;
}

function acceptedInputs(kind: StudioKind | "group", handle: string | null | undefined): PortDataType[] {
  if (kind === "action" && handle === "product") return ["image"];
  if (kind === "action" && handle === "constraint") return ["constraint", "text"];
  if ((kind === "output" || kind === "video") && handle === "input") return ["image"];
  return [];
}

export function wouldCreateWorkflowCycle(
  source: string,
  target: string,
  edges: CanvasEdge[],
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.data?.kind === "lineage") continue;
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }

  const visited = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === source) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export function validateConnection(
  connection: GraphConnection,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): ConnectionValidation {
  if (!connection.source || !connection.target) return { valid: false, reason: "连接缺少起点或终点" };
  if (connection.source === connection.target) return { valid: false, reason: "节点不能连接到自身" };

  const sourceNode = nodes.find((node) => node.id === connection.source);
  const targetNode = nodes.find((node) => node.id === connection.target);
  if (!sourceNode || !targetNode) return { valid: false, reason: "连接节点不存在" };

  const dataType = outputType(nodeKind(sourceNode), connection.sourceHandle);
  if (!dataType) return { valid: false, reason: "该起点没有可用输出端口" };
  const accepted = acceptedInputs(nodeKind(targetNode), connection.targetHandle);
  if (!accepted.includes(dataType)) {
    return { valid: false, reason: `${dataType} 输出与目标端口不兼容` };
  }

  const duplicate = edges.some((edge) =>
    edge.source === connection.source
    && edge.target === connection.target
    && (edge.sourceHandle ?? "output") === (connection.sourceHandle ?? "output")
    && (edge.targetHandle ?? null) === (connection.targetHandle ?? null));
  if (duplicate) return { valid: false, reason: "相同端口已经连接" };
  if (wouldCreateWorkflowCycle(connection.source, connection.target, edges)) {
    return { valid: false, reason: "该连接会形成循环工作流" };
  }

  return { valid: true, dataType };
}
