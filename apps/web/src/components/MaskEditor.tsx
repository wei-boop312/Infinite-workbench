import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { Asset } from "@canvas/contracts";

type MaskTool = "brush" | "rectangle" | "erase";

type MaskEditorProps = {
  assets: Asset[];
  previewUrls: Record<string, string>;
  initialMaskAssetId?: string;
  onCancel: () => void;
  onSave: (sourceAssetId: string, blob: Blob, width: number, height: number) => Promise<Asset>;
};

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("无法导出蒙版")),
    "image/png",
  ));
}

export function MaskEditor({ assets, previewUrls, initialMaskAssetId, onCancel, onSave }: MaskEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gestureRef = useRef<{ startX: number; startY: number; before?: ImageData } | null>(null);
  const sourceAssets = useMemo(() => assets.filter((asset) => asset.kind === "image" && asset.purpose !== "mask"), [assets]);
  const initialMask = assets.find((asset) => asset.id === initialMaskAssetId && asset.purpose === "mask");
  const [sourceAssetId, setSourceAssetId] = useState(initialMask?.sourceAssetId ?? sourceAssets[0]?.id ?? "");
  const [tool, setTool] = useState<MaskTool>("brush");
  const [brushSize, setBrushSize] = useState(48);
  const [hasMarks, setHasMarks] = useState(Boolean(initialMask));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const source = sourceAssets.find((asset) => asset.id === sourceAssetId);
  const sourceUrl = source ? previewUrls[source.id] : undefined;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;
    const scale = Math.min(1, 1600 / Math.max(source.width ?? 1200, source.height ?? 1200));
    canvas.width = Math.max(1, Math.round((source.width ?? 1200) * scale));
    canvas.height = Math.max(1, Math.round((source.height ?? 1200) * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const canRestore = initialMask?.sourceAssetId === source.id && previewUrls[initialMask.id];
    if (!canRestore) {
      setHasMarks(false);
      return;
    }
    const image = new Image();
    image.onload = () => {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      setHasMarks(true);
    };
    image.src = previewUrls[initialMask.id];
  }, [initialMask?.id, initialMask?.sourceAssetId, previewUrls, source]);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const configureBrush = (context: CanvasRenderingContext2D) => {
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = brushSize;
    context.strokeStyle = "#ffffff";
    context.fillStyle = "#ffffff";
    context.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.setPointerCapture(event.pointerId);
    const current = point(event);
    if (tool === "rectangle") {
      gestureRef.current = { startX: current.x, startY: current.y, before: context.getImageData(0, 0, canvas.width, canvas.height) };
    } else {
      configureBrush(context);
      context.beginPath();
      context.moveTo(current.x, current.y);
      context.lineTo(current.x + 0.01, current.y + 0.01);
      context.stroke();
      gestureRef.current = { startX: current.x, startY: current.y };
    }
    setHasMarks(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!gesture || !canvas || !context) return;
    const current = point(event);
    if (tool === "rectangle" && gesture.before) {
      context.globalCompositeOperation = "source-over";
      context.putImageData(gesture.before, 0, 0);
      context.fillStyle = "#ffffff";
      context.fillRect(gesture.startX, gesture.startY, current.x - gesture.startX, current.y - gesture.startY);
    } else {
      configureBrush(context);
      context.lineTo(current.x, current.y);
      context.stroke();
    }
  };

  const finishGesture = () => {
    gestureRef.current = null;
  };

  const clearMask = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    setHasMarks(false);
  };

  return createPortal(
    <section className="mask-editor-backdrop" role="dialog" aria-modal="true" aria-label="蒙版编辑器">
      <div className="mask-editor">
        <header>
          <div><span>可编辑区域蒙版</span><strong>白色区域允许 AI 修改，透明区域保持锁定</strong></div>
          <button aria-label="关闭蒙版编辑器" onClick={onCancel}>×</button>
        </header>
        {!sourceAssets.length ? (
          <p className="mask-empty">请先导入至少一张商品图片，再创建蒙版。</p>
        ) : (
          <>
            <div className="mask-toolbar">
              <label>底图<select aria-label="蒙版底图" value={sourceAssetId} onChange={(event) => setSourceAssetId(event.target.value)}>
                {sourceAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName}</option>)}
              </select></label>
              <div role="group" aria-label="蒙版工具">
                <button className={tool === "brush" ? "active" : ""} onClick={() => setTool("brush")}>画笔</button>
                <button className={tool === "rectangle" ? "active" : ""} onClick={() => setTool("rectangle")}>矩形</button>
                <button className={tool === "erase" ? "active" : ""} onClick={() => setTool("erase")}>橡皮</button>
              </div>
              <label>大小<input aria-label="画笔大小" type="range" min="8" max="180" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /></label>
              <button onClick={clearMask}>清空</button>
            </div>
            <div className="mask-stage" style={{ aspectRatio: `${source?.width ?? 1} / ${source?.height ?? 1}` }}>
              {sourceUrl ? <img src={sourceUrl} alt={source?.originalName ?? "蒙版底图"} /> : <span>正在载入底图预览…</span>}
              <canvas
                ref={canvasRef}
                aria-label="蒙版绘制画布"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={finishGesture}
                onPointerCancel={finishGesture}
              />
            </div>
            {error && <p className="mask-error" role="alert">{error}</p>}
            <footer>
              <small>每次保存都会创建新的蒙版资产版本，不会覆盖旧蒙版。</small>
              <div><button onClick={onCancel}>取消</button><button className="primary" disabled={!hasMarks || saving || !source} onClick={async () => {
                const canvas = canvasRef.current;
                if (!canvas || !source) return;
                setSaving(true);
                setError("");
                try {
                  const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
                  let containsMask = false;
                  if (pixels) {
                    for (let index = 3; index < pixels.length; index += 4) {
                      if (pixels[index] > 0) {
                        containsMask = true;
                        break;
                      }
                    }
                  }
                  if (!containsMask) throw new Error("蒙版为空，请先绘制允许修改的区域");
                  const blob = await canvasBlob(canvas);
                  await onSave(source.id, blob, canvas.width, canvas.height);
                } catch (saveError) {
                  setError(saveError instanceof Error ? saveError.message : "蒙版保存失败");
                } finally {
                  setSaving(false);
                }
              }}>{saving ? "正在保存…" : "保存蒙版版本"}</button></div>
            </footer>
          </>
        )}
      </div>
    </section>,
    document.body,
  );
}
