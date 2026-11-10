import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagePreparationPublicSchema, ImageConfirmationPublicSchema } from "../packages/contracts/src/index";
import { StudioRunClient } from "../apps/web/src/runs/runClient";
import { readConfirmationRecovery } from "../apps/web/src/runs/imageConfirmationRecovery";
import { fixturePublicPreparation, fixturePublicConfirmation } from "./fixtures/image-preparation";

afterEach(() => vi.unstubAllGlobals());
const reply = (payload: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
describe("完整人工冻结确认浏览器合同", () => {
  it("原约束必填且关系严格；不能用编号或客户端现值代替", () => {
    const record = fixturePublicPreparation();
    const { constraint: _constraint, ...missing } = record; expect(ImagePreparationPublicSchema.safeParse(missing).success).toBe(false);
    for (const constraint of [{ ...record.constraint, id: "foreign" }, { ...record.constraint, projectId: "foreign" }, { ...record.constraint, lockedPaths: ["product.pixels"] },
      { ...record.constraint, outputSpec: { width: 800, height: 800, format: "png" } }]) expect(ImagePreparationPublicSchema.safeParse({ ...record, constraint }).success).toBe(false);
  });
  it("篡改品牌/区域但保留原SHA失败关闭，不能提交确认", async () => {
    const record = fixturePublicPreparation(); record.constraint.brandRules.tone = "未曾确认的品牌规则";
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(new StudioRunClient(new AbortController().signal).confirmImage(record)).rejects.toThrow("人工约束摘要不一致"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("确认只发送完整原摘要/币种/估价/上限，同源有界且不发送私有执行字段", async () => {
    const record = fixturePublicPreparation(), result = fixturePublicConfirmation(record), fetcher = vi.fn().mockResolvedValue(reply(result)); vi.stubGlobal("fetch", fetcher);
    expect(await new StudioRunClient(new AbortController().signal).confirmImage(record)).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(1); const [path, options] = fetcher.mock.calls[0];
    expect(path).toBe("/studio-api/v1/projects/project-a/image-preparations/preparation-a/confirm");
    expect(options).toMatchObject({ method: "POST", cache: "no-store", redirect: "error", credentials: "same-origin", headers: { "x-canvas-local": "1" } });
    expect(JSON.parse(options.body)).toEqual({ expectedSnapshotFingerprint: record.snapshotFingerprint, expectedEstimatedCostMinor: 25, expectedMaxCostMinor: 30, expectedCurrency: "CNY" });
  });
  it("只读恢复空确认和已确认历史不POST；不存在客户端自报授权", async () => {
    const record = fixturePublicPreparation(), confirmed = fixturePublicConfirmation(record);
    const history = { mode: "local-fixture", preparationId: record.id, preparationFingerprint: record.snapshotFingerprint };
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ ...history, confirmation: null })).mockResolvedValueOnce(reply({ ...history, confirmation: confirmed })); vi.stubGlobal("fetch", fetcher);
    const client = new StudioRunClient(new AbortController().signal); expect(await client.imageConfirmation(record)).toBeNull(); expect(await client.imageConfirmation(record)).toEqual(confirmed);
    for (const [path, options] of fetcher.mock.calls) { expect(path).toMatch(/\/confirmation$/); expect(options.method).toBe("GET"); expect(options.body).toBeUndefined(); }
  });
  it.each(["preparation", "currency", "project", "ceiling", "tool", "inputs", "time", "transform"])("确认响应错配 %s 失败关闭，不补发", async damage => {
    const record = fixturePublicPreparation(), result = fixturePublicConfirmation(record);
    if (damage === "preparation") result.preparationFingerprint = "1".repeat(64);
    if (damage === "currency") result.aggregate.batch.currency = "USD";
    if (damage === "project") result.aggregate.batch.projectId = "foreign";
    if (damage === "ceiling") result.aggregate.batch.maxCostMinor = 25;
    if (damage === "tool") result.aggregate.batch.tool = "image-edit";
    if (damage === "inputs") result.aggregate.batch.inputAssetIds = ["foreign"];
    if (damage === "time") { result.confirmedAt = "2100-01-01T00:00:00.000Z"; result.aggregate.batch.confirmedAt = result.confirmedAt; }
    if (damage === "transform") result.transformedInputs = [{ assetId: "foreign", originalChecksumSha256: "a".repeat(64), transmittedChecksumSha256: "b".repeat(64), transform: "exif-srgb-png-v1" }];
    const fetcher = vi.fn().mockResolvedValue(reply(result)); vi.stubGlobal("fetch", fetcher);
    await expect(new StudioRunClient(new AbortController().signal).confirmImage(record)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("坏合同/超限/可缓存响应与取消失败关闭，不自动重试", async () => {
    const record = fixturePublicPreparation(), result = fixturePublicConfirmation(record);
    expect(ImageConfirmationPublicSchema.safeParse({ ...result, executionAuthorized: true }).success).toBe(false);
    const fetcher = vi.fn().mockResolvedValueOnce(reply(result, { "content-length": String(512 * 1024 + 1) }))
      .mockResolvedValueOnce(reply(result, { "cache-control": "public" })).mockRejectedValueOnce(new Error("response-lost")); vi.stubGlobal("fetch", fetcher);
    const client = new StudioRunClient(new AbortController().signal); for (let index = 0; index < 3; index++) await expect(client.confirmImage(record)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(3);
    const abort = new AbortController(); abort.abort(); await expect(new StudioRunClient(abort.signal).confirmImage(record)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("恢复指针只保存本项目原编号及摘要，不接受报价/授权或损坏/跨项目", () => {
    const pointer = { schemaVersion: 1, projectId: "project-a", preparationId: "preparation-a", preparationFingerprint: "a".repeat(64) };
    expect(readConfirmationRecovery(JSON.stringify(pointer), "project-a")).toEqual(pointer); expect(readConfirmationRecovery(null, "project-a")).toBeNull();
    for (const raw of ["broken", "x".repeat(16 * 1024 + 1), JSON.stringify({ ...pointer, quote: {} }), JSON.stringify({ ...pointer, executionAuthorized: true })]) expect(() => readConfirmationRecovery(raw, "project-a")).toThrow();
    expect(() => readConfirmationRecovery(JSON.stringify(pointer), "foreign")).toThrow();
  });
});
