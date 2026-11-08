import { WorkspaceObjectSchema, type WorkspaceObject } from "@canvas/contracts";
import { migrateCanvasDocument } from "@canvas/canvas-schema";

/** All-or-nothing conversion of the explicitly mapped image/text/tool slice.
 * Legacy workflow/lineage edges are quarantined, never turned into executable edges.
 * Unsupported objects fail instead of silently losing user data.
 */
export function migrateLegacyObjects(raw: unknown, targetProjectId: string, mapping: {
  objectIds: Record<string, string>; assetVersions: Record<string, string>; templateVersions: Record<string, string>;
}) {
  const legacy = migrateCanvasDocument(raw);
  const ids = new Set<string>();
  const objects: WorkspaceObject[] = legacy.nodes.map(node => {
    const id = mapping.objectIds[node.id];
    if (!id || ids.has(id)) throw new Error("EXPLICIT_UNIQUE_OBJECT_MAPPING_REQUIRED");
    ids.add(id);
    if (node.parentId) throw new Error("GROUP_MIGRATION_NOT_IMPLEMENTED");
    const base = { id, projectId: targetProjectId, revision: 1, title: node.data.title, x: node.position.x, y: node.position.y,
      width: node.size?.width ?? 220, height: node.size?.height ?? 160 };
    if (node.type === "image" && node.data.assetId) {
      return WorkspaceObjectSchema.parse({ ...base, type: "image", assetVersionId: mapping.assetVersions[node.data.assetId] });
    }
    if (node.type === "tool") {
      return WorkspaceObjectSchema.parse({ ...base, type: "tool", templateVersionId: mapping.templateVersions[node.data.toolId ?? node.id] });
    }
    if (node.type === "text" && typeof node.data.body === "string") {
      return WorkspaceObjectSchema.parse({ ...base, type: "text", text: node.data.body });
    }
    throw new Error(`UNSUPPORTED_LEGACY_OBJECT:${node.type}`);
  });
  return {
    schemaVersion: 1, legacyProjectId: legacy.projectId, projectId: targetProjectId,
    objects, quarantinedEdges: structuredClone(legacy.edges),
    sourceDocument: structuredClone(legacy),
    mapping: structuredClone(mapping), executionAuthorized: false,
  };
}
