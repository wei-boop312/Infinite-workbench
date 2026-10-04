import type { CanvasDocument } from "@canvas/contracts";
import { assertGeneratedNodeHistory } from "./generatedHistory.ts";
export { parseGeneratedCanvasHistory, type GeneratedCanvasHistory } from "./generatedHistory.ts";
export { parseProductionCanvasHistory, type ProductionCanvasHistory } from "./productionHistory.ts";

const CURRENT_VERSION = 2;
const NODE_TYPES = new Set(["image", "video", "text", "constraint", "tool", "output", "group", "note"]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 160;
}

function isFinitePosition(value: unknown): boolean {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function containsDataUrl(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") return /^data:/i.test(value.trim());
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((entry) => containsDataUrl(entry, seen));
}

function migrateLegacy(input: UnknownRecord, version: number): UnknownRecord {
  let migrated = input;
  if (version === 0) {
    const edges = Array.isArray(input.edges) ? input.edges : [];
    migrated = {
      ...input,
      schemaVersion: 1,
      revision: typeof input.revision === "number" ? input.revision : 0,
      edges: edges.map((edge) => isRecord(edge) && !edge.kind
        ? { ...edge, kind: "workflow", editable: true, deletable: true }
        : edge),
    };
  }
  return migrated.schemaVersion === 1 ? { ...migrated, schemaVersion: 2 } : migrated;
}

function assertCanvasShape(value: UnknownRecord): void {
  if (value.schemaVersion !== CURRENT_VERSION) throw new Error("画布版本迁移失败");
  if (!isId(value.id) || !isId(value.projectId)) throw new Error("画布标识无效");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new Error("画布修订号无效");
  if (!Array.isArray(value.nodes) || value.nodes.length > 10_000) throw new Error("画布节点列表无效");
  if (!Array.isArray(value.edges) || value.edges.length > 20_000) throw new Error("画布连线列表无效");
  if (!isRecord(value.viewport) || !Number.isFinite(value.viewport.x) || !Number.isFinite(value.viewport.y)
    || !Number.isFinite(value.viewport.zoom) || Number(value.viewport.zoom) <= 0 || Number(value.viewport.zoom) > 8) {
    throw new Error("画布视口无效");
  }
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) throw new Error("画布更新时间无效");

  for (const node of value.nodes) {
    if (!isRecord(node) || !isId(node.id) || !NODE_TYPES.has(String(node.type))
      || !isFinitePosition(node.position) || !isRecord(node.data)
      || typeof node.data.title !== "string" || node.data.title.length > 240) {
      throw new Error("画布节点无效");
    }
    if (node.parentId !== undefined && !isId(node.parentId)) throw new Error("节点父级无效");
    assertGeneratedNodeHistory(node.data, value.projectId as string);
  }

  for (const edge of value.edges) {
    if (!isRecord(edge) || !isId(edge.id) || !isId(edge.source) || !isId(edge.target)) throw new Error("画布连线无效");
    if (edge.kind === "workflow") {
      if (edge.editable !== true || typeof edge.deletable !== "boolean") throw new Error("工作流连线无效");
    } else if (edge.kind === "lineage") {
      if (!isId(edge.runJobId) || edge.editable !== false || edge.deletable !== false) throw new Error("血缘连线无效");
    } else {
      throw new Error("画布连线类型无效");
    }
  }

  if (containsDataUrl(value)) throw new Error("画布文档禁止保存 Data URL；媒体必须通过 assetId 引用");
}

export function migrateCanvasDocumentLight(input: unknown): CanvasDocument {
  if (!isRecord(input)) throw new Error("画布文档必须是对象");
  const version = input.schemaVersion ?? 0;
  if (!Number.isInteger(version) || Number(version) < 0) throw new Error("画布 schemaVersion 无效");
  if (Number(version) > CURRENT_VERSION) throw new Error(`画布版本 ${version} 高于当前支持版本 ${CURRENT_VERSION}`);
  const migrated = migrateLegacy(input, Number(version));
  assertCanvasShape(migrated);
  return migrated as CanvasDocument;
}
