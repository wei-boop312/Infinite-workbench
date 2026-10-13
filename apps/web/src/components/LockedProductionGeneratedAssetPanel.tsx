import { useEffect, useRef, useState } from "react";
import { LockedProductionGeneratedReadScopeSchema, type Asset, type LockedProductionGeneratedAssetLineage, type LockedProductionGeneratedReadScope } from "@canvas/contracts";
import { LockedProductionGeneratedAssetClient } from "../runs/lockedProductionGeneratedAssetClient";
const amount = (n: number, currency: string) => `${currency} ${n} 最小单位`;
export default function LockedProductionGeneratedAssetPanel({ scope: input, projectId, onCachedAsset }: {
  scope: LockedProductionGeneratedReadScope; projectId: string; onCachedAsset: (asset: Asset) => void;
}) {
  const scope = LockedProductionGeneratedReadScopeSchema.parse(input), [id, setId] = useState(""), [busy, setBusy] = useState(false);
  const [view, setView] = useState<LockedProductionGeneratedAssetLineage | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const client = useRef<LockedProductionGeneratedAssetClient | null>(null), abort = useRef<AbortController | null>(null), pending = useRef(false);
  useEffect(() => { const c = new AbortController(); abort.current = c; client.current = new LockedProductionGeneratedAssetClient(scope, c.signal);
    return () => { c.abort(); client.current = null; abort.current = null; };
  }, [projectId, scope.tenantId, scope.mode]);
  const run = async (kind: "lineage" | "cache" | "verify") => {
    const api = client.current, signal = abort.current?.signal, assetId = id.trim(); if (!api || !signal || pending.current) return;
    const current = () => client.current === api && !signal.aborted;
    pending.current = true; setBusy(true); setError(""); setNotice(""); setView(null);
    try {
      if (kind === "cache") { const asset = await api.cache(projectId, assetId); if (!current()) return;
        onCachedAsset(asset); setNotice("保护原文件已缓存；未生成、结算或回画布。");
      } else { const latest = kind === "verify" ? (await api.verifyCached(projectId, assetId)).view : await api.lineage(projectId, assetId);
        if (!current()) return; setView(latest); setNotice(kind === "verify" ? "保护原图/代理/元数据/独立标记已核验；不是当前执行或费用许可。" : "只读原保护观察；不代表本机已缓存。"); }
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : "保护原图读取失败；离线原文件保留。"); }
    finally { if (current()) { pending.current = false; setBusy(false); } }
  };
  return <section className="image-preparation" aria-label="保护原图只读缓存">
    <h3>保护原图 · 独立v2只读缓存</h3>
    <p className="run-hint">仅可信主程序显式配置。只读已保存的保护产物，不生成、核账、释放预留或回画布。{scope.mode === "production-contract-fixture" && " 当前仅自有零费用合同夹具。"}</p>
    <label>原产物编号<input aria-label="保护原图资产编号" maxLength={160} value={id} disabled={busy} onChange={e => { setId(e.target.value); setView(null); setNotice(""); setError(""); }} /></label>
    <div className="run-fields"><button disabled={busy || !id.trim()} onClick={() => void run("lineage")}>只读保护原图谱系</button><button disabled={busy || !id.trim()} onClick={() => void run("cache")}>缓存保护原图</button></div>
    <button disabled={busy || !id.trim()} onClick={() => void run("verify")}>重新核验保护原图缓存</button>
    {error && <p role="alert" className="run-error">{error}</p>}{notice && <p role="status" className="run-hint">{notice}</p>}
    {view && <article className="image-preparation-summary" aria-label="保护原图谱系摘要">
      <strong>{view.image.asset.originalName} · {view.image.asset.width}×{view.image.asset.height} · {view.image.asset.mimeType}</strong>
      <small>实际任务 {view.jobId} · 批次 {view.batchId} · 原准备 {view.preparationId}</small>
      <small>原图 {view.image.asset.byteSize} 字节 · SHA {view.image.checksumSha256} · 产物 {view.artifactFingerprint}</small>
      <p>原估价 {view.billing.estimatedMinor === null ? "未知（不是零费用）" : amount(view.billing.estimatedMinor, view.billing.currency)} · 原上限 {amount(view.billing.maxCostMinor, view.billing.currency)} · 当前结算上限 {amount(view.billing.currentMaxCostMinor, view.billing.currency)} · 当前预留 {amount(view.billing.reservedMinor, view.billing.currency)} · 实费 {view.billing.actualMinor === undefined ? "未测得" : amount(view.billing.actualMinor, view.billing.currency)}</p>
      <p>原锁区 {view.protection.lockedPixels} 像素 · 原编辑区 {view.protection.editablePixels} 像素 · 已保存锁区RGBA8相等观察</p>
      <small>{view.protection.normalizationVersion} · {view.protection.maskPolicy} · checked-not-applied</small>
      <small>保护政策 {view.protection.policyFingerprint} · 像素证据 {view.protection.pixelProofFingerprint}</small>
      <p className="run-hint">仅固定autoOrient/sRGB/RGBA8域，不代表原编码/ICC/高位深或品牌语义；没有合成或重编码原图。客户端观察、缓存或SHA不是服务器许可。</p>
      <details><summary>原冻结保护、输入与约束</summary><pre>{JSON.stringify({ protection: view.protection, request: view.requestDraft, constraint: view.constraint, transformedInputs: view.transformedInputs }, null, 2)}</pre></details>
      <p className="run-hint">合法本机副本可离线保留，事后撤权不宣称销毁；普通添加和受保护回画布尚未开放。</p>
    </article>}
  </section>;
}
