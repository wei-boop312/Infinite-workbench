import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RequestBillingOverageSchema, ReviewBillingOverageSchema, type BillingOverage, type RequestBillingOverage, type ReviewBillingOverage, type RunBatchAggregate, type RunKernelSnapshot } from "../packages/contracts/src/index";
import { createApiServer } from "../apps/api/src/index";
import { InMemoryRunKernel, RunKernelError, StaticRunAuthorizer, type RunPermission } from "../apps/api/src/runKernel";
import type { RunKernelStateStore } from "../apps/api/src/runKernelStore";

class MemoryStore implements RunKernelStateStore {
  snapshot: RunKernelSnapshot | null = null;
  load() { return this.snapshot ? structuredClone(this.snapshot) : null; }
  save(snapshot: RunKernelSnapshot) { this.snapshot = structuredClone(snapshot); }
}
const owner = { tenantId: "tenant-a", actorId: "designer" };
const reviewer = { tenantId: "tenant-a", actorId: "reviewer" };
const auditor = { tenantId: "tenant-a", actorId: "auditor" };
const all: RunPermission[] = ["run:read", "run:create", "run:confirm", "run:execute", "run:retry", "run:cancel", "run:reconcile-billing", "run:approve-billing-overage"];
function kernel(options: { limit?: number; store?: MemoryStore } = {}) {
  return new InMemoryRunKernel({ authorizer: new StaticRunAuthorizer([
    { ...owner, bearerToken: "designer", projects: { "project-a": all } },
    { ...reviewer, bearerToken: "reviewer", projects: { "project-a": ["run:read", "run:approve-billing-overage"] } },
    { ...auditor, bearerToken: "auditor", projects: { "project-a": ["run:read", "run:reconcile-billing"] } },
    { tenantId: "tenant-b", actorId: "foreign", bearerToken: "foreign", projects: { "project-a": all } },
  ]), budgets: [{ tenantId: "tenant-a", projectId: "project-a", currency: "CNY", limitMinor: options.limit ?? 500 }],
    unitEstimateMinor: 40, unitActualMinor: 30, maxConcurrentJobs: 4, stateStore: options.store });
}
function unknown(engine: InMemoryRunKernel, outputs = 1) {
  const draft = engine.createBatch(owner, { projectId: "project-a", tool: "product-retouch", constraintSnapshotId: "constraint-1", inputAssetIds: ["asset-1"], expectedOutputs: outputs,
    maxCostMinor: outputs * 40, currency: "CNY", idempotencyKey: "action-1", mockScenario: "billing-unknown" });
  engine.confirmBatch(owner, draft.batch.id, { expectedEstimatedCostMinor: outputs * 40, expectedCurrency: "CNY" });
  return engine.dispatchBatch(owner, draft.batch.id);
}
function proposal(overrides: Partial<RequestBillingOverage> = {}): RequestBillingOverage {
  return { requestId: "overage-action-1", expectedReservedMinor: 40, expectedCurrency: "CNY", expectedBatchMaxCostMinor: 40, actualCostMinor: 70,
    requestedBatchMaxCostMinor: 70, evidenceRef: "invoice-70", reason: "账单单价高于预估", ...overrides };
}
function review(overage: BillingOverage, overrides: Partial<ReviewBillingOverage> = {}): ReviewBillingOverage {
  return { reviewId: "review-action-1", decision: "approve", expectedReservedMinor: overage.reservedMinor, expectedCurrency: overage.currency,
    expectedActualCostMinor: overage.actualCostMinor, expectedBatchMaxCostMinor: overage.batchMaxCostMinor,
    expectedRequestedBatchMaxCostMinor: overage.requestedBatchMaxCostMinor, evidenceRef: "verified-invoice-70", note: "已核实账单及可用预算", ...overrides };
}
function error(code: string) { return expect.objectContaining<Partial<RunKernelError>>({ code }); }
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((failure) => failure ? reject(failure) : resolve())))); });
async function listen(server: Server) {
  servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("服务未启动");
  return `http://127.0.0.1:${address.port}`;
}
function post(url: string, path: string, token: string, body: unknown) {
  return fetch(url + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("超预留账单升级审批", () => {
  it("申请只冻结原预留，防重复和参数漂移，不能绕过待审批核账", () => {
    const engine = kernel(); const batch = unknown(engine); const jobId = batch.jobs[0].id;
    const requested = engine.requestBillingOverage(owner, jobId, proposal());
    expect(requested.billingOverages).toHaveLength(1);
    expect(requested.billingOverages[0]).toMatchObject({ status: "pending", requestedBy: owner.actorId });
    expect(engine.getBudget(owner, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0 });
    const again = engine.requestBillingOverage(owner, jobId, proposal());
    expect(again.audit).toHaveLength(requested.audit.length);
    expect(() => engine.requestBillingOverage(owner, jobId, proposal({ actualCostMinor: 65 }))).toThrowError(error("billing_overage_idempotency_conflict"));
    expect(() => engine.requestBillingOverage(owner, jobId, proposal({ requestId: "second-action" }))).toThrowError(error("billing_overage_pending"));
    expect(() => engine.resolveBillingUnknown(auditor, jobId, { resolutionId: "bypass", resolution: "not-charged", expectedReservedMinor: 40, expectedCurrency: "CNY", evidenceRef: "other-ticket" })).toThrowError(error("billing_overage_pending"));
    expect(() => engine.retryJob(owner, jobId, { expectedEstimatedCostMinor: 40, expectedCurrency: "CNY", mockScenario: "success" })).toThrowError(error("billing_state_unknown"));
    expect(() => engine.cancelBatch(owner, batch.batch.id)).toThrowError(error("billing_state_unknown"));
  });

  it("提交和审批权限分离，拥有全部权限也不能审批自己的申请", () => {
    const engine = kernel(); const batch = unknown(engine); const jobId = batch.jobs[0].id;
    expect(() => engine.requestBillingOverage(reviewer, jobId, proposal())).toThrowError(error("run_permission_denied"));
    const record = engine.requestBillingOverage(owner, jobId, proposal()).billingOverages[0];
    expect(() => engine.reviewBillingOverage(auditor, jobId, record.id, review(record))).toThrowError(error("run_permission_denied"));
    expect(() => engine.reviewBillingOverage(owner, jobId, record.id, review(record))).toThrowError(error("billing_overage_self_review"));
    expect(() => engine.reviewBillingOverage(owner, jobId, record.id, review(record, { decision: "reject" }))).toThrowError(error("billing_overage_self_review"));
    expect(engine.getBatch(owner, batch.batch.id).billingOverages[0].status).toBe("pending");
  });

  it("批准明确变更批次上限并按实际扣费结算，不改项目总预算、不自动重试", () => {
    const engine = kernel(); const batch = unknown(engine); const jobId = batch.jobs[0].id;
    const record = engine.requestBillingOverage(owner, jobId, proposal()).billingOverages[0];
    const approved = engine.reviewBillingOverage(reviewer, jobId, record.id, review(record));
    expect(approved.batch).toMatchObject({ maxCostMinor: 70, status: "failed" });
    expect(approved.jobs).toHaveLength(1);
    expect(approved.jobs[0]).toMatchObject({ actualCostMinor: 70, status: "failed", billingResolvedBy: reviewer.actorId });
    expect(approved.billingOverages[0]).toMatchObject({ status: "approved", reviewedBy: reviewer.actorId, requestedBy: owner.actorId });
    expect(approved.ledger.at(-1)).toMatchObject({ settlement: "settled", actualMinor: 70 });
    expect(engine.getBudget(owner, "project-a")).toMatchObject({ limitMinor: 500, reservedMinor: 0, spentMinor: 70, availableMinor: 430 });
    expect(engine.reviewBillingOverage(reviewer, jobId, record.id, review(record)).audit).toHaveLength(approved.audit.length);
    expect(() => engine.reviewBillingOverage(reviewer, jobId, record.id, review(record, { decision: "reject" }))).toThrowError(error("billing_overage_review_idempotency_conflict"));
    expect(() => engine.reviewBillingOverage(reviewer, jobId, record.id, review(record, { reviewId: "new-action" }))).toThrowError(error("billing_overage_already_reviewed"));
    expect(() => engine.retryJob(owner, jobId, { expectedEstimatedCostMinor: 40, expectedCurrency: "CNY", mockScenario: "success" })).toThrowError(error("batch_cost_ceiling_exceeded"));
  });

  it("拒绝保留冻结和原上限，结论不可覆盖，可提交新的申请", () => {
    const engine = kernel(); const batch = unknown(engine); const jobId = batch.jobs[0].id;
    const record = engine.requestBillingOverage(owner, jobId, proposal()).billingOverages[0];
    const rejected = engine.reviewBillingOverage(reviewer, jobId, record.id, review(record, { decision: "reject", note: "请补充供应商证明" }));
    expect(rejected.batch).toMatchObject({ status: "billing_unknown", maxCostMinor: 40 });
    expect(engine.getBudget(owner, "project-a")).toMatchObject({ reservedMinor: 40, spentMinor: 0 });
    expect(engine.reviewBillingOverage(reviewer, jobId, record.id, review(record, { decision: "reject", note: "请补充供应商证明" })).audit).toHaveLength(rejected.audit.length);
    const next = engine.requestBillingOverage(owner, jobId, proposal({ requestId: "new-proof-action", evidenceRef: "updated-proof" }));
    expect(next.billingOverages.map((item) => item.status)).toEqual(["rejected", "pending"]);
  });

  it("项目预算不足不结算；其他任务释放预算后可用同一审批动作再确认", () => {
    const engine = kernel({ limit: 80 }); const batch = unknown(engine, 2); const jobId = batch.jobs[0].id;
    const record = engine.requestBillingOverage(owner, jobId, proposal({ expectedBatchMaxCostMinor: 80, requestedBatchMaxCostMinor: 110 })).billingOverages[0];
    expect(() => engine.reviewBillingOverage(reviewer, jobId, record.id, review(record))).toThrowError(error("project_budget_exceeded"));
    expect(engine.getBudget(owner, "project-a")).toMatchObject({ limitMinor: 80, reservedMinor: 80, spentMinor: 0 });
    expect(engine.getBatch(owner, batch.batch.id).billingOverages[0].status).toBe("pending");
    engine.resolveBillingUnknown(auditor, batch.jobs[1].id, { resolutionId: "release-other", resolution: "not-charged", expectedReservedMinor: 40, expectedCurrency: "CNY", evidenceRef: "no-charge-ticket" });
    engine.reviewBillingOverage(reviewer, jobId, record.id, review(record));
    expect(engine.getBudget(owner, "project-a")).toMatchObject({ limitMinor: 80, reservedMinor: 0, spentMinor: 70, availableMinor: 10 });
  });

  it("覆盖全部批次预留，拒绝无效、过时和被其他审批改变的上限", () => {
    const engine = kernel(); const batch = unknown(engine, 2); const [first, second] = batch.jobs;
    expect(() => engine.requestBillingOverage(owner, first.id, proposal({ expectedBatchMaxCostMinor: 80, requestedBatchMaxCostMinor: 90 }))).toThrowError(error("billing_overage_ceiling_insufficient"));
    expect(() => engine.requestBillingOverage(owner, first.id, proposal({ expectedBatchMaxCostMinor: 40 }))).toThrowError(error("billing_overage_snapshot_mismatch"));
    expect(() => engine.requestBillingOverage(owner, first.id, proposal({ expectedBatchMaxCostMinor: 80, actualCostMinor: 40, requestedBatchMaxCostMinor: 80 }))).toThrowError(error("billing_overage_not_needed"));
    const a = engine.requestBillingOverage(owner, first.id, proposal({ expectedBatchMaxCostMinor: 80, actualCostMinor: 60, requestedBatchMaxCostMinor: 100 })).billingOverages[0];
    const b = engine.requestBillingOverage(owner, second.id, proposal({ requestId: "second-output", expectedBatchMaxCostMinor: 80, actualCostMinor: 60, requestedBatchMaxCostMinor: 120 })).billingOverages[1];
    expect(() => engine.reviewBillingOverage(reviewer, first.id, a.id, review(a, { expectedActualCostMinor: 50 }))).toThrowError(error("billing_overage_snapshot_mismatch"));
    engine.reviewBillingOverage(reviewer, first.id, a.id, review(a));
    expect(() => engine.reviewBillingOverage(reviewer, second.id, b.id, review(b, { reviewId: "review-second" }))).toThrowError(error("billing_overage_snapshot_mismatch"));
    engine.reviewBillingOverage(reviewer, second.id, b.id, review(b, { reviewId: "reject-stale", decision: "reject" }));
    const c = engine.requestBillingOverage(owner, second.id, proposal({ requestId: "fresh-second", expectedBatchMaxCostMinor: 100, actualCostMinor: 60, requestedBatchMaxCostMinor: 120 })).billingOverages[2];
    engine.reviewBillingOverage(reviewer, second.id, c.id, review(c, { reviewId: "approve-fresh" }));
    expect(engine.getBudget(owner, "project-a")).toMatchObject({ spentMinor: 120, reservedMinor: 0 });
  });

  it("申请和审批快照严格校验，拒绝空证据、空理由、额外金额字段", () => {
    expect(RequestBillingOverageSchema.safeParse({ ...proposal(), reason: " " }).success).toBe(false);
    expect(RequestBillingOverageSchema.safeParse({ ...proposal(), evidenceRef: "" }).success).toBe(false);
    const engine = kernel(); const batch = unknown(engine); const record = engine.requestBillingOverage(owner, batch.jobs[0].id, proposal()).billingOverages[0];
    expect(ReviewBillingOverageSchema.safeParse({ ...review(record), actualCostMinor: 1 }).success).toBe(false);
    expect(ReviewBillingOverageSchema.safeParse({ ...review(record), note: " " }).success).toBe(false);
  });

  it("待审批和已批准状态跨重启恢复，重复审批不会重复入账", () => {
    const store = new MemoryStore(); const first = kernel({ store }); const batch = unknown(first); const jobId = batch.jobs[0].id;
    const record = first.requestBillingOverage(owner, jobId, proposal()).billingOverages[0];
    const second = kernel({ store });
    expect(second.getBatch(owner, batch.batch.id).billingOverages[0].status).toBe("pending");
    const approved = second.reviewBillingOverage(reviewer, jobId, record.id, review(record));
    const third = kernel({ store });
    expect(third.reviewBillingOverage(reviewer, jobId, record.id, review(record)).ledger).toHaveLength(approved.ledger.length);
    expect(third.getBudget(owner, "project-a")).toMatchObject({ spentMinor: 70, reservedMinor: 0 });
    expect(third.requestBillingOverage(owner, jobId, proposal()).billingOverages).toHaveLength(1);
  });

  it("损坏的审批证据、同人审批或待审批预留错配会阻止恢复", () => {
    const store = new MemoryStore(); const engine = kernel({ store }); const batch = unknown(engine); const jobId = batch.jobs[0].id;
    const record = engine.requestBillingOverage(owner, jobId, proposal()).billingOverages[0];
    const pending = structuredClone(store.snapshot!);
    store.snapshot!.batches[0].aggregate.billingOverages[0].reason = "篡改理由";
    expect(() => kernel({ store })).toThrow(/超额申请证据/);
    store.snapshot = structuredClone(pending);
    store.snapshot.batches[0].aggregate.billingOverages.push(structuredClone(record));
    expect(() => kernel({ store })).toThrow(/超额申请归属/);
    store.snapshot = structuredClone(pending);
    const valid = kernel({ store }); valid.reviewBillingOverage(reviewer, jobId, record.id, review(record));
    const approved = store.snapshot!.batches[0].aggregate.billingOverages[0];
    if (approved.status === "pending") throw new Error("审批未完成");
    approved.reviewedBy = owner.actorId;
    expect(() => kernel({ store })).toThrow(/超额审批证据/);
  });

  it("旧版快照缺少审批数组时安全迁移为空列表", () => {
    const store = new MemoryStore(); const engine = kernel({ store }); const batch = unknown(engine);
    const old = store.snapshot! as unknown as { batches: { aggregate: { billingOverages?: BillingOverage[] } }[] };
    delete old.batches[0].aggregate.billingOverages;
    expect(kernel({ store }).getBatch(owner, batch.batch.id).billingOverages).toEqual([]);
  });

  it("安全整数边界的超额计算与恢复不丢失最小货币单位", () => {
    const store = new MemoryStore(); const engine = kernel({ limit: Number.MAX_SAFE_INTEGER, store });
    const batch = unknown(engine); const jobId = batch.jobs[0].id;
    const record = engine.requestBillingOverage(owner, jobId, proposal({ actualCostMinor: Number.MAX_SAFE_INTEGER, requestedBatchMaxCostMinor: Number.MAX_SAFE_INTEGER })).billingOverages[0];
    engine.reviewBillingOverage(reviewer, jobId, record.id, review(record));
    const restored = kernel({ limit: Number.MAX_SAFE_INTEGER, store });
    expect(restored.getBudget(owner, "project-a")).toMatchObject({ availableMinor: 0, spentMinor: Number.MAX_SAFE_INTEGER, reservedMinor: 0 });
    expect(restored.getBatch(owner, batch.batch.id).jobs[0].actualCostMinor).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("HTTP 入口默认关闭，拒绝匿名、普通核账审批、跨租户及不完整请求", async () => {
    const engine = kernel(); const batch = unknown(engine); const jobId = batch.jobs[0].id;
    const url = await listen(createApiServer({ runKernel: engine })); const path = `/v1/run-jobs/${jobId}/billing-overages`;
    expect((await post(url, path, "", proposal())).status).toBe(401);
    expect((await post(url, path, "foreign", proposal())).status).toBe(404);
    expect((await post(url, path, "designer", { ...proposal(), reason: "" })).status).toBe(400);
    const submitted = await post(url, path, "designer", proposal()); expect(submitted.status).toBe(201);
    const record = (await submitted.json() as RunBatchAggregate).billingOverages[0]; const reviewPath = `${path}/${record.id}/review`;
    expect((await post(url, reviewPath, "auditor", review(record))).status).toBe(403);
    expect((await post(url, reviewPath, "designer", review(record))).status).toBe(403);
    expect((await post(url, reviewPath, "reviewer", { ...review(record), note: "" })).status).toBe(400);
    expect((await post(url, reviewPath, "reviewer", review(record))).status).toBe(200);
    const disabled = await listen(createApiServer());
    expect((await post(disabled, path, "designer", proposal())).status).toBe(503);
    expect((await post(disabled, reviewPath, "reviewer", review(record))).status).toBe(503);
  });
});
