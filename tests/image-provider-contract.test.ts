import { describe, expect, it, vi } from "vitest";
import {
  ImageExecutionRequestSchema, ImageProviderConnectionSchema, ImageProviderOutcomeSchema,
  ImageUsageSchema, type ImageExecutionRequest, type ImageProviderConnection, type VerifiedImage,
} from "../packages/contracts/src/index";
import {
  assertRealImageExecutionAllowed, imageConfirmationFingerprint, imageProviderPublicView,
  requireImageConfirmation, validateImageProviderInputs, validateImageProviderRequest,
} from "../apps/api/src/imageProviderContract";
import { createApiServer } from "../apps/api/src/index";

const now = "2026-10-03T14:00:00Z";
const sha = "a".repeat(64);
const source = { assetId: "source", checksumSha256: sha, mimeType: "image/png" as const, byteSize: 100, width: 1024, height: 1024 };
function connection(): ImageProviderConnection {
  return ImageProviderConnectionSchema.parse({
    schemaVersion: 1, id: "provider-a", tenantId: "tenant-a", projectId: "project-a", name: "本地合同样例",
    revision: 1, protocol: "openai", adapterId: "image-adapter-v1", baseUrl: "https://provider.invalid/v1", credentialRef: "credential-reference-only", enabled: true,
    diagnostic: { state: "not-run" },
    models: [{ model: "fixture-image-model", version: "capability-1", operations: ["generate", "edit"],
      inputMimeTypes: ["image/png", "image/jpeg"], outputFormats: ["png", "jpeg", "webp"], maxInputImages: 2,
      maxInputBytes: 1000, maxTotalInputBytes: 2000, maxPromptCharacters: 4000, maxInputEdge: 2048, maxInputPixels: 2097152,
      sizes: { allowAuto: true, presets: [{ width: 1024, height: 1024 }], custom: { minEdge: 256, maxEdge: 2048, multipleOf: 16, minPixels: 65536, maxPixels: 2097152, maxAspectRatio: 3 } },
      qualities: ["auto", "high"], backgrounds: ["auto", "opaque", "transparent"], inputFidelities: ["high"], supportsOutputCompression: true,
      mask: { mode: "prompt-guidance", polarity: "transparent-edit" }, evidence: { state: "declared" },
    }],
  });
}
function request(): ImageExecutionRequest {
  return ImageExecutionRequestSchema.parse({
    schemaVersion: 1, tenantId: "tenant-a", projectId: "project-a", jobId: "job-a", idempotencyKey: "job-a-attempt-1",
    connectionId: "provider-a", connectionRevision: 1, adapterId: "image-adapter-v1", model: "fixture-image-model", capabilityVersion: "capability-1",
    constraintSnapshotId: "constraint-a", constraintChecksumSha256: sha, protection: "none", operation: "edit", inputs: [source],
    parameters: { prompt: "仅修改背景", n: 1, size: { width: 1024, height: 1024 }, quality: "high", outputFormat: "png", background: "auto", inputFidelity: "high" },
    quote: { id: "quote-a", version: "price-1", source: "manual-budget", currency: "CNY", estimatedCostMinor: 25, maxCostMinor: 30, expiresAt: "2026-10-04T14:00:00Z" },
  });
}
function receipt(extra: Partial<VerifiedImage> = {}): VerifiedImage {
  return { schemaVersion: 1, id: "receipt-a", tenantId: "tenant-a",
    asset: { id: "source", projectId: "project-a", kind: "image", purpose: "source", originalName: "source.png", storageKey: "server-verified/source",
      mimeType: "image/png", byteSize: 100, width: 1024, height: 1024, contentFingerprint: `sha256:${sha}`, createdAt: now },
    registeredMetadataSha256: sha, checksumSha256: sha, decoder: "sharp-full-decode-v1", verifiedBy: "server", verifiedAt: now, ...extra };
}
function validate(config = connection(), input = request()) { return validateImageProviderRequest(config, input, now); }
function expectCode(callback: () => unknown, code: string) { expect(callback).toThrow(code); }

describe("阶段 4 严格图片供应商合同（不发外网、不读取凭证）", () => {
  it("统一表示四种协议，不据此推定模型能力或真实验收", () => {
    for (const protocol of ["openai", "openai-compatible", "google", "custom"] as const) {
      const config = connection(); config.protocol = protocol;
      expect(validate(config).request.model).toBe("fixture-image-model");
      expect(imageProviderPublicView(config)).toMatchObject({ configuration: "valid", diagnostic: { state: "not-run" }, realExecutionEnabled: false, models: [{ evidence: { state: "declared" } }] });
    }
  });
  it("不接受服务端默认模型、多个输出、未声明参数或原始密钥字段", () => {
    const input = request();
    expect(ImageExecutionRequestSchema.safeParse({ ...input, model: undefined }).success).toBe(false);
    expect(ImageExecutionRequestSchema.safeParse({ ...input, parameters: { ...input.parameters, n: 2 } }).success).toBe(false);
    expect(ImageExecutionRequestSchema.safeParse({ ...input, parameters: { ...input.parameters, seed: 42 } }).success).toBe(false);
    expect(ImageExecutionRequestSchema.safeParse({ ...input, apiKey: "not-a-real-key" }).success).toBe(false);
    expect(ImageProviderConnectionSchema.safeParse({ ...connection(), apiKey: "not-a-real-key" }).success).toBe(false);
  });
  it("基础地址拒绝凭证、查询参数、片段和 HTTP；这里只校验语法，不宣称已完成 SSRF 防护", () => {
    for (const baseUrl of ["http://provider.invalid/v1", "https://user:pass@provider.invalid/v1", "https://provider.invalid/v1?key=fake", "https://provider.invalid/v1#key"]) {
      expect(ImageProviderConnectionSchema.safeParse({ ...connection(), baseUrl }).success).toBe(false);
    }
  });
  it("服务端公开视图不暴露地址和凭证引用，连通诊断不等于模型验收", () => {
    const config = connection(); config.diagnostic = { state: "reachable", evidenceRef: "diagnostic-a", checkedAt: now };
    const view = imageProviderPublicView(config);
    expect(view.models[0].evidence.state).toBe("declared");
    expect(JSON.stringify(view)).not.toContain(config.credentialRef);
    expect(JSON.stringify(view)).not.toContain(config.baseUrl);
    expect(ImageProviderConnectionSchema.safeParse({ ...config, models: [{ ...config.models[0], evidence: { state: "live-request-accepted" } }] }).success).toBe(false);
  });
  it("拒绝跨租户、跨项目、旧连接版本、停用连接和未声明模型", () => {
    for (const field of ["tenantId", "projectId", "connectionId"] as const) expectCode(() => validate(connection(), { ...request(), [field]: "foreign" }), "image_connection_not_found");
    expectCode(() => validate({ ...connection(), enabled: false }), "image_connection_disabled");
    expectCode(() => validate(connection(), { ...request(), connectionRevision: 2 }), "image_connection_changed");
    expectCode(() => validate(connection(), { ...request(), adapterId: "other" }), "image_connection_changed");
    expectCode(() => validate(connection(), { ...request(), model: "auto" }), "image_model_not_declared");
    expectCode(() => validate(connection(), { ...request(), capabilityVersion: "capability-2" }), "image_capability_changed");
  });
  it("模型参数逐项拒绝，不在官方、兼容和非 OpenAI 协议间静默降级", () => {
    const input = request();
    expectCode(() => validate(connection(), { ...input, parameters: { ...input.parameters, quality: "xhigh" } }), "image_quality_unsupported");
    const limited = connection(); limited.models[0].outputFormats = ["png"]; limited.models[0].backgrounds = ["opaque"]; limited.models[0].inputFidelities = []; limited.models[0].supportsOutputCompression = false;
    expectCode(() => validate(limited, { ...input, parameters: { ...input.parameters, outputFormat: "webp" } }), "image_output_format_unsupported");
    expectCode(() => validate(limited), "image_background_unsupported");
    limited.models[0].backgrounds = ["auto"];
    expectCode(() => validate(limited), "image_fidelity_unsupported");
    limited.models[0].inputFidelities = ["high"];
    expectCode(() => validate(limited, { ...input, parameters: { ...input.parameters, outputFormat: "png", outputCompression: 0 } }), "PNG");
    limited.models[0].outputFormats = ["webp"];
    expectCode(() => validate(limited, { ...input, parameters: { ...input.parameters, outputFormat: "webp", outputCompression: 0 } }), "image_compression_unsupported");
  });
  it("校验尺寸预设及自定义边界、步长、像素数与比例", () => {
    const input = request();
    for (const size of ["auto", { width: 1024, height: 1024 }, { width: 512, height: 256 }] as const) expect(validate(connection(), { ...input, parameters: { ...input.parameters, size } }).fingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const size of [{ width: 257, height: 512 }, { width: 128, height: 512 }, { width: 2048, height: 2048 }, { width: 2048, height: 256 }]) expectCode(() => validate(connection(), { ...input, parameters: { ...input.parameters, size } }), "image_size_unsupported");
    const limited = connection(); limited.models[0].sizes.allowAuto = false;
    expectCode(() => validate(limited, { ...input, parameters: { ...input.parameters, size: "auto" } }), "image_size_unsupported");
  });
  it("拒绝透明 JPEG、PNG 压缩参数、浮点报价、超预算或过期报价", () => {
    const input = request();
    expect(ImageExecutionRequestSchema.safeParse({ ...input, parameters: { ...input.parameters, outputFormat: "jpeg", background: "transparent" } }).success).toBe(false);
    for (const quote of [{ ...input.quote, estimatedCostMinor: 0.1 }, { ...input.quote, maxCostMinor: 24 }]) expect(ImageExecutionRequestSchema.safeParse({ ...input, quote }).success).toBe(false);
    expectCode(() => validate(connection(), { ...input, quote: { ...input.quote, expiresAt: now } }), "image_quote_expired");
    expectCode(() => validateImageProviderRequest(connection(), input, "not-a-date"), "image_quote_expired");
  });
  it("有模型蒙版也不能冒充商品像素锁定", () => {
    expectCode(() => validate(connection(), { ...request(), protection: "pixel-exact" }), "image_pixel_protection_not_configured");
    const limited = connection(); limited.models[0].mask = { mode: "none", polarity: "unsupported" };
    const input = request(); if (input.operation !== "edit") throw new Error("fixture");
    input.mask = { ...source, assetId: "mask" };
    expectCode(() => validate(limited, input), "image_mask_unsupported");
    limited.models[0].mask = { mode: "prompt-guidance", polarity: "unverified" };
    expectCode(() => validate(limited, input), "image_mask_unsupported");
    expect(validate(connection(), input).request).toHaveProperty("mask");
    input.mask.width = 512;
    expectCode(() => validate(connection(), input), "image_mask_invalid");
  });
  it("计数、单文件、累计大小和来源类型都受能力限制", () => {
    const input = request(); if (input.operation !== "edit") throw new Error("fixture");
    input.inputs = [source, { ...source, assetId: "second" }, { ...source, assetId: "third" }];
    expectCode(() => validate(connection(), input), "image_input_count_exceeded");
    input.inputs = [{ ...source, byteSize: 1001 }];
    expectCode(() => validate(connection(), input), "image_input_bytes_exceeded");
    input.inputs = [source]; input.mask = { ...source, assetId: "mask", byteSize: 2000 };
    expectCode(() => validate(connection(), input), "image_input_total_bytes_exceeded");
    input.mask = undefined; input.inputs = [{ ...source, mimeType: "image/gif" }];
    expectCode(() => validate(connection(), input), "image_input_mime_unsupported");
    input.inputs = [{ ...source, width: 2049 }];
    expectCode(() => validate(connection(), input), "image_input_dimensions_exceeded");
    input.inputs = [{ ...source, width: 2048, height: 2048 }];
    expectCode(() => validate(connection(), input), "image_input_dimensions_exceeded");
    input.inputs = [source]; input.parameters.prompt = "长".repeat(4001);
    expectCode(() => validate(connection(), input), "image_prompt_too_long");
  });
  it("生成不接受底图或编辑专用的输入保真参数", () => {
    const { operation: _, inputs: __, ...base } = request();
    const generation = { ...base, operation: "generate", inputs: [] };
    expectCode(() => validateImageProviderRequest(connection(), generation, now), "image_fidelity_unsupported");
    const { inputFidelity: ___, ...parameters } = base.parameters;
    expect(validateImageProviderRequest(connection(), { ...generation, parameters }, now).request.operation).toBe("generate");
    expect(ImageExecutionRequestSchema.safeParse({ ...generation, inputs: [source] }).success).toBe(false);
  });
  it("原图摘要、实际大小、尺寸及租户须匹配服务端权威收据", () => {
    expect(() => validateImageProviderInputs(request(), [receipt()])).not.toThrow();
    expectCode(() => validateImageProviderInputs(request(), []), "image_input_not_verified");
    expectCode(() => validateImageProviderInputs(request(), [receipt({ tenantId: "foreign" })]), "image_input_not_verified");
    const changed = receipt(); changed.asset.width = 512;
    expectCode(() => validateImageProviderInputs(request(), [changed]), "image_input_changed");
    const changedHash = request(); if (changedHash.operation !== "edit") throw new Error("fixture");
    changedHash.inputs = [{ ...source, checksumSha256: "b".repeat(64) }];
    expectCode(() => validateImageProviderInputs(changedHash, [receipt()]), "image_input_changed");
  });
  it("蒙版必须绑定第一张已验证底图，不能拿蒙版作底图", () => {
    const mask = receipt(); mask.asset = { ...mask.asset, id: "mask", purpose: "mask", sourceAssetId: "source" }; mask.sourceChecksumSha256 = sha;
    const input = request(); if (input.operation !== "edit") throw new Error("fixture");
    input.mask = { ...source, assetId: "mask" };
    expect(() => validateImageProviderInputs(input, [receipt(), mask])).not.toThrow();
    expectCode(() => validateImageProviderInputs(input, [receipt(), { ...mask, sourceChecksumSha256: "b".repeat(64) }]), "image_mask_source_changed");
    const wrongSource = { ...mask, asset: { ...mask.asset, sourceAssetId: "different" } };
    expectCode(() => validateImageProviderInputs(input, [receipt(), wrongSource]), "image_mask_source_changed");
    input.mask = undefined; input.inputs = [{ ...source, assetId: "mask" }];
    expectCode(() => validateImageProviderInputs(input, [mask]), "image_source_is_mask");
  });
  it("确认摘要与属性顺序无关；变更参数、原图、约束、报价或连接必须重新确认", () => {
    const config = connection(); const input = request(); const fingerprint = validate(config, input).fingerprint;
    expect(imageConfirmationFingerprint(config, { ...input, parameters: { ...input.parameters, prompt: input.parameters.prompt } })).toBe(fingerprint);
    expect(() => requireImageConfirmation(config, input, fingerprint, now)).not.toThrow();
    for (const changed of [
      { ...input, parameters: { ...input.parameters, prompt: "新指令" } },
      { ...input, constraintChecksumSha256: "b".repeat(64) },
      { ...input, quote: { ...input.quote, version: "price-2" } },
      { ...input, quote: { ...input.quote, currency: "USD" } },
      { ...input, inputs: [{ ...source, checksumSha256: "b".repeat(64) }] },
    ]) expectCode(() => requireImageConfirmation(config, changed as ImageExecutionRequest, fingerprint, now), "image_confirmation_changed");
    for (const changed of [{ ...config, baseUrl: "https://different.invalid/v1" }, { ...config, credentialRef: "other-ref" }]) expectCode(() => requireImageConfirmation(changed, input, fingerprint, now), "image_confirmation_changed");
  });
  it("用量缺失不是零收费；损坏产物也可以已有真实扣费", () => {
    const outcome = { schemaVersion: 1, tenantId: "tenant-a", projectId: "project-a", jobId: "job-a", connectionId: "provider-a", requestFingerprint: sha,
      providerStatus: "returned", artifactStatus: "invalid", failureCode: "image_decode_failed", usage: { source: "unavailable" }, billing: { state: "charged", costMinor: 25, currency: "CNY", source: "provider-reported", evidenceRef: "billing-a" } };
    expect(ImageProviderOutcomeSchema.parse(outcome)).toMatchObject({ artifactStatus: "invalid", billing: { state: "charged", costMinor: 25 } });
    expect(ImageProviderOutcomeSchema.safeParse({ ...outcome, billing: { state: "unbilled" } }).success).toBe(false);
    expect(ImageUsageSchema.safeParse({ source: "provider-reported", metrics: {} }).success).toBe(false);
    expect(ImageUsageSchema.safeParse({ source: "unavailable", costMinor: 0 }).success).toBe(false);
    expect(ImageUsageSchema.parse({ source: "provider-reported", metrics: { inputTokens: 0 } })).toHaveProperty("metrics.inputTokens", 0);
    expect(ImageUsageSchema.safeParse({ source: "estimated", estimatedCostMinor: 25 }).success).toBe(false);
    expect(ImageProviderOutcomeSchema.safeParse({ ...outcome, artifactStatus: "pending-validation", providerStatus: "unknown" }).success).toBe(false);
    expect(ImageProviderOutcomeSchema.safeParse({ ...outcome, b64_json: "never-stored-here" }).success).toBe(false);
  });
  it("真实执行闸门在任何凭证和传输动作之前拒绝，没有客户端布尔值可解锁", () => {
    const credentialResolver = vi.fn(); const transport = vi.fn();
    expectCode(() => { assertRealImageExecutionAllowed(); credentialResolver(); transport(); }, "real_image_execution_disabled");
    expect(credentialResolver).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
  it("本地服务公开合同阶段，现有任务执行器仍只允许 mock", async () => {
    const server = createApiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture server");
      expect(await (await fetch(`http://127.0.0.1:${address.port}/health`)).json()).toMatchObject({ realExecutorsEnabled: false, imageProviderMode: "contracts-only" });
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
