import { describe, expect, it, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ProductionImageBillingRecordSchema, type ReviewProductionImageBilling, type ProductionImageBillingRecord, type DecideProductionImageBilling } from "../packages/contracts/src/index";
import { ImageProductionBillingSettlementHarness, ProductionImageBillingSettlementService } from "../apps/api/src/productionImageBillingSettlement";
import type { ProductionBillingSourceContext } from "../apps/api/src/productionImageBillingReview";
import { ImageProductionBillingReviewHarness, ProductionImageBillingReviewService } from "../apps/api/src/productionImageBillingReview";
import { productionBillingTaskFixture as fixture } from "./helpers/production-billing-task-fixture";
import { principal } from "./helpers/image-task-fixture";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { imageSnapshotFingerprint as fp } from "../apps/api/src/imageProviderContract";
import * as decoder from "../apps/api/src/staticImageDecoder";
import * as protocol from "../apps/api/src/productionImageProtocol";

const reviewer = { ...principal, actorId: "other" };
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) if (!child.killed) child.kill(); });
type Task = Awaited<ReturnType<typeof fixture>>;
function setup(t: Task, extra: Record<string, unknown> = {}, stateStore = t.f.store) {
  let billing: ImageProductionBillingSettlementHarness;
  const source = { kind: "contract-fixture" as const, realExecutionEnabled: false as const, verify: vi.fn((_c: ProductionBillingSourceContext) => true) };
  const kernel = new SqliteRunKernel({ ...t.kernelOptions, authorizer: t.auth, budgets: stateStore.load()!.budgets, stateStore, clock: t.f.clock,
    productionImageBillingPolicy: { usesStateStore: s => billing?.billingPolicy.usesStateStore(s) ?? false,
      authorizeScope: (p,j,a) => billing?.billingPolicy.authorizeScope(p,j,a) ?? false, validateCommit: (p,r) => billing?.billingPolicy.validateCommit(p,r) ?? false } });
  const options = { billingSettlementEnabled: true as const, tenantId: principal.tenantId, stateStore, runKernel: kernel,
    runAuthorizer: t.auth, providerAuthorizer: t.auth, assetAuthorizer: t.auth, clock: t.f.clock, billingSource: source, ...extra };
  billing = new ImageProductionBillingSettlementHarness(options);
  const review = new ImageProductionBillingReviewHarness({ ...options, billingReviewEnabled: true });
  const args = [reviewer, "project-a", t.args[2], t.args[3]] as const;
  const snapshot = review.inspect(...args);
  const request = (actual = 25, reviewId = "owned-review"): ReviewProductionImageBilling => ({ reviewId, expectedSnapshotFingerprint: fp(snapshot),
    expectedCurrency: snapshot.currency, expectedReservedMinor: snapshot.reservedMinor, expectedMaxCostMinor: snapshot.maxCostMinor,
    resolution: actual ? "charged" : "not-charged", actualCostMinor: actual,
    evidence: { sourceId: "owned-billing", sourceVersion: "v1", evidenceRef: "owned-fake-bill", checksumSha256: "a".repeat(64), observedAt: snapshot.unknownAt } });
  const decide = (r: ProductionImageBillingRecord, decision: "approve" | "reject" = "approve", decisionId = "owned-decision"): DecideProductionImageBilling => ({ decisionId,
    expectedRecordFingerprint: fp(r), expectedSnapshotFingerprint: r.snapshotFingerprint, expectedCurrency: r.snapshot.currency,
    expectedReservedMinor: r.snapshot.reservedMinor, expectedActualCostMinor: r.request.actualCostMinor, decision, evidenceRef: "owned-approval", note: "人工逐项核对" });
  return { billing, options, kernel, source, review, args, snapshot, request, decide };
}
function processCommand(t: Task, request: ReviewProductionImageBilling | { reviewId: string; decision: DecideProductionImageBilling }) {
  const child = fork(fileURLToPath(new URL("./fixtures/production-billing-process.ts", import.meta.url)), [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"] }); children.push(child);
  return new Promise<{ ok: boolean; result: ProductionImageBillingRecord }>((resolve, reject) => {
    let delivered = false;
    child.on("error", reject); child.on("exit", () => { if (!delivered) reject(new Error("owned billing process exited before result")); });
    child.on("message", (m: { ready?: boolean; ok: boolean; result: ProductionImageBillingRecord }) => { if (m.ready) child.send("go"); else { delivered = true; resolve(m); } });
    child.send({ path: t.f.path, now: t.f.clock(), batch: t.args[2], job: t.args[3], ...("reviewId" in request && "decision" in request ? request : { request }) });
  });
}

describe("actual production billing settlement, owned zero-cost evidence only", () => {
  for (const protocolName of ["openai", "openai-compatible", "google"] as const) for (const manual of [false, true]) for (const image of [false, true]) {
    it(`${protocolName}/${manual ? "unknown" : "known"}/${image ? "artifact" : "no image"} settles once and recovers the full original chain`, async () => {
      const t = await fixture({ protocol: protocolName, manual, edit: true, bad: !image }); if (image) await t.artifacts.ingest(...t.args);
      const s = setup(t), before = t.saved(), record = s.billing.settle(...s.args, s.request());
      expect(record.status).toBe("settled"); expect(record.snapshot.estimate).toEqual(manual ? { state: "unknown" } : { state: "known", estimatedCostMinor: 25 });
      const after = t.saved(), job = after.aggregate.jobs[0];
      expect(job.status).toBe(image ? "succeeded" : "failed"); expect(job.actualCostMinor).toBe(25);
      expect(job.leaseId).toBe(before.aggregate.jobs[0].leaseId); expect(job.leaseOwnerId).toBe(before.aggregate.jobs[0].leaseOwnerId);
      expect(after.productionImageExecution).toEqual(before.productionImageExecution); expect(after.productionImageDispatchIntent).toEqual(before.productionImageDispatchIntent);
      expect(after.productionImageAttempt).toEqual(before.productionImageAttempt); expect(after.productionImageResult).toEqual(before.productionImageResult); expect(after.productionImageArtifact).toEqual(before.productionImageArtifact);
      expect(after.aggregate.ledger.map(l => l.settlement)).toEqual(["reserved", "unknown", "settled"]); expect(after.jobReservations).toEqual([]);
      expect(s.kernel.getBudget(principal, "project-a")).toMatchObject({ spentMinor: 25, reservedMinor: 0 });
      const read = t.price.read.mockClear(), verify = t.price.verify.mockClear(), decode = vi.spyOn(decoder, "decodeStaticImage"), normalize = vi.spyOn(protocol, "prepareProductionImageProtocol");
      expect(s.billing.settle(...s.args, s.request())).toEqual(record); expect(s.billing.inspect(...s.args)).toEqual([record]);
      const connection = new SqliteRunKernelStateStore(t.f.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true });
      try { const second = setup(t, {}, connection); expect(second.billing.settle(...second.args, second.request())).toEqual(record); expect(second.source.verify).not.toHaveBeenCalled();
        expect(second.kernel.getBudget(principal, "project-a")).toMatchObject({ spentMinor: 25, reservedMinor: 0 }); } finally { connection.close(); }
      expect(read).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); expect(normalize).not.toHaveBeenCalled();
      expect(s.source.verify).toHaveBeenCalledTimes(2); expect(t.send).toHaveBeenCalledTimes(1);
    });
  }
  for (const cap of [0, 40]) it(`not-charged cap ${cap} preserves unknown estimate and releases exactly the original reservation`, async () => {
    const t = await fixture({ cap }), s = setup(t), r = s.billing.settle(...s.args, s.request(0));
    expect(r.request.actualCostMinor).toBe(0); expect(t.saved().aggregate.ledger.at(-1)).toMatchObject({ settlement: "released", estimatedMinor: null, actualMinor: 0, reservedMinor: 0 });
    expect(s.kernel.getBudget(principal, "project-a")).toMatchObject({ spentMinor: 0, reservedMinor: 0 });
  });
  it("overage keeps max reservation until a different independently authorized actor approves; no project budget increase", async () => {
    const t = await fixture(), s = setup(t), before = t.saved(), pending = s.billing.settle(...s.args, s.request(65));
    expect(pending.status).toBe("pending"); expect(t.saved().reservedMinor).toBe(40); expect(t.saved().actualMinor).toBe(0);
    expect(() => s.billing.decide(...s.args, pending.request.reviewId, s.decide(pending))).toThrow(/保持/);
    const approved = s.billing.decide(principal, ...s.args.slice(1) as [string,string,string], pending.request.reviewId, s.decide(pending));
    expect(approved.status).toBe("settled"); expect(t.saved().aggregate.batch.maxCostMinor).toBe(65);
    expect(t.saved().productionImageExecution).toEqual(before.productionImageExecution); expect(s.kernel.getBudget(principal, "project-a")).toMatchObject({ spentMinor: 65, reservedMinor: 0, limitMinor: 1000 });
    expect(s.billing.decide(principal, ...s.args.slice(1) as [string,string,string], pending.request.reviewId, s.decide(pending))).toEqual(approved);
    expect(s.source.verify).toHaveBeenCalledTimes(4);
  });
  it("rejected overage retains immutable history and permits a separate new verified review", async () => {
    const t = await fixture(), s = setup(t), pending = s.billing.settle(...s.args, s.request(65));
    const rejected = s.billing.decide(principal, ...s.args.slice(1) as [string,string,string], pending.request.reviewId, s.decide(pending, "reject"));
    expect(rejected.status).toBe("rejected"); expect(t.saved().reservedMinor).toBe(40); expect(t.saved().aggregate.jobs[0].status).toBe("billing_unknown");
    expect(s.billing.settle(...s.args, s.request(25, "separate-review")).status).toBe("settled");
    expect(s.billing.inspect(...s.args)[0]).toEqual(rejected); expect(t.saved().productionImageBilling).toHaveLength(2);
  });
  for (const permission of ["run:read", "run:reconcile-billing", "provider:read", "asset:read"]) it(`${permission} is checked before private task or body reads`, async () => {
    const t = await fixture(), s = setup(t); t.denied.add(permission);
    const load = vi.spyOn(t.f.store, "load"), body = vi.spyOn(t.f.store, "loadProductionImageResponse");
    expect(() => s.billing.settle(...s.args, s.request())).toThrow(); expect(load).not.toHaveBeenCalled(); expect(body).not.toHaveBeenCalled(); expect(s.source.verify).not.toHaveBeenCalled();
  });
  for (const change of ["off", "source", "tenant", "store"] as const) it(`default/config ${change} cannot read private evidence`, async () => {
    const t = await fixture(), s = setup(t), options = { ...s.options,
      ...(change === "off" ? { billingSettlementEnabled: false } : change === "source" ? { billingSource: { ...s.source, kind: "server-billing" } }
        : change === "tenant" ? { tenantId: "another" } : { runKernel: { usesStateStore: () => false } }) };
    const load = vi.spyOn(t.f.store, "load"), body = vi.spyOn(t.f.store, "loadProductionImageResponse");
    const service = new ImageProductionBillingSettlementHarness(options as never);
    expect(() => service.settle(...s.args, s.request())).toThrow(); expect(load).not.toHaveBeenCalled(); expect(body).not.toHaveBeenCalled();
    expect(() => new ImageProductionBillingSettlementHarness().settle(...s.args, s.request())).toThrow();
  });
  it("production service cannot relabel owned fixture task and billing source", async () => {
    const t = await fixture(), s = setup(t), service = new ProductionImageBillingSettlementService({ ...s.options, billingSource: { kind: "server-billing", verify: s.source.verify } });
    const before = t.f.store.load(); expect(() => service.settle(...s.args, s.request())).toThrow(); expect(t.f.store.load()).toEqual(before); expect(s.source.verify).not.toHaveBeenCalled();
  });
  for (const permission of ["run:execute", "asset:write"]) it(`review and approval do not borrow ${permission} or change sender`, async () => {
    const t = await fixture(), s = setup(t); t.denied.add(permission);
    expect(s.billing.settle(...s.args, s.request()).status).toBe("settled"); expect(t.saved().productionImageAttempt?.actorId).toBe(principal.actorId);
  });
  for (const field of ["expectedSnapshotFingerprint", "expectedCurrency", "expectedReservedMinor", "expectedMaxCostMinor"] as const) it(`human frozen ${field} mismatch is rejected before source`, async () => {
    const t = await fixture(), s = setup(t), request = s.request();
    (request as Record<string, unknown>)[field] = field === "expectedSnapshotFingerprint" ? "b".repeat(64) : field === "expectedCurrency" ? "USD" : 39;
    const before = t.f.store.load(); expect(() => s.billing.settle(...s.args, request)).toThrow(); expect(s.source.verify).not.toHaveBeenCalled(); expect(t.f.store.load()).toEqual(before);
  });
  for (const value of [false, 1, Promise.resolve(true), "throw"] as const) it(`strict synchronous source ${String(value)} cannot settle`, async () => {
    const t = await fixture(), s = setup(t), before = t.f.store.load();
    s.source.verify.mockImplementation(() => { if (value === "throw") throw new Error("private fake bill details"); return value as never; });
    expect(() => s.billing.settle(...s.args, s.request())).toThrow(); expect(t.f.store.load()).toEqual(before);
  });
  for (const phase of ["initial", "post-write"] as const) for (const failure of ["revoke", "clock", "source-withdrawal", "constraint", "save-throws"] as const) it(`${phase} ${failure} rolls back the complete new financial write`, async () => {
    const t = await fixture({ edit: true }), s = setup(t), before = t.f.store.load();
    const fail = () => { if (failure === "revoke") t.revoke(); else if (failure === "clock") t.f.advance(-1);
      else if (failure === "constraint") { const catalog = t.f.store.loadCatalog()!; catalog.projects[0].constraints[0].brandRules.style = "changed"; t.f.store.saveCatalog(catalog); }
      else if (failure === "save-throws") throw new Error("owned storage fault"); return failure !== "source-withdrawal"; };
    s.source.verify.mockImplementation(() => s.source.verify.mock.calls.length === (phase === "initial" ? 1 : 2) ? fail() : true);
    expect(() => s.billing.settle(...s.args, s.request())).toThrow(); expect(t.f.store.load()).toEqual(before);
    expect(t.saved().reservedMinor).toBe(40); expect(t.saved().productionImageBilling).toBeUndefined();
  });
  it("actual SQL save revocation rolls back settlement, audit, budget and source record", async () => {
    const t = await fixture(), s = setup(t), before = t.f.store.load(), save = t.f.store.save.bind(t.f.store);
    vi.spyOn(t.f.store, "save").mockImplementation(snapshot => { save(snapshot); t.revoke(); });
    expect(() => s.billing.settle(...s.args, s.request())).toThrow(); expect(t.f.store.load()).toEqual(before);
  });
  it("post-write metadata capacity rejects added records without discarding original response", async () => {
    const t = await fixture(), s = setup(t), before = t.f.store.load();
    const original = t.f.store.imageMetadataBytes.bind(t.f.store);
    vi.spyOn(t.f.store, "imageMetadataBytes").mockImplementation((tenant, project) => t.saved().productionImageBilling ? 16 * 1024 * 1024 : original(tenant, project));
    expect(() => s.billing.settle(...s.args, s.request())).toThrow(); expect(t.f.store.load()).toEqual(before);
    expect(t.f.store.loadProductionImageResponse(principal.tenantId, "project-a", "production-contract-fixture", t.args[3])?.record).toEqual(before!.batches[0].productionImageResult);
  });
  it("approval needs separate permission and exact cost/evidence, with no project budget increase", async () => {
    const t = await fixture(), s = setup(t), pending = s.billing.settle(...s.args, s.request(1001)), before = t.f.store.load();
    t.denied.add("run:approve-billing-overage"); const body = vi.spyOn(t.f.store, "loadProductionImageResponse");
    expect(() => s.billing.decide(principal, ...s.args.slice(1) as [string,string,string], pending.request.reviewId, s.decide(pending))).toThrow(); expect(body).not.toHaveBeenCalled();
    t.denied.clear(); expect(() => s.billing.decide(principal, ...s.args.slice(1) as [string,string,string], pending.request.reviewId, s.decide(pending))).toThrow();
    expect(t.f.store.load()).toEqual(before); expect(t.saved().productionImageBilling?.[0].status).toBe("pending");
    expect(t.saved().reservedMinor).toBe(40);
  });
  it("pending source copies cannot mutate evidence; reentrant settlement and closed pending replay are rejected", async () => {
    const t = await fixture(), s = setup(t); s.source.verify.mockImplementation(c => { c.snapshot.workerId = "copied"; c.request.actualCostMinor = 1;
      expect(() => s.billing.settle(...s.args, s.request())).toThrow(); return true; });
    const result = s.billing.settle(...s.args, s.request()); expect(result.snapshot.workerId).toBe("owned-worker"); expect(result.request.actualCostMinor).toBe(25);
    expect(s.billing.billingPolicy.validateCommit(reviewer, result)).toBe(false); expect(() => s.kernel.commitProductionImageBilling(reviewer, result)).toThrow();
  });
  it("A draft, source label, client confirmed and unsafe/changed actual fee cannot serve as commitment", async () => {
    const t = await fixture(), s = setup(t), draft = s.review.verify(...s.args, s.request()), before = t.f.store.load();
    for (const request of [draft, { ...s.request(), confirmed: true }, { ...s.request(), actualCostMinor: Number.MAX_SAFE_INTEGER + 1 }]) expect(() => s.billing.settle(...s.args, request as never)).toThrow();
    expect(t.f.store.load()).toEqual(before); const result = s.billing.settle(...s.args, s.request());
    expect(() => s.billing.settle(...s.args, { ...s.request(), actualCostMinor: 26 })).toThrow(); expect(t.saved().productionImageBilling?.[0]).toEqual(result);
    expect(ProductionImageBillingRecordSchema.safeParse({ ...result, snapshot: { ...result.snapshot, estimate: { state: "known", estimatedCostMinor: 0 } } }).success).toBe(true);
    // Schema success is deliberately not current task/commit proof.
    expect(() => s.kernel.commitProductionImageBilling(reviewer, { ...result, snapshot: { ...result.snapshot, estimate: { state: "known", estimatedCostMinor: 0 } } })).toThrow();
  });
  it("independent OS processes replay one actual settlement without duplicate expense or released cap", async () => {
    const t = await fixture(), s = setup(t), [first, second] = await Promise.all([processCommand(t, s.request()), processCommand(t, s.request())]);
    expect(first.ok).toBe(true); expect(second.ok).toBe(true); expect(first.result).toEqual(second.result);
    expect(t.saved().productionImageBilling).toHaveLength(1); expect(t.saved().aggregate.ledger).toHaveLength(3);
    expect(s.kernel.getBudget(principal, "project-a")).toMatchObject({ spentMinor: 25, reservedMinor: 0 });
  });
  it("independent OS processes approve one frozen overage only once", async () => {
    const t = await fixture(), s = setup(t), pending = s.billing.settle(...s.args, s.request(65)), request = { reviewId: pending.request.reviewId, decision: s.decide(pending) };
    const [first, second] = await Promise.all([processCommand(t, request), processCommand(t, request)]);
    expect(first.ok).toBe(true); expect(second.ok).toBe(true); expect(first.result).toEqual(second.result);
    expect(t.saved().aggregate.audit.filter(a => a.eventType === "production-billing-approved")).toHaveLength(1);
    expect(s.kernel.getBudget(principal, "project-a")).toMatchObject({ spentMinor: 65, reservedMinor: 0 });
  });
  it("two actual production overages in the same budget race; only the affordable one settles", async () => {
    const first = await fixture(), second = await fixture({ path: first.f.path, actionId: "owned-second-action" });
    const a = setup(first), b = setup(second), ar = a.billing.settle(...a.args, a.request(600)), br = b.billing.settle(...b.args, b.request(600));
    const results = await Promise.all([processCommand(first, { reviewId: ar.request.reviewId, decision: a.decide(ar) }), processCommand(second, { reviewId: br.request.reviewId, decision: b.decide(br) })]);
    expect(results.filter(r => r.ok)).toHaveLength(1); expect(results.filter(r => !r.ok)).toHaveLength(1);
    expect(a.kernel.getBudget(principal, "project-a")).toMatchObject({ spentMinor: 600, reservedMinor: 40, availableMinor: 360, limitMinor: 1000 });
    const states = first.f.store.load()!.batches.map(s => s.productionImageBilling![0].status).sort(); expect(states).toEqual(["pending", "settled"]);
  });
  it.each(["fingerprint", "fee", "summary", "audit", "ledger", "budget", "original", "delete-fees", "original-response"])("settled %s damage fails closed even after selected SHA recomputation", async kind => {
    const t = await fixture(), s = setup(t); await t.artifacts.ingest(...t.args);
    // The old snapshot predates this committed artifact; take a new human view.
    const current = setup(t), result = current.billing.settle(...current.args, current.request()), x = t.f.store.load()!, b = x.batches[0];
    if (kind === "fingerprint") b.productionImageBillingFingerprint = "0".repeat(64);
    if (kind === "fee") { b.productionImageBilling![0].request.actualCostMinor = 24; b.productionImageBillingFingerprint = fp(b.productionImageBilling); }
    if (kind === "summary") b.aggregate.productionBilling![0].actualCostMinor = 24;
    if (kind === "audit") b.aggregate.audit = b.aggregate.audit.filter(a => a.eventType !== "production-billing-reviewed");
    if (kind === "ledger") b.aggregate.ledger.at(-1)!.actualMinor = 24;
    if (kind === "budget") x.budgets[0].spentMinor = 24;
    if (kind === "original") b.productionImageAttemptFingerprint = "0".repeat(64);
    if (kind === "delete-fees") { delete b.productionImageBilling; delete b.productionImageBillingFingerprint; delete b.aggregate.productionBilling; }
    if (kind === "original-response") { const d = new DatabaseSync(t.f.path); try { d.exec("DELETE FROM production_image_response_presence"); } finally { d.close(); } }
    else t.f.store.transaction(() => t.f.store.save(x));
    expect(() => current.billing.inspect(...current.args)).toThrow(); expect(() => new SqliteRunKernel({ ...t.kernelOptions, stateStore: t.f.store, authorizer: t.auth, budgets: [{ tenantId: "tenant-a", projectId: "project-a", currency: "CNY", limitMinor: 1000 }], clock: t.f.clock })).toThrow();
    expect(result.status).toBe("settled"); expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("ordinary legacy billing/cancel/retry cannot overwrite completed independent production evidence", async () => {
    const t = await fixture(), s = setup(t); s.billing.settle(...s.args, s.request()); const before = t.f.store.load();
    expect(() => t.f.kernel.resolveBillingUnknown(principal, t.args[3], { resolutionId: "old", resolution: "not-charged", expectedReservedMinor: 0, expectedCurrency: "CNY", evidenceRef: "owned" })).toThrow();
    expect(() => t.f.kernel.cancelBatch(principal, t.args[2])).toThrow(); expect(() => t.f.kernel.retryJob(principal, t.args[3], {} as never)).toThrow();
    expect(t.f.store.load()).toEqual(before);
  });
  it.each(["NaN", "async-authorizer", "zero-quota"])("%s refuses before original raw reads", async kind => {
    const t = await fixture(), s = setup(t), options = { ...s.options, ...(kind === "NaN" ? { clock: () => NaN } : kind === "zero-quota" ? { maxMetadataBytes: 0 }
      : { runAuthorizer: { ...t.auth, allows: () => Promise.resolve(true) } }) };
    const service = new ImageProductionBillingSettlementHarness(options as never), read = vi.spyOn(t.f.store, "loadProductionImageResponse");
    expect(() => service.settle(...s.args, s.request())).toThrow(); expect(read).not.toHaveBeenCalled();
  });
  it("expired quote and disabled directory preserve original human history without price verify/read or new sending", async () => {
    const t = await fixture(), s = setup(t); t.f.advance(120_000); t.f.register({ ...t.config, revision: 2, enabled: false });
    t.price.read.mockClear(); t.price.verify.mockClear(); const result = s.billing.settle(...s.args, s.request());
    expect(result.status).toBe("settled"); expect(s.billing.inspect(...s.args)).toEqual([result]); expect(t.price.read).not.toHaveBeenCalled(); expect(t.price.verify).not.toHaveBeenCalled(); expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("post-SQL zero-cap source withdrawal keeps original unknown job and zero reservation relationship", async () => {
    const t = await fixture({ cap: 0 }), s = setup(t), before = t.f.store.load(); s.source.verify.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(() => s.billing.settle(...s.args, s.request(0))).toThrow(); expect(t.f.store.load()).toEqual(before); expect(t.saved().jobReservations).toEqual([[t.args[3], 0]]);
  });
  it.each(["expectedRecordFingerprint", "expectedSnapshotFingerprint", "expectedCurrency", "expectedReservedMinor", "expectedActualCostMinor"] as const)("approval %s drift cannot change amount or consume the decision", async field => {
    const t = await fixture(), s = setup(t), pending = s.billing.settle(...s.args, s.request(65)), decision = s.decide(pending), before = t.f.store.load();
    (decision as Record<string, unknown>)[field] = field.includes("Fingerprint") ? "b".repeat(64) : field === "expectedCurrency" ? "USD" : 1;
    s.source.verify.mockClear(); expect(() => s.billing.decide(principal, ...s.args.slice(1) as [string,string,string], pending.request.reviewId, decision)).toThrow();
    expect(s.source.verify).not.toHaveBeenCalled(); expect(t.f.store.load()).toEqual(before);
  });
  it.each([false, true])("independent production namespace with owned pricing/billing oracle, %s manual, never dispatches a fixture or native request", async manual => {
    const t = await fixture({ productionStartOnly: true, manual }); let service: ProductionImageBillingSettlementService;
    const source = { kind: "server-billing" as const, verify: vi.fn(() => true) };
    const kernel = new SqliteRunKernel({ ...t.kernelOptions, stateStore: t.f.store, authorizer: t.auth, budgets: t.f.store.load()!.budgets, clock: t.f.clock,
      productionImageBillingPolicy: { usesStateStore: s => service?.billingPolicy.usesStateStore(s) ?? false,
        authorizeScope: (p,j,a) => service?.billingPolicy.authorizeScope(p,j,a) ?? false, validateCommit: (p,r) => service?.billingPolicy.validateCommit(p,r) ?? false } });
    const options = { billingSettlementEnabled: true as const, tenantId: principal.tenantId, stateStore: t.f.store, runKernel: kernel,
      runAuthorizer: t.auth, providerAuthorizer: t.auth, assetAuthorizer: t.auth, clock: t.f.clock, billingSource: source };
    service = new ProductionImageBillingSettlementService(options);
    const snapshot = new ProductionImageBillingReviewService({ ...options, billingReviewEnabled: true }).inspect(reviewer, "project-a", t.args[2], t.args[3]);
    const request: ReviewProductionImageBilling = { reviewId: "owned-production-no-bill", expectedSnapshotFingerprint: fp(snapshot), expectedCurrency: snapshot.currency,
      expectedReservedMinor: 40, expectedMaxCostMinor: 40, resolution: "not-charged", actualCostMinor: 0,
      evidence: { sourceId: "owned-oracle", sourceVersion: "v1", evidenceRef: "no-real-billing", checksumSha256: "a".repeat(64), observedAt: snapshot.unknownAt } };
    const record = service.settle(reviewer, "project-a", t.args[2], t.args[3], request);
    expect(record.mode).toBe("production"); expect(record.status).toBe("settled"); expect(record.snapshot.estimate.state).toBe(manual ? "unknown" : "known");
    expect(record.snapshot.attemptFingerprint).toBeNull(); expect(record.snapshot.resultFingerprint).toBeNull(); expect(record.snapshot.artifactFingerprint).toBeNull();
    expect(t.saved().aggregate.jobs[0].status).toBe("failed"); expect(kernel.getBudget(principal, "project-a")).toMatchObject({ spentMinor: 0, reservedMinor: 0 });
    expect(source.verify).toHaveBeenCalledTimes(2); expect(t.send).not.toHaveBeenCalled(); expect(t.saved().productionImageDispatchIntent?.transport).toBe("not-connected");
  });
});
