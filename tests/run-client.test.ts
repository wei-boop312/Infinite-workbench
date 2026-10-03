import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMoney, StudioRunClient } from "../apps/web/src/runs/runClient";

afterEach(() => vi.unstubAllGlobals());
describe("画布任务客户端", () => {
  it("金额解析不使用浮点四舍五入，拒绝负数和额外精度", () => {
    expect(parseMoney("0.29")).toBe(29);
    expect(parseMoney(" 2.5 ")).toBe(250);
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
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await expect(client.budget("project-a")).rejects.toThrow(/可安全重试/);
    fetchMock.mockResolvedValueOnce(new Response("<html></html>", { status: 200 }));
    await expect(client.list("project-a")).rejects.toThrow(/有效数据/);
  });
});
