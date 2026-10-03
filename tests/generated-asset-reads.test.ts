import { createRequire } from "node:module";
import { request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalGeneratedAssetReads, type GeneratedAssetReadPort } from "../apps/api/src/generatedAssetReads";
import { LocalImageTaskArtifacts } from "../apps/api/src/imageTaskArtifacts";
import { LocalFixtureImageExecutor } from "../apps/api/src/imageFixtureExecutor";
import { LocalGeneratedImages } from "../apps/api/src/generatedImages";
import { parseStoredImageResponse } from "../apps/api/src/imageArtifactPolicy";
import { prepareOpenAiImageRequest } from "../apps/api/src/openaiImageProtocol";
import { createApiServer } from "../apps/api/src/index";
import { imageSnapshotFingerprint } from "../apps/api/src/imageProviderContract";
import { setupImageTask, principal, sha, connection } from "./helpers/image-task-fixture";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
let png: Buffer, jpeg: Buffer, webp: Buffer;
beforeAll(async () => { const image = sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ff8800" } });
  [png, jpeg, webp] = await Promise.all([image.clone().png().toBuffer(), image.clone().jpeg().toBuffer(), image.clone().webp().toBuffer()]); });
const fixtures: ReturnType<typeof setupImageTask>[] = [], servers: Server[] = [], sockets: IncomingMessage[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  vi.restoreAllMocks(); for (const f of fixtures.splice(0).reverse()) f.cleanup(); });
const setup = (options: Parameters<typeof setupImageTask>[0] = {}) => { const f = setupImageTask(options); fixtures.push(f); return f; };
const reader = (f: ReturnType<typeof setup>, authorizer = f.assetAuthorizer) => new LocalGeneratedAssetReads({ tenantId: principal.tenantId, stateStore: f.store, authorizer });
async function generated(f: ReturnType<typeof setup>, id = "read-fixture", original = png, attach = true, configuration?: ReturnType<typeof connection>) {
  f.register(configuration ?? connection({ models: [{ ...connection().models[0], outputFormats: ["png", "jpeg", "webp"] }] }));
  const format = original === jpeg ? "jpeg" : original === webp ? "webp" : "png";
  const batch = await f.confirm(id, { parameters: { prompt: "private-human-prompt", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", background: "auto", outputFormat: format } });
  const lease = f.kernel.claimImageBatch(principal, batch.batch.id, { workerId: "read-worker", maxJobs: 1 }).leases[0];
  const packet = configuration?.protocol === "google" ? { candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: original.toString("base64") } }] } }] }
    : { created: 1, data: [{ b64_json: original.toString("base64") }] };
  const send = vi.fn(async () => ({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(packet)) }));
  await new LocalFixtureImageExecutor({ stateStore: f.store, runKernel: f.kernel, transport: { mode: "local-fixture", realExecutionEnabled: false, send },
    artifacts: attach ? new LocalImageTaskArtifacts({ tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, authorizer: f.assetAuthorizer, clock: f.clock }) : undefined,
    clock: f.clock }).execute(principal, batch.jobs[0].id, { workerId: lease.workerId, leaseId: lease.leaseId });
  const record = f.store.loadGeneratedImage(principal.tenantId, "project-a", batch.jobs[0].id);
  return { batch, record, send, assetId: record?.image.asset.id ?? "not-generated" };
}
async function listen(port?: GeneratedAssetReadPort, configure?: (server: Server) => void) {
  const server = createApiServer({ generatedAssetReads: port }); servers.push(server);
  configure?.(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address();
  if (!address || typeof address === "string") throw new Error("server-missing"); return `http://127.0.0.1:${address.port}`;
}
const path = (assetId: string, project = "project-a") => `/v1/projects/${encodeURIComponent(project)}/generated-assets/${encodeURIComponent(assetId)}/content`;
const headers = { authorization: "Bearer writer" };
const unchanged = (f: ReturnType<typeof setup>, before: unknown) => { expect(f.store.load()).toEqual(before); expect(f.store.load()!.budgets[0].reservedMinor).toBe(30); };

describe("有权限的已生成资产二进制回读", () => {
  it("缺失配置关闭；租户配置无效拒绝，不创建执行器", async () => {
    const f = setup(); for (const tenantId of ["", " tenant-a", "x".repeat(161), "bad\n"]) expect(() => new LocalGeneratedAssetReads({ tenantId, stateStore: f.store, authorizer: f.assetAuthorizer })).toThrow();
    const base = await listen(), response = await fetch(base + path("unknown")); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "generated_asset_reads_not_configured" });
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(await (await fetch(base + "/health")).json()).toMatchObject({ realExecutorsEnabled: false, generatedAssetReadEnabled: false });
  });
  it.each(["png", "jpeg", "webp"] as const)("%s 返回保存的原字节与必要字段，不暴露完整谱系或改费用", async (format) => {
    const f = setup({ format: format === "jpeg" ? "jpeg" : "png" });
    if (format === "webp") f.store.transaction(() => { const catalog = f.store.loadCatalog()!; catalog.projects[0].constraints[0].outputSpec.format = "webp"; f.store.saveCatalog(catalog); });
    const original = format === "jpeg" ? jpeg : format === "webp" ? webp : png, run = await generated(f, format, original), before = f.store.load();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no-network")); const content = reader(f).read(principal, "project-a", run.assetId);
    expect(content).toEqual({ body: original, mimeType: `image/${format}`, checksumSha256: sha(original) }); expect(Object.keys(content).sort()).toEqual(["body", "checksumSha256", "mimeType"]);
    expect(content.body).not.toBe(original); expect(network).not.toHaveBeenCalled(); unchanged(f, before); expect(run.send).toHaveBeenCalledTimes(1);
  });
  it("只读成员无需执行/写入/供应商权限，unknown 有图可读但不释放预留", async () => {
    const f = setup(); const run = await generated(f), before = f.store.load(); f.revokeProvider(); f.denyRun("run:read"); f.denyRun("run:execute");
    const allows = vi.fn((_actor, projectId, permission) => projectId === "project-a" && permission === "asset:read");
    const view = reader(f, { authenticate: () => ({ ...principal, actorId: "reader" }), allows });
    expect(view.read({ ...principal, actorId: "reader" }, "project-a", run.assetId).body).toEqual(png);
    expect(allows.mock.calls.every((call) => call[2] === "asset:read")).toBe(true); unchanged(f, before); expect(run.send).toHaveBeenCalledTimes(1);
  });
  it.each(["compatible", "google"] as const)("%s 冻结原生响应也只能回读实际候选的已绑定原图", async (protocol) => {
    const f = setup({ format: protocol === "google" ? "jpeg" : "png" }), base = connection(), original = protocol === "google" ? jpeg : png;
    const config = protocol === "google" ? connection({ protocol: "google", baseUrl: "https://generativelanguage.googleapis.com",
      googleNative: { version: "fixture-v1", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: "explicit-fixture-model", sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] },
      models: [{ ...base.models[0], outputFormats: ["jpeg"], maxInputImages: 3 }] }) : connection({ protocol: "openai-compatible", compatibility: {
        version: "fixture-v1", endpoints: { generate: "/images/generations", edit: "/images/edits" }, auth: { scheme: "header", headerName: "x-api-key" },
        editEncoding: "multipart-image-single", responseEncoding: "images-b64-json-v1", extraParameters: [] } });
    const run = await generated(f, protocol, original, true, config), before = f.store.load(); expect(reader(f).read(principal, "project-a", run.assetId).body).toEqual(original); unchanged(f, before);
  });
  it("读取授权必须同步返回 true，Promise 不能被当作有权限", async () => {
    const f = setup(); const run = await generated(f), before = f.store.load(), load = vi.spyOn(f.store, "load");
    expect(() => reader(f, { authenticate: () => principal, allows: (() => Promise.resolve(false)) as never }).read(principal, "project-a", run.assetId))
      .toThrow(expect.objectContaining({ status: 404 })); expect(load).not.toHaveBeenCalled(); unchanged(f, before);
  });
  it("权限/租户拒绝在快照、目录、原包与原图读取之前，并统一 404", async () => {
    const f = setup(); const run = await generated(f), view = reader(f), spies = [vi.spyOn(f.store, "load"), vi.spyOn(f.store, "loadCatalog"), vi.spyOn(f.store, "loadImageFixtureResponse"), vi.spyOn(f.store, "loadVerifiedImageBytes")];
    expect(() => view.read({ ...principal, tenantId: "foreign" }, "project-a", run.assetId)).toThrow(expect.objectContaining({ code: "generated_asset_not_found", status: 404 }));
    f.revokeAsset(); expect(() => view.read(principal, "project-a", run.assetId)).toThrow(expect.objectContaining({ code: "generated_asset_not_found", status: 404 }));
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });
  it("同名项目的其他租户、其他项目/来源图片/URL/路径/未知编号都不返回字节", async () => {
    const f = setup(); f.source(); const run = await generated(f), view = reader(f), before = f.store.load();
    for (const [projectId, assetId] of [["other", run.assetId], ["project-a", "source"], ["project-a", "unknown"], ["project-a", "https://supplier.invalid/image"], ["project-a", "C:\\private\\file.png"], ["project-a", "../source"], ["project-a", "x".repeat(161)]]) {
      expect(() => view.read(principal, projectId, assetId)).toThrow(expect.objectContaining({ status: 404, code: "generated_asset_not_found" }));
    }
    unchanged(f, before);
  });
  it("提交前撤销读取权限拒绝返回，没有被读取触发的任务或账本变更", async () => {
    const f = setup(); const run = await generated(f), before = f.store.load(), allows = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    expect(() => reader(f, { authenticate: () => principal, allows }).read(principal, "project-a", run.assetId)).toThrow(expect.objectContaining({ status: 404 })); unchanged(f, before);
  });
  it("每次回读是独立 Buffer，修改返回体不覆盖原资产", async () => {
    const f = setup(); const run = await generated(f), view = reader(f), before = f.store.load(); const content = view.read(principal, "project-a", run.assetId); content.body.fill(0);
    expect(view.read(principal, "project-a", run.assetId).body).toEqual(png); unchanged(f, before);
  });
  it("目录停用/报价过期及另一个租约到期，读取不恢复任务/租约或改预算", async () => {
    const f = setup(); const run = await generated(f), queued = await f.confirm("unrelated-lease"); f.kernel.claimImageBatch(principal, queued.batch.id, { workerId: "unrelated", maxJobs: 1 });
    f.advance(61000); f.register(connection({ revision: 2, enabled: false })); const before = f.store.load(), save = vi.spyOn(f.store, "save");
    expect(reader(f).read(principal, "project-a", run.assetId).body).toEqual(png); expect(f.store.load()).toEqual(before); expect(save).not.toHaveBeenCalled();
    expect(f.store.load()!.batches[1].aggregate.jobs[0].status).toBe("leased"); expect(f.store.load()!.budgets[0].reservedMinor).toBe(60);
  });
  it("未绑定的独立 5A 资产不是可下载任务产物，不以目录存在冒充授权", async () => {
    const f = setup(); const run = await generated(f, "standalone", png, false), execution = f.kernel.inspectImageArtifact(principal, run.batch.jobs[0].id).execution;
    const prepared = await prepareOpenAiImageRequest(execution.preparation.connection, execution.request, [], execution.confirmedAt), parsed = parseStoredImageResponse(execution, f.store.loadImageFixtureResponse(principal.tenantId, "project-a", execution.request.jobId)!);
    const record = await new LocalGeneratedImages({ tenantId: principal.tenantId, stateStore: f.store, authorizer: f.assetAuthorizer, authorizeCommit: () => undefined, clock: f.clock })
      .accept(principal, { connection: execution.preparation.connection, request: execution.request, confirmedFingerprint: execution.requestFingerprint, confirmedAt: execution.confirmedAt, prepared }, parsed);
    const before = f.store.load(); expect(() => reader(f).read(principal, "project-a", record.image.asset.id)).toThrow(expect.objectContaining({ status: 404 })); unchanged(f, before);
  });
  it.each(["blob", "receipt", "lineage", "marker", "catalog", "preparation", "raw", "raw-marker", "artifact", "output", "audit"] as const)("%s 损坏失败关闭，不返回半图片、不生成或释放预留", async (kind) => {
    const f = setup(); const run = await generated(f), db = new DatabaseSync(f.path);
    try {
      if (kind === "blob") db.exec("UPDATE verified_images SET body = x'00'"); if (kind === "receipt") db.exec("DELETE FROM verified_images");
      if (kind === "lineage") db.exec("DELETE FROM generated_images"); if (kind === "marker") db.exec("DELETE FROM generated_image_presence");
      if (kind === "preparation") db.exec("DELETE FROM image_preparation_presence"); if (kind === "raw") db.exec("UPDATE image_fixture_responses SET body = x'00'");
      if (kind === "raw-marker") db.exec("DELETE FROM image_fixture_response_presence");
      if (kind === "catalog") f.store.transaction(() => { const catalog = f.store.loadCatalog()!; catalog.projects[0].assets = []; f.store.saveCatalog(catalog); });
      if (["artifact", "output", "audit"].includes(kind)) f.store.transaction(() => { const state = f.store.load()!, stored = state.batches[0];
        if (kind === "artifact") delete stored.imageTaskArtifact; if (kind === "output") stored.aggregate.jobs[0].outputAssetIds = ["foreign"];
        if (kind === "audit") stored.aggregate.audit = stored.aggregate.audit.filter((event) => event.eventType !== "image-artifact-verified"); f.store.save(state); });
      const before = f.store.load(); expect(() => reader(f).read(principal, "project-a", run.assetId)).toThrow(expect.objectContaining({ status: 503 })); unchanged(f, before); expect(run.send).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });
  it("部分重哈希生成谱系也不能改变已确认请求后下载", async () => {
    const f = setup(); const run = await generated(f), state = f.store.load()!, record = run.record!, db = new DatabaseSync(f.path);
    record.request.parameters.prompt = "different-confirmation"; const payload = JSON.stringify(record), stored = state.batches[0];
    stored.imageTaskArtifact!.generatedRecordFingerprint = imageSnapshotFingerprint(record); stored.imageTaskArtifactFingerprint = imageSnapshotFingerprint(stored.imageTaskArtifact);
    stored.aggregate.audit.find((event) => event.eventType === "image-artifact-verified")!.metadata.generatedRecordFingerprint = stored.imageTaskArtifact!.generatedRecordFingerprint;
    try { db.prepare("UPDATE generated_images SET record = ?, record_sha256 = ?").run(payload, sha(Buffer.from(payload))); f.store.transaction(() => f.store.save(state)); }
    finally { db.close(); }
    expect(() => reader(f).read(principal, "project-a", run.assetId)).toThrow(expect.objectContaining({ status: 503 })); unchanged(f, state);
  });
  it("人工核账完成后的资产仍可读，不重复结算或覆盖原返回", async () => {
    const f = setup(); const run = await generated(f); f.kernel.resolveBillingUnknown(principal, run.batch.jobs[0].id, { resolutionId: "read-human", resolution: "charged", actualCostMinor: 27,
      expectedReservedMinor: 30, expectedCurrency: "CNY", evidenceRef: "local-only-paid-fixture" });
    const before = f.store.load(); expect(reader(f).read(principal, "project-a", run.assetId).body).toEqual(png); expect(f.store.load()).toEqual(before);
    expect(f.store.load()!.budgets[0]).toMatchObject({ reservedMinor: 0, spentMinor: 27 }); expect(run.send).toHaveBeenCalledTimes(1);
  });
  it("真实本地 HTTP 回读返回原文件/摘要/安全头，不返回提示词、报价、凭证或原包", async () => {
    const f = setup(); const run = await generated(f), base = await listen(reader(f)), before = f.store.load();
    const response = await fetch(base + path(run.assetId), { headers }); expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get("content-type")).toBe("image/png"); expect(response.headers.get("content-length")).toBe(String(png.length)); expect(response.headers.get("x-content-sha256")).toBe(sha(png));
    expect(response.headers.get("x-canvas-binary-version")).toBe("generated-image-v1"); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff"); expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain("sandbox"); expect(response.headers.get("vary")).toBe("Authorization"); expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const allHeaders = [...response.headers].join(" "); for (const value of ["private-human-prompt", "opaque-never-resolved", "never-called.invalid", "b64_json", "fixture-quote"]) expect(allHeaders).not.toContain(value);
    const conditional = await fetch(base + path(run.assetId), { headers: { ...headers, "if-none-match": `"${sha(png)}"` } }); expect(conditional.status).toBe(200); expect(Buffer.from(await conditional.arrayBuffer())).toEqual(png); unchanged(f, before);
  });
  it("HTTP 认证/权限/参数/方法/Range 都不产生或泄漏图片，错误也禁止缓存", async () => {
    const f = setup(); const run = await generated(f), base = await listen(reader(f)), uri = base + path(run.assetId), before = f.store.load();
    for (const [url, init, status] of [[uri, {}, 401], [uri, { headers: { authorization: "Bearer invalid" } }, 401], [uri, { headers, method: "POST" }, 405],
      [uri, { headers, method: "HEAD" }, 405], [uri + "?tenantId=foreign", { headers }, 400], [uri, { headers: { ...headers, range: "bytes=0-7" } }, 416],
      [base + path("unknown"), { headers }, 404], [base + path(run.assetId, "foreign"), { headers }, 404], [base + "/v1/projects/project-a/generated-assets/%ZZ/content", { headers }, 400]] as const) {
      const response = await fetch(url, init); expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-sha256")).toBeNull(); expect(response.headers.get("content-type")).not.toBe("image/png");
      if (init.method !== "HEAD") expect((await response.text())).not.toContain("private-human-prompt");
    }
    f.revokeAsset(); const denied = await fetch(uri, { headers }); expect(denied.status).toBe(404); expect(await denied.json()).toEqual({ error: "generated_asset_not_found" }); unchanged(f, before);
  });
  it("可信读取端口返回坏类型/错误摘要/超限正文时 HTTP 仍拒绝二进制", async () => {
    for (const content of [{ body: png, mimeType: "text/html", checksumSha256: sha(png) }, { body: png, mimeType: "image/png", checksumSha256: "0".repeat(64) },
      { body: Buffer.alloc(20 * 1024 * 1024 + 1), mimeType: "image/png", checksumSha256: "0".repeat(64) }]) {
      const base = await listen({ authenticate: () => principal, read: () => content as never }); const response = await fetch(base + path("trusted-fixture"));
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "generated_asset_unavailable" });
    }
  });
  it("带正文的 GET 请求提前拒绝，不把正文当作租户、路径或执行参数", async () => {
    const read = vi.fn(() => ({ body: png, mimeType: "image/png" as const, checksumSha256: sha(png) })), base = await listen({ authenticate: () => principal, read });
    const result = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const outgoing = httpRequest(base + path("body-fixture"), { method: "GET", headers: { "content-length": "4" } }, (response) => {
        const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk))); response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }); outgoing.on("error", reject); outgoing.end("fake");
    });
    expect(result).toEqual({ status: 400, body: JSON.stringify({ error: "generated_asset_request_invalid" }) }); expect(read).not.toHaveBeenCalled();
  });
  it("两份未完成二进制响应占用共享槽，客户端中断后释放而不无限排队", async () => {
    // Transfer-boundary fixture only; actual persisted artifact authority is
    // covered above. No provider, image decode, user state or billing action.
    let hold = true;
    const base = await listen({ authenticate: () => principal, read: () => ({ body: png, mimeType: "image/png", checksumSha256: sha(png) }) }, (server) => {
      // Deterministically keep responses open; Windows TCP can buffer a whole
      // 20 MiB response even when the receiver pauses, so that is not a slot test.
      server.prependListener("request", (_request, response) => {
        const end = response.end.bind(response);
        response.end = ((...args: unknown[]) => { if (hold && response.statusCode === 200) { response.flushHeaders(); return response; }
          return (end as (...args: unknown[]) => ServerResponse)(...args); }) as ServerResponse["end"];
      });
    });
    const pause = () => new Promise<IncomingMessage>((resolve, reject) => { const outgoing = httpRequest(base + path("transfer-fixture"), (incoming) => { incoming.pause(); sockets.push(incoming); resolve(incoming); }); outgoing.on("error", reject); outgoing.end(); });
    const a = await pause(), b = await pause(); expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
    const full = await fetch(base + path("transfer-fixture")); expect(full.status).toBe(429); expect(await full.json()).toEqual({ error: "generated_asset_read_busy" });
    a.destroy(); b.destroy(); await new Promise((resolve) => setTimeout(resolve, 50)); hold = false;
    const available = await fetch(base + path("transfer-fixture")); expect(available.status).toBe(200); expect(Buffer.from(await available.arrayBuffer())).toEqual(png);
  });
});
