import { describe, expect, it, vi } from "vitest";
import { ImageExecutionRequestSchema, type ImageProviderConnection } from "../packages/contracts/src/index";
import { ImageEgressContractError, ImageEgressFixtureHarness, isAllowedImageEgressAddress, type ImageDnsPort, type ImageEgressFixtureTransport } from "../apps/api/src/imageEgressContract";
import { prepareOpenAiImageRequest } from "../apps/api/src/openaiImageProtocol";
import { prepareCompatibleImageRequest } from "../apps/api/src/compatibleImageProtocol";
import { prepareGoogleImageRequest } from "../apps/api/src/googleImageProtocol";
import { imagePayloadSha256 } from "../apps/api/src/imageRequestPayload";
import { connection as baseConnection, principal, at } from "./helpers/image-task-fixture";

async function wire(protocol: ImageProviderConnection["protocol"] = "openai", baseUrl?: string) {
  const connection = baseConnection({ protocol, ...(baseUrl ? { baseUrl } : {}) });
  if (protocol === "openai-compatible") connection.compatibility = { version: "relay-v1", endpoints: { generate: "/images/generations", edit: "/images/edits" },
    editEncoding: "multipart-image-array", responseEncoding: "images-b64-json-v1", extraParameters: [], auth: { scheme: "header", headerName: "x-access-token" } };
  if (protocol === "google") {
    connection.baseUrl = "https://generativelanguage.googleapis.com";
    connection.models[0].outputFormats = ["jpeg"];
    connection.models[0].maxInputImages = 2;
    connection.googleNative = { version: "native-v1", apiVersion: "v1", requestEncoding: "generate-content-response-format-v1",
      modelMappings: [{ model: connection.models[0].model, sizes: [{ width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" }] }] };
  }
  const request = ImageExecutionRequestSchema.parse({ schemaVersion: 1, tenantId: connection.tenantId, projectId: connection.projectId, jobId: "job-fixture",
    idempotencyKey: "attempt-fixture", connectionId: connection.id, connectionRevision: 1, adapterId: connection.adapterId,
    model: connection.models[0].model, capabilityVersion: connection.models[0].version, constraintSnapshotId: "constraint-a", constraintChecksumSha256: "a".repeat(64),
    protection: "none", operation: "generate", inputs: [], parameters: { prompt: "人工指定构图", n: 1, size: { width: 1024, height: 1024 }, quality: "auto", background: "auto", outputFormat: protocol === "google" ? "jpeg" : "png" },
    quote: { id: "quote-fixture", version: "price-fixture", source: "manual-budget", currency: "CNY", estimatedCostMinor: 25, maxCostMinor: 30, expiresAt: "2026-10-03T19:00:00Z" } });
  const prepare = protocol === "google" ? prepareGoogleImageRequest : protocol === "openai-compatible" ? prepareCompatibleImageRequest : prepareOpenAiImageRequest;
  return { connection, request, prepared: await prepare(connection, request, [], at) };
}
type FixtureReply = Awaited<ReturnType<ImageEgressFixtureTransport["send"]>>;
const stream = async function* (parts: Uint8Array[] = [Buffer.from("{}")]) { for (const part of parts) yield part; };
const reply = (extra: Partial<FixtureReply> = {}): FixtureReply => ({ status: 200, headers: { "content-type": "application/json", "content-length": "2", "x-request-id": "fixture-response" }, body: stream(), ...extra });
async function fixture(protocol: ImageProviderConnection["protocol"] = "openai") {
  const input = await wire(protocol); let now = Date.parse(at), allowed = true;
  const captures: Array<Parameters<ImageEgressFixtureTransport["send"]>[0]> = [];
  const options: NonNullable<ConstructorParameters<typeof ImageEgressFixtureHarness>[0]> = {
    tenantId: principal.tenantId, allowedTargets: [{ hostname: new URL(input.connection.baseUrl).hostname, port: 443 }], clock: () => now,
    authorize: vi.fn(() => allowed), dns: { mode: "contract-fixture", resolveAll: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) },
    credentials: { mode: "contract-fixture", realExecutionEnabled: false, withCredential: async (scope, _signal, use) => use({ scope, secret: Buffer.from("fixture-not-a-real-key") }) },
    transport: { mode: "contract-fixture", realExecutionEnabled: false, send: vi.fn(async sent => { captures.push({ ...sent, headers: { ...sent.headers }, body: Buffer.from(sent.body) }); return reply(); }) },
  };
  const invoke = (harness = new ImageEgressFixtureHarness(options), signal = new AbortController().signal) => harness.run(principal, input.connection, input.request, input.prepared, signal);
  return { input, options, invoke, captures, clock: (next: number) => { now = next; }, deny: () => { allowed = false; } };
}
describe("图片出站安全合同（显式本地端口，无真实 DNS/网络/密钥）", () => {
  it("默认未配置拒绝；真实标记或危险目标配置拒绝", async () => {
    const f = await fixture(); await expect(f.invoke(new ImageEgressFixtureHarness())).rejects.toThrow("image_egress_not_configured");
    for (const change of [{ allowedTargets: [] }, { allowedTargets: [{ hostname: "localhost", port: 443 }] }, { timeoutMs: 30001 }, { additionalDeniedAddresses: ["::ffff:127.0.0.1"] },
      { maxRequestBytes: 64 * 1024 * 1024 + 1 }, { transport: { ...f.options.transport, realExecutionEnabled: true } }, { credentials: { ...f.options.credentials, mode: "production" } }]) {
      expect(() => new ImageEgressFixtureHarness({ ...f.options, ...change } as typeof f.options)).toThrow("image_egress_configuration_invalid");
    }
    expect(f.options.dns.resolveAll).not.toHaveBeenCalled(); expect(f.options.transport.send).not.toHaveBeenCalled();
  });
  it.each(["openai", "openai-compatible", "google"] as const)("%s 从实际纯协议构造绑定端点/摘要并仅调用一次假端口", async protocol => {
    const f = await fixture(protocol), harness = new ImageEgressFixtureHarness(f.options), result = await f.invoke(harness);
    expect(result).toMatchObject({ status: 200, requestId: "fixture-response", body: Buffer.from("{}") });
    expect(f.captures[0].destination).toMatchObject({ address: "8.8.8.8", family: 4, hostname: new URL(f.input.connection.baseUrl).hostname, servername: new URL(f.input.connection.baseUrl).hostname,
      rejectUnauthorized: true, redirects: "error", retries: 0, proxy: "disabled" });
    expect(f.captures[0].body).toEqual(f.input.prepared.body);
    const auth = protocol === "openai" ? "authorization" : protocol === "google" ? "x-goog-api-key" : "x-access-token";
    expect(f.captures[0].headers[auth]).toBe((protocol === "openai" ? "Bearer " : "") + "fixture-not-a-real-key");
    expect(JSON.stringify(result)).not.toContain("fixture-not-a-real-key");
    await expect(f.invoke(harness)).rejects.toThrow("image_egress_fixture_consumed"); expect(f.options.transport.send).toHaveBeenCalledTimes(1);
  });
  it.each(["0.0.0.1", "10.1.1.1", "100.100.100.200", "127.1.2.3", "169.254.169.254", "168.63.129.16", "172.16.0.1", "192.168.1.1", "192.0.0.9", "192.0.2.1", "192.31.196.1", "192.52.193.1", "192.88.99.1", "192.175.48.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "100:0:0:1::1", "2001::1", "2001:db8::1", "2002:7f00:1::", "2620:4f:8000::1", "3fff::1", "5f00::1", "fd00::1", "fe80::1", "ff02::1", "fe80::1%eth0", "0177.0.0.1", "2130706433"])("拒绝特殊/编码地址 %s", address => {
    expect(isAllowedImageEgressAddress(address, address.includes(":") ? 6 : 4)).toBe(false);
  });
  it("公共 IPv4/IPv6 可候选，错误族拒绝；一个坏 A/AAAA 即整体拒绝，不挑安全地址", async () => {
    expect(isAllowedImageEgressAddress("8.8.8.8", 4)).toBe(true); expect(isAllowedImageEgressAddress("2606:4700:4700::1111", 6)).toBe(true);
    expect(isAllowedImageEgressAddress("8.8.8.8", 6)).toBe(false);
    for (const records of [[], [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }], [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }], Array(33).fill({ address: "8.8.8.8", family: 4 })]) {
      const f = await fixture(); f.options.dns.resolveAll = async () => records as Awaited<ReturnType<ImageDnsPort["resolveAll"]>>;
      await expect(f.invoke()).rejects.toThrow("image_egress_dns_rejected"); expect(f.options.transport.send).not.toHaveBeenCalled();
    }
  });
  it.each(["https://127.0.0.1/v1", "https://2130706433/v1", "https://0x7f000001/v1", "https://0177.0.0.1/v1", "https://[::1]/v1", "https://never-called.invalid./v1", "https://never-called.invalid/../v1", "https://never-called.invalid/%2e%2e/v1", "https://never-called.invalid\\@evil.invalid/v1", "https://never-called.invalid/v1?key=fixture", "https://user:fixture@never-called.invalid/v1"])("原地址不能由 URL 规范化隐藏危险内容 %s", async baseUrl => {
    const f = await fixture(); f.input.connection.baseUrl = baseUrl;
    await expect(f.invoke()).rejects.toThrow(); expect(f.options.dns.resolveAll).not.toHaveBeenCalled(); expect(f.options.transport.send).not.toHaveBeenCalled();
  });
  it("目标精确匹配服务端名单/端口，不接受后缀、替换端点或鉴权计划", async () => {
    const f = await fixture("openai-compatible"); f.options.allowedTargets = [{ hostname: "invalid", port: 443 }];
    expect(() => new ImageEgressFixtureHarness(f.options)).toThrow("image_egress_configuration_invalid");
    f.options.allowedTargets = [{ hostname: "other.invalid", port: 443 }]; await expect(f.invoke()).rejects.toThrow("image_egress_target_not_allowed");
    f.options.allowedTargets = [{ hostname: "never-called.invalid", port: 444 }]; await expect(f.invoke()).rejects.toThrow("image_egress_target_not_allowed");
    if (!("endpointUrl" in f.input.prepared)) throw Error("fixture protocol");
    f.input.prepared.endpointUrl += "/other"; await expect(f.invoke()).rejects.toThrow("image_egress_endpoint_mismatch");
    expect(f.options.dns.resolveAll).not.toHaveBeenCalled();
  });
  it("请求字节/指纹/方法/类型/容量漂移在 DNS/凭证前拦截", async () => {
    for (const update of [{ payloadChecksumSha256: "a".repeat(64) }, { requestFingerprint: "b".repeat(64) }, { method: "GET" }, { contentType: "application/json\r\nx-key: bad" }]) {
      const f = await fixture(); Object.assign(f.input.prepared, update); await expect(f.invoke()).rejects.toThrow(); expect(f.options.dns.resolveAll).not.toHaveBeenCalled();
    }
    const f = await fixture(); f.options.maxRequestBytes = 1; await expect(f.invoke()).rejects.toThrow("image_egress_request_too_large"); expect(f.options.dns.resolveAll).not.toHaveBeenCalled();
  });
  it("范围/异步政策拒绝，DNS后及凭证后撤权不调用传输", async () => {
    const f = await fixture(); f.deny(); await expect(f.invoke()).rejects.toThrow("image_egress_permission_denied"); expect(f.options.dns.resolveAll).not.toHaveBeenCalled();
    const asyncPolicy = await fixture(); asyncPolicy.options.authorize = (() => Promise.resolve(true)) as unknown as typeof f.options.authorize;
    await expect(asyncPolicy.invoke()).rejects.toThrow("image_egress_permission_denied");
    const dnsDenied = await fixture(); dnsDenied.options.dns.resolveAll = async () => { dnsDenied.deny(); return [{ address: "8.8.8.8", family: 4 }]; };
    await expect(dnsDenied.invoke()).rejects.toThrow("image_egress_permission_denied"); expect(dnsDenied.options.transport.send).not.toHaveBeenCalled();
    const keyDenied = await fixture(); keyDenied.options.credentials.withCredential = async (scope, _signal, use) => { keyDenied.deny(); return use({ scope, secret: Buffer.from("fixture") }); };
    await expect(keyDenied.invoke()).rejects.toThrow("image_egress_permission_denied"); expect(keyDenied.options.transport.send).not.toHaveBeenCalled();
    const foreign = await fixture(); await expect(new ImageEgressFixtureHarness(foreign.options).run({ ...principal, tenantId: "foreign" }, foreign.input.connection, foreign.input.request, foreign.input.prepared, new AbortController().signal)).rejects.toThrow("image_egress_permission_denied");
  });
  it("凭证严格绑定范围与摘要，控制字符和容量拒绝；原异常不泄漏", async () => {
    for (const variant of ["scope", "newline", "large", "empty", "error"] as const) {
      const f = await fixture(); f.options.credentials.withCredential = async (scope, _signal, use) => {
        if (variant === "error") throw Error("fixture-private-secret-and-address");
        return use({ scope: variant === "scope" ? { ...scope, projectId: "foreign" } : scope,
          secret: Buffer.from(variant === "newline" ? "a\r\nb" : variant === "large" ? "x".repeat(4097) : variant === "empty" ? "" : "fixture") });
      };
      await expect(f.invoke()).rejects.toThrow(variant === "error" ? "image_egress_contract_failed" : "image_egress_credential_invalid"); expect(f.options.transport.send).not.toHaveBeenCalled();
    }
  });
  it("发送前复查报价及30秒DNS有效期；单个固定地址不二次解析/轮询重试", async () => {
    const f = await fixture(); f.options.credentials.withCredential = async (scope, _signal, use) => { f.clock(Date.parse(at) + 30000); return use({ scope, secret: Buffer.from("fixture") }); };
    await expect(f.invoke()).rejects.toThrow("image_egress_dns_expired"); expect(f.options.transport.send).not.toHaveBeenCalled();
    const expired = await fixture(); expired.options.credentials.withCredential = async (scope, _signal, use) => { expired.clock(Date.parse(at) + 3600001); return use({ scope, secret: Buffer.from("fixture") }); };
    await expect(expired.invoke()).rejects.toThrow("image_egress_contract_failed"); expect(expired.options.transport.send).not.toHaveBeenCalled();
    const fixed = await fixture(); fixed.options.dns.resolveAll = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
    fixed.options.transport.send = vi.fn(async () => { throw Error("fixture-private-network-error"); });
    await expect(fixed.invoke()).rejects.toThrow("image_egress_contract_failed"); expect(fixed.options.dns.resolveAll).toHaveBeenCalledTimes(1); expect(fixed.options.transport.send).toHaveBeenCalledTimes(1);
  });
  it.each([301, 302, 307, 308])("HTTP %i 不跟随重定向、不再次鉴权或发送", async status => {
    const f = await fixture(); f.options.transport.send = vi.fn(async () => reply({ status, headers: { "location": "https://127.0.0.1/private", "content-type": "application/json" } }));
    await expect(f.invoke()).rejects.toThrow("image_egress_redirect_rejected"); expect(f.options.transport.send).toHaveBeenCalledTimes(1);
  });
  it("响应 MIME/编码/重复头/声明长度/实际流/分片/原始异常全部有界拒绝", async () => {
    const bad: Array<[FixtureReply, string]> = [
      [reply({ headers: { "content-type": "text/html" } }), "image_egress_response_encoding_invalid"],
      [reply({ headers: { "content-type": "application/json", "content-encoding": "gzip" } }), "image_egress_response_encoding_invalid"],
      [reply({ headers: { "content-type": "application/json", "Content-Type": "application/json" } }), "image_egress_response_headers_invalid"],
      [reply({ headers: { "content-type": "application/json", "content-length": "100" } }), "image_egress_response_too_large"],
      [reply({ headers: { "content-type": "application/json", "content-length": "3" } }), "image_egress_response_length_mismatch"],
      [reply({ body: stream([Buffer.from("123")]) }), "image_egress_response_too_large"],
      [reply({ body: stream([new Uint8Array()]) }), "image_egress_response_chunks_invalid"],
      [reply({ headers: { "content-type": "application/json" }, body: stream(Array(4097).fill(Buffer.from("x"))) }), "image_egress_response_chunks_invalid"],
    ];
    for (const [response, code] of bad) { const f = await fixture(); f.options.maxResponseBytes = response.headers["content-length"] === "100" ? 3 : 8192; f.options.transport.send = vi.fn(async () => response);
      await expect(f.invoke()).rejects.toThrow(code); expect(f.options.transport.send).toHaveBeenCalledTimes(1); }
  });
  it("取消/超时不再发送；不合作DNS保留两个槽直到结束，避免超时后无限后台操作", async () => {
    const f = await fixture(), controller = new AbortController(); controller.abort(); await expect(f.invoke(undefined, controller.signal)).rejects.toThrow("image_egress_cancelled"); expect(f.options.dns.resolveAll).not.toHaveBeenCalled();
    const releases: Array<(value: Array<{ address: string; family: 4 }>) => void> = [];
    const fixtures = await Promise.all([fixture(), fixture(), fixture()]);
    for (const item of fixtures.slice(0, 2)) { item.options.timeoutMs = 10; item.options.dns.resolveAll = () => new Promise(resolve => releases.push(resolve)); }
    const hanging = fixtures.slice(0, 2).map(item => item.invoke().catch(error => error.code));
    await expect(Promise.all(hanging)).resolves.toEqual(["image_egress_cancelled", "image_egress_cancelled"]);
    await expect(fixtures[2].invoke()).rejects.toThrow("image_egress_capacity");
    for (const release of releases) release([{ address: "8.8.8.8", family: 4 }]); await new Promise(resolve => setTimeout(resolve, 0));
    const next = await fixture(); await expect(next.invoke()).resolves.toMatchObject({ status: 200 });
    for (const item of fixtures) expect(item.options.transport.send).not.toHaveBeenCalled();
  });
  it("缓存输入隔离：异步期间外部改原字节不改变已冻结发送摘要，port重复消费不重发", async () => {
    const f = await fixture(), original = Buffer.from(f.input.prepared.body); f.options.dns.resolveAll = async () => { f.input.prepared.body.fill(0); return [{ address: "8.8.8.8", family: 4 }]; };
    await expect(f.invoke()).resolves.toMatchObject({ status: 200 }); expect(imagePayloadSha256(f.captures[0].body)).toBe(imagePayloadSha256(original));
    const twice = await fixture(); twice.options.credentials.withCredential = async (scope, _signal, use) => { await use({ scope, secret: Buffer.from("fixture") }); return use({ scope, secret: Buffer.from("fixture") }); };
    await expect(twice.invoke()).rejects.toThrow("image_egress_credential_reused"); expect(twice.options.transport.send).toHaveBeenCalledTimes(1);
  });
  it("额外部署阻断只增拒绝，IPv6不同写法一致，初始化后外部名单变动不放行", async () => {
    const f = await fixture(); f.options.additionalDeniedAddresses = ["2606:4700:4700:0:0:0:0:1111"];
    f.options.dns.resolveAll = async () => [{ address: "2606:4700:4700::1111", family: 6 }];
    await expect(f.invoke()).rejects.toThrow("image_egress_dns_rejected"); expect(f.options.transport.send).not.toHaveBeenCalled();
    const fixed = await fixture(); fixed.options.allowedTargets = [{ hostname: "other.invalid", port: 443 }];
    const harness = new ImageEgressFixtureHarness(fixed.options); fixed.options.allowedTargets = [{ hostname: "never-called.invalid", port: 443 }];
    await expect(fixed.invoke(harness)).rejects.toThrow("image_egress_target_not_allowed"); expect(fixed.options.dns.resolveAll).not.toHaveBeenCalled();
  });
  it("纯IPv6固定连接和显式HTTPS非默认端口能通过合同，不自动降级IPv4或端口", async () => {
    const f = await fixture(); f.options.dns.resolveAll = async () => [{ address: "2606:4700:4700::1111", family: 6 }];
    await f.invoke(); expect(f.captures[0].destination.family).toBe(6);
    const custom = await fixture(); Object.assign(custom.input, await wire("openai", "https://never-called.invalid:8443/root")); custom.options.allowedTargets = [{ hostname: "never-called.invalid", port: 8443 }];
    await custom.invoke(); expect(custom.captures[0].destination).toMatchObject({ port: 8443, path: "/root/images/generations" });
  });
  it("凭证端口不能绕过有界响应核验返回另一份包，不能不用受控消费回调", async () => {
    const f = await fixture(); f.options.credentials.withCredential = async (scope, _signal, use) => { await use({ scope, secret: Buffer.from("fixture") }); return { body: Buffer.alloc(1) } as never; };
    await expect(f.invoke()).rejects.toThrow("image_egress_credential_invalid"); expect(f.options.transport.send).toHaveBeenCalledTimes(1);
    const skipped = await fixture(); skipped.options.credentials.withCredential = async () => ({ body: Buffer.from("{}") }) as never;
    await expect(skipped.invoke()).rejects.toThrow("image_egress_credential_invalid"); expect(skipped.options.transport.send).not.toHaveBeenCalled();
  });
  it("异步拒绝政策、DNS、响应迭代器异常均固定错误，不传播原消息或cause", async () => {
    for (const port of ["policy", "dns", "body"] as const) {
      const f = await fixture();
      if (port === "policy") f.options.authorize = (() => Promise.reject(Error("private-key-fixture"))) as unknown as typeof f.options.authorize;
      if (port === "dns") f.options.dns.resolveAll = async () => { throw Error("private-key-fixture"); };
      if (port === "body") f.options.transport.send = async () => reply({ body: (async function* () { yield Buffer.from("{"); throw Error("private-key-fixture"); })() });
      let caught: unknown; try { await f.invoke(); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: port === "policy" ? "image_egress_permission_denied" : "image_egress_contract_failed" });
      expect(String(caught)).not.toContain("private-key-fixture"); expect(caught).not.toHaveProperty("cause");
    }
  });
  it("取消挂起响应保留槽直到迭代操作结清，并调用return；不再发送", async () => {
    const f = await fixture(), controller = new AbortController(); let release!: (value: IteratorResult<Uint8Array>) => void;
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    f.options.transport.send = async () => reply({ body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(resolve => { release = resolve; }), return: close }) } });
    const work = f.invoke(undefined, controller.signal); while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort(); await expect(work).rejects.toThrow("image_egress_cancelled"); expect(close).toHaveBeenCalledTimes(1);
    release({ done: true, value: undefined }); await new Promise(resolve => setTimeout(resolve, 0));
    const next = await fixture(); await expect(next.invoke()).resolves.toMatchObject({ status: 200 });
  });
  it("端点和鉴权合同不能跨协议替换；对称拒绝不同headerName/credentialRef", async () => {
    for (const changed of [{ scheme: "header", headerName: "authorization", credentialRef: "opaque-never-resolved" },
      { scheme: "header", headerName: "x-access-token", credentialRef: "foreign-credential" }]) {
      const f = await fixture("openai-compatible"); Object.assign(f.input.prepared, { authPlan: changed });
      await expect(f.invoke()).rejects.toThrow("image_egress_endpoint_mismatch"); expect(f.options.dns.resolveAll).not.toHaveBeenCalled();
    }
    const native = await fixture("google"), official = await wire();
    await expect(new ImageEgressFixtureHarness(native.options).run(principal, native.input.connection, native.input.request, official.prepared, new AbortController().signal)).rejects.toThrow("image_egress_endpoint_mismatch");
  });
  it("共享原图/输出容量先于DNS或凭证，4K和自动尺寸不能从出站合同绕过", async () => {
    for (const size of [{ width: 4096, height: 4096 }, "auto"] as const) {
      const f = await fixture(); f.input.connection.models[0].sizes.presets.push({ width: 4096, height: 4096 }); f.input.request.parameters.size = size;
      f.input.prepared = await prepareOpenAiImageRequest(f.input.connection, f.input.request, [], at);
      await expect(f.invoke()).rejects.toThrow(size === "auto" ? "image_egress_explicit_size_required" : "image_egress_dimensions_exceeded");
      expect(f.options.dns.resolveAll).not.toHaveBeenCalled(); expect(f.options.transport.send).not.toHaveBeenCalled();
    }
  });
  it("头部或重定向被拒绝也关闭未读取响应，不能只关闭已开始读流的包", async () => {
    for (const status of [302, 200]) {
      const f = await fixture(), next = vi.fn(async () => ({ done: true as const, value: undefined })), close = vi.fn(async () => ({ done: true as const, value: undefined }));
      f.options.transport.send = async () => reply({ status, headers: { "content-type": "text/html" }, body: { [Symbol.asyncIterator]: () => ({ next, return: close }) } });
      await expect(f.invoke()).rejects.toThrow(status === 302 ? "image_egress_redirect_rejected" : "image_egress_response_encoding_invalid");
      expect(next).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
    }
  });
  it("同步传输抛错也清零副本；端口伪造本类异常不能传播秘密message/code", async () => {
    for (const code of ["private-key-fixture", "image_egress_response_invalid"]) {
      const f = await fixture(); let sent: Buffer | undefined;
      f.options.transport.send = input => { sent = input.body; const error = new ImageEgressContractError(code); error.message = "private-message-fixture"; throw error; };
      let caught: unknown; try { await f.invoke(); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: code.startsWith("image_egress_") ? code : "image_egress_contract_failed" });
      expect(String(caught)).not.toContain("private"); expect(sent).toBeDefined(); expect(sent!.every(byte => byte === 0)).toBe(true);
    }
  });
});
