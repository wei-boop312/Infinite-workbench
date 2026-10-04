import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { ProductionImageOutputDraftSchema, validateProductionImageOutput } from "../apps/api/src/productionImageOutputValidation";
import * as decoderApi from "../apps/api/src/staticImageDecoder";
import { ProductionImageAttemptSchema, ProductionImageRawResponseSchema, type ConfirmedProductionImageExecution, type ImageProviderConnection } from "../packages/contracts/src/index";
import { ImageProductionPreparationHarness, type ImagePriceContext } from "../apps/api/src/productionImagePreparations";
import { createProductionImageLeaseFixturePolicy, type ProductionImageLeasePolicy } from "../apps/api/src/productionImageLeasePolicy";
import { ImageProductionReconstructionHarness } from "../apps/api/src/productionImageTaskReconstruction";
import { productionExpected } from "../apps/api/src/productionImageConfirmationIntegrity";
import { assertProductionImageAttempt, assertProductionImageRawResponse, parseProductionImageResponse, productionImageUnknownOutcome } from "../apps/api/src/productionImageResponse";
import { parseOpenAiImageResponse, parseProductionOpenAiImageResponse } from "../apps/api/src/openaiImageProtocol";
import { parseGoogleImageResponse, parseProductionGoogleImageResponse } from "../apps/api/src/googleImageProtocol";
import { parseCompatibleImageResponse, parseProductionCompatibleImageResponse } from "../apps/api/src/compatibleImageProtocol";
import { imageSnapshotFingerprint as fp } from "../apps/api/src/imageProviderContract";
import { imageTaskMetadataBytes } from "../apps/api/src/imageTaskMetadata";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { at, connection, png, principal, setupImageTask, sha } from "./helpers/image-task-fixture";
const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");

const owned: ReturnType<typeof setupImageTask>[] = [], opened: SqliteRunKernelStateStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const s of opened.splice(0).reverse()) s.close(); for (const f of owned.splice(0).reverse()) f.cleanup(); });
const rawStore = (path: string) => { const s = new SqliteRunKernelStateStore(path, { productionResponseStorageEnabled: true }); opened.push(s); return s; };
const withDb = <T>(path: string, action: (db: DatabaseSync) => T): T => { const db = new DatabaseSync(path); try { return action(db); } finally { db.close(); } };
// Only self-owned contract-fixture pricing/material. Actual accepted confirmation,
// lease and not-connected intent are built by their real SQLite services. The
// attempt below is a pure fixture, NOT a committed actual task/send authorization.
async function evidence(options: { protocol?: ImageProviderConnection["protocol"]; manual?: boolean; edit?: boolean; cap?: number; background?: "transparent" | "opaque" } = {}) {
  let service: ImageProductionPreparationHarness, leasePolicy: ProductionImageLeasePolicy, reconstruction: ImageProductionReconstructionHarness;
  const authorizer = { authenticate: () => principal, allows: (p: typeof principal, project: string) => p.tenantId === principal.tenantId && p.actorId === principal.actorId && project === "project-a" };
  const gate: ProductionImageLeasePolicy = { usesStateStore: s => leasePolicy.usesStateStore(s), authorizeScope: (p, project) => leasePolicy.authorizeScope(p, project),
    validate: (p, e, purpose, bytes) => leasePolicy.validate(p, e, purpose, bytes) };
  const f = setupImageTask({ format: options.protocol === "google" ? "jpeg" : "png", kernel: { authorizer,
    validateProductionImageConfirmation: (p, e: ConfirmedProductionImageExecution) => service.authorizeConfirmation(p, e), productionImageLeasePolicy: gate,
    productionImageStartPolicy: { usesStateStore: s => reconstruction?.usesStateStore(s) ?? false, authorizeScope: (p, project) => reconstruction?.authorizeScope(p, project) ?? false,
      validateStart: (p, e, l, i) => reconstruction?.validateStart(p, e, l, i) ?? false } } }); owned.push(f);
  const model = connection().models[0], protocol = options.protocol ?? "openai";
  const config = connection({ protocol,
    ...(options.background ? { models: [{ ...model, backgrounds: ["auto", "transparent", "opaque"] }] } : {}),
    ...(protocol === "openai-compatible" ? { compatibility: { version: "owned-compat", editEncoding: "json-images", responseEncoding: "images-b64-json-v1",
      auth: { scheme: "header", headerName: "x-api-key" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}),
    ...(protocol === "google" ? { baseUrl: "https://generativelanguage.googleapis.com", models: [{ ...model, maxInputImages: 14, outputFormats: ["jpeg"] }],
      googleNative: { version: "owned-google", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: model.model,
        sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] } } : {}) });
  f.register(config); if (options.edit) f.source();
  const pricePort = { kind: "contract-fixture" as const, realExecutionEnabled: false as const,
    read: vi.fn((c: ImagePriceContext) => ({ schemaVersion: 1, scope: c.scope, quote: { id: "owned-price", version: "owned-v1", source: options.manual === false ? "server-price-table" : "manual-budget",
      currency: "CNY", maxCostMinor: options.cap ?? 40, ...(options.manual === false ? { estimatedCostMinor: 25 } : {}), expiresAt: new Date(f.clock() + 60_000).toISOString() },
      evidence: { kind: "contract-fixture", realExecutionEnabled: false, sourceRevision: "owned-table", evidenceRef: "no-real-price", checkedBy: "owned-oracle", checkedAt: c.requestedAt } })), verify: vi.fn(() => true) };
  leasePolicy = createProductionImageLeaseFixturePolicy({ leasePreparationEnabled: true, tenantId: principal.tenantId, stateStore: f.store, clock: f.clock,
    runAuthorizer: authorizer, providerAuthorizer: authorizer, assetAuthorizer: authorizer, pricePort });
  service = new ImageProductionPreparationHarness({ preparationEnabled: true, tenantId: principal.tenantId, stateStore: f.store, clock: f.clock,
    runKernel: f.kernel, authorizer, runAuthorizer: authorizer, assetAuthorizer: authorizer, pricePort });
  reconstruction = new ImageProductionReconstructionHarness({ reconstructionEnabled: true, startEnabled: true, leasePolicy: gate, stateStore: f.store,
    tenantId: principal.tenantId, runKernel: f.kernel, clock: f.clock });
  const prepared = service.createPreparation(principal, { projectId: "project-a", idempotencyKey: "owned-action", connectionId: config.id, connectionRevision: 1,
    model: model.model, capabilityVersion: model.version, constraintSnapshotId: "constraint-a", protection: "none", operation: options.edit ? "edit" : "generate",
    inputAssetIds: options.edit ? ["source"] : [], parameters: { prompt: "原人工指令", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", background: options.background ?? "auto", outputFormat: protocol === "google" ? "jpeg" : "png" } });
  const preparation = f.store.loadProductionImagePreparation(principal.tenantId, "project-a", "production-contract-fixture", prepared.id)!;
  const batch = (await service.confirmPreparation(principal, "project-a", prepared.id, productionExpected(preparation))).aggregate;
  const l = f.kernel.claimProductionImageBatch(principal, "project-a", batch.batch.id, { workerId: "owned-worker", maxJobs: 1 }).leases[0];
  await reconstruction.start(principal, "project-a", batch.batch.id, l.jobId, { workerId: l.workerId, leaseId: l.leaseId });
  const saved = f.store.load()!.batches[0], e = saved.productionImageExecution!, lease = saved.productionImageLeases![0], intent = saved.productionImageDispatchIntent!;
  const attempt = ProductionImageAttemptSchema.parse({ schemaVersion: 1, mode: e.mode, state: "attempted", id: `production-image-attempt:${randomUUID()}`,
    tenantId: principal.tenantId, projectId: "project-a", jobId: e.protocol.request.jobId, batchId: e.batchId, actorId: lease.actorId, workerId: lease.workerId, leaseId: lease.leaseId,
    transport: "contract-fixture", intentFingerprint: fp(intent), executionFingerprint: fp(e), leaseFingerprint: fp(lease), requestFingerprint: e.protocol.requestFingerprint,
    payloadChecksumSha256: e.protocol.payloadChecksumSha256, attemptedAt: intent.recordedAt });
  // Magic-only candidate fixtures deliberately do not prove 1024x1024 decoding.
  const image = protocol === "google" ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]) : png;
  const json = protocol === "google" ? { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ inlineData: { mimeType: "image/jpeg", data: image.toString("base64") } }] } }], responseId: "owned-google-id" }
    : { created: 1, data: [{ b64_json: image.toString("base64"), revised_prompt: "never-public" }] };
  const response = { status: 200, contentType: "application/json", requestId: "owned-request-id", body: Buffer.from(JSON.stringify(json)) };
  const parse = (r = response, time = at, a: unknown = attempt) => parseProductionImageResponse(e, lease, intent, a, r, time);
  return { f, e, lease, intent, attempt, response, json, image, parse, pricePort, store: rawStore(f.path) };
}

describe("6D4A 独立生产响应纯解析，不是实际发送/产物许可", () => {
  it.each(["openai", "openai-compatible", "google"] as const)("%s known/unknown及编辑保留原确认关系，不填假估价", async protocol => {
    for (const manual of [true, false]) for (const edit of [true, false]) {
      const { f, e, parse, image, pricePort } = await evidence({ protocol, manual, edit }), before = f.store.load(), calls = pricePort.verify.mock.calls.length;
      const result = parse(); expect(result.candidate!.body).toEqual(image);
      expect(result.record).toMatchObject({ mode: "production-contract-fixture", kind: "returned", outcome: { providerStatus: "returned", artifactStatus: "pending-validation", billing: { state: "unknown" } } });
      expect(e.protocol.request.quote).toEqual(expect.objectContaining({ source: manual ? "manual-budget" : "server-price-table" }));
      expect(before!.batches[0].aggregate.jobs[0].estimatedCostMinor).toBe(manual ? null : 25);
      expect(f.store.load()).toEqual(before); expect(pricePort.read).toHaveBeenCalledTimes(1); expect(pricePort.verify).toHaveBeenCalledTimes(calls);
      const publicRecord = JSON.stringify(result.record); for (const secret of ["原人工指令", "never-public", "never-called.invalid", "opaque-never-resolved", image.toString("base64")]) expect(publicRecord).not.toContain(secret);
      expect(before!.batches[0]).not.toHaveProperty("productionImageAttempt"); result.candidate!.body.fill(0);
    }
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s 未知估价不能进入legacy入口、补0/上限或冒充本地编号", async protocol => {
    const { e, response } = await evidence({ protocol }), request = e.protocol.request;
    const legacy = protocol === "google" ? parseGoogleImageResponse : protocol === "openai-compatible" ? parseCompatibleImageResponse : parseOpenAiImageResponse;
    const production = protocol === "google" ? parseProductionGoogleImageResponse : protocol === "openai-compatible" ? parseProductionCompatibleImageResponse : parseProductionOpenAiImageResponse;
    expect(() => legacy(request as any, fp(request), response)).toThrow();
    for (const estimate of [0, request.quote.maxCostMinor]) expect(() => production({ ...request, quote: { ...request.quote, estimatedCostMinor: estimate } } as any, e.protocol.requestFingerprint, response, e.preparation.connection)).toThrow();
    const changed = { ...request, jobId: "image-job-local", idempotencyKey: "local-execution" };
    expect(() => production(changed, fp(changed), response, e.preparation.connection)).toThrow(); expect(() => production(request, "0".repeat(64), response, e.preparation.connection)).toThrow();
  });
  it.each(["tenantId", "projectId", "jobId", "batchId", "actorId", "workerId", "leaseId", "mode", "transport", "intentFingerprint", "executionFingerprint", "leaseFingerprint", "requestFingerprint", "payloadChecksumSha256"])("重算attemptSHA不能绕过%s", async field => {
    const { e, lease, intent, attempt } = await evidence(); const changed = { ...attempt, [field]: field === "mode" ? "production" : field === "transport" ? "native-https"
      : field.endsWith("Fingerprint") || field.endsWith("Sha256") ? "f".repeat(64) : "forged" };
    expect(() => assertProductionImageAttempt(changed, fp(changed), e, lease, intent)).toThrow();
  });
  it.each(["before-intent", "lease-expired", "quote-expired", "legacy-id", "fake-state", "extra-authorization"])("尝试%s拒绝", async kind => {
    const { e, lease, intent, attempt } = await evidence(); const changed = { ...attempt,
      ...(kind === "before-intent" ? { attemptedAt: new Date(Date.parse(at) - 1).toISOString() } : {}),
      ...(kind === "lease-expired" ? { attemptedAt: lease.expiresAt } : {}), ...(kind === "quote-expired" ? { attemptedAt: e.protocol.request.quote.expiresAt } : {}),
      ...(kind === "legacy-id" ? { id: "image-attempt-local" } : {}), ...(kind === "fake-state" ? { state: "sent" } : {}), ...(kind === "extra-authorization" ? { executionAuthorized: true } : {}) };
    expect(() => assertProductionImageAttempt(changed, fp(changed), e, lease, intent)).toThrow();
    expect(() => assertProductionImageAttempt(attempt, "0".repeat(64), e, lease, intent)).toThrow();
  });
  it("完整确认/原租约/意图替换不能靠部分重算摘要绕过", async () => {
    const a = await evidence(), b = await evidence();
    expect(() => assertProductionImageAttempt({ ...a.attempt, executionFingerprint: fp(b.e) }, fp({ ...a.attempt, executionFingerprint: fp(b.e) }), b.e, a.lease, a.intent)).toThrow();
    expect(() => assertProductionImageAttempt(a.attempt, fp(a.attempt), a.e, b.lease, a.intent)).toThrow();
    expect(() => assertProductionImageAttempt(a.attempt, fp(a.attempt), a.e, a.lease, { ...a.intent, payloadByteSize: a.intent.payloadByteSize + 1 })).toThrow();
  });
  it("迟到原响应用原尝试时间，不重新verify或刷新运行任务，不授权新发送", async () => {
    const a = await evidence(), before = a.f.store.load(); a.f.advance(120_000); const calls = a.pricePort.verify.mock.calls.length;
    const result = a.parse(a.response, new Date(a.f.clock()).toISOString()); expect(result.record.receivedAt).toBe(new Date(a.f.clock()).toISOString());
    expect(a.f.store.load()).toEqual(before); expect(a.pricePort.verify).toHaveBeenCalledTimes(calls); expect(result.record.outcome.billing.state).toBe("unknown");
  });
  it.each(["bad-status", "nan-status", "bad-type", "long-type", "bad-id", "before-attempt", "bad-time", "not-buffer", "oversize"])("外层响应%s失败关闭", async kind => {
    const { parse, response } = await evidence(); const r = { ...response,
      ...(kind === "bad-status" ? { status: 600 } : {}), ...(kind === "nan-status" ? { status: NaN } : {}), ...(kind === "bad-type" ? { contentType: "application/json\r\nx-secret: private" } : {}),
      ...(kind === "long-type" ? { contentType: "x".repeat(257) } : {}), ...(kind === "bad-id" ? { requestId: "secret/token?" } : {}),
      ...(kind === "not-buffer" ? { body: new Uint8Array([1]) } : {}), ...(kind === "oversize" ? { body: Buffer.alloc(32 * 1024 * 1024 + 1) } : {}) };
    expect(() => parse(r as any, kind === "before-attempt" ? new Date(Date.parse(at) - 1).toISOString() : kind === "bad-time" ? "invalid" : at)).toThrow();
  });
  it.each(["http-error", "redirect", "wrong-type", "json", "utf8", "url-only", "many", "base64", "magic", "format", "usage"])("有界坏响应%s可留原包但不创造合格图片或费用", async kind => {
    const { f, parse, response, json } = await evidence(), before = f.store.load();
    const r = { ...response, ...(kind === "http-error" ? { status: 500 } : {}), ...(kind === "redirect" ? { status: 302 } : {}), ...(kind === "wrong-type" ? { contentType: "image/png" } : {}),
      ...(kind === "json" ? { body: Buffer.from("{secret") } : {}), ...(kind === "utf8" ? { body: Buffer.from([0xff]) } : {}),
      ...(["url-only", "many", "base64", "magic", "format", "usage"].includes(kind) ? { body: Buffer.from(JSON.stringify({ ...json,
        ...(kind === "url-only" ? { data: [{ url: "https://not-fetched.invalid/private" }] } : {}), ...(kind === "many" ? { data: [json.data![0], json.data![0]] } : {}),
        ...(kind === "base64" ? { data: [{ b64_json: "abcd!" }] } : {}), ...(kind === "magic" ? { data: [{ b64_json: Buffer.from("not-image").toString("base64") }] } : {}),
        ...(kind === "format" ? { output_format: "webp" } : {}), ...(kind === "usage" ? { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 99 } } : {}) })) } : {}) };
    const result = parse(r); expect(result.candidate).toBeUndefined(); expect(result.record.outcome.billing).toEqual({ state: "unknown" });
    expect(result.record.bodyChecksumSha256).toBe(sha(r.body)); expect(f.store.load()).toEqual(before);
    expect(JSON.stringify(result.record)).not.toContain("https://not-fetched.invalid");
  });
  it.each(["BLOCKED", "incomplete", "url", "many-images", "usage"])("Google%s不选择替代输出或计费", async kind => {
    const { parse, response, json } = await evidence({ protocol: "google" }); const j: any = structuredClone(json);
    if (kind === "BLOCKED") j.promptFeedback = { blockReason: "SAFETY" };
    if (kind === "incomplete") j.candidates[0].finishReason = "MAX_TOKENS";
    if (kind === "url") j.candidates[0].content.parts = [{ fileData: { fileUri: "https://not-fetched.invalid/private" } }];
    if (kind === "many-images") j.candidates[0].content.parts.push(j.candidates[0].content.parts[0]);
    if (kind === "usage") j.usageMetadata = { promptTokenCount: -1 };
    const result = parse({ ...response, body: Buffer.from(JSON.stringify(j)) }); expect(result.candidate).toBeUndefined(); expect(result.record.outcome.billing.state).toBe("unknown");
  });
  it.each(["production-timeout", "production-transport-error", "production-response-invalid", "production-response-save-failed"] as const)("固定未知失败%s不透传异常/补费用", async code => {
    const { e, f } = await evidence(), before = f.store.load(); expect(productionImageUnknownOutcome(e, code)).toMatchObject({ failureCode: code, billing: { state: "unknown" }, usage: { source: "unavailable" } });
    expect(() => productionImageUnknownOutcome(e, "private-error-token" as any)).toThrow(); expect(f.store.load()).toEqual(before);
  });
  it.each(["outcome", "protocol", "attempt", "intent", "execution", "body", "time"])("原包恢复%s损坏及部分重算仍拒绝", async kind => {
    const { e, lease, intent, attempt, parse, response } = await evidence(), record = parse().record;
    const changed = { ...record, ...(kind === "outcome" ? { outcome: { ...record.outcome, providerRequestId: "forged" } } : {}), ...(kind === "protocol" ? { protocol: "google" } : {}),
      ...(kind === "attempt" ? { attemptFingerprint: "f".repeat(64) } : {}), ...(kind === "intent" ? { intentFingerprint: "f".repeat(64) } : {}),
      ...(kind === "execution" ? { executionFingerprint: "f".repeat(64) } : {}), ...(kind === "body" ? { bodyChecksumSha256: "f".repeat(64) } : {}),
      ...(kind === "time" ? { receivedAt: new Date(Date.parse(at) - 1).toISOString() } : {}) };
    expect(() => assertProductionImageRawResponse(changed, e, lease, intent, attempt, response.body)).toThrow();
  });
  it("一致原包恢复候选的独立副本，无持久化任务/产物授权", async () => {
    const { e, lease, intent, attempt, parse, response, image, f } = await evidence(), record = parse().record, before = f.store.load();
    const restored = assertProductionImageRawResponse(record, e, lease, intent, attempt, response.body); expect(restored.candidate!.body).toEqual(image);
    restored.candidate!.body.fill(0); expect(image).toEqual(png); expect(f.store.load()).toEqual(before);
  });
});

// 6D6A uses real confirmed/leased/started SQLite history, but its attempt is the
// original PURE fixture above. Full decode does not make that fixture an actual
// task response or grant an asset commit. 6D6B must obtain actual task evidence.
const fullImage = (format: "png" | "jpeg" = "png", width = 1024, height = 1024, alpha = 1) =>
  sharp({ create: { width, height, channels: 4, background: { r: 20, g: 40, b: 60, alpha } } })[format]().toBuffer();
async function outputEvidence(options: Parameters<typeof evidence>[0] = {}) {
  const t = await evidence(options), image = await fullImage(options.protocol === "google" ? "jpeg" : "png");
  const packet = (bytes = image, contentType = options.protocol === "google" ? "image/jpeg" : "image/png") => ({ ...t.response, body: Buffer.from(JSON.stringify(options.protocol === "google"
    ? { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ inlineData: { mimeType: contentType, data: bytes.toString("base64") } }] } }] }
    : { created: 1, data: [{ b64_json: bytes.toString("base64") }] })) });
  const response = packet(), record = t.parse(response).record;
  const validate = (r = record, body = response.body, time = at) => validateProductionImageOutput(t.e, t.lease, t.intent, t.attempt, r, body, time);
  return { ...t, image, response, record, validate, packet };
}
describe("6D6A 完整生产图片校验，仅decoded-uncommitted而非资产授权", () => {
  describe.each((["openai", "openai-compatible", "google"] as const).flatMap(protocol => [true, false].flatMap(manual => [true, false].map(edit => [protocol, manual, edit] as const))))(
    "%s manual=%s edit=%s", (protocol, manual, edit) => {
    let t: Awaited<ReturnType<typeof outputEvidence>>;
    beforeEach(async () => { t = await outputEvidence({ protocol, manual, edit }); });
    it("完整解码原字节并保留独立未知金额，不写任务/原包/资产/预算", async () => {
      const before = t.f.store.load(), catalog = t.f.store.loadCatalog(), reads = t.pricePort.read.mock.calls.length, verifies = t.pricePort.verify.mock.calls.length;
      const result = await t.validate();
      expect(result.body).toEqual(t.image); expect(result.body).not.toBe(t.image);
      expect(result.draft).toMatchObject({ mode: "production-contract-fixture", validation: "decoded-uncommitted", artifactCommitted: false,
        executionAuthorized: false, realExecutionEnabled: false, protectionApplied: "none", image: { width: 1024, height: 1024, checksumSha256: sha(t.image) },
        money: { maxCostMinor: 40, estimate: manual ? { state: "unknown" } : { state: "known", estimatedCostMinor: 25 }, billing: "unknown" } });
      expect(result.draftFingerprint).toBe(fp(result.draft)); expect(result.draft.responseFingerprint).toBe(fp(t.record));
      expect(result.draft.transformedInputsFingerprint).toBe(fp(t.e.protocol.transformedInputs));
      expect(t.f.store.load()).toEqual(before); expect(t.f.store.loadCatalog()).toEqual(catalog);
      expect(t.pricePort.read).toHaveBeenCalledTimes(reads); expect(t.pricePort.verify).toHaveBeenCalledTimes(verifies);
      for (const secret of ["原人工指令", t.e.preparation.connection.baseUrl, t.e.preparation.connection.credentialRef, t.image.toString("base64"), t.e.protocol.request.idempotencyKey])
        expect(JSON.stringify(result.draft)).not.toContain(secret);
      expect(result.draft).not.toHaveProperty("assetId"); expect(result.draft).not.toHaveProperty("receipt");
      result.body.fill(0); expect(t.image.some(byte => byte !== 0)).toBe(true);
    });
  });
  it.each(["tiny", "magic-only", "truncated", "mime", "oversize-pixels", "wrong-size", "absent", "raw-sha", "outcome", "time"])("%s拒绝，不凭pending候选声明已入库", async variant => {
    const t = await outputEvidence(), before = t.f.store.load(); let response = t.response;
    if (variant === "tiny") response = t.packet(png);
    if (variant === "magic-only") response = t.packet(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (variant === "truncated") response = t.packet(t.image.subarray(0, t.image.length - 30));
    if (variant === "mime") response = t.packet(await fullImage("jpeg"));
    if (variant === "oversize-pixels") response = t.packet(await fullImage("png", 4096, 4096));
    if (variant === "wrong-size") response = t.packet(await fullImage("png", 1024, 512));
    if (variant === "absent") response = { ...response, body: Buffer.from('{"data":[{"url":"https://not-fetched.invalid/"}]}') };
    const record: any = t.parse(response).record;
    if (variant === "raw-sha") record.bodyChecksumSha256 = "f".repeat(64);
    if (variant === "outcome") record.outcome.providerRequestId = "forged";
    await expect(t.validate(record, response.body, variant === "time" ? new Date(Date.parse(at) - 1).toISOString() : at)).rejects.toThrow();
    expect(t.f.store.load()).toEqual(before); expect(response.body.some(byte => byte !== 0)).toBe(true);
  });
  it.each(["opaque", "transparent"] as const)("冻结%s背景按真实像素alpha检查，不靠通道声明", async background => {
    const t = await outputEvidence({ background }), bad = t.packet(await fullImage("png", 1024, 1024, background === "opaque" ? 0.5 : 1));
    await expect(t.validate(t.parse(bad).record, bad.body)).rejects.toThrow(/完整校验/);
    const good = t.packet(await fullImage("png", 1024, 1024, background === "opaque" ? 1 : 0.5)), result = await t.validate(t.parse(good).record, good.body);
    expect(result.draft.image.hasTransparency).toBe(background === "transparent"); result.body.fill(0);
  });
  it.each(["mode", "lease", "attempt", "intent", "confirmation", "interrupted"])("纯历史%s不能部分重算绕过", async variant => {
    const t = await outputEvidence();
    await expect(validateProductionImageOutput(variant === "confirmation" ? { ...t.e, batchId: "local-batch" } : t.e,
      variant === "lease" ? { ...t.lease, actorId: "other" } : t.lease, variant === "intent" ? { ...t.intent, payloadByteSize: t.intent.payloadByteSize + 1 } : t.intent,
      variant === "attempt" ? { ...t.attempt, actorId: "other" } : t.attempt,
      variant === "mode" ? { ...t.record, mode: "production" } : variant === "interrupted" ? { ...t.record, kind: "interrupted" } : t.record, t.response.body, at)).rejects.toThrow();
  });
  it("迟到校验只保留原尝试关系，不查询当前价格或开启执行", async () => {
    const t = await outputEvidence(); t.f.advance(120_000); t.pricePort.verify.mockReturnValue(false); const before = t.f.store.load(), verifies = t.pricePort.verify.mock.calls.length;
    const result = await t.validate(t.record, t.response.body, new Date(t.f.clock()).toISOString()); expect(result.draft.money.billing).toBe("unknown");
    expect(t.pricePort.verify).toHaveBeenCalledTimes(verifies); expect(t.f.store.load()).toEqual(before); result.body.fill(0);
  });
  it("首await前冻结原包和完整证据，调用者改动不改变原字节；失败清零自有候选", async () => {
    const t = await outputEvidence(); let done!: (value: Awaited<ReturnType<typeof decoderApi.decodeStaticImage>>) => void;
    const decode = vi.spyOn(decoderApi, "decodeStaticImage").mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const originalRecord = structuredClone(t.record), raw = Buffer.from(t.response.body), pending = t.validate(originalRecord, raw);
    raw.fill(0); originalRecord.outcome.providerRequestId = "changed";
    done({ width: 512, height: 1024, hasAlpha: false, hasTransparency: false }); await expect(pending).rejects.toThrow();
    expect(decode.mock.calls[0][0].every(byte => byte === 0)).toBe(true); expect(t.response.body.some(byte => byte !== 0)).toBe(true);
  });
  it("两份异步校验占槽，不创建无限解码队列", async () => {
    const t = await outputEvidence(); const pendingDecodes: ((value: Awaited<ReturnType<typeof decoderApi.decodeStaticImage>>) => void)[] = [];
    vi.spyOn(decoderApi, "decodeStaticImage").mockImplementation(() => new Promise(resolve => pendingDecodes.push(resolve)));
    const a = t.validate(), b = t.validate(); await expect(t.validate()).rejects.toMatchObject({ status: 429 });
    for (const done of pendingDecodes) done({ width: 1024, height: 1024, hasAlpha: false, hasTransparency: false });
    for (const result of await Promise.all([a, b])) result.body.fill(0);
  });
  it("严格草稿不可混入资产/费用/执行授权字段，manual未知不补0或上限", async () => {
    const t = await outputEvidence(), result = await t.validate(), d = result.draft;
    for (const changed of [{ ...d, artifactCommitted: true }, { ...d, executionAuthorized: true }, { ...d, assetId: "fake" }, { ...d, receipt: {} },
      { ...d, image: { ...d.image, width: 4096, height: 4096 } }, { ...d, money: { ...d.money, billing: "known" } },
      { ...d, money: { ...d.money, estimate: { state: "unknown", estimatedCostMinor: 0 } } }]) expect(ProductionImageOutputDraftSchema.safeParse(changed).success).toBe(false);
    expect(d.money.estimate).toEqual({ state: "unknown" }); result.body.fill(0);
  });
});

describe("6D4A 默认关闭有界生产原包存储（尚未绑定实际任务尝试）", () => {
  it("默认关闭且要求外层同步事务，不写任务账本预算", async () => {
    const { f, store, parse, response } = await evidence(), record = parse().record, before = f.store.load();
    expect(() => f.store.loadProductionImageResponse(principal.tenantId, "project-a", record.mode, record.outcome.jobId)).toThrow();
    expect(() => f.store.transaction(() => f.store.saveProductionImageResponse(record, response.body))).toThrow();
    expect(() => store.saveProductionImageResponse(record, response.body)).toThrow(); expect(f.store.load()).toEqual(before);
    expect(store.productionImageResponseBytes(principal.tenantId, "project-a")).toBe(0);
  });
  it("完整原包/标记原子保存，同编号重放跨连接/重启不覆盖或重复计容量", async () => {
    const { f, store, parse, response } = await evidence(), record = parse().record, before = f.store.load(), catalog = f.store.loadCatalog();
    store.transaction(() => store.saveProductionImageResponse(record, response.body)); const bytes = store.imageMetadataBytes(principal.tenantId, "project-a");
    const other = rawStore(f.path); other.transaction(() => other.saveProductionImageResponse(record, response.body));
    expect(other.imageMetadataBytes(principal.tenantId, "project-a")).toBe(bytes); expect(other.productionImageResponseBytes(principal.tenantId, "project-a")).toBe(response.body.length);
    const read = other.loadProductionImageResponse(principal.tenantId, "project-a", record.mode, record.outcome.jobId)!; expect(read.record).toEqual(record); expect(read.body).toEqual(response.body);
    read.body.fill(0); other.close(); const reopened = rawStore(f.path); expect(reopened.loadProductionImageResponse(principal.tenantId, "project-a", record.mode, record.outcome.jobId)!.body).toEqual(response.body);
    expect(f.store.load()).toEqual(before); expect(f.store.loadCatalog()).toEqual(catalog);
  });
  it.each(["id", "status", "outcome", "body"])("一致任务历史%s冲突不可覆盖", async kind => {
    const { store, parse, response } = await evidence(), record = parse().record; store.transaction(() => store.saveProductionImageResponse(record, response.body));
    const body = kind === "body" ? Buffer.from("another") : response.body;
    const changed = { ...record, ...(kind === "id" ? { id: `production-image-response:${randomUUID()}` } : {}), ...(kind === "status" ? { status: 500 } : {}),
      ...(kind === "outcome" ? { outcome: { ...record.outcome, failureCode: "forged" } } : {}), ...(kind === "body" ? { bodyByteSize: body.length, bodyChecksumSha256: sha(body) } : {}) };
    expect(() => store.transaction(() => store.saveProductionImageResponse(changed, body))).toThrow();
    expect(store.loadProductionImageResponse(principal.tenantId, "project-a", record.mode, record.outcome.jobId)!.body).toEqual(response.body);
  });
  it("外层写后故障整体回滚原包与标记，不改账本预留", async () => {
    const { store, f, parse, response } = await evidence(), record = parse().record, before = f.store.load();
    expect(() => store.transaction(() => { store.saveProductionImageResponse(record, response.body); throw new Error("owned-failure"); })).toThrow();
    expect(store.loadProductionImageResponse(principal.tenantId, "project-a", record.mode, record.outcome.jobId)).toBeNull(); expect(f.store.load()).toEqual(before);
  });
  it("第二表插入失败即使外层捕获也回滚新正文，无孤立记录", async () => {
    const { store, f, parse, response } = await evidence(), record = parse().record;
    withDb(f.path, db => db.exec("CREATE TRIGGER owned_fail_presence BEFORE INSERT ON production_image_response_presence BEGIN SELECT RAISE(ABORT, 'owned-fault'); END"));
    store.transaction(() => { expect(() => store.saveProductionImageResponse(record, response.body)).toThrow(); });
    expect(withDb(f.path, db => db.prepare("SELECT COUNT(*) AS n FROM production_image_responses").get()!.n)).toBe(0);
    expect(store.loadProductionImageResponse(principal.tenantId, "project-a", record.mode, record.outcome.jobId)).toBeNull();
  });
  it("租户项目/模式精确隔离，raw行本身不宣称当前读取许可", async () => {
    const { store, parse, response } = await evidence(), record = parse().record; store.transaction(() => store.saveProductionImageResponse(record, response.body));
    for (const [tenant, project, mode] of [["tenant-b", "project-a", record.mode], [principal.tenantId, "project-b", record.mode], [principal.tenantId, "project-a", "production"]])
      expect(store.loadProductionImageResponse(tenant, project, mode as any, record.outcome.jobId)).toBeNull();
    expect(() => store.loadProductionImageResponse(principal.tenantId, "project-a", "local-fixture" as any, record.outcome.jobId)).toThrow();
  });
  it.each(["binary", "metadata", "fraction", "raise-cap", "mismatch-size", "mismatch-sha", "non-buffer"])("容量/字节%s拒绝且不删除历史", async kind => {
    const { store, f, parse, response } = await evidence(), record = parse().record, before = f.store.load(); f.source("capacity-source");
    const base = store.imageMetadataBytes(principal.tenantId, "project-a") + imageTaskMetadataBytes(store.load(), principal.tenantId, "project-a");
    const limits = kind === "binary" ? { maxProjectBytes: response.body.length + png.length - 1 } : kind === "metadata" ? { maxMetadataBytes: base + Buffer.byteLength(JSON.stringify(record)) - 1 }
      : kind === "fraction" ? { maxMetadataBytes: 1.5 } : kind === "raise-cap" ? { maxProjectBytes: 512 * 1024 * 1024 + 1 } : {};
    const changed = { ...record, ...(kind === "mismatch-size" ? { bodyByteSize: response.body.length + 1 } : {}), ...(kind === "mismatch-sha" ? { bodyChecksumSha256: "f".repeat(64) } : {}) };
    expect(() => store.transaction(() => store.saveProductionImageResponse(changed, kind === "non-buffer" ? new Uint8Array(response.body) as any : response.body, limits))).toThrow();
    expect(store.productionImageResponseBytes(principal.tenantId, "project-a")).toBe(0); expect(f.store.load()).toEqual(before);
    expect(f.store.loadVerifiedImageBytes(principal.tenantId, "project-a", "capacity-source")!.body).toEqual(png);
  });
  it("原图/本地原包/生成图共用统计包含生产原包，元数据包含实际任务", async () => {
    const { store, f, parse, response } = await evidence(), record = parse().record; f.source("capacity-source");
    const before = store.localImageBinaryBytes(principal.tenantId, "project-a"), meta = store.imageMetadataBytes(principal.tenantId, "project-a");
    store.transaction(() => store.saveProductionImageResponse(record, response.body));
    expect(store.localImageBinaryBytes(principal.tenantId, "project-a")).toBe(before + response.body.length);
    expect(store.imageMetadataBytes(principal.tenantId, "project-a")).toBe(meta + Buffer.byteLength(JSON.stringify(record)));
  });
  it.each(["marker-missing", "row-missing", "marker-id", "marker-sha", "body", "record-sha", "body-sha-rewritten", "foreign-project", "huge-record", "huge-body"])("损坏%s只读失败关闭，不重建或覆盖", async kind => {
    const { store, f, parse, response } = await evidence(), record = parse().record; store.transaction(() => store.saveProductionImageResponse(record, response.body));
    withDb(f.path, db => {
      if (kind === "marker-missing") db.exec("DELETE FROM production_image_response_presence");
      if (kind === "row-missing") db.exec("DELETE FROM production_image_responses");
      if (kind === "marker-id") db.prepare("UPDATE production_image_response_presence SET response_id=?").run(`production-image-response:${randomUUID()}`);
      if (kind === "marker-sha") db.prepare("UPDATE production_image_response_presence SET record_sha256=?").run("f".repeat(64));
      if (kind === "body") db.prepare("UPDATE production_image_responses SET body=?").run(Buffer.from("bad"));
      if (kind === "record-sha") db.prepare("UPDATE production_image_responses SET record_sha256=?").run("f".repeat(64));
      if (kind === "body-sha-rewritten" || kind === "foreign-project") {
        const changed = { ...record, ...(kind === "body-sha-rewritten" ? { bodyChecksumSha256: "f".repeat(64) } : { outcome: { ...record.outcome, projectId: "project-b" } }) }, text = JSON.stringify(changed), hash = sha(Buffer.from(text));
        db.prepare("UPDATE production_image_responses SET record=?, record_sha256=?").run(text, hash); db.prepare("UPDATE production_image_response_presence SET record_sha256=?").run(hash);
      }
      if (kind === "huge-record") db.prepare("UPDATE production_image_responses SET record=?").run("x".repeat(512 * 1024 + 1));
      if (kind === "huge-body") db.exec("UPDATE production_image_responses SET body=zeroblob(33554433)");
    });
    const before = f.store.load(); expect(() => store.loadProductionImageResponse(principal.tenantId, "project-a", record.mode, record.outcome.jobId)).toThrow(); expect(f.store.load()).toEqual(before);
  });
  it.each(["legacy-job", "legacy-attempt", "custom", "known-cost", "extra-asset", "oversize"])("独立原包shape%s不能混旧或声明入库/结算", async kind => {
    const { parse } = await evidence(), record = parse().record;
    const changed = { ...record, ...(kind === "legacy-attempt" ? { attemptId: "image-attempt-local" } : {}), ...(kind === "custom" ? { protocol: "custom" } : {}),
      ...(kind === "legacy-job" ? { outcome: { ...record.outcome, jobId: "image-local-job" } } : {}), ...(kind === "known-cost" ? { outcome: { ...record.outcome, billing: { state: "known", actualCostMinor: 0, currency: "CNY" } } } : {}),
      ...(kind === "extra-asset" ? { outputAssetId: "fake-asset" } : {}), ...(kind === "oversize" ? { bodyByteSize: 32 * 1024 * 1024 + 1 } : {}) };
    expect(ProductionImageRawResponseSchema.safeParse(changed).success).toBe(false);
  });
  it("v6→v7仅追加表，保留用户记录/目录/预算/原图，v8不覆盖", async () => {
    const { f } = await evidence(); f.source("preserved-source"); const before = f.store.load(), catalog = f.store.loadCatalog();
    withDb(f.path, db => db.exec("DROP TABLE production_image_responses; DROP TABLE production_image_response_presence; CREATE TABLE owned_user_data(value TEXT); INSERT INTO owned_user_data VALUES('preserve'); PRAGMA user_version=6"));
    const upgraded = rawStore(f.path); expect(upgraded.load()).toEqual(before); expect(upgraded.loadCatalog()).toEqual(catalog);
    expect(upgraded.loadVerifiedImageBytes(principal.tenantId, "project-a", "preserved-source")!.body).toEqual(png);
    withDb(f.path, db => { expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(7); expect(db.prepare("SELECT value FROM owned_user_data").get()!.value).toBe("preserve"); db.exec("PRAGMA user_version=8"); });
    expect(() => new SqliteRunKernelStateStore(f.path)).toThrow(); expect(withDb(f.path, db => db.prepare("SELECT value FROM owned_user_data").get()!.value)).toBe("preserve");
  });
  it.each(["production_image_responses", "production_image_response_presence"])("v7缺失%s不假装空或重建", async table => {
    const { f } = await evidence(); withDb(f.path, db => db.exec(`DROP TABLE ${table}`));
    expect(() => new SqliteRunKernelStateStore(f.path)).toThrow();
    expect(withDb(f.path, db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))).toBeUndefined();
  });
});
