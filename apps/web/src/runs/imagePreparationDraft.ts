import { CreateImagePreparationSchema, ImagePreparationRecoverySchema,
  type Asset, type ConstraintSnapshot, type CreateImagePreparation, type ImageProviderPublic, type ImagePreparationRecovery } from "@canvas/contracts";

export type ImagePreparationDraft = {
  connectionId: string; model: string; operation: "" | "generate" | "edit"; constraintId: string;
  prompt: string; quality: string; background: string; sizeMode: "constraint" | "auto";
  inputFidelity: string; outputCompression: string; inputAssetIds: string[]; maskAssetId: string;
  extraValues: Record<string, string>;
};
export const emptyImageDraft = (): ImagePreparationDraft => ({ connectionId: "", model: "", operation: "", constraintId: "",
  prompt: "", quality: "", background: "", sizeMode: "constraint", inputFidelity: "", outputCompression: "",
  inputAssetIds: [], maskAssetId: "", extraValues: {} });
function fail(message: string): never { throw new Error(message); }
const integer = (value: string): number => {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail("参数需要安全范围内的整数。");
  return Number(value);
};

// An early usability check, NOT server receipts, authority or live capability proof.
export function buildImageSelection(projectId: string, actionId: string, draft: ImagePreparationDraft,
  providers: ImageProviderPublic[], constraints: ConstraintSnapshot[], assets: Asset[], missing: Set<string>): CreateImagePreparation {
  const connection = providers.find((item) => item.id === draft.connectionId);
  if (!connection || !connection.enabled) fail("请明确选择启用的供应商，不会自动添加或切换连接。");
  if (connection.protocol === "custom") fail("自定义协议尚无适配器，不接受准备。");
  const model = connection.models.find((item) => item.model === draft.model);
  if (!model || !draft.operation || !model.operations.includes(draft.operation)) fail("请明确选择模型和其声明支持的生成或编辑操作。");
  const constraint = constraints.find((item) => item.id === draft.constraintId && item.projectId === projectId);
  if (!constraint) fail("请明确选择当前项目的人工约束快照。");
  if (constraint.lockedPaths.includes("product.pixels")) fail("此约束要求商品像素锁，原生图片尚不能兑现；不会移除锁定或降级。");
  const { width, height, format } = constraint.outputSpec;
  if (Math.max(width, height) > 8192 || width * height > 16_000_000) fail("输出超过 1600 万像素或单边 8192 限制，未估价；4096×4096 也超限。");
  if (format === "mp4" || !model.outputFormats.includes(format)) fail("模型未声明支持约束的输出格式，请选择匹配的模型或人工创建新约束。");
  if (!draft.prompt.trim() || draft.prompt.trim().length > model.maxPromptCharacters) fail("请填写不超过模型声明长度的设计指令。");
  if (!model.qualities.includes(draft.quality) || !model.backgrounds.includes(draft.background as "auto")) fail("请明确选择声明支持的质量和背景参数。");
  const custom = model.sizes.custom;
  const exactAllowed = model.sizes.presets.some((size) => size.width === width && size.height === height)
    || Boolean(custom && Math.min(width, height) >= custom.minEdge && Math.max(width, height) <= custom.maxEdge
      && width % custom.multipleOf === 0 && height % custom.multipleOf === 0 && width * height >= custom.minPixels
      && width * height <= custom.maxPixels && Math.max(width / height, height / width) <= custom.maxAspectRatio);
  if (draft.sizeMode === "auto" ? !model.sizes.allowAuto : !exactAllowed) fail("模型未声明支持所选尺寸方式，不会改尺寸或缩图。");
  if (draft.inputFidelity && (draft.operation !== "edit" || !model.inputFidelities.includes(draft.inputFidelity as "low"))) fail("此操作不接受所选输入保真度。");
  if (draft.outputCompression && (!model.supportsOutputCompression || format === "png")) fail("模型或 PNG 输出不接受有损压缩参数。");
  const masks = [...new Set(constraint.editableRegions.flatMap((region) => region.maskAssetId ? [region.maskAssetId] : []))];
  if (masks.length > 1 || (masks.length && (draft.operation !== "edit" || draft.maskAssetId !== masks[0]))
    || (draft.maskAssetId && !masks.includes(draft.maskAssetId))) fail("蒙版必须与所选人工约束一致，不能静默忽略或替换。");
  if (draft.operation === "generate" && (draft.inputAssetIds.length || draft.maskAssetId)) fail("生成操作不能携带编辑输入或蒙版。");
  if (draft.operation === "edit") {
    if (!draft.inputAssetIds.length || draft.inputAssetIds.length > model.maxInputImages || new Set(draft.inputAssetIds).size !== draft.inputAssetIds.length) fail("请按模型数量限制明确选择编辑原图。");
    const inputs = draft.inputAssetIds.map((id) => assets.find((item) => item.id === id && item.projectId === projectId));
    const mask = draft.maskAssetId ? assets.find((item) => item.id === draft.maskAssetId && item.projectId === projectId) : undefined;
    if (draft.maskAssetId && (model.mask.mode === "none" || model.mask.polarity === "unverified" || !mask || mask.purpose !== "mask"
      || mask.mimeType !== "image/png" || mask.sourceAssetId !== draft.inputAssetIds[0] || mask.width !== inputs[0]?.width || mask.height !== inputs[0]?.height)) fail("蒙版能力、极性、尺寸或首张底图关联未核对，不能准备。");
    for (const input of [...inputs, ...(mask ? [mask] : [])]) {
      if (!input || input.kind !== "image" || missing.has(input.id) || (input !== mask && (input.purpose === "mask" || !model.inputMimeTypes.includes(input.mimeType as "image/png")))) fail("原文件缺失、格式不支持或输入不是当前项目图片。");
      if (!input.width || !input.height || input.byteSize > Math.min(model.maxInputBytes, 30 * 1024 * 1024)
        || Math.max(input.width, input.height) > model.maxInputEdge || input.width * input.height > model.maxInputPixels) fail("输入超过声明的大小或像素限制，未上传原文件。");
    }
    if ([...inputs, ...(mask ? [mask] : [])].reduce((total, input) => total + input!.byteSize, 0) > model.maxTotalInputBytes) fail("输入总容量超过模型声明限制。");
  }
  const extra: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(draft.extraValues)) {
    if (value === "") continue;
    const rule = connection.extraParameters.find((item) => item.name === name);
    if (connection.protocol !== "openai-compatible" || !rule || !rule.operations.includes(draft.operation)) fail("额外参数未被该操作明确允许。");
    if (rule.type === "integer") {
      const number = integer(value); if (number < rule.minimum || number > rule.maximum) fail("额外整数参数超过允许范围。"); extra[name] = number;
    } else if (rule.type === "boolean") {
      if (value !== "true" && value !== "false") fail("额外布尔参数无效。"); extra[name] = value === "true";
    } else { if (!rule.values.includes(value)) fail("额外参数不在允许枚举中。"); extra[name] = value; }
  }
  const checked = CreateImagePreparationSchema.safeParse({ projectId, idempotencyKey: actionId, connectionId: connection.id,
    connectionRevision: connection.revision, model: model.model, capabilityVersion: model.capabilityVersion,
    constraintSnapshotId: constraint.id, protection: "none", operation: draft.operation, inputAssetIds: draft.inputAssetIds,
    ...(draft.operation === "edit" && draft.maskAssetId ? { maskAssetId: draft.maskAssetId } : {}),
    parameters: { prompt: draft.prompt, n: 1, size: draft.sizeMode === "auto" ? "auto" : { width, height }, quality: draft.quality,
      outputFormat: format, background: draft.background, ...(draft.inputFidelity ? { inputFidelity: draft.inputFidelity } : {}),
      ...(draft.outputCompression ? { outputCompression: integer(draft.outputCompression) } : {}) },
    ...(Object.keys(extra).length ? { providerParameters: extra } : {}) });
  if (!checked.success) fail("图片参数不符合合同；透明 JPEG、非法压缩或编号均不接受。");
  return checked.data;
}

export const recoveryKey = (projectId: string) => `ai-commerce-canvas.image-preparation.${projectId}`;
export function readImageRecovery(raw: string | null, projectId: string): ImagePreparationRecovery | null {
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).length > 128 * 1024) fail("准备恢复记录过大，未重新提交。");
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { fail("准备恢复记录损坏，未重新提交。"); }
  const checked = ImagePreparationRecoverySchema.safeParse(parsed);
  if (!checked.success || checked.data.selection.projectId !== projectId) fail("准备恢复记录损坏或属于其他项目，未重新提交。");
  return checked.data;
}
