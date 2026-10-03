import { useEffect, useRef, useState } from "react";
import type { Asset, ConstraintSnapshot, ImageProviderPublic, ImagePreparationPublic, ImagePreparationRecovery } from "@canvas/contracts";
import { assetRepository } from "../assets/assetRepository";
import { StudioRunClient } from "../runs/runClient";
import { buildImageSelection, emptyImageDraft, readImageRecovery, recoveryKey, type ImagePreparationDraft } from "../runs/imagePreparationDraft";

type Props = { projectId: string; assets: Asset[]; constraints: ConstraintSnapshot[]; missingOriginalAssetIds: Set<string>; disabled: boolean };
const evidenceLabel = { declared: "仅声明，未验证真实请求", "local-fixture-passed": "本地假响应通过，不是实接", "live-request-accepted": "有实请求证据，真实执行仍关闭" };

export default function ImagePreparationPanel(props: Props) {
  const { projectId } = props;
  const [providers, setProviders] = useState<ImageProviderPublic[]>([]);
  const [draft, setDraft] = useState(emptyImageDraft);
  const [record, setRecord] = useState<ImagePreparationPublic | null>(null);
  const [recovery, setRecovery] = useState<ImagePreparationRecovery | null>(null);
  const [historyId, setHistoryId] = useState("");
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [changed, setChanged] = useState(false);
  const [now, setNow] = useState(Date.now());
  const client = useRef<StudioRunClient | null>(null);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const context = useRef(props); context.current = props;
  const state = useRef({ providers, draft }); state.current = { providers, draft };
  const connection = providers.find((item) => item.id === draft.connectionId);
  const model = connection?.models.find((item) => item.model === draft.model);
  const constraint = props.constraints.find((item) => item.id === draft.constraintId);
  const active = () => controller.current !== null && !controller.current.signal.aborted;
  const current = (api: StudioRunClient) => client.current === api && active();
  const patch = (fields: Partial<ImagePreparationDraft>) => { setDraft((value) => ({ ...value, ...fields })); setChanged(true); };
  const perform = async (action: (api: StudioRunClient) => Promise<void>) => {
    if (pending.current || !client.current || props.disabled) return;
    const api = client.current;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(api); }
    catch (failure) { if (current(api)) setError(failure instanceof Error ? failure.message : "本地准备失败，未启动任务。"); }
    finally { if (current(api)) { pending.current = false; setBusy(false); } }
  };
  const readDirectory = async (api: StudioRunClient) => {
    const next = await api.imageProviders(projectId); if (!current(api)) return;
    const selected = state.current.providers.find((item) => item.id === state.current.draft.connectionId);
    if (selected && JSON.stringify(selected) !== JSON.stringify(next.find((item) => item.id === selected.id))) {
      setDraft(emptyImageDraft()); setChanged(true); setNotice("目录修订或能力变化，请明确重新选择；旧准备单仅保留为历史。");
    }
    setProviders(next); setLoaded(true);
  };
  const displayRecord = (value: ImagePreparationPublic, historical: boolean, api: StudioRunClient) => {
    if (!current(api)) return;
    setRecord(value); setHistoryId(value.id); setChanged(historical);
    setNotice(historical ? "恢复的是原准备历史，不重新报价、不确认或执行。" : "未确认准备单已保存，没有创建任务或预留预算。");
  };
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    const api = new StudioRunClient(abort.signal); client.current = api; pending.current = true;
    void (async () => {
      await readDirectory(api);
      if (!current(api)) return;
      const previous = readImageRecovery(localStorage.getItem(recoveryKey(projectId)), projectId);
      setRecovery(previous); setRecoveryChecked(true);
      if (previous?.preparationId) displayRecord(await api.imagePreparation(projectId, previous.preparationId), true, api);
      else if (previous) setNotice("上次准备响应未确认。请人工恢复原动作；不会自动重发或重新报价。");
    })().catch((failure) => { if (current(api)) setError(failure instanceof Error ? failure.message : "目录或历史恢复失败。"); })
      .finally(() => { if (current(api)) { pending.current = false; setBusy(false); } });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { abort.abort(); controller.current = null; client.current = null; window.clearInterval(timer); };
    // Parent is keyed by project; closing/switching cancels all operations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const savePointer = (value: ImagePreparationRecovery) => {
    localStorage.setItem(recoveryKey(projectId), JSON.stringify(value)); setRecovery(value);
  };
  const submit = (recover = false) => perform(async (api) => {
    const latest = context.current;
    if (!recoveryChecked) throw new Error("恢复指针尚未核验；请先处理恢复记录，或明确开始新动作。");
    if (!recover && recovery) throw new Error("请先恢复原动作，或明确点击开始新准备动作；不会覆盖未核对的选择。");
    const selection = recover ? recovery?.selection : buildImageSelection(projectId, `prepare-${crypto.randomUUID()}`, draft,
      providers, latest.constraints, latest.assets, latest.missingOriginalAssetIds);
    if (!selection) throw new Error("没有可以恢复的原动作。");
    if (!recover) {
      // Persist before ANY POST. Storage failure prevents an untracked action.
      savePointer({ schemaVersion: 1, selection });
      await api.register({ projectId, assets: latest.assets, constraints: latest.constraints });
      const ids = selection.operation === "edit" ? [...selection.inputAssetIds, ...(selection.maskAssetId ? [selection.maskAssetId] : [])] : [];
      for (const id of ids) {
        const asset = latest.assets.find((item) => item.id === id);
        const original = await assetRepository.getBlob(id, "original");
        if (!asset || !original) throw new Error("编辑原文件已丢失，不会用代理缩略图代替。");
        if (!current(api)) return;
        setNotice(`正在本机核验原文件 ${asset.originalName}（无供应商上传）…`);
        await api.verifyImage(projectId, id, original, asset.mimeType);
      }
    }
    if (!current(api)) return;
    const prepared = await api.prepareImage(selection); if (!current(api)) return;
    displayRecord(prepared, recover, api);
    // On pointer-save failure, the returned immutable ID remains visible.
    savePointer({ schemaVersion: 1, selection, preparationId: prepared.id });
  });
  let validation = "";
  try { buildImageSelection(projectId, "preview-not-a-submission", draft, providers, props.constraints, props.assets, props.missingOriginalAssetIds); }
  catch (failure) { validation = failure instanceof Error ? failure.message : "请完成选择。"; }
  const expired = record && Date.parse(record.pricing.quote.expiresAt) <= now;
  const drifted = record && loaded && JSON.stringify(providers.find((item) => item.id === record.connection.id)) !== JSON.stringify(record.connection);
  const frozen = record?.requestTemplate;
  return <section className="image-preparation" aria-label="图片供应商准备">
    <h3>图片供应商 · 本地准备</h3>
    <p className="run-hint">先明确选择，再保存假报价。声明能力和目录读取不等于图片实接；本区不创建任务、不预留预算、不执行生成。</p>
    {error && <p className="run-error" role="alert">{error}</p>}
    {notice && <p className="run-hint" role="status">{notice}</p>}
    <button disabled={busy || props.disabled} onClick={() => void perform(readDirectory)}>刷新供应商目录</button>
    {loaded && providers.length === 0 && <p className="run-hint">当前项目供应商目录为空。请后续由受控服务端配置；不会自动添加模型、价格或诊断。旧模拟商品精修与此区独立。</p>}
    <fieldset disabled={busy || props.disabled || !loaded || !providers.length}>
      <legend>明确选择（每个任务一张图）</legend>
      <label>供应商<select aria-label="图片供应商" value={draft.connectionId} onChange={(event) => {
        setDraft({ ...emptyImageDraft(), connectionId: event.target.value }); setChanged(true);
      }}><option value="">请选择，不自动选定</option>{providers.map((item) => <option key={item.id} value={item.id} disabled={!item.enabled || item.protocol === "custom"}>
        {item.name} · {item.protocol} · 修订 {item.revision}{!item.enabled ? " · 已停用" : item.protocol === "custom" ? " · 未实现" : ""}</option>)}</select></label>
      <label>模型<select aria-label="图片模型" value={draft.model} onChange={(event) => patch({ model: event.target.value, operation: "", quality: "", background: "", inputFidelity: "", outputCompression: "", extraValues: {}, inputAssetIds: [], maskAssetId: "" })}>
        <option value="">请选择显式模型</option>{connection?.models.map((item) => <option key={item.model} value={item.model}>{item.model} · {item.capabilityVersion}</option>)}</select></label>
      {model && <p className="run-hint">能力证据：{evidenceLabel[model.evidence.state]}。格式：{model.outputFormats.join(" / ")}；最多 {model.maxInputImages} 张编辑原图。蒙版：{model.mask.mode} / {model.mask.polarity}，仅提示引导、不承诺像素锁。连接诊断：{connection?.diagnostic.state}。</p>}
      <label>操作<select aria-label="图片操作" value={draft.operation} onChange={(event) => patch({ operation: event.target.value as ImagePreparationDraft["operation"], inputAssetIds: [], maskAssetId: "", inputFidelity: "", extraValues: {} })}>
        <option value="">请选择生成或编辑</option>{model?.operations.map((item) => <option key={item} value={item}>{item === "generate" ? "图片生成（无输入）" : "图片编辑（读取原图）"}</option>)}</select></label>
      <label>人工约束<select aria-label="图片准备约束" value={draft.constraintId} onChange={(event) => patch({ constraintId: event.target.value })}>
        <option value="">请选择已保存快照</option>{props.constraints.map((item, index) => <option key={item.id} value={item.id}>版本 {index + 1} · {item.outputSpec.width}×{item.outputSpec.height} {item.outputSpec.format}{item.lockedPaths.includes("product.pixels") ? " · 要求商品像素锁（不可准备）" : ""}</option>)}</select></label>
      {constraint && <p className="run-hint">输出严格来自人工约束：{constraint.outputSpec.width}×{constraint.outputSpec.height} {constraint.outputSpec.format}。锁定：{constraint.lockedPaths.join("、") || "无硬像素锁"}；可编辑：{constraint.editableRegions.map((region) => region.description).join("、")}。不在此区修改约束。</p>}
      <label>设计指令<textarea aria-label="图片设计指令" rows={3} maxLength={model?.maxPromptCharacters ?? 32000} value={draft.prompt} onChange={(event) => patch({ prompt: event.target.value })} /></label>
      <div className="run-fields"><label>质量<select aria-label="图片质量" value={draft.quality} onChange={(event) => patch({ quality: event.target.value })}><option value="">请选择</option>{model?.qualities.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>背景<select aria-label="图片背景" value={draft.background} onChange={(event) => patch({ background: event.target.value })}><option value="">请选择</option>{model?.backgrounds.map((item) => <option key={item}>{item}</option>)}</select></label></div>
      <label>尺寸方式<select aria-label="图片尺寸方式" value={draft.sizeMode} onChange={(event) => patch({ sizeMode: event.target.value as ImagePreparationDraft["sizeMode"] })}>
        <option value="constraint">按约束精确尺寸</option>{model?.sizes.allowAuto && <option value="auto">供应商自动尺寸（产物仍需符合约束）</option>}</select></label>
      {draft.operation === "edit" && <><fieldset><legend>编辑原图（选择顺序即输入顺序，第一张为蒙版底图）</legend>
        {props.assets.filter((asset) => asset.kind === "image" && asset.purpose !== "mask").map((asset) => <label className="image-input-choice" key={asset.id}><input type="checkbox" aria-label={`编辑输入 ${asset.originalName}`} disabled={props.missingOriginalAssetIds.has(asset.id)} checked={draft.inputAssetIds.includes(asset.id)} onChange={(event) => patch({ inputAssetIds: event.target.checked ? [...draft.inputAssetIds, asset.id] : draft.inputAssetIds.filter((id) => id !== asset.id) })} />{asset.originalName}{draft.inputAssetIds.includes(asset.id) ? ` · 第 ${draft.inputAssetIds.indexOf(asset.id) + 1} 张` : ""}</label>)}</fieldset>
        <label>蒙版<select aria-label="图片编辑蒙版" value={draft.maskAssetId} onChange={(event) => patch({ maskAssetId: event.target.value })}><option value="">不携带蒙版</option>{props.assets.filter((asset) => asset.purpose === "mask" && !props.missingOriginalAssetIds.has(asset.id)).map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName}</option>)}</select></label>
        {Boolean(model?.inputFidelities.length) && <label>输入保真度<select aria-label="图片输入保真度" value={draft.inputFidelity} onChange={(event) => patch({ inputFidelity: event.target.value })}><option value="">不发送可选参数</option>{model?.inputFidelities.map((item) => <option key={item}>{item}</option>)}</select></label>}</>}
      {model?.supportsOutputCompression && constraint?.outputSpec.format !== "png" && <label>输出压缩（可选 0–100）<input aria-label="图片输出压缩" value={draft.outputCompression} inputMode="numeric" onChange={(event) => patch({ outputCompression: event.target.value })} /></label>}
      {connection?.extraParameters.filter((rule) => draft.operation && rule.operations.includes(draft.operation)).map((rule) => <label key={rule.name}>受控参数 {rule.name}
        {rule.type === "integer" ? <input aria-label={`图片参数 ${rule.name}`} inputMode="numeric" placeholder={`${rule.minimum}–${rule.maximum}，可留空`} value={draft.extraValues[rule.name] ?? ""} onChange={(event) => patch({ extraValues: { ...draft.extraValues, [rule.name]: event.target.value } })} />
          : <select aria-label={`图片参数 ${rule.name}`} value={draft.extraValues[rule.name] ?? ""} onChange={(event) => patch({ extraValues: { ...draft.extraValues, [rule.name]: event.target.value } })}><option value="">不发送</option>{(rule.type === "enum" ? rule.values : ["true", "false"]).map((value) => <option key={value}>{value}</option>)}</select>}</label>)}
      {validation && <small>{validation}</small>}
      <button className="run-primary" disabled={Boolean(validation) || Boolean(recovery) || !recoveryChecked} onClick={() => void submit()}>保存未确认假报价准备单</button>
    </fieldset>
    {recovery && <p className="run-hint">原动作：{recovery.selection.idempotencyKey} · {recovery.selection.model} · 修订 {recovery.selection.connectionRevision}。恢复严格沿用这组选项，不采用当前表单。</p>}
    {recovery && !recovery.preparationId && <button disabled={busy || props.disabled} onClick={() => void submit(true)}>人工恢复原准备动作</button>}
    <div className="run-fields"><label>历史准备单编号<input aria-label="历史图片准备单编号" maxLength={160} value={historyId} onChange={(event) => setHistoryId(event.target.value)} /></label>
      <button disabled={busy || props.disabled || !historyId.trim()} onClick={() => void perform(async (api) => displayRecord(await api.imagePreparation(projectId, historyId.trim()), true, api))}>读取历史准备单</button></div>
    {(recovery || record || error) && <button disabled={busy || props.disabled} onClick={() => {
      try { localStorage.removeItem(recoveryKey(projectId)); setRecovery(null); setRecoveryChecked(true); setRecord(null); setChanged(true); setError(""); setNotice("仅清除本项目浏览器恢复指针；服务端历史保留。下一次保存使用新动作编号和新假报价。"); }
      catch { setError("恢复指针未能清除，未开始新动作。"); }
    }}>开始新准备动作（保留服务端历史）</button>}
    {record && frozen && <article className="image-preparation-summary" aria-label="未确认图片准备单">
      <strong>未确认 · 未授权执行 · 协议未准备</strong><small>准备单：{record.id} · {record.createdAt}</small>
      {(expired || drifted || changed) && <p className="run-hint">{expired ? "假报价已过期。" : ""}{drifted ? "当前目录与冻结版本不同。" : ""}{changed ? "此处是原冻结记录，当前表单不代表它。" : ""}历史不会自动重报价，后续确认需重新核对。</p>}
      <p className="run-hint">{record.connection.name} · {record.connection.protocol} · 修订 {record.connection.revision} · {frozen.model} · {frozen.capabilityVersion}<br />
        {frozen.operation === "generate" ? "生成" : "编辑"} · 输入：{frozen.inputs.map((input) => input.assetId).join("、") || "无"} · 蒙版：{frozen.operation === "edit" ? frozen.mask?.assetId ?? "无" : "无"}<br />
        约束：{frozen.constraintSnapshotId} · {frozen.parameters.size === "auto" ? "auto" : `${frozen.parameters.size.width}×${frozen.parameters.size.height}`} · {frozen.parameters.outputFormat} · {frozen.parameters.quality} · {frozen.parameters.background}<br />
        假报价（不是实费）：{record.pricing.quote.currency}，估算 {record.pricing.quote.estimatedCostMinor} 最小币种单位，上限 {record.pricing.quote.maxCostMinor} 最小币种单位；有效至 {record.pricing.quote.expiresAt}。未预留。</p>
      <details><summary>完整冻结参数与摘要</summary><pre>{JSON.stringify({ requestTemplate: frozen, pricing: record.pricing, snapshotFingerprint: record.snapshotFingerprint }, null, 2)}</pre></details>
      <small>确认入口将在下一步接入。本区没有生成、自动重试或成本结算按钮。</small>
    </article>}
  </section>;
}
