import { useEffect, useRef, useState } from "react";
import type { ImageConfirmationPublic, ImagePreparationPublic, ProjectBudgetSnapshot } from "@canvas/contracts";
import { StudioRunClient } from "../runs/runClient";
import { confirmationRecoveryKey } from "../runs/imageConfirmationRecovery";

type Props = { record: ImagePreparationPublic; disabled: boolean; blocked: boolean;
  onConfirmed: (result: ImageConfirmationPublic, budget?: ProjectBudgetSnapshot) => void };

export default function ImageConfirmationReview(props: Props) {
  const { record } = props;
  const [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(true), [checked, setChecked] = useState(false);
  const [result, setResult] = useState<ImageConfirmationPublic | null>(null), [error, setError] = useState("");
  const client = useRef<StudioRunClient | null>(null), pending = useRef(false), liveProps = useRef(props); liveProps.current = props;
  const read = async (api: StudioRunClient) => {
    const saved = await api.imageConfirmation(record);
    if (client.current !== api) return;
    setResult(saved); setChecked(true); setReviewed(false);
    if (saved) {
      liveProps.current.onConfirmed(saved);
      const budget = await api.budget(record.projectId);
      if (client.current === api) liveProps.current.onConfirmed(saved, budget);
    }
  };
  useEffect(() => {
    const abort = new AbortController(), api = new StudioRunClient(abort.signal); client.current = api; pending.current = true;
    void read(api).catch(failure => { if (client.current === api) setError(failure instanceof Error ? failure.message : "只读确认恢复失败。"); })
      .finally(() => { if (client.current === api) { pending.current = false; setBusy(false); } });
    return () => { abort.abort(); client.current = null; };
    // Parent keys this review by the immutable preparation ID and fingerprint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { setReviewed(false); }, [props.blocked, props.disabled]);
  const perform = async (confirm: boolean) => {
    const api = client.current;
    if (!api || pending.current || props.disabled || (confirm && (!reviewed || !checked || props.blocked || result))) return;
    pending.current = true; setBusy(true); setError("");
    try {
      if (!confirm) await read(api);
      else {
        // Save only a read pointer BEFORE POST. Storage failure prevents the POST.
        localStorage.setItem(confirmationRecoveryKey(record.projectId), JSON.stringify({ schemaVersion: 1, projectId: record.projectId,
          preparationId: record.id, preparationFingerprint: record.snapshotFingerprint }));
        setChecked(false); setReviewed(false);
        const confirmed = await api.confirmImage(record);
        if (client.current !== api) return;
        setResult(confirmed); setChecked(true);
        liveProps.current.onConfirmed(confirmed);
        const budget = await api.budget(record.projectId);
        if (client.current === api) liveProps.current.onConfirmed(confirmed, budget);
      }
    } catch (failure) { if (client.current === api) setError(failure instanceof Error ? failure.message : "确认结果未知，请只读核对原准备单。"); }
    finally { if (client.current === api) { pending.current = false; setBusy(false); } }
  };
  const template = record.requestTemplate, constraint = record.constraint, quote = record.pricing.quote;
  return <section className="image-confirmation-review" aria-label="图片人工冻结确认">
    <h4>人工核对 · 服务端冻结记录</h4>
    <p className="run-hint">当前表单和资产名称不参与本次确认。以下约束、原文件引用、参数及假报价来自原不可变准备单。</p>
    <p className="image-frozen-prompt">设计指令：{template.parameters.prompt}</p>
    <p className="run-hint">约束 {constraint.id} · 保存于 {constraint.createdAt}<br />
      锁定路径：{constraint.lockedPaths.join("、") || "无"}；像素保护：{template.protection}（不承诺硬像素锁）<br />
      输出：{constraint.outputSpec.width}×{constraint.outputSpec.height} {constraint.outputSpec.format}；每任务 {template.parameters.n} 张<br />
      品牌规则：{JSON.stringify(constraint.brandRules)}<br />
      可编辑区域：{constraint.editableRegions.map(region => `${region.id}：${region.description}；蒙版 ${region.maskAssetId ?? "无"}`).join(" / ") || "无"}</p>
    <div className="run-hint">权威原文件（按冻结顺序）：{!template.inputs.length && "无"}
      {template.inputs.map((input, index) => <p key={input.assetId}>{index + 1}. {input.assetId} · {input.mimeType} · {input.width}×{input.height} · {input.byteSize} 字节<br />SHA-256：{input.checksumSha256}</p>)}
      {template.operation === "edit" && template.mask && <p>蒙版：{template.mask.assetId} · {template.mask.mimeType} · {template.mask.width}×{template.mask.height} · {template.mask.byteSize} 字节<br />SHA-256：{template.mask.checksumSha256}</p>}</div>
    <p className="run-hint">冻结参数：{JSON.stringify(template.parameters)}<br />受控中转参数：{JSON.stringify(template.providerParameters ?? {})}<br />
      假报价编号/版本/来源：{quote.id} / {quote.version} / {quote.source}；本地证据：{record.pricing.evidenceRef}<br />
      币种 {quote.currency}；估价 {quote.estimatedCostMinor}，预算预留上限 {quote.maxCostMinor}（均为最小币种单位，不是实费）<br />
      有效至 {quote.expiresAt}<br />完整准备摘要：{record.snapshotFingerprint}<br />人工约束 SHA-256：{template.constraintChecksumSha256}</p>
    {error && <p role="alert" className="run-error">{error} 不自动重发；原准备单与已有预留保留。</p>}
    <button disabled={busy || props.disabled} onClick={() => void perform(false)}>只读核对确认结果</button>
    {!checked && !busy && <p className="run-hint">确认状态未核对，不能再次提交；请只读恢复。</p>}
    {result ? <article aria-label="本地图片确认结果"><strong>已人工确认 · 未授权执行 · 协议已准备</strong>
      <p className="run-hint">任务 {result.aggregate.batch.id} · {result.aggregate.batch.status}；输出任务 {result.aggregate.jobs[0].id}<br />
        确认人 {result.confirmedBy} · {result.confirmedAt}<br />执行快照摘要：{result.executionFingerprint}<br />
        已准备负载 SHA-256：{result.payloadChecksumSha256}（不是已发送证据）<br />预留状态以任务账本为准；历史恢复不再次预留、不重新执行。</p></article>
      : <><label className="image-input-choice"><input aria-label="已核对完整冻结摘要与假报价上限" type="checkbox" checked={reviewed}
        disabled={busy || props.disabled || props.blocked || !checked} onChange={event => setReviewed(event.target.checked)} />
        我已核对完整冻结设计、输入/蒙版、币种、估价和上限；仅确认本地假报价，不授权生成。</label>
      <button className="run-primary" disabled={busy || props.disabled || props.blocked || !checked || !reviewed} onClick={() => void perform(true)}>确认假报价并预留上限</button></>}
    <small>确认前服务端复查目录/能力、输入/约束、报价和权限；漂移必须新动作。本区不生成、不自动执行/重试、不结算。</small>
  </section>;
}
