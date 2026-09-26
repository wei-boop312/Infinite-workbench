import { describe, expect, it } from "vitest";
import type { Asset, CanvasDocument, ConstraintSnapshot } from "../packages/contracts/src/index";
import {
  createProjectPackage,
  parseProjectPackage,
  remapProjectPackage,
} from "../apps/web/src/projects/projectPackage";

const createdAt = "2026-09-27T00:00:00.000Z";
const sourceBytes = new Uint8Array([1, 2, 3, 4]);
const proxyBytes = new Uint8Array([5, 6]);
const maskBytes = new Uint8Array([7, 8, 9]);

const assets: Asset[] = [
  {
    id: "source-asset",
    projectId: "project-source",
    kind: "image",
    purpose: "source",
    originalName: "product.png",
    storageKey: "indexeddb://assets/source-asset/original",
    proxyStorageKey: "indexeddb://assets/source-asset/proxy",
    mimeType: "image/png",
    byteSize: sourceBytes.byteLength,
    width: 1200,
    height: 1200,
    createdAt,
  },
  {
    id: "mask-asset",
    projectId: "project-source",
    kind: "image",
    purpose: "mask",
    sourceAssetId: "source-asset",
    originalName: "mask.png",
    storageKey: "indexeddb://assets/mask-asset/original",
    mimeType: "image/png",
    byteSize: maskBytes.byteLength,
    width: 1200,
    height: 1200,
    createdAt,
  },
];

const constraints: ConstraintSnapshot[] = [{
  id: "constraint-source",
  projectId: "project-source",
  lockedPaths: ["product.pixels"],
  editableRegions: [{ id: "background", description: "只改背景", maskAssetId: "mask-asset" }],
  brandRules: { tone: "克制" },
  outputSpec: { width: 1200, height: 1200, format: "png" },
  createdAt,
}];

const document: CanvasDocument = {
  schemaVersion: 2,
  id: "document-source",
  projectId: "project-source",
  revision: 3,
  nodes: [
    { id: "image-node", type: "image", position: { x: 0, y: 0 }, data: { title: "商品", assetId: "source-asset" } },
    { id: "constraint-node", type: "constraint", position: { x: 300, y: 0 }, data: { title: "约束", constraintSnapshotId: "constraint-source" } },
  ],
  edges: [{ id: "edge-1", source: "image-node", target: "constraint-node", kind: "workflow", editable: true, deletable: true }],
  viewport: { x: 0, y: 0, zoom: 1 },
  updatedAt: createdAt,
};

function blobFor(assetId: string, role: "original" | "proxy"): Blob | null {
  if (assetId === "source-asset" && role === "original") return new Blob([sourceBytes], { type: "image/png" });
  if (assetId === "source-asset" && role === "proxy") return new Blob([proxyBytes], { type: "image/webp" });
  if (assetId === "mask-asset" && role === "original") return new Blob([maskBytes], { type: "image/png" });
  return null;
}

describe("可迁移项目资产包", () => {
  it("往返保留原文件、蒙版、画布和约束引用", async () => {
    const archive = await createProjectPackage(
      { projectName: "商品主图", document, constraints, assets },
      async (assetId, role) => blobFor(assetId, role),
    );
    const parsed = await parseProjectPackage(archive);
    expect(parsed.projectName).toBe("商品主图");
    expect(parsed.assets).toHaveLength(2);
    expect(new Uint8Array(await parsed.assets[0].original.arrayBuffer())).toEqual(sourceBytes);
    expect(new Uint8Array(await parsed.assets[0].proxy!.arrayBuffer())).toEqual(proxyBytes);
    expect(parsed.constraints[0].editableRegions[0].maskAssetId).toBe("mask-asset");

    const remapped = remapProjectPackage(parsed, "document-copy", "project-copy");
    const remappedSource = remapped.assets.find(({ asset }) => asset.purpose === "source")!.asset;
    const remappedMask = remapped.assets.find(({ asset }) => asset.purpose === "mask")!.asset;
    expect(remapped.document.projectId).toBe("project-copy");
    expect(remappedSource.id).not.toBe("source-asset");
    expect(remappedMask.sourceAssetId).toBe(remappedSource.id);
    expect(remapped.document.nodes[0].data.assetId).toBe(remappedSource.id);
    expect(remapped.constraints[0].editableRegions[0].maskAssetId).toBe(remappedMask.id);
    expect(remapped.document.nodes[1].data.constraintSnapshotId).toBe(remapped.constraints[0].id);
  });

  it("拒绝截断包和断裂引用，而不是部分恢复", async () => {
    const archive = await createProjectPackage(
      { projectName: "商品主图", document, constraints, assets },
      async (assetId, role) => blobFor(assetId, role),
    );
    await expect(parseProjectPackage(archive.slice(0, archive.size - 1))).rejects.toThrow(/不完整/);
    await expect(createProjectPackage(
      { projectName: "坏包", document: { ...document, nodes: [{ ...document.nodes[0], data: { title: "断裂", assetId: "missing" } }] }, constraints, assets },
      async (assetId, role) => blobFor(assetId, role),
    )).rejects.toThrow(/引用已断裂/);
  });
});
