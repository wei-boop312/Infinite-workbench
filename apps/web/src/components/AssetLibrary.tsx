import { useState } from "react";
import type { Asset } from "@canvas/contracts";
import { formatAssetBytes, type AssetUsage } from "../assets/assetRepository";
import type { RemoteStorageUsage, UploadSession } from "../storage/objectStorage";

type AssetLibraryProps = {
  open: boolean;
  assets: Asset[];
  previewUrls: Record<string, string>;
  importing: boolean;
  error: string;
  referenceCounts: Record<string, number>;
  usage: AssetUsage | null;
  storageQuota: number | null;
  uploadSessions: Record<string, UploadSession>;
  remoteUsage: RemoteStorageUsage | null;
  backupAllBusy: boolean;
  missingOriginalAssetIds: Set<string>;
  restoringAssetIds: Set<string>;
  onClose: () => void;
  onAddToCanvas: (asset: Asset) => void;
  onChooseFiles: () => void;
  onRemove: (asset: Asset) => Promise<void>;
  onCleanup: () => Promise<number>;
  onBackup: (asset: Asset) => Promise<void>;
  onPauseBackup: (assetId: string) => void;
  onBackupAll: () => Promise<void>;
  onRestore: (asset: Asset) => Promise<void>;
};

function uploadLabel(session: UploadSession | undefined): string {
  if (!session) return "备份";
  const progress = session.totalBytes ? Math.round(session.uploadedBytes / session.totalBytes * 100) : 0;
  if (session.status === "completed") return "已备份";
  if (session.status === "reused") return "已复用";
  if (session.status === "paused") return `继续 ${progress}%`;
  if (session.status === "failed") return "重试";
  if (session.status === "hashing") return `暂停校验 ${progress}%`;
  return `暂停 ${progress}%`;
}

export function AssetLibrary({
  open,
  assets,
  previewUrls,
  importing,
  error,
  referenceCounts,
  usage,
  storageQuota,
  uploadSessions,
  remoteUsage,
  backupAllBusy,
  missingOriginalAssetIds,
  restoringAssetIds,
  onClose,
  onAddToCanvas,
  onChooseFiles,
  onRemove,
  onCleanup,
  onBackup,
  onPauseBackup,
  onBackupAll,
  onRestore,
}: AssetLibraryProps) {
  const [confirmAssetId, setConfirmAssetId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  if (!open) return null;
  const confirmAsset = assets.find((asset) => asset.id === confirmAssetId);
  const unusedCount = assets.filter((asset) => (referenceCounts[asset.id] ?? 0) === 0).length;
  const pendingBackupCount = assets.filter((asset) => !missingOriginalAssetIds.has(asset.id)
    && !["completed", "reused"].includes(uploadSessions[asset.id]?.status ?? "")).length;
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
      <div className="remote-backup-summary" aria-label="本地假远端备份">
        <div>
          <span>本地假远端 · {remoteUsage?.objectCount ?? 0} 个对象</span>
          <span>{remoteUsage ? `占用 ${formatAssetBytes(remoteUsage.storedBytes)} · 0 次外网请求` : "正在读取备份状态"}</span>
        </div>
        <button disabled={!pendingBackupCount || backupAllBusy} onClick={() => void onBackupAll()}>
          {backupAllBusy ? "备份中…" : `备份未同步 ${pendingBackupCount}`}
        </button>
      </div>
      {(error || removeError) && <p className="asset-error" role="alert">{removeError || error}</p>}
      {!assets.length && <p className="asset-empty">导入后的原文件保存在浏览器资产库中，画布文档只记录 assetId。</p>}
      <div className="asset-grid">
        {assets.map((asset) => {
          const session = uploadSessions[asset.id];
          const transferActive = ["queued", "hashing", "uploading"].includes(session?.status ?? "");
          const transferFinished = ["completed", "reused"].includes(session?.status ?? "");
          const locallyProtected = (referenceCounts[asset.id] ?? 0) > 0;
          const originalMissing = missingOriginalAssetIds.has(asset.id);
          const restoring = restoringAssetIds.has(asset.id);
          const canRestore = originalMissing && transferFinished && Boolean(session?.objectKey);
          return (
          <article key={asset.id} className="asset-card">
            <div className="asset-thumb">
              {previewUrls[asset.id]
                ? <img src={previewUrls[asset.id]} alt={asset.originalName} />
                : <span>{asset.kind === "video" ? "VIDEO" : "IMAGE"}</span>}
              <em>{asset.purpose === "mask" ? "蒙版" : asset.kind === "video" ? "视频" : "图片"}</em>
            </div>
            <strong title={asset.originalName}>{asset.originalName}</strong>
            <small>
              <span>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "尺寸未知"} · {formatAssetBytes(asset.byteSize)}</span>
              <span className={`remote-state state-${session?.status ?? "local"}`}>
                {originalMissing
                  ? canRestore ? "本地原文件缺失 · 备份可恢复" : "本地原文件缺失 · 无完整备份"
                  : session?.status === "failed" ? `备份失败：${session.error ?? "可重试"}` : uploadLabel(session)}
              </span>
            </small>
            <div className="asset-card-actions">
              <button disabled={originalMissing || asset.purpose === "generated"} title={asset.purpose === "generated" ? "生成图片已缓存；任务结果画布回流尚未开放" : originalMissing ? "请先恢复本地原文件" : undefined} onClick={() => onAddToCanvas(asset)}>添加到画布</button>
              <button
                className="backup"
                disabled={originalMissing ? !canRestore || restoring : transferFinished}
                onClick={() => originalMissing
                  ? void onRestore(asset)
                  : transferActive ? onPauseBackup(asset.id) : void onBackup(asset)}
              >{restoring ? "恢复中…" : originalMissing ? canRestore ? "恢复本地" : "无可用备份" : uploadLabel(session)}</button>
              <button
                className="remove"
                disabled={locallyProtected || transferActive || restoring}
                title={locallyProtected ? "先删除画布节点或引用该蒙版的约束快照" : transferActive ? "请先暂停当前备份" : "移除本地原文件和预览"}
                onClick={() => setConfirmAssetId(asset.id)}
              >{locallyProtected ? `使用中 ${referenceCounts[asset.id]}` : transferActive ? "备份中" : "移除"}</button>
            </div>
          </article>
          );
        })}
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
