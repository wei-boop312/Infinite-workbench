import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ImageTaskArtifactSchema, ImageTaskArtifactFailureSchema, type RunBatchAggregate } from "../packages/contracts/src/index";
import { LocalImageTaskArtifacts } from "../apps/api/src/imageTaskArtifacts";
import { LocalFixtureImageExecutor } from "../apps/api/src/imageFixtureExecutor";
import { LocalGeneratedImages } from "../apps/api/src/generatedImages";
import { createImageArtifactValidator, parseStoredImageResponse } from "../apps/api/src/imageArtifactPolicy";
import { imageSnapshotFingerprint } from "../apps/api/src/imageProviderContract";
import { imageTaskMetadataBytes } from "../apps/api/src/imageTaskMetadata";
import { InMemoryRunKernel } from "../apps/api/src/runKernel";
import { createApiServer } from "../apps/api/src/index";
import { prepareOpenAiImageRequest } from "../apps/api/src/openaiImageProtocol";
import { connection, png, principal, setupImageTask, sha } from "./helpers/image-task-fixture";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
let full: Buffer, jpeg: Buffer, other: Buffer;
beforeAll(async () => { [full, jpeg, other] = await Promise.all([sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffa500" } }).png().toBuffer(),
  sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffa500" } }).jpeg().toBuffer(), sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#2288ff" } }).png().toBuffer()]); });
const fixtures: ReturnType<typeof setupImageTask>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0).reverse()) f.cleanup(); });
const setup = (options: Parameters<typeof setupImageTask>[0] = {}) => { const f = setupImageTask(options); fixtures.push(f); return f; };
const artifacts = (f: ReturnType<typeof setup>, extra: Partial<ConstructorParameters<typeof LocalImageTaskArtifacts>[0]> = {}) => new LocalImageTaskArtifacts({ tenantId: principal.tenantId,
  stateStore: f.store, runKernel: f.kernel, authorizer: f.assetAuthorizer, clock: f.clock, ...extra });
const reply = (body = full) => ({ status: 200, contentType: "application/json", requestId: "local-response", body: Buffer.from(JSON.stringify({ created: 1, data: [{ b64_json: body.toString("base64") }] })) });
const claim = (f: ReturnType<typeof setup>, batch: RunBatchAggregate) => { const lease = f.kernel.claimImageBatch(principal, batch.batch.id, { workerId: "fixture-worker", maxJobs: 1 }).leases[0]; return { workerId: lease.workerId, leaseId: lease.leaseId }; };
async function returned(f: ReturnType<typeof setup>, id = "human-artifact", raw = reply(), sink?: LocalImageTaskArtifacts, extra: Record<string, unknown> = {}) {
  const batch = await f.confirm(id, extra), lease = claim(f, batch), send = vi.fn(async () => raw);
  const executor = new LocalFixtureImageExecutor({ stateStore: f.store, runKernel: f.kernel, transport: { mode: "local-fixture", realExecutionEnabled: false, send }, clock: f.clock, artifacts: sink });
  await executor.execute(principal, batch.jobs[0].id, lease); return { batch, lease, send, executor };
}
const held = (f: ReturnType<typeof setup>, amount = 30) => expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: amount, spentMinor: 0 });
const empty = (f: ReturnType<typeof setup>, job: string) => {
  expect(f.store.loadGeneratedImage(principal.tenantId, "project-a", job)).toBeNull(); expect(f.store.loadCatalog()!.projects[0].assets.filter((item) => item.purpose === "generated")).toEqual([]);
  expect(f.store.load()!.batches.find((item) => item.aggregate.jobs[0].id === job)!.aggregate.jobs[0].outputAssetIds).toEqual([]);
};

describe("实际响应授权的产物与任务同库原子绑定", () => {
  it("默认关闭与分裂事务拒绝，queued/意图/仅 attempted 都不是入库授权", async () => {
    const f = setup({ kernel: { validateImageArtifact: undefined } }), another = setup(); f.register();
    const batch = await f.confirm(), lease = claim(f, batch); await f.leases.prepareStart(principal, batch.jobs[0].id, lease);
    expect(() => artifacts(f, { stateStore: another.store })).toThrow(/同一事务/);
    expect(() => new LocalFixtureImageExecutor({ stateStore: f.store, runKernel: f.kernel, transport: { mode: "local-fixture", realExecutionEnabled: false, send: vi.fn() }, artifacts: artifacts(another) })).toThrow(/同一事务/);
    await expect(artifacts(f).ingest(principal, batch.jobs[0].id)).rejects.toMatchObject({ code: "image_output_response_not_authorized" });
    const plain = setup(); plain.register(); const queued = await plain.confirm(); await expect(artifacts(plain).ingest(principal, queued.jobs[0].id)).rejects.toMatchObject({ code: "image_output_response_not_authorized" });
    const ready = setup({ kernel: { validateImageArtifact: undefined } }); ready.register(); const run = await returned(ready);
    await expect(artifacts(ready).ingest(principal, run.batch.jobs[0].id)).rejects.toMatchObject({ code: "image_output_policy_not_configured" }); held(ready);
    const attempted = setup(); attempted.register(); const a = await attempted.confirm(), l = claim(attempted, a);
    await attempted.leases.withFirstStart(principal, a.jobs[0].id, l, async ({ prepared }) => { attempted.kernel.beginImageFixtureAttempt(principal, a.jobs[0].id, l, prepared); });
    await expect(artifacts(attempted).ingest(principal, a.jobs[0].id)).rejects.toMatchObject({ code: "image_output_response_not_authorized" }); empty(attempted, a.jobs[0].id); held(attempted);
  });
  it("完整原始图/收据/谱系/目录/任务原子保存，产物有效不等于费用已结算", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no-network")); const f = setup(); f.register(); const run = await returned(f, "integrated", reply(), artifacts(f));
    const job = run.batch.jobs[0].id, stored = f.store.load()!.batches[0], record = f.store.loadGeneratedImage(principal.tenantId, "project-a", job)!;
    expect(record.image.asset).toMatchObject({ purpose: "generated", width: 1024, height: 1024, contentFingerprint: `sha256:${sha(full)}` });
    expect(f.store.loadVerifiedImageBytes(principal.tenantId, "project-a", record.image.asset.id)!.body).toEqual(full);
    expect(stored.imageTaskArtifact).toMatchObject({ assetId: record.image.asset.id, checksumSha256: sha(full), resultId: stored.imageFixtureResult!.id, attemptId: stored.imageFixtureAttempt!.id,
      generatedRecordFingerprint: imageSnapshotFingerprint(record), resultFingerprint: stored.imageFixtureResultFingerprint });
    expect(stored.imageTaskArtifactFingerprint).toBe(imageSnapshotFingerprint(stored.imageTaskArtifact));
    expect(f.kernel.getBatch(principal, run.batch.batch.id).jobs[0]).toMatchObject({ status: "billing_unknown", outputAssetIds: [record.image.asset.id] });
    expect(stored.aggregate.audit.filter((item) => item.eventType === "image-artifact-verified")).toHaveLength(1);
    expect(stored.aggregate.ledger.filter((item) => item.settlement === "unknown")).toHaveLength(1); expect(stored.aggregate.ledger.some((item) => item.settlement === "settled")).toBe(false);
    expect(stored.imageFixtureResult!.outcome.artifactStatus).toBe("pending-validation"); expect(run.send).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled(); held(f);
    expect(JSON.stringify(f.kernel.getBatch(principal, run.batch.batch.id))).not.toContain("b64_json");
  });
  it.each([true, Promise.resolve(undefined)])("产物授权政策返回 %s 而非同步 undefined 时失败关闭", async (result) => {
    const f = setup({ kernel: { validateImageArtifact: (() => result) as never } }); f.register(); const run = await returned(f);
    await expect(artifacts(f).ingest(principal, run.batch.jobs[0].id)).rejects.toMatchObject({ code: "image_output_policy_invalid" });
    empty(f, run.batch.jobs[0].id); held(f); expect(run.send).toHaveBeenCalledTimes(1);
  });
  it("原响应已保存但验证前进程结束，重启只处理已有响应、不补发", async () => {
    const a = setup(); a.register(); const run = await returned(a); empty(a, run.batch.jobs[0].id);
    const b = setup({ path: a.path }); b.advance(61000); b.register(connection({ revision: 2, enabled: false }));
    const record = await artifacts(b).ingest(principal, run.batch.jobs[0].id); expect(record.image.checksumSha256).toBe(sha(full));
    expect((await run.executor.execute(principal, run.batch.jobs[0].id, run.lease)).started).toBe(false); expect(run.send).toHaveBeenCalledTimes(1); held(b);
  });
  it("跨连接并发/重启重放只有一份资产，历史不重解码或改费用", async () => {
    const a = setup(); a.register(); a.source(); const run = await returned(a, "edit", reply(), undefined, { operation: "edit", inputAssetIds: ["source"] }); const b = setup({ path: a.path });
    const records = await Promise.all([artifacts(a).ingest(principal, run.batch.jobs[0].id), artifacts(b).ingest(principal, run.batch.jobs[0].id)]); expect(records[0]).toEqual(records[1]);
    const before = a.store.load(), read = vi.spyOn(b.store, "loadVerifiedImageBytes"); b.advance(61000); b.register(connection({ revision: 2, enabled: false }));
    expect(await artifacts(b).ingest(principal, run.batch.jobs[0].id)).toEqual(records[0]); expect(read).not.toHaveBeenCalled(); expect(a.store.load()).toEqual(before);
    expect(a.store.loadCatalog()!.projects[0].assets.filter((asset) => asset.purpose === "generated")).toHaveLength(1); held(b);
  });
  it("兼容编辑和 Google 原生 JPEG 都用实际响应与冻结转换谱系", async () => {
    for (const kind of ["compatible", "google"] as const) {
      const f = setup({ format: kind === "google" ? "jpeg" : "png" }), base = connection();
      f.register(kind === "compatible" ? connection({ protocol: "openai-compatible", compatibility: { version: "fixture-v1", endpoints: { generate: "/images/generations", edit: "/images/edits" }, auth: { scheme: "header", headerName: "x-api-key" },
        editEncoding: "multipart-image-single", responseEncoding: "images-b64-json-v1", extraParameters: [] } }) : connection({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com",
        googleNative: { version: "fixture-v1", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: "explicit-fixture-model", sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] }, models: [{ ...base.models[0], outputFormats: ["jpeg"], maxInputImages: 3 }] }));
      f.source(); const raw = kind === "compatible" ? reply() : { ...reply(), body: Buffer.from(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } }] } }] })) };
      const run = await returned(f, kind, raw, artifacts(f), { operation: "edit", inputAssetIds: ["source"] }), record = f.store.loadGeneratedImage(principal.tenantId, "project-a", run.batch.jobs[0].id)!;
      expect(record.protocol).toBe(kind === "compatible" ? "openai-compatible" : "google"); expect(record.image.asset.sourceAssetId).toBe("source"); expect(record.transformedInputs).toHaveLength(1);
      expect(record.image.checksumSha256).toBe(sha(kind === "compatible" ? full : jpeg)); held(f);
    }
  });
  it("实际尺寸不匹配拒绝，坏产物证据不改原响应、不释放预留也不重发", async () => {
    const f = setup(); f.register(); const run = await returned(f, "wrong-size", reply(png)), raw = f.store.loadImageFixtureResponse(principal.tenantId, "project-a", run.batch.jobs[0].id);
    for (let i = 0; i < 2; i++) await expect(artifacts(f).ingest(principal, run.batch.jobs[0].id)).rejects.toMatchObject({ code: "image_output_dimensions_mismatch" });
    const stored = f.store.load()!.batches[0]; expect(stored.imageTaskArtifactFailures).toHaveLength(1); expect(stored.imageTaskArtifactFailures![0]).toMatchObject({ stage: "validation", code: "image_output_dimensions_mismatch" });
    expect(stored.aggregate.jobs[0].status).toBe("billing_unknown"); expect(f.store.loadImageFixtureResponse(principal.tenantId, "project-a", run.batch.jobs[0].id)).toEqual(raw); empty(f, run.batch.jobs[0].id); held(f);
    expect(run.send).toHaveBeenCalledTimes(1);
  });
  it("截断候选/无候选坏 JSON 保存拒绝证据，不能冒充完整解码", async () => {
    for (const raw of [reply(full.subarray(0, 40)), { ...reply(), body: Buffer.from("bad-json") }]) {
      const f = setup(); f.register(); const run = await returned(f, "bad", raw);
      await expect(artifacts(f).ingest(principal, run.batch.jobs[0].id)).rejects.toMatchObject({ status: 422 }); empty(f, run.batch.jobs[0].id); held(f);
      expect(f.store.load()!.batches[0].imageTaskArtifactFailures).toHaveLength(1); expect(f.store.load()!.batches[0].imageFixtureResult!.kind).toBe("returned");
    }
  });
  it("超时中断没有原始 returned 包，不能使用自报的候选授权", async () => {
    const f = setup(); f.register(); const batch = await f.confirm(), lease = claim(f, batch);
    const worker = new LocalFixtureImageExecutor({ stateStore: f.store, runKernel: f.kernel, transport: { mode: "local-fixture", realExecutionEnabled: false, send: vi.fn(async () => { throw new Error("fixture"); }) }, artifacts: artifacts(f), clock: f.clock });
    await worker.execute(principal, batch.jobs[0].id, lease); await expect(artifacts(f).ingest(principal, batch.jobs[0].id)).rejects.toMatchObject({ code: "image_output_response_not_authorized" }); empty(f, batch.jobs[0].id); held(f);
  });
  it("资产保存期间撤销权限会在任务绑定前再次拒绝并回滚资产", async () => {
    const f = setup(); f.register(); const run = await returned(f), original = f.store.saveGeneratedImage.bind(f.store);
    vi.spyOn(f.store, "saveGeneratedImage").mockImplementationOnce((record, body) => { original(record, body); f.revokeAsset(); });
    await expect(artifacts(f).ingest(principal, run.batch.jobs[0].id)).rejects.toMatchObject({ code: "image_output_permission_denied" }); empty(f, run.batch.jobs[0].id); held(f);
    expect(f.store.load()!.batches[0].imageFixtureResult!.kind).toBe("returned"); expect(run.send).toHaveBeenCalledTimes(1);
  });
  it("服务权限/供应商权限/任务权限/原领取身份撤销不能绕过", async () => {
    for (const kind of ["asset", "provider", "run", "actor", "tenant"] as const) {
      const f = setup(); f.register(); const run = await returned(f);
      if (kind === "asset") f.revokeAsset(); if (kind === "provider") f.revokeProvider(); if (kind === "run") f.denyRun("run:execute");
      const actor = kind === "actor" ? { ...principal, actorId: "other" } : kind === "tenant" ? { ...principal, tenantId: "other" } : principal;
      await expect(artifacts(f).ingest(actor, run.batch.jobs[0].id)).rejects.toBeDefined(); empty(f, run.batch.jobs[0].id); held(f);
    }
  });
  it("异步准备中约束/原图漂移会阻止提交，不静默缩图或改谱系", async () => {
    for (const kind of ["constraint", "source"] as const) {
      const f = setup(); f.register(); f.source(); const run = await returned(f, kind, reply(), undefined, { operation: "edit", inputAssetIds: ["source"] });
      const pending = artifacts(f).ingest(principal, run.batch.jobs[0].id);
      f.store.transaction(() => { const catalog = f.store.loadCatalog()!; kind === "constraint" ? catalog.projects[0].constraints[0].brandRules.style = "changed" : catalog.projects[0].assets[0].contentFingerprint = `sha256:${"f".repeat(64)}`; f.store.saveCatalog(catalog); });
      await expect(pending).rejects.toBeDefined(); empty(f, run.batch.jobs[0].id); held(f);
    }
  });
  it("独立测试端口写入另一张有效图片，也不能绑定到实际响应的任务", async () => {
    const f = setup(); f.register(); const run = await returned(f); const initial = f.kernel.inspectImageArtifact(principal, run.batch.jobs[0].id), prepared = await prepareOpenAiImageRequest(initial.execution.preparation.connection, initial.execution.request, [], initial.execution.confirmedAt);
    const parsed = parseStoredImageResponse(initial.execution, f.store.loadImageFixtureResponse(principal.tenantId, "project-a", run.batch.jobs[0].id)!);
    // Deliberately use a standalone 5A authority fixture to create a DIFFERENT
    // artifact. It is not the integrated authority and cannot attach to this task.
    const standalone = new LocalGeneratedImages({ tenantId: principal.tenantId, stateStore: f.store, authorizer: f.assetAuthorizer, authorizeCommit: () => undefined, clock: f.clock });
    const fake = await standalone.accept(principal, { connection: initial.execution.preparation.connection, request: initial.execution.request, confirmedFingerprint: initial.execution.requestFingerprint, confirmedAt: initial.execution.confirmedAt, prepared },
      { ...parsed, candidate: { mimeType: "image/png", body: other, checksumSha256: sha(other) } });
    expect(() => f.kernel.attachImageArtifact(principal, fake)).toThrow(expect.objectContaining({ code: "image_output_candidate_changed" }));
    expect(f.kernel.getBatch(principal, run.batch.batch.id).jobs[0].outputAssetIds).toEqual([]); held(f);
  });
  it.each(["blob", "lineage", "catalog", "task"] as const)("%s 保存后故障回滚图片/目录/产物任务，保留原响应与未知预留", async (kind) => {
    const f = setup(); f.register(); const run = await returned(f), raw = f.store.loadImageFixtureResponse(principal.tenantId, "project-a", run.batch.jobs[0].id);
    if (kind === "blob") { const original = f.store.saveVerifiedImage.bind(f.store); vi.spyOn(f.store, "saveVerifiedImage").mockImplementationOnce((record, body) => { original(record, body); throw new Error("after-blob-secret"); }); }
    if (kind === "lineage") { const original = f.store.saveGeneratedImage.bind(f.store); vi.spyOn(f.store, "saveGeneratedImage").mockImplementationOnce((record, body) => { original(record, body); throw new Error("after-lineage-secret"); }); }
    if (kind === "catalog") { const original = f.store.saveCatalog.bind(f.store); vi.spyOn(f.store, "saveCatalog").mockImplementationOnce((catalog) => { original(catalog); throw new Error("after-catalog-secret"); }); }
    if (kind === "task") { const original = f.store.save.bind(f.store); vi.spyOn(f.store, "save").mockImplementation((snapshot) => { original(snapshot); if (snapshot.batches[0].imageTaskArtifact) throw new Error("after-task-secret"); }); }
    await expect(artifacts(f).ingest(principal, run.batch.jobs[0].id)).rejects.toMatchObject({ status: 503 }); empty(f, run.batch.jobs[0].id); held(f);
    expect(f.store.loadImageFixtureResponse(principal.tenantId, "project-a", run.batch.jobs[0].id)).toEqual(raw);
    expect(f.store.load()!.batches[0].imageTaskArtifactFailures).toMatchObject([{ stage: "commit", code: "image_output_save_failed" }]); expect(JSON.stringify(f.store.load())).not.toContain("-secret");
    vi.restoreAllMocks(); const record = await artifacts(f).ingest(principal, run.batch.jobs[0].id); expect(record.image.checksumSha256).toBe(sha(full)); expect(run.send).toHaveBeenCalledTimes(1); held(f);
    expect(f.store.load()!.batches[0].imageTaskArtifactFailures).toHaveLength(1);
  });
  it("原始包与生成图共用二进制上限，不能先存图再删除历史腾空间", async () => {
    const f = setup(); f.register(); const run = await returned(f), bytes = f.store.localImageBinaryBytes(principal.tenantId, "project-a");
    await expect(artifacts(f, { maxProjectBytes: bytes + full.length - 1 }).ingest(principal, run.batch.jobs[0].id)).rejects.toMatchObject({ code: "image_output_project_quota" });
    expect(f.store.localImageBinaryBytes(principal.tenantId, "project-a")).toBe(bytes); empty(f, run.batch.jobs[0].id); held(f);
  });
  it("完整谱系和任务证据计入元数据额度，超限无半提交", async () => {
    let quota = 16 * 1024 * 1024;
    const f = setup({ kernel: { validateImageArtifact: (...args) => createImageArtifactValidator({ tenantId: principal.tenantId, stateStore: f.store, providerAuthorizer: { authenticate: () => principal, allows: () => true }, assetAuthorizer: f.assetAuthorizer, maxMetadataBytes: quota })(...args) } });
    f.register(); const run = await returned(f); quota = f.store.imageMetadataBytes(principal.tenantId, "project-a") + imageTaskMetadataBytes(f.store.load(), principal.tenantId, "project-a") + 1;
    await expect(artifacts(f).ingest(principal, run.batch.jobs[0].id)).rejects.toMatchObject({ code: "image_output_metadata_quota" }); empty(f, run.batch.jobs[0].id); held(f);
  });
  it("失败证据有界且一致重放不追加，不删除旧证据腾空间", async () => {
    const f = setup(); f.register(); const run = await returned(f, "failures", reply(png));
    for (let i = 0; i < 16; i++) f.kernel.recordImageArtifactFailure(principal, run.batch.jobs[0].id, "validation", `image_output_fixture_${String.fromCharCode(97 + i)}`);
    f.kernel.recordImageArtifactFailure(principal, run.batch.jobs[0].id, "validation", "image_output_fixture_a"); expect(f.store.load()!.batches[0].imageTaskArtifactFailures).toHaveLength(16);
    expect(() => f.kernel.recordImageArtifactFailure(principal, run.batch.jobs[0].id, "commit", "image_output_more")).toThrow(expect.objectContaining({ code: "image_output_failure_history_full" })); held(f);
  });
  it.each(["charged", "not-charged"] as const)("已验证资产经人工 %s 核账才完成，不改变原响应或重复结算", async (resolution) => {
    const f = setup(); f.register(); const run = await returned(f, "manual", reply(), artifacts(f)), raw = f.store.loadImageFixtureResponse(principal.tenantId, "project-a", run.batch.jobs[0].id);
    const request = { resolutionId: "human-billing", expectedReservedMinor: 30, expectedCurrency: "CNY", evidenceRef: "zero-fee-accounting-fixture", resolution, ...(resolution === "charged" ? { actualCostMinor: 27 } : {}) };
    const result = f.kernel.resolveBillingUnknown(principal, run.batch.jobs[0].id, request as never); expect(result.jobs[0]).toMatchObject({ status: "succeeded", actualCostMinor: resolution === "charged" ? 27 : 0 });
    expect(result.jobs[0].outputAssetIds).toHaveLength(1); expect(f.kernel.resolveBillingUnknown(principal, run.batch.jobs[0].id, request as never)).toEqual(result);
    expect(f.store.loadImageFixtureResponse(principal.tenantId, "project-a", run.batch.jobs[0].id)).toEqual(raw); expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ reservedMinor: 0, spentMinor: resolution === "charged" ? 27 : 0 });
    expect(run.send).toHaveBeenCalledTimes(1);
  });
  it("核账先于资产恢复也不重发，新资产仅改产物状态、不改已核费用", async () => {
    const f = setup(); f.register(); const run = await returned(f);
    f.kernel.resolveBillingUnknown(principal, run.batch.jobs[0].id, { resolutionId: "human-first", expectedReservedMinor: 30, expectedCurrency: "CNY", evidenceRef: "fixture-paid-proof", resolution: "charged", actualCostMinor: 27 });
    const ledger = f.store.load()!.batches[0].aggregate.ledger; expect(f.kernel.getBatch(principal, run.batch.batch.id).jobs[0].status).toBe("failed");
    await artifacts(f).ingest(principal, run.batch.jobs[0].id); expect(f.kernel.getBatch(principal, run.batch.batch.id).jobs[0]).toMatchObject({ status: "succeeded", actualCostMinor: 27 });
    expect(f.store.load()!.batches[0].aggregate.ledger).toEqual(ledger); expect(run.send).toHaveBeenCalledTimes(1);
  });
  it("有图也不能绕过超额审批，第二人批准不提高项目预算", async () => {
    const f = setup(); f.register(); const run = await returned(f, "overage", reply(), artifacts(f));
    const pending = f.kernel.requestBillingOverage(principal, run.batch.jobs[0].id, { requestId: "overage-a", expectedReservedMinor: 30, expectedCurrency: "CNY", expectedBatchMaxCostMinor: 30,
      actualCostMinor: 35, requestedBatchMaxCostMinor: 35, evidenceRef: "local-overage-evidence", reason: "fixture-only" }); held(f);
    const result = f.kernel.reviewBillingOverage({ ...principal, actorId: "reviewer" }, run.batch.jobs[0].id, pending.billingOverages[0].id, { reviewId: "second-review", decision: "approve",
      expectedReservedMinor: 30, expectedCurrency: "CNY", expectedActualCostMinor: 35, expectedBatchMaxCostMinor: 30, expectedRequestedBatchMaxCostMinor: 35, evidenceRef: "local-review-evidence", note: "fixture-only" });
    expect(result.jobs[0].status).toBe("succeeded"); expect(f.kernel.getBudget(principal, "project-a")).toMatchObject({ limitMinor: 1000, spentMinor: 35, reservedMinor: 0 });
  });
  it("损坏正文/谱系/标记/目录不是未生成，任务恢复失败关闭仍保留预算", async () => {
    for (const kind of ["blob", "lineage", "marker", "catalog"] as const) {
      const f = setup(); f.register(); const run = await returned(f, "corrupt", reply(), artifacts(f)), db = new DatabaseSync(f.path);
      try {
        if (kind === "blob") db.exec("UPDATE verified_images SET body = x'00'"); if (kind === "lineage") db.exec("DELETE FROM generated_images"); if (kind === "marker") db.exec("DELETE FROM generated_image_presence");
        if (kind === "catalog") f.store.transaction(() => { const catalog = f.store.loadCatalog()!; catalog.projects[0].assets = []; f.store.saveCatalog(catalog); });
        expect(() => f.kernel.getBatch(principal, run.batch.batch.id)).toThrow(expect.objectContaining({ code: "run_state_unavailable" })); expect(f.store.load()!.budgets[0].reservedMinor).toBe(30);
      } finally { db.close(); }
    }
  });
  it("重哈希的资产/响应/审计/身份/状态错配仍拒绝内核恢复", async () => {
    const f = setup(); f.register(); await returned(f, "rehash", reply(), artifacts(f)); const saved = f.store.load()!;
    expect(ImageTaskArtifactSchema.safeParse({ ...saved.batches[0].imageTaskArtifact, executionAuthorized: true }).success).toBe(false);
    expect(ImageTaskArtifactFailureSchema.safeParse({ schemaVersion: 1, mode: "local-fixture", code: "private-secret" }).success).toBe(false);
    for (const kind of ["asset", "result", "actor", "audit", "status", "missing"] as const) {
      const state = structuredClone(saved), stored = state.batches[0];
      if (kind === "asset") stored.imageTaskArtifact!.assetId = "foreign"; if (kind === "result") stored.imageTaskArtifact!.resultId = "foreign"; if (kind === "actor") stored.imageTaskArtifact!.committedBy = "other";
      if (kind === "audit") stored.aggregate.audit = stored.aggregate.audit.filter((event) => event.eventType !== "image-artifact-verified"); if (kind === "status") stored.aggregate.jobs[0].status = "succeeded";
      if (kind === "missing") delete stored.imageTaskArtifact; else stored.imageTaskArtifactFingerprint = imageSnapshotFingerprint(stored.imageTaskArtifact);
      expect(() => new InMemoryRunKernel({ authorizer: { authenticate: () => principal, allows: () => true }, budgets: state.budgets, recoverRunningJobsOnRestore: false, stateStore: { load: () => state, save: () => undefined } })).toThrow();
    }
  });
  it("生成记录和产物摘要重新计算，也不能绕过完整确认/响应谱系恢复检查", async () => {
    for (const kind of ["request", "payload", "time", "protocol", "constraint", "outcome"] as const) {
      const f = setup(); f.register(); const run = await returned(f, kind, reply(), artifacts(f)), state = f.store.load()!, stored = state.batches[0];
      const record = f.store.loadGeneratedImage(principal.tenantId, "project-a", run.batch.jobs[0].id)!;
      if (kind === "request") record.request.parameters.prompt = "different-human-confirmation";
      if (kind === "payload") record.payloadChecksumSha256 = "f".repeat(64);
      if (kind === "time") record.confirmedAt = new Date(Date.parse(record.confirmedAt) - 1000).toISOString();
      if (kind === "protocol") record.protocol = "google";
      if (kind === "constraint") record.constraint.brandRules.style = "different-constraint";
      if (kind === "outcome") record.providerOutcome.providerRequestId = "different-response";
      stored.imageTaskArtifact!.generatedRecordFingerprint = imageSnapshotFingerprint(record);
      stored.imageTaskArtifactFingerprint = imageSnapshotFingerprint(stored.imageTaskArtifact);
      stored.aggregate.audit.find((event) => event.eventType === "image-artifact-verified")!.metadata.generatedRecordFingerprint = stored.imageTaskArtifact!.generatedRecordFingerprint;
      const db = new DatabaseSync(f.path);
      try { const payload = JSON.stringify(record); db.prepare("UPDATE generated_images SET record = ?, record_sha256 = ?").run(payload, sha(Buffer.from(payload))); f.store.transaction(() => f.store.save(state)); }
      finally { db.close(); }
      expect(() => f.kernel.getBatch(principal, run.batch.batch.id)).toThrow(expect.objectContaining({ code: "run_state_unavailable" }));
      expect(f.store.load()!.budgets[0].reservedMinor).toBe(30); expect(run.send).toHaveBeenCalledTimes(1);
    }
  });
  it("两份验证占用有界槽，第三个可后续明确处理已有响应、不重发", async () => {
    const f = setup({ kernel: { maxConcurrentJobs: 4 } }); f.register(); const runs = [await returned(f, "a"), await returned(f, "b"), await returned(f, "c")];
    const pending = runs.slice(0, 2).map((run) => artifacts(f).ingest(principal, run.batch.jobs[0].id));
    await expect(artifacts(f).ingest(principal, runs[2].batch.jobs[0].id)).rejects.toMatchObject({ code: "image_output_busy" }); await Promise.all(pending);
    await artifacts(f).ingest(principal, runs[2].batch.jobs[0].id); expect(runs.every((run) => run.send.mock.calls.length === 1)).toBe(true); held(f, 90);
  });
  it("HTTP 不开放产物写入/二进制回读，已绑定资产的公开任务也不含私有结果", async () => {
    const f = setup(); f.register(); const run = await returned(f, "http", reply(), artifacts(f)), server = createApiServer({ runKernel: f.kernel }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("server-missing"); const base = `http://127.0.0.1:${address.port}`, headers = { authorization: "Bearer writer", "content-type": "application/json" };
      for (const path of ["artifact-ingest", "artifact-binary"]) expect((await fetch(`${base}/v1/run-jobs/${run.batch.jobs[0].id}/${path}`, { method: "POST", headers, body: "{}" })).status).toBe(404);
      expect((await fetch(`${base}/v1/run-jobs/${run.batch.jobs[0].id}/artifact-binary`, { headers })).status).toBe(404);
      const body = await (await fetch(`${base}/v1/run-batches/${run.batch.batch.id}`, { headers })).text(); expect(body).toContain("generated-"); expect(body).not.toContain("b64_json"); expect(body).not.toContain("opaque-never-resolved"); held(f);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
