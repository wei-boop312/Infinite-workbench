import type { CanvasEdge, CanvasNode } from "./model";

function topLevelId(nodeId: string, nodeById: Map<string, CanvasNode>): string {
  let current = nodeById.get(nodeId);
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    current = nodeById.get(current.parentId);
  }
  return current?.id ?? nodeId;
}

export function layoutCanvas(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const topLevel = nodes.filter((node) => !node.parentId);
  const topLevelIds = new Set(topLevel.map((node) => node.id));
  const incoming = new Map(topLevel.map((node) => [node.id, 0]));
  const outgoing = new Map<string, Set<string>>();

  for (const edge of edges) {
    const source = topLevelId(edge.source, nodeById);
    const target = topLevelId(edge.target, nodeById);
    if (source === target || !topLevelIds.has(source) || !topLevelIds.has(target)) continue;
    const targets = outgoing.get(source) ?? new Set<string>();
    if (!targets.has(target)) {
      targets.add(target);
      outgoing.set(source, targets);
      incoming.set(target, (incoming.get(target) ?? 0) + 1);
    }
  }

  const queue = topLevel
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .sort((a, b) => a.position.y - b.position.y)
    .map((node) => node.id);
  const level = new Map(queue.map((id) => [id, 0]));
  const ordered: string[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    ordered.push(current);
    for (const target of outgoing.get(current) ?? []) {
      level.set(target, Math.max(level.get(target) ?? 0, (level.get(current) ?? 0) + 1));
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }

  for (const node of topLevel) {
    if (!ordered.includes(node.id)) {
      ordered.push(node.id);
      level.set(node.id, level.get(node.id) ?? 0);
    }
  }

  const rows = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const id of ordered) {
    const column = level.get(id) ?? 0;
    const row = rows.get(column) ?? 0;
    positions.set(id, { x: 90 + column * 330, y: 90 + row * 230 });
    rows.set(column, row + 1);
  }

  return nodes.map((node) => node.parentId
    ? node
    : { ...node, position: positions.get(node.id) ?? node.position });
}

