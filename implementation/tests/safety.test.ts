import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

describe("真实供应商网络隔离", () => {
  it("只有独立本地任务客户端可发起固定同源请求", () => {
    const files = sourceFiles(join(process.cwd(), "apps", "web", "src"));
    const clientPath = join(process.cwd(), "apps", "web", "src", "runs", "runClient.ts");
    for (const file of files) {
      let source = readFileSync(file, "utf8");
      if (file === clientPath) {
        expect(source.match(/\bfetch\s*\(/g)).toHaveLength(1);
        expect(source).toContain('"x-canvas-local": "1"');
        expect(source).not.toMatch(/https?:\/\/|Bearer|api[_-]?key/i);
        source = source.replace('fetch(`/studio-api${path}`,', "localRequest(");
      }
      expect(source, file).not.toMatch(/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\baxios\b/);
    }
  });
  it("任务和预算响应绕过离线缓存", () => {
    const source = readFileSync(join(process.cwd(), "apps", "web", "public", "sw.js"), "utf8");
    expect(source).toContain('if (url.pathname.startsWith("/studio-api/") || url.pathname.startsWith("/v1/")) return;');
    expect(source).toContain('!response.headers.get("cache-control")?.includes("no-store")');
  });
});
