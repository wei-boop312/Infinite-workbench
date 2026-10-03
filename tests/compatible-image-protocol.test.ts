import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  ImageCompatibilityProfileSchema, ImageExecutionRequestSchema, ImageProviderConnectionSchema,
  type ImageCompatibilityProfile, type ImageExecutionRequest, type VerifiedImage,
} from "../packages/contracts/src/index";
import { imageProviderPublicView, requireImageConfirmation, validateImageProviderRequest, assertRealImageExecutionAllowed } from "../apps/api/src/imageProviderContract";
import { prepareCompatibleImageRequest, parseCompatibleImageResponse, type CompatibleImagePreparedRequest } from "../apps/api/src/compatibleImageProtocol";
import { encodeImageJson, MAX_IMAGE_PROTOCOL_REQUEST_BYTES, MAX_IMAGE_REFERENCE_CHARACTERS, prepareImagePayloadParts } from "../apps/api/src/imageRequestPayload";
import { LocalImageProtocolSession } from "./helpers/local-image-protocol-session";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const now = "2026-10-03T15:00:00Z";
function profile(encoding: ImageCompatibilityProfile["editEncoding"] = "json-images"): ImageCompatibilityProfile {
  return ImageCompatibilityProfileSchema.parse({ version: "relay-profile-v1", endpoints: { generate: "/images/generations", edit: "/images/edits" }, editEncoding: encoding,
    auth: { scheme: "bearer" }, responseEncoding: "images-b64-json-v1", extraParameters: [
      { name: "seed", type: "integer", minimum: 0, maximum: 1000, operations: ["generate"] },
      { name: "style_hint", type: "enum", values: ["studio", "natural"], operations: ["generate", "edit"] },
      { name: "watermark", type: "boolean", operations: ["generate", "edit"] },
    ] });
}
function connection(encoding: ImageCompatibilityProfile["editEncoding"] = "json-images") {
  return ImageProviderConnectionSchema.parse({ schemaVersion: 1, id: "relay-a", tenantId: "tenant-a", projectId: "project-a", name: "本地中转协议样例", revision: 1,
    protocol: "openai-compatible", adapterId: "relay-image-v1", baseUrl: "https://relay.invalid/gateway/v1/", credentialRef: "server-ref-never-resolved", enabled: true, compatibility: profile(encoding), diagnostic: { state: "not-run" },
    models: [{ model: "explicit-relay-model", version: "relay-caps-v1", operations: ["generate", "edit"], inputMimeTypes: ["image/png"], outputFormats: ["png"], maxPromptCharacters: 32000,
      maxInputImages: 20, maxInputEdge: 8192, maxInputPixels: 16000000, maxInputBytes: 30 * 1024 * 1024, maxTotalInputBytes: 100 * 1024 * 1024,
      sizes: { allowAuto: true, presets: [{ width: 1024, height: 1024 }] }, qualities: ["auto", "high"], backgrounds: ["auto", "opaque"], inputFidelities: [], supportsOutputCompression: false,
      mask: { mode: "prompt-guidance", polarity: "transparent-edit" }, evidence: { state: "declared" } }] });
}
function request(): ImageExecutionRequest {
  return ImageExecutionRequestSchema.parse({ schemaVersion: 1, tenantId: "tenant-a", projectId: "project-a", jobId: "job-a", idempotencyKey: "job-a-1", connectionId: "relay-a",
    connectionRevision: 1, adapterId: "relay-image-v1", model: "explicit-relay-model", capabilityVersion: "relay-caps-v1", constraintSnapshotId: "constraint-a", constraintChecksumSha256: "a".repeat(64),
    protection: "none", operation: "generate", inputs: [], parameters: { prompt: "人工指定商品背景", n: 1, size: "auto", quality: "high", outputFormat: "png", background: "opaque" },
    quote: { id: "quote-a", version: "manual-v1", source: "manual-budget", currency: "CNY", estimatedCostMinor: 25, maxCostMinor: 30, expiresAt: "2026-10-04T00:00:00Z" } });
}
function verified(id = "source", body = png, extra: Partial<VerifiedImage["asset"]> = {}): VerifiedImage {
  return { schemaVersion: 1, tenantId: "tenant-a", id: `proof-${id}`, asset: { id, projectId: "project-a", kind: "image", purpose: "source", originalName: "unsafe\"\r\nfilename.png",
    storageKey: "never-forwarded/local-file", mimeType: "image/png", byteSize: body.length, width: 1, height: 1, contentFingerprint: `sha256:${sha(body)}`, createdAt: now, ...extra },
    registeredMetadataSha256: "a".repeat(64), checksumSha256: sha(body), decoder: "sharp-full-decode-v1", verifiedBy: "fixture", verifiedAt: now };
}
const reference = (receipt: VerifiedImage) => ({ assetId: receipt.asset.id, checksumSha256: receipt.checksumSha256, mimeType: receipt.asset.mimeType, byteSize: receipt.asset.byteSize, width: receipt.asset.width, height: receipt.asset.height });
const edit = (receipts = [verified()]) => ImageExecutionRequestSchema.parse({ ...request(), operation: "edit", inputs: receipts.map(reference) });
const images = (receipts = [verified()]) => receipts.map((receipt) => ({ receipt, body: png }));
const reply = (json: unknown = { created: 1, data: [{ b64_json: png.toString("base64") }] }) => ({ status: 200, contentType: "application/json", requestId: "req-relay-fixture", body: Buffer.from(JSON.stringify(json)) });

describe("兼容中转显式差异与零费用假响应", () => {
  it("差异只来自严格声明，不允许脚本、任意鉴权头或 URL 响应猜测", () => {
    for (const patch of [{ script: "eval('never')" }, { auth: { scheme: "header", headerName: "host" } }, { auth: { scheme: "none" } }, { responseEncoding: "download-url" }, { editEncoding: "guess" }]) {
      expect(ImageCompatibilityProfileSchema.safeParse({ ...profile(), ...patch }).success).toBe(false);
    }
    expect(ImageProviderConnectionSchema.safeParse({ ...connection(), protocol: "openai" }).success).toBe(false);
    expect(ImageCompatibilityProfileSchema.safeParse({ ...profile(), extraParameters: [profile().extraParameters[0], profile().extraParameters[0]] }).success).toBe(false);
  });
  it("端点拒绝跨站绝对地址、查询、片段、转义、空段和目录穿越", () => {
    for (const path of ["https://other.invalid/generate", "//other.invalid/generate", "/images/../generate", "/images/%2e%2e/generate", "/images/edits?key=fake", "/images/edits#secret", "/images//edits", "/images\\edits", "/images/edits\r\nHost: other"]) {
      expect(ImageCompatibilityProfileSchema.safeParse({ ...profile(), endpoints: { ...profile().endpoints, generate: path } }).success).toBe(false);
    }
  });
  it("缺少差异配置即拒绝，不能靠列模型或连通诊断补出图片能力", async () => {
    const { compatibility: _, ...incomplete } = connection();
    await expect(prepareCompatibleImageRequest(incomplete, request(), [], now)).rejects.toThrow("image_compatibility_not_configured");
    const config = connection(); config.diagnostic = { state: "reachable", checkedAt: now, evidenceRef: "models-list-only" }; config.models[0].operations = ["generate"]; config.models[0].mask = { mode: "none", polarity: "unsupported" };
    await expect(prepareCompatibleImageRequest(config, edit(), images(), now)).rejects.toThrow("image_operation_unsupported");
    expect(imageProviderPublicView(config).models[0].evidence.state).toBe("declared");
  });
  it("额外参数按类型、枚举、范围和操作校验，保留 false 与 0", async () => {
    const input = { ...request(), providerParameters: { seed: 0, style_hint: "studio", watermark: false } };
    const prepared = await prepareCompatibleImageRequest(connection(), input, [], now);
    expect(JSON.parse(prepared.body.toString())).toMatchObject({ seed: 0, style_hint: "studio", watermark: false, n: 1, model: "explicit-relay-model" });
    for (const providerParameters of [{ seed: 1001 }, { seed: "0" }, { style_hint: "unknown" }, { watermark: "false" }, { undeclared: true }]) await expect(prepareCompatibleImageRequest(connection(), { ...request(), providerParameters }, [], now)).rejects.toThrow(/image_extra_parameter_(invalid|unsupported)/);
    await expect(prepareCompatibleImageRequest(connection(), { ...edit(), providerParameters: { seed: 0 } }, images(), now)).rejects.toThrow("image_extra_parameter_unsupported");
  });
  it("客户端额外参数不能覆盖模型、数量、蒙版、响应格式或鉴权，也没有任意嵌套对象", () => {
    for (const name of ["model", "n", "prompt", "size", "mask", "images", "stream", "response_format", "headers", "authorization", "api_key", "constructor", "prototype", "__proto__"]) {
      expect(ImageCompatibilityProfileSchema.safeParse({ ...profile(), extraParameters: [{ name, type: "boolean", operations: ["generate"] }] }).success).toBe(false);
      expect(ImageExecutionRequestSchema.safeParse({ ...request(), providerParameters: Object.fromEntries([[name, true]]) }).success).toBe(false);
    }
    expect(ImageExecutionRequestSchema.safeParse({ ...request(), providerParameters: { options: { code: "never" } } }).success).toBe(false);
    expect(ImageExecutionRequestSchema.safeParse({ ...request(), providerParameters: { seed: 0.5 } }).success).toBe(false);
    expect(ImageCompatibilityProfileSchema.safeParse({ ...profile(), extraParameters: [{ name: "seed", type: "integer", minimum: 2, maximum: 1, operations: ["generate"] }] }).success).toBe(false);
  });
  it("JSON 生成/编辑只用冻结显式路径与 API root，不自动切换协议", async () => {
    const config = connection(); config.compatibility!.endpoints = { generate: "/custom/render.json", edit: "/custom/edit.json" };
    const prepared = await prepareCompatibleImageRequest(config, edit(), images(), now);
    expect(prepared.endpointUrl).toBe("https://relay.invalid/gateway/v1/custom/edit.json"); expect(prepared.contentType).toBe("application/json");
    expect(JSON.parse(prepared.body.toString())).toMatchObject({ n: 1, images: [{ image_url: expect.stringMatching(/^data:image\/png;base64,/) }] });
    expect(prepared.authPlan).toEqual({ scheme: "bearer", credentialRef: "server-ref-never-resolved" });
    expect(prepared.payloadChecksumSha256).toBe(sha(prepared.body));
    const generated = await prepareCompatibleImageRequest(config, request(), [], now);
    expect(generated.endpointUrl).toBe("https://relay.invalid/gateway/v1/custom/render.json");
    expect(JSON.parse(generated.body.toString())).not.toHaveProperty("images");
    for (const suffix of ["?", "#"]) {
      const edge = { ...config, baseUrl: `https://relay.invalid/gateway/v1${suffix}` };
      expect((await prepareCompatibleImageRequest(edge, request(), [], now)).endpointUrl).toBe("https://relay.invalid/gateway/v1/custom/render.json");
    }
  });
  it("多文件表单实际二进制逐个可解析，文件名不能带用户路径或头注入", async () => {
    const receipts = [verified(), verified("second")];
    const prepared = await prepareCompatibleImageRequest(connection("multipart-image-array"), { ...edit(receipts), providerParameters: { watermark: false } }, images(receipts), now);
    const form = await new Response(prepared.body, { headers: { "content-type": prepared.contentType } }).formData();
    expect(form.get("model")).toBe("explicit-relay-model"); expect(form.get("n")).toBe("1"); expect(form.get("watermark")).toBe("false");
    expect(form.getAll("image[]")).toHaveLength(2); expect(form.get("images")).toBeNull();
    for (const [index, value] of form.getAll("image[]").entries()) {
      if (typeof value === "string") throw new Error("fixture expected file");
      expect(value.name).toBe(`input-${index + 1}.png`); expect(value.type).toBe("image/png");
      const body = Buffer.from(await value.arrayBuffer()); expect(prepared.transformedInputs[index].transmittedChecksumSha256).toBe(sha(body));
      expect(await sharp(body).metadata()).toMatchObject({ width: 1, height: 1, format: "png" });
    }
    expect(prepared.body.toString()).not.toContain("unsafe"); expect(prepared.body.toString()).not.toContain("never-forwarded");
  });
  it("单文件表单拒绝多输入而不是丢弃参考图；生成仍使用 JSON", async () => {
    const receipts = [verified(), verified("second")];
    await expect(prepareCompatibleImageRequest(connection("multipart-image-single"), edit(receipts), images(receipts), now)).rejects.toThrow("image_single_input_required");
    const prepared = await prepareCompatibleImageRequest(connection("multipart-image-single"), edit(), images(), now);
    const form = await new Response(prepared.body, { headers: { "content-type": prepared.contentType } }).formData(); expect(form.getAll("image")).toHaveLength(1); expect(form.get("image[]")).toBeNull();
    expect((await prepareCompatibleImageRequest(connection("multipart-image-single"), request(), [], now)).contentType).toBe("application/json");
  });
  it("两种已声明蒙版极性分别转换，未知极性拒绝，硬像素保护始终关闭", async () => {
    const maskBody = await sharp({ create: { width: 1, height: 1, channels: 4, background: "white" } }).png().toBuffer();
    const maskReceipt = verified("mask", maskBody, { purpose: "mask", sourceAssetId: "source" }); maskReceipt.sourceChecksumSha256 = sha(png);
    const input = edit(); if (input.operation !== "edit") throw new Error("fixture"); input.mask = reference(maskReceipt);
    const files = [...images(), { receipt: maskReceipt, body: maskBody }];
    for (const polarity of ["transparent-edit", "white-edit"] as const) {
      const config = connection("multipart-image-array"); config.models[0].mask.polarity = polarity;
      const prepared = await prepareCompatibleImageRequest(config, input, files, now);
      const form = await new Response(prepared.body, { headers: { "content-type": prepared.contentType } }).formData(); const mask = form.get("mask");
      if (!mask || typeof mask === "string") throw new Error("fixture expected mask");
      const pixels = await sharp(Buffer.from(await mask.arrayBuffer())).ensureAlpha().raw().toBuffer(); expect(pixels[3]).toBe(polarity === "transparent-edit" ? 0 : 255);
      expect(prepared.transformedInputs[1].transform).toBe(polarity === "transparent-edit" ? "internal-white-to-transparent-mask-v1" : "internal-white-mask-v1");
    }
    const unknown = connection(); unknown.models[0].mask.polarity = "unverified";
    await expect(prepareCompatibleImageRequest(unknown, input, files, now)).rejects.toThrow("image_mask_unsupported");
    await expect(prepareCompatibleImageRequest(connection(), { ...input, protection: "pixel-exact" }, files, now)).rejects.toThrow("image_pixel_protection_not_configured");
  });
  it("表单边界和负载可重放；任一连接/鉴权/格式/白名单/参数变化都使旧确认失效", async () => {
    const config = connection("multipart-image-array"); const input = edit();
    const prepared = await prepareCompatibleImageRequest(config, input, images(), now); const again = await prepareCompatibleImageRequest(config, input, images(), now);
    expect(again.body.equals(prepared.body)).toBe(true); expect(again.contentType).toBe(prepared.contentType);
    for (const change of [
      { ...config, baseUrl: "https://other-relay.invalid/v1" },
      { ...config, compatibility: { ...config.compatibility!, version: "relay-v2" } },
      { ...config, compatibility: { ...config.compatibility!, editEncoding: "json-images" as const } },
      { ...config, compatibility: { ...config.compatibility!, auth: { scheme: "header" as const, headerName: "x-api-key" as const } } },
      { ...config, compatibility: { ...config.compatibility!, extraParameters: [] } },
    ]) expect(() => requireImageConfirmation(change, input, prepared.requestFingerprint, now)).toThrow("image_confirmation_changed");
    expect(() => requireImageConfirmation(config, { ...input, providerParameters: { watermark: false } }, prepared.requestFingerprint, now)).toThrow("image_confirmation_changed");
  });
  it("白名单变更或跨项目不能复用旧参数，公开视图不含差异配置和凭证", async () => {
    const config = connection(); config.compatibility!.extraParameters = [];
    await expect(prepareCompatibleImageRequest(config, { ...request(), providerParameters: { seed: 0 } }, [], now)).rejects.toThrow("image_extra_parameter_unsupported");
    await expect(prepareCompatibleImageRequest(connection(), { ...request(), projectId: "foreign" }, [], now)).rejects.toThrow("image_connection_not_found");
    expect(JSON.stringify(imageProviderPublicView(connection()))).not.toMatch(/server-ref|gateway|extraParameters|x-api-key/);
    const official = { ...connection(), protocol: "openai" as const, compatibility: undefined };
    expect(() => validateImageProviderRequest(official, { ...request(), providerParameters: { seed: 0 } }, now)).toThrow("image_extra_parameter_unsupported");
  });
  it("复用严格结果解析；未知异步包、URL、错误和缺用量都不能变成免费成功", () => {
    for (const json of [{ task_id: "async-job", status: "running" }, { created: 1, data: [{ url: "https://private.invalid/image" }] }, { created: 1, data: [{ b64_json: "invalid" }] }]) {
      const result = parseCompatibleImageResponse(request(), "a".repeat(64), reply(json)); expect(result.outcome.billing.state).toBe("unknown"); expect(result.candidate).toBeUndefined();
    }
    const success = parseCompatibleImageResponse(request(), "a".repeat(64), reply());
    expect(success.outcome).toMatchObject({ usage: { source: "unavailable" }, billing: { state: "unknown" }, artifactStatus: "pending-validation" });
  });
  it("JSON 引用及总请求大小有界，表单不以 Base64 膨胀文件", () => {
    const empty = { fields: { model: "fixture", n: 1 }, transformedInputs: [] };
    expect(() => encodeImageJson({ ...empty, images: [] }, { n: 2 })).toThrow("image_extra_parameter_reserved");
    const large = Buffer.alloc(Math.ceil(MAX_IMAGE_REFERENCE_CHARACTERS * 3 / 4));
    expect(() => encodeImageJson({ ...empty, images: [{ assetId: "too-large", body: large }] })).toThrow("image_reference_too_large");
    const bounded = Buffer.alloc(14 * 1024 * 1024);
    expect(() => encodeImageJson({ ...empty, images: [1, 2, 3, 4].map((id) => ({ assetId: `large-${id}`, body: bounded })) })).toThrow("image_request_too_large");
    expect(MAX_IMAGE_PROTOCOL_REQUEST_BYTES).toBe(64 * 1024 * 1024);
  });
  it("回环假服务分别收到 JSON 与可解析表单，鉴权方案只用固定假凭证测试", async () => {
    const received: Array<{ path: string; auth?: string; model: unknown; imageCount: number }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
      if (req.headers["content-type"]?.startsWith("multipart/form-data")) {
        const form = await new Response(body, { headers: { "content-type": req.headers["content-type"] } }).formData();
        received.push({ path: req.url!, auth: req.headers["x-api-key"] as string, model: form.get("model"), imageCount: form.getAll("image[]").length });
      } else { const json = JSON.parse(body.toString()); received.push({ path: req.url!, auth: req.headers.authorization, model: json.model, imageCount: json.images?.length ?? 0 }); }
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "local-relay-1" }); res.end(reply().body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture");
      for (const encoding of ["json-images", "multipart-image-array"] as const) {
        const config = connection(encoding); if (encoding !== "json-images") config.compatibility!.auth = { scheme: "header", headerName: "x-api-key" };
        const input = edit(); const prepared = await prepareCompatibleImageRequest(config, input, images(), now);
        const session = new LocalImageProtocolSession<CompatibleImagePreparedRequest>(async () => {
          // TEST ONLY fixed loopback destination, not prepared.endpointUrl.
          const response = await fetch(`http://127.0.0.1:${address.port}/fixture/edits`, { method: "POST", redirect: "error", headers: { "content-type": prepared.contentType,
            ...(prepared.authPlan.scheme === "bearer" ? { authorization: "Bearer fixed-not-a-key" } : { [prepared.authPlan.headerName]: "fixed-not-a-key" }) }, body: prepared.body });
          return { status: response.status, contentType: response.headers.get("content-type")!, requestId: response.headers.get("x-request-id")!, body: Buffer.from(await response.arrayBuffer()) };
        }, 1000);
        const result = await session.run(input, prepared); await session.run(input, prepared);
        expect(result.outcome).toMatchObject({ providerRequestId: "local-relay-1", billing: { state: "unknown" }, artifactStatus: "pending-validation" });
      }
      expect(received).toEqual([
        { path: "/fixture/edits", auth: "Bearer fixed-not-a-key", model: "explicit-relay-model", imageCount: 1 },
        { path: "/fixture/edits", auth: "fixed-not-a-key", model: "explicit-relay-model", imageCount: 1 },
      ]);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it("配置中转请求仍不能解析真实凭证或启用传输，损坏输入先拒绝", async () => {
    const config = connection(); const resolver = vi.fn(); const transport = vi.fn();
    await prepareCompatibleImageRequest(config, request(), [], now);
    expect(() => { assertRealImageExecutionAllowed(); resolver(config.credentialRef); transport(); }).toThrow("real_image_execution_disabled"); expect(resolver).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
    await expect(prepareImagePayloadParts(edit(), config.models[0], [{ receipt: verified(), body: Buffer.from("changed") }], "declared")).rejects.toThrow("image_input_bytes_changed");
  });
  it("中转假响应超时和 429 都保留未知计费，重放没有隐式重试或换模型", async () => {
    const config = connection(); const input = request(); const prepared = await prepareCompatibleImageRequest(config, input, [], now);
    const pending = vi.fn(() => new Promise<ReturnType<typeof reply>>(() => {}));
    const session = new LocalImageProtocolSession<CompatibleImagePreparedRequest>(pending, 10);
    const fixtureRequest = prepared;
    expect((await session.run(input, fixtureRequest)).outcome).toMatchObject({ failureCode: "image_response_timeout", billing: { state: "unknown" } });
    await session.run(input, fixtureRequest); expect(pending).toHaveBeenCalledTimes(1);
    const limited = parseCompatibleImageResponse(input, prepared.requestFingerprint, { ...reply({ error: { message: "private-provider-message" } }), status: 429 });
    expect(limited.outcome).toMatchObject({ providerStatus: "rejected", billing: { state: "unknown" } }); expect(JSON.stringify(limited)).not.toContain("private-provider-message");
  });
});
