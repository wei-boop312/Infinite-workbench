import { describe, expect, it } from "vitest";
import { AssetSchema, ConstraintSnapshotSchema } from "../packages/contracts/src/index";
import { formatAssetBytes, validateAssetFile } from "../apps/web/src/assets/assetRepository";
import { buildConstraintSnapshot, defaultConstraintDraft } from "../apps/web/src/constraints/constraintRepository";

describe("阶段 2 资产与约束合同", () => {
  it("只接受受控大小的图片和视频", () => {
    expect(validateAssetFile({ name: "product.png", type: "image/png", size: 2048 })).toBe("image");
    expect(validateAssetFile({ name: "clip.mp4", type: "video/mp4", size: 4096 })).toBe("video");
    expect(() => validateAssetFile({ name: "vector.svg", type: "image/svg+xml", size: 100 })).toThrow(/不支持/);
    expect(() => validateAssetFile({ name: "huge.png", type: "image/png", size: 31 * 1024 * 1024 })).toThrow(/30 MB/);
    expect(formatAssetBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("资产元数据合同保留原文件名但不包含二进制", () => {
    const asset = AssetSchema.parse({
      id: "asset-1",
      projectId: "project-1",
      kind: "image",
      purpose: "source",
      originalName: "product.png",
      storageKey: "indexeddb://assets/asset-1/original",
      proxyStorageKey: "indexeddb://assets/asset-1/proxy",
      mimeType: "image/png",
      byteSize: 2048,
      width: 1200,
      height: 1200,
      createdAt: "2026-09-27T00:00:00+08:00",
    });
    expect(asset).toMatchObject({ originalName: "product.png", purpose: "source", width: 1200, height: 1200 });
    expect(JSON.stringify(asset)).not.toContain("data:image");
  });

  it("把人工选择冻结为可验证的不可变约束快照", () => {
    const snapshot = buildConstraintSnapshot(
      "project-1",
      { ...defaultConstraintDraft, outputWidth: 1080, outputHeight: 1440 },
      "constraint-fixed",
      "2026-09-27T00:00:00+08:00",
    );
    expect(ConstraintSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      id: "constraint-fixed",
      lockedPaths: ["product.pixels", "brand.identity"],
      outputSpec: { width: 1080, height: 1440, format: "png" },
    });
  });

  it("拒绝没有可编辑区域或超出范围的输出规格", () => {
    expect(() => buildConstraintSnapshot("project-1", { ...defaultConstraintDraft, editableRegions: [] })).toThrow(/至少需要一个/);
    expect(() => buildConstraintSnapshot("project-1", { ...defaultConstraintDraft, outputWidth: 9000 })).toThrow(/64–8192/);
  });
});
