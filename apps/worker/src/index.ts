import { MockRunRequestSchema, type MockRunResult } from "@canvas/contracts";
import { executeMockRun } from "@canvas/testing";

export type WorkerEnvelope = {
  type: "mock.run";
  payload: unknown;
};

export function processJob(job: WorkerEnvelope): MockRunResult {
  if (job.type !== "mock.run") throw new Error("阶段 0 禁止启用真实执行器");
  return executeMockRun(MockRunRequestSchema.parse(job.payload));
}

