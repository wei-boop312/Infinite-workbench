import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConstraintSnapshotSchema, GeneratedImageRecordSchema, ImageExecutionRequestSchema, ImageProviderConnectionSchema, ImageProviderOutcomeSchema, VerifiedImageSchema,
  type Asset, type ConstraintSnapshot, type ImageExecutionRequest, type VerifiedImage } from "../packages/contracts/src/index";
import { LocalGeneratedImages, constraintContentChecksum, type ImageOutputContext } from "../apps/api/src/generatedImages";
import { imageConfirmationFingerprint } from "../apps/api/src/imageProviderContract";
import { MAX_IMAGE_PROTOCOL_OUTPUT_BYTES, type ParsedImageProtocolResponse } from "../apps/api/src/imageProtocolResponse";
import { parseGoogleImageResponse } from "../apps/api/src/googleImageProtocol";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { LocalVerifiedAssets, assetMetadataFingerprint } from "../apps/api/src/verifiedAssets";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
let png: Buffer;
let jpeg: Buffer;
let webp: Buffer;
beforeAll(async () => {
  const image = sharp({ create: { width: 2, height: 3, channels: 4, background: "#ffaa00" } });
  [png, jpeg, webp] = await Promise.all([image.clone().png().toBuffer(), image.clone().jpeg().toBuffer(), image.clone().webp().toBuffer()]);
});
const checksum = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const at = "2026-10-03T15:00:00Z";
const actor = { tenantId: "tenant-a", actorId: "writer" };
const directories: string[] = [];
const stores: SqliteRunKernelStateStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function constraint(extra: Partial<ConstraintSnapshot> = {}) {
  return ConstraintSnapshotSchema.parse({ id: "constraints-a", projectId: "project-a", lockedPaths: [], editableRegions: [], brandRules: { style: "人工指定的构图" }, outputSpec: { width: 2, height: 3, format: "png" }, createdAt: at, ...extra });
}
function connection() {
  return ImageProviderConnectionSchema.parse({ schemaVersion: 1, id: "provider-fixture", tenantId: "tenant-a", projectId: "project-a", name: "本地零费用供应商夹具", protocol: "openai", revision: 1,
    adapterId: "image-fixture", baseUrl: "https://never-called.invalid", credentialRef: "never-resolved", enabled: true, diagnostic: { state: "not-run" }, models: [
      { model: "explicit-fixture-model", version: "caps-v1", operations: ["generate", "edit"], inputMimeTypes: ["image/png"], outputFormats: ["png", "jpeg", "webp"], maxInputImages: 2,
        maxPromptCharacters: 32000, maxInputEdge: 8192, maxInputPixels: 16000000, maxInputBytes: 30 * 1024 * 1024, maxTotalInputBytes: 100 * 1024 * 1024,
        sizes: { allowAuto: true, presets: [{ width: 2, height: 3 }, { width: 3, height: 2 }] }, qualities: ["auto"], backgrounds: ["auto", "opaque", "transparent"], inputFidelities: [], supportsOutputCompression: false,
        mask: { mode: "prompt-guidance", polarity: "transparent-edit" }, evidence: { state: "local-fixture-passed", evidenceRef: "fixture-only", checkedAt: at } },
    ] });
}
function request(snapshot = constraint(), extra: Partial<ImageExecutionRequest> = {}): ImageExecutionRequest {
  return ImageExecutionRequestSchema.parse({ schemaVersion: 1, tenantId: "tenant-a", projectId: "project-a", jobId: "job-a", idempotencyKey: "job-attempt-a", connectionId: "provider-fixture", connectionRevision: 1,
    adapterId: "image-fixture", model: "explicit-fixture-model", capabilityVersion: "caps-v1", constraintSnapshotId: snapshot.id, constraintChecksumSha256: constraintContentChecksum(snapshot), protection: "none",
    operation: "generate", inputs: [], parameters: { prompt: "人工确认的图片设计", n: 1, size: "auto", quality: "auto", background: "auto", outputFormat: snapshot.outputSpec.format },
    quote: { id: "quote-fixture", version: "budget-fixture-v1", source: "manual-budget", currency: "CNY", estimatedCostMinor: 25, maxCostMinor: 30, expiresAt: "2026-10-03T16:00:00Z" }, ...extra });
}
function setup(options: { path?: string; quota?: number; snapshot?: ConstraintSnapshot } = {}) {
  const directory = options.path ? undefined : mkdtempSync(join(tmpdir(), "canvas-generated-image-")); if (directory) directories.push(directory);
  const path = options.path ?? join(directory!, "state.sqlite");
  const store = new SqliteRunKernelStateStore(path); stores.push(store);
  const snapshot = options.snapshot ?? constraint();
  if (!store.loadCatalog()) store.transaction(() => store.saveCatalog({ schemaVersion: 1, projects: [{ projectId: "project-a", assets: [], constraints: [snapshot] }] }));
  let writeAllowed = true;
  let executionAllowed = true;
  const frozen = new Map<string, { fingerprint: string; payloadHash: string; binding: string }>();
  const authorizer = { authenticate: () => null, allows: (principal: typeof actor, project: string, permission: string) => principal.tenantId === actor.tenantId && project === "project-a"
    && (principal.actorId === "writer" ? (permission !== "asset:write" || writeAllowed) : principal.actorId === "reader" && permission === "asset:read") };
  const authorizeCommit = vi.fn((input: ImageExecutionRequest, fingerprint: string, payloadHash: string, binding: unknown): undefined => {
    const job = frozen.get(input.jobId);
    if (!executionAllowed || !job || job.fingerprint !== fingerprint || job.payloadHash !== payloadHash || job.binding !== JSON.stringify(binding)) throw new Error("fixture-execution-not-authorized");
    return undefined;
  });
  const service = new LocalGeneratedImages({ tenantId: actor.tenantId, stateStore: store, authorizer, authorizeCommit, maxProjectBytes: options.quota,
    clock: () => Date.parse("2026-10-03T17:00:00Z") }); // Response after quote expiry
  const makeContext = (input = request(snapshot)): ImageOutputContext => {
    const config = connection(); const fingerprint = imageConfirmationFingerprint(config, input);
    // Explicit trusted local executor fixture, not a production provider/Worker.
    const body = Buffer.from(JSON.stringify({ fixtureOnly: true, request: input })); const payloadHash = checksum(body);
    const refs = input.operation === "edit" ? [...input.inputs, ...(input.mask ? [input.mask] : [])] : [];
    const context: ImageOutputContext = { request: input, connection: config, confirmedAt: at, confirmedFingerprint: fingerprint,
      prepared: { body, payloadChecksumSha256: payloadHash, requestFingerprint: fingerprint, transformedInputs: refs.map((ref) => ({ assetId: ref.assetId, originalChecksumSha256: ref.checksumSha256,
        transmittedChecksumSha256: ref.checksumSha256, transform: ref === (input.operation === "edit" ? input.mask : undefined) ? "internal-white-to-transparent-mask-v1" : "exif-srgb-png-v1" })) } };
    frozen.set(input.jobId, { fingerprint, payloadHash, binding: JSON.stringify({ confirmedAt: at, transformedInputs: context.prepared.transformedInputs }) });
    return context;
  };
  return { path, store, service, snapshot, makeContext, authorizer, authorizeCommit,
    revokeWrite: () => { writeAllowed = false; }, revokeExecution: () => { executionAllowed = false; } };
}
function response(context: ImageOutputContext, body = png): ParsedImageProtocolResponse {
  const input = context.request;
  return { outcome: ImageProviderOutcomeSchema.parse({ schemaVersion: 1, tenantId: input.tenantId, projectId: input.projectId, jobId: input.jobId, connectionId: input.connectionId,
    requestFingerprint: context.confirmedFingerprint, providerRequestId: "provider-fixture-response", providerStatus: "returned", artifactStatus: "pending-validation", usage: { source: "unavailable" }, billing: { state: "unknown" } }),
    candidate: { body, checksumSha256: checksum(body), mimeType: `image/${input.parameters.outputFormat}` } };
}
function source(store: SqliteRunKernelStateStore, id = "source", body = png, extra: Partial<Asset> = {}): VerifiedImage {
  const asset = { id, projectId: "project-a", kind: "image" as const, purpose: "source" as const, storageKey: `local-fixture:${id}`, originalName: `${id}.png`,
    mimeType: "image/png", byteSize: body.length, width: 2, height: 3, contentFingerprint: `sha256:${checksum(body)}`, createdAt: at, ...extra };
  const proof = VerifiedImageSchema.parse({ schemaVersion: 1, id: `proof-${id}`, tenantId: "tenant-a", asset, registeredMetadataSha256: assetMetadataFingerprint(asset), checksumSha256: checksum(body),
    sourceChecksumSha256: asset.purpose === "mask" ? checksum(png) : undefined, decoder: "sharp-full-decode-v1", verifiedBy: "fixture", verifiedAt: at });
  store.transaction(() => { store.saveVerifiedImage(proof, body); const catalog = store.loadCatalog()!; catalog.projects[0].assets.push(asset); store.saveCatalog(catalog); });
  return proof;
}
const reference = (proof: VerifiedImage) => ({ assetId: proof.asset.id, checksumSha256: proof.checksumSha256, mimeType: proof.asset.mimeType, byteSize: proof.asset.byteSize, width: proof.asset.width, height: proof.asset.height });

describe("生成候选完整核验与本机不可变资产谱系", () => {
  it("完整像素核验后正文/收据/目录/谱系一起保存，重启可读且不保存 Base64 负载", async () => {
    const first = setup(); const context = first.makeContext();
    const output = await first.service.accept(actor, context, response(context));
    expect(output).toMatchObject({ validation: "verified", protectionApplied: "none", request: { jobId: "job-a", model: "explicit-fixture-model" },
      image: { asset: { purpose: "generated", width: 2, height: 3 }, checksumSha256: checksum(png), decoder: "sharp-full-decode-v1" }, providerOutcome: { billing: { state: "unknown" } } });
    expect(output.image.asset.id).toMatch(/^generated-/); expect(output.image.asset.storageKey).toMatch(/^local-verified:/);
    expect(first.store.loadVerifiedImageBytes(actor.tenantId, "project-a", output.image.asset.id)!.body.equals(png)).toBe(true);
    expect(JSON.stringify(output)).not.toContain(png.toString("base64")); expect(JSON.stringify(output)).not.toMatch(/never-resolved|never-called|fixtureOnly/);
    expect(first.store.loadCatalog()!.projects[0].assets).toEqual([output.image.asset]);
    const second = setup({ path: first.path }); expect(second.service.get({ ...actor, actorId: "reader" }, "project-a", "job-a")).toEqual(output);
    const verified = new LocalVerifiedAssets({ stateStore: second.store, authorizer: second.authorizer,
      findAsset: (tenant, project, id) => tenant === actor.tenantId ? second.store.loadCatalog()?.projects.find((item) => item.projectId === project)?.assets.find((item) => item.id === id) ?? null : null });
    expect(verified.requireImage(actor.tenantId, "project-a", output.image.asset.id)).toEqual(output.image);
  });
  it("响应丢失/并发重放只保存同一版本；报价已过期仍接收已确认结果", async () => {
    const first = setup(); const peer = setup({ path: first.path }); const context = first.makeContext(); peer.makeContext(context.request);
    const results = await Promise.all([first.service.accept(actor, context, response(context)), peer.service.accept(actor, context, response(context))]);
    expect(results[0]).toEqual(results[1]); expect(first.store.verifiedImageBytes(actor.tenantId, "project-a")).toBe(png.length);
    expect(await first.service.accept(actor, context, response(context))).toEqual(results[0]);
    expect(Date.parse(results[0].image.verifiedAt)).toBeGreaterThan(Date.parse(context.request.quote.expiresAt));
  });
  it("同一任务换图/换用量收据不能覆盖原资产或费用证据", async () => {
    const { service, makeContext, store } = setup(); const context = makeContext(); const saved = await service.accept(actor, context, response(context));
    const changed = await sharp(png).negate().png().toBuffer();
    await expect(service.accept(actor, context, response(context, changed))).rejects.toMatchObject({ code: "image_output_version_conflict", status: 409 });
    const newReceipt = response(context); newReceipt.outcome.providerRequestId = "different-receipt";
    await expect(service.accept(actor, context, newReceipt)).rejects.toMatchObject({ code: "image_output_version_conflict" });
    expect(service.get(actor, "project-a", "job-a")).toEqual(saved); expect(store.verifiedImageBytes(actor.tenantId, "project-a")).toBe(png.length);
  });
  it("格式头或 metadata 可读并不等于完整图片，截断/伪造产物拒绝", async () => {
    const { service, makeContext, store } = setup(); const context = makeContext();
    for (const body of [png.subarray(0, 45), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("<svg/>"), jpeg]) await expect(service.accept(actor, context, response(context, body))).rejects.toMatchObject({ status: 422 });
    expect(store.verifiedImageBytes(actor.tenantId, "project-a")).toBe(0); expect(store.loadGeneratedImage(actor.tenantId, "project-a", "job-a")).toBeNull();
  });
  it("Google 原生魔数候选只有 JPEG 头时，在完整核验边界被拒绝", async () => {
    const snapshot = constraint({ outputSpec: { width: 2, height: 3, format: "jpeg" } });
    const { service, makeContext } = setup({ snapshot }); const context = makeContext();
    const parsed = parseGoogleImageResponse(context.request, context.confirmedFingerprint, { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "/9j/" } }] } }] })) });
    expect(parsed.candidate).toBeDefined(); expect(parsed.outcome.artifactStatus).toBe("pending-validation");
    await expect(service.accept(actor, context, parsed)).rejects.toMatchObject({ code: "image_output_decode_failed" });
  });
  it.each(["png", "jpeg", "webp"] as const)("%s 原文件不重编码，EXIF 后真实尺寸用于验收", async (format) => {
    const snapshot = constraint({ outputSpec: { width: 2, height: 3, format } }); const { service, makeContext, store } = setup({ snapshot }); const context = makeContext();
    const body = format === "png" ? png : format === "jpeg" ? jpeg : webp;
    const output = await service.accept(actor, context, response(context, body)); expect(output.image.checksumSha256).toBe(checksum(body));
    expect(store.loadVerifiedImageBytes(actor.tenantId, "project-a", output.image.asset.id)!.body.equals(body)).toBe(true);
    const rotated = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#ffaa00" } }).withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
    const rotatedContext = makeContext(request(snapshot, { jobId: `rotated-${format}`, idempotencyKey: `rotated-${format}` }));
    expect((await service.accept(actor, rotatedContext, response(rotatedContext, rotated))).image.asset).toMatchObject({ width: 2, height: 3 });
  });
  it("约束/请求指定尺寸与实际输出不一致就拒绝，不静默裁切或缩放", async () => {
    const { service, makeContext, store } = setup(); const context = makeContext(); const other = await sharp(png).resize(3, 2).png().toBuffer();
    await expect(service.accept(actor, context, response(context, other))).rejects.toMatchObject({ code: "image_output_dimensions_mismatch" });
    const mismatched = makeContext({ ...context.request, parameters: { ...context.request.parameters, size: { width: 3, height: 2 } } });
    await expect(service.accept(actor, mismatched, response(mismatched))).rejects.toMatchObject({ code: "image_output_spec_changed" });
    expect(store.loadCatalog()!.projects[0].assets).toEqual([]);
  });
  it("透明/不透明输出检查实际像素而不只看 alpha 通道存在", async () => {
    const { service, makeContext } = setup(); const transparent = makeContext({ ...request(), parameters: { ...request().parameters, background: "transparent" } });
    await expect(service.accept(actor, transparent, response(transparent))).rejects.toMatchObject({ code: "image_output_background_mismatch" });
    const clear = await sharp({ create: { width: 2, height: 3, channels: 4, background: "#00000000" } }).png().toBuffer();
    expect((await service.accept(actor, transparent, response(transparent, clear))).image.asset.mimeType).toBe("image/png");
    const opaque = makeContext({ ...request(), jobId: "opaque-job", parameters: { ...request().parameters, background: "opaque" } });
    await expect(service.accept(actor, opaque, response(opaque, clear))).rejects.toMatchObject({ code: "image_output_background_mismatch" });
  });
  it("APNG/动态 WebP、过大文件/边长/像素和项目配额均有界拒绝", async () => {
    const { service, makeContext, store } = setup(); const context = makeContext();
    const control = Buffer.from("000000086163544c000000020000000000000000", "hex"); const apng = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]);
    await expect(service.accept(actor, context, response(context, apng))).rejects.toMatchObject({ code: "image_output_animated" });
    const hugeBody = Buffer.alloc(MAX_IMAGE_PROTOCOL_OUTPUT_BYTES + 1);
    await expect(service.accept(actor, context, response(context, hugeBody))).rejects.toMatchObject({ code: "image_output_too_large", status: 413 });
    const wide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: "black" } }).png().toBuffer();
    await expect(service.accept(actor, context, response(context, wide))).rejects.toMatchObject({ code: "image_output_dimensions_exceeded" });
    const manyPixels = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: "black" } }).png().toBuffer();
    await expect(service.accept(actor, context, response(context, manyPixels))).rejects.toMatchObject({ status: 422 });
    const webpSnapshot = constraint({ outputSpec: { width: 1, height: 1, format: "webp" } }); const animationSetup = setup({ snapshot: webpSnapshot });
    const animation = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } }).webp({ delay: [100, 100] }).toBuffer();
    const animContext = animationSetup.makeContext(); await expect(animationSetup.service.accept(actor, animContext, response(animContext, animation))).rejects.toMatchObject({ code: "image_output_animated" });
    const limited = setup({ quota: png.length - 1 }); const limitedContext = limited.makeContext();
    await expect(limited.service.accept(actor, limitedContext, response(limitedContext))).rejects.toMatchObject({ code: "image_output_project_quota" });
    expect(store.verifiedImageBytes(actor.tenantId, "project-a")).toBe(0);
  });
  it("原生响应编号/归属/候选摘要及实际发送负载必须一致", async () => {
    const { service, makeContext, store } = setup(); const context = makeContext();
    for (const change of [{ tenantId: "foreign" }, { projectId: "foreign" }, { jobId: "foreign" }, { connectionId: "foreign" }, { requestFingerprint: "b".repeat(64) }, { providerStatus: "unknown", artifactStatus: "absent" }]) {
      const parsed = response(context); parsed.outcome = { ...parsed.outcome, ...change } as typeof parsed.outcome;
      await expect(service.accept(actor, context, parsed)).rejects.toMatchObject({ code: "image_output_response_not_accepted" });
    }
    const corrupt = response(context); corrupt.candidate!.checksumSha256 = "b".repeat(64);
    await expect(service.accept(actor, context, corrupt)).rejects.toMatchObject({ code: "image_output_checksum_changed" });
    const prepared = { ...context, prepared: { ...context.prepared, body: Buffer.from("payload changed") } };
    await expect(service.accept(actor, prepared, response(context))).rejects.toMatchObject({ code: "image_output_prepared_payload_changed" });
    expect(store.loadGeneratedImage(actor.tenantId, "project-a", "job-a")).toBeNull();
  });
  it("冻结约束的更改、移除或伪装为无锁不能绕过商品硬像素保护", async () => {
    const { service, makeContext, store } = setup(); const context = makeContext();
    store.transaction(() => { const catalog = store.loadCatalog()!; catalog.projects[0].constraints[0].brandRules.style = "changed"; store.saveCatalog(catalog); });
    await expect(service.accept(actor, context, response(context))).rejects.toMatchObject({ code: "image_output_constraint_changed" });
    const locked = constraint({ lockedPaths: ["product.pixels"] }); const strict = setup({ snapshot: locked }); const lockedContext = strict.makeContext();
    await expect(strict.service.accept(actor, lockedContext, response(lockedContext))).rejects.toMatchObject({ code: "image_pixel_protection_not_configured" });
    expect(strict.store.verifiedImageBytes(actor.tenantId, "project-a")).toBe(0);
  });
  it("编辑谱系绑定权威输入正文与发送摘要；失去输入不能回流新结果", async () => {
    const { path, store, service, makeContext } = setup(); const proof = source(store); const input = ImageExecutionRequestSchema.parse({ ...request(), operation: "edit", inputs: [reference(proof)] }); const context = makeContext(input);
    const output = await service.accept(actor, context, response(context)); expect(output.image.asset.sourceAssetId).toBe("source"); expect(output.transformedInputs[0].originalChecksumSha256).toBe(checksum(png));
    const fresh = makeContext({ ...input, jobId: "next-job" });
    const db = new DatabaseSync(path);
    try { db.prepare("UPDATE verified_images SET body = ? WHERE asset_id = 'source'").run(Buffer.alloc(png.length)); } finally { db.close(); }
    await expect(service.accept(actor, fresh, response(fresh))).rejects.toMatchObject({ code: "run_state_unavailable" });
  });
  it("只读/跨租户不能写；解码等待期间权限或执行授权撤回会回滚", async () => {
    const first = setup(); const context = first.makeContext();
    await expect(first.service.accept({ ...actor, actorId: "reader" }, context, response(context))).rejects.toMatchObject({ status: 403 });
    await expect(first.service.accept({ ...actor, tenantId: "foreign" }, context, response(context))).rejects.toMatchObject({ status: 403 });
    const pending = first.service.accept(actor, context, response(context)); first.revokeWrite(); await expect(pending).rejects.toMatchObject({ status: 403 });
    expect(first.store.verifiedImageBytes(actor.tenantId, "project-a")).toBe(0);
    const revoked = setup(); const another = revoked.makeContext(); const delayed = revoked.service.accept(actor, another, response(another)); revoked.revokeExecution();
    await expect(delayed).rejects.toMatchObject({ status: 503 }); expect(revoked.store.verifiedImageBytes(actor.tenantId, "project-a")).toBe(0);
    expect(() => first.service.get({ ...actor, tenantId: "foreign" }, "project-a", "job-a")).toThrowError(expect.objectContaining({ status: 404 }));
  });
  it("正文/谱系保存后目录写入故障整体回滚，重放已有候选不会再请求模型", async () => {
    const { store, service, makeContext } = setup(); const context = makeContext(); const savedCatalog = store.loadCatalog(); const original = store.saveCatalog.bind(store);
    store.saveCatalog = () => { throw new Error("injected catalog failure"); };
    await expect(service.accept(actor, context, response(context))).rejects.toMatchObject({ status: 503 });
    expect(store.loadCatalog()).toEqual(savedCatalog); expect(store.verifiedImageBytes(actor.tenantId, "project-a")).toBe(0); expect(store.loadGeneratedImage(actor.tenantId, "project-a", "job-a")).toBeNull();
    store.saveCatalog = original; expect((await service.accept(actor, context, response(context))).validation).toBe("verified");
  });
  it("坏产物/配额/保存失败不结算未知费用，也不改变现有预留或任务", async () => {
    const fixture = setup(); const kernel = new SqliteRunKernel({ stateStore: fixture.store, authorizer: { authenticate: () => null, allows: () => true }, budgets: [{ tenantId: actor.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }] });
    const draft = kernel.createBatch(actor, { projectId: "project-a", constraintSnapshotId: "constraints-a", inputAssetIds: ["source-fixture"], tool: "product-retouch", expectedOutputs: 1, maxCostMinor: 25, currency: "CNY", idempotencyKey: "budget-fixture", mockScenario: "billing-unknown" });
    kernel.confirmBatch(actor, draft.batch.id, { expectedCurrency: "CNY", expectedEstimatedCostMinor: 25 }); kernel.dispatchBatch(actor, draft.batch.id);
    const before = fixture.store.load(); const context = fixture.makeContext();
    await expect(fixture.service.accept(actor, context, response(context, png.subarray(0, 45)))).rejects.toMatchObject({ code: "image_output_decode_failed" });
    await fixture.service.accept(actor, context, response(context));
    expect(fixture.store.load()).toEqual(before); expect(kernel.getBudget(actor, "project-a")).toMatchObject({ reservedMinor: 25, spentMinor: 0 });
    expect(kernel.getBatch(actor, draft.batch.id).jobs[0].status).toBe("billing_unknown");
  });
  it("谱系/正文/收据/目录或存在标记损坏时拒绝，禁止用同任务编号重新生成", async () => {
    for (const damage of ["record", "body", "receipt", "catalog", "missing-record", "missing-marker"] as const) {
      const fixture = setup(); const context = fixture.makeContext(); const output = await fixture.service.accept(actor, context, response(context));
      const db = new DatabaseSync(fixture.path);
      try {
        if (damage === "record") db.exec("UPDATE generated_images SET record = '{}' ");
        if (damage === "body") db.prepare("UPDATE verified_images SET body = ?").run(Buffer.alloc(png.length));
        if (damage === "receipt") db.exec("UPDATE verified_images SET record = '{}' ");
        if (damage === "missing-record") db.exec("DELETE FROM generated_images");
        if (damage === "missing-marker") db.exec("DELETE FROM generated_image_presence");
      } finally { db.close(); }
      if (damage === "catalog") fixture.store.transaction(() => { const catalog = fixture.store.loadCatalog()!; catalog.projects[0].assets[0].originalName = "changed"; fixture.store.saveCatalog(catalog); });
      expect(() => fixture.service.get(actor, "project-a", "job-a")).toThrowError(expect.objectContaining({ status: 503 }));
      await expect(fixture.service.accept(actor, context, response(context))).rejects.toMatchObject({ status: 503 });
      expect(output.image.asset.id).toMatch(/^generated-/);
    }
  });
  it("v2 安全升级保留旧账本/目录；无候选不创建资产或伪造收据", async () => {
    const first = setup(); const inputProof = source(first.store);
    const kernel = new SqliteRunKernel({ stateStore: first.store, authorizer: { authenticate: () => null, allows: () => true }, budgets: [{ tenantId: actor.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }] });
    const draft = kernel.createBatch(actor, { projectId: "project-a", constraintSnapshotId: "constraints-a", inputAssetIds: ["source"], tool: "product-retouch", expectedOutputs: 1, maxCostMinor: 25, currency: "CNY", idempotencyKey: "migration-fixture", mockScenario: "success" });
    kernel.confirmBatch(actor, draft.batch.id, { expectedCurrency: "CNY", expectedEstimatedCostMinor: 25 });
    const oldCatalog = first.store.loadCatalog(); const oldRuns = first.store.load();
    const db = new DatabaseSync(first.path); db.exec("PRAGMA user_version = 2"); db.close();
    const second = setup({ path: first.path }); expect(second.store.loadCatalog()).toEqual(oldCatalog);
    expect(second.store.load()).toEqual(oldRuns); expect(second.store.loadVerifiedImage(actor.tenantId, "project-a", "source")).toEqual(inputProof);
    expect(second.store.loadVerifiedImageBytes(actor.tenantId, "project-a", "source")!.body.equals(png)).toBe(true);
    expect(second.store.loadGeneratedImage(actor.tenantId, "project-a", "job-a")).toBeNull();
    const context = second.makeContext(); const absent = response(context); delete absent.candidate;
    await expect(second.service.accept(actor, context, absent)).rejects.toMatchObject({ code: "image_output_response_not_accepted" });
    expect(() => second.store.saveGeneratedImage({} as never, png)).toThrow(/事务/);
  });
  it("共享解码槽与服务并发上限阻止过量同时解码，调用者改 Buffer 不影响已接收字节", async () => {
    const { service, makeContext } = setup(); const contexts = ["1", "2", "3"].map((id) => makeContext({ ...request(), jobId: id }));
    const candidate = response(contexts[0], Buffer.from(png)); const first = service.accept(actor, contexts[0], candidate); candidate.candidate!.body.fill(0);
    const second = service.accept(actor, contexts[1], response(contexts[1]));
    await expect(service.accept(actor, contexts[2], response(contexts[2]))).rejects.toMatchObject({ code: "image_output_busy", status: 429 });
    expect((await first).image.checksumSha256).toBe(checksum(png)); await second;
  });
  it("严格生成合同拒绝跨项目、虚假成功/硬保护和不完整输入谱系", async () => {
    const { service, makeContext } = setup(); const context = makeContext(); const record = await service.accept(actor, context, response(context));
    for (const change of [{ protectionApplied: "pixel-exact" }, { image: { ...record.image, tenantId: "foreign" } }, { providerOutcome: { ...record.providerOutcome, artifactStatus: "absent" } },
      { transformedInputs: [{ assetId: "foreign", originalChecksumSha256: checksum(png), transmittedChecksumSha256: checksum(png), transform: "exif-srgb-png-v1" }] }]) expect(GeneratedImageRecordSchema.safeParse({ ...record, ...change }).success).toBe(false);
  });
  it("缺执行授权或篡改发送图片摘要不能回流；未知收费不能被替换为零费用", async () => {
    const fixture = setup(); const proof = source(fixture.store);
    const context = fixture.makeContext(ImageExecutionRequestSchema.parse({ ...request(), operation: "edit", inputs: [reference(proof)] }));
    context.prepared.transformedInputs[0].transmittedChecksumSha256 = "b".repeat(64);
    await expect(fixture.service.accept(actor, context, response(context))).rejects.toMatchObject({ status: 503 });
    const fresh = fixture.makeContext();
    const noAuthority = new LocalGeneratedImages({ tenantId: actor.tenantId, stateStore: fixture.store, authorizer: fixture.authorizer, authorizeCommit: undefined as never });
    await expect(noAuthority.accept(actor, fresh, response(fresh))).rejects.toMatchObject({ code: "image_output_execution_not_authorized" });
    const free = response(fresh); free.outcome.billing = { state: "unbilled", evidenceRef: "client-claim" };
    await expect(fixture.service.accept(actor, fresh, free)).rejects.toMatchObject({ code: "image_output_response_not_accepted" });
  });
  it("NaN/负值/超限容量不能让配额比较失效，租户必须显式固定", () => {
    const fixture = setup();
    for (const maxProjectBytes of [NaN, Infinity, -1, 1.5, 512 * 1024 * 1024 + 1]) expect(() => new LocalGeneratedImages({ tenantId: actor.tenantId, stateStore: fixture.store, authorizer: fixture.authorizer, authorizeCommit: () => undefined, maxProjectBytes })).toThrow(/配置无效/);
    expect(() => new LocalGeneratedImages({ tenantId: " ", stateStore: fixture.store, authorizer: fixture.authorizer, authorizeCommit: () => undefined })).toThrow(/配置无效/);
  });
});
