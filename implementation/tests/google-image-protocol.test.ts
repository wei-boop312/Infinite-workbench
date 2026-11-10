import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GoogleImageProfileSchema, ImageExecutionRequestSchema, ImageProviderConnectionSchema, type ImageExecutionRequest, type VerifiedImage } from "../packages/contracts/src/index";
import { assertRealImageExecutionAllowed, imageProviderPublicView, requireImageConfirmation } from "../apps/api/src/imageProviderContract";
import { encodeGoogleImageJson, MAX_GOOGLE_IMAGE_REQUEST_BYTES, parseGoogleImageResponse, prepareGoogleImageRequest, type GoogleImagePreparedRequest } from "../apps/api/src/googleImageProtocol";
import { MAX_IMAGE_PROTOCOL_OUTPUT_BYTES, MAX_IMAGE_PROTOCOL_RESPONSE_BYTES } from "../apps/api/src/imageProtocolResponse";
import { LocalImageProtocolSession } from "./helpers/local-image-protocol-session";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
let jpeg: Buffer;
beforeAll(async () => { jpeg = await sharp(png).jpeg().toBuffer(); });
const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const now = "2026-10-03T15:30:00Z";
function profile() {
  return GoogleImageProfileSchema.parse({ version: "google-profile-fixture-v1", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1",
    modelMappings: [{ model: "explicit-fixture-model", sizes: [
      { width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" },
      { width: 1376, height: 768, aspectRatio: "16:9", imageSize: "1K" },
    ] }] });
}
function connection() {
  return ImageProviderConnectionSchema.parse({ schemaVersion: 1, id: "google-fixture", tenantId: "tenant-a", projectId: "project-a", name: "Google 原生本地夹具",
    revision: 1, protocol: "google", adapterId: "google-native-fixture", baseUrl: "https://generativelanguage.googleapis.com", credentialRef: "never-resolved-server-reference",
    enabled: true, diagnostic: { state: "not-run" }, googleNative: profile(), models: [{ model: "explicit-fixture-model", version: "caps-v1", operations: ["generate", "edit"],
      inputMimeTypes: ["image/png", "image/jpeg"], outputFormats: ["jpeg"], maxInputImages: 3, maxPromptCharacters: 32000, maxInputEdge: 8192, maxInputPixels: 16000000,
      maxInputBytes: 30 * 1024 * 1024, maxTotalInputBytes: 100 * 1024 * 1024, sizes: { allowAuto: true, presets: profile().modelMappings[0].sizes.map(({ width, height }) => ({ width, height })) },
      qualities: ["auto"], backgrounds: ["auto"], inputFidelities: [], supportsOutputCompression: false, mask: { mode: "none", polarity: "unsupported" }, evidence: { state: "declared" } }] });
}
function request(): ImageExecutionRequest {
  return ImageExecutionRequestSchema.parse({ schemaVersion: 1, tenantId: "tenant-a", projectId: "project-a", jobId: "job-a", idempotencyKey: "attempt-a", connectionId: "google-fixture", connectionRevision: 1,
    adapterId: "google-native-fixture", model: "explicit-fixture-model", capabilityVersion: "caps-v1", constraintSnapshotId: "constraints-a", constraintChecksumSha256: "a".repeat(64), protection: "none",
    operation: "generate", inputs: [], parameters: { prompt: "人为指定构图与光线", n: 1, size: "auto", quality: "auto", background: "auto", outputFormat: "jpeg" },
    quote: { id: "quote-fixture", version: "budget-fixture-v1", source: "manual-budget", currency: "CNY", estimatedCostMinor: 25, maxCostMinor: 30, expiresAt: "2026-10-04T00:00:00Z" } });
}
function verified(id = "source", body = png, extra: Partial<VerifiedImage["asset"]> = {}): VerifiedImage {
  return { schemaVersion: 1, tenantId: "tenant-a", id: `proof-${id}`, asset: { id, projectId: "project-a", kind: "image", purpose: "source", originalName: "private-original-name.png",
    storageKey: "private-local-path", mimeType: "image/png", byteSize: body.length, width: 1, height: 1, contentFingerprint: `sha256:${sha(body)}`, createdAt: now, ...extra },
    registeredMetadataSha256: "a".repeat(64), checksumSha256: sha(body), decoder: "sharp-full-decode-v1", verifiedBy: "fixture", verifiedAt: now };
}
const reference = (receipt: VerifiedImage) => ({ assetId: receipt.asset.id, checksumSha256: receipt.checksumSha256, mimeType: receipt.asset.mimeType, byteSize: receipt.asset.byteSize, width: receipt.asset.width, height: receipt.asset.height });
const edit = (receipts = [verified()]) => ImageExecutionRequestSchema.parse({ ...request(), operation: "edit", inputs: receipts.map(reference) });
const finalImage = () => ({ inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } });
const nativeJson = (parts: unknown[] = [finalImage()]) => ({ responseId: "google-response-fixture", candidates: [{ finishReason: "STOP", content: { role: "model", parts } }] });
const reply = (json: unknown = nativeJson()) => ({ status: 200, contentType: "application/json; charset=utf-8", body: Buffer.from(JSON.stringify(json)) });
const parse = (json: unknown = nativeJson()) => parseGoogleImageResponse(request(), "a".repeat(64), reply(json));

describe("Google 非 OpenAI 原生图片协议与零费用假响应", () => {
  it("严格固定原生合同，不接受脚本、路径模板、任意版本或混用中转配置", () => {
    for (const change of [{ apiVersion: "guess-next" }, { requestEncoding: "openai" }, { auth: "query-key" }, { script: "eval('never')" }]) expect(GoogleImageProfileSchema.safeParse({ ...profile(), ...change }).success).toBe(false);
    for (const model of ["../model", "models/model", "model:generateContent", "model?key=secret", "model%2fchild", "model\\child"]) expect(GoogleImageProfileSchema.safeParse({ ...profile(), modelMappings: [{ ...profile().modelMappings[0], model }] }).success).toBe(false);
    expect(ImageProviderConnectionSchema.safeParse({ ...connection(), protocol: "openai" }).success).toBe(false);
    expect(ImageProviderConnectionSchema.safeParse({ ...connection(), googleNative: { ...profile(), modelMappings: [{ ...profile().modelMappings[0], model: "undeclared" }] } }).success).toBe(false);
    expect(GoogleImageProfileSchema.safeParse({ ...profile(), modelMappings: [profile().modelMappings[0], profile().modelMappings[0]] }).success).toBe(false);
  });
  it("未配置或其他协议即拒绝；官方原生地址不猜测 Vertex、私网或中转服务", async () => {
    await expect(prepareGoogleImageRequest({ ...connection(), googleNative: undefined }, request(), [], now)).rejects.toThrow("google_image_profile_not_configured");
    await expect(prepareGoogleImageRequest({ ...connection(), protocol: "openai", googleNative: undefined }, request(), [], now)).rejects.toThrow("image_protocol_mismatch");
    for (const baseUrl of ["https://relay.invalid", "https://generativelanguage.googleapis.com.evil.invalid", "https://127.0.0.1", "https://generativelanguage.googleapis.com/v1", "https://generativelanguage.googleapis.com:444"]) await expect(prepareGoogleImageRequest({ ...connection(), baseUrl }, request(), [], now)).rejects.toThrow("google_image_endpoint_unsupported");
  });
  it("生成使用显式模型路径、原生 contents 与受控鉴权计划；无 OpenAI 字段或密钥", async () => {
    const prepared = await prepareGoogleImageRequest(connection(), request(), [], now);
    expect(prepared.endpointUrl).toBe("https://generativelanguage.googleapis.com/v1/models/explicit-fixture-model:generateContent");
    expect(prepared.authPlan).toEqual({ scheme: "header", headerName: "x-goog-api-key", credentialRef: "never-resolved-server-reference" });
    expect(JSON.parse(prepared.body.toString())).toEqual({ contents: [{ role: "user", parts: [{ text: "人为指定构图与光线" }] }], generationConfig: {
      responseModalities: ["TEXT", "IMAGE"], candidateCount: 1, responseFormat: { image: { mimeType: "IMAGE_JPEG", delivery: "INLINE" } } } });
    expect(prepared.payloadChecksumSha256).toBe(sha(prepared.body)); expect(prepared.transformedInputs).toEqual([]);
    expect(prepared.body.toString()).not.toMatch(/api.key|credential|model|n":|output_format|images|quality|background/);
  });
  it("明确像素预设逐项映射原生比例与尺寸枚举；auto 不暗选分辨率", async () => {
    const input = { ...request(), parameters: { ...request().parameters, size: { width: 1376, height: 768 } } };
    const prepared = await prepareGoogleImageRequest(connection(), input, [], now);
    expect(JSON.parse(prepared.body.toString()).generationConfig.responseFormat.image).toMatchObject({ aspectRatio: "ASPECT_RATIO_SIXTEEN_BY_NINE", imageSize: "IMAGE_SIZE_ONE_K" });
    await expect(prepareGoogleImageRequest(connection(), { ...input, parameters: { ...input.parameters, size: { width: 1920, height: 1080 } } }, [], now)).rejects.toThrow("image_size_unsupported");
    const mismatch = connection(); mismatch.googleNative!.modelMappings[0].sizes.pop();
    await expect(prepareGoogleImageRequest(mismatch, request(), [], now)).rejects.toThrow("google_image_size_mapping_inconsistent");
    const duplicate = profile(); duplicate.modelMappings[0].sizes.push(duplicate.modelMappings[0].sizes[0]); expect(GoogleImageProfileSchema.safeParse(duplicate).success).toBe(false);
  });
  it("参考图用权威原文件、完整 PNG 归一化及 inlineData，不带用户路径或文件名", async () => {
    const receipts = [verified(), verified("second")];
    const prepared = await prepareGoogleImageRequest(connection(), edit(receipts), receipts.map((receipt) => ({ receipt, body: png })), now);
    const wire = JSON.parse(prepared.body.toString()); expect(wire.contents[0].parts).toHaveLength(3);
    for (const [index, part] of wire.contents[0].parts.slice(1).entries()) {
      expect(part.inlineData.mimeType).toBe("image/png"); const body = Buffer.from(part.inlineData.data, "base64");
      expect(await sharp(body).metadata()).toMatchObject({ width: 1, height: 1, format: "png" }); expect(sha(body)).toBe(prepared.transformedInputs[index].transmittedChecksumSha256);
    }
    expect(prepared.body.toString()).not.toMatch(/private-original-name|private-local-path|source|second|data:image/);
    expect(prepared.transformedInputs.map((item) => item.originalChecksumSha256)).toEqual([sha(png), sha(png)]);
  });
  it("缺证明、改字节、跨项目或多输入不能悄悄发送或丢弃", async () => {
    await expect(prepareGoogleImageRequest(connection(), edit(), [], now)).rejects.toThrow("image_input_not_verified");
    await expect(prepareGoogleImageRequest(connection(), edit(), [{ receipt: verified(), body: Buffer.from("changed") }], now)).rejects.toThrow("image_input_bytes_changed");
    const foreign = verified(); foreign.asset.projectId = "foreign";
    await expect(prepareGoogleImageRequest(connection(), edit(), [{ receipt: foreign, body: png }], now)).rejects.toThrow("image_input_not_verified");
    const receipts = [verified(), verified("2"), verified("3"), verified("4")];
    await expect(prepareGoogleImageRequest(connection(), edit(receipts), [], now)).rejects.toThrow("image_input_count_exceeded");
  });
  it("蒙版与硬像素锁明确拒绝，不把它们改为提示词或普通参考图", async () => {
    const mask = verified("mask", png, { purpose: "mask", sourceAssetId: "source" }); mask.sourceChecksumSha256 = sha(png);
    await expect(prepareGoogleImageRequest(connection(), { ...edit(), mask: reference(mask) }, [], now)).rejects.toThrow("image_mask_unsupported");
    await expect(prepareGoogleImageRequest(connection(), { ...edit(), protection: "pixel-exact" }, [], now)).rejects.toThrow("image_pixel_protection_not_configured");
    const invalid = connection(); invalid.models[0].mask = { mode: "prompt-guidance", polarity: "white-edit" };
    await expect(prepareGoogleImageRequest(invalid, request(), [], now)).rejects.toThrow("google_image_mask_not_supported");
  });
  it("不支持的质量、透明度、格式、压缩和额外字段都拒绝而不是忽略", async () => {
    for (const parameters of [{ quality: "high" }, { background: "opaque" }, { outputFormat: "png" }, { inputFidelity: "high" }, { outputCompression: 50 }]) await expect(prepareGoogleImageRequest(connection(), { ...request(), parameters: { ...request().parameters, ...parameters } }, [], now)).rejects.toThrow(/image_(quality|background|output_format|fidelity|compression)_unsupported/);
    await expect(prepareGoogleImageRequest(connection(), { ...request(), parameters: { ...request().parameters, background: "transparent" } }, [], now)).rejects.toThrow("JPEG 不支持透明输出");
    await expect(prepareGoogleImageRequest(connection(), { ...request(), providerParameters: { seed: 0 } }, [], now)).rejects.toThrow("image_extra_parameter_unsupported");
    const dishonest = connection(); dishonest.models[0].qualities.push("high");
    await expect(prepareGoogleImageRequest(dishonest, request(), [], now)).rejects.toThrow("google_image_capability_not_supported");
  });
  it("请求总大小按 JSON/文本/Base64 累计，编码前拒绝过大引用", () => {
    expect(MAX_GOOGLE_IMAGE_REQUEST_BYTES).toBe(20_000_000);
    expect(() => encodeGoogleImageJson("fixture", [{ assetId: "huge", body: Buffer.alloc(15_000_000) }])).toThrow("image_request_too_large");
    expect(() => encodeGoogleImageJson("fixture", [1, 2].map((id) => ({ assetId: String(id), body: Buffer.alloc(8_000_000) })))).toThrow("image_request_too_large");
  });
  it("原生映射/版本/参数改变都要求重新确认，公开视图不泄露连接细节", async () => {
    const prepared = await prepareGoogleImageRequest(connection(), request(), [], now);
    const changes = [connection(), connection()]; changes[0].googleNative!.version = "profile-v2"; changes[1].googleNative!.modelMappings[0].sizes[0].imageSize = "2K";
    for (const change of changes) expect(() => requireImageConfirmation(change, request(), prepared.requestFingerprint, now)).toThrow("image_confirmation_changed");
    expect(JSON.stringify(imageProviderPublicView(connection()))).not.toMatch(/googleNative|generativelanguage|never-resolved|x-goog/);
    expect(imageProviderPublicView(connection()).models[0].evidence.state).toBe("declared");
  });
  it("原生图文响应只返回最终候选字节，忽略思考预览及私有文本/签名", () => {
    const result = parse(nativeJson([{ thought: true, inlineData: { mimeType: "image/png", data: "never-decode-thought" }, thoughtSignature: "private-signature" },
      { text: "private-generated-text" }, { thought: false, ...finalImage() }]));
    expect(result.candidate!.body.equals(jpeg)).toBe(true); expect(result.candidate!.checksumSha256).toBe(sha(jpeg));
    expect(result.outcome).toMatchObject({ providerRequestId: "google-response-fixture", artifactStatus: "pending-validation", usage: { source: "unavailable" }, billing: { state: "unknown" } });
    expect(JSON.stringify(result.outcome)).not.toMatch(/private|never-decode|signature|base64/);
  });
  it("多候选、多图、仅思考/文本或远端 URI 不能由程序抽卡选择", () => {
    for (const parts of [[finalImage(), finalImage()], [{ thought: true, ...finalImage() }], [{ text: "no image" }], [{ fileData: { mimeType: "image/jpeg", fileUri: "https://private.invalid/file" } }], [{ text: "mixed", ...finalImage() }], [{ thought: "true", ...finalImage() }]]) {
      const result = parse(nativeJson(parts)); expect(result.candidate).toBeUndefined(); expect(result.outcome.billing.state).toBe("unknown");
    }
    const two = nativeJson(); two.candidates.push(two.candidates[0]); expect(parse(two).candidate).toBeUndefined();
    expect(parse({ created: 1, data: [{ b64_json: jpeg.toString("base64") }] }).candidate).toBeUndefined();
  });
  it("阻断或未完成不能当作成功；仍保留返回用量与未知收费", () => {
    const usageMetadata = { totalTokenCount: 10 };
    for (const finishReason of ["SAFETY", "IMAGE_SAFETY", "MAX_TOKENS", "OTHER", undefined]) {
      const json = nativeJson(); json.candidates[0].finishReason = finishReason!;
      const result = parse({ ...json, usageMetadata }); expect(result.candidate).toBeUndefined(); expect(result.outcome).toMatchObject({ failureCode: "google_image_finish_not_complete", usage: { source: "provider-reported", metrics: { totalTokens: 10 } }, billing: { state: "unknown" } });
    }
    expect(parse({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata }).outcome).toMatchObject({ failureCode: "google_image_prompt_blocked", providerStatus: "rejected", billing: { state: "unknown" } });
  });
  it("原生实报思考 token 单独保存，缺字段不假造零或收费金额", () => {
    const result = parse({ ...nativeJson(), usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 5, totalTokenCount: 10, cachedContentTokenCount: 1, toolUsePromptTokenCount: 0 } });
    expect(result.outcome.usage).toEqual({ source: "provider-reported", metrics: { inputTokens: 2, outputTokens: 3, reasoningTokens: 5, totalTokens: 10, cachedInputTokens: 1, toolInputTokens: 0 } });
    const partial = parse({ ...nativeJson(), usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 10 } });
    expect(partial.candidate).toBeDefined(); expect(partial.outcome.usage).toEqual({ source: "provider-reported", metrics: { inputTokens: 2, outputTokens: 3, totalTokens: 10 } });
    expect(partial.outcome.billing).toEqual({ state: "unknown" });
  });
  it("已知候选安全阻断标记不因 STOP 被忽略，异常 parts/role 也拒绝", () => {
    const blocked = nativeJson();
    expect(parse({ ...blocked, candidates: [{ ...blocked.candidates[0], safetyRatings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", blocked: true }] }] }).outcome)
      .toMatchObject({ failureCode: "google_image_candidate_blocked", providerStatus: "rejected", billing: { state: "unknown" } });
    for (const content of [{ role: "user", parts: [finalImage()] }, { role: "model", parts: Array.from({ length: 65 }, () => ({ text: "bounded" })) }, { parts: [null] }, { parts: [{ unknownUnion: true }] }]) {
      expect(parse({ ...blocked, candidates: [{ finishReason: "STOP", content }] }).candidate).toBeUndefined();
    }
  });
  it("异常用量拒绝，包含负数/小数/字符串/溢出/不守恒/缓存超额", () => {
    for (const usageMetadata of [{}, null, { totalTokenCount: "10" }, { promptTokenCount: -1 }, { candidatesTokenCount: 1.5 }, { totalTokenCount: Number.MAX_SAFE_INTEGER + 1 },
      { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 10 }, { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 1, totalTokenCount: 10 }, { promptTokenCount: 2, cachedContentTokenCount: 3 }]) {
      const result = parse({ ...nativeJson(), usageMetadata }); expect(result.candidate).toBeUndefined(); expect(result.outcome.failureCode).toBe("image_usage_invalid"); expect(result.outcome.billing.state).toBe("unknown");
    }
  });
  it("MIME 改变、非规范 Base64 和魔数错误拒绝；完整输出解码仍待下个里程碑", () => {
    for (const inlineData of [{ mimeType: "image/png", data: png.toString("base64") }, { mimeType: "image/jpeg", data: jpeg.toString("base64") + "\n" }, { mimeType: "image/jpeg", data: "@@@@" },
      { mimeType: "image/jpeg", data: png.toString("base64") }, { mimeType: "image/jpeg", data: "" }]) expect(parse(nativeJson([{ inlineData }])).candidate).toBeUndefined();
    const magicOnly = parse(nativeJson([{ inlineData: { mimeType: "image/jpeg", data: Buffer.from([255, 216, 255]).toString("base64") } }]));
    expect(magicOnly.outcome.artifactStatus).toBe("pending-validation"); expect(magicOnly.candidate).toBeDefined(); // NOT an accepted asset
    const oversize = parse(nativeJson([{ inlineData: { mimeType: "image/jpeg", data: "A".repeat(4 * Math.ceil(MAX_IMAGE_PROTOCOL_OUTPUT_BYTES / 3) + 4) } }]));
    expect(oversize.outcome.failureCode).toBe("image_output_too_large");
  });
  it("HTTP/重定向/JSON/UTF-8/响应上限错误都不露原始错误、不变成未扣费", () => {
    for (const response of [{ ...reply({ error: { message: "private-error" } }), status: 429 }, { ...reply(), status: 302 }, { ...reply(), status: 500 }, { ...reply(), status: 204 },
      { ...reply(), status: 0 }, { ...reply(), contentType: "text/html" }, { ...reply(), body: Buffer.from("not-json") }, { ...reply(), body: Buffer.from([0xff]) },
      { ...reply(), body: Buffer.alloc(MAX_IMAGE_PROTOCOL_RESPONSE_BYTES + 1) }]) {
      const result = parseGoogleImageResponse(request(), "a".repeat(64), response); expect(result.candidate).toBeUndefined(); expect(result.outcome.billing.state).toBe("unknown"); expect(JSON.stringify(result.outcome)).not.toContain("private-error");
    }
    const unsafe = parse({ ...nativeJson(), responseId: "private\nrequest-id" }); expect(unsafe.outcome.providerRequestId).toBeUndefined();
  });
  it("原生回环 HTTP 假服务用固定假头收到真实请求二进制，重复派发只调用一次", async () => {
    const received: unknown[] = [];
    const server = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push({ path: req.url, auth: req.headers["x-goog-api-key"], body: JSON.parse(Buffer.concat(chunks).toString()) }); res.writeHead(200, { "content-type": "application/json" }); res.end(reply().body); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture");
      const prepared = await prepareGoogleImageRequest(connection(), request(), [], now);
      const fixture = vi.fn(async () => { // TEST ONLY fixed loopback, not prepared.endpointUrl
        const response = await fetch(`http://127.0.0.1:${address.port}/fixture:generateContent`, { method: "POST", redirect: "error", headers: { "content-type": prepared.contentType, "x-goog-api-key": "fixed-not-a-key" }, body: prepared.body });
        return { status: response.status, contentType: response.headers.get("content-type")!, body: Buffer.from(await response.arrayBuffer()) }; });
      const session = new LocalImageProtocolSession<GoogleImagePreparedRequest>(fixture, 1000, parseGoogleImageResponse);
      const results = await Promise.all([session.run(request(), prepared), session.run(request(), prepared)]);
      expect(results.every((result) => result.candidate!.body.equals(jpeg))).toBe(true); expect(fixture).toHaveBeenCalledTimes(1);
      expect(received).toEqual([{ path: "/fixture:generateContent", auth: "fixed-not-a-key", body: JSON.parse(prepared.body.toString()) }]);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it("原生超时/断线/429 无隐式重试；真实执行固定关闭且不访问凭证", async () => {
    const prepared = await prepareGoogleImageRequest(connection(), request(), [], now);
    const pending = vi.fn(() => new Promise<ReturnType<typeof reply>>(() => {}));
    const session = new LocalImageProtocolSession<GoogleImagePreparedRequest>(pending, 10, parseGoogleImageResponse);
    expect((await session.run(request(), prepared)).outcome).toMatchObject({ failureCode: "image_response_timeout", billing: { state: "unknown" } });
    await session.run(request(), prepared); expect(pending).toHaveBeenCalledTimes(1);
    const lost = new LocalImageProtocolSession<GoogleImagePreparedRequest>(async () => { throw new Error("private-network-error"); }, 50, parseGoogleImageResponse);
    expect((await lost.run(request(), prepared)).outcome.failureCode).toBe("image_transport_uncertain");
    const resolver = vi.fn(); const transport = vi.fn();
    expect(() => { assertRealImageExecutionAllowed(); resolver(); transport(); }).toThrow("real_image_execution_disabled"); expect(resolver).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
});
