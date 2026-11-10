import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfirmProductionImagePreparationSchema, ImageExecutionRequestSchema, ProductionImageExecutionRequestSchema,
  type ProductionImagePreparationRecord, type ImageProviderConnection,
} from "../packages/contracts/src/index";
import { ImageProductionPreparationHarness, type ImagePriceContext } from "../apps/api/src/productionImagePreparations";
import { prepareProductionImageProtocol, validateProductionImageConfirmationExpectations } from "../apps/api/src/productionImageProtocol";
import {
  assertRealImageExecutionAllowed, imageSnapshotFingerprint, validateImageProviderInputs, validateImageProviderRequest,
  validateProductionImageProviderRequest,
} from "../apps/api/src/imageProviderContract";
import { prepareOpenAiImageRequest, prepareProductionOpenAiImageRequest } from "../apps/api/src/openaiImageProtocol";
import { prepareCompatibleImageRequest, prepareProductionCompatibleImageRequest } from "../apps/api/src/compatibleImageProtocol";
import { prepareGoogleImageRequest, prepareProductionGoogleImageRequest } from "../apps/api/src/googleImageProtocol";
import { imagePayloadSha256 } from "../apps/api/src/imageRequestPayload";
import { at, connection, principal, png, setupImageTask } from "./helpers/image-task-fixture";

const owned: ReturnType<typeof setupImageTask>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of owned.splice(0).reverse()) f.cleanup(); });
const identity = () => ({ jobId: `production-image-job-${randomUUID()}`, idempotencyKey: `production-image-execution-${randomUUID()}` });
function expected(p: ProductionImagePreparationRecord) {
  return { expectedSnapshotFingerprint: p.snapshotFingerprint, expectedPricingFingerprint: imageSnapshotFingerprint(p.pricing),
    expectedCurrency: p.pricing.quote.currency, expectedMaxCostMinor: p.pricing.quote.maxCostMinor,
    estimate: p.pricing.quote.source === "manual-budget" ? { state: "unknown" as const }
      : { state: "known" as const, expectedEstimatedCostMinor: p.pricing.quote.estimatedCostMinor } };
}
function fixture(protocol: "openai" | "openai-compatible" | "google" = "openai", manual = false, edit = false,
  encoding: "json-images" | "multipart-image-single" | "multipart-image-array" = "json-images") {
  const f = setupImageTask({ format: protocol === "google" ? "jpeg" : "png" }); owned.push(f);
  const base = connection(), model = base.models[0];
  const config = connection({ protocol,
    ...(protocol === "openai-compatible" ? { compatibility: { version: "owned-compat", editEncoding: encoding, responseEncoding: "images-b64-json-v1",
      auth: { scheme: "header", headerName: "x-api-key" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}),
    ...(protocol === "google" ? { baseUrl: "https://generativelanguage.googleapis.com", models: [{ ...model, maxInputImages: 14, outputFormats: ["jpeg"] }],
      googleNative: { version: "owned-google", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1", modelMappings: [{ model: model.model,
        sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] } } : {}),
  });
  f.register(config); if (edit) { f.source("source"); f.source("second"); }
  const authorizer = { authenticate: () => principal, allows: () => true };
  const pricePort = { kind: "contract-fixture" as const, realExecutionEnabled: false as const,
    read: vi.fn((c: ImagePriceContext) => ({ schemaVersion: 1, scope: c.scope,
      quote: { id: "owned-price", version: "owned-v1", source: manual ? "manual-budget" : "server-price-table", currency: "CNY", maxCostMinor: 40,
        ...(manual ? {} : { estimatedCostMinor: 25 }), expiresAt: new Date(f.clock() + 60_000).toISOString() },
      evidence: { kind: "contract-fixture", realExecutionEnabled: false, sourceRevision: "owned-table", evidenceRef: "no-real-price",
        checkedBy: "owned-oracle", checkedAt: c.requestedAt } })), verify: vi.fn(() => true) };
  const service = new ImageProductionPreparationHarness({ preparationEnabled: true, tenantId: principal.tenantId, stateStore: f.store,
    authorizer, runAuthorizer: authorizer, assetAuthorizer: authorizer, clock: f.clock, pricePort });
  const result = service.createPreparation(principal, { projectId: "project-a", idempotencyKey: "owned-action", connectionId: config.id, connectionRevision: 1,
    model: model.model, capabilityVersion: model.version, constraintSnapshotId: "constraint-a", protection: "none", operation: edit ? "edit" : "generate",
    inputAssetIds: edit ? ["source", "second"] : [], parameters: { prompt: "原完整人工指令", n: 1, size: { width: 1024, height: 1024 }, quality: "auto",
      background: "auto", outputFormat: protocol === "google" ? "jpeg" : "png" } });
  const record = f.store.loadProductionImagePreparation(principal.tenantId, "project-a", "production-contract-fixture", result.id)!;
  const images = edit ? ["source", "second"].map((id) => ({ receipt: f.store.loadVerifiedImage(principal.tenantId, "project-a", id)!, body: Buffer.from(png) })) : [];
  return { ...f, record, images, pricePort, config, service };
}
const request = (p: ProductionImagePreparationRecord) => ProductionImageExecutionRequestSchema.parse({ ...p.requestDraft, ...identity(), quote: p.pricing.quote });
function reseal(p: ProductionImagePreparationRecord) {
  p.selectionFingerprint = imageSnapshotFingerprint(p.selection);
  p.basisFingerprint = imageSnapshotFingerprint({ connection: p.connection, selection: p.selection, requestDraft: p.requestDraft, constraint: p.constraint });
  p.pricing.scope.selectionFingerprint = p.selectionFingerprint; p.pricing.scope.basisFingerprint = p.basisFingerprint;
  const { snapshotFingerprint: _old, ...rest } = p; p.snapshotFingerprint = imageSnapshotFingerprint(rest);
}

describe("6D2A production pure protocol / explicit unknown estimate", () => {
  it.each(["openai", "openai-compatible", "google"] as const)("%s 手动上限无估价、零补值或任务写入", async (protocol) => {
    const f = fixture(protocol, true), state = f.store.load(), bytes = f.store.imageMetadataBytes(principal.tenantId, "project-a");
    const result = await prepareProductionImageProtocol(f.record, expected(f.record), identity(), [], at);
    expect(result.snapshot).toMatchObject({ mode: "production-contract-fixture", confirmationState: "unconfirmed", protocolPreparation: "prepared",
      realExecutionEnabled: false, executionAuthorized: false, request: { quote: { source: "manual-budget", maxCostMinor: 40 } } });
    expect(result.snapshot.request.quote).not.toHaveProperty("estimatedCostMinor");
    expect(result.wire.body.toString()).not.toMatch(/quote|estimatedCostMinor|maxCostMinor|owned-price|no-real-price|idempotencyKey/);
    expect(result.snapshot.payloadChecksumSha256).toBe(imagePayloadSha256(result.wire.body));
    expect(result.snapshot.payloadByteSize).toBe(result.wire.body.byteLength);
    const { snapshotFingerprint, ...rest } = result.snapshot; expect(snapshotFingerprint).toBe(imageSnapshotFingerprint(rest));
    expect(f.store.load()).toEqual(state); expect(f.store.imageMetadataBytes(principal.tenantId, "project-a")).toBe(bytes);
    expect(f.store.loadProductionImagePreparation(principal.tenantId, "project-a", f.record.mode, f.record.id)).toEqual(f.record);
    expect(f.pricePort.read).toHaveBeenCalledTimes(1); expect(f.pricePort.verify).toHaveBeenCalledTimes(1);
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s 明确估价也不进入旧确认/账本，实际wire不含计费", async (protocol) => {
    const f = fixture(protocol), before = f.store.load(), result = await prepareProductionImageProtocol(f.record, expected(f.record), identity(), [], at);
    expect(result.snapshot.request.quote).toMatchObject({ source: "server-price-table", estimatedCostMinor: 25, maxCostMinor: 40 });
    expect(result.wire.body.toString()).not.toMatch(/estimatedCostMinor|quote|currency/); expect(f.store.load()).toEqual(before);
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s 原图顺序/完整归一化摘要，不用代理或原路径", async (protocol) => {
    const f = fixture(protocol, true, true), originals = f.images.map((i) => Buffer.from(i.body));
    const result = await prepareProductionImageProtocol(f.record, expected(f.record), identity(), f.images, at);
    expect(result.snapshot.transformedInputs.map((t) => t.assetId)).toEqual(["source", "second"]);
    expect(result.snapshot.transformedInputs.every((t) => t.originalChecksumSha256 === imagePayloadSha256(png) && t.transform === "exif-srgb-png-v1")).toBe(true);
    expect(result.wire.body.toString()).not.toMatch(/local-verified|source.png|second.png|constraint-a/);
    expect(f.images.map((i) => i.body)).toEqual(originals);
  });
  it.each(["multipart-image-array", "multipart-image-single"] as const)("中转%s冻结实际boundary和Content-Type而非伪JSON摘要", async (encoding) => {
    const f = fixture("openai-compatible", true, true, encoding), p = f.record;
    if (encoding === "multipart-image-single") {
      p.selection.inputAssetIds = ["source"]; if (p.requestDraft.operation === "edit") p.requestDraft.inputs = p.requestDraft.inputs.slice(0, 1); reseal(p);
    }
    const id = identity(), first = await prepareProductionImageProtocol(p, expected(p), id, f.images, at);
    const repeated = await prepareProductionImageProtocol(p, expected(p), id, f.images, at);
    expect(first.wire).toEqual(repeated.wire); expect(first.snapshot).toEqual(repeated.snapshot);
    expect(first.wire.contentType).toBe(`multipart/form-data; boundary=canvas-${first.snapshot.requestFingerprint.slice(0, 40)}`);
    expect(first.wire.body.toString()).toContain(encoding === "multipart-image-single" ? 'name="image"' : 'name="image[]"');
    expect(first.wire.body.toString()).not.toMatch(/estimatedCostMinor|quote|local-verified/);
    expect((await prepareProductionImageProtocol(p, expected(p), identity(), f.images, at)).snapshot.requestFingerprint).not.toBe(first.snapshot.requestFingerprint);
  });
  it.each([0, 25, 40, null, undefined])("生产manual-budget禁止携带伪估价 %s", (value) => {
    const f = fixture("openai", true), r = request(f.record);
    expect(ProductionImageExecutionRequestSchema.safeParse({ ...r, quote: { ...r.quote, estimatedCostMinor: value } }).success).toBe(false);
  });
  it("未知估价的确认表达独立，旧确认金额字段不静默兼容", () => {
    const f = fixture("openai", true), e = expected(f.record);
    expect(ConfirmProductionImagePreparationSchema.parse(e).estimate).toEqual({ state: "unknown" });
    for (const bad of [{ ...e, expectedEstimatedCostMinor: 0 }, { ...e, estimate: { state: "unknown", expectedEstimatedCostMinor: 40 } },
      { ...e, estimate: { state: "known" } }, { ...e, estimate: { state: "unknown", confirmed: true } }, { ...e, executionAuthorized: true }]) expect(ConfirmProductionImagePreparationSchema.safeParse(bad).success).toBe(false);
  });
  it.each(["expectedSnapshotFingerprint", "expectedPricingFingerprint", "expectedCurrency", "expectedMaxCostMinor", "estimate"])("人工冻结期待%s不一致拒绝", async (key) => {
    const f = fixture("openai", true), e = expected(f.record);
    const changed = { ...e, [key]: key.endsWith("Fingerprint") ? "0".repeat(64) : key === "estimate" ? { state: "known", expectedEstimatedCostMinor: 40 } : key === "expectedCurrency" ? "USD" : 41 };
    await expect(prepareProductionImageProtocol(f.record, changed, identity(), [], at)).rejects.toThrow("production_image_confirmation_changed");
  });
  it.each(["unknown", "wrong-known"])("可信估价不能变成%s", (kind) => {
    const f = fixture(), e = expected(f.record);
    expect(() => validateProductionImageConfirmationExpectations(f.record, { ...e, estimate: kind === "unknown" ? { state: "unknown" } : { state: "known", expectedEstimatedCostMinor: 40 } })).toThrow("production_image_confirmation_changed");
  });
  it.each(["snapshot", "selection", "basis", "constraint", "parameter", "source", "mode"])("原准备%s损坏或错配不构造wire", async (kind) => {
    const f = fixture(), p = structuredClone(f.record);
    if (kind === "snapshot") p.snapshotFingerprint = "0".repeat(64);
    if (kind === "selection") p.selectionFingerprint = "0".repeat(64);
    if (kind === "basis") p.basisFingerprint = "0".repeat(64);
    if (kind === "constraint") p.constraint.brandRules.changed = "tampered";
    if (kind === "parameter") p.requestDraft.parameters.prompt = "current form not original";
    if (kind === "source") p.pricing.quote.version = "changed";
    if (kind === "mode") (p as any).mode = "production";
    await expect(prepareProductionImageProtocol(p, expected(p), identity(), [], at)).rejects.toThrow();
  });
  it.each(["2026-10-03T17:59:59Z", "2026-10-03T18:01:00Z", "invalid"])("构造时间%s无效/倒退/到期拒绝", async (now) => {
    const f = fixture(); await expect(prepareProductionImageProtocol(f.record, expected(f.record), identity(), [], now)).rejects.toThrow("production_image_price_expired");
  });
  it.each([{ jobId: "old-job", idempotencyKey: "old-attempt" }, { jobId: "production-static-validation-only", idempotencyKey: "not-an-execution" },
    { ...identity(), idempotencyKey: "owned-action" }, { ...identity(), executionAuthorized: true }])("生产候选身份不复用旧命名空间或附加授权 %s", async (id) => {
    const f = fixture(); await expect(prepareProductionImageProtocol(f.record, expected(f.record), id, [], at)).rejects.toThrow("production_image_identity_namespace_invalid");
  });
  it.each(["missing", "bytes", "receipt", "duplicate", "foreign"])("原图%s拒绝，不污染账本或调用者原文件", async (kind) => {
    const f = fixture("openai", true, true), before = f.store.load(), images = structuredClone(f.images).map((i) => ({ ...i, body: Buffer.from(i.body) }));
    if (kind === "missing") images.pop(); if (kind === "bytes") images[0].body = Buffer.from("changed");
    if (kind === "receipt") images[0].receipt.asset.width = 2; if (kind === "duplicate") images.push(images[0]);
    if (kind === "foreign") images[0].receipt.asset.projectId = "foreign";
    const copies = images.map((i) => Buffer.from(i.body));
    await expect(prepareProductionImageProtocol(f.record, expected(f.record), identity(), images, at)).rejects.toThrow();
    expect(images.map((i) => i.body)).toEqual(copies); expect(f.store.load()).toEqual(before);
  });
  it("在首await之前冻结输入，外部修改不改变已准备负载", async () => {
    const f = fixture("openai", true, true), p = structuredClone(f.record), e = expected(p), images = f.images;
    const pending = prepareProductionImageProtocol(p, e, identity(), images, at);
    p.requestDraft.parameters.prompt = "changed"; images[1].body.fill(0); images[1].receipt.asset.width = 4;
    const result = await pending;
    expect(JSON.parse(result.wire.body.toString()).prompt).toBe("原完整人工指令");
    expect(result.snapshot.transformedInputs[1].originalChecksumSha256).toBe(imagePayloadSha256(png));
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s 生产未知估价不能进入旧协议入口/旧输入合同", async (protocol) => {
    const f = fixture(protocol, true), r = request(f.record);
    expect(ImageExecutionRequestSchema.safeParse(r).success).toBe(false);
    expect(() => validateImageProviderRequest(f.config, r, at)).toThrow(); expect(() => validateImageProviderInputs(r as any, [])).toThrow();
    const old = protocol === "openai" ? prepareOpenAiImageRequest : protocol === "google" ? prepareGoogleImageRequest : prepareCompatibleImageRequest;
    await expect(old(f.config, r as any, [], at)).rejects.toThrow();
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s 新纯入口拒绝auto/4096平方/硬像素且不降级", async (protocol) => {
    const f = fixture(protocol, true), r = request(f.record);
    const builder = protocol === "openai" ? prepareProductionOpenAiImageRequest : protocol === "google" ? prepareProductionGoogleImageRequest : prepareProductionCompatibleImageRequest;
    for (const size of ["auto", { width: 4096, height: 4096 }, { width: 8193, height: 1 }]) await expect(builder(f.config, { ...r, parameters: { ...r.parameters, size } } as any, [], at)).rejects.toThrow();
    expect(() => validateProductionImageProviderRequest(f.config, { ...r, protection: "pixel-exact" }, at)).toThrow("image_pixel_protection_not_configured");
  });
  it("支持声明不是模型默认选择、真实价格核验或发送授权", async () => {
    const f = fixture("openai-compatible", true), result = await prepareProductionImageProtocol(f.record, expected(f.record), identity(), [], at);
    expect(result.wire).toHaveProperty("authPlan.credentialRef", f.config.credentialRef);
    expect(result.snapshot).not.toHaveProperty("confirmedBy"); expect(result.snapshot).not.toHaveProperty("batchId");
    expect(() => assertRealImageExecutionAllowed()).toThrow("real_image_execution_disabled");
    expect(f.kernel.getBudget(principal, "project-a").reservedMinor).toBe(0); expect(f.kernel.listBatches(principal, "project-a")).toEqual([]);
  });
});
