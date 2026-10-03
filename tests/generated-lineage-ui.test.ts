import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratedAssetLineageSchema } from "../packages/contracts/src/index";
import { StudioRunClient } from "../apps/web/src/runs/runClient";
import { fixturePublicPreparation, fixturePublicConfirmation } from "./fixtures/image-preparation";

const fixture = () => {
  const prepared = fixturePublicPreparation(), confirmed = fixturePublicConfirmation(prepared), batch = confirmed.aggregate;
  batch.batch.status = "billing_unknown"; batch.jobs[0].status = "billing_unknown"; batch.jobs[0].outputAssetIds = ["actual-output"];
  const view = GeneratedAssetLineageSchema.parse({ schemaVersion: 1, mode: "local-fixture", realExecutionEnabled: false, tenantId: "local-studio", projectId: "project-a",
    batchId: batch.batch.id, jobId: batch.jobs[0].id, jobStatus: "billing_unknown", protocol: "openai", connectionName: prepared.connection.name,
    requestTemplate: prepared.requestTemplate, constraint: prepared.constraint, pricing: prepared.pricing, preparationId: prepared.id,
    preparationFingerprint: prepared.snapshotFingerprint, executionFingerprint: confirmed.executionFingerprint, requestFingerprint: confirmed.requestFingerprint,
    payloadChecksumSha256: confirmed.payloadChecksumSha256, generatedRecordFingerprint: "b".repeat(64), transformedInputs: [], confirmedBy: confirmed.confirmedBy, confirmedAt: confirmed.confirmedAt,
    image: { schemaVersion: 1, id: "actual-receipt", tenantId: "local-studio", registeredMetadataSha256: "c".repeat(64), checksumSha256: "d".repeat(64),
      decoder: "sharp-full-decode-v1", verifiedBy: "fixture-designer", verifiedAt: prepared.createdAt, asset: { id: "actual-output", projectId: "project-a", kind: "image", purpose: "generated",
        originalName: "actual.png", contentFingerprint: `sha256:${"d".repeat(64)}`, storageKey: "local-verified:opaque-fixture", mimeType: "image/png", byteSize: 8000, width: 1024, height: 1024, createdAt: prepared.createdAt } },
    billing: { state: "unknown", currency: "CNY", reservedMinor: 30, batchMaxCostMinor: 30 } });
  return { view, batch, job: batch.jobs[0] };
};
const reply = (payload: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json", "cache-control": "private, no-store", ...headers } });
afterEach(() => vi.unstubAllGlobals());
describe("实际图片谱系浏览器只读合同", () => {
  it("固定同源有界GET；绑定实际输出编号，不发送自报证据或任务命令", async () => {
    const f = fixture(), fetcher = vi.fn().mockResolvedValue(reply(f.view)); vi.stubGlobal("fetch", fetcher);
    expect(await new StudioRunClient(new AbortController().signal).generatedLineage(f.batch, f.job)).toEqual(f.view);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toBe("/studio-api/v1/projects/project-a/generated-assets/actual-output/lineage");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store", redirect: "error", credentials: "same-origin", headers: { "x-canvas-local": "1" } });
    expect(fetcher.mock.calls[0][1].body).toBeUndefined();
  });
  it.each(["task", "batch", "output", "scope", "constraint", "currency", "authority", "secret", "billing"])("%s 错配拒绝，不用缓存或自动重发", async damage => {
    const f = fixture(), payload = structuredClone(f.view);
    if (damage === "task") payload.jobId = "foreign"; if (damage === "batch") payload.batchId = "foreign"; if (damage === "output") payload.image.asset.id = "foreign";
    if (damage === "scope") payload.tenantId = "foreign"; if (damage === "constraint") payload.constraint.brandRules.tone = "unconfirmed-current-form";
    if (damage === "currency") { payload.billing.currency = "USD"; payload.pricing.quote.currency = "USD"; payload.requestTemplate.quote.currency = "USD"; }
    if (damage === "authority") payload.realExecutionEnabled = true as never; if (damage === "secret") Object.assign(payload, { credentialRef: "private" });
    if (damage === "billing") payload.billing.reservedMinor = 0;
    const fetcher = vi.fn().mockResolvedValue(reply(payload)); vi.stubGlobal("fetch", fetcher);
    await expect(new StudioRunClient(new AbortController().signal).generatedLineage(f.batch, f.job)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("没有实际输出/旧mock/不属于当前批次，网络前拒绝", async () => {
    const f = fixture(), fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); const client = new StudioRunClient(new AbortController().signal);
    await expect(client.generatedLineage(f.batch, { ...f.job, outputAssetIds: [] })).rejects.toThrow();
    await expect(client.generatedLineage(f.batch, { ...f.job, batchId: "foreign" })).rejects.toThrow();
    await expect(client.generatedLineage({ ...f.batch, batch: { ...f.batch.batch, tool: "product-retouch" } }, f.job)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("超限/可缓存/中断响应都失败关闭，只读不自动GET重试", async () => {
    const f = fixture(), fetcher = vi.fn().mockResolvedValueOnce(reply(f.view, { "content-length": String(512 * 1024 + 1) }))
      .mockResolvedValueOnce(reply(f.view, { "cache-control": "public" })).mockRejectedValueOnce(new Error("lost")); vi.stubGlobal("fetch", fetcher);
    const client = new StudioRunClient(new AbortController().signal);
    for (let index = 0; index < 3; index++) await expect(client.generatedLineage(f.batch, f.job)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(3);
    const controller = new AbortController(); fetcher.mockImplementationOnce(async () => { controller.abort(); return reply(f.view); });
    await expect(new StudioRunClient(controller.signal).generatedLineage(f.batch, f.job)).rejects.toThrow();
  });
});
