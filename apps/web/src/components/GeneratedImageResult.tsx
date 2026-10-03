import { useEffect, useRef, useState } from "react";
import type { GeneratedAssetLineage, RunBatchAggregate, RunJob } from "@canvas/contracts";
import { StudioRunClient } from "../runs/runClient";

// Explicit read only. No task refresh/recovery, cache fallback or accounting.
export default function GeneratedImageResult({ batch, job }: { batch: RunBatchAggregate; job: RunJob }) {
  const [view, setView] = useState<GeneratedAssetLineage | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null), pending = useRef(false);
  useEffect(() => {
    const active = new AbortController(); controller.current = active; pending.current = false; setView(null); setError(""); setBusy(false);
    return () => { active.abort(); if (controller.current === active) controller.current = null; };
  }, [batch.batch.projectId, batch.batch.id, job.id, job.status, job.outputAssetIds[0]]);
  const read = async () => {
    const active = controller.current;
    if (!active || pending.current) return;
    pending.current = true; setBusy(true); setView(null); setError("");
    try {
      const result = await new StudioRunClient(active.signal).generatedLineage(batch, job);
      if (controller.current === active && !active.signal.aborted) setView(result);
    } catch (failure) {
      if (controller.current === active && !active.signal.aborted) setError(failure instanceof Error ? failure.message : "结果读取失败。");
    } finally {
      if (controller.current === active && !active.signal.aborted) { pending.current = false; setBusy(false); }
    }
  };
  return <section className="image-result-lineage" aria-label="实际图片结果谱系">
    <button disabled={busy} onClick={() => void read()}>只读核验输出 {job.outputIndex + 1} 谱系</button>
    {error && <p className="run-error" role="alert">{error}</p>}
    {view && <article aria-label="已核验实际图片结果">
      <strong>已验证原图 · 本地假响应产物，非真实供应商生成</strong>
      <p>{view.connectionName} · {view.protocol} · {view.requestTemplate.model} · 修订 {view.requestTemplate.connectionRevision} · 能力 {view.requestTemplate.capabilityVersion}</p>
      <p className="image-frozen-prompt">原冻结指令：{view.requestTemplate.parameters.prompt}</p>
      <p>原约束 {view.constraint.id} · 锁定：{view.constraint.lockedPaths.join("、") || "无"} · 品牌：{Object.entries(view.constraint.brandRules).map(([name, value]) => `${name}=${value}`).join("；") || "无"}</p>
      <p>可编辑区域：{view.constraint.editableRegions.map(region => `${region.description}${region.maskAssetId ? `（蒙版 ${region.maskAssetId}）` : ""}`).join("；") || "无"}</p>
      {view.requestTemplate.inputs.map((input, index) => <p key={input.assetId}>输入 {index + 1}：{input.assetId} · {input.width}×{input.height} · SHA-256 {input.checksumSha256}</p>)}
      {view.requestTemplate.operation === "edit" && view.requestTemplate.mask && <p>原蒙版：{view.requestTemplate.mask.assetId} · SHA-256 {view.requestTemplate.mask.checksumSha256}</p>}
      <p>输出：{view.image.asset.id} · {view.image.asset.width}×{view.image.asset.height} · {view.image.asset.mimeType} · {view.image.asset.byteSize} 字节</p>
      <small>原图 SHA-256：{view.image.checksumSha256}</small>
      <small>实际任务 {view.jobId} · 批次 {view.batchId}</small>
      <small>人工确认 {view.confirmedBy} · {view.confirmedAt} · 准备单 {view.preparationId}</small>
      <small>不可变产物摘要：{view.generatedRecordFingerprint}</small>
      <p>假报价 {view.pricing.quote.currency} · 原估价 {view.pricing.quote.estimatedCostMinor} · 原上限 {view.pricing.quote.maxCostMinor}（最小货币单位）</p>
      <p>{view.billing.state === "unknown" ? `费用未知 · 预留 ${view.billing.reservedMinor}，有图不等于已结算` : `已人工核账 · 实费 ${view.billing.actualMinor} · 预留 ${view.billing.reservedMinor}`} {view.billing.currency}</p>
      <small>此读取不发送、不核账、不释放预留；画布回流尚未开放。</small>
    </article>}
  </section>;
}
