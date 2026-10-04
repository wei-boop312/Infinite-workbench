import {
  CURRENT_CANVAS_SCHEMA_VERSION,
  CanvasDocumentSchema,
  type CanvasDocument,
} from "@canvas/contracts";
import { assertGeneratedNodeHistory } from "./generatedHistory.ts";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function migrateV0(input: UnknownRecord): UnknownRecord {
  const legacyEdges = Array.isArray(input.edges) ? input.edges : [];
  return {
    ...input,
    schemaVersion: 1,
    revision: typeof input.revision === "number" ? input.revision : 0,
    edges: legacyEdges.map((edge) => {
      if (!isRecord(edge) || edge.kind) return edge;
      return { ...edge, kind: "workflow", editable: true, deletable: true };
    }),
  };
}

function migrateV1(input: UnknownRecord): UnknownRecord {
  return { ...input, schemaVersion: 2 };
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

  let migrated = input;
  let migratedVersion = version;
  if (migratedVersion === 0) {
    migrated = migrateV0(migrated);
    migratedVersion = 1;
  }
  if (migratedVersion === 1) {
    migrated = migrateV1(migrated);
  }
  const document = CanvasDocumentSchema.parse(migrated);
  for (const node of document.nodes) assertGeneratedNodeHistory(node.data, document.projectId);
  return document;
}

export { CURRENT_CANVAS_SCHEMA_VERSION };
