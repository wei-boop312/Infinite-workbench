import { useState } from "react";
import type { Asset } from "@canvas/contracts";
import { formatAssetBytes, type AssetUsage } from "../assets/assetRepository";

type AssetLibraryProps = {
  open: boolean;
  assets: Asset[];
  previewUrls: Record<string, string>;
  importing: boolean;
  error: string;
  referenceCounts: Record<string, number>;
  usage: AssetUsage | null;
  storageQuota: number | null;
  onClose: () => void;
  onAddToCanvas: (asset: Asset) => void;
  onChooseFiles: () => void;
  onRemove: (asset: Asset) => Promise<void>;
  onCleanup: () => Promise<number>;
};

export function AssetLibrary({
  open,
  assets,
  previewUrls,
  importing,
  error,
  referenceCounts,
  usage,
  storageQuota,
  onClose,
  onAddToCanvas,
  onChooseFiles,
  onRemove,
  onCleanup,
}: AssetLibraryProps) {
  const [confirmAssetId, setConfirmAssetId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  if (!open) return null;
  const confirmAsset = assets.find((asset) => asset.id === confirmAssetId);
  const unusedCount = assets.filter((asset) => (referenceCounts[asset.id] ?? 0) === 0).length;
  return (
    <aside className="asset-library" aria-label="项目资产库">
      <header>
        <div><span>项目资产库</span><strong>{assets.length} 个资产</strong></div>
        <button aria-label="关闭资产库" onClick={onClose}>×</button>
      </header>
      <button className="asset-import-primary" disabled={importing} onClick={onChooseFiles}>
        {importing ? "正在生成缩略图…" : "导入图片或视频"}
      </button>
      {usage && (
        <div className="asset-usage" aria-label="资产存储占用">
          <div><span>当前项目 {formatAssetBytes(usage.totalBytes)}</span><span>{storageQuota ? `浏览器配额 ${formatAssetBytes(storageQuota)}` : "浏览器配额未知"}</span></div>
          <button disabled={!unusedCount} onClick={() => {
            setConfirmAssetId(null);
            setConfirmCleanup(true);
          }}>清理未使用 {unusedCount}</button>
        </div>
      )}
      {(error || removeError) && <p className="asset-error" role="alert">{removeError || error}</p>}
      {!assets.length && <p className="asset-empty">导入后的原文件保存在浏览器资产库中，画布文档只记录 assetId。</p>}
      <div className="asset-grid">
        {assets.map((asset) => (
          <article key={asset.id} className="asset-card">
            <div className="asset-thumb">
              {previewUrls[asset.id]
                ? <img src={previewUrls[asset.id]} alt={asset.originalName} />
                : <span>{asset.kind === "video" ? "VIDEO" : "IMAGE"}</span>}
              <em>{asset.purpose === "mask" ? "蒙版" : asset.kind === "video" ? "视频" : "图片"}</em>
            </div>
            <strong title={asset.originalName}>{asset.originalName}</strong>
            <small>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "尺寸未知"} · {formatAssetBytes(asset.byteSize)}</small>
            <div className="asset-card-actions">
              <button onClick={() => onAddToCanvas(asset)}>添加到画布</button>
              <button
                className="remove"
                disabled={(referenceCounts[asset.id] ?? 0) > 0}
                title={(referenceCounts[asset.id] ?? 0) > 0 ? "先删除画布节点或引用该蒙版的约束快照" : "移除本地原文件和预览"}
                onClick={() => setConfirmAssetId(asset.id)}
              >{(referenceCounts[asset.id] ?? 0) > 0 ? `使用中 ${referenceCounts[asset.id]}` : "移除"}</button>
            </div>
          </article>
        ))}
      </div>
      {confirmAsset && (
        <section className="asset-remove-confirm" role="alertdialog" aria-label="确认移除资产">
          <strong>移除“{confirmAsset.originalName}”？</strong>
          <p>将删除当前浏览器中的原文件和预览，且无法撤销。</p>
          <div><button onClick={() => setConfirmAssetId(null)}>取消</button><button className="danger" disabled={removing} onClick={async () => {
            setRemoving(true);
            setRemoveError("");
            try {
              await onRemove(confirmAsset);
              setConfirmAssetId(null);
            } catch (removeAssetError) {
              setRemoveError(removeAssetError instanceof Error ? removeAssetError.message : "资产移除失败");
            } finally {
              setRemoving(false);
            }
          }}>{removing ? "正在移除…" : "确认移除"}</button></div>
        </section>
      )}
      {confirmCleanup && (
        <section className="asset-remove-confirm" role="alertdialog" aria-label="确认清理未使用资产">
          <strong>清理 {unusedCount} 个未使用资产？</strong>
          <p>正在被画布节点、蒙版来源或历史约束快照引用的资产不会被删除。</p>
          <div><button onClick={() => setConfirmCleanup(false)}>取消</button><button className="danger" disabled={removing} onClick={async () => {
            setRemoving(true);
            setRemoveError("");
            try {
              await onCleanup();
              setConfirmCleanup(false);
            } catch (cleanupError) {
              setRemoveError(cleanupError instanceof Error ? cleanupError.message : "未使用资产清理失败");
            } finally {
              setRemoving(false);
            }
          }}>{removing ? "正在清理…" : "确认清理"}</button></div>
        </section>
      )}
    </aside>
  );
}
