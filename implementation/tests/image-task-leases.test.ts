import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageDispatchIntentSchema, type RunBatchAggregate } from "../packages/contracts/src/index";
import { InMemoryRunKernel, type RunKernelOptions } from "../apps/api/src/runKernel";
import { LocalImageTaskLeases } from "../apps/api/src/imageTaskLeases";
import { prepareOpenAiImageRequest } from "../apps/api/src/openaiImageProtocol";
import { imageSnapshotFingerprint } from "../apps/api/src/imageProviderContract";
import { withStaticImageDecodeSlot } from "../apps/api/src/staticImageDecoder";
import { createApiServer } from "../apps/api/src/index";
import { at, connection, principal, setupImageTask, sha } from "./helpers/image-task-fixture";

const fixtures: ReturnType<typeof setupImageTask>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0).reverse()) fixture.cleanup(); });
const setup = (options: Parameters<typeof setupImageTask>[0] = {}) => { const fixture = setupImageTask(options); fixtures.push(fixture); return fixture; };
const claim = (fixture: ReturnType<typeof setup>, batch: RunBatchAggregate, workerId = "fixture-worker") =>
  fixture.kernel.claimImageBatch(principal, batch.batch.id, { workerId, maxJobs: 1 });
const leaseInput = (lease: { workerId: string; leaseId: string }) => ({ workerId: lease.workerId, leaseId: lease.leaseId });
const start = (fixture: ReturnType<typeof setup>, batch: RunBatchAggregate, lease: { workerId: string; leaseId: string }) => fixture.leases.prepareStart(principal, batch.jobs[0].id, leaseInput(lease));
const rejectCode = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });
const held = (fixture: ReturnType<typeof setup>, reservedMinor = 30) => expect(fixture.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor, spentMinor: 0 });
const noIntent = (fixture: ReturnType<typeof setup>) => expect(fixture.store.load()!.batches.every((batch) => !batch.imageDispatchIntent)).toBe(true);

describe("服务端内部本地图片租约与未连接传输的持久化意图", () => {
  it("默认不配置权威政策时拒绝图片领取，原确认/上限预留不变", async () => {
    const f = setup({ policy: false }); f.register(); const batch = await f.confirm();
    expect(() => claim(f, batch)).toThrow(expect.objectContaining({ code: "image_lease_policy_not_configured" }));
    expect(f.kernel.getBatch(principal, batch.batch.id).jobs[0].status).toBe("queued"); noIntent(f); held(f);
  });
  it("重建确认负载后绑定领取人/租约并原子保存意图，没有外网、供应商响应或资产", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("forbidden-network"));
    const f = setup(); f.register(); const batch = await f.confirm(); const lease = claim(f, batch).leases[0];
    const result = await start(f, batch, lease); const stored = f.store.load()!.batches[0], execution = stored.imageExecution!;
    expect(result).toMatchObject({ started: true, intent: { mode: "local-fixture", transport: "not-connected", actorId: "writer", workerId: lease.workerId, leaseId: lease.leaseId,
      executionFingerprint: stored.requestFingerprint, requestFingerprint: execution.requestFingerprint, payloadChecksumSha256: execution.payloadChecksumSha256, recordedAt: at } });
    expect(result.aggregate.jobs[0]).toMatchObject({ status: "running", outputAssetIds: [] }); expect(result.aggregate.jobs[0].providerRequestId).toBeUndefined();
    expect(stored.imageDispatchIntentFingerprint).toBe(imageSnapshotFingerprint(result.intent));
    const wire = await prepareOpenAiImageRequest(execution.preparation.connection, execution.request, [], at);
    expect(result.intent.payloadChecksumSha256).toBe(sha(wire.body)); expect(result.intent.payloadByteSize).toBe(wire.body.length);
    expect(result.aggregate.audit.filter((event) => event.eventType === "job-started")).toHaveLength(1); held(f); expect(network).not.toHaveBeenCalled();
    expect(f.store.loadCatalog()!.projects[0].assets).toEqual([]);
    const publicResult = JSON.stringify(result); expect(publicResult).not.toContain(connection().baseUrl); expect(publicResult).not.toContain(connection().credentialRef); expect(publicResult).not.toContain('"body"');
  });
  it("两个数据库连接领取不重复，两个并行准备只允许一次 started=true", async () => {
    const a = setup(); a.register(); const batch = await a.confirm(); const b = setup({ path: a.path });
    const lease = claim(a, batch).leases[0]; expect(claim(b, batch).leases).toEqual([]);
    const [left, right] = await Promise.all([start(a, batch, lease), start(b, batch, lease)]);
    expect([left.started, right.started].sort()).toEqual([false, true]); expect(left.intent).toEqual(right.intent);
    expect(a.store.load()!.batches).toHaveLength(1); expect(a.kernel.getBatch(principal, batch.batch.id).audit.filter((event) => event.eventType === "job-started")).toHaveLength(1); held(a);
  });
  it("重启、报价过期及目录停用后的历史恢复不能再次派发，也不读取原图字节", async () => {
    const a = setup(); a.register(); a.source(); const batch = await a.confirm("edit", { operation: "edit", inputAssetIds: ["source"] }); const lease = claim(a, batch).leases[0];
    const first = await start(a, batch, lease); const b = setup({ path: a.path }); b.advance(61_000); b.register(connection({ revision: 2, enabled: false }));
    const reads = vi.spyOn(b.store, "loadVerifiedImageBytes"); const replay = await start(b, batch, lease);
    expect(replay).toMatchObject({ started: false, intent: first.intent }); expect(replay.aggregate.jobs[0].status).toBe("billing_unknown"); expect(reads).not.toHaveBeenCalled(); held(b);
    expect(b.store.load()!.batches[0].aggregate.audit.filter((event) => event.eventType === "job-started")).toHaveLength(1);
  });
  it("错误执行器、租约、领取人或无执行权限在解码前拒绝", async () => {
    const f = setup(); f.register(); f.source(); const batch = await f.confirm("edit", { operation: "edit", inputAssetIds: ["source"] }); const lease = claim(f, batch).leases[0];
    const reads = vi.spyOn(f.store, "loadVerifiedImageBytes");
    await rejectCode(start(f, batch, { ...lease, workerId: "other-worker" }), "run_job_lease_mismatch");
    await rejectCode(start(f, batch, { ...lease, leaseId: "other-lease" }), "run_job_lease_mismatch");
    await rejectCode(f.leases.prepareStart({ ...principal, actorId: "other" }, batch.jobs[0].id, leaseInput(lease)), "run_job_lease_mismatch");
    f.denyRun("run:execute"); await rejectCode(start(f, batch, lease), "run_permission_denied"); expect(reads).not.toHaveBeenCalled(); noIntent(f); held(f);
  });
  it("排队状态及取消状态不能自报租约启动", async () => {
    const f = setup(); f.register(); const batch = await f.confirm();
    await rejectCode(start(f, batch, { workerId: "fixture-worker", leaseId: "self-reported" }), "run_job_lease_mismatch");
    f.kernel.cancelBatch(principal, batch.batch.id);
    await rejectCode(start(f, batch, { workerId: "fixture-worker", leaseId: "self-reported" }), "run_job_lease_mismatch"); noIntent(f); held(f, 0);
  });
  it("领取后未启动过期可重新领取不同租约，旧租约不能启动", async () => {
    const f = setup({ kernel: { leaseDurationMs: 1000 } }); f.register(); const batch = await f.confirm(); const old = claim(f, batch).leases[0]; f.advance(1001);
    const current = claim(f, batch).leases[0]; expect(current.leaseId).not.toBe(old.leaseId); await rejectCode(start(f, batch, old), "run_job_lease_mismatch");
    expect((await start(f, batch, current)).started).toBe(true); held(f);
  });
  it("已领取但从未启动的任务取消释放上限，不产生派发意图", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(); const lease = claim(f, batch).leases[0];
    expect(f.kernel.cancelBatch(principal, batch.batch.id).jobs[0].status).toBe("cancelled");
    await rejectCode(start(f, batch, lease), "run_job_not_leased"); held(f, 0); noIntent(f);
  });
  it("启动后租约过期进入计费未知，保留上限且重复恢复不会重发/重计账", async () => {
    const f = setup({ kernel: { leaseDurationMs: 1000 } }); f.register(); const batch = await f.confirm(); const lease = claim(f, batch).leases[0]; const first = await start(f, batch, lease); f.advance(1001);
    const unknown = f.kernel.reconcileImageBatch(principal, batch.batch.id); expect(unknown.jobs[0]).toMatchObject({ status: "billing_unknown", outputAssetIds: [] });
    expect((await start(f, batch, lease))).toMatchObject({ started: false, intent: first.intent });
    expect(f.kernel.reconcileImageBatch(principal, batch.batch.id).ledger).toEqual(unknown.ledger); held(f);
    expect(() => claim(f, batch)).toThrow(expect.objectContaining({ code: "billing_state_unknown" }));
    expect(() => f.kernel.cancelBatch(principal, batch.batch.id)).toThrow(expect.objectContaining({ code: "billing_state_unknown" }));
    expect(() => f.kernel.retryJob(principal, batch.jobs[0].id, { expectedEstimatedCostMinor: 25, expectedCurrency: "CNY", mockScenario: "success" })).toThrow(expect.objectContaining({ code: "image_execution_not_configured" }));
  });
  it("图片运行超时不走旧 mock 已知费用失败释放路径", async () => {
    const f = setup({ kernel: { jobTimeoutMs: 1000, leaseDurationMs: 30000, unitActualMinor: 20 } }); f.register(); const batch = await f.confirm(); const lease = claim(f, batch).leases[0]; await start(f, batch, lease); f.advance(1000);
    expect(f.kernel.reconcileImageBatch(principal, batch.batch.id).jobs[0]).toMatchObject({ status: "billing_unknown", failureCode: "image-dispatch-outcome-unknown" }); held(f);
    expect(f.store.load()!.batches[0].aggregate.ledger.some((entry) => ["settled", "released"].includes(entry.settlement))).toBe(false);
  });
  it("不共享数据库的内存恢复将已启动图片保守转为计费未知", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(); const lease = claim(f, batch).leases[0]; await start(f, batch, lease);
    let snapshot = f.store.load()!;
    const recovered = new InMemoryRunKernel({ budgets: snapshot.budgets, authorizer: { authenticate: () => principal, allows: () => true }, clock: f.clock,
      stateStore: { load: () => snapshot, save: (next) => { snapshot = next; } } });
    expect(recovered.getBatch(principal, batch.batch.id).jobs[0].status).toBe("billing_unknown"); expect(snapshot.budgets[0].reservedMinor).toBe(30);
  });
  it("领取前目录修订、报价到期与约束变化都不能沿用确认", async () => {
    for (const kind of ["directory", "quote", "constraint"] as const) {
      const f = setup(); f.register(); const batch = await f.confirm();
      if (kind === "directory") f.register(connection({ revision: 2 }));
      if (kind === "quote") f.advance(60000);
      if (kind === "constraint") f.store.transaction(() => { const catalog = f.store.loadCatalog()!; catalog.projects[0].constraints[0].lockedPaths = ["product.pixels"]; f.store.saveCatalog(catalog); });
      expect(() => claim(f, batch)).toThrow(expect.objectContaining({ code: kind === "directory" ? "image_connection_changed" : kind === "quote" ? "image_quote_expired" : "image_output_constraint_changed" }));
      noIntent(f); held(f);
    }
  });
  it("领取后资产/供应商权限撤销在读取原图之前拒绝", async () => {
    for (const kind of ["provider", "asset"] as const) {
      const f = setup(); f.register(); f.source(); const batch = await f.confirm("edit", { operation: "edit", inputAssetIds: ["source"] }); const lease = claim(f, batch).leases[0];
      kind === "provider" ? f.revokeProvider() : f.revokeAsset(); const reads = vi.spyOn(f.store, "loadVerifiedImageBytes");
      await rejectCode(start(f, batch, lease), "image_task_permission_denied"); expect(reads).not.toHaveBeenCalled(); noIntent(f); held(f);
    }
  });
  it("异步负载重建后的目录、权限、原图登记及报价仍二次核验", async () => {
    for (const kind of ["directory", "permission", "input", "quote"] as const) {
      const f = setup({ kernel: { leaseDurationMs: 120000 } }); f.register(); f.source(); const batch = await f.confirm("edit", { operation: "edit", inputAssetIds: ["source"] }); const lease = claim(f, batch).leases[0]; const pending = start(f, batch, lease);
      if (kind === "directory") f.register(connection({ revision: 2 }));
      if (kind === "permission") f.revokeAsset();
      if (kind === "input") f.store.transaction(() => { const catalog = f.store.loadCatalog()!; catalog.projects[0].assets[0].originalName = "changed.png"; f.store.saveCatalog(catalog); });
      if (kind === "quote") f.advance(60000);
      await rejectCode(pending, kind === "directory" ? "image_connection_changed" : kind === "permission" ? "image_task_permission_denied" : kind === "input" ? "image_input_not_verified" : "image_quote_expired"); noIntent(f); held(f);
    }
  });
  it("异步准备期间租约到期不得写意图，预留仍保留", async () => {
    const f = setup({ kernel: { leaseDurationMs: 1000 } }); f.register(); f.source(); const batch = await f.confirm("edit", { operation: "edit", inputAssetIds: ["source"] }); const lease = claim(f, batch).leases[0];
    const pending = start(f, batch, lease); f.advance(1001); await rejectCode(pending, "run_job_not_leased"); noIntent(f); held(f);
  });
  it("最终同步政策核验跨过租约边界同样拒绝意图并安全恢复 queued", async () => {
    let f!: ReturnType<typeof setup>;
    f = setup({ kernel: { leaseDurationMs: 1000, validateImageTask: (_actor, _execution, intent) => { if (intent) f.advance(1000); return undefined; } } });
    f.register(); const batch = await f.confirm(), lease = claim(f, batch).leases[0];
    await rejectCode(start(f, batch, lease), "run_job_not_leased"); noIntent(f); held(f);
    expect(f.kernel.getBatch(principal, batch.batch.id).jobs[0].status).toBe("queued");
  });
  it("同进程图片派发准备上限两份，第三份可稍后用原租约继续", async () => {
    const f = setup({ kernel: { maxConcurrentJobs: 4 } }); f.register();
    const batches = await Promise.all([f.confirm("one"), f.confirm("two")]); const third = await f.confirm("three");
    const leases = [...batches, third].map((batch) => claim(f, batch).leases[0]);
    const pending = batches.map((batch, i) => start(f, batch, leases[i])); await rejectCode(start(f, third, leases[2]), "image_dispatch_capacity"); await Promise.all(pending);
    expect((await start(f, third, leases[2])).started).toBe(true); held(f, 90);
  });
  it("重建输入共用两个完整解码槽，繁忙不会留下派发意图", async () => {
    const f = setup(); f.register(); f.source(); const batch = await f.confirm("edit", { operation: "edit", inputAssetIds: ["source"] }); const lease = claim(f, batch).leases[0];
    let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; }); const occupied = [withStaticImageDecodeSlot(() => barrier), withStaticImageDecodeSlot(() => barrier)];
    try { await rejectCode(start(f, batch, lease), "verified_asset_busy"); noIntent(f); held(f); }
    finally { release(); await Promise.all(occupied); }
    expect((await start(f, batch, lease)).started).toBe(true);
  });
  it("字节、长度、Content-Type、请求摘要及转换谱系任一错配都拒绝", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(); const lease = claim(f, batch).leases[0], execution = f.store.load()!.batches[0].imageExecution!;
    const wire = await prepareOpenAiImageRequest(execution.preparation.connection, execution.request, [], at);
    const mutations = [{ body: Buffer.from(wire.body.map((value, index) => index === 0 ? value ^ 1 : value)) }, { body: Buffer.concat([wire.body, Buffer.from(" ")]) },
      { contentType: "application/problem+json" }, { requestFingerprint: "f".repeat(64) }, { payloadChecksumSha256: "f".repeat(64) },
      { transformedInputs: [{ assetId: "forged", originalChecksumSha256: "f".repeat(64) }] }];
    for (const change of mutations) expect(() => f.kernel.startImageJob(principal, batch.jobs[0].id, leaseInput(lease), { ...wire, ...change } as typeof wire)).toThrow(expect.objectContaining({ code: "image_dispatch_payload_mismatch" }));
    noIntent(f); held(f); expect((await start(f, batch, lease)).started).toBe(true);
  });
  it("保存写入后故障原子回滚到 leased，恢复后可写入一次意图", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(); const lease = claim(f, batch).leases[0]; const before = f.store.load(), save = f.store.save.bind(f.store);
    const fault = vi.spyOn(f.store, "save").mockImplementationOnce((snapshot) => { save(snapshot); throw new Error("injected-after-write"); });
    await rejectCode(start(f, batch, lease), "run_state_unavailable"); expect(f.store.load()).toEqual(before); fault.mockRestore();
    expect((await start(f, batch, lease)).started).toBe(true); held(f);
  });
  it("目录/准备/快照/意图共用元数据额度，超限保留历史和租约预算", async () => {
    const a = setup(); a.register(); const batch = await a.confirm(); const lease = claim(a, batch).leases[0];
    const quota = a.store.imageMetadataBytes(principal.tenantId, "project-a") + Buffer.byteLength(JSON.stringify(a.store.load()!.batches[0].imageExecution)) + 1;
    const b = setup({ path: a.path, quota }); await rejectCode(start(b, batch, lease), "image_metadata_quota"); noIntent(b); held(b);
    expect(b.kernel.getBatch(principal, batch.batch.id).jobs[0].status).toBe("leased"); expect((await start(a, batch, lease)).started).toBe(true);
  });
  it("手工核账使用上限预留而非估价，未扣费/已扣费只结算一次且不重试", async () => {
    for (const charged of [false, true]) {
      const f = setup({ kernel: { jobTimeoutMs: 1000 } }); f.register(); const batch = await f.confirm(); const lease = claim(f, batch).leases[0]; await start(f, batch, lease); f.advance(1000); f.kernel.reconcileImageBatch(principal, batch.batch.id);
      const base = { resolutionId: "human-evidence", expectedReservedMinor: 30, expectedCurrency: "CNY" as const, evidenceRef: "fixture-no-real-billing" };
      const request = charged ? { ...base, resolution: "charged" as const, actualCostMinor: 27 } : { ...base, resolution: "not-charged" as const };
      expect(() => f.kernel.resolveBillingUnknown(principal, batch.jobs[0].id, { ...request, expectedReservedMinor: 25 })).toThrow(expect.objectContaining({ code: "billing_resolution_snapshot_mismatch" }));
      const result = f.kernel.resolveBillingUnknown(principal, batch.jobs[0].id, request);
      expect(result.jobs[0]).toMatchObject({ status: "failed", actualCostMinor: charged ? 27 : 0, outputAssetIds: [] }); expect(f.kernel.resolveBillingUnknown(principal, batch.jobs[0].id, request)).toEqual(result);
      expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: charged ? 27 : 0 });
      expect((await start(f, batch, lease)).started).toBe(false); expect(result.jobs).toHaveLength(1);
    }
  });
  it("超额仍需第二人审批，不允许原提交人提升上限后自动执行", async () => {
    const f = setup({ kernel: { jobTimeoutMs: 1000 } }); f.register(); const batch = await f.confirm(); const lease = claim(f, batch).leases[0]; await start(f, batch, lease); f.advance(1000); f.kernel.reconcileImageBatch(principal, batch.batch.id);
    const pending = f.kernel.requestBillingOverage(principal, batch.jobs[0].id, { requestId: "overage", expectedReservedMinor: 30, expectedCurrency: "CNY", expectedBatchMaxCostMinor: 30,
      actualCostMinor: 35, requestedBatchMaxCostMinor: 35, evidenceRef: "fixture-only", reason: "manual fixture reconciliation" }); held(f);
    const overage = pending.billingOverages[0]; const review = { reviewId: "review", decision: "approve" as const, expectedReservedMinor: 30, expectedCurrency: "CNY" as const,
      expectedActualCostMinor: 35, expectedBatchMaxCostMinor: 30, expectedRequestedBatchMaxCostMinor: 35, evidenceRef: "second-person-fixture", note: "approved fixture only" };
    expect(() => f.kernel.reviewBillingOverage(principal, batch.jobs[0].id, overage.id, review)).toThrow(); held(f);
    const approved = f.kernel.reviewBillingOverage({ ...principal, actorId: "reviewer" }, batch.jobs[0].id, overage.id, review);
    expect(approved.batch.maxCostMinor).toBe(35); expect(approved.jobs[0].status).toBe("failed"); expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 35 });
    expect((await start(f, batch, lease)).started).toBe(false);
  });
  it("与旧 mock 共用项目槽位，但原商品精修假结算与指纹不变", async () => {
    const f = setup({ kernel: { maxConcurrentJobs: 1 } }); f.register(); const batch = await f.confirm();
    const mock = f.kernel.createBatch(principal, { projectId: "project-a", constraintSnapshotId: "constraint-a", tool: "product-retouch", inputAssetIds: ["legacy"], idempotencyKey: "legacy-action", expectedOutputs: 1, maxCostMinor: 25, currency: "CNY", mockScenario: "slow" });
    f.kernel.confirmBatch(principal, mock.batch.id, { expectedEstimatedCostMinor: 25, expectedCurrency: "CNY" }); const mockLease = f.kernel.claimBatch(principal, mock.batch.id, { workerId: "old-worker", maxJobs: 1 }).leases[0];
    expect(claim(f, batch)).toMatchObject({ leases: [], throttledBy: "project-concurrency" }); noIntent(f);
    f.kernel.cancelBatch(principal, mock.batch.id); expect(claim(f, batch).leases).toHaveLength(1); held(f);
    expect(() => f.kernel.executeLeasedJob(principal, batch.jobs[0].id, mockLease)).toThrow(expect.objectContaining({ code: "image_execution_not_configured" }));
  });
  it("供应商并发及持久化时间窗同样约束图片任务", async () => {
    const config = { maxConcurrentJobs: 4, providerLimits: [{ adapterId: "fixture-image-v1", maxConcurrentJobs: 1, maxStartsPerWindow: 1, windowMs: 2000 }] };
    const f = setup({ kernel: config }); f.register(); const a = await f.confirm("a"), b = await f.confirm("b"); claim(f, a);
    expect(claim(f, b)).toMatchObject({ leases: [], throttledBy: "provider-concurrency" }); f.kernel.cancelBatch(principal, a.batch.id);
    expect(claim(f, b)).toMatchObject({ leases: [], throttledBy: "provider-rate", retryAfterMs: 2000 }); f.advance(2000); expect(claim(f, b).leases).toHaveLength(1); held(f);
  });
  it("兼容 multipart 和 Google 原生负载都重建并逐项匹配，不静默换协议", async () => {
    for (const kind of ["compatible", "google"] as const) {
      const f = setup({ format: kind === "google" ? "jpeg" : "png" }); const base = connection();
      const config = kind === "compatible" ? connection({ protocol: "openai-compatible", compatibility: { version: "compatible-profile-v1", endpoints: { generate: "/images/generations", edit: "/images/edits" }, auth: { scheme: "header", headerName: "x-api-key" },
        editEncoding: "multipart-image-single", responseEncoding: "images-b64-json-v1", extraParameters: [] } }) : connection({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com",
          googleNative: { version: "google-profile-v1", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: "explicit-fixture-model", sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] },
          models: [{ ...base.models[0], maxInputImages: 3, outputFormats: ["jpeg"] }] });
      f.register(config); f.source(); const batch = await f.confirm("edit", { operation: "edit", inputAssetIds: ["source"] }); const lease = claim(f, batch).leases[0];
      const result = await start(f, batch, lease), execution = f.store.load()!.batches[0].imageExecution!;
      expect(result.started).toBe(true); expect(result.intent.contentType).toBe(execution.contentType); expect(result.intent.payloadChecksumSha256).toBe(execution.payloadChecksumSha256);
      expect(result.intent.inputTransformsFingerprint).toBe(imageSnapshotFingerprint(execution.transformedInputs)); held(f);
    }
  });
  it("公开 HTTP 旧执行入口仍拒绝图片，新内部租约方法没有 HTTP 路由", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(), jobId = batch.jobs[0].id;
    const server = createApiServer({ runKernel: f.kernel }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("test-server-missing");
      const base = `http://127.0.0.1:${address.port}`, headers = { authorization: "Bearer writer", "content-type": "application/json" };
      for (const [path, body] of [[`/v1/run-batches/${batch.batch.id}/claims`, { workerId: "fixture-worker", maxJobs: 1 }],
        [`/v1/run-jobs/${jobId}/execute`, { workerId: "fixture-worker", leaseId: "self-reported" }], [`/v1/run-batches/${batch.batch.id}/reconcile`, {}]] as const) {
        const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }); expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: "image_execution_not_configured" });
      }
      const unsupported = await fetch(`${base}/v1/run-jobs/${jobId}/image-start`, { method: "POST", headers, body: "{}" }); expect(unsupported.status).toBe(404);
      noIntent(f); held(f);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it("没有政策不能伪造同步授权，服务也拒绝分裂事务存储", async () => {
    const a = setup({ kernel: { validateImageTask: (() => ({ allowed: true })) as unknown as NonNullable<RunKernelOptions["validateImageTask"]> } }); a.register(); const batch = await a.confirm();
    expect(() => claim(a, batch)).toThrow(expect.objectContaining({ code: "image_lease_policy_invalid" })); noIntent(a); held(a);
    const b = setup(); expect(() => new LocalImageTaskLeases({ stateStore: b.store, runKernel: a.kernel })).toThrow(/同一事务/);
  });
  it("意图合同拒绝传输/密钥字段，损坏或重哈希的租约/演员/审计/时间证据恢复失败", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(); const lease = claim(f, batch).leases[0]; const result = await start(f, batch, lease);
    expect(ImageDispatchIntentSchema.safeParse({ ...result.intent, transport: "network" }).success).toBe(false);
    expect(ImageDispatchIntentSchema.safeParse({ ...result.intent, apiKey: "not-a-key" }).success).toBe(false);
    const saved = f.store.load()!;
    for (const kind of ["missing", "hash", "actor", "lease", "audit", "audit-worker", "audit-payload", "time", "success"] as const) {
      const snapshot = structuredClone(saved), stored = snapshot.batches[0];
      if (kind === "missing") { delete stored.imageDispatchIntent; delete stored.imageDispatchIntentFingerprint; }
      if (kind === "hash") stored.imageDispatchIntentFingerprint = "f".repeat(64);
      if (kind === "actor") stored.imageDispatchIntent!.actorId = "other";
      if (kind === "lease") stored.imageDispatchIntent!.leaseId = "forged-lease";
      if (kind === "audit") stored.aggregate.audit = stored.aggregate.audit.filter((event) => event.eventType !== "job-started");
      if (kind === "audit-worker") stored.aggregate.audit.find((event) => event.eventType === "job-leased")!.metadata.workerId = "forged-worker";
      if (kind === "audit-payload") stored.aggregate.audit.find((event) => event.eventType === "job-started")!.metadata.payloadChecksumSha256 = "f".repeat(64);
      if (kind === "time") stored.imageDispatchIntent!.recordedAt = "2026-10-03T18:01:00.000Z";
      if (kind === "success") { stored.aggregate.jobs[0].status = "succeeded"; stored.aggregate.batch.status = "succeeded"; }
      if (stored.imageDispatchIntent && kind !== "hash") stored.imageDispatchIntentFingerprint = imageSnapshotFingerprint(stored.imageDispatchIntent);
      expect(() => new InMemoryRunKernel({ authorizer: { authenticate: () => principal, allows: () => true }, budgets: snapshot.budgets,
        recoverRunningJobsOnRestore: false, stateStore: { load: () => snapshot, save: () => undefined } })).toThrow();
    }
  });
});
