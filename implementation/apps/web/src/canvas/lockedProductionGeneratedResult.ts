import { ConstraintSnapshotSchema, LockedProductionGeneratedAssetLineageSchema, type Asset, type ConstraintSnapshot, type LockedProductionGeneratedAssetLineage } from "@canvas/contracts";
import { parseLockedProductionCanvasHistory, type LockedProductionCanvasHistory } from "@canvas/canvas-schema/light";
import { createAssetNode, type CanvasSnapshot, type CanvasNode, type CanvasEdge } from "./model";

// Pure history builder, NOT a permission/cache validator. The live controller
// must freshly read the server and the joint output/input IDB snapshot first.
export function buildLockedProductionResultGraph(current: CanvasSnapshot, input: LockedProductionGeneratedAssetLineage, projectId: string,
  assets: Asset[], constraints: ConstraintSnapshot[], position: { x: number; y: number }): CanvasSnapshot {
  const v = LockedProductionGeneratedAssetLineageSchema.parse(input), d = v.requestDraft, image = v.image.asset;
  if (projectId !== v.projectId || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error("保护生产回流项目或位置错配。");
  const c = constraints.filter(c => c.id === v.constraint.id && c.projectId === projectId);
  if (c.length !== 1 || JSON.stringify(ConstraintSnapshotSchema.parse(c[0])) !== JSON.stringify(v.constraint)) throw new Error("原完整人工约束在本项目中缺失或漂移。");
  const refs = [...d.inputs, ...(d.operation === "edit" && d.mask ? [d.mask] : [])];
  const sources = refs.map((ref, index) => {
    const matches = assets.filter(a => a.id === ref.assetId && a.projectId === projectId), a = matches[0];
    if (matches.length !== 1 || a.kind !== "image" || a.contentFingerprint !== `sha256:${ref.checksumSha256}` || a.width !== ref.width
      || a.height !== ref.height || a.byteSize !== ref.byteSize || a.mimeType !== ref.mimeType
      || (index === d.inputs.length ? a.purpose !== "mask" || a.sourceAssetId !== d.inputs[0]?.assetId : a.purpose === "mask")) throw new Error("原输入/蒙版順序、元数据或来源错配。");
    return a;
  });
  const outputs = assets.filter(a => a.id === image.id);
  if (outputs.length !== 1 || JSON.stringify(outputs[0]) !== JSON.stringify(image)) throw new Error("原产物元信息错配。");
  const h = parseLockedProductionCanvasHistory({ version: 2, evidence: `${v.mode}-locked-history`, mode: v.mode, tenantId: v.tenantId, originProjectId: projectId,
    batchId: v.batchId, jobId: v.jobId, assetId: image.id, inputAssetIds: refs.map(r => r.assetId), inputChecksums: refs.map(r => r.checksumSha256),
    constraintSnapshotId: v.constraint.id, constraintChecksumSha256: d.constraintChecksumSha256, protocol: v.connection.protocol,
    connectionId: d.connectionId, connectionRevision: d.connectionRevision, model: d.model, capabilityVersion: d.capabilityVersion, preparationId: v.preparationId,
    protection: v.protection, protectedSourceAssetId: v.protection.source.assetId, protectedMaskAssetId: v.protection.mask.assetId,
    artifactFingerprint: v.artifactFingerprint, preparationFingerprint: v.preparationFingerprint, pricingFingerprint: v.pricingFingerprint, executionFingerprint: v.executionFingerprint,
    requestFingerprint: v.requestFingerprint, payloadChecksumSha256: v.payloadChecksumSha256, checksumSha256: v.image.checksumSha256,
    confirmedBy: v.confirmedBy, confirmedAt: v.confirmedAt, currency: v.billing.currency, estimateState: v.billing.estimatedMinor === null ? "unknown" : "known",
    estimatedCostMinor: v.billing.estimatedMinor, maxCostMinor: v.billing.maxCostMinor, currentMaxCostMinor: v.billing.currentMaxCostMinor,
    billingState: v.billing.state, reservedMinor: v.billing.reservedMinor, ...(v.billing.actualMinor === undefined ? {} : { actualMinor: v.billing.actualMinor }), observedAt: new Date().toISOString() });
  const frozen = (h: LockedProductionCanvasHistory) => { const { billingState: _s, reservedMinor: _r, actualMinor: _a, currentMaxCostMinor: _m, observedAt: _o, ...f } = h; return JSON.stringify(f); };
  const prefix = `locked-production-result-${v.jobId}`, outputId = `${prefix}-output`, toolId = `${prefix}-tool`, constraintId = `${prefix}-constraint`;
  const existing = current.nodes.find(n => n.id === outputId);
  if (existing) {
    if (existing.type !== "studio" || existing.data.kind !== "output" || existing.data.generatedHistory || existing.data.productionGeneratedHistory || !existing.data.lockedProductionGeneratedHistory
      || frozen(parseLockedProductionCanvasHistory(existing.data.lockedProductionGeneratedHistory)) !== frozen(h)
      || existing.data.assetId !== image.id || existing.data.runJobId !== v.jobId || existing.data.runBatchId !== v.batchId || existing.data.constraintSnapshotId !== v.constraint.id) throw new Error("保护生产结果编号被占用或历史冲突。");
  }
  const additions: CanvasNode[] = sources.map((a, i) => {
    const n = createAssetNode(a, { x: position.x, y: position.y + i * 205 });
    return { ...n, id: `${prefix}-input-${i}`, selected: false, data: { ...n.data, title: a.originalName.slice(0, 240), badge: `原保护生产输入 ${i + 1}` } };
  });
  additions.push({ id: constraintId, type: "studio", position: { x: position.x, y: position.y + sources.length * 205 },
    data: { kind: "constraint", title: "原保护生产人工约束", subtitle: "冻结历史 · 非新执行授权", accent: "#f59e0b", constraintSnapshotId: v.constraint.id }, style: { width: 240, height: 168 } },
  { id: toolId, type: "studio", position: { x: position.x + 310, y: position.y },
    data: { kind: "action", title: "已确认保护生产图片任务", subtitle: `${v.connection.protocol} · ${d.model}`, badge: v.mode === "production" ? "保护生产历史" : "自有合同夹具历史", accent: "#a78bfa", runJobId: v.jobId, runBatchId: v.batchId, constraintSnapshotId: v.constraint.id }, style: { width: 250, height: 180 } },
  { id: outputId, type: "studio", position: { x: position.x + 660, y: position.y }, selected: true,
    data: { kind: "output", title: "已验证保护生产图片结果", subtitle: `${image.width}×${image.height} · ${h.currency} · ${h.billingState === "unknown" ? "费用未知" : "人工已核账"}`,
      badge: v.mode === "production" ? "保护生产原图历史" : "自有合同夹具原图", accent: "#34d399", assetId: image.id, constraintSnapshotId: v.constraint.id, runJobId: v.jobId, runBatchId: v.batchId, lockedProductionGeneratedHistory: h }, style: { width: 260, height: 220 } });
  const edge = (source: string, target: string, targetHandle: string): CanvasEdge => ({ id: `${prefix}-edge-${source.slice(prefix.length + 1)}-${target.slice(prefix.length + 1)}`, source, target, sourceHandle: "output", targetHandle,
    type: "smoothstep", deletable: false, selectable: false, className: "edge-lineage", data: { kind: "lineage", runJobId: v.jobId } });
  const additionsE = [...sources.map((_, i) => edge(`${prefix}-input-${i}`, toolId, "product")), edge(constraintId, toolId, "constraint"), edge(toolId, outputId, "input")];
  const missingN = additions.filter(n => {
    const old = current.nodes.find(o => o.id === n.id); if (!old) return true;
    if (old === existing) return false; // Its independent immutable history was checked above.
    if (old.type !== "studio" || n.type !== "studio" || old.data.kind !== n.data.kind || old.data.generatedHistory || old.data.productionGeneratedHistory || old.data.lockedProductionGeneratedHistory
      || ["assetId", "constraintSnapshotId", "runJobId", "runBatchId"].some(k => old.data[k as keyof typeof old.data] !== n.data[k as keyof typeof n.data])) throw new Error("保护生产来源节点关系冲突。");
    return false;
  });
  const missingE = additionsE.filter(e => {
    const old = current.edges.find(o => o.id === e.id); if (!old) return true;
    if (old.source !== e.source || old.target !== e.target || old.sourceHandle !== e.sourceHandle || old.targetHandle !== e.targetHandle
      || old.data?.kind !== "lineage" || old.data.runJobId !== v.jobId || old.deletable !== false || old.selectable !== false) throw new Error("保护生产系统连线冲突。");
    return false;
  });
  // A repeat does not repair deliberately removed visual sources or overwrite
  // the old fee observation, but existing same-ID relationships must still match.
  if (existing) return current;
  if (current.nodes.length + missingN.length > 10_000 || current.edges.length + missingE.length > 20_000 || additions.some(n => n.id.length > 160) || additionsE.some(e => e.id.length > 160)) throw new Error("保护生产回流容量或编号超限；未部分提交。");
  return { nodes: [...current.nodes.map(n => ({ ...n, selected: false })), ...missingN.map(n => ({ ...n, initialWidth: Number(n.style?.width), initialHeight: Number(n.style?.height) }))], edges: [...current.edges, ...missingE] };
}
