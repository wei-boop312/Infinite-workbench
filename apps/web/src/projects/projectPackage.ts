import type { Asset, CanvasDocument, ConstraintSnapshot } from "@canvas/contracts";
import { migrateCanvasDocumentLight } from "@canvas/canvas-schema/light";

const MAGIC = "AICPKG01";
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const HEADER_PREFIX_BYTES = MAGIC_BYTES.byteLength + 4;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const PROJECT_PACKAGE_MIME = "application/x-ai-commerce-canvas-package";

type BlobRole = "original" | "proxy";
type BinaryDescriptor = { assetId: string; role: BlobRole; mimeType: string; byteSize: number };
type ProjectPackageManifest = {
  format: "ai-commerce-canvas-package";
  version: 1;
  projectName: string;
  exportedAt: string;
  document: CanvasDocument;
  constraints: ConstraintSnapshot[];
  assets: Asset[];
  binaries: BinaryDescriptor[];
};

export type PortableAsset = { asset: Asset; original: Blob; proxy?: Blob };
export type PortableProject = {
  projectName: string;
  exportedAt: string;
  packageBytes: number;
  document: CanvasDocument;
  constraints: ConstraintSnapshot[];
  assets: PortableAsset[];
};

type PackageSource = {
  projectName: string;
  document: CanvasDocument;
  constraints: ConstraintSnapshot[];
  assets: Asset[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 160;
}

function assertAsset(value: unknown, projectId: string): Asset {
  if (!isRecord(value)
    || !isId(value.id)
    || value.projectId !== projectId
    || !["image", "video", "audio", "document"].includes(String(value.kind))
    || (value.purpose !== undefined && !["source", "mask", "generated"].includes(String(value.purpose)))
    || (value.sourceAssetId !== undefined && !isId(value.sourceAssetId))
    || typeof value.originalName !== "string" || !value.originalName.trim() || value.originalName.length > 260
    || typeof value.storageKey !== "string" || !value.storageKey
    || (value.proxyStorageKey !== undefined && (typeof value.proxyStorageKey !== "string" || !value.proxyStorageKey))
    || typeof value.mimeType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.mimeType)
    || !Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < 0
    || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("项目包包含无效资产记录");
  }
  for (const field of ["width", "height"] as const) {
    if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || Number(value[field]) <= 0)) {
      throw new Error("项目包包含无效资产尺寸");
    }
  }
  if (value.durationMs !== undefined && (!Number.isSafeInteger(value.durationMs) || Number(value.durationMs) < 0)) {
    throw new Error("项目包包含无效视频时长");
  }
  if (value.contentFingerprint !== undefined
    && (typeof value.contentFingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.contentFingerprint))) {
    throw new Error("项目包包含无效内容指纹");
  }
  return structuredClone(value) as Asset;
}

function assertConstraint(value: unknown, projectId: string): ConstraintSnapshot {
  if (!isRecord(value)
    || !isId(value.id)
    || value.projectId !== projectId
    || !Array.isArray(value.lockedPaths) || value.lockedPaths.some((path) => typeof path !== "string" || !path)
    || !Array.isArray(value.editableRegions)
    || !isRecord(value.brandRules)
    || !isRecord(value.outputSpec)
    || !Number.isSafeInteger(value.outputSpec.width) || Number(value.outputSpec.width) <= 0
    || !Number.isSafeInteger(value.outputSpec.height) || Number(value.outputSpec.height) <= 0
    || !["png", "jpeg", "webp", "mp4"].includes(String(value.outputSpec.format))
    || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("项目包包含无效约束快照");
  }
  for (const region of value.editableRegions) {
    if (!isRecord(region) || !isId(region.id) || typeof region.description !== "string" || !region.description
      || (region.maskAssetId !== undefined && !isId(region.maskAssetId))) {
      throw new Error("项目包包含无效可编辑区域");
    }
  }
  if (Object.entries(value.brandRules).some(([key, entry]) => !key || typeof entry !== "string")) {
    throw new Error("项目包包含无效品牌规则");
  }
  return structuredClone(value) as ConstraintSnapshot;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`项目包包含重复${label}`);
}

function validateReferences(document: CanvasDocument, constraints: ConstraintSnapshot[], assets: Asset[]): void {
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const constraintIds = new Set(constraints.map((snapshot) => snapshot.id));
  for (const asset of assets) {
    if (asset.sourceAssetId && (!assetMap.has(asset.sourceAssetId) || asset.sourceAssetId === asset.id)) {
      throw new Error(`资产 ${asset.originalName} 的来源引用已断裂`);
    }
  }
  for (const snapshot of constraints) {
    for (const region of snapshot.editableRegions) {
      if (!region.maskAssetId) continue;
      const mask = assetMap.get(region.maskAssetId);
      if (!mask || mask.purpose !== "mask") throw new Error(`约束 ${snapshot.id} 的蒙版引用已断裂`);
    }
  }
  for (const node of document.nodes) {
    if (node.data.assetId && !assetMap.has(node.data.assetId)) throw new Error(`节点 ${node.id} 的资产引用已断裂`);
    if (node.data.constraintSnapshotId && !constraintIds.has(node.data.constraintSnapshotId)) {
      throw new Error(`节点 ${node.id} 的约束引用已断裂`);
    }
  }
}

function removeLegacyPlaceholderReferences(document: CanvasDocument, assets: Asset[]): CanvasDocument {
  const assetIds = new Set(assets.map((asset) => asset.id));
  return migrateCanvasDocumentLight({
    ...document,
    nodes: document.nodes.map((node) => {
      const assetId = node.data.assetId;
      const isKnownPlaceholder = assetId === "asset-product-demo" || node.data.badge === "本地占位";
      if (!assetId || assetIds.has(assetId) || !isKnownPlaceholder) return node;
      const { assetId: _assetId, ...data } = node.data;
      return { ...node, data };
    }),
  });
}

function parseManifest(value: unknown): ProjectPackageManifest {
  if (!isRecord(value)
    || value.format !== "ai-commerce-canvas-package"
    || value.version !== 1
    || typeof value.projectName !== "string" || !value.projectName.trim() || value.projectName.length > 120
    || typeof value.exportedAt !== "string" || Number.isNaN(Date.parse(value.exportedAt))
    || !Array.isArray(value.assets)
    || !Array.isArray(value.constraints)
    || !Array.isArray(value.binaries)) {
    throw new Error("不是受支持的画布项目包");
  }
  const document = migrateCanvasDocumentLight(value.document);
  const assets = value.assets.map((asset) => assertAsset(asset, document.projectId));
  const constraints = value.constraints.map((snapshot) => assertConstraint(snapshot, document.projectId));
  const binaries = value.binaries.map((descriptor): BinaryDescriptor => {
    if (!isRecord(descriptor)
      || !isId(descriptor.assetId)
      || !["original", "proxy"].includes(String(descriptor.role))
      || typeof descriptor.mimeType !== "string"
      || !Number.isSafeInteger(descriptor.byteSize) || Number(descriptor.byteSize) < 0) {
      throw new Error("项目包包含无效二进制索引");
    }
    return {
      assetId: descriptor.assetId,
      role: descriptor.role as BlobRole,
      mimeType: descriptor.mimeType,
      byteSize: Number(descriptor.byteSize),
    };
  });
  assertUnique(assets.map((asset) => asset.id), "资产编号");
  assertUnique(constraints.map((snapshot) => snapshot.id), "约束编号");
  assertUnique(binaries.map((descriptor) => `${descriptor.assetId}:${descriptor.role}`), "二进制索引");
  validateReferences(document, constraints, assets);
  return {
    format: "ai-commerce-canvas-package",
    version: 1,
    projectName: value.projectName.trim(),
    exportedAt: value.exportedAt,
    document,
    constraints,
    assets,
    binaries,
  };
}

export async function createProjectPackage(
  source: PackageSource,
  loadBlob: (assetId: string, role: BlobRole) => Promise<Blob | null>,
): Promise<Blob> {
  const sourceDocument = migrateCanvasDocumentLight(source.document);
  const assets = source.assets.map((asset) => assertAsset(asset, sourceDocument.projectId));
  const constraints = source.constraints.map((snapshot) => assertConstraint(snapshot, sourceDocument.projectId));
  const document = removeLegacyPlaceholderReferences(sourceDocument, assets);
  validateReferences(document, constraints, assets);
  const binaries: BinaryDescriptor[] = [];
  const parts: Blob[] = [];
  for (const asset of assets) {
    const original = await loadBlob(asset.id, "original");
    if (!original || original.size !== asset.byteSize) throw new Error(`无法读取原文件：${asset.originalName}`);
    binaries.push({ assetId: asset.id, role: "original", mimeType: asset.mimeType, byteSize: original.size });
    parts.push(original);
    if (asset.proxyStorageKey) {
      const proxy = await loadBlob(asset.id, "proxy");
      if (!proxy) throw new Error(`无法读取预览文件：${asset.originalName}`);
      binaries.push({ assetId: asset.id, role: "proxy", mimeType: proxy.type || "image/webp", byteSize: proxy.size });
      parts.push(proxy);
    }
  }
  const manifest: ProjectPackageManifest = {
    format: "ai-commerce-canvas-package",
    version: 1,
    projectName: source.projectName.trim() || "未命名画布项目",
    exportedAt: new Date().toISOString(),
    document,
    constraints,
    assets,
    binaries,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("项目包清单过大");
  const lengthBytes = new Uint8Array(4);
  new DataView(lengthBytes.buffer).setUint32(0, manifestBytes.byteLength, true);
  return new Blob([MAGIC_BYTES, lengthBytes, manifestBytes, ...parts], { type: PROJECT_PACKAGE_MIME });
}

export async function parseProjectPackage(file: Blob): Promise<PortableProject> {
  if (file.size < HEADER_PREFIX_BYTES) throw new Error("项目包文件不完整");
  const prefix = new Uint8Array(await file.slice(0, HEADER_PREFIX_BYTES).arrayBuffer());
  const foundMagic = new TextDecoder().decode(prefix.slice(0, MAGIC_BYTES.byteLength));
  if (foundMagic !== MAGIC) throw new Error("文件不是画布项目包");
  const manifestLength = new DataView(prefix.buffer, prefix.byteOffset + MAGIC_BYTES.byteLength, 4).getUint32(0, true);
  if (manifestLength <= 0 || manifestLength > MAX_MANIFEST_BYTES || HEADER_PREFIX_BYTES + manifestLength > file.size) {
    throw new Error("项目包清单长度无效");
  }
  let parsed: unknown;
  try {
    const manifestText = await file.slice(HEADER_PREFIX_BYTES, HEADER_PREFIX_BYTES + manifestLength).text();
    parsed = JSON.parse(manifestText);
  } catch {
    throw new Error("项目包清单无法解析");
  }
  const manifest = parseManifest(parsed);
  const assetMap = new Map(manifest.assets.map((asset) => [asset.id, { asset } as PortableAsset]));
  let offset = HEADER_PREFIX_BYTES + manifestLength;
  for (const descriptor of manifest.binaries) {
    const target = assetMap.get(descriptor.assetId);
    if (!target) throw new Error("项目包二进制引用了不存在的资产");
    if (offset + descriptor.byteSize > file.size) throw new Error("项目包二进制内容不完整");
    const blob = file.slice(offset, offset + descriptor.byteSize, descriptor.mimeType);
    offset += descriptor.byteSize;
    if (descriptor.role === "original") target.original = blob;
    else target.proxy = blob;
  }
  if (offset !== file.size) throw new Error("项目包包含未登记的尾部数据");
  for (const portable of assetMap.values()) {
    if (!portable.original || portable.original.size !== portable.asset.byteSize) {
      throw new Error(`资产 ${portable.asset.originalName} 缺少原文件`);
    }
    if (Boolean(portable.asset.proxyStorageKey) !== Boolean(portable.proxy)) {
      throw new Error(`资产 ${portable.asset.originalName} 的预览索引不完整`);
    }
  }
  return {
    projectName: manifest.projectName,
    exportedAt: manifest.exportedAt,
    packageBytes: file.size,
    document: manifest.document,
    constraints: manifest.constraints,
    assets: [...assetMap.values()],
  };
}

export function remapProjectPackage(source: PortableProject, documentId: string, projectId: string): PortableProject {
  if (!isId(documentId) || !isId(projectId)) throw new Error("导入项目编号无效");
  const assetIds = new Map(source.assets.map(({ asset }) => [
    asset.id,
    `${asset.purpose === "mask" ? "mask" : "asset"}-${crypto.randomUUID()}`,
  ]));
  const constraintIds = new Map(source.constraints.map((snapshot) => [snapshot.id, `constraint-${crypto.randomUUID()}`]));
  const assets = source.assets.map(({ asset, original, proxy }) => {
    const id = assetIds.get(asset.id)!;
    return {
      asset: {
        ...asset,
        id,
        projectId,
        sourceAssetId: asset.sourceAssetId ? assetIds.get(asset.sourceAssetId) : undefined,
        storageKey: `indexeddb://assets/${id}/original`,
        proxyStorageKey: proxy ? `indexeddb://assets/${id}/proxy` : undefined,
      },
      original,
      proxy,
    };
  });
  const constraints = source.constraints.map((snapshot) => ({
    ...snapshot,
    id: constraintIds.get(snapshot.id)!,
    projectId,
    editableRegions: snapshot.editableRegions.map((region) => ({
      ...region,
      maskAssetId: region.maskAssetId ? assetIds.get(region.maskAssetId) : undefined,
    })),
  }));
  const document = migrateCanvasDocumentLight({
    ...source.document,
    id: documentId,
    projectId,
    revision: 0,
    updatedAt: new Date().toISOString(),
    nodes: source.document.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        assetId: node.data.assetId ? assetIds.get(node.data.assetId) : undefined,
        constraintSnapshotId: node.data.constraintSnapshotId
          ? constraintIds.get(node.data.constraintSnapshotId)
          : undefined,
      },
    })),
  });
  validateReferences(document, constraints, assets.map(({ asset }) => asset));
  return { ...source, document, constraints, assets };
}
