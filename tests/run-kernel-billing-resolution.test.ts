import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CreateRunBatchRequest,
  ResolveBillingUnknownRequest,
  RunBatchAggregate,
  RunKernelSnapshot,
} from "@canvas/contracts";
import { createApiServer } from "../apps/api/src/index";
import {
  InMemoryRunKernel,
  RunKernelError,
  StaticRunAuthorizer,
  type RunPermission,
  type RunPrincipal,
} from "../apps/api/src/runKernel";
import type { RunKernelStateStore } from "../apps/api/src/runKernelStore";

class MemoryRunKernelStateStore implements RunKernelStateStore {
  snapshot: RunKernelSnapshot | null = null;

  load(): RunKernelSnapshot | null {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  save(snapshot: RunKernelSnapshot): void {
    this.snapshot = structuredClone(snapshot);
  }
}

const owner: RunPrincipal = { tenantId: "tenant-a", actorId: "owner" };
const auditor: RunPrincipal = { tenantId: "tenant-a", actorId: "billing-auditor" };
const operator: RunPrincipal = { tenantId: "tenant-a", actorId: "operator" };
const full: readonly RunPermission[] = [
  "run:read",
  "run:create",
  "run:confirm",
  "run:cancel",
  "run:execute",
  "run:retry",
  "run:reconcile-billing",
];
const runningServers: Server[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(server: Server): Promise<string> {
  runningServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP 端口");
  return `http://127.0.0.1:${address.port}`;
}

function createKernel(stateStore?: RunKernelStateStore) {
  return new InMemoryRunKernel({
    authorizer: new StaticRunAuthorizer([
      { bearerToken: "owner-token", ...owner, projects: { "project-a": full } },
      {
        bearerToken: "auditor-token",
        ...auditor,
        projects: { "project-a": ["run:read", "run:reconcile-billing"] },
      },
      {
        bearerToken: "operator-token",
        ...operator,
        projects: { "project-a": ["run:read", "run:execute", "run:retry"] },
      },
    ]),
    budgets: [{ tenantId: "tenant-a", projectId: "project-a", currency: "CNY", limitMinor: 500 }],
    stateStore,
    unitEstimateMinor: 40,
    unitActualMinor: 30,
    maxConcurrentJobs: 4,
  });
}

function request(idempotencyKey: string, expectedOutputs = 1): CreateRunBatchRequest {
  return {
    projectId: "project-a",
    constraintSnapshotId: "constraint-v1",
    tool: "product-retouch",
    inputAssetIds: ["asset-a"],
    expectedOutputs,
    maxCostMinor: 200,
    currency: "CNY",
    idempotencyKey,
    mockScenario: "billing-unknown",
  };
}

function createUnknown(kernel: InMemoryRunKernel, idempotencyKey: string, expectedOutputs = 1): RunBatchAggregate {
  const draft = kernel.createBatch(owner, request(idempotencyKey, expectedOutputs));
  kernel.confirmBatch(owner, draft.batch.id, {
    expectedEstimatedCostMinor: draft.batch.estimatedCostMinor,
    expectedCurrency: draft.batch.currency,
  });
  return kernel.dispatchBatch(owner, draft.batch.id);
}

function resolution(
  overrides: {
    resolutionId?: string;
    resolution?: "charged" | "not-charged";
    expectedReservedMinor?: number;
    expectedCurrency?: string;
    evidenceRef?: string;
    actualCostMinor?: number;
  } = {},
): ResolveBillingUnknownRequest {
  const base = {
    resolutionId: overrides.resolutionId ?? "resolution-1",
    expectedReservedMinor: overrides.expectedReservedMinor ?? 40,
    expectedCurrency: overrides.expectedCurrency ?? "CNY",
    evidenceRef: overrides.evidenceRef ?? "provider-invoice-1001",
  };
  if (overrides.resolution === "not-charged") return { ...base, resolution: "not-charged" };
  return { ...base, resolution: "charged", actualCostMinor: overrides.actualCostMinor ?? 25 };
}

describe("阶段 3 计费待核对人工解决流程", () => {
  it("只有独立核账权限可以处理计费待核对任务", () => {
    const kernel = createKernel();
    const unknown = createUnknown(kernel, "billing-permission");
    expect(() => kernel.resolveBillingUnknown(operator, unknown.jobs[0].id, resolution()))
      .toThrowError(expect.objectContaining<Partial<RunKernelError>>({ code: "run_permission_denied" }));
    expect(kernel.getBatch(owner, unknown.batch.id).jobs[0].status).toBe("billing_unknown");
  });

  it("确认已扣费后按实际金额结算，释放差额并保持核账动作幂等", () => {
    const kernel = createKernel();
    const unknown = createUnknown(kernel, "billing-charged");
    const input = resolution();
    const resolved = kernel.resolveBillingUnknown(auditor, unknown.jobs[0].id, input);
    expect(resolved.batch.status).toBe("failed");
    expect(resolved.jobs[0]).toMatchObject({
      status: "failed",
      actualCostMinor: 25,
      failureCode: "billing-resolved-charged",
      billingResolutionId: "resolution-1",
      billingResolvedBy: "billing-auditor",
      billingEvidenceRef: "provider-invoice-1001",
    });
    expect(resolved.ledger.at(-1)).toMatchObject({ settlement: "settled", actualMinor: 25, reservedMinor: 0 });
    expect(resolved.audit.map((event) => event.eventType)).toContain("billing-resolved-charged");
    expect(kernel.getBudget(owner, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 25, availableMinor: 475 });

    const repeated = kernel.resolveBillingUnknown(auditor, unknown.jobs[0].id, input);
    expect(repeated.ledger).toHaveLength(resolved.ledger.length);
    expect(repeated.audit).toHaveLength(resolved.audit.length);
    expect(() => kernel.resolveBillingUnknown(auditor, unknown.jobs[0].id, resolution({ actualCostMinor: 20 })))
      .toThrowError(expect.objectContaining<Partial<RunKernelError>>({ code: "billing_resolution_idempotency_conflict" }));
    expect(() => kernel.resolveBillingUnknown(auditor, unknown.jobs[0].id, resolution({ resolutionId: "resolution-2" })))
      .toThrowError(expect.objectContaining<Partial<RunKernelError>>({ code: "billing_already_resolved" }));
  });

  it("确认未扣费后释放全部预留，并允许人工创建新的重试", () => {
    const kernel = createKernel();
    const unknown = createUnknown(kernel, "billing-not-charged");
    const resolved = kernel.resolveBillingUnknown(auditor, unknown.jobs[0].id, resolution({
      resolutionId: "resolution-not-charged",
      resolution: "not-charged",
      evidenceRef: "provider-ticket-no-charge",
    }));
    expect(resolved.jobs[0]).toMatchObject({
      status: "failed",
      actualCostMinor: 0,
      failureCode: "billing-resolved-not-charged",
    });
    expect(resolved.ledger.at(-1)).toMatchObject({ settlement: "released", actualMinor: 0 });
    expect(kernel.getBudget(owner, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 0, availableMinor: 500 });

    const retried = kernel.retryJob(owner, resolved.jobs[0].id, {
      expectedEstimatedCostMinor: 40,
      expectedCurrency: "CNY",
      mockScenario: "success",
    });
    expect(retried.jobs.at(-1)).toMatchObject({ status: "queued", retryOf: resolved.jobs[0].id });
    expect(kernel.dispatchBatch(owner, resolved.batch.id).batch.status).toBe("succeeded");
  });

  it("快照失效或实际扣费超过预留时保持冻结并记录拒绝原因", () => {
    const kernel = createKernel();
    const unknown = createUnknown(kernel, "billing-rejected");
    const jobId = unknown.jobs[0].id;
    expect(() => kernel.resolveBillingUnknown(auditor, jobId, resolution({ expectedReservedMinor: 39 })))
      .toThrowError(expect.objectContaining<Partial<RunKernelError>>({ code: "billing_resolution_snapshot_mismatch" }));
    expect(() => kernel.resolveBillingUnknown(auditor, jobId, resolution({
      resolutionId: "resolution-overrun",
      actualCostMinor: 41,
    }))).toThrowError(expect.objectContaining<Partial<RunKernelError>>({ code: "billing_actual_exceeds_reservation" }));

    const unchanged = kernel.getBatch(owner, unknown.batch.id);
    expect(unchanged.jobs[0].status).toBe("billing_unknown");
    expect(unchanged.audit.filter((event) => event.eventType === "billing-resolution-rejected")).toHaveLength(2);
    expect(kernel.getBudget(owner, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0 });
  });

  it("多任务批次只有全部未知计费都处理后才解除批次冻结", () => {
    const kernel = createKernel();
    const unknown = createUnknown(kernel, "billing-multiple", 2);
    const first = kernel.resolveBillingUnknown(auditor, unknown.jobs[0].id, resolution({
      resolutionId: "resolution-multi-1",
      resolution: "not-charged",
      evidenceRef: "ticket-multi-1",
    }));
    expect(first.batch.status).toBe("billing_unknown");
    expect(kernel.getBudget(owner, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0 });

    const second = kernel.resolveBillingUnknown(auditor, unknown.jobs[1].id, resolution({
      resolutionId: "resolution-multi-2",
      evidenceRef: "invoice-multi-2",
      actualCostMinor: 30,
    }));
    expect(second.batch.status).toBe("failed");
    expect(kernel.getBudget(owner, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 30 });
  });

  it("核账结果跨重启保持幂等，并可通过 HTTP 入口提交", async () => {
    const store = new MemoryRunKernelStateStore();
    const firstKernel = createKernel(store);
    const unknown = createUnknown(firstKernel, "billing-http-persistent");
    const baseUrl = await listen(createApiServer({ runKernel: firstKernel }));
    const input = resolution({ resolutionId: "resolution-http" });
    const response = await fetch(`${baseUrl}/v1/run-jobs/${unknown.jobs[0].id}/resolve-billing`, {
      method: "POST",
      headers: { authorization: "Bearer auditor-token", "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as RunBatchAggregate).jobs[0].billingResolutionId).toBe("resolution-http");

    const restoredKernel = createKernel(store);
    const beforeRepeat = restoredKernel.getBatch(owner, unknown.batch.id);
    const repeated = restoredKernel.resolveBillingUnknown(auditor, unknown.jobs[0].id, input);
    expect(repeated.ledger).toHaveLength(beforeRepeat.ledger.length);
    expect(repeated.audit).toHaveLength(beforeRepeat.audit.length);
    expect(restoredKernel.getBudget(owner, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 25 });
  });
});
