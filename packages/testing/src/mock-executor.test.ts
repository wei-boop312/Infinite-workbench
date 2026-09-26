import { describe, expect, it } from "vitest";
import { executeMockRun } from "./index";

describe("假执行器", () => {
  it("生成资产 ID，但始终保持零成本和零网络调用", () => {
    const result = executeMockRun({
      projectId: "project-1",
      tool: "product-retouch",
      inputAssetIds: ["asset-1", "asset-2"],
      constraints: { productLocked: true, brandLocked: true, editableRegion: "background-only" },
      maxCost: 0,
    });
    expect(result.outputAssetIds).toHaveLength(2);
    expect(result).toMatchObject({ executor: "mock", estimatedCost: 0, actualCost: 0, networkCalls: 0 });
  });
});

