import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { LocalImageProviders } from "../apps/api/src/imageProviders";
import { createApiServer } from "../apps/api/src/index";
import { StudioRunClient } from "../apps/web/src/runs/runClient";
import { fixtureConnection, fixtureConstraint, fixtureSelection, fixtureTime } from "./fixtures/image-preparation";

describe("浏览器客户端与实际零费用HTTP/SQLite准备服务", () => {
  it("读取能力/实际准备/重复/到期/停用历史恢复不创建任务、预留或执行", async () => {
    const directory = mkdtempSync(join(tmpdir(), "canvas-image-preparation-client-"));
    const store = new SqliteRunKernelStateStore(join(directory, "state.sqlite"));
    const principal = { tenantId: "local-studio", actorId: "fixture-designer" };
    let allowed = true; let now = Date.parse(fixtureTime);
    const scope = (actor: typeof principal, project: string) => allowed && actor.tenantId === principal.tenantId && project === "project-a";
    const authorizer = { authenticate: (request: { headers: Record<string, unknown> }) => request.headers["x-canvas-local"] === "1" ? principal : null, allows: scope };
    const estimate = vi.fn((_connection: unknown, _selection: unknown, at: string) => ({ mode: "local-fixture" as const, evidenceRef: "fixture-no-real-cost",
      quote: { id: "fixture-quote", version: "fake-price-v1", source: "server-price-table" as const, currency: "CNY", estimatedCostMinor: 25, maxCostMinor: 30,
        expiresAt: new Date(Date.parse(at) + 60_000).toISOString() } }));
    store.transaction(() => store.saveCatalog({ schemaVersion: 1, projects: [{ projectId: "project-a", assets: [], constraints: [fixtureConstraint()] }] }));
    const kernel = new SqliteRunKernel({ stateStore: store, authorizer, budgets: [{ tenantId: principal.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }] });
    const providers = new LocalImageProviders({ tenantId: principal.tenantId, stateStore: store, authorizer, runAuthorizer: authorizer,
      assetAuthorizer: authorizer, estimate, clock: () => now });
    providers.registerRevision(principal, fixtureConnection(), 0);
    const server = createApiServer({ imageProviders: providers, runKernel: kernel });
    const nativeFetch = globalThis.fetch;
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture loopback port unavailable");
      const paths: string[] = [];
      vi.stubGlobal("fetch", (path: string, options: RequestInit) => {
        expect(path.startsWith("/studio-api/v1/")).toBe(true); paths.push(path);
        return nativeFetch(`http://127.0.0.1:${address.port}${path.replace(/^\/studio-api/, "")}`, options);
      });
      const client = new StudioRunClient(new AbortController().signal), before = kernel.getBudget(principal, "project-a");
      const list = await client.imageProviders("project-a"); expect(list[0].models[0]).toMatchObject({ capabilityVersion: "caps-v1", maxInputImages: 2, outputFormats: ["png", "jpeg", "webp"] });
      expect(JSON.stringify(list)).not.toMatch(/never-called|opaque-not-resolved|baseUrl|credentialRef|endpoints/);
      const prepared = await client.prepareImage(fixtureSelection());
      expect(prepared).toMatchObject({ status: "unconfirmed", executionAuthorized: false, protocolPreparation: "not-run", mode: "local-fixture" });
      expect(await client.prepareImage(fixtureSelection())).toEqual(prepared); expect(estimate).toHaveBeenCalledTimes(1);
      now += 120_000; providers.registerRevision(principal, { ...fixtureConnection(), revision: 2, enabled: false }, 1);
      expect(await client.imagePreparation("project-a", prepared.id)).toEqual(prepared);
      expect(await client.prepareImage(fixtureSelection())).toEqual(prepared); expect(estimate).toHaveBeenCalledTimes(1);
      expect(kernel.getBudget(principal, "project-a")).toEqual(before); expect(kernel.listBatches(principal, "project-a")).toEqual([]);
      expect(store.imagePreparationCount(principal.tenantId, "project-a")).toBe(1);
      allowed = false; await expect(client.imagePreparation("project-a", prepared.id)).rejects.toThrow();
      expect(paths.some(path => /confirm|dispatch|execute|run-jobs/.test(path))).toBe(false);
    } finally {
      vi.unstubAllGlobals(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
      // Only the resolved test directory created above, never user state.
      if (resolve(directory).startsWith(resolve(tmpdir()) + "\\canvas-image-preparation-client-")) rmSync(directory, { recursive: true, force: true });
    }
  });
});
