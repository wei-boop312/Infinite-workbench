import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createApiServer } from "../apps/api/src/index";
import { snapshotToDocument } from "../apps/web/src/canvas/document";
import { semanticEdges, semanticNodes } from "../apps/web/src/canvas/model";

const runningServers: Server[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("画布条件修订接口", () => {
  it("保存新修订，并拒绝旧修订覆盖", async () => {
    const server = createApiServer();
    runningServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP 端口");
    const url = `http://127.0.0.1:${address.port}/v1/canvases/revision-test`;
    const document = snapshotToDocument("revision-test", "project-test", 0, { nodes: semanticNodes, edges: semanticEdges }, { x: 0, y: 0, zoom: 1 });

    const savedResponse = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "0" },
      body: JSON.stringify(document),
    });
    expect(savedResponse.status).toBe(200);
    expect(savedResponse.headers.get("etag")).toBe('"1"');
    const saved = await savedResponse.json();
    expect(saved).toMatchObject({ id: "revision-test", revision: 1 });

    const staleResponse = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "0" },
      body: JSON.stringify(document),
    });
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ error: "revision_conflict", remote: { revision: 1 } });

    const getResponse = await fetch(url);
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toMatchObject({ revision: 1 });
  });
});
