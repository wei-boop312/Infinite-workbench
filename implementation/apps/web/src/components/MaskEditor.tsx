import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { Asset } from "@canvas/contracts";

type MaskTool = "brush" | "rectangle" | "polygon" | "lasso" | "erase";
type Point = { x: number; y: number };
type Gesture = {
  kind: Exclude<MaskTool, "polygon">;
  start: Point;
  before: ImageData;
  points?: Point[];
};

const HISTORY_LIMIT = 8;

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

function canvasHasMarks(canvas: HTMLCanvasElement): boolean {
  const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
  if (!pixels) return false;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) return true;
  }
  return false;
}

function drawClosedShape(context: CanvasRenderingContext2D, points: Point[]): void {
  if (points.length < 3) return;
  context.save();
  context.globalCompositeOperation = "source-over";
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  context.closePath();
  context.fill();
  context.restore();
}

export function MaskEditor({ assets, previewUrls, initialMaskAssetId, onCancel, onSave }: MaskEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const polygonRef = useRef<{ before: ImageData; points: Point[] } | null>(null);
  const undoRef = useRef<ImageData[]>([]);
  const redoRef = useRef<ImageData[]>([]);
  const sourceAssets = useMemo(() => assets.filter((asset) => asset.kind === "image" && asset.purpose !== "mask"), [assets]);
  const initialMask = assets.find((asset) => asset.id === initialMaskAssetId && asset.purpose === "mask");
  const [sourceAssetId, setSourceAssetId] = useState(initialMask?.sourceAssetId ?? sourceAssets[0]?.id ?? "");
  const [tool, setTool] = useState<MaskTool>("brush");
  const [brushSize, setBrushSize] = useState(48);
  const [hasMarks, setHasMarks] = useState(Boolean(initialMask));
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 });
  const [polygonPointCount, setPolygonPointCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const source = sourceAssets.find((asset) => asset.id === sourceAssetId);
  const sourceUrl = source ? previewUrls[source.id] : undefined;

  const updateHistoryState = useCallback(() => {
    setHistoryState({ undo: undoRef.current.length, redo: redoRef.current.length });
  }, []);

  const resetHistory = useCallback(() => {
    undoRef.current = [];
    redoRef.current = [];
    gestureRef.current = null;
    polygonRef.current = null;
    setPolygonPointCount(0);
    updateHistoryState();
  }, [updateHistoryState]);

  const syncHasMarks = useCallback(() => {
    const canvas = canvasRef.current;
    setHasMarks(Boolean(canvas && canvasHasMarks(canvas)));
  }, []);

  const commitChange = useCallback((before: ImageData) => {
    undoRef.current = [...undoRef.current.slice(-(HISTORY_LIMIT - 1)), before];
    redoRef.current = [];
    updateHistoryState();
    syncHasMarks();
  }, [syncHasMarks, updateHistoryState]);

  const cancelPolygon = useCallback(() => {
    const canvas = canvasRef.current;
    const polygon = polygonRef.current;
    const context = canvas?.getContext("2d");
    if (context && polygon) context.putImageData(polygon.before, 0, 0);
    polygonRef.current = null;
    setPolygonPointCount(0);
    syncHasMarks();
  }, [syncHasMarks]);

  const finishPolygon = useCallback(() => {
    const canvas = canvasRef.current;
    const polygon = polygonRef.current;
    const context = canvas?.getContext("2d");
    if (!context || !polygon || polygon.points.length < 3) return;
    context.putImageData(polygon.before, 0, 0);
    drawClosedShape(context, polygon.points);
    polygonRef.current = null;
    setPolygonPointCount(0);
    commitChange(polygon.before);
  }, [commitChange]);

  const undo = useCallback(() => {
    if (polygonRef.current) {
      cancelPolygon();
      return;
    }
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const previous = undoRef.current.pop();
    if (!canvas || !context || !previous) return;
    redoRef.current.push(context.getImageData(0, 0, canvas.width, canvas.height));
    context.putImageData(previous, 0, 0);
    updateHistoryState();
    syncHasMarks();
  }, [cancelPolygon, syncHasMarks, updateHistoryState]);

  const redo = useCallback(() => {
    cancelPolygon();
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const next = redoRef.current.pop();
    if (!canvas || !context || !next) return;
    undoRef.current.push(context.getImageData(0, 0, canvas.width, canvas.height));
    context.putImageData(next, 0, 0);
    updateHistoryState();
    syncHasMarks();
  }, [cancelPolygon, syncHasMarks, updateHistoryState]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;
    const scale = Math.min(1, 1600 / Math.max(source.width ?? 1200, source.height ?? 1200));
    canvas.width = Math.max(1, Math.round((source.width ?? 1200) * scale));
    canvas.height = Math.max(1, Math.round((source.height ?? 1200) * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    resetHistory();
    const canRestore = initialMask?.sourceAssetId === source.id && previewUrls[initialMask.id];
    if (!canRestore) {
      setHasMarks(false);
      return;
    }
    const image = new Image();
    image.onload = () => {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      setHasMarks(true);
      resetHistory();
    };
    image.src = previewUrls[initialMask.id];
  }, [initialMask?.id, initialMask?.sourceAssetId, previewUrls, resetHistory, source]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && (key === "z" || key === "y")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if ((key === "z" && event.shiftKey) || key === "y") redo();
        else undo();
      } else if (event.key === "Enter" && polygonRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finishPolygon();
      } else if (event.key === "Escape" && polygonRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelPolygon();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancelPolygon, finishPolygon, redo, undo]);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const configureBrush = (context: CanvasRenderingContext2D, activeTool = tool) => {
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = activeTool === "lasso" ? Math.max(2, brushSize / 10) : brushSize;
    context.strokeStyle = "#ffffff";
    context.fillStyle = "#ffffff";
    context.globalCompositeOperation = activeTool === "erase" ? "destination-out" : "source-over";
  };

  const renderPolygonPreview = () => {
    const canvas = canvasRef.current;
    const polygon = polygonRef.current;
    const context = canvas?.getContext("2d");
    if (!context || !polygon || !canvas) return;
    context.putImageData(polygon.before, 0, 0);
    context.save();
    context.globalCompositeOperation = "source-over";
    context.strokeStyle = "#ffffff";
    context.fillStyle = "#ffffff";
    context.lineWidth = Math.max(2, canvas.width / 400);
    context.beginPath();
    context.moveTo(polygon.points[0].x, polygon.points[0].y);
    for (const item of polygon.points.slice(1)) context.lineTo(item.x, item.y);
    context.stroke();
    for (const item of polygon.points) {
      context.beginPath();
      context.arc(item.x, item.y, Math.max(3, canvas.width / 260), 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const current = point(event);
    if (tool === "polygon") {
      if (!polygonRef.current) {
        polygonRef.current = {
          before: context.getImageData(0, 0, canvas.width, canvas.height),
          points: [current],
        };
      } else {
        polygonRef.current.points.push(current);
      }
      setPolygonPointCount(polygonRef.current.points.length);
      renderPolygonPreview();
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    const before = context.getImageData(0, 0, canvas.width, canvas.height);
    gestureRef.current = {
      kind: tool,
      start: current,
      before,
      points: tool === "lasso" ? [current] : undefined,
    };
    if (tool === "rectangle") return;
    configureBrush(context);
    context.beginPath();
    context.moveTo(current.x, current.y);
    context.lineTo(current.x + 0.01, current.y + 0.01);
    context.stroke();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!gesture || !canvas || !context) return;
    const current = point(event);
    if (gesture.kind === "rectangle") {
      context.putImageData(gesture.before, 0, 0);
      context.save();
      context.globalCompositeOperation = "source-over";
      context.fillStyle = "#ffffff";
      context.fillRect(gesture.start.x, gesture.start.y, current.x - gesture.start.x, current.y - gesture.start.y);
      context.restore();
    } else {
      configureBrush(context, gesture.kind);
      context.lineTo(current.x, current.y);
      context.stroke();
      if (gesture.kind === "lasso") gesture.points?.push(current);
    }
  };

  const finishGesture = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!gesture || !canvas || !context) return;
    if (gesture.kind === "lasso") {
      context.putImageData(gesture.before, 0, 0);
      drawClosedShape(context, gesture.points ?? []);
    }
    gestureRef.current = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    commitChange(gesture.before);
  };

  const cancelGesture = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (gesture && context) context.putImageData(gesture.before, 0, 0);
    gestureRef.current = null;
    if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    syncHasMarks();
  };

  const selectTool = (next: MaskTool) => {
    if (polygonRef.current) cancelPolygon();
    setTool(next);
  };

  const clearMask = () => {
    cancelPolygon();
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !canvasHasMarks(canvas)) return;
    const before = context.getImageData(0, 0, canvas.width, canvas.height);
    context.clearRect(0, 0, canvas.width, canvas.height);
    commitChange(before);
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
                <button className={tool === "brush" ? "active" : ""} onClick={() => selectTool("brush")}>画笔</button>
                <button className={tool === "rectangle" ? "active" : ""} onClick={() => selectTool("rectangle")}>矩形</button>
                <button className={tool === "polygon" ? "active" : ""} onClick={() => selectTool("polygon")}>多边形</button>
                <button className={tool === "lasso" ? "active" : ""} onClick={() => selectTool("lasso")}>套索</button>
                <button className={tool === "erase" ? "active" : ""} onClick={() => selectTool("erase")}>橡皮</button>
              </div>
              <label>大小<input aria-label="画笔大小" type="range" min="8" max="180" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /></label>
              <div role="group" aria-label="蒙版历史">
                <button aria-label="撤销蒙版" disabled={!historyState.undo} onClick={undo}>撤销</button>
                <button aria-label="重做蒙版" disabled={!historyState.redo} onClick={redo}>重做</button>
              </div>
              <button onClick={clearMask}>清空</button>
            </div>
            {tool === "polygon" && (
              <div className="polygon-actions">
                <span>{polygonPointCount ? "已放置 " + polygonPointCount + " 个点" : "点击画布放置顶点，至少 3 个点"}</span>
                <button disabled={polygonPointCount < 3} onClick={finishPolygon}>完成多边形</button>
                <button disabled={!polygonPointCount} onClick={cancelPolygon}>取消路径</button>
              </div>
            )}
            <div className="mask-stage" style={{ aspectRatio: String(source?.width ?? 1) + " / " + String(source?.height ?? 1) }}>
              {sourceUrl ? <img src={sourceUrl} alt={source?.originalName ?? "蒙版底图"} /> : <span>正在载入底图预览…</span>}
              <canvas
                ref={canvasRef}
                aria-label="蒙版绘制画布"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={finishGesture}
                onPointerCancel={cancelGesture}
              />
            </div>
            {error && <p className="mask-error" role="alert">{error}</p>}
            <footer>
              <small>支持 Ctrl/⌘+Z 撤销；每次保存都会创建新蒙版版本，不覆盖历史资产。</small>
              <div><button onClick={onCancel}>取消</button><button className="primary" disabled={!hasMarks || saving || !source || Boolean(polygonPointCount)} onClick={async () => {
                const canvas = canvasRef.current;
                if (!canvas || !source) return;
                setSaving(true);
                setError("");
                try {
                  if (!canvasHasMarks(canvas)) throw new Error("蒙版为空，请先绘制允许修改的区域");
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
