import { useEffect, useRef, useState } from "react";
import { ProductionGeneratedReadScopeSchema, type Asset, type ProductionGeneratedAssetLineage, type ProductionGeneratedReadScope } from "@canvas/contracts";
import { ProductionGeneratedAssetClient } from "../runs/productionGeneratedAssetClient";
const amount = (minor: number, currency: string) => `${currency} ${minor} 最小单位`;

export default function ProductionGeneratedAssetPanel({ scope: input, projectId, onCachedAsset }: {
  scope: ProductionGeneratedReadScope; projectId: string; onCachedAsset: (asset: Asset) => void;
}) {
  const scope = ProductionGeneratedReadScopeSchema.parse(input), [id, setId] = useState(""), [busy, setBusy] = useState(false);
  const [view, setView] = useState<ProductionGeneratedAssetLineage | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const client = useRef<ProductionGeneratedAssetClient | null>(null), abort = useRef<AbortController | null>(null), pending = useRef(false);
  useEffect(() => {
    const c = new AbortController(); abort.current = c; client.current = new ProductionGeneratedAssetClient(scope, c.signal);
    return () => { c.abort(); client.current = null; abort.current = null; };
  }, [projectId, scope.tenantId, scope.mode]);
  const run = async (kind: "lineage" | "cache" | "verify") => {
    const api = client.current, signal = abort.current?.signal, assetId = id.trim(); if (!api || !signal || pending.current) return;
    const current = () => client.current === api && !signal.aborted;
    pending.current = true; setBusy(true); setError(""); setNotice(""); setView(null);
    try {
      if (kind === "cache") {
        const asset = await api.cache(projectId, assetId); if (!current()) return;
        onCachedAsset(asset); setNotice("生产原文件已缓存到项目资产库；未生成、结算或回画布。");
      } else {
        const latest = kind === "verify" ? (await api.verifyCached(projectId, assetId)).view : await api.lineage(projectId, assetId); if (!current()) return;
        setView(latest); setNotice(kind === "verify" ? "原图/元数据/独立标记已核验；不构成当前执行或费用许可。" : "仅当前只读谱系；不代表本机已有原文件。");
      }
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : "生产原图读取失败；离线原文件保留。"); }
    finally { if (current()) { pending.current = false; setBusy(false); } }
  };
  return <section className="image-preparation" aria-label="生产原图只读缓存">
    <h3>生产原图 · 只读谱系与独立缓存</h3>
    <p className="run-hint">仅可信主程序显式配置。只读取已保存的权威产物，不生成、重试、核账或释放未知预留。{scope.mode === "production-contract-fixture" && " 当前仅自有零费用合同夹具。"}</p>
    <label>原产物编号<input aria-label="生产原图资产编号" maxLength={160} value={id} disabled={busy} onChange={e => { setId(e.target.value); setView(null); setNotice(""); setError(""); }} /></label>
    <div className="run-fields"><button disabled={busy || !id.trim()} onClick={() => void run("lineage")}>只读生产原图谱系</button><button disabled={busy || !id.trim()} onClick={() => void run("cache")}>缓存生产原图</button></div>
    <button disabled={busy || !id.trim()} onClick={() => void run("verify")}>重新核验生产原图缓存</button>
    {error && <p role="alert" className="run-error">{error}</p>}{notice && <p role="status" className="run-hint">{notice}</p>}
    {view && <article className="image-preparation-summary" aria-label="生产原图谱系摘要">
      <strong>{view.image.asset.originalName} · {view.image.asset.width}×{view.image.asset.height} · {view.image.asset.mimeType}</strong>
      <small>实际任务 {view.jobId} · 批次 {view.batchId} · 原准备 {view.preparationId}</small>
      <small>原图 {view.image.asset.byteSize} 字节 · SHA {view.image.checksumSha256} · 产物 {view.artifactFingerprint}</small>
      <p>原估价 {view.billing.estimatedMinor === null ? "未知（不是零费用）" : amount(view.billing.estimatedMinor, view.billing.currency)} · 原上限 {amount(view.billing.maxCostMinor, view.billing.currency)} · 当前结算上限 {amount(view.billing.currentMaxCostMinor, view.billing.currency)} · 当前预留 {amount(view.billing.reservedMinor, view.billing.currency)} · 实费 {view.billing.actualMinor === undefined ? "未测得" : amount(view.billing.actualMinor, view.billing.currency)}</p>
      <details><summary>原冻结输入与约束</summary><pre>{JSON.stringify({ request: view.requestDraft, constraint: view.constraint, transformedInputs: view.transformedInputs }, null, 2)}</pre></details>
      <p className="run-hint">本机副本可离线保留，缓存不代表当前读取权限；普通添加到画布仍关闭，受控生产回流尚未开放。</p>
    </article>}
  </section>;
}
