import {
  CURRENT_CANVAS_SCHEMA_VERSION,
  CanvasDocumentSchema,
  type CanvasDocument,
} from "@canvas/contracts";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function migrateV0(input: UnknownRecord): UnknownRecord {
  const legacyEdges = Array.isArray(input.edges) ? input.edges : [];
  return {
    ...input,
    schemaVersion: CURRENT_CANVAS_SCHEMA_VERSION,
    revision: typeof input.revision === "number" ? input.revision : 0,
    edges: legacyEdges.map((edge) => {
      if (!isRecord(edge) || edge.kind) return edge;
      return { ...edge, kind: "workflow", editable: true, deletable: true };
    }),
  };
}

export function migrateCanvasDocument(input: unknown): CanvasDocument {
  if (!isRecord(input)) throw new Error("画布文档必须是对象");

  const version = input.schemaVersion ?? 0;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new Error("画布 schemaVersion 无效");
  }
  if (version > CURRENT_CANVAS_SCHEMA_VERSION) {
    throw new Error(`画布版本 ${version} 高于当前支持版本 ${CURRENT_CANVAS_SCHEMA_VERSION}`);
  }

  const migrated = version === 0 ? migrateV0(input) : input;
  return CanvasDocumentSchema.parse(migrated);
}

export { CURRENT_CANVAS_SCHEMA_VERSION };

