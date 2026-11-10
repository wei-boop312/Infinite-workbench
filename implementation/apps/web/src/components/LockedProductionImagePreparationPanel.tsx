import { useEffect, useRef, useState } from "react";
import { LockedProductionImageUiScopeSchema, type Asset, type ConstraintSnapshot, type ImageProviderPublic, type LockedProductionImagePreparationPublic, type LockedProductionImageRecovery, type LockedProductionImageUiScope } from "@canvas/contracts";
import { LockedProductionImageClient } from "../runs/lockedProductionImageClient";
import { lockedProductionRecoveryKey, readLockedProductionRecovery, saveLockedProductionRecovery } from "../runs/lockedProductionImageRecovery";
import { emptyImageDraft, type ImagePreparationDraft } from "../runs/imagePreparationDraft";
import { buildLockedImageSelection } from "../runs/lockedImagePreparationDraft";
import { assetRepository } from "../assets/assetRepository";
import LockedProductionImageConfirmationReview from "./LockedProductionImageConfirmationReview";

type Props = { scope: LockedProductionImageUiScope; projectId: string; assets: Asset[]; constraints: ConstraintSnapshot[]; missingOriginalAssetIds: Set<string>; disabled: boolean };
export default function LockedProductionImagePreparationPanel(props: Props) {
  const scope = LockedProductionImageUiScopeSchema.parse(props.scope), { projectId } = props;
  const [providers, setProviders] = useState<ImageProviderPublic[]>([]), [draft, setDraft] = useState(emptyImageDraft);
  const [record, setRecord] = useState<LockedProductionImagePreparationPublic | null>(null), [pointer, setPointer] = useState<LockedProductionImageRecovery | null>(null);
  const [busy, setBusy] = useState(true), [pointerChecked, setPointerChecked] = useState(false), [directoryChecked, setDirectoryChecked] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [historyId, setHistoryId] = useState(""), [edited, setEdited] = useState(false), [now, setNow] = useState(Date.now());
  const client = useRef<LockedProductionImageClient | null>(null), controller = useRef<AbortController | null>(null), pending = useRef(false), latest = useRef(props); latest.current = props;
  const current = (api: LockedProductionImageClient) => client.current === api && !controller.current?.signal.aborted && latest.current.projectId === projectId && latest.current.scope.tenantId === scope.tenantId && latest.current.scope.mode === scope.mode;
  const display = (p: LockedProductionImagePreparationPublic, api: LockedProductionImageClient) => { if (current(api)) { setRecord(p); setHistoryId(p.id); setEdited(false); } };
  const save = (p: LockedProductionImageRecovery) => { saveLockedProductionRecovery(localStorage, scope, p); setPointer(p); };
  const directory = async (api: LockedProductionImageClient) => { const list = await api.providers(projectId); if (current(api)) { setProviders(list); setDirectoryChecked(true); } };
  const run = async (action: (api: LockedProductionImageClient) => Promise<void>) => {
    const api = client.current; if (!api || pending.current || props.disabled) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(api); } catch (e) { if (current(api)) setError(e instanceof Error ? e.message : "保护准备失败。"); }
    finally { if (current(api)) { pending.current = false; setBusy(false); } }
  };
  useEffect(() => {
    const abort = new AbortController(), api = new LockedProductionImageClient(scope, abort.signal); client.current = api; controller.current = abort; pending.current = true;
    void (async () => {
      const previous = readLockedProductionRecovery(localStorage.getItem(lockedProductionRecoveryKey(scope, projectId)), scope, projectId);
      if (!current(api)) return; setPointer(previous); setPointerChecked(true);
      if (previous?.preparationId) {
        const p = await api.preparation(projectId, previous.preparationId); if (!current(api)) return;
        if (p.snapshotFingerprint !== previous.preparationFingerprint || p.pricingFingerprint !== previous.pricingFingerprint || p.protectionPolicyFingerprint !== previous.protectionPolicyFingerprint) throw new Error("生产恢复指针与完整原摘要不一致。");
        display(p, api); setNotice("只读原准备及确认历史；不重新报价、确认或预留。");
      } else if (previous) setNotice("原准备响应不明，仅可按原编号只读核对；不会自动重发准备动作。");
    })().catch(e => { if (current(api)) setError(e instanceof Error ? e.message : "生产历史恢复失败。"); })
      .finally(async () => {
        try { await directory(api); } catch (e) { if (current(api)) setError(e instanceof Error ? e.message : "目录读取失败；历史保留。"); }
        if (current(api)) { pending.current = false; setBusy(false); }
      });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { abort.abort(); client.current = null; controller.current = null; window.clearInterval(timer); };
    // Trusted host keys tenant/mode/project; cleanup isolates close, switch and StrictMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, scope.tenantId, scope.mode]);
  const patch = (changes: Partial<ImagePreparationDraft>) => { setDraft(d => ({ ...d, ...changes })); setEdited(true); };
  const connection = providers.find(p => p.id === draft.connectionId), model = connection?.models.find(m => m.model === draft.model), constraint = props.constraints.find(c => c.id === draft.constraintId && c.projectId === projectId);
  let validation = "";
  try { buildLockedImageSelection(projectId, "production-preview-not-authority", draft, providers, props.constraints, props.assets, props.missingOriginalAssetIds); if (draft.sizeMode !== "constraint") throw new Error("生产只接显式原约束尺寸。"); }
  catch (e) { validation = e instanceof Error ? e.message : "请完整选择。"; }
  const submit = () => run(async api => {
    if (!pointerChecked || pointer || localStorage.getItem(lockedProductionRecoveryKey(scope, projectId)) !== null) throw new Error("请核对原指针或明确开始新动作；不覆盖未知动作。");
    const live = structuredClone({ ...latest.current, missingOriginalAssetIds: latest.current.missingOriginalAssetIds }), selection = buildLockedImageSelection(projectId, `production-prepare-${crypto.randomUUID()}`, draft, providers, live.constraints, live.assets, live.missingOriginalAssetIds);
    if (selection.parameters.size === "auto") throw new Error("生产只接显式原约束尺寸。");
    const initial: LockedProductionImageRecovery = { schemaVersion: 2, tenantId: scope.tenantId, projectId, mode: scope.mode, actionId: selection.idempotencyKey, stage: "preparing" };
    // Persist before context, original-file verification AND preparation POSTs.
    save(initial);
    const beforePost = () => {
      if (!current(api) || JSON.stringify(readLockedProductionRecovery(localStorage.getItem(lockedProductionRecoveryKey(scope, projectId)), scope, projectId)) !== JSON.stringify(initial)) throw new Error("保护指针丢失或范围漂移，仅只读核对，不补发。");
      const fresh = buildLockedImageSelection(projectId, selection.idempotencyKey, draft, providers, latest.current.constraints, latest.current.assets, latest.current.missingOriginalAssetIds);
      if (JSON.stringify(fresh) !== JSON.stringify(selection) || JSON.stringify(latest.current.constraints) !== JSON.stringify(live.constraints)
        || JSON.stringify(latest.current.assets) !== JSON.stringify(live.assets)) throw new Error("当前输入或完整约束漂移，不继续提交。");
      saveLockedProductionRecovery(localStorage, scope, initial);
    };
    beforePost(); await api.register({ projectId, assets: live.assets.filter(a => a.projectId === projectId), constraints: live.constraints.filter(c => c.projectId === projectId) }, beforePost);
    if (!current(api)) return;
    for (const id of selection.operation === "edit" ? [...selection.inputAssetIds, ...(selection.maskAssetId ? [selection.maskAssetId] : [])] : []) {
      const asset = live.assets.find(a => a.id === id && a.projectId === projectId), original = await assetRepository.getBlob(id, "original");
      if (!asset || !original) throw new Error("实际原图或蒙版缺失；不采用代理。");
      if (!current(api)) return; beforePost(); await api.verifyImage(projectId, id, original, asset.mimeType, beforePost); if (!current(api)) return;
    }
    beforePost(); const prepared = await api.prepare(selection, beforePost); if (!current(api)) return;
    display(prepared, api);
    save({ ...initial, stage: "prepared", preparationId: prepared.id, preparationFingerprint: prepared.snapshotFingerprint, pricingFingerprint: prepared.pricingFingerprint, protectionPolicyFingerprint: prepared.protectionPolicyFingerprint });
    setNotice("原准备单永久未确认；独立任务状态以下方只读确认结果为准，不自动重发或重复预留。");
  });
  const inputDrift = Boolean(record && (JSON.stringify(props.constraints.find(c => c.id === record.constraint.id && c.projectId === projectId)) !== JSON.stringify(record.constraint)
    || [...record.requestDraft.inputs, record.requestDraft.mask!].some(r => { const a = props.assets.find(a => a.id === r.assetId && a.projectId === projectId);
      return !a || props.missingOriginalAssetIds.has(r.assetId) || a.mimeType !== r.mimeType || a.width !== r.width || a.height !== r.height || a.byteSize !== r.byteSize || a.contentFingerprint !== `sha256:${r.checksumSha256}`
        || (r.assetId === record.protectionPolicy.mask.assetId && a.sourceAssetId !== record.protectionPolicy.source.assetId); })));
  const expired = Boolean(record && Date.parse(record.pricing.quote.expiresAt) <= now), drift = Boolean(record && directoryChecked && JSON.stringify(providers.find(p => p.id === record.connection.id)) !== JSON.stringify(record.connection));
  return <section className="image-preparation" aria-label="保护生产图片准备">
    <h3>保护生产图片 · 独立准备与人工确认</h3><p className="run-hint">默认关闭，仅可信主程序显式配置后显示。目录能力/价格标签不证明实接；本区不生成。{scope.mode === "production-contract-fixture" && " 当前仅自有零费用合同夹具。"}</p>
    {error && <p className="run-error" role="alert">{error}</p>}{notice && <p className="run-hint" role="status">{notice}</p>}
    <button disabled={busy || props.disabled} onClick={() => void run(directory)}>刷新保护供应商目录</button>
    {directoryChecked && !providers.length && <p className="run-hint">目录为空，不自动添加或选择供应商、模型或价格。</p>}
    <fieldset disabled={busy || props.disabled || !directoryChecked || !providers.length}>
      <legend>明确保护选择（不自动选模型）</legend>
      <label>供应商<select aria-label="保护生产图片供应商" value={draft.connectionId} onChange={e => { setDraft({ ...emptyImageDraft(), connectionId: e.target.value }); setEdited(true); }}><option value="">请选择</option>{providers.map(p => <option key={p.id} value={p.id} disabled={!p.enabled || !["openai", "openai-compatible"].includes(p.protocol)}>{p.name} · {p.protocol} · 修订 {p.revision}</option>)}</select></label>
      <label>模型<select aria-label="保护生产图片模型" value={draft.model} onChange={e => patch({ model: e.target.value, operation: "", quality: "", background: "", inputFidelity: "", outputCompression: "", inputAssetIds: [], maskAssetId: "", extraValues: {} })}><option value="">请选择</option>{connection?.models.map(m => <option key={m.model}>{m.model}</option>)}</select></label>
      {model && <p className="run-hint">能力证据 {model.evidence.state}（不代表本次请求获授权）；格式 {model.outputFormats.join(" / ")}；最多 {model.maxInputImages} 原图；蒙版 {model.mask.mode} / {model.mask.polarity}；诊断 {connection?.diagnostic.state}。</p>}
      <label>操作<select aria-label="保护生产图片操作" value={draft.operation} onChange={e => patch({ operation: e.target.value as ImagePreparationDraft["operation"], inputAssetIds: [], maskAssetId: "", inputFidelity: "", extraValues: {} })}><option value="">请选择</option>{model?.operations.filter(o => o === "edit").map(o => <option key={o} value={o}>{"编辑准备（实际原图 / 绑定蒙版）"}</option>)}</select></label>
      <label>人工约束<select aria-label="保护生产图片约束" value={draft.constraintId} onChange={e => patch({ constraintId: e.target.value })}><option value="">请选择已保存快照</option>{props.constraints.filter(c => c.projectId === projectId).map((c, i) => <option key={c.id} value={c.id}>版本 {i + 1} · {c.outputSpec.width}×{c.outputSpec.height} {c.outputSpec.format}</option>)}</select></label>
      <label>设计指令<textarea aria-label="保护生产图片设计指令" rows={3} maxLength={model?.maxPromptCharacters ?? 32000} value={draft.prompt} onChange={e => patch({ prompt: e.target.value })} /></label>
      <div className="run-fields"><label>质量<select aria-label="保护生产图片质量" value={draft.quality} onChange={e => patch({ quality: e.target.value })}><option value="">请选择</option>{model?.qualities.map(q => <option key={q}>{q}</option>)}</select></label><label>背景<select aria-label="保护生产图片背景" value={draft.background} onChange={e => patch({ background: e.target.value })}><option value="">请选择</option>{model?.backgrounds.map(b => <option key={b}>{b}</option>)}</select></label></div>
      <p className="run-hint">精确输出来自原人工约束：{constraint ? `${constraint.outputSpec.width}×${constraint.outputSpec.height} ${constraint.outputSpec.format}` : "未选择"}。不提供 auto、改锁、缩图或换模型。</p>
      {draft.operation === "edit" && <><fieldset><legend>保护编辑原图（选中顺序即原输入顺序）</legend>{props.assets.filter(a => a.projectId === projectId && a.kind === "image" && a.purpose !== "mask").map(a => <label className="image-input-choice" key={a.id}><input type="checkbox" aria-label={`保护编辑输入 ${a.originalName}`} disabled={props.missingOriginalAssetIds.has(a.id)} checked={draft.inputAssetIds.includes(a.id)} onChange={e => patch({ inputAssetIds: e.target.checked ? [...draft.inputAssetIds, a.id] : draft.inputAssetIds.filter(id => id !== a.id) })} />{a.originalName} {draft.inputAssetIds.includes(a.id) && `· 第 ${draft.inputAssetIds.indexOf(a.id) + 1} 张`}</label>)}</fieldset>
        <label>蒙版<select aria-label="保护生产图片蒙版" value={draft.maskAssetId} onChange={e => patch({ maskAssetId: e.target.value })}><option value="">不携带</option>{props.assets.filter(a => a.projectId === projectId && a.purpose === "mask" && !props.missingOriginalAssetIds.has(a.id)).map(a => <option key={a.id} value={a.id}>{a.originalName}</option>)}</select></label>
        {!!model?.inputFidelities.length && <label>输入保真度<select aria-label="保护生产图片保真度" value={draft.inputFidelity} onChange={e => patch({ inputFidelity: e.target.value })}><option value="">不发送可选参数</option>{model.inputFidelities.map(f => <option key={f}>{f}</option>)}</select></label>}</>}
      {model?.supportsOutputCompression && constraint?.outputSpec.format !== "png" && <label>压缩<input aria-label="保护生产图片压缩" inputMode="numeric" value={draft.outputCompression} onChange={e => patch({ outputCompression: e.target.value })} /></label>}
      {connection?.extraParameters.filter(r => draft.operation && r.operations.includes(draft.operation)).map(r => <label key={r.name}>受控参数 {r.name}{r.type === "integer" ? <input aria-label={`保护生产图片参数 ${r.name}`} inputMode="numeric" value={draft.extraValues[r.name] ?? ""} onChange={e => patch({ extraValues: { ...draft.extraValues, [r.name]: e.target.value } })} /> : <select aria-label={`保护生产图片参数 ${r.name}`} value={draft.extraValues[r.name] ?? ""} onChange={e => patch({ extraValues: { ...draft.extraValues, [r.name]: e.target.value } })}><option value="">不发送</option>{(r.type === "enum" ? r.values : ["true", "false"]).map(v => <option key={v}>{v}</option>)}</select>}</label>)}
      {validation && <small>{validation}</small>}<button className="run-primary" disabled={!!validation || !!pointer || !pointerChecked} onClick={() => void submit()}>保存未确认保护准备单</button>
    </fieldset>
    {pointer && <small>只读动作指针 {pointer.actionId} · {pointer.stage}。不含报价、选择或执行许可。</small>}
    <div className="run-fields"><label>原准备编号<input aria-label="历史保护准备单编号" maxLength={160} value={historyId} onChange={e => setHistoryId(e.target.value)} /></label><button disabled={busy || props.disabled || !historyId.trim() || !pointerChecked} onClick={() => void run(async api => {
      if (pointer?.preparationId && pointer.preparationId !== historyId.trim()) throw new Error("请先明确开始新动作，不覆盖原未知确认指针。");
      const actual = readLockedProductionRecovery(localStorage.getItem(lockedProductionRecoveryKey(scope, projectId)), scope, projectId);
      if (JSON.stringify(actual) !== JSON.stringify(pointer)) throw new Error("当前只读指针漂移，不能覆盖原动作。");
      const p = await api.preparation(projectId, historyId.trim()); if (!current(api)) return;
      if (pointer?.preparationId && (pointer.preparationFingerprint !== p.snapshotFingerprint || pointer.pricingFingerprint !== p.pricingFingerprint || pointer.protectionPolicyFingerprint !== p.protectionPolicyFingerprint)) throw new Error("原历史完整摘要错配。");
      if (JSON.stringify(readLockedProductionRecovery(localStorage.getItem(lockedProductionRecoveryKey(scope, projectId)), scope, projectId)) !== JSON.stringify(pointer)) throw new Error("读取中原指针漂移，不能覆盖。");
      display(p, api);
      if (!pointer) save({ schemaVersion: 2, tenantId: scope.tenantId, projectId, mode: scope.mode, actionId: `production-read-${crypto.randomUUID()}`, stage: "prepared", preparationId: p.id, preparationFingerprint: p.snapshotFingerprint, pricingFingerprint: p.pricingFingerprint, protectionPolicyFingerprint: p.protectionPolicyFingerprint });
      setNotice("只读原历史，不重报价或补发。");
    })}>读取历史保护准备单</button></div>
    <button disabled={busy || props.disabled} onClick={() => { try {
      const key = lockedProductionRecoveryKey(scope, projectId); localStorage.removeItem(key); if (localStorage.getItem(key) !== null) throw new Error();
      setPointer(null); setPointerChecked(true); setRecord(null); setEdited(false); setError(""); setNotice("仅清除本范围浏览器指针，服务端历史及预留保留；下次是明确新动作。");
    } catch { setError("生产指针无法清除，未开始新动作。"); } }}>开始新保护动作（保留服务端历史）</button>
    {record && <article className="image-preparation-summary" aria-label="未确认保护准备单"><strong>未确认 · 未授权执行 · 协议未准备</strong><small>{record.id} · {record.createdAt}</small>
      {(expired || drift || edited || inputDrift) && <p className="run-hint">{expired && "原价格已过期。"}{drift && "当前目录与原冻结修订不同。"}{edited && "当前表单已修改。"}{inputDrift && "当前完整约束或输入关系漂移。"}仅保留原历史，新确认需明确新动作。</p>}
      <LockedProductionImageConfirmationReview key={`${record.id}:${record.snapshotFingerprint}:${record.pricingFingerprint}:${record.protectionPolicyFingerprint}`} scope={scope} record={record} pointer={pointer} onPointer={setPointer}
        disabled={busy || props.disabled} contextBlocked={expired || drift || edited || inputDrift || !directoryChecked || !pointerChecked} blocked={expired || drift || edited || inputDrift || !directoryChecked || !pointerChecked || pointer?.stage !== "prepared"} />
    </article>}
  </section>;
}
