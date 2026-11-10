import {
  MockRunRequestSchema,
  MockRunResultSchema,
  type MockRunRequest,
  type MockRunResult,
} from "@canvas/contracts";

export function executeMockRun(input: MockRunRequest): MockRunResult {
  const request = MockRunRequestSchema.parse(input);
  return MockRunResultSchema.parse({
    executor: "mock",
    status: "succeeded",
    estimatedCost: 0,
    actualCost: 0,
    networkCalls: 0,
    outputAssetIds: request.inputAssetIds.map((assetId, index) => `mock-output-${assetId}-${index + 1}`),
  });
}

