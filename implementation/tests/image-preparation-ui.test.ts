import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageProviderPublicSchema, ImagePreparationPublicSchema, type Asset } from "../packages/contracts/src/index";
import { imageProviderPublicView } from "../apps/api/src/imageProviderContract";
import { buildImageSelection, emptyImageDraft, readImageRecovery, type ImagePreparationDraft } from "../apps/web/src/runs/imagePreparationDraft";
import { StudioRunClient } from "../apps/web/src/runs/runClient";
import { fixtureConnection, fixtureConstraint, fixtureSelection, fixturePublicPreparation } from "./fixtures/image-preparation";

afterEach(() => { vi.unstubAllGlobals(); });
const provider = () => imageProviderPublicView(fixtureConnection());
const draft = (fields: Partial<ImagePreparationDraft> = {}): ImagePreparationDraft => ({ ...emptyImageDraft(), connectionId: "fixture-openai", model: "explicit-fixture-model",
  operation: "generate", constraintId: "constraint-a", prompt: "人工设计目标", quality: "auto", background: "opaque", ...fields });
const build = (fields: Partial<ImagePreparationDraft> = {}, constraint = fixtureConstraint(), assets: Asset[] = [], missing = new Set<string>()) =>
  buildImageSelection("project-a", "human-action", draft(fields), [provider()], [constraint], assets, missing);
const source: Asset = { id: "source", projectId: "project-a", kind: "image", purpose: "source", originalName: "source.png", storageKey: "local-source",
  mimeType: "image/png", byteSize: 68, width: 1, height: 1, createdAt: "2026-10-04T00:00:00.000Z" };
const reply = (payload: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

describe("明确选择与非授权准备单浏览器合同", () => {
  it("明确选择、约束尺寸和参数转换，不包含价钱/确认/任务；每次新动作由调用者明确给号", () => {
    expect(build()).toEqual(fixtureSelection()); expect(build().parameters.n).toBe(1);
  });
  it.each([ { connectionId: "" }, { model: "" }, { operation: "" }, { quality: "" }, { background: "" }, { prompt: "" }, { inputFidelity: "high" }, { extraValues: { arbitrary: "1" } } ] as Partial<ImagePreparationDraft>[])("缺少或非法选择拒绝，不自动选定 %j", fields => expect(() => build(fields)).toThrow());
  it("商品锁、4K超限、格式或不支持尺寸拒绝，不能靠auto绕过本机像素政策", () => {
    expect(() => build({}, fixtureConstraint({ lockedPaths: ["product.pixels"] }))).toThrow("不会移除锁定");
    for (const sizeMode of ["constraint", "auto"] as const) expect(() => build({ sizeMode }, fixtureConstraint({ outputSpec: { width: 4096, height: 4096, format: "png" } }))).toThrow("未估价");
    expect(() => build({}, fixtureConstraint({ outputSpec: { width: 1200, height: 1200, format: "png" } }))).toThrow("不会改尺寸");
    expect(() => build({}, fixtureConstraint({ outputSpec: { width: 1024, height: 1024, format: "mp4" } }))).toThrow("输出格式");
  });
  it("编辑明确选择原图/蒙版，保留顺序；缺原文件、错误蒙版和超限均拒绝", () => {
    expect(build({ operation: "edit", inputAssetIds: ["source"] }, fixtureConstraint(), [source]).inputAssetIds).toEqual(["source"]);
    expect(() => build({ operation: "edit", inputAssetIds: ["source"] }, fixtureConstraint(), [source], new Set(["source"]))).toThrow("原文件缺失");
    expect(() => build({ operation: "generate", inputAssetIds: ["source"] }, fixtureConstraint(), [source])).toThrow("不能携带编辑输入");
    expect(() => build({ operation: "edit", inputAssetIds: ["source"], maskAssetId: "mask" }, fixtureConstraint(), [source])).toThrow("不能静默忽略");
  });
  it("中转只接受明确规则中的整数/布尔/枚举，不发送空值或受保护字段", () => {
    const config = imageProviderPublicView(fixtureConnection("openai-compatible"));
    const convert = (values: Record<string,string>) => buildImageSelection("project-a", "human-action", draft({ connectionId: config.id, extraValues: values }), [config], [fixtureConstraint()], [], new Set());
    expect(convert({ seed: "0", watermark: "false", style_hint: "studio" }).providerParameters).toEqual({ seed: 0, watermark: false, style_hint: "studio" });
    expect(convert({ seed: "" }).providerParameters).toBeUndefined();
    for (const values of [{ seed: "101" }, { seed: "0.5" }, { watermark: "no" }, { style_hint: "arbitrary" }, { model: "override" }]) expect(() => convert(values)).toThrow();
  });
  it("公开模型保留全部能力校验，私有地址/凭证和假执行授权失败关闭", () => {
    const visible = provider(); expect(visible.models[0].sizes).toEqual(fixtureConnection().models[0].sizes);
    for (const fields of [{ baseUrl: "private" }, { credentialRef: "private" }, { realExecutionEnabled: true }]) expect(ImageProviderPublicSchema.safeParse({ ...visible, ...fields }).success).toBe(false);
    expect(ImageProviderPublicSchema.safeParse({ ...visible, models: [{ ...visible.models[0], mask: { mode: "none", polarity: "white-edit" } }] }).success).toBe(false);
    const record = fixturePublicPreparation();
    for (const fields of [{ executionAuthorized: true }, { jobId: "fake" }, { projectId: "foreign" }, { pricing: { ...record.pricing, quote: { ...record.pricing.quote, maxCostMinor: 99 } } }]) expect(ImagePreparationPublicSchema.safeParse({ ...record, ...fields }).success).toBe(false);
  });
  it("恢复指针只接受本项目选择，拒绝损坏、价钱/授权和跨项目，不自动重新报价", () => {
    const record = { schemaVersion: 1, selection: fixtureSelection(), preparationId: "preparation-a" };
    expect(readImageRecovery(JSON.stringify(record), "project-a")).toEqual(record); expect(readImageRecovery(null, "project-a")).toBeNull();
    for (const raw of ["broken", JSON.stringify({ ...record, confirmed: true }), JSON.stringify({ ...record, quote: {} }), "x".repeat(128 * 1024 + 1)]) expect(() => readImageRecovery(raw, "project-a")).toThrow();
    expect(() => readImageRecovery(JSON.stringify(record), "foreign")).toThrow("属于其他项目");
  });
  it("客户端只调用同源新准备/目录/历史入口，no-store且不执行/创建任务", async () => {
    const fake = vi.fn().mockResolvedValueOnce(reply([provider()])).mockResolvedValueOnce(reply(fixturePublicPreparation())).mockResolvedValueOnce(reply(fixturePublicPreparation())); vi.stubGlobal("fetch", fake);
    const client = new StudioRunClient(new AbortController().signal);
    expect(await client.imageProviders("project-a")).toEqual([provider()]); await client.prepareImage(fixtureSelection()); await client.imagePreparation("project-a", "preparation-a");
    expect(fake.mock.calls.map(([path]) => path)).toEqual(["/studio-api/v1/projects/project-a/image-providers", "/studio-api/v1/projects/project-a/image-preparations", "/studio-api/v1/projects/project-a/image-preparations/preparation-a"]);
    for (const [, options] of fake.mock.calls) expect(options).toMatchObject({ cache: "no-store", redirect: "error", credentials: "same-origin", headers: { "x-canvas-local": "1" } });
  });
  it.each(["project", "model", "parameters", "id"])("客户端拒绝响应错配 %s，不能把其他选择或历史当成功", async damage => {
    const record = fixturePublicPreparation();
    if (damage === "project") { record.projectId = "foreign"; record.requestTemplate.projectId = "foreign"; record.constraint.projectId = "foreign"; }
    if (damage === "model") { record.requestTemplate.model = "different"; record.connection.models[0].model = "different"; }
    if (damage === "parameters") record.requestTemplate.parameters.prompt = "not-the-human-choice";
    if (damage === "id") record.id = "foreign-id";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(record))); const client = new StudioRunClient(new AbortController().signal);
    if (damage === "id") await expect(client.imagePreparation("project-a", "preparation-a")).rejects.toThrow("编号");
    else await expect(client.prepareImage(fixtureSelection())).rejects.toThrow("不一致");
  });
  it("目录/历史坏合同或过大响应失败关闭；取消后不恢复成功", async () => {
    const fake = vi.fn().mockResolvedValueOnce(reply([provider()], { "content-length": String(2 * 1024 * 1024 + 1) }))
      .mockResolvedValueOnce(reply([{ ...provider(), privateEndpoint: "hidden" }])).mockResolvedValueOnce(reply(fixturePublicPreparation())); vi.stubGlobal("fetch", fake);
    const abort = new AbortController(); const client = new StudioRunClient(abort.signal);
    await expect(client.imageProviders("project-a")).rejects.toThrow("有效数据"); await expect(client.imageProviders("project-a")).rejects.toThrow("符合合同");
    abort.abort(); await expect(client.imagePreparation("project-a", "preparation-a")).rejects.toThrow();
  });
  it("实际流超过声明缺省上限仍拒绝，非JSON或可缓存的响应也不接受", async () => {
    const fake = vi.fn().mockResolvedValueOnce(reply("x".repeat(2 * 1024 * 1024)))
      .mockResolvedValueOnce(reply([provider()], { "content-type": "text/html" }))
      .mockResolvedValueOnce(reply([provider()], { "cache-control": "public, max-age=600" })); vi.stubGlobal("fetch", fake);
    const client = new StudioRunClient(new AbortController().signal);
    for (let i = 0; i < 3; i++) await expect(client.imageProviders("project-a")).rejects.toThrow("有效数据");
  });
});
