import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheGeneratedAsset, MAX_GENERATED_CACHE_BYTES } from "../apps/web/src/assets/generatedAssetCache";
import type { VerifiedImage } from "../packages/contracts/src/index";
const bytes = new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]), sum = createHash("sha256").update(bytes).digest("hex");
const receipt: VerifiedImage = { schemaVersion: 1, id: "verified-1", tenantId: "local-studio", registeredMetadataSha256: "0".repeat(64), checksumSha256: sum,
  decoder: "sharp-full-decode-v1", verifiedBy: "local-designer", verifiedAt: "2026-10-04T00:00:00Z",
  asset: { id: "generated-1", projectId: "project-a", kind: "image", purpose: "generated", mimeType: "image/png", byteSize: bytes.length,
    width: 1024, height: 1024, storageKey: "local-verified:opaque", contentFingerprint: `sha256:${sum}`, originalName: "generated-1.png", createdAt: "2026-10-04T00:00:00Z" } };
const controller = () => new AbortController();
function metadata(value: unknown = receipt) { return new Response(JSON.stringify(value), { headers: { "cache-control": "no-store", "content-type": "application/json" } }); }
function content(body: BodyInit = bytes, extra: Record<string,string> = {}) { return new Response(body, { headers: { "cache-control": "private, no-store", "content-type": "image/png",
  "content-length": String(bytes.length), "x-content-sha256": sum, "x-canvas-binary-version": "generated-image-v1", ...extra } }); }
function setup(responses = [metadata(), content()]) {
  const cacheGenerated = vi.fn(async (r: VerifiedImage, _blob: Blob, signal: AbortSignal) => { signal.throwIfAborted(); return r.asset; });
  const fetchMock = vi.fn(); for (const response of responses) fetchMock.mockResolvedValueOnce(response); vi.stubGlobal("fetch", fetchMock);
  return { repository: { cacheGenerated }, fetchMock, signal: controller().signal };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("生成原文件受控浏览器下载", () => {
  it("固定同源只读、不重试，核验收据和原字节后才调用缓存端口", async () => {
    const f = setup(); expect(await cacheGeneratedAsset("project-a", "generated-1", f)).toEqual(receipt.asset);
    expect(f.fetchMock.mock.calls.map(([url]) => url)).toEqual(["/studio-api/v1/projects/project-a/assets/generated-1/verification", "/studio-api/v1/projects/project-a/generated-assets/generated-1/content"]);
    for (const [, options] of f.fetchMock.mock.calls) expect(options).toMatchObject({ method: "GET", headers: { "x-canvas-local": "1" }, cache: "no-store", credentials: "same-origin", mode: "same-origin", redirect: "error", referrerPolicy: "no-referrer" });
    const [r, original] = f.repository.cacheGenerated.mock.calls[0]; expect(r).toEqual(receipt); expect(original.type).toBe("image/png"); expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
  });
  it.each(["project", "asset", "tenant", "purpose", "size", "pixels", "format"])("%s 错配收据拒绝，未下载产物或写缓存", async (field) => {
    const bad = structuredClone(receipt);
    if (field === "project") bad.asset.projectId = "foreign"; if (field === "asset") bad.asset.id = "other";
    if (field === "tenant") bad.tenantId = "other"; if (field === "purpose") bad.asset.purpose = "source";
    if (field === "size") bad.asset.byteSize = MAX_GENERATED_CACHE_BYTES + 1; if (field === "pixels") bad.asset.width = bad.asset.height = 4096;
    if (field === "format") bad.asset.mimeType = "image/gif";
    const f = setup([metadata(bad)]); await expect(cacheGeneratedAsset("project-a", "generated-1", f)).rejects.toThrow(); expect(f.fetchMock).toHaveBeenCalledTimes(1); expect(f.repository.cacheGenerated).not.toHaveBeenCalled();
  });
  it.each([{ "content-type": "image/jpeg" }, { "content-length": "12" }, { "x-content-sha256": "1".repeat(64) }, { "x-canvas-binary-version": "other" }, { "content-encoding": "gzip" }, { "cache-control": "public" }])("响应头 %j 错配拒绝写缓存", async (headers) => {
    const f = setup([metadata(), content(bytes, headers)]); await expect(cacheGeneratedAsset("project-a", "generated-1", f)).rejects.toThrow(); expect(f.repository.cacheGenerated).not.toHaveBeenCalled();
  });
  it.each([bytes.slice(0, 4), new Uint8Array(bytes.length), new Uint8Array(bytes.length + 1)])("实际字节截断/篡改/超声明限制拒绝写缓存", async (body) => {
    const f = setup([metadata(), content(body)]); await expect(cacheGeneratedAsset("project-a", "generated-1", f)).rejects.toThrow(); expect(f.repository.cacheGenerated).not.toHaveBeenCalled();
  });
  it.each([401,403,404,429,503])("HTTP %i 不自动重试或用旧缓存冒充许可", async (status) => {
    const f = setup([metadata(), new Response("private-error", { status, headers: { "cache-control": "no-store" } })]); await expect(cacheGeneratedAsset("project-a", "generated-1", f)).rejects.toThrow(/读取被拒绝/);
    expect(f.fetchMock).toHaveBeenCalledTimes(2); expect(f.repository.cacheGenerated).not.toHaveBeenCalled();
  });
  it("有界收据流超过32KiB取消，不接任意大JSON", async () => {
    const cancel = vi.fn(), stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(32769)); }, cancel });
    const f = setup([new Response(stream, { headers: { "cache-control": "no-store" } })]); await expect(cacheGeneratedAsset("project-a", "generated-1", f)).rejects.toThrow(/容量限制/); expect(cancel).toHaveBeenCalled(); expect(f.repository.cacheGenerated).not.toHaveBeenCalled();
  });
  it.each(["empty", "fragments"])("%s 异常分片流取消，避免按块对象无界增长", async (kind) => {
    const cancel=vi.fn();let n=0; const stream=new ReadableStream({pull(c){if(kind==="empty")c.enqueue(new Uint8Array());else{c.enqueue(new Uint8Array([32]));n++;}},cancel});
    const f=setup([new Response(stream,{headers:{"cache-control":"no-store"}})]);await expect(cacheGeneratedAsset("project-a","generated-1",f)).rejects.toThrow(/分片/);expect(cancel).toHaveBeenCalled();if(kind==="fragments")expect(n).toBeLessThan(4100);expect(f.repository.cacheGenerated).not.toHaveBeenCalled();
  });
  it("手动取消未结束的流，未缓存或第二次发送", async () => {
    const cancel = vi.fn(), c = controller(), f = setup([metadata(), content(new ReadableStream({ cancel }))]);
    const pending = cacheGeneratedAsset("project-a", "generated-1", { ...f, signal: c.signal });
    await vi.waitFor(() => expect(f.fetchMock).toHaveBeenCalledTimes(2)); c.abort(); await expect(pending).rejects.toThrow(); expect(cancel).toHaveBeenCalled(); expect(f.repository.cacheGenerated).not.toHaveBeenCalled();
  });
  it("最多两份下载，第三份不排队；取消释放槽位", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(new ReadableStream(), { headers: { "cache-control": "no-store" } })); vi.stubGlobal("fetch", fetchMock);
    const a=controller(),b=controller(),r={ cacheGenerated: vi.fn() };
    const first=cacheGeneratedAsset("project-a","generated-1",{signal:a.signal,repository:r}),second=cacheGeneratedAsset("project-a","generated-2",{signal:b.signal,repository:r});
    const complete=Promise.allSettled([first,second]); await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await expect(cacheGeneratedAsset("project-a","generated-3",{signal:controller().signal,repository:r})).rejects.toThrow(/正在缓存/); a.abort();b.abort(); await complete;
    const f=setup(); await expect(cacheGeneratedAsset("project-a","generated-1",f)).resolves.toEqual(receipt.asset);
  });
  it("30秒超时取消等待，缓存故障不自动重新下载", async () => {
    vi.useFakeTimers(); const cancel=vi.fn(),f=setup([new Response(new ReadableStream({cancel}),{headers:{"cache-control":"no-store"}})]);
    const pending=cacheGeneratedAsset("project-a","generated-1",f); const assertion=expect(pending).rejects.toThrow(/超时/); await vi.advanceTimersByTimeAsync(30001); await assertion; expect(cancel).toHaveBeenCalled();
    vi.useRealTimers(); const good=setup(); good.repository.cacheGenerated.mockRejectedValueOnce(new Error("cache-full")); await expect(cacheGeneratedAsset("project-a","generated-1",good)).rejects.toThrow("cache-full"); expect(good.fetchMock).toHaveBeenCalledTimes(2);
  });
});
