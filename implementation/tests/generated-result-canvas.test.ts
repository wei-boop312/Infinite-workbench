import { describe, expect, it } from "vitest";
import { GeneratedAssetLineageSchema, type Asset } from "../packages/contracts/src/index";
import { migrateCanvasDocument } from "../packages/canvas-schema/src/index";
import { migrateCanvasDocumentLight, parseGeneratedCanvasHistory } from "../packages/canvas-schema/src/light";
import { fixturePublicPreparation, fixturePublicConfirmation } from "./fixtures/image-preparation";
import { buildGeneratedResultGraph } from "../apps/web/src/canvas/generatedResult";
import { documentToSnapshot, snapshotToDocument } from "../apps/web/src/canvas/document";
import { createHistoryState, historyReducer } from "../apps/web/src/canvas/history";
import { createProjectPackage, parseProjectPackage, remapProjectPackage } from "../apps/web/src/projects/projectPackage";
import type { CanvasSnapshot, StudioNode } from "../apps/web/src/canvas/model";

// Pure portable/history fixtures, not server authorization or production output.
function fixture(edit = false) {
  const p = fixturePublicPreparation(), c = fixturePublicConfirmation(p), sum = "d".repeat(64);
  const source: Asset = { id: "source", projectId: "project-a", kind: "image", purpose: "source", originalName: "source.png", storageKey: "local:source",
    contentFingerprint: `sha256:${"c".repeat(64)}`, mimeType: "image/png", byteSize: 4, width: 1, height: 1, createdAt: p.createdAt };
  const mask: Asset = { ...source, id: "mask", purpose: "mask", sourceAssetId: source.id, originalName: "mask.png" };
  const ref = (a: Asset) => ({ assetId: a.id, checksumSha256: "c".repeat(64), mimeType: "image/png" as const, byteSize: 4, width: 1, height: 1 });
  const request = edit ? { ...p.requestTemplate, operation: "edit", inputs: [ref(source)], mask: ref(mask) } : p.requestTemplate;
  const view = GeneratedAssetLineageSchema.parse({ schemaVersion: 1, mode: "local-fixture", realExecutionEnabled: false, tenantId: "local-studio", projectId: "project-a",
    batchId: "batch-a", jobId: "job-a", jobStatus: "billing_unknown", protocol: "openai", connectionName: p.connection.name,
    requestTemplate: request, constraint: p.constraint, pricing: p.pricing, preparationId: p.id, preparationFingerprint: p.snapshotFingerprint,
    executionFingerprint: c.executionFingerprint, requestFingerprint: c.requestFingerprint, payloadChecksumSha256: c.payloadChecksumSha256,
    generatedRecordFingerprint: "b".repeat(64), transformedInputs: edit ? [source, mask].map((a, i) => ({ assetId: a.id, originalChecksumSha256: "c".repeat(64),
      transmittedChecksumSha256: "9".repeat(64), transform: i ? "internal-white-to-transparent-mask-v1" : "exif-srgb-png-v1" })) : [], confirmedBy: c.confirmedBy, confirmedAt: c.confirmedAt,
    image: { schemaVersion: 1, id: "receipt", tenantId: "local-studio", registeredMetadataSha256: "c".repeat(64), checksumSha256: sum, decoder: "sharp-full-decode-v1", verifiedBy: "fixture-designer", verifiedAt: p.createdAt,
      asset: { id: "actual-output", projectId: "project-a", kind: "image", purpose: "generated", originalName: "output.png", contentFingerprint: `sha256:${sum}`,
        storageKey: "local-verified:immutable", mimeType: "image/png", byteSize: 8, width: 1024, height: 1024, createdAt: p.createdAt, ...(edit ? { sourceAssetId: source.id } : {}) } },
    billing: { state: "unknown", currency: "CNY", reservedMinor: 30, batchMaxCostMinor: 30 } });
  const empty: CanvasSnapshot = { nodes: [], edges: [] }, assets = [...(edit ? [source, mask] : []), view.image.asset], constraints = [view.constraint];
  const build = (current = empty) => buildGeneratedResultGraph(current, view, "project-a", assets, constraints, { x: 0, y: 0 });
  return { view, assets, constraints, empty, build };
}
const doc = (snapshot: CanvasSnapshot) => snapshotToDocument("canvas-a", "project-a", 2, snapshot, { x: 0, y: 0, zoom: 1 });
const output = (snapshot: CanvasSnapshot) => snapshot.nodes.find(n => n.type === "studio" && n.data.generatedHistory)! as StudioNode;
describe("受控生成结果画布与可移植历史", () => {
  it("实际assetId与冻结约束/模型/确认/未知费用关系保留，不保存媒体或执行密钥", () => {
    const f = fixture(), graph = f.build(); expect(graph.nodes).toHaveLength(3); expect(graph.edges).toHaveLength(2);
    expect(output(graph).data).toMatchObject({ kind: "output", assetId: "actual-output", runJobId: "job-a", constraintSnapshotId: "constraint-a", generatedHistory: {
      evidence: "local-fixture-history", model: "explicit-fixture-model", confirmedBy: "fixture-designer", currency: "CNY", maxCostMinor: 30, billingState: "unknown", reservedMinor: 30 } });
    expect(graph.edges.every(e => e.data?.kind === "lineage" && e.deletable === false && e.selectable === false)).toBe(true);
    expect(JSON.stringify(doc(graph))).not.toMatch(/base64|blob:|https:|credentialRef|idempotencyKey|leaseId|local-verified/);
    expect(f.empty).toEqual({ nodes: [], edges: [] });
  });
  it("编辑与蒙版按原顺序建立只读来源，引用原约束而非当前表单", () => {
    const f = fixture(true), graph = f.build(); expect(graph.nodes).toHaveLength(5); expect(graph.edges).toHaveLength(4);
    expect(output(graph).data.generatedHistory?.inputAssetIds).toEqual(["source", "mask"]);
    expect(graph.nodes.filter(n => n.type === "studio" && n.id.includes("-input-")).map(n => n.data.assetId)).toEqual(["source", "mask"]);
  });
  it.each(["project", "constraint-missing", "constraint-drift", "constraint-duplicate", "input-missing", "input-checksum", "input-size", "input-duplicate"])("%s 错配整份拒绝不产生半个图", damage => {
    const f = fixture(true); let project = "project-a";
    if (damage === "project") project = "foreign";
    if (damage === "constraint-missing") f.constraints.length = 0;
    if (damage === "constraint-drift") f.constraints[0] = { ...f.constraints[0], brandRules: { tone: "current-form" } };
    if (damage === "constraint-duplicate") f.constraints.push(f.constraints[0]);
    if (damage === "input-missing") f.assets.splice(0, 1);
    if (damage === "input-checksum") f.assets[0].contentFingerprint = `sha256:${"a".repeat(64)}`;
    if (damage === "input-size") f.assets[0].width = 2;
    if (damage === "input-duplicate") f.assets.push(f.assets[0]);
    expect(() => buildGeneratedResultGraph(f.empty, f.view, project, f.assets, f.constraints, { x: 0, y: 0 })).toThrow(); expect(f.empty.nodes).toEqual([]);
  });
  it("重复回画布不新增节点或覆写核验时费用；之后结账仍为历史观察", () => {
    const f = fixture(), graph = f.build(); expect(f.build(graph)).toBe(graph);
    f.view.billing = { state: "settled", currency: "CNY", reservedMinor: 0, batchMaxCostMinor: 30, actualMinor: 27 }; f.view.jobStatus = "succeeded";
    expect(f.build(graph)).toBe(graph); expect(output(graph).data.generatedHistory?.billingState).toBe("unknown");
  });
  it("删除单个输出后能受控补回，不重复来源节点；编号冒用失败关闭", () => {
    const f = fixture(), graph = f.build(), removed = { nodes: graph.nodes.filter(n => !n.id.endsWith("-output")), edges: graph.edges.filter(e => !e.target.endsWith("-output")) };
    const restored = f.build(removed); expect(restored.nodes).toHaveLength(3); expect(restored.edges).toHaveLength(2);
    const corrupt = structuredClone(graph); output(corrupt).data.generatedHistory!.model = "other"; expect(() => f.build(corrupt)).toThrow();
    const corruptSource = structuredClone(removed); (corruptSource.nodes[0] as StudioNode).data.constraintSnapshotId = "other"; expect(() => f.build(corruptSource)).toThrow();
  });
  it("一次历史提交撤销整个关系，重做与双迁移/刷新保留完整历史", () => {
    const f = fixture(true), graph = f.build(); let state = historyReducer(createHistoryState(f.empty), { type: "commit", next: graph });
    state = historyReducer(state, { type: "undo" }); expect(state.present).toEqual(f.empty); state = historyReducer(state, { type: "redo" });
    const document = doc(state.present); expect(migrateCanvasDocument(document)).toEqual(migrateCanvasDocumentLight(document));
    expect(output(documentToSnapshot(document)).data.generatedHistory).toEqual(output(graph).data.generatedHistory);
  });
  it("容量或非法位置整份拒绝；初始尺寸令视口外结果可被可靠聚焦", () => {
    const f = fixture(), graph = f.build(); expect(graph.nodes.every(n => Number(n.initialWidth) > 0 && Number(n.initialHeight) > 0)).toBe(true);
    const full: CanvasSnapshot = { nodes: Array.from({ length: 10_000 }, (_, i) => ({ ...graph.nodes[0], id: `full-${i}` })), edges: [] };
    expect(() => f.build(full)).toThrow(/容量/); expect(full.nodes).toHaveLength(10_000);
    expect(() => buildGeneratedResultGraph(f.empty, f.view, "project-a", f.assets, f.constraints, { x: Infinity, y: 0 })).toThrow();
  });
  it.each(["extra-field", "reserve", "output", "scope", "input-list"])("%s 损坏历史两个文档路径都拒绝", damage => {
    const document = doc(fixture().build()), data = document.nodes.find(n => n.data.generatedHistory)!.data, history = data.generatedHistory as Record<string, unknown>;
    if (damage === "extra-field") history.credentialRef = "not-allowed"; if (damage === "reserve") history.reservedMinor = 0;
    if (damage === "output") history.assetId = "fake"; if (damage === "scope") history.originProjectId = "foreign";
    if (damage === "input-list") history.inputAssetIds = ["duplicate", "duplicate"];
    expect(() => migrateCanvasDocument(document)).toThrow(); expect(() => migrateCanvasDocumentLight(document)).toThrow();
  });
  it("项目包原文件与来源完整保留，副本重映射且明确不是新授权", async () => {
    const f = fixture(true), original = new Blob([new Uint8Array(8)], { type: "image/png" }), source = new Blob([new Uint8Array(4)], { type: "image/png" });
    const archive = await createProjectPackage({ projectName: "history", document: doc(f.build()), constraints: f.constraints, assets: f.assets }, async id => id === "actual-output" ? original : source);
    const parsed = await parseProjectPackage(archive), copy = remapProjectPackage(parsed, "copy-doc", "copy-project"), data = copy.document.nodes.find(n => n.data.generatedHistory)!.data;
    const history = parseGeneratedCanvasHistory(data.generatedHistory);
    expect(history.evidence).toBe("imported-copy-history"); expect(history.originProjectId).toBe("project-a"); expect(history.assetId).not.toBe("actual-output");
    expect(history.inputAssetIds.every(id => copy.assets.some(a => a.asset.id === id))).toBe(true); expect(history.constraintSnapshotId).toBe(copy.constraints[0].id);
    expect(data.badge).toBe("导入历史副本"); expect(history.checksumSha256).toBe(f.view.image.checksumSha256);
    const again = remapProjectPackage(copy, "copy-2-doc", "copy-2-project"); expect(parseGeneratedCanvasHistory(again.document.nodes.find(n => n.data.generatedHistory)!.data.generatedHistory).originProjectId).toBe("project-a");
    const broken = doc(f.build()); (broken.nodes.find(n => n.data.generatedHistory)!.data.generatedHistory as Record<string, unknown>).inputAssetIds = ["missing-source"];
    await expect(createProjectPackage({ projectName: "broken", document: broken, constraints: f.constraints, assets: f.assets }, async () => original)).rejects.toThrow();
  });
});
