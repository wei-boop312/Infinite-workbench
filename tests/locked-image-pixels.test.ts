import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConstraintSnapshotSchema, ImageExecutionRequestSchema, ImageProviderConnectionSchema, LockedImagePixelDraftSchema, VerifiedImageSchema } from "../packages/contracts/src/index";
import { assetMetadataFingerprint } from "../apps/api/src/assetMetadata";
import { verifyLockedImagePixels, type LockedImagePixelInput } from "../apps/api/src/lockedImagePixelValidation";
import * as decoder from "../apps/api/src/staticImageDecoder";
import { validateImageProviderRequest } from "../apps/api/src/imageProviderContract";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
const hash = (body: Buffer | string) => createHash("sha256").update(body).digest("hex");
const at = "2026-10-05T00:00:00Z", clock = () => Date.parse(at);
const rgba = Buffer.from([10,20,30,255, 40,50,60,255, 70,80,90,255, 100,110,120,255, 130,140,150,128, 160,170,180,255]);
const maskRgba = Buffer.from([0,0,0,0, 255,255,255,255, 255,255,255,128, 255,255,255,255, 0,0,0,0, 255,255,255,255]);
const encode = async (pixels: Buffer, format = "png", width = 3, height = 2): Promise<Buffer> => sharp(pixels, { raw: { width, height, channels: 4 } })[format](format === "webp" ? { lossless: true } : {}).toBuffer();
let png: Buffer, maskPng: Buffer;
beforeAll(async () => { png = await encode(rgba); maskPng = await encode(maskRgba); });
afterEach(() => { vi.restoreAllMocks(); });
function receipt(id: string, body: Buffer, purpose: "source" | "mask", sourceHash?: string, mimeType = "image/png", width = 3, height = 2) {
  const asset = { id, projectId: "owned-project", kind: "image" as const, purpose, storageKey: `owned:${id}`, originalName: `${id}.png`, mimeType, byteSize: body.length,
    width, height, contentFingerprint: `sha256:${hash(body)}`, createdAt: at, ...(purpose === "mask" ? { sourceAssetId: "owned-source" } : {}) };
  return VerifiedImageSchema.parse({ schemaVersion: 1, id: `receipt-${id}`, tenantId: "owned-tenant", asset, registeredMetadataSha256: assetMetadataFingerprint(asset),
    checksumSha256: hash(body), ...(sourceHash ? { sourceChecksumSha256: sourceHash } : {}), decoder: "sharp-full-decode-v1", verifiedBy: "owned-fixture", verifiedAt: at });
}
function input(candidate = png, format: "png" | "jpeg" | "webp" = "png", source = png, mask = maskPng): LockedImagePixelInput {
  const constraint = ConstraintSnapshotSchema.parse({ id: "owned-constraint", projectId: "owned-project", lockedPaths: ["product.pixels"], editableRegions: [{ id: "region", description: "仅完全不透明白色为编辑区域", maskAssetId: "owned-mask" }],
    brandRules: { style: "冻结人工约束，不在本原语中验证风格" }, outputSpec: { width: 3, height: 2, format }, createdAt: at });
  return { protection: "pixel-exact", source: receipt("owned-source", source, "source", undefined, `image/${format}`), mask: receipt("owned-mask", mask, "mask", hash(source)),
    constraint, constraintChecksumSha256: hash(JSON.stringify(constraint)), sourceBody: source, maskBody: mask,
    candidate: { body: candidate, mimeType: `image/${format}`, checksumSha256: hash(candidate) } };
}
const updateConstraint = (i: LockedImagePixelInput) => { i.constraintChecksumSha256 = hash(JSON.stringify(i.constraint)); };
const updateReceipt = (i: LockedImagePixelInput, which: "source" | "mask") => { i[which].registeredMetadataSha256 = assetMetadataFingerprint(i[which].asset); };
describe("冻结原锁区专项的纯像素核验草稿，不是提交/执行许可", () => {
  it.each(["png", "jpeg", "webp"] as const)("%s 完整解码逐通道完全相同才通过；费用与执行不进入草稿", async format => {
    const body = await encode(rgba, format), i = input(body, format, body);
    const draft = await verifyLockedImagePixels(i, { clock });
    expect(draft).toMatchObject({ lockedPixels: 3, editablePixels: 3, protectionApplied: "checked-not-applied", artifactCommitted: false, executionAuthorized: false, realExecutionEnabled: false, settlementAuthorized: false });
    expect(draft.sourcePixelsSha256).toBe(draft.candidatePixelsSha256);
    expect(Object.keys(draft).some(key => /body|url|quote|price|usage|worker|lease|key|prompt/i.test(key))).toBe(false);
    expect(i.sourceBody.equals(body)).toBe(true);
  });
  it("仅编辑区改变可通过，无合成或改写候选", async () => {
    const changed = Buffer.from(rgba); changed[4] = 200; const candidate = await encode(changed);
    const i = input(candidate), original = Buffer.from(candidate), draft = await verifyLockedImagePixels(i, { clock });
    expect(draft.candidatePixelsSha256).not.toBe(draft.sourcePixelsSha256); expect(candidate.equals(original)).toBe(true);
  });
  it.each([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19])("锁区RGBA通道%d改变拒绝，半透明边缘也锁定", async channel => {
    const changed = Buffer.from(rgba); changed[channel]++; const candidate = await encode(changed);
    await expect(verifyLockedImagePixels(input(candidate), { clock })).rejects.toMatchObject({ code: "image_locked_pixels_changed" });
  });
  it.each([0, 255])("全蒙版alpha%d拒绝，不允许无锁区/无编辑区的真空通过", async alpha => {
    const mask = Buffer.alloc(24, 255); for (let p = 3; p < mask.length; p += 4) mask[p] = alpha;
    await expect(verifyLockedImagePixels(input(png, "png", png, await encode(mask)), { clock })).rejects.toMatchObject({ code: "image_locked_mask_vacuous" });
  });
  it("非透明灰色蒙版拒绝", async () => {
    const mask = Buffer.from(maskRgba); mask[8] = 100;
    await expect(verifyLockedImagePixels(input(png, "png", png, await encode(mask)), { clock })).rejects.toMatchObject({ code: "image_locked_mask_invalid" });
  });
  const mutations: Array<[string, (i: LockedImagePixelInput) => void, string]> = [
    ["跨租户", i => { i.mask.tenantId = "other"; }, "receipt_mismatch"],
    ["跨项目", i => { i.mask.asset.projectId = "other"; updateReceipt(i, "mask"); }, "receipt_mismatch"],
    ["蒙版来源编号", i => { i.mask.asset.sourceAssetId = "other"; updateReceipt(i, "mask"); }, "receipt_mismatch"],
    ["蒙版来源SHA", i => { i.mask.sourceChecksumSha256 = "0".repeat(64); }, "receipt_mismatch"],
    ["注册元信息SHA", i => { i.source.registeredMetadataSha256 = "0".repeat(64); }, "receipt_mismatch"],
    ["普通生成收据", i => { i.source.asset.purpose = "generated"; updateReceipt(i, "source"); }, "receipt_mismatch"],
    ["未绑定区域", i => { delete i.constraint.editableRegions[0].maskAssetId; updateConstraint(i); }, "mask_unbound"],
    ["另一蒙版", i => { i.constraint.editableRegions[0].maskAssetId = "other"; updateConstraint(i); }, "mask_unbound"],
    ["重复区域编号", i => { i.constraint.editableRegions.push({ ...i.constraint.editableRegions[0] }); updateConstraint(i); }, "mask_unbound"],
    ["约束SHA", i => { i.constraintChecksumSha256 = "0".repeat(64); }, "constraint_mismatch"],
    ["没有硬像素锁", i => { i.constraint.lockedPaths = []; updateConstraint(i); }, "constraint_mismatch"],
    ["候选格式", i => { i.candidate.mimeType = "image/jpeg"; }, "constraint_mismatch"],
    ["输出尺寸", i => { i.constraint.outputSpec.width = 2; updateConstraint(i); }, "dimensions_mismatch"],
    ["8193边长读前", i => { i.source.asset.width = i.mask.asset.width = i.constraint.outputSpec.width = 8193; updateReceipt(i,"source"); updateReceipt(i,"mask"); updateConstraint(i); }, "dimensions_mismatch"],
    ["4096平方读前", i => { i.source.asset.width = i.mask.asset.width = i.constraint.outputSpec.width = 4096; i.source.asset.height = i.mask.asset.height = i.constraint.outputSpec.height = 4096; updateReceipt(i,"source"); updateReceipt(i,"mask"); updateConstraint(i); }, "dimensions_mismatch"],
    ["原图声明30MiB读前", i => { i.source.asset.byteSize = 30 * 1024 * 1024 + 1; updateReceipt(i,"source"); }, "inputs_too_large"],
    ["候选字节SHA", i => { i.candidate.checksumSha256 = "0".repeat(64); }, "bytes_mismatch"],
    ["原图精确长度", i => { i.sourceBody = Buffer.concat([i.sourceBody, Buffer.from([0])]); }, "bytes_mismatch"],
  ];
  it.each(mutations)("%s不能由部分重算SHA绕过", async (_, mutate, code) => {
    const i = input(); mutate(i); const spy = vi.spyOn(decoder, "decodeStaticImagePixels");
    await expect(verifyLockedImagePixels(i, { clock })).rejects.toMatchObject({ code: `image_locked_${code}` }); expect(spy).not.toHaveBeenCalled();
  });
  it("声明尺寸与真实完整解码尺寸不同拒绝", async () => {
    const candidate = await encode(Buffer.alloc(4, 255), "png", 1, 1);
    await expect(verifyLockedImagePixels(input(candidate), { clock })).rejects.toMatchObject({ code: "image_locked_dimensions_mismatch" });
  });
  it("原完整解码拒绝截断/伪造正文，不只依赖SHA/魔数", async () => {
    const bad = png.subarray(0, 40);
    await expect(verifyLockedImagePixels(input(bad), { clock })).rejects.toMatchObject({ code: "verified_asset_decode_failed" });
  });
  it("20MiB候选/512KiB元信息读前拒绝，不先复制或解码", async () => {
    const spy = vi.spyOn(decoder, "decodeStaticImagePixels"), large = input(); large.candidate.body = Buffer.alloc(20 * 1024 * 1024 + 1);
    await expect(verifyLockedImagePixels(large, { clock })).rejects.toMatchObject({ code: "image_locked_bytes_mismatch" });
    const metadata = input(); metadata.constraint.brandRules.style = "x".repeat(512 * 1024);
    await expect(verifyLockedImagePixels(metadata, { clock })).rejects.toMatchObject({ code: "image_locked_metadata_too_large" }); expect(spy).not.toHaveBeenCalled();
  });
  it("动画PNG和错配魔数不能当静态候选", async () => {
    const apng = Buffer.concat([png.subarray(0,8), Buffer.from([0,0,0,0]), Buffer.from("acTL"), Buffer.alloc(4), png.subarray(8)]);
    await expect(verifyLockedImagePixels(input(apng), { clock })).rejects.toMatchObject({ code: "verified_asset_animated" });
    await expect(verifyLockedImagePixels(input(Buffer.from("not-a-png")), { clock })).rejects.toMatchObject({ code: "verified_asset_mime_mismatch" });
  });
  it("首await前复制原字节及完整约束，调用者修改不改本次冻结结论", async () => {
    const i = input(Buffer.from(png), "png", Buffer.from(png), Buffer.from(maskPng)), checksum = i.candidate.checksumSha256;
    const pending = verifyLockedImagePixels(i, { clock }); i.sourceBody.fill(0); i.maskBody.fill(0); i.candidate.body.fill(0); i.constraint.lockedPaths = []; i.mask.asset.sourceAssetId = "changed";
    expect((await pending).candidateChecksumSha256).toBe(checksum);
  });
  it("EXIF自动方向后比较规范像素，不按未旋转元信息匹配", async () => {
    const body = await sharp(rgba, { raw: { width: 2, height: 3, channels: 4 } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect((await verifyLockedImagePixels(input(body, "jpeg", body), { clock })).width).toBe(3);
  });
  it.each([NaN, Infinity, -1])("首无效时钟%s拒绝且不占槽", async value => {
    await expect(verifyLockedImagePixels(input(), { clock: () => value })).rejects.toMatchObject({ code: "image_locked_clock_invalid" });
    expect((await verifyLockedImagePixels(input(), { clock })).lockedPixelsEqual).toBe(true);
  });
  it.each([0, 30001, 1.5])("无效期限%s拒绝", async timeoutMs => {
    await expect(verifyLockedImagePixels(input(), { clock, timeoutMs })).rejects.toMatchObject({ code: "image_locked_timeout_invalid" });
  });
  it("已观察时钟倒退失败，正常毫秒推进通过", async () => {
    let now = clock(); expect((await verifyLockedImagePixels(input(), { clock: () => now++ })).lockedPixelsEqual).toBe(true);
    let count = 0; await expect(verifyLockedImagePixels(input(), { clock: () => clock() - count++ })).rejects.toMatchObject({ code: "image_locked_clock_invalid" });
  });
  it("完整解码后超实际期限拒绝并清零自有像素", async () => {
    const actual = decoder.decodeStaticImagePixels; let now = clock(); let pixels: Buffer | undefined;
    vi.spyOn(decoder, "decodeStaticImagePixels").mockImplementation(async (...args) => { const result = await actual(...args); pixels = result.pixels; now += 5000; return result; });
    await expect(verifyLockedImagePixels(input(), { clock: () => now })).rejects.toMatchObject({ code: "image_locked_expired" }); expect(pixels?.every(byte => byte === 0)).toBe(true);
  });
  it("非合作解码取消/绝对超时保留两槽，迟到清零且不可提交", async () => {
    const pendingDecodes: Array<(result: Awaited<ReturnType<typeof decoder.decodeStaticImagePixels>>) => void> = [];
    const copied: Buffer[] = [];
    vi.spyOn(decoder, "decodeStaticImagePixels").mockImplementation(body => { copied.push(body); return new Promise(resolve => pendingDecodes.push(resolve)); });
    const abort = new AbortController();
    const first = verifyLockedImagePixels(input(), { signal: abort.signal, clock });
    const cancelled = expect(first).rejects.toMatchObject({ code: "image_locked_cancelled" }); abort.abort(); await cancelled;
    const second = verifyLockedImagePixels(input(), { clock, timeoutMs: 10 }); await expect(second).rejects.toMatchObject({ code: "image_locked_expired" });
    await expect(verifyLockedImagePixels(input(), { clock })).rejects.toMatchObject({ code: "image_locked_busy", status: 429 });
    const late = pendingDecodes.map(resolve => { const pixels = Buffer.from(rgba); resolve({ width: 3, height: 2, hasAlpha: true, hasTransparency: true, pixels }); return pixels; });
    await new Promise(resolve => setImmediate(resolve)); expect([...copied, ...late].every(body => body.every(byte => byte === 0))).toBe(true);
    vi.restoreAllMocks(); expect((await verifyLockedImagePixels(input(), { clock })).lockedPixelsEqual).toBe(true);
  });
  it("共享实际解码两槽满时拒绝，无独立绕开槽或无限队列", async () => {
    const release: Array<() => void> = [];
    const held = [0,1].map(() => decoder.withStaticImageDecodeSlot(() => new Promise<void>(resolve => release.push(resolve))));
    try { await expect(verifyLockedImagePixels(input(), { clock })).rejects.toMatchObject({ code: "verified_asset_busy" }); }
    finally { release.forEach(done => done()); await Promise.all(held); }
    expect((await verifyLockedImagePixels(input(), { clock })).lockedPixelsEqual).toBe(true);
  });
  it("事先取消不读取正文或占槽", async () => {
    const abort = new AbortController(); abort.abort(); const spy = vi.spyOn(decoder, "decodeStaticImagePixels");
    await expect(verifyLockedImagePixels(input(), { clock, signal: abort.signal })).rejects.toMatchObject({ code: "image_locked_cancelled" }); expect(spy).not.toHaveBeenCalled();
  });
  it("草稿schema拒绝许可旗标/额外正文/不守恒像素", async () => {
    const draft = await verifyLockedImagePixels(input(), { clock });
    for (const extra of [{ artifactCommitted: true }, { executionAuthorized: true }, { realExecutionEnabled: true }, { settlementAuthorized: true }, { body: "secret" }, { lockedPixels: 6 }]) expect(LockedImagePixelDraftSchema.safeParse({ ...draft, ...extra }).success).toBe(false);
  });
  it("旧实际协议仍拒绝pixel-exact，不接本草稿或放宽真实闸门", () => {
    const connection = ImageProviderConnectionSchema.parse({ schemaVersion: 1, id: "owned-provider", tenantId: "owned-tenant", projectId: "owned-project", name: "自有声明，不发送",
      revision: 1, protocol: "openai", adapterId: "owned-adapter", baseUrl: "https://never-contacted.invalid", credentialRef: "never-read", enabled: true, diagnostic: { state: "not-run" },
      models: [{ model: "owned-model", version: "owned-capability", operations: ["generate"], inputMimeTypes: ["image/png"], outputFormats: ["png"], maxInputImages: 1,
        maxInputBytes: 1024, maxTotalInputBytes: 1024, maxPromptCharacters: 100, maxInputEdge: 8192, maxInputPixels: 16000000,
        sizes: { allowAuto: false, presets: [{ width: 3, height: 2 }] }, qualities: ["auto"], backgrounds: ["auto"], inputFidelities: [], supportsOutputCompression: false,
        mask: { mode: "none", polarity: "unsupported" }, evidence: { state: "declared" } }] });
    const request = ImageExecutionRequestSchema.parse({ schemaVersion: 1, tenantId: "owned-tenant", projectId: "owned-project", jobId: "owned-job", idempotencyKey: "owned-only",
      connectionId: connection.id, connectionRevision: 1, adapterId: connection.adapterId, model: "owned-model", capabilityVersion: "owned-capability",
      constraintSnapshotId: "owned-constraint", constraintChecksumSha256: "a".repeat(64), protection: "none", operation: "generate", inputs: [],
      parameters: { prompt: "自有合同", n: 1, size: { width: 3, height: 2 }, quality: "auto", background: "auto", outputFormat: "png" },
      quote: { id: "owned-quote", version: "owned-v1", source: "manual-budget", currency: "CNY", estimatedCostMinor: 10, maxCostMinor: 20, expiresAt: "2026-10-06T00:00:00Z" } });
    expect(validateImageProviderRequest(connection, request, at).request.protection).toBe("none");
    expect(() => validateImageProviderRequest(connection, { ...request, protection: "pixel-exact" }, at)).toThrow("image_pixel_protection_not_configured");
  });
});
