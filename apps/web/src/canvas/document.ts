import type { CanvasDocument } from "@canvas/contracts";
import type { Viewport } from "@xyflow/react";
import type { CanvasEdge, CanvasNode, CanvasSnapshot, StudioKind } from "./model";

const DEFAULT_ACCENTS: Record<StudioKind, string> = {
  image: "#60a5fa",
  video: "#fb7185",
  constraint: "#f59e0b",
  action: "#a78bfa",
  output: "#34d399",
  text: "#22d3ee",
};

function numericSize(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function snapshotToDocument(
  id: string,
  projectId: string,
  revision: number,
  snapshot: CanvasSnapshot,
  viewport: Viewport,
): CanvasDocument {
  return {
    schemaVersion: 2,
    id,
    projectId,
    revision,
    nodes: snapshot.nodes.map((node) => {
      const width = node.measured?.width ?? numericSize(node.style?.width, node.type === "group" ? 500 : 220);
      const height = node.measured?.height ?? numericSize(node.style?.height, node.type === "group" ? 320 : 160);
      if (node.type === "group") {
        return {
          id: node.id,
          type: "group" as const,
          position: node.position,
          size: { width, height },
          parentId: node.parentId,
          data: { ...node.data },
        };
      }
      return {
        id: node.id,
        type: (node.data.kind === "action" ? "tool" : node.data.kind) as "image" | "video" | "text" | "constraint" | "tool" | "output",
        position: node.position,
        size: { width, height },
        parentId: node.parentId,
        data: { ...node.data },
      };
    }),
    edges: snapshot.edges.map((edge) => edge.data?.kind === "lineage"
      ? {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? undefined,
          targetHandle: edge.targetHandle ?? undefined,
          kind: "lineage" as const,
          runJobId: edge.data.runJobId ?? "unknown-run-job",
          editable: false as const,
          deletable: false as const,
        }
      : {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? undefined,
          targetHandle: edge.targetHandle ?? undefined,
          kind: "workflow" as const,
          editable: true as const,
          deletable: edge.deletable !== false,
          dataType: edge.data?.dataType,
        }),
    viewport,
    updatedAt: new Date().toISOString(),
  };
}

export function documentToSnapshot(document: CanvasDocument): CanvasSnapshot {
  const nodes: CanvasNode[] = document.nodes.map((node) => {
    if (node.type === "group") {
      return {
        id: node.id,
        type: "group",
        position: node.position,
        parentId: node.parentId,
        extent: node.parentId ? "parent" : undefined,
        data: {
          kind: "group",
          title: typeof node.data.title === "string" ? node.data.title : "分组",
          accent: typeof node.data.accent === "string" ? node.data.accent : "#64748b",
        },
        style: { width: node.size?.width ?? 500, height: node.size?.height ?? 320 },
      };
    }

    const kind: StudioKind = node.type === "tool" ? "action" : node.type === "note" ? "text" : node.type;
    return {
      id: node.id,
      type: "studio",
      position: node.position,
      parentId: node.parentId,
      extent: node.parentId ? "parent" : undefined,
      data: {
        kind,
        title: typeof node.data.title === "string" ? node.data.title : "未命名节点",
        subtitle: typeof node.data.subtitle === "string" ? node.data.subtitle : "",
        badge: typeof node.data.badge === "string" ? node.data.badge : undefined,
        accent: typeof node.data.accent === "string" ? node.data.accent : DEFAULT_ACCENTS[kind],
        assetId: typeof node.data.assetId === "string" ? node.data.assetId : undefined,
        body: typeof node.data.body === "string" ? node.data.body : undefined,
      },
      style: { width: node.size?.width ?? 220, height: node.size?.height ?? 160 },
    };
  });

  const edges: CanvasEdge[] = document.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: "smoothstep",
    className: edge.kind === "lineage" ? "edge-lineage" : "edge-workflow",
    selectable: edge.kind === "lineage" ? false : undefined,
    deletable: edge.deletable,
    data: edge.kind === "lineage"
      ? { kind: "lineage", runJobId: edge.runJobId }
      : { kind: "workflow", dataType: edge.dataType },
  }));

  return { nodes, edges };
}

export function snapshotFingerprint(snapshot: CanvasSnapshot, viewport: Viewport): string {
  const normalizedNodes = snapshot.nodes.map(({ selected: _selected, dragging: _dragging, measured: _measured, ...node }) => node);
  const normalizedEdges = snapshot.edges.map(({ selected: _selected, ...edge }) => edge);
  return JSON.stringify({ nodes: normalizedNodes, edges: normalizedEdges, viewport });
}
