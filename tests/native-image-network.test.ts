import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { Resolver } from "node:dns";
import { createSocket } from "node:dgram";
import { IncomingMessage, type ClientRequest } from "node:http";
import { Agent, createServer, request as httpsRequest, type RequestOptions } from "node:https";
import { Socket } from "node:net";
import { checkServerIdentity } from "node:tls";
import { ImageNetworkDriverHarness, NativeImageNetworkClient, type ImageNetworkLocalDrivers, type NativeImageNetworkInput, type NativeImageNetworkOptions } from "../apps/api/src/nativeImageNetwork";
import { imagePayloadSha256 } from "../apps/api/src/imageRequestPayload";
import { ownedTestCertificate, ownedTestKey } from "./helpers/owned-tls-fixture";

const signal = () => new AbortController().signal;
// Allow close/cancel promises to release the shared slot between tests.
afterEach(async () => { await new Promise(resolve => setImmediate(resolve)); });
function fixture() {
  const body = Buffer.from("{\"fixture\":true}"), input: NativeImageNetworkInput = {
    endpointUrl: "https://owned.fixture.invalid/v1/images/generations", body,
    scope: { tenantId: "tenant-a", projectId: "project-a", actorId: "writer", connectionId: "connection-a", connectionRevision: 1,
      credentialRef: "fixture-reference", requestFingerprint: "a".repeat(64), payloadChecksumSha256: imagePayloadSha256(body) },
    headers: { "content-type": "application/json", "content-length": String(body.length), accept: "application/json", "accept-encoding": "identity", authorization: "Bearer explicit-test-only" },
  };
  const options: NativeImageNetworkOptions = { networkEnabled: true, tenantId: "tenant-a", allowedTargets: [{ hostname: "owned.fixture.invalid", port: 443 }], authorize: vi.fn(() => true) };
  const captures: Array<RequestOptions & { sentBody?: Buffer }> = [], queries: Array<{ hostname: string; family: number; ttl: boolean }> = [];
  const resolver = {
    resolve4: vi.fn((hostname, opts, done) => { queries.push({ hostname, family: 4, ttl: opts.ttl }); done(null, [{ address: "8.8.8.8", ttl: 60 }]); }),
    resolve6: vi.fn((hostname, opts, done) => { queries.push({ hostname, family: 6, ttl: opts.ttl }); done(null, [{ address: "2606:4700:4700::1111", ttl: 60 }]); }), cancel: vi.fn(),
  };
  let replyHeaders = ["Content-Type", "application/json", "Content-Length", "2"], status = 200, replyBody = Buffer.from("{}"), complete = true, trailers: string[] = [];
  const replies: IncomingMessage[] = [], requests: ClientRequest[] = [];
  const drivers: ImageNetworkLocalDrivers = { mode: "local-driver", realExecutionEnabled: false, createResolver: vi.fn(() => resolver),
    request: vi.fn((opts, callback) => {
      const capture = { ...opts, headers: { ...opts.headers } }; captures.push(capture);
      const emitter = new EventEmitter() as ClientRequest; requests.push(emitter); let closed = false;
      emitter.destroy = vi.fn(() => { if (!closed) { closed = true; setImmediate(() => emitter.emit("close")); } return emitter; });
      emitter.end = vi.fn(bytes => { capture.sentBody = Buffer.from(bytes as Buffer); setImmediate(() => {
        if (closed) return;
        const message = new IncomingMessage(new Socket()); message.statusCode = status; message.rawHeaders = [...replyHeaders]; message.complete = complete; message.rawTrailers = [...trailers]; replies.push(message);
        callback(message); message.push(replyBody); message.push(null);
      }); return emitter; }) as typeof emitter.end;
      setImmediate(() => { if (closed) return; const socket = Object.assign(new EventEmitter(), { encrypted: true, authorized: true }); emitter.emit("socket", socket); socket.emit("secureConnect"); });
      return emitter;
    }) };
  const send = (client = new ImageNetworkDriverHarness(options, drivers), abort = signal()) => client.send(input, abort);
  return { input, options, drivers, resolver, captures, queries, replies, requests, send,
    reply: (value: { headers?: string[]; status?: number; body?: Buffer; complete?: boolean; trailers?: string[] }) => {
      replyHeaders = value.headers ?? replyHeaders; status = value.status ?? status; replyBody = value.body ?? replyBody; complete = value.complete ?? complete; trailers = value.trailers ?? trailers;
    } };
}
function callLookup(options: RequestOptions, hostname = options.hostname as string) {
  return new Promise<{ address: string; family: number }>((resolve, reject) => options.lookup!(hostname, { family: options.family } as never, (error, address, family) => {
    if (error) reject(error); else resolve({ address, family });
  }));
}

describe("原生网络内核：本地驱动，不读取凭证或访问供应商", () => {
  it("Native 默认关闭；假驱动不能作为原生构造配置或重标生产", async () => {
    const f = fixture(); await expect(new NativeImageNetworkClient().send(f.input, signal())).rejects.toThrow("image_egress_not_configured");
    expect(f.drivers.request).not.toHaveBeenCalled();
    for (const changed of [{ networkEnabled: false }, { timeoutMs: 30001 }, { allowedTargets: [] }, { allowedTargets: [{ hostname: "127.0.0.1", port: 443 }] }, { maxRequestBytes: 64 * 1024 * 1024 + 1 }, { maxResponseBytes: 32 * 1024 * 1024 + 1 }]) {
      expect(() => new NativeImageNetworkClient({ ...f.options, ...changed } as NativeImageNetworkOptions)).toThrow("image_egress_configuration_invalid");
    }
    expect(() => new ImageNetworkDriverHarness(f.options, { ...f.drivers, mode: "native" } as never)).toThrow("image_egress_configuration_invalid");
    expect(() => new ImageNetworkDriverHarness(f.options, { ...f.drivers, realExecutionEnabled: true } as never)).toThrow("image_egress_configuration_invalid");
    await expect(new NativeImageNetworkClient({ ...f.options, authorize: () => false }).send(f.input, signal())).rejects.toThrow("image_egress_permission_denied");
  });
  it("全A/AAAA各查一次，保留原Host/SNI/证书，独立无代理无池无TLS会话", async () => {
    const f = fixture(), client = new ImageNetworkDriverHarness(f.options, f.drivers), result = await f.send(client);
    expect(result.body).toEqual(Buffer.from("{}")); expect(f.queries).toEqual([{ hostname: "owned.fixture.invalid", family: 4, ttl: true }, { hostname: "owned.fixture.invalid", family: 6, ttl: true }]);
    expect(f.drivers.createResolver).toHaveBeenCalledWith({ timeout: 5000, tries: 1 });
    const options = f.captures[0]; expect(options).toMatchObject({ hostname: "owned.fixture.invalid", servername: "owned.fixture.invalid", method: "POST", path: "/v1/images/generations",
      rejectUnauthorized: true, checkServerIdentity, minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"], autoSelectFamily: false, family: 4, maxHeaderSize: 16384, insecureHTTPParser: false });
    expect(options.headers).toMatchObject({ host: "owned.fixture.invalid", connection: "close" });
    expect(options.agent).toBeInstanceOf(Agent); expect((options.agent as Agent).options).toMatchObject({ keepAlive: false, proxyEnv: {} });
    expect((options.agent as Agent).maxCachedSessions).toBe(0); expect(options.sentBody).toEqual(f.input.body);
    await expect(f.send(client)).rejects.toThrow("image_egress_network_consumed"); expect(f.drivers.request).toHaveBeenCalledTimes(1);
    expect(f.resolver.cancel).toHaveBeenCalled(); expect(f.requests[0].destroy).toHaveBeenCalled(); expect(f.replies[0].destroyed).toBe(true);
    expect(f.input.headers.authorization).toBe("Bearer explicit-test-only"); expect(f.input.body.toString()).toContain("fixture");
  });
  it("固定lookup仅返回选定地址，不能二次解析/循环地址或替换主机", async () => {
    const f = fixture(), original = f.drivers.request, lookups: Array<Promise<unknown>> = [];
    f.drivers.request = (options, callback) => { lookups.push(callLookup(options), callLookup(options).catch(error => error.message)); return original(options, callback); };
    await f.send(); expect(await lookups[0]).toEqual({ address: "8.8.8.8", family: 4 }); expect(await lookups[1]).toBe("image_egress_dns_rejected"); expect(f.queries).toHaveLength(2);
    // Completed/disposed request cannot reuse its lookup closure either.
    await expect(callLookup(f.captures[0])).rejects.toThrow("image_egress_dns_rejected");
    const other = fixture(); await other.send(); await expect(callLookup(other.captures[0], "other.invalid")).rejects.toThrow("image_egress_dns_rejected");
    const ipv6 = fixture(), original6 = ipv6.drivers.request; let address6: Promise<unknown> | undefined;
    ipv6.resolver.resolve4 = vi.fn((_host, _opts, done) => done({ code: "ENODATA" }, [])); ipv6.drivers.request = (options, callback) => { address6 = callLookup(options); return original6(options, callback); };
    await ipv6.send(); expect(await address6).toEqual({ address: "2606:4700:4700::1111", family: 6 });
  });
  it("同进程两个槽，取消后未结清DNS仍占槽，结清后才恢复容量", async () => {
    const first = fixture(), second = fixture(), aborts = [new AbortController(), new AbortController()], finishes: Array<() => void> = [];
    for (const f of [first, second]) {
      f.resolver.resolve4 = vi.fn((_host, _opts, done) => finishes.push(() => done({ code: "ECANCELLED" }, [])));
      f.resolver.cancel = vi.fn(); // Deliberately uncooperative trusted test driver.
    }
    const pending = [first.send(undefined, aborts[0].signal), second.send(undefined, aborts[1].signal)].map(work => work.catch(error => error.message));
    for (const abort of aborts) abort.abort(); expect(await Promise.all(pending)).toEqual(["image_egress_cancelled", "image_egress_cancelled"]);
    const third = fixture(); await expect(third.send()).rejects.toThrow("image_egress_capacity"); expect(third.drivers.createResolver).not.toHaveBeenCalled();
    for (const finish of finishes) finish(); await new Promise(resolve => setImmediate(resolve)); await fixture().send();
  });
  it("显式非默认端口保留Host与完整根路径，不以代理绝对URL发送", async () => {
    const f = fixture(); f.input.endpointUrl = "https://owned.fixture.invalid:8443/root/v1/images/generations"; f.options.allowedTargets = [{ hostname: "owned.fixture.invalid", port: 8443 }];
    await f.send(); expect(f.captures[0]).toMatchObject({ port: 8443, path: "/root/v1/images/generations", headers: { host: "owned.fixture.invalid:8443" } });
  });
  it.each(["https://127.0.0.1/v1", "https://2130706433/v1", "https://0x7f000001/v1", "https://[::1]/v1", "https://owned.fixture.invalid/../v1", "https://owned.fixture.invalid/%2e/v1", "https://owned.fixture.invalid/v1?key=fixture", "https://user:key@owned.fixture.invalid/v1", "http://owned.fixture.invalid/v1"])("危险原URL在DNS前拒绝 %s", async url => {
    const f = fixture(); f.input.endpointUrl = url; await expect(f.send()).rejects.toThrow("image_egress_url_invalid"); expect(f.drivers.createResolver).not.toHaveBeenCalled();
  });
  it("精确主机/端口名单，额外IPv6数值等价阻断，配置不可被原对象修改", async () => {
    const f = fixture(); f.options.allowedTargets = [{ hostname: "else.invalid", port: 443 }]; await expect(f.send()).rejects.toThrow("image_egress_target_not_allowed"); expect(f.drivers.createResolver).not.toHaveBeenCalled();
    const port = fixture(); port.input.endpointUrl = port.input.endpointUrl.replace("invalid/", "invalid:8443/"); await expect(port.send()).rejects.toThrow("image_egress_target_not_allowed");
    const frozen = fixture(), client = new ImageNetworkDriverHarness(frozen.options, frozen.drivers); (frozen.options.allowedTargets as Array<{ hostname: string; port: number }>)[0].hostname = "changed.invalid"; await frozen.send(client);
    const extra = fixture(); extra.resolver.resolve4 = vi.fn((_host, _opts, done) => done({ code: "ENODATA" }, []));
    extra.options.additionalDeniedAddresses = ["2606:4700:4700:0:0:0:0:1111"]; await expect(extra.send()).rejects.toThrow("image_egress_dns_rejected"); expect(extra.drivers.request).not.toHaveBeenCalled();
  });
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "168.63.129.16", "192.0.2.1", "224.0.0.1", "::1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2001:db8::1", "fd00::1"])("任一不安全A/AAAA整体拒绝 %s", async address => {
    const f = fixture(); const family = address.includes(":") ? "resolve6" : "resolve4";
    f.resolver[family] = vi.fn((_host, _opts, done) => done(null, [{ address: "8.8.8.8", ttl: 60 }, { address, ttl: 60 }]));
    await expect(f.send()).rejects.toThrow("image_egress_dns_rejected"); expect(f.drivers.request).not.toHaveBeenCalled();
  });
  it.each([0, -1, 0.5, NaN, 0x100000000])("不可靠TTL %s 拒绝", async ttl => {
    const f = fixture(); f.resolver.resolve4 = vi.fn((_host, _opts, done) => done(null, [{ address: "8.8.8.8", ttl }])); await expect(f.send()).rejects.toThrow("image_egress_dns_rejected");
  });
  it("ENODATA仅为空族，其他错误/无地址/33条均失败关闭且无重试", async () => {
    const f = fixture(); f.resolver.resolve4 = vi.fn((_host, _opts, done) => done({ code: "ENODATA" }, [])); await f.send(); expect(f.captures[0].family).toBe(6);
    for (const code of ["ENOTFOUND", "ETIMEOUT", "ESERVFAIL", "EREFUSED", "ECANCELLED"]) {
      const bad = fixture(); bad.resolver.resolve6 = vi.fn((_host, _opts, done) => done({ code, message: "private-address-key" }, []));
      await expect(bad.send()).rejects.toThrow("image_egress_dns_failed"); expect(bad.drivers.request).not.toHaveBeenCalled(); expect(bad.resolver.resolve6).toHaveBeenCalledTimes(1);
    }
    const empty = fixture(); empty.resolver.resolve4 = empty.resolver.resolve6 = vi.fn((_host, _opts, done) => done({ code: "ENODATA" }, [])); await expect(empty.send()).rejects.toThrow("image_egress_dns_rejected");
    const many = fixture(); many.resolver.resolve4 = vi.fn((_host, _opts, done) => done(null, Array(32).fill({ address: "8.8.8.8", ttl: 60 }))); await expect(many.send()).rejects.toThrow("image_egress_dns_rejected");
  });
  it("TTL最小值与30秒上限、报价/权限政策在发送前重新核验", async () => {
    let now = 1000; const f = fixture(); f.options.clock = () => now; f.resolver.resolve4 = vi.fn((_host, _opts, done) => done(null, [{ address: "8.8.8.8", ttl: 1 }]));
    f.options.authorize = (_scope, phase) => { if (phase === "before-connect") now = 2000; return true; };
    await expect(f.send()).rejects.toThrow("image_egress_dns_expired"); expect(f.drivers.request).not.toHaveBeenCalled();
    const cap = fixture(); cap.options.clock = () => now; cap.options.authorize = (_scope, phase) => { if (phase === "before-connect") now += 30000; return true; }; await expect(cap.send()).rejects.toThrow("image_egress_dns_expired");
    const revoke = fixture(); revoke.options.authorize = (_scope, phase) => phase !== "before-connect"; await expect(revoke.send()).rejects.toThrow("image_egress_permission_denied"); expect(revoke.drivers.request).not.toHaveBeenCalled();
    const final = fixture(); final.options.authorize = (_scope, phase) => phase !== "before-write"; await expect(final.send()).rejects.toThrow("image_egress_permission_denied"); expect(final.requests[0].end).not.toHaveBeenCalled();
  });
  it("范围、异步政策、摘要/字节漂移和上限在DNS前拒绝", async () => {
    for (const variation of ["tenant", "promise", "hash", "limit"] as const) {
      const f = fixture(); if (variation === "tenant") f.input.scope.tenantId = "other";
      if (variation === "promise") f.options.authorize = (() => Promise.resolve(true)) as never;
      if (variation === "hash") f.input.scope.payloadChecksumSha256 = "b".repeat(64); if (variation === "limit") f.options.maxRequestBytes = 1;
      await expect(f.send()).rejects.toThrow(); expect(f.drivers.createResolver).not.toHaveBeenCalled();
    }
  });
  it("无效信号/时钟异常不泄漏或永久占槽；时钟漂移拒绝", async () => {
    const f = fixture(); await expect(f.send(undefined, undefined as unknown as AbortSignal)).resolves.toBeDefined();
    await expect(new ImageNetworkDriverHarness(f.options, f.drivers).send(f.input, {} as AbortSignal)).rejects.toThrow("image_egress_configuration_invalid");
    for (const clock of [() => { throw Error("private-clock"); }, () => NaN, () => Infinity]) {
      const bad = fixture(); bad.options.clock = clock; await expect(bad.send()).rejects.toThrow(/image_egress_(network_failed|configuration_invalid)/); expect(bad.drivers.createResolver).not.toHaveBeenCalled();
    }
    let now = 1000; const moved = fixture(); moved.options.clock = () => now; moved.options.authorize = (_scope, phase) => { if (phase === "before-connect") now = NaN; return true; };
    await expect(moved.send()).rejects.toThrow("image_egress_cancelled"); expect(moved.drivers.request).not.toHaveBeenCalled(); await fixture().send();
  });
  it.each(["host", "connection", "proxy-authorization", "transfer-encoding", "cookie", "Content-Type", "x-arbitrary"])("拒绝调用者注入头 %s", async name => {
    const f = fixture(); f.input.headers = { ...f.input.headers, [name]: "injected" }; await expect(f.send()).rejects.toThrow("image_egress_request_headers_invalid"); expect(f.drivers.createResolver).not.toHaveBeenCalled();
  });
  it("头值/鉴权/声明大小不匹配，或同时多个密钥头拒绝", async () => {
    for (const change of [{ "content-length": "1" }, { authorization: "Bearer x\r\nInjected: true" }, { authorization: "Basic fixture" }, { "x-api-key": "extra" }, { "accept-encoding": "gzip" }, { "content-type": "image/png" }]) {
      const f = fixture(); f.input.headers = { ...f.input.headers, ...change }; await expect(f.send()).rejects.toThrow("image_egress_request_headers_invalid"); expect(f.drivers.request).not.toHaveBeenCalled();
    }
  });
  it.each([301, 302, 307, 308])("不跟随%d，不重试且销毁响应流", async status => {
    const f = fixture(); f.reply({ status, headers: ["Content-Type", "application/json", "Location", "https://private.invalid/key"] });
    await expect(f.send()).rejects.toThrow("image_egress_redirect_rejected"); expect(f.drivers.request).toHaveBeenCalledTimes(1); expect(f.replies[0].destroyed).toBe(true);
  });
  it.each([
    ["Content-Type", "application/json", "Content-Encoding", "gzip"], ["Content-Type", "image/png"], ["Content-Type", "application/json", "content-type", "application/json"],
    ["Content-Type", "application/json", "X-Value", "private\r\nkey"], ["Content-Type", "application/json", "Content-Length", "01"], ["Content-Type", "application/json", "Content-Length", "33554433"],
  ])("响应原始头严格拒绝 %j", async headers => {
    const f = fixture(); f.reply({ headers }); await expect(f.send()).rejects.toThrow(); expect(f.replies[0].destroyed).toBe(true); expect(f.drivers.request).toHaveBeenCalledTimes(1);
  });
  it("有界响应、长度不符、半包与trailer拒绝，不把网络完成当产物/结算", async () => {
    for (const variation of ["oversize", "short", "partial", "trailer"] as const) {
      const f = fixture(); if (variation === "oversize") { f.options.maxResponseBytes = 1; f.reply({ headers: ["Content-Type", "application/json"] }); }
      if (variation === "short") f.reply({ headers: ["Content-Type", "application/json", "Content-Length", "3"] });
      if (variation === "partial") f.reply({ complete: false }); if (variation === "trailer") f.reply({ trailers: ["X-Private", "fixture"] });
      await expect(f.send()).rejects.toThrow(); expect(f.requests[0].destroy).toHaveBeenCalled();
    }
  });
  it("已取消不查DNS；DNS取消与响应等待超时真正关闭驱动，不盲目重发", async () => {
    const f = fixture(), abort = new AbortController(); abort.abort(); await expect(f.send(undefined, abort.signal)).rejects.toThrow("image_egress_cancelled"); expect(f.drivers.createResolver).not.toHaveBeenCalled();
    const waiting = fixture(), controller = new AbortController(); let cancelQuery: () => void = () => {};
    waiting.resolver.resolve4 = vi.fn((_host, _opts, done) => { cancelQuery = () => done({ code: "ECANCELLED" }, []); }); waiting.resolver.cancel = vi.fn(() => cancelQuery());
    const pending = waiting.send(undefined, controller.signal); controller.abort(); await expect(pending).rejects.toThrow("image_egress_cancelled"); expect(waiting.resolver.cancel).toHaveBeenCalled(); expect(waiting.drivers.request).not.toHaveBeenCalled();
    const stalled = fixture(); stalled.options.timeoutMs = 20; stalled.drivers.request = vi.fn((_opts, _callback) => {
      const emitter = new EventEmitter() as ClientRequest; emitter.end = (() => emitter) as typeof emitter.end;
      let closed = false; emitter.destroy = vi.fn(() => { if (!closed) { closed = true; setImmediate(() => { emitter.emit("error", Error("private-timeout")); emitter.emit("close"); }); } return emitter; }); return emitter;
    });
    await expect(stalled.send()).rejects.toThrow("image_egress_cancelled"); expect(stalled.drivers.request).toHaveBeenCalledTimes(1);
  });
  it("异常只给固定错误，不泄漏message/code/cause；失败后实例也不可重发", async () => {
    const f = fixture(), client = new ImageNetworkDriverHarness(f.options, f.drivers); f.drivers.request = vi.fn(() => { throw Object.assign(Error("private-prompt-key-address"), { code: "private-code", cause: "private-cause" }); });
    const error = await f.send(client).catch(error => error); expect(error.message).toBe("image_egress_network_failed"); expect(error.cause).toBeUndefined(); expect(JSON.stringify(error)).not.toContain("private");
    await expect(f.send(client)).rejects.toThrow("image_egress_network_consumed"); expect(f.drivers.request).toHaveBeenCalledTimes(1);
  });
});

describe("真实Node DNS/HTTPS：仅自有回环驱动，不放宽生产公网策略", () => {
  it("原生Resolver向自有UDP DNS获取全A/AAAA；全答核验，未用OS lookup", async () => {
    const dns = createSocket("udp4"), queries: number[] = []; dns.bind(0, "127.0.0.1"); await once(dns, "listening");
    const port = dns.address().port;
    dns.on("message", (query, remote) => {
      let end = 12; while (query[end]) end += query[end] + 1; end += 5; const type = query.readUInt16BE(end - 4); queries.push(type);
      const data = type === 1 ? Buffer.from([8, 8, 8, 8]) : Buffer.from("26064700470000000000000000001111", "hex");
      const header = Buffer.from(query.subarray(0, 12)); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 6); header.writeUInt32BE(0, 8);
      const answer = Buffer.alloc(12); answer.writeUInt16BE(0xc00c); answer.writeUInt16BE(type, 2); answer.writeUInt16BE(1, 4); answer.writeUInt32BE(60, 6); answer.writeUInt16BE(data.length, 10);
      dns.send(Buffer.concat([header, query.subarray(12, end), answer, data]), remote.port, remote.address);
    });
    try {
      const f = fixture(); f.drivers.createResolver = options => { const resolver = new Resolver(options); resolver.setServers([`127.0.0.1:${port}`]); return resolver; };
      let pinned: Promise<unknown> | undefined; const original = f.drivers.request;
      f.drivers.request = (options, callback) => { pinned = callLookup(options); return original(options, callback); };
      await f.send(); expect(queries.sort()).toEqual([1, 28]); expect(await pinned).toEqual({ address: "8.8.8.8", family: 4 });
    } finally { dns.close(); await once(dns, "close"); }
  });
  it("原生Resolver cancel停止自有未响应DNS，之后可再次使用容量", async () => {
    const dns = createSocket("udp4"); dns.bind(0, "127.0.0.1"); await once(dns, "listening");
    try {
      const f = fixture(); f.options.timeoutMs = 30; let resolver: Resolver | undefined;
      f.drivers.createResolver = options => { resolver = new Resolver(options); resolver.setServers([`127.0.0.1:${dns.address().port}`]); return resolver; };
      await expect(f.send()).rejects.toThrow("image_egress_cancelled"); expect(resolver).toBeDefined(); expect(f.drivers.request).not.toHaveBeenCalled();
      await new Promise(resolve => setImmediate(resolve)); await fixture().send();
    } finally { dns.close(); await once(dns, "close"); }
  });
  it.each(["valid", "untrusted", "hostname", "redirect", "truncated", "cancel", "duplicates", "large-headers", "many-headers", "gzip", "revoke", "expired"] as const)("真实HTTPS/TLS行为 %s，明确本地路由/测试CA不是生产接通", async variant => {
    const seen: Array<{ servername: string; host: string; path: string; body: string }> = [], peers: Socket[] = [];
    const server = createServer({ key: ownedTestKey, cert: ownedTestCertificate }, (req, res) => {
      const parts: Buffer[] = []; req.on("data", part => parts.push(part)); req.on("end", () => {
        seen.push({ servername: (req.socket as Socket & { servername: string }).servername, host: req.headers.host!, path: req.url!, body: Buffer.concat(parts).toString() });
        if (variant === "cancel") { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); return; }
        if (variant === "truncated") { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "10" }); res.end("{}"); return; }
        if (variant === "duplicates") { res.writeHead(200, ["Content-Type", "application/json", "X-Repeat", "one", "X-Repeat", "two", "Content-Length", "2"]); res.end("{}"); return; }
        if (variant === "large-headers") { res.writeHead(200, { "Content-Type": "application/json", "X-Large": "x".repeat(17000), "Content-Length": "2" }); res.end("{}"); return; }
        if (variant === "many-headers") { res.writeHead(200, { "Content-Type": "application/json", ...Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`x-field-${i}`, "fixture"])) }); res.end("{}"); return; }
        if (variant === "gzip") { res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": "2" }); res.end("{}"); return; }
        res.writeHead(variant === "redirect" ? 302 : 200, { "Content-Type": "application/json", "Content-Length": "2", ...(variant === "redirect" ? { Location: "https://not-called.invalid/key" } : {}) }); res.end("{}");
      });
    });
    server.on("connection", socket => { peers.push(socket); }); server.on("tlsClientError", () => {}); server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const f = fixture(); f.options.timeoutMs = variant === "cancel" || variant === "truncated" ? 150 : 2000;
      if (variant === "revoke") f.options.authorize = (_scope, phase) => phase !== "before-write";
      if (variant === "expired") { let now = 1000; f.options.clock = () => now; f.options.authorize = (_scope, phase) => { if (phase === "before-write") now = 31000; return true; }; }
      // The shared production policy still sees a PUBLIC address and would never
      // connect to 127.0.0.1. This explicitly local DRIVER asserts original pin
      // options, then changes ONLY routing/CA for the owned real TLS server.
      f.drivers.request = vi.fn((options, callback) => {
        expect(options.servername).toBe("owned.fixture.invalid"); expect(options.rejectUnauthorized).toBe(true); expect(options.checkServerIdentity).toBe(checkServerIdentity);
        const address = server.address(); if (!address || typeof address === "string") throw Error("owned-server-address");
        return httpsRequest({ ...options, port: address.port, ...(variant !== "untrusted" ? { ca: ownedTestCertificate } : {}),
          ...(variant === "hostname" ? { servername: "mismatch.fixture.invalid" } : {}), lookup: (_host, _opts, done) => done(null, "127.0.0.1", 4) }, callback);
      });
      const promise = f.send(); if (variant === "valid") { expect((await promise).body).toEqual(Buffer.from("{}")); expect(seen).toEqual([{ servername: "owned.fixture.invalid", host: "owned.fixture.invalid", path: "/v1/images/generations", body: f.input.body.toString() }]); }
      else await expect(promise).rejects.toThrow(variant === "redirect" ? "image_egress_redirect_rejected" : variant === "cancel" ? "image_egress_cancelled" : variant === "duplicates" || variant === "many-headers" ? "image_egress_response_headers_invalid" : variant === "gzip" ? "image_egress_response_encoding_invalid" : variant === "revoke" ? "image_egress_permission_denied" : variant === "expired" ? "image_egress_dns_expired" : /image_egress_(network_failed|cancelled)/);
      expect(f.drivers.request).toHaveBeenCalledTimes(1); if (["untrusted", "hostname", "revoke", "expired"].includes(variant)) expect(seen).toHaveLength(0);
    } finally { for (const socket of peers) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
