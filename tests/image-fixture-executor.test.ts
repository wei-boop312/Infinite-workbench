import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageFixtureAttemptSchema, ImageFixtureResultSchema, type RunBatchAggregate } from "../packages/contracts/src/index";
import { LocalFixtureImageExecutor, type LocalFixtureTransport } from "../apps/api/src/imageFixtureExecutor";
import { createApiServer } from "../apps/api/src/index";
import { imageTaskMetadataBytes } from "../apps/api/src/imageTaskMetadata";
import { imageSnapshotFingerprint } from "../apps/api/src/imageProviderContract";
import { MAX_IMAGE_PROTOCOL_RESPONSE_BYTES } from "../apps/api/src/imageProtocolResponse";
import { InMemoryRunKernel } from "../apps/api/src/runKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { connection, png, principal, setupImageTask, sha } from "./helpers/image-task-fixture";

const fixtures: ReturnType<typeof setupImageTask>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0).reverse()) f.cleanup(); });
const setup = (options: Parameters<typeof setupImageTask>[0] = {}) => { const f = setupImageTask(options); fixtures.push(f); return f; };
const response = (data: unknown = { created: 1, data: [{ b64_json: png.toString("base64") }] }) => ({ status: 200, contentType: "application/json", requestId: "fixture-request", body: Buffer.from(JSON.stringify(data)) });
const transport = (send = vi.fn(async () => response())): LocalFixtureTransport => ({ mode: "local-fixture", realExecutionEnabled: false, send });
const executor = (f: ReturnType<typeof setup>, wire = transport(), extra: Partial<ConstructorParameters<typeof LocalFixtureImageExecutor>[0]> = {}) => new LocalFixtureImageExecutor({ stateStore: f.store, runKernel: f.kernel, transport: wire, clock: f.clock, ...extra });
const claim = (f: ReturnType<typeof setup>, batch: RunBatchAggregate) => { const lease = f.kernel.claimImageBatch(principal, batch.batch.id, { workerId: "fixture-worker", maxJobs: 1 }).leases[0]; return { workerId: lease.workerId, leaseId: lease.leaseId }; };
const rejected = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });
const held = (f: ReturnType<typeof setup>, amount = 30) => expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: amount, spentMinor: 0 });

describe("持久化本地图片传输尝试与原始响应（不授权资产）", () => {
  it("必须显式零费用假传输，默认/真实模式/分裂数据库拒绝", () => {
    const a = setup(), b = setup();
    expect(() => executor(a, undefined, { transport: undefined } as never)).toThrow(/零费用/);
    expect(() => executor(a, { mode: "real", realExecutionEnabled: true } as never)).toThrow(/零费用/);
    expect(() => executor(a, transport(), { stateStore: b.store })).toThrow(/同一事务/);
    for (const extra of [{ timeoutMs: 0 }, { timeoutMs: 30001 }, { maxProjectBytes: 513 * 1024 * 1024 }, { maxMetadataBytes: -1 }]) expect(() => executor(a, transport(), extra)).toThrow(/配置无效/);
  });
  it("假传输前持久化尝试，响应 BLOB/证据/未知账本同事务且不生成资产", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network-forbidden"));
    const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch); const raw = response();
    const send = vi.fn(async (request: Parameters<LocalFixtureTransport["send"]>[0]) => {
      const stored = f.store.load()!.batches[0]; expect(stored.imageFixtureAttempt).toMatchObject({ status: "attempted", transport: "local-fixture" });
      expect(stored.imageFixtureResult).toBeUndefined(); expect(sha(request.body)).toBe(stored.imageExecution!.payloadChecksumSha256);
      expect(Object.keys(request).sort()).toEqual(["body", "contentType", "method", "path"]); expect(request.path).toBe("/images/generations"); return raw;
    });
    const result = await executor(f, transport(send as never)).execute(principal, batch.jobs[0].id, lease);
    const stored = f.store.load()!.batches[0], journal = f.store.loadImageFixtureResponse(principal.tenantId, "project-a", batch.jobs[0].id)!;
    expect(result.started).toBe(true); expect(stored.imageDispatchIntent!.transport).toBe("not-connected");
    expect(stored.imageFixtureResult).toMatchObject({ kind: "returned", bodyChecksumSha256: sha(raw.body), outcome: { artifactStatus: "pending-validation", billing: { state: "unknown" } } });
    expect(journal.record).toEqual(stored.imageFixtureResult); expect(journal.body).toEqual(raw.body); expect(journal.body).not.toBe(raw.body);
    expect(stored.imageFixtureAttemptFingerprint).toBe(imageSnapshotFingerprint(stored.imageFixtureAttempt)); expect(stored.imageFixtureResultFingerprint).toBe(imageSnapshotFingerprint(journal.record));
    expect(result.aggregate.jobs[0]).toMatchObject({ status: "billing_unknown", providerRequestId: "fixture-request", outputAssetIds: [] });
    expect(f.store.loadCatalog()!.projects[0].assets).toEqual([]); expect(f.store.loadGeneratedImage(principal.tenantId, "project-a", batch.jobs[0].id)).toBeNull(); held(f);
    expect(send).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(connection().baseUrl); expect(JSON.stringify(result)).not.toContain(connection().credentialRef); expect(JSON.stringify(result)).not.toContain("b64_json");
  });
  it("并发/重启/报价过期/目录停用后只恢复历史，绝不重发", async () => {
    const a = setup(); a.register(); const batch = await a.confirm(), lease = claim(a, batch); const b = setup({ path: a.path });
    let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; }); const send = vi.fn(async () => { await barrier; return response(); });
    const left = executor(a, transport(send)).execute(principal, batch.jobs[0].id, lease);
    const right = await executor(b, transport(send)).execute(principal, batch.jobs[0].id, lease); expect(right.started).toBe(false); release(); await left;
    b.advance(61000); b.register(connection({ revision: 2, enabled: false }));
    expect((await executor(b, transport(send)).execute(principal, batch.jobs[0].id, lease)).started).toBe(false); expect(send).toHaveBeenCalledTimes(1); held(b);
    const stored = b.store.load()!.batches[0]; expect(stored.aggregate.audit.filter((event) => event.eventType === "image-fixture-attempted")).toHaveLength(1);
    expect(stored.aggregate.ledger.filter((entry) => entry.settlement === "unknown")).toHaveLength(1);
  });
  it("兼容 multipart 与 Google 原生编辑使用冻结字节/路径，只留未验证候选", async () => {
    const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp"), jpeg: Buffer = await sharp(png).jpeg().toBuffer();
    for (const kind of ["compatible", "google"] as const) {
      const f = setup({ format: kind === "google" ? "jpeg" : "png" }), base = connection();
      f.register(kind === "compatible" ? connection({ protocol: "openai-compatible", compatibility: { version: "compatible-profile-v1", endpoints: { generate: "/images/generations", edit: "/images/edits" },
        auth: { scheme: "header", headerName: "x-api-key" }, editEncoding: "multipart-image-single", responseEncoding: "images-b64-json-v1", extraParameters: [] } })
        : connection({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com", googleNative: { version: "google-profile-v1", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1",
          modelMappings: [{ model: "explicit-fixture-model", sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] }, models: [{ ...base.models[0], maxInputImages: 3, outputFormats: ["jpeg"] }] }));
      f.source(); const batch = await f.confirm("edit", { operation: "edit", inputAssetIds: ["source"] }), lease = claim(f, batch);
      const raw = kind === "compatible" ? response() : response({ responseId: "google-response-fixture", candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } }] } }] });
      const send = vi.fn(async (wire: Parameters<LocalFixtureTransport["send"]>[0]) => {
        const execution = f.store.load()!.batches[0].imageExecution!;
        expect(Object.keys(wire).sort()).toEqual(["body", "contentType", "method", "path"]); expect(sha(wire.body)).toBe(execution.payloadChecksumSha256);
        expect(wire.path).toBe(kind === "compatible" ? "/v1/images/edits" : "/v1/models/explicit-fixture-model:generateContent");
        expect(wire.contentType).toBe(execution.contentType); expect(execution.transformedInputs).toHaveLength(1); return raw;
      });
      const result = await executor(f, transport(send as never)).execute(principal, batch.jobs[0].id, lease);
      expect(result.aggregate.jobs[0]).toMatchObject({ status: "billing_unknown", outputAssetIds: [] });
      expect(f.store.load()!.batches[0].imageFixtureResult).toMatchObject({ kind: "returned", outcome: { providerStatus: "returned", artifactStatus: "pending-validation", billing: { state: "unknown" } } });
      expect(f.store.loadImageFixtureResponse(principal.tenantId, "project-a", batch.jobs[0].id)!.body).toEqual(raw.body); expect(send).toHaveBeenCalledTimes(1); held(f);
    }
  });
  it("仅有旧派发意图没有活的首次启动续接时不会补发", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch); await f.leases.prepareStart(principal, batch.jobs[0].id, lease);
    const send = vi.fn(async () => response()); expect((await executor(f, transport(send)).execute(principal, batch.jobs[0].id, lease)).started).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(f.store.load()!.batches[0].imageFixtureAttempt).toBeUndefined(); held(f);
  });
  it("尝试写入后故障回滚，不调用传输、不沿用意图再次尝试", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch), send = vi.fn(async () => response());
    const original = f.store.save.bind(f.store); const fault = vi.spyOn(f.store, "save").mockImplementation((snapshot) => {
      original(snapshot); if (snapshot.batches[0].imageFixtureAttempt) throw new Error("attempt-save-fault");
    });
    await rejected(executor(f, transport(send)).execute(principal, batch.jobs[0].id, lease), "run_state_unavailable"); fault.mockRestore();
    expect(f.store.load()!.batches[0]).toMatchObject({ imageDispatchIntent: { transport: "not-connected" } }); expect(f.store.load()!.batches[0].imageFixtureAttempt).toBeUndefined();
    expect((await executor(f, transport(send)).execute(principal, batch.jobs[0].id, lease)).started).toBe(false); expect(send).not.toHaveBeenCalled(); held(f);
  });
  it("持久化尝试后模拟崩溃保留证据，重启不能盲目重发", async () => {
    const a = setup({ kernel: { leaseDurationMs: 1000 } }); a.register(); const batch = await a.confirm(), lease = claim(a, batch);
    await rejected(a.leases.withFirstStart(principal, batch.jobs[0].id, lease, async ({ prepared }) => { a.kernel.beginImageFixtureAttempt(principal, batch.jobs[0].id, lease, prepared); throw new Error("crash-after-attempt-before-send"); }), "run_state_unavailable");
    const b = setup({ path: a.path, kernel: { leaseDurationMs: 1000 } }); b.advance(1001); const send = vi.fn(async () => response());
    expect((await executor(b, transport(send)).execute(principal, batch.jobs[0].id, lease)).aggregate.jobs[0].status).toBe("billing_unknown");
    expect(send).not.toHaveBeenCalled(); expect(b.store.load()!.batches[0].imageFixtureAttempt).toBeDefined(); expect(b.store.load()!.batches[0].imageFixtureResult).toBeUndefined(); held(b);
  });
  it("超时中止等待，迟到响应不改已保存未知结果也不重发", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch); let release!: () => void; let signal!: AbortSignal;
    const barrier = new Promise<void>((resolve) => { release = resolve; }); const send = vi.fn(async (_request, abort) => { signal = abort; await barrier; return response(); });
    await executor(f, transport(send as never), { timeoutMs: 5 }).execute(principal, batch.jobs[0].id, lease);
    expect(signal.aborted).toBe(true); const before = f.store.load(); expect(before!.batches[0].imageFixtureResult).toMatchObject({ kind: "interrupted", failureCode: "fixture-timeout", outcome: { billing: { state: "unknown" } } });
    release(); await barrier; await Promise.resolve(); expect(f.store.load()).toEqual(before);
    expect(f.store.loadImageFixtureResponse(principal.tenantId, "project-a", batch.jobs[0].id)).toBeNull(); held(f);
  });
  it("同步/异步传输错误只记固定代码，不把异常或私密字符串写入状态", async () => {
    for (const sync of [false, true]) {
      const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch); const send = vi.fn(() => { if (sync) throw new Error("secret-test-string"); return Promise.reject(new Error("secret-test-string")); });
      await executor(f, transport(send)).execute(principal, batch.jobs[0].id, lease); const saved = f.store.load()!;
      expect(saved.batches[0].imageFixtureResult).toMatchObject({ kind: "interrupted", failureCode: "fixture-transport-error" }); expect(JSON.stringify(saved)).not.toContain("secret-test-string"); held(f);
    }
  });
  it("HTTP 错误/坏 JSON/伪图片/缺用量都不视为免费或有效资产", async () => {
    const cases = [{ ...response(), status: 429 }, { ...response(), body: Buffer.from("invalid-json") }, response({ created: 1, data: [{ b64_json: Buffer.from("not-image").toString("base64") }] }), response()];
    for (const raw of cases) {
      const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch); await executor(f, transport(vi.fn(async () => raw))).execute(principal, batch.jobs[0].id, lease);
      const stored = f.store.load()!.batches[0]; expect(stored.imageFixtureResult!.kind).toBe("returned"); expect(stored.imageFixtureResult!.outcome.billing.state).toBe("unknown");
      expect(stored.aggregate.jobs[0].outputAssetIds).toEqual([]); expect(f.store.loadCatalog()!.projects[0].assets).toEqual([]); held(f);
    }
  });
  it("响应包超限/非法状态/头字段不保存原始包，只留未知计费证据", async () => {
    for (const raw of [{ ...response(), body: Buffer.alloc(MAX_IMAGE_PROTOCOL_RESPONSE_BYTES + 1) }, { ...response(), status: 999 }, { ...response(), contentType: "application/json\r\nsecret" }]) {
      const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch); await executor(f, transport(vi.fn(async () => raw))).execute(principal, batch.jobs[0].id, lease);
      expect(f.store.load()!.batches[0].imageFixtureResult).toMatchObject({ kind: "interrupted", failureCode: "fixture-response-invalid" });
      expect(f.store.imageFixtureResponseBytes(principal.tenantId, "project-a")).toBe(0); held(f);
    }
  });
  it("响应晚于报价/租约过期仍保存原始证据，不重新确认或调用", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch); const send = vi.fn(async () => { f.advance(61000); return response(); });
    const result = await executor(f, transport(send)).execute(principal, batch.jobs[0].id, lease); expect(result.aggregate.jobs[0].status).toBe("billing_unknown");
    expect(f.store.load()!.batches[0].imageFixtureResult!.receivedAt).toBe("2026-10-03T18:01:01.000Z"); expect(send).toHaveBeenCalledTimes(1); held(f);
  });
  it("异步协议准备中撤销权限或目录漂移不写尝试、不传输", async () => {
    for (const kind of ["permission", "directory"] as const) {
      const f = setup(); f.register(); f.source(); const batch = await f.confirm("edit", { operation: "edit", inputAssetIds: ["source"] }), lease = claim(f, batch), send = vi.fn(async () => response());
      const pending = executor(f, transport(send)).execute(principal, batch.jobs[0].id, lease); kind === "permission" ? f.revokeAsset() : f.register(connection({ revision: 2 }));
      await rejected(pending, kind === "permission" ? "image_task_permission_denied" : "image_connection_changed"); expect(send).not.toHaveBeenCalled(); expect(f.store.load()!.batches[0].imageFixtureAttempt).toBeUndefined(); held(f);
    }
  });
  it("尝试前最终同步政策跨过租约或报价边界时不调用假传输", async () => {
    for (const kind of ["lease", "quote"] as const) {
      const f = setup({ kernel: { leaseDurationMs: kind === "lease" ? 1000 : 120000, validateImageTask: (_actor, _execution, _intent, bytes) => { if (bytes) f.advance(kind === "lease" ? 1001 : 61000); } } });
      f.register(); const batch = await f.confirm(), lease = claim(f, batch), send = vi.fn(async () => response());
      await rejected(executor(f, transport(send)).execute(principal, batch.jobs[0].id, lease), kind === "lease" ? "run_job_not_leased" : "image_quote_expired");
      expect(f.store.load()!.batches[0].imageFixtureAttempt).toBeUndefined(); expect(send).not.toHaveBeenCalled(); held(f);
    }
  });
  it("已尝试后撤销执行权限不保存伪响应、不释放或补发，另一次授权恢复只核对未知", async () => {
    const a = setup(); a.register(); const batch = await a.confirm(), lease = claim(a, batch), send = vi.fn(async () => { a.denyRun("run:execute"); return response(); });
    await rejected(executor(a, transport(send)).execute(principal, batch.jobs[0].id, lease), "run_permission_denied");
    expect(a.store.load()!.batches[0].imageFixtureAttempt).toBeDefined(); expect(a.store.load()!.batches[0].imageFixtureResult).toBeUndefined(); held(a);
    const b = setup({ path: a.path }); b.advance(31000); expect(b.kernel.reconcileImageBatch(principal, batch.batch.id).jobs[0].status).toBe("billing_unknown");
    expect((await executor(b, transport(send)).execute(principal, batch.jobs[0].id, lease)).started).toBe(false); expect(send).toHaveBeenCalledTimes(1); held(b);
  });
  it("返回响应写入后/任务保存中故障原子回滚，原尝试和未知费用保留", async () => {
    for (const kind of ["blob", "kernel"] as const) {
      const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch), send = vi.fn(async () => response());
      if (kind === "blob") { const original = f.store.saveImageFixtureResponse.bind(f.store); vi.spyOn(f.store, "saveImageFixtureResponse").mockImplementationOnce((record, body) => { original(record, body); throw new Error("response-after-write"); }); }
      else { const original = f.store.save.bind(f.store); vi.spyOn(f.store, "save").mockImplementation((snapshot) => { original(snapshot); if (snapshot.batches[0].imageFixtureResult?.kind === "returned") throw new Error("kernel-after-write"); }); }
      await rejected(executor(f, transport(send)).execute(principal, batch.jobs[0].id, lease), "run_state_unavailable");
      const stored = f.store.load()!.batches[0]; expect(stored.imageFixtureResult).toMatchObject({ kind: "interrupted", failureCode: "fixture-response-save-failed" });
      expect(f.store.loadImageFixtureResponse(principal.tenantId, "project-a", batch.jobs[0].id)).toBeNull(); expect(stored.aggregate.ledger.filter((entry) => entry.settlement === "unknown")).toHaveLength(1);
      expect((await executor(f, transport(send)).execute(principal, batch.jobs[0].id, lease)).started).toBe(false); expect(send).toHaveBeenCalledTimes(1); held(f);
    }
  });
  it("原始响应与原图共用二进制额度，超限不删除历史、不释放预算", async () => {
    const f = setup(); f.register(); f.source(); const batch = await f.confirm(), lease = claim(f, batch); const before = f.store.loadCatalog();
    await rejected(executor(f, transport(), { maxProjectBytes: png.length + 1 }).execute(principal, batch.jobs[0].id, lease), "image_fixture_binary_quota");
    expect(f.store.loadCatalog()).toEqual(before); expect(f.store.localImageBinaryBytes(principal.tenantId, "project-a")).toBe(png.length);
    expect(f.store.load()!.batches[0].imageFixtureResult).toMatchObject({ kind: "interrupted", failureCode: "fixture-response-save-failed" }); held(f);
  });
  it("响应元数据额度拒绝后不留下半响应，原意图/尝试可审计", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch);
    const quota = f.store.imageMetadataBytes(principal.tenantId, "project-a") + imageTaskMetadataBytes(f.store.load(), principal.tenantId, "project-a") + 1;
    await rejected(executor(f, transport(), { maxMetadataBytes: quota }).execute(principal, batch.jobs[0].id, lease), "image_metadata_quota");
    expect(f.store.loadImageFixtureResponse(principal.tenantId, "project-a", batch.jobs[0].id)).toBeNull(); expect(f.store.load()!.batches[0].imageFixtureAttempt).toBeDefined(); held(f);
  });
  it("两个执行中的假传输占用有界槽，第三个稍后执行不重复", async () => {
    const f = setup({ kernel: { maxConcurrentJobs: 4 } }); f.register(); const batches = [await f.confirm("a"), await f.confirm("b"), await f.confirm("c")], leases = batches.map((batch) => claim(f, batch));
    let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; }); const send = vi.fn(async () => { await barrier; return response(); }), worker = executor(f, transport(send));
    const pending = batches.slice(0, 2).map((batch, i) => worker.execute(principal, batch.jobs[0].id, leases[i]));
    await rejected(worker.execute(principal, batches[2].jobs[0].id, leases[2]), "image_dispatch_capacity"); release(); await Promise.all(pending);
    await worker.execute(principal, batches[2].jobs[0].id, leases[2]); expect(send).toHaveBeenCalledTimes(3); held(f, 90);
  });
  it("核账仍人工且不改变原始未知响应，核账后历史不重发", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch), send = vi.fn(async () => response()), worker = executor(f, transport(send));
    await worker.execute(principal, batch.jobs[0].id, lease); const before = f.store.loadImageFixtureResponse(principal.tenantId, "project-a", batch.jobs[0].id);
    f.kernel.resolveBillingUnknown(principal, batch.jobs[0].id, { resolutionId: "human-fixture", expectedReservedMinor: 30, expectedCurrency: "CNY", resolution: "not-charged", evidenceRef: "manual-zero-fee-fixture" });
    expect(f.store.loadImageFixtureResponse(principal.tenantId, "project-a", batch.jobs[0].id)).toEqual(before); expect((await worker.execute(principal, batch.jobs[0].id, lease)).started).toBe(false);
    expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: 0 }); expect(send).toHaveBeenCalledTimes(1);
  });
  it("响应正文或存在标记丢失/被篡改不是未执行，任务恢复失败关闭", async () => {
    for (const kind of ["body", "row", "both"] as const) {
      const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch); await executor(f).execute(principal, batch.jobs[0].id, lease);
      const db = new DatabaseSync(f.path);
      try {
        db.exec(kind === "body" ? "UPDATE image_fixture_responses SET body = x'00'" : "DELETE FROM image_fixture_responses"); if (kind === "both") db.exec("DELETE FROM image_fixture_response_presence");
        expect(() => f.kernel.getBatch(principal, batch.batch.id)).toThrow(expect.objectContaining({ code: "run_state_unavailable" }));
        expect(f.store.load()!.batches[0].imageFixtureAttempt).toBeDefined(); expect(f.store.load()!.budgets[0].reservedMinor).toBe(30);
      } finally { db.close(); }
    }
  });
  it("响应 BLOB 回读为独立字节，不能修改已持久化原始证据", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch); await executor(f).execute(principal, batch.jobs[0].id, lease);
    const first = f.store.loadImageFixtureResponse(principal.tenantId, "project-a", batch.jobs[0].id)!; first.body.fill(0);
    expect(f.store.loadImageFixtureResponse(principal.tenantId, "project-a", batch.jobs[0].id)!.body).toEqual(response().body); held(f);
  });
  it("SQLite 提交端口自身要求正文并原子保存，精确重放不覆盖，冲突回滚", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch);
    let result!: ReturnType<typeof ImageFixtureResultSchema.parse>;
    await f.leases.withFirstStart(principal, batch.jobs[0].id, lease, async ({ prepared, execution }) => {
      const attempt = f.kernel.beginImageFixtureAttempt(principal, batch.jobs[0].id, lease, prepared), raw = response();
      const { parseOpenAiImageResponse } = await import("../apps/api/src/openaiImageProtocol");
      result = ImageFixtureResultSchema.parse({ schemaVersion: 1, mode: "local-fixture", id: "fixture-result-internal", attemptId: attempt.id, kind: "returned", receivedAt: new Date(f.clock()).toISOString(),
        outcome: parseOpenAiImageResponse(execution.request, execution.requestFingerprint, raw).outcome, status: raw.status, contentType: raw.contentType, requestId: raw.requestId, bodyChecksumSha256: sha(raw.body), bodyByteSize: raw.body.length });
      expect(() => f.kernel.recordImageFixtureResult(principal, batch.jobs[0].id, result)).toThrow(expect.objectContaining({ code: "image_fixture_response_body_required" }));
      expect(f.store.load()!.batches[0].imageFixtureResult).toBeUndefined();
      f.kernel.recordImageFixtureResult(principal, batch.jobs[0].id, result, raw.body);
    });
    const before = f.store.load(); expect(f.kernel.recordImageFixtureResult(principal, batch.jobs[0].id, result, response().body).jobs[0].status).toBe("billing_unknown");
    expect(() => f.kernel.recordImageFixtureResult(principal, batch.jobs[0].id, result, Buffer.from("tampered"))).toThrow(expect.objectContaining({ code: "image_fixture_result_conflict" }));
    expect(f.store.load()).toEqual(before); expect(f.store.loadImageFixtureResponse(principal.tenantId, "project-a", batch.jobs[0].id)!.body).toEqual(response().body); held(f);
  });
  it("v4 增量升级保留原图/准备/确认/未知费用，并拒绝未来 v7", async () => {
    const a = setup(); a.register(); a.source(); const batch = await a.confirm(), lease = claim(a, batch); await a.leases.prepareStart(principal, batch.jobs[0].id, lease);
    a.advance(31000); expect(a.kernel.reconcileImageBatch(principal, batch.batch.id).jobs[0].status).toBe("billing_unknown"); const before = a.store.load(), catalog = a.store.loadCatalog();
    const db = new DatabaseSync(a.path); db.exec("DROP TABLE image_fixture_responses; DROP TABLE image_fixture_response_presence; PRAGMA user_version = 4"); db.close();
    const b = setup({ path: a.path }); expect(b.store.load()).toEqual(before); expect(b.store.loadCatalog()).toEqual(catalog); expect(b.store.loadVerifiedImage(principal.tenantId, "project-a", "source")).toBeDefined();
    const version = new DatabaseSync(a.path); expect(version.prepare("PRAGMA user_version").get()!.user_version).toBe(6); version.exec("PRAGMA user_version = 7"); version.close(); held(b);
    expect(() => new SqliteRunKernelStateStore(a.path)).toThrow(expect.objectContaining({ code: "run_state_unavailable" }));
  });
  it("严格证据拒绝密钥和真实模式，重新哈希的归属/尝试/响应损坏仍拒绝恢复", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch); await executor(f).execute(principal, batch.jobs[0].id, lease); const saved = f.store.load()!;
    expect(ImageFixtureAttemptSchema.safeParse({ ...saved.batches[0].imageFixtureAttempt, transport: "network" }).success).toBe(false);
    expect(ImageFixtureResultSchema.safeParse({ ...saved.batches[0].imageFixtureResult, apiKey: "not-a-key" }).success).toBe(false);
    for (const kind of ["attempt", "actor", "time", "outcome", "free", "audit"] as const) {
      const snapshot = structuredClone(saved), stored = snapshot.batches[0];
      if (kind === "attempt") stored.imageFixtureResult!.attemptId = "not-this-attempt";
      if (kind === "actor") stored.imageFixtureAttempt!.actorId = "other";
      if (kind === "time") stored.imageFixtureAttempt!.attemptedAt = "2026-10-03T18:01:00.000Z";
      if (kind === "outcome") stored.imageFixtureResult!.outcome.jobId = "other-job";
      if (kind === "free") stored.imageFixtureResult!.outcome.billing = { state: "not-charged", evidenceRef: "caller-claim" } as never;
      if (kind === "audit") stored.aggregate.audit = stored.aggregate.audit.filter((event) => event.eventType !== "image-fixture-returned");
      stored.imageFixtureAttemptFingerprint = imageSnapshotFingerprint(stored.imageFixtureAttempt); stored.imageFixtureResultFingerprint = imageSnapshotFingerprint(stored.imageFixtureResult);
      expect(() => new InMemoryRunKernel({ authorizer: { authenticate: () => principal, allows: () => true }, budgets: snapshot.budgets, recoverRunningJobsOnRestore: false, stateStore: { load: () => snapshot, save: () => undefined } })).toThrow();
    }
  });
  it("HTTP 不开放假传输或原始响应回读，旧执行仍拒绝图片", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch); await executor(f).execute(principal, batch.jobs[0].id, lease);
    const server = createApiServer({ runKernel: f.kernel }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("server-missing"); const base = `http://127.0.0.1:${address.port}`, headers = { authorization: "Bearer writer", "content-type": "application/json" };
      for (const path of ["fixture-execute", "fixture-response"]) expect((await fetch(`${base}/v1/run-jobs/${batch.jobs[0].id}/${path}`, { headers })).status).toBe(404);
      expect((await fetch(`${base}/v1/run-jobs/${batch.jobs[0].id}/execute`, { method: "POST", headers, body: JSON.stringify(lease) })).status).toBe(409);
      const publicResponse = await (await fetch(`${base}/v1/run-batches/${batch.batch.id}`, { headers })).text(); expect(publicResponse).not.toContain("b64_json"); expect(publicResponse).not.toContain("never-called.invalid"); held(f);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
