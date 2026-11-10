import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { ImageExecutionRequestSchema, ImageProviderConnectionSchema, type ImageExecutionRequest, type VerifiedImage } from "../packages/contracts/src/index";
import {
  MAX_IMAGE_PROTOCOL_RESPONSE_BYTES, parseOpenAiImageResponse, prepareOpenAiImageRequest,
  type ImageProtocolResponse, type PreparedImageProtocolRequest,
} from "../apps/api/src/openaiImageProtocol";
import { assertRealImageExecutionAllowed } from "../apps/api/src/imageProviderContract";
import { LocalImageProtocolSession } from "./helpers/local-image-protocol-session";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const now = "2026-10-03T14:00:00Z";
function connection() {
  return ImageProviderConnectionSchema.parse({ schemaVersion: 1, id: "official-fixture", tenantId: "tenant-a", projectId: "project-a", name: "官方协议本地夹具", revision: 1,
    protocol: "openai", adapterId: "openai-image-json-v1", baseUrl: "https://api.openai.com/v1", credentialRef: "never-resolved", enabled: true, diagnostic: { state: "not-run" },
    models: [{ model: "fixture-explicit-model", version: "caps-v1", operations: ["generate", "edit"], inputMimeTypes: ["image/png", "image/jpeg"], outputFormats: ["png", "jpeg", "webp"],
      maxPromptCharacters: 32000, maxInputImages: 16, maxInputEdge: 8192, maxInputPixels: 16000000, maxInputBytes: 30 * 1024 * 1024, maxTotalInputBytes: 100 * 1024 * 1024,
      sizes: { allowAuto: true, presets: [{ width: 1024, height: 1024 }] }, qualities: ["auto", "high"], backgrounds: ["auto", "opaque", "transparent"], inputFidelities: ["high"], supportsOutputCompression: true,
      mask: { mode: "prompt-guidance", polarity: "transparent-edit" }, evidence: { state: "local-fixture-passed", evidenceRef: "test-only", checkedAt: now } }],
  });
}
function request(): ImageExecutionRequest {
  return ImageExecutionRequestSchema.parse({ schemaVersion: 1, tenantId: "tenant-a", projectId: "project-a", jobId: "job-a", idempotencyKey: "job-a-1", connectionId: "official-fixture",
    connectionRevision: 1, adapterId: "openai-image-json-v1", model: "fixture-explicit-model", capabilityVersion: "caps-v1", constraintSnapshotId: "constraint-a", constraintChecksumSha256: "a".repeat(64),
    protection: "none", operation: "generate", inputs: [], parameters: { prompt: "人工确认的背景指令", n: 1, size: "auto", quality: "high", outputFormat: "png", background: "opaque" },
    quote: { id: "quote-a", version: "manual-v1", source: "manual-budget", currency: "CNY", estimatedCostMinor: 25, maxCostMinor: 30, expiresAt: "2026-10-04T00:00:00Z" } });
}
function verified(body = png, extra: Partial<VerifiedImage["asset"]> = {}): VerifiedImage {
  return { schemaVersion: 1, tenantId: "tenant-a", id: "proof-a", asset: { id: "source", projectId: "project-a", kind: "image", purpose: "source", originalName: "not-forwarded.png",
    storageKey: "local-verified/source", mimeType: "image/png", byteSize: body.length, width: 1, height: 1, contentFingerprint: `sha256:${hash(body)}`, createdAt: now, ...extra },
    registeredMetadataSha256: "a".repeat(64), checksumSha256: hash(body), decoder: "sharp-full-decode-v1", verifiedBy: "server-fixture", verifiedAt: now };
}
function inputRef(receipt: VerifiedImage) { return { assetId: receipt.asset.id, checksumSha256: receipt.checksumSha256, mimeType: receipt.asset.mimeType, byteSize: receipt.asset.byteSize, width: receipt.asset.width, height: receipt.asset.height }; }
function edit(receipts: VerifiedImage[]): ImageExecutionRequest {
  return ImageExecutionRequestSchema.parse({ ...request(), operation: "edit", inputs: receipts.map(inputRef), parameters: { ...request().parameters, inputFidelity: "high" } });
}
function response(json: unknown = { created: 1791036000, data: [{ b64_json: png.toString("base64") }] }, extra: Partial<ImageProtocolResponse> = {}): ImageProtocolResponse {
  return { status: 200, contentType: "application/json; charset=utf-8", requestId: "req-fixture-1", body: Buffer.from(JSON.stringify(json)), ...extra };
}
const prepare = (input = request()) => prepareOpenAiImageRequest(connection(), input, [], now);
const parse = (reply: ImageProtocolResponse) => parseOpenAiImageResponse(request(), "a".repeat(64), reply);

describe("官方图片纯协议和本地假响应", () => {
  it("显式 JSON 生成参数固定单输出，不附加凭证、重试或默认模型", async () => {
    const prepared = await prepare();
    expect(prepared).toMatchObject({ method: "POST", path: "/images/generations", contentType: "application/json", transformedInputs: [] });
    expect(JSON.parse(prepared.body.toString())).toEqual({ model: "fixture-explicit-model", prompt: "人工确认的背景指令", n: 1, size: "auto", quality: "high", output_format: "png", background: "opaque" });
    expect(prepared.payloadChecksumSha256).toBe(hash(prepared.body));
    expect(JSON.stringify(prepared)).not.toMatch(/never-resolved|Authorization|Bearer|https:\/\//);
    const input = request(); input.parameters = { ...input.parameters, size: { width: 1024, height: 1024 }, outputFormat: "webp", outputCompression: 0 };
    expect(JSON.parse((await prepare(input)).body.toString())).toMatchObject({ size: "1024x1024", output_compression: 0 });
  });
  it("编辑使用服务端实际原文件，转换为 PNG 并保留转换前后摘要", async () => {
    const receipt = verified(); const prepared = await prepareOpenAiImageRequest(connection(), edit([receipt]), [{ receipt, body: png }], now);
    const json = JSON.parse(prepared.body.toString());
    expect(prepared.path).toBe("/images/edits"); expect(json).toMatchObject({ input_fidelity: "high", images: [{ image_url: expect.stringMatching(/^data:image\/png;base64,/) }] });
    expect(json).not.toHaveProperty("image"); expect(prepared.transformedInputs[0]).toMatchObject({ assetId: "source", originalChecksumSha256: hash(png), transform: "exif-srgb-png-v1" });
    const bytes = Buffer.from(json.images[0].image_url.split(",")[1], "base64");
    expect(prepared.transformedInputs[0].transmittedChecksumSha256).toBe(hash(bytes));
    expect(await sharp(bytes).metadata()).toMatchObject({ format: "png", width: 1, height: 1 });
  });
  it("EXIF 旋转归一化后尺寸和坐标一致，不发送原文件路径", async () => {
    const body = await sharp({ create: { width: 2, height: 3, channels: 3, background: "red" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const receipt = verified(body, { width: 3, height: 2, mimeType: "image/jpeg" });
    const prepared = await prepareOpenAiImageRequest(connection(), edit([receipt]), [{ receipt, body }], now);
    const bytes = Buffer.from(JSON.parse(prepared.body.toString()).images[0].image_url.split(",")[1], "base64");
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 3, height: 2, format: "png" });
    expect(prepared.body.toString()).not.toContain("not-forwarded");
  });
  it("内部白色编辑蒙版转换极性并保留抗锯齿，绑定第一张底图", async () => {
    const sourceBody = await sharp({ create: { width: 3, height: 1, channels: 4, background: "red" } }).png().toBuffer();
    const maskBody = await sharp(Buffer.from([0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 128]), { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
    const sourceReceipt = verified(sourceBody, { width: 3 });
    const maskReceipt = verified(maskBody, { id: "mask", purpose: "mask", sourceAssetId: "source", width: 3 }); maskReceipt.sourceChecksumSha256 = hash(sourceBody);
    const input = edit([sourceReceipt]); if (input.operation !== "edit") throw new Error("fixture"); input.mask = inputRef(maskReceipt);
    const prepared = await prepareOpenAiImageRequest(connection(), input, [{ receipt: sourceReceipt, body: sourceBody }, { receipt: maskReceipt, body: maskBody }], now);
    const json = JSON.parse(prepared.body.toString());
    const converted = await sharp(Buffer.from(json.mask.image_url.split(",")[1], "base64")).ensureAlpha().raw().toBuffer();
    expect([converted[3], converted[7], converted[11]]).toEqual([255, 0, 127]);
    expect(prepared.transformedInputs[1]).toMatchObject({ assetId: "mask", transform: "internal-white-to-transparent-mask-v1", originalChecksumSha256: hash(maskBody) });
  });
  it("拒绝错误蒙版语义、原文件变更或缺失，不能用证明/缩略图绕过", async () => {
    const receipt = verified(); const input = edit([receipt]);
    await expect(prepareOpenAiImageRequest(connection(), input, [], now)).rejects.toThrow("image_input_not_verified");
    await expect(prepareOpenAiImageRequest(connection(), input, [{ receipt, body: Buffer.from("thumbnail") }], now)).rejects.toThrow("image_input_bytes_changed");
    const badBody = await sharp({ create: { width: 1, height: 1, channels: 4, background: "black" } }).png().toBuffer();
    const maskReceipt = verified(badBody, { id: "mask", purpose: "mask", sourceAssetId: "source" }); maskReceipt.sourceChecksumSha256 = hash(png);
    if (input.operation !== "edit") throw new Error("fixture"); input.mask = inputRef(maskReceipt);
    const files = [{ receipt, body: png }, { receipt: maskReceipt, body: badBody }];
    await expect(prepareOpenAiImageRequest(connection(), input, files, now)).rejects.toThrow("image_internal_mask_invalid");
    const config = connection(); config.models[0].mask.polarity = "white-edit";
    await expect(prepareOpenAiImageRequest(config, input, files, now)).rejects.toThrow("image_mask_conversion_unsupported");
  });
  it("不把中转站和非 OpenAI 协议伪装成官方协议", async () => {
    for (const protocol of ["openai-compatible", "google", "custom"] as const) await expect(prepareOpenAiImageRequest({ ...connection(), protocol }, request(), [], now)).rejects.toThrow("image_protocol_mismatch");
    const config = connection(); config.models[0].inputMimeTypes = ["image/jpeg"];
    await expect(prepareOpenAiImageRequest(config, edit([verified(png, { mimeType: "image/jpeg" })]), [{ receipt: verified(png, { mimeType: "image/jpeg" }), body: png }], now)).rejects.toThrow("image_normalization_format_unsupported");
  });
  it("转换后的单文件/累计大小重新受限，声明尺寸不能覆盖实际解码尺寸", async () => {
    const receipt = verified(); const config = connection(); config.models[0].maxInputBytes = png.length;
    await expect(prepareOpenAiImageRequest(config, edit([receipt]), [{ receipt, body: png }], now)).rejects.toThrow("image_transformed_bytes_exceeded");
    const second = verified(png, { id: "second" }); const limited = connection(); limited.models[0].maxTotalInputBytes = png.length * 2;
    await expect(prepareOpenAiImageRequest(limited, edit([receipt, second]), [{ receipt, body: png }, { receipt: second, body: png }], now)).rejects.toThrow("image_transformed_total_bytes_exceeded");
    const incorrect = verified(png, { width: 2 });
    await expect(prepareOpenAiImageRequest(connection(), edit([incorrect]), [{ receipt: incorrect, body: png }], now)).rejects.toThrow("image_normalized_dimensions_changed");
    const malformed = Buffer.from("broken-image"); const bad = verified(malformed);
    await expect(prepareOpenAiImageRequest(connection(), edit([bad]), [{ receipt: bad, body: malformed }], now)).rejects.toThrow("image_input_decode_failed");
  });
  it("缺用量保留 unknown 计费；响应字节只是候选产物，不是资产或成功任务", () => {
    const result = parse(response());
    expect(result.outcome).toMatchObject({ providerRequestId: "req-fixture-1", providerStatus: "returned", artifactStatus: "pending-validation", usage: { source: "unavailable" }, billing: { state: "unknown" } });
    expect(result.candidate).toMatchObject({ body: png, mimeType: "image/png", checksumSha256: hash(png) });
    expect(JSON.stringify(result.outcome)).not.toMatch(/b64_json|assetId|base64/);
  });
  it("实报 token 不等于费用，不忽略用量类型或总数错误", () => {
    const usage = { input_tokens: 50, output_tokens: 10, total_tokens: 60, input_tokens_details: { image_tokens: 40, text_tokens: 10 } };
    expect(parse(response({ created: 1, data: [{ b64_json: png.toString("base64") }], usage })).outcome).toMatchObject({ usage: { source: "provider-reported", metrics: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } }, billing: { state: "unknown" } });
    for (const invalid of [null, {}, { ...usage, total_tokens: 0 }, { ...usage, input_tokens: "50" }, { ...usage, output_tokens: -1 }, { ...usage, input_tokens_details: { image_tokens: 0, text_tokens: 0 } }]) {
      expect(parse(response({ created: 1, data: [{ b64_json: png.toString("base64") }], usage: invalid })).outcome).toMatchObject({ failureCode: "image_usage_invalid", billing: { state: "unknown" } });
    }
  });
  it("HTTP 拒绝、重定向或服务异常都不证明免费，绝不跟随下载图片 URL", () => {
    for (const status of [301, 400, 401, 429, 500]) expect(parse(response({ error: { message: "untrusted secret text" } }, { status })).outcome).toMatchObject({ providerStatus: "rejected", failureCode: "image_provider_http_error", billing: { state: "unknown" } });
    expect(parse(response({ created: 1, data: [{ url: "https://private.invalid/image" }] })).outcome.failureCode).toBe("image_base64_required");
    expect(JSON.stringify(parse(response(undefined, { status: 401 })))).not.toContain("untrusted secret");
  });
  it("拒绝错误类型、非 UTF8、坏 JSON、重复输出、超限和非规范 Base64", () => {
    expect(parse(response(undefined, { contentType: "text/html" })).outcome.failureCode).toBe("image_response_content_type_invalid");
    expect(parse(response(undefined, { body: Buffer.from([255, 254]) })).outcome.failureCode).toBe("image_response_json_invalid");
    expect(parse(response(undefined, { body: Buffer.from("not-json") })).outcome.failureCode).toBe("image_response_json_invalid");
    expect(parse(response({ created: 1, data: [{ b64_json: png.toString("base64") }, { b64_json: png.toString("base64") }] })).outcome.failureCode).toBe("image_response_shape_invalid");
    expect(parse(response(undefined, { body: Buffer.alloc(MAX_IMAGE_PROTOCOL_RESPONSE_BYTES + 1) })).outcome.failureCode).toBe("image_response_too_large");
    for (const encoded of ["%%%notbase64", "data:image/png;base64," + png.toString("base64"), "AB==", png.toString("base64") + "\n"]) expect(parse(response({ created: 1, data: [{ b64_json: encoded }] })).outcome.failureCode).toBe("image_base64_invalid");
  });
  it("明显坏图和格式变化保留未知扣费；仅有魔数的截断图仍须后续完整解码", () => {
    expect(parse(response({ created: 1, data: [{ b64_json: Buffer.from("not-image").toString("base64") }] })).outcome).toMatchObject({ artifactStatus: "invalid", failureCode: "image_output_magic_invalid", billing: { state: "unknown" } });
    expect(parse(response({ created: 1, output_format: "webp", data: [{ b64_json: png.toString("base64") }] })).outcome.failureCode).toBe("image_output_format_changed");
    const truncated = parse(response({ created: 1, data: [{ b64_json: png.subarray(0, 8).toString("base64") }] }));
    expect(truncated.outcome.artifactStatus).toBe("pending-validation");
    expect(truncated.outcome.billing.state).toBe("unknown");
  });
  it("未知增量元数据不污染产物、日志或请求编号", () => {
    const result = parse(response({ created: 1, data: [{ b64_json: png.toString("base64"), unsafe: "private" }], extra: "untrusted" }, { requestId: "Bearer untrusted-private-text\n" }));
    expect(result.outcome.artifactStatus).toBe("pending-validation"); expect(result.outcome.providerRequestId).toBeUndefined();
    expect(JSON.stringify(result.outcome)).not.toMatch(/private|untrusted/);
  });
  it("本地假传输并发与重复响应重放只发一次，没有自动重试或模型切换", async () => {
    const fixture = vi.fn(async () => response()); const session = new LocalImageProtocolSession(fixture);
    const input = request(); const prepared = await prepare(input);
    const results = await Promise.all([session.run(input, prepared), session.run(input, prepared)]);
    expect(results[0]).toEqual(results[1]); expect(await session.run(input, prepared)).toEqual(results[0]);
    expect(fixture).toHaveBeenCalledTimes(1);
    expect(() => session.run(input, { ...prepared, requestFingerprint: "b".repeat(64) })).toThrow("fixture_confirmation_changed");
    expect(() => session.run(input, { ...prepared, body: Buffer.from("changed") })).toThrow("fixture_payload_changed");
  });
  it("假传输超时/断线后保留 unknown、终止等待且重复点击不发第二次", async () => {
    let signal: AbortSignal | undefined;
    const late = vi.fn((_prepared: PreparedImageProtocolRequest, value: AbortSignal) => { signal = value; return new Promise<ImageProtocolResponse>(() => {}); });
    const session = new LocalImageProtocolSession(late, 10); const input = request(); const prepared = await prepare();
    expect((await session.run(input, prepared)).outcome).toMatchObject({ providerStatus: "unknown", failureCode: "image_response_timeout", billing: { state: "unknown" } });
    expect(signal?.aborted).toBe(true); await session.run(input, prepared); expect(late).toHaveBeenCalledTimes(1);
    const disconnected = vi.fn(async () => { throw new Error("fake private text"); }); const failed = new LocalImageProtocolSession(disconnected);
    const result = await failed.run(input, prepared); expect(result.outcome.failureCode).toBe("image_transport_uncertain"); expect(JSON.stringify(result)).not.toContain("private");
    await failed.run(input, prepared); expect(disconnected).toHaveBeenCalledTimes(1);
  });
  it("回环假服务整合：实际 HTTP 接收冻结请求和固定假凭证，响应只解析一次", async () => {
    let received: unknown; let calls = 0; let authorization: string | undefined;
    const server = createServer(async (req, res) => {
      calls++; authorization = req.headers.authorization;
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "req-local-http" }); res.end(response().body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture server");
      // The test injects only this explicitly bound loopback URL. Production
      // configuration/SSRF policies are not relaxed to allow test HTTP.
      const fixture = async (prepared: PreparedImageProtocolRequest, signal: AbortSignal): Promise<ImageProtocolResponse> => {
        const reply = await fetch(`http://127.0.0.1:${address.port}${prepared.path}`, { method: prepared.method, signal, redirect: "error",
          headers: { "content-type": prepared.contentType, authorization: "Bearer fixed-local-fixture-not-a-key" }, body: prepared.body });
        return { status: reply.status, contentType: reply.headers.get("content-type") ?? "", requestId: reply.headers.get("x-request-id") ?? undefined, body: Buffer.from(await reply.arrayBuffer()) };
      };
      const session = new LocalImageProtocolSession(fixture, 1000); const input = request(); const prepared = await prepare();
      const result = await session.run(input, prepared); await session.run(input, prepared);
      expect(calls).toBe(1); expect(authorization).toBe("Bearer fixed-local-fixture-not-a-key"); expect(received).toMatchObject({ n: 1, model: "fixture-explicit-model" });
      expect(result.outcome).toMatchObject({ providerRequestId: "req-local-http", artifactStatus: "pending-validation", billing: { state: "unknown" } });
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it("协议准备不解锁真实执行，也不解析 credentialRef", async () => {
    await prepare(); const resolver = vi.fn();
    expect(() => { assertRealImageExecutionAllowed(); resolver(); }).toThrow("real_image_execution_disabled"); expect(resolver).not.toHaveBeenCalled();
  });
});
