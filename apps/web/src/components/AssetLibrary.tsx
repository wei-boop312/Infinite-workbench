import type { Asset } from "@canvas/contracts";
import { formatAssetBytes } from "../assets/assetRepository";

type AssetLibraryProps = {
  open: boolean;
  assets: Asset[];
  previewUrls: Record<string, string>;
  importing: boolean;
  error: string;
  onClose: () => void;
  onAddToCanvas: (asset: Asset) => void;
  onChooseFiles: () => void;
};

export function AssetLibrary({
  open,
  assets,
  previewUrls,
  importing,
  error,
  onClose,
  onAddToCanvas,
  onChooseFiles,
}: AssetLibraryProps) {
  if (!open) return null;
  return (
    <aside className="asset-library" aria-label="项目资产库">
      <header>
        <div><span>项目资产库</span><strong>{assets.length} 个资产</strong></div>
        <button aria-label="关闭资产库" onClick={onClose}>×</button>
      </header>
      <button className="asset-import-primary" disabled={importing} onClick={onChooseFiles}>
        {importing ? "正在生成缩略图…" : "导入图片或视频"}
      </button>
      {error && <p className="asset-error" role="alert">{error}</p>}
      {!assets.length && <p className="asset-empty">导入后的原文件保存在浏览器资产库中，画布文档只记录 assetId。</p>}
      <div className="asset-grid">
        {assets.map((asset) => (
          <article key={asset.id} className="asset-card">
            <div className="asset-thumb">
              {previewUrls[asset.id]
                ? <img src={previewUrls[asset.id]} alt={asset.originalName} />
                : <span>{asset.kind === "video" ? "VIDEO" : "IMAGE"}</span>}
              <em>{asset.kind === "video" ? "视频" : "图片"}</em>
            </div>
            <strong title={asset.originalName}>{asset.originalName}</strong>
            <small>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "尺寸未知"} · {formatAssetBytes(asset.byteSize)}</small>
            <button onClick={() => onAddToCanvas(asset)}>添加到画布</button>
          </article>
        ))}
      </div>
    </aside>
  );
}
