import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { money, parseMoney, StudioRunClient } from "../apps/web/src/runs/runClient";

afterEach(() => vi.unstubAllGlobals());
describe("画布任务客户端", () => {
  it("金额解析不使用浮点四舍五入，拒绝负数和额外精度", () => {
    expect(parseMoney("0.29")).toBe(29);
    expect(parseMoney(" 2.5 ")).toBe(250);
    expect(money(Number.MAX_SAFE_INTEGER)).toBe("¥90071992547409.91");
    expect(parseMoney("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of ["-1", "NaN", "1e2", "0.001", "9007199254740992"]) expect(() => parseMoney(value)).toThrow();
  });
  it("请求固定走同源接口，编码项目名，不携带供应商凭证", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await new StudioRunClient(new AbortController().signal).list("https://foreign.invalid/path");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/studio-api/v1/projects/https%3A%2F%2Fforeign.invalid%2Fpath/run-batches");
    expect(options.headers).toEqual({ "x-canvas-local": "1" });
  });
  it("服务端拒绝和网络中断显示明确错误，不伪造成功", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "project_budget_exceeded" }), { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new StudioRunClient(new AbortController().signal);
    await expect(client.budget("project-a")).rejects.toThrow(/模拟预算不足/);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "run_state_busy" }), { status: 503 }));
    await expect(client.budget("project-a")).rejects.toThrow(/保留原动作编号/);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "run_state_unavailable" }), { status: 503 }));
    await expect(client.budget("project-a")).rejects.toThrow(/未重置任何预算/);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await expect(client.budget("project-a")).rejects.toThrow(/可安全重试/);
    fetchMock.mockResolvedValueOnce(new Response("<html></html>", { status: 200 }));
    await expect(client.list("project-a")).rejects.toThrow(/有效数据/);
  });
  it("只把原文件发到同源核验入口，计算实际 SHA-256，不接受自报成功", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const sum = createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex");
    const receipt = { schemaVersion: 1, id: "verification-1", tenantId: "local-studio", checksumSha256: sum, registeredMetadataSha256: "0".repeat(64),
      decoder: "sharp-full-decode-v1", verifiedBy: "local-designer", verifiedAt: "2026-10-03T00:00:00Z",
      asset: { id: "asset-1", projectId: "project-a", kind: "image", mimeType: "image/png", byteSize: 3, width: 1, height: 1,
        storageKey: "local-verified:server", contentFingerprint: `sha256:${sum}`, originalName: "source.png", createdAt: "2026-10-03T00:00:00Z" } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new StudioRunClient(new AbortController().signal);
    expect(await client.verifyImage("project-a", "asset-1", blob, "image/png")).toEqual(receipt);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/studio-api/v1/projects/project-a/assets/asset-1/verification");
    expect(options.method).toBe("POST"); expect(options.body).toBe(blob);
    expect(options.headers).toEqual({ "x-canvas-local": "1", "content-type": "image/png", "x-content-sha256": sum });
    fetchMock.mockResolvedValueOnce(new Response('{"verified":true}', { status: 200 }));
    await expect(client.verifyImage("project-a", "asset-1", blob, "image/png")).rejects.toThrow(/有效数据/);
    fetchMock.mockResolvedValueOnce(new Response('{"error":"verified_asset_decode_failed"}', { status: 422 }));
    await expect(client.verifyImage("project-a", "asset-1", blob, "image/png")).rejects.toThrow(/完整解码/);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...receipt, asset: { ...receipt.asset, projectId: "another-project" } }), { status: 200 }));
    await expect(client.verifyImage("project-a", "asset-1", blob, "image/png")).rejects.toThrow(/不一致/);
  });
});
