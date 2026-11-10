import type { MockRunRequest, MockRunResult } from "@canvas/contracts";

export function executeMockRun(input: MockRunRequest): MockRunResult {
  return {
    executor: "mock",
    status: "succeeded",
    estimatedCost: 0,
    actualCost: 0,
    networkCalls: 0,
    outputAssetIds: input.inputAssetIds.map((assetId, index) => `mock-output-${assetId}-${index + 1}`),
  };
}
