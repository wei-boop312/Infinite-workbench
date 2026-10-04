import { GeneratedAssetLineageSchema, ConstraintSnapshotSchema, type Asset, type ConstraintSnapshot, type GeneratedAssetLineage } from "@canvas/contracts";
import { parseGeneratedCanvasHistory } from "@canvas/canvas-schema/light";
import { assertGeneratedReceipt } from "../assets/generatedAssetPolicy";
import { createAssetNode, type CanvasNode, type CanvasEdge, type CanvasSnapshot } from "./model";

// Caller obtains a fresh server lineage and validates the consistent local cache.
// This pure builder cannot itself grant permission, download or execute a task.
export function buildGeneratedResultGraph(current: CanvasSnapshot, value: GeneratedAssetLineage, projectId: string,
  assets: Asset[], constraints: ConstraintSnapshot[], position: { x: number; y: number }): CanvasSnapshot {
  const view = GeneratedAssetLineageSchema.parse(value), image = view.image.asset;
  assertGeneratedReceipt(view.image, projectId, image.id);
  if (view.projectId !== projectId || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error("图片回画布项目或位置错配。");
  const localConstraint = constraints.filter(c => c.id === view.constraint.id && c.projectId === projectId);
  if (localConstraint.length !== 1 || JSON.stringify(ConstraintSnapshotSchema.parse(localConstraint[0])) !== JSON.stringify(view.constraint)) throw new Error("原冻结约束在当前项目中缺失或漂移，不能用现值代替。");
  const inputs = [...view.requestTemplate.inputs, ...(view.requestTemplate.operation === "edit" && view.requestTemplate.mask ? [view.requestTemplate.mask] : [])];
  const sourceAssets = inputs.map(ref => {
    const matches = assets.filter(a => a.id === ref.assetId && a.projectId === projectId);
    const a = matches[0];
    if (matches.length !== 1 || a.kind !== "image" || a.contentFingerprint !== `sha256:${ref.checksumSha256}`
      || a.mimeType !== ref.mimeType || a.byteSize !== ref.byteSize || a.width !== ref.width || a.height !== ref.height) throw new Error("原输入/蒙版元数据缺失或错配，不能伪造来源节点。");
    return a;
  });
  const history = parseGeneratedCanvasHistory({ version: 1, evidence: "local-fixture-history", originProjectId: projectId,
    batchId: view.batchId, jobId: view.jobId, assetId: image.id, inputAssetIds: inputs.map(ref => ref.assetId), constraintSnapshotId: view.constraint.id,
    protocol: view.protocol, connectionId: view.requestTemplate.connectionId, connectionRevision: view.requestTemplate.connectionRevision,
    model: view.requestTemplate.model, capabilityVersion: view.requestTemplate.capabilityVersion, preparationId: view.preparationId,
    generatedRecordFingerprint: view.generatedRecordFingerprint, requestFingerprint: view.requestFingerprint, checksumSha256: view.image.checksumSha256,
    confirmedBy: view.confirmedBy, confirmedAt: view.confirmedAt, currency: view.billing.currency,
    estimatedCostMinor: view.pricing.quote.estimatedCostMinor, maxCostMinor: view.pricing.quote.maxCostMinor,
    billingState: view.billing.state, reservedMinor: view.billing.reservedMinor, ...(view.billing.actualMinor === undefined ? {} : { actualMinor: view.billing.actualMinor }), observedAt: new Date().toISOString() });
  const prefix = `image-result-${view.jobId}`, outputId = `${prefix}-output`, toolId = `${prefix}-tool`, constraintId = `${prefix}-constraint`;
  const existing = current.nodes.find(node => node.id === outputId);
  if (existing) {
    const sameOrigin = (h: ReturnType<typeof parseGeneratedCanvasHistory>) => { const { billingState: _state, reservedMinor: _reserved, actualMinor: _actual, observedAt: _observed, ...frozen } = h; return JSON.stringify(frozen); };
    if (existing.type !== "studio" || !existing.data.generatedHistory || sameOrigin(parseGeneratedCanvasHistory(existing.data.generatedHistory)) !== sameOrigin(history)
      || existing.data.assetId !== image.id || existing.data.runJobId !== view.jobId || existing.data.runBatchId !== view.batchId
      || existing.data.constraintSnapshotId !== view.constraint.id) throw new Error("生成结果节点编号已占用或历史错配。");
    return current; // Preserve the historical fee observation; do not silently rewrite it.
  }
  const additions: CanvasNode[] = sourceAssets.map((a, index) => {
    const node = createAssetNode(a, { x: position.x, y: position.y + index * 205 });
    return { ...node, id: `${prefix}-input-${index}`, selected: false, data: { ...node.data, title: a.originalName.slice(0, 240), badge: `原冻结输入 ${index + 1}` } };
  });
  additions.push({ id: constraintId, type: "studio", position: { x: position.x, y: position.y + sourceAssets.length * 205 },
    data: { kind: "constraint", title: "原冻结人工约束", subtitle: "历史引用 · 不构成新执行授权", accent: "#f59e0b", constraintSnapshotId: view.constraint.id }, style: { width: 240, height: 168 } },
  { id: toolId, type: "studio", position: { x: position.x + 310, y: position.y }, data: { kind: "action", title: "已确认图片任务", subtitle: `${view.protocol} · ${view.requestTemplate.model}`, badge: "本地假响应历史", accent: "#a78bfa", runJobId: view.jobId, runBatchId: view.batchId, constraintSnapshotId: view.constraint.id }, style: { width: 250, height: 180 } },
  { id: outputId, type: "studio", position: { x: position.x + 660, y: position.y }, selected: true,
    data: { kind: "output", title: "已验证图片结果", subtitle: `${image.width}×${image.height} · ${view.billing.currency} · ${view.billing.state === "unknown" ? "费用未知" : "人工已核账"}`,
      badge: "本地假响应原图", accent: "#34d399", assetId: image.id, constraintSnapshotId: view.constraint.id, runJobId: view.jobId, runBatchId: view.batchId, generatedHistory: history }, style: { width: 260, height: 220 } });
  const lineage = (source: string, target: string, targetHandle: string): CanvasEdge => ({ id: `${source}-to-${target}`, source, target, sourceHandle: "output", targetHandle,
    type: "smoothstep", deletable: false, selectable: false, className: "edge-lineage", data: { kind: "lineage", runJobId: view.jobId } });
  const addedEdges = [...sourceAssets.map((_, i) => lineage(`${prefix}-input-${i}`, toolId, "product")), lineage(constraintId, toolId, "constraint"), lineage(toolId, outputId, "input")];
  const missingNodes = additions.filter(n => {
    const old = current.nodes.find(o => o.id === n.id);
    if (!old) return true;
    if (old.type !== "studio" || n.type !== "studio" || old.data.kind !== n.data.kind
      || ["assetId", "constraintSnapshotId", "runJobId", "runBatchId"].some(k => old.data[k as keyof typeof old.data] !== n.data[k as keyof typeof n.data])) throw new Error("既有来源节点与冻结关系冲突。");
    return false;
  });
  const missingEdges = addedEdges.filter(e => {
    const old = current.edges.find(o => o.id === e.id);
    if (!old) return true;
    if (old.source !== e.source || old.target !== e.target || old.sourceHandle !== e.sourceHandle || old.targetHandle !== e.targetHandle
      || old.data?.kind !== "lineage" || old.data.runJobId !== view.jobId || old.deletable !== false || old.selectable !== false) throw new Error("既有谱系连线与冻结关系冲突。");
    return false;
  });
  if (current.nodes.length + missingNodes.length > 10_000 || current.edges.length + missingEdges.length > 20_000
    || additions.some(n => n.id.length > 160) || addedEdges.some(e => e.id.length > 160)) throw new Error("画布容量不足或生成谱系编号冲突；没有添加部分节点。");
  return { nodes: [...current.nodes.map(n => ({ ...n, selected: false })), ...missingNodes.map(n => ({ ...n, initialWidth: Number(n.style?.width), initialHeight: Number(n.style?.height) }))], edges: [...current.edges, ...missingEdges] };
}
