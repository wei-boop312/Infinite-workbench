import { useEffect, useRef, useState } from "react";
import type { LockedProductionImagePreparationPublic, LockedProductionImageConfirmationPublic, LockedProductionImageUiScope, LockedProductionImageRecovery } from "@canvas/contracts";
import { LockedProductionImageClient } from "../runs/lockedProductionImageClient";
import { lockedProductionRecoveryKey, readLockedProductionRecovery, saveLockedProductionRecovery } from "../runs/lockedProductionImageRecovery";

type Props = { scope: LockedProductionImageUiScope; record: LockedProductionImagePreparationPublic; disabled: boolean; blocked: boolean; contextBlocked: boolean;
  pointer: LockedProductionImageRecovery | null; onPointer: (p: LockedProductionImageRecovery) => void };
export default function LockedProductionImageConfirmationReview(props: Props) {
  const { record, scope } = props;
  const [reviewed, setReviewed] = useState(false), [checked, setChecked] = useState(false), [busy, setBusy] = useState(true);
  const [result, setResult] = useState<LockedProductionImageConfirmationPublic | null>(null), [error, setError] = useState(""), [budgetText, setBudgetText] = useState("");
  const client = useRef<LockedProductionImageClient | null>(null), pending = useRef(false), latest = useRef(props); latest.current = props;
  const read = async (api: LockedProductionImageClient) => {
    const c = await api.history(record); if (client.current !== api) return;
    setResult(c); setChecked(true); setReviewed(false);
    if (c) {
      const b = await api.budget(record.projectId); if (client.current !== api) return;
      setBudgetText(`项目 ${b.currency}：已预留 ${b.reservedMinor}，已结算 ${b.spentMinor}（最小币种单位）。`);
    }
  };
  useEffect(() => {
    const abort = new AbortController(), api = new LockedProductionImageClient(scope, abort.signal); client.current = api; pending.current = true;
    void read(api).catch(e => { if (client.current === api) setError(e instanceof Error ? e.message : "只读恢复失败。"); })
      .finally(() => { if (client.current === api) { pending.current = false; setBusy(false); } });
    return () => { abort.abort(); client.current = null; };
    // Keyed by exact tenant/mode/project/preparation/fingerprints, including StrictMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setReviewed(false), [props.blocked, props.disabled]);
  const attempted = props.pointer?.stage === "confirm-submitted";
  const perform = async (confirm: boolean) => {
    const api = client.current, live = latest.current;
    if (!api || pending.current || live.disabled || (confirm && (!checked || !reviewed || live.blocked || attempted || result))) return;
    pending.current = true; setBusy(true); setError("");
    try {
      if (!confirm) await read(api);
      else {
        setChecked(false); setReviewed(false);
        const pointer = readLockedProductionRecovery(localStorage.getItem(lockedProductionRecoveryKey(scope, record.projectId)), scope, record.projectId);
        if (!pointer || pointer.stage !== "prepared" || pointer.preparationId !== record.id || pointer.preparationFingerprint !== record.snapshotFingerprint
          || pointer.pricingFingerprint !== record.pricingFingerprint || pointer.protectionPolicyFingerprint !== record.protectionPolicyFingerprint || JSON.stringify(pointer) !== JSON.stringify(live.pointer)) throw new Error("生产指针丢失或漂移；仅只读核对，不提交。");
        const next = { ...pointer, stage: "confirm-submitted" as const };
        saveLockedProductionRecovery(localStorage, scope, next); live.onPointer(next);
        const c = await api.confirm(record, () => {
          if (client.current !== api || latest.current.contextBlocked || latest.current.disabled || JSON.stringify(readLockedProductionRecovery(localStorage.getItem(lockedProductionRecoveryKey(scope, record.projectId)), scope, record.projectId)) !== JSON.stringify(next)) throw new Error("确认前原指针或范围漂移，仅只读核对。");
          saveLockedProductionRecovery(localStorage, scope, next);
        }); if (client.current !== api) return;
        setResult(c); setChecked(true);
        const b = await api.budget(record.projectId); if (client.current === api) setBudgetText(`项目 ${b.currency}：已预留 ${b.reservedMinor}，已结算 ${b.spentMinor}（最小币种单位）。`);
      }
    } catch (e) { if (client.current === api) setError(e instanceof Error ? e.message : "结果未知，仅只读恢复。"); }
    finally { if (client.current === api) { pending.current = false; setBusy(false); } }
  };
  const d = record.requestDraft, c = record.constraint, q = record.pricing.quote;
  return <section className="image-confirmation-review" aria-label="保护生产图片人工冻结确认">
    <h4>生产合同 · 人工核对原服务端冻结记录</h4>
    <p className="run-hint">{record.mode === "production-contract-fixture" ? "自有零费用合同夹具，不是供应商价格或实接。" : "独立生产合同，不代表已核验真实供应商或开启执行。"} 当前表单、名称和客户端摘要不是服务端许可。</p>
    <p className="image-frozen-prompt">设计指令：{d.parameters.prompt}</p>
    <p className="run-hint">{record.connection.name} · {record.connection.protocol} · 修订 {record.connection.revision} · {d.model} · 能力 {d.capabilityVersion}<br />
      约束 {c.id} · {c.createdAt}<br />锁定路径：{c.lockedPaths.join("、") || "无"}；像素保护 {d.protection}（仅固定 RGBA8 域核验，尚未核验输出）<br />
      品牌规则：{JSON.stringify(c.brandRules)}<br />可编辑区域：{c.editableRegions.map(r => `${r.id}：${r.description}；蒙版 ${r.maskAssetId ?? "无"}`).join(" / ") || "无"}<br />
      输出 {c.outputSpec.width}×{c.outputSpec.height} {c.outputSpec.format}；每任务 {d.parameters.n} 张</p>
    <div className="run-hint">权威原文件（冻结顺序）：{!d.inputs.length && "无"}{d.inputs.map((r, i) => <p key={r.assetId}>{i + 1}. {r.assetId} · {r.mimeType} · {r.width}×{r.height} · {r.byteSize} 字节<br />SHA-256：{r.checksumSha256}</p>)}
      {d.operation === "edit" && d.mask && <p>蒙版 {d.mask.assetId} · {d.mask.mimeType} · {d.mask.width}×{d.mask.height} · {d.mask.byteSize} 字节<br />SHA-256：{d.mask.checksumSha256}</p>}</div>
    <p className="run-hint">冻结参数：{JSON.stringify(d.parameters)}<br />受控中转参数：{JSON.stringify(d.providerParameters ?? {})}<br />
      价格编号/版本/来源：{q.id} / {q.version} / {q.source}<br />依据：{record.pricing.evidence.kind} · {record.pricing.evidence.sourceRevision} · {record.pricing.evidence.evidenceRef} · {record.pricing.evidence.checkedBy} · {record.pricing.evidence.checkedAt}<br />
      币种 {q.currency}；{q.source === "manual-budget" ? "估价未知（不能当作0或上限）" : `原估价 ${q.estimatedCostMinor}`}；独立预留上限 {q.maxCostMinor}（最小币种单位，不是实费）<br />
      有效至 {q.expiresAt}<br />完整准备摘要：{record.snapshotFingerprint}<br />原完整价格摘要：{record.pricingFingerprint}<br />人工约束 SHA-256：{d.constraintChecksumSha256}</p>
    <div className="run-hint" aria-label="原冻结保护输入政策">
      <strong>输入已预检 / 输出尚未核验 · input-verified-output-unchecked</strong>
      <p>政策 {record.protectionPolicy.policyVersion}；规范 {record.protectionPolicy.normalizationVersion}；蒙版 {record.protectionPolicy.maskPolicy}。fixed-rgba8-only：方向校正 / sRGB / RGBA8，白色且 alpha255 可编辑，alpha0..254（含抗锯齿）锁定。锁区 {record.protectionPolicy.lockedPixels} 像素 / 编辑区 {record.protectionPolicy.editablePixels} 像素，两区均非零。</p>
      <p>只验证供应商原输出，不缩放、重编码、合成或放宽有损差异。不是原编码字节、ICC、高位深、任意解码器一致或品牌语义保证；此处没有输出锁区相等证明或生成许可。</p>
      {[record.protectionPolicy.source, record.protectionPolicy.mask].map(r => <p key={r.assetId}>原收据 {r.receiptId} / {r.assetId}；注册元信息 SHA {r.registeredMetadataSha256}<br />原字节 SHA {r.checksumSha256} · {r.mimeType} · {r.width}×{r.height} · {r.byteSize} 字节</p>)}
      <p>蒙版 → 原源图 {record.protectionPolicy.mask.sourceAssetId} / {record.protectionPolicy.mask.sourceChecksumSha256}<br />
        规范源图像素 SHA {record.protectionPolicy.sourcePixelsSha256}<br />规范蒙版像素 SHA {record.protectionPolicy.maskPixelsSha256}<br />
        输入预检时刻 {record.protectionPolicy.verifiedAt}<br />原完整保护政策摘要（不透明）{record.protectionPolicyFingerprint}</p>
    </div>
    {error && <p className="run-error" role="alert">{error} 原记录与已有预留保留，不自动重发。</p>}
    <button disabled={busy || props.disabled} onClick={() => void perform(false)}>只读核对保护确认结果</button>
    {result ? <article aria-label="保护生产图片确认结果"><strong>已人工确认 · 未授权执行 · 协议已准备</strong><p className="run-hint">批次 {result.task.batchId} · {result.task.batchStatus}<br />任务 {result.task.jobId} · {result.task.jobStatus}<br />
      确认人 {result.confirmedBy} · {result.confirmedAt}<br />原估价 {result.task.estimatedCostMinor === null ? "未知" : result.task.estimatedCostMinor} · 原上限 {q.maxCostMinor} · 当前上限 {result.task.currentMaxCostMinor} · 当前预留 {result.task.reservedMinor} · 实费 {result.task.actualCostMinor ?? "未测得"}<br />
      执行快照摘要 {result.executionFingerprint}<br />已准备负载 SHA-256 {result.payloadChecksumSha256}（不是已发送证据）。<br />历史不再预留、不发送、不结算。</p>{budgetText && <p className="run-hint">{budgetText}</p>}</article>
      : <><label className="image-input-choice"><input type="checkbox" aria-label="已核对保护完整冻结记录与独立上限" checked={reviewed} disabled={busy || props.disabled || props.blocked || !checked || attempted} onChange={e => setReviewed(e.target.checked)} />我已核对原完整设计、锁区、品牌、区域、输入/蒙版元信息与绑定、完整保护政策、固定 RGBA8 域及其限制、两非零区域、参数、币种、估价或未知和独立上限；只暂存确认，不授权生成。</label>
        <button className="run-primary" disabled={busy || props.disabled || props.blocked || !checked || !reviewed || attempted} onClick={() => void perform(true)}>人工确认保护记录并预留上限</button>
        {(!checked || attempted) && <p className="run-hint">状态未完整核对或原确认已尝试；此动作只读恢复，禁止补发确认。</p>}</>}
    <small>服务端仍复查实际权限、目录能力、原图约束、原价格和统一预算。本区无执行、重试、产物、核账或回画布操作。</small>
  </section>;
}
