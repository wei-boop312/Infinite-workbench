import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { type ProductionGeneratedAssetLineage } from "../packages/contracts/src/index";
import { migrateCanvasDocument } from "../packages/canvas-schema/src/index";
import { migrateCanvasDocumentLight, parseProductionCanvasHistory, parseGeneratedCanvasHistory } from "../packages/canvas-schema/src/light";
import { ownedProductionBillingTask } from "./helpers/production-billing-task-core";
import { ImageProductionGeneratedAssetReadHarness } from "../apps/api/src/productionGeneratedAssetReads";
import { principal } from "./helpers/image-task-fixture";
import { buildProductionResultGraph } from "../apps/web/src/canvas/productionGeneratedResult";
import { snapshotToDocument, documentToSnapshot } from "../apps/web/src/canvas/document";
import { historyReducer, createHistoryState } from "../apps/web/src/canvas/history";
import { createProjectPackage, parseProjectPackage, remapProjectPackage } from "../apps/web/src/projects/projectPackage";
import { ProductionGeneratedAssetClient } from "../apps/web/src/runs/productionGeneratedAssetClient";
import type { CanvasSnapshot, StudioNode } from "../apps/web/src/canvas/model";

let task: Awaited<ReturnType<typeof ownedProductionBillingTask>>, view: ProductionGeneratedAssetLineage;
const own: typeof task[] = [], empty: CanvasSnapshot = { nodes: [], edges: [] };
const read = (t: typeof task) => new ImageProductionGeneratedAssetReadHarness({ generatedReadEnabled: true, tenantId: principal.tenantId, stateStore: t.f.store, runKernel: t.f.kernel, assetAuthorizer: t.auth, runAuthorizer: t.auth }).lineage(principal, "project-a", t.saved().productionImageArtifact!.image.asset.id);
beforeAll(async () => { task = await ownedProductionBillingTask({ edit: true, mask: true, twoInputs: true }); await task.artifacts.ingest(...task.args); view = read(task); });
afterAll(() => task?.f.cleanup()); afterEach(() => { vi.unstubAllGlobals(); for (const t of own.splice(0)) t.f.cleanup(); });
const assets = (t = task, v = view) => [...v.requestDraft.inputs, ...(v.requestDraft.operation === "edit" && v.requestDraft.mask ? [v.requestDraft.mask] : [])].map(r => t.f.store.loadVerifiedImage(principal.tenantId, "project-a", r.assetId)!.asset).concat(v.image.asset);
const build = (v = view, current = empty) => buildProductionResultGraph(current, v, "project-a", assets(task, v), [v.constraint], { x: 0, y: 0 });
const output = (s: CanvasSnapshot) => s.nodes.find(n => n.type === "studio" && n.data.productionGeneratedHistory)! as StudioNode;
const doc = (s: CanvasSnapshot) => snapshotToDocument("owned-doc", "project-a", 1, s, { x: 0, y: 0, zoom: 1 });
describe("6D9C independent production canvas history", () => {
  for (const protocol of ["openai", "openai-compatible", "google"] as const) for (const manual of [true, false]) it(`${protocol}/${manual} actual owned task graph known/unknown`, async () => {
    const t = await ownedProductionBillingTask({ protocol, manual, edit: true }); own.push(t); await t.artifacts.ingest(...t.args); const v = read(t), before = t.f.store.load();
    const graph = buildProductionResultGraph(empty, v, "project-a", assets(t, v), [v.constraint], { x: 0, y: 0 });
    expect(output(graph).data.productionGeneratedHistory).toMatchObject({ estimatedCostMinor: manual ? null : 25, estimateState: manual ? "unknown" : "known", maxCostMinor: 40, reservedMinor: 40, mode: "production-contract-fixture", evidence: "production-contract-fixture-history" });
    expect(output(graph).data.generatedHistory).toBeUndefined(); expect(() => parseGeneratedCanvasHistory(output(graph).data.productionGeneratedHistory)).toThrow();
    const document = doc(graph); expect(migrateCanvasDocument(document)).toEqual(migrateCanvasDocumentLight(document)); expect(t.f.store.load()).toEqual(before);
  });
  it("original multiple inputs and mask ordering, one undo/redo and exact refresh history", () => {
    const graph = build(); expect(output(graph).data.productionGeneratedHistory?.inputAssetIds).toEqual(["source", "source-2", "owned-mask"]);
    expect(graph.nodes).toHaveLength(6); expect(graph.edges).toHaveLength(5); expect(graph.edges.every(e => e.deletable === false && e.selectable === false)).toBe(true);
    let h = historyReducer(createHistoryState(empty), { type: "commit", next: graph }); expect(h.past).toHaveLength(1); h = historyReducer(h, { type: "undo" }); expect(h.present).toEqual(empty); h = historyReducer(h, { type: "redo" });
    expect(output(documentToSnapshot(migrateCanvasDocumentLight(doc(h.present)))).data.productionGeneratedHistory).toEqual(output(graph).data.productionGeneratedHistory);
    expect(JSON.stringify(doc(graph))).not.toMatch(/Base64|blob:|https:|credentialRef|wire|executionKey|idempotencyKey|leaseId/);
  });
  it("repeated return preserves old unknown observation after legitimate settlement", () => {
    const graph = build(), v = structuredClone(view); v.billing = { ...v.billing, state: "settled", currentMaxCostMinor: 50, actualMinor: 49, reservedMinor: 0 }; v.jobStatus = "succeeded";
    expect(build(v, graph)).toBe(graph); expect(output(graph).data.productionGeneratedHistory?.estimatedCostMinor).toBeNull(); expect(output(graph).data.productionGeneratedHistory?.billingState).toBe("unknown");
  });
  it("removed output can return without duplicating sources; origin and edge collision reject", () => {
    const graph = build(), removed = { nodes: graph.nodes.filter(n => !n.id.endsWith("-output")), edges: graph.edges.filter(e => !e.target.endsWith("-output")) }; expect(build(view, removed).nodes).toHaveLength(6);
    const bad = structuredClone(graph); output(bad).data.productionGeneratedHistory!.artifactFingerprint = "a".repeat(64); expect(() => build(view, bad)).toThrow();
    removed.edges[0].selectable = true; expect(() => build(view, removed)).toThrow();
  });
  it.each(["output-kind", "source-kind", "source-asset", "edge"])("repeat still rejects %s collision in the existing graph", damage => {
    const graph = structuredClone(build());
    if (damage === "output-kind") output(graph).data.kind = "image";
    if (damage === "source-kind") (graph.nodes[0] as StudioNode).data.kind = "text";
    if (damage === "source-asset") (graph.nodes[0] as StudioNode).data.assetId = "foreign";
    if (damage === "edge") graph.edges[0].selectable = true;
    expect(() => build(view, graph)).toThrow();
  });
  it.each(["constraint-missing", "constraint-drift", "constraint-duplicate", "input-missing", "input-sha", "input-size", "input-duplicate", "mask-source", "output-meta", "project", "position"])("%s cannot create partial graph", damage => {
    const a = structuredClone(assets()), c = [structuredClone(view.constraint)]; let p = "project-a", x = 0;
    if (damage === "constraint-missing") c.length = 0; if (damage === "constraint-drift") c[0].brandRules = { tone: "new" }; if (damage === "constraint-duplicate") c.push(c[0]);
    if (damage === "input-missing") a.shift(); if (damage === "input-sha") a[0].contentFingerprint = `sha256:${"a".repeat(64)}`; if (damage === "input-size") a[0].width = 2; if (damage === "input-duplicate") a.push(a[0]);
    if (damage === "mask-source") a[2].sourceAssetId = "source-2"; if (damage === "output-meta") a.at(-1)!.originalName = "changed"; if (damage === "project") p = "foreign"; if (damage === "position") x = Infinity;
    expect(() => buildProductionResultGraph(empty, view, p, a, c, { x, y: 0 })).toThrow(); expect(empty.nodes).toHaveLength(0);
  });
  it.each(["extra", "unknown-zero", "unknown-max", "known-null", "reserve", "mode", "scope", "output", "input", "hash", "double-local"])("%s bad independent history rejected by both migrations", damage => {
    const d = doc(build()), data = d.nodes.find(n => n.data.productionGeneratedHistory)!.data, h = data.productionGeneratedHistory as Record<string, unknown>;
    if (damage === "extra") h.executionKey = "no"; if (damage === "unknown-zero") h.estimatedCostMinor = 0; if (damage === "unknown-max") h.estimatedCostMinor = 40; if (damage === "known-null") h.estimateState = "known";
    if (damage === "reserve") h.reservedMinor = 0; if (damage === "mode") h.mode = "local-fixture"; if (damage === "scope") h.originProjectId = "foreign"; if (damage === "output") h.assetId = "foreign";
    if (damage === "input") h.inputAssetIds = ["source", "source"]; if (damage === "hash") h.inputChecksums = ["x"]; if (damage === "double-local") data.generatedHistory = {};
    expect(() => migrateCanvasDocument(d)).toThrow(); expect(() => migrateCanvasDocumentLight(d)).toThrow();
  });
  it("capacity limits/initial dimensions remain without trimming history", () => {
    const g = build(); expect(g.nodes.every(n => Number(n.initialWidth) > 0 && Number(n.initialHeight) > 0)).toBe(true);
    expect(() => build(view, { nodes: Array.from({ length: 10_000 }, (_, i) => ({ ...g.nodes[0], id: `full-${i}` })), edges: [] })).toThrow(/容量/);
    expect(() => build(view, { nodes: [], edges: Array.from({ length: 20_000 }, (_, i) => ({ ...g.edges[0], id: `full-${i}` })) })).toThrow(/容量/);
  });
  it.each(["mode", "evidence", "protocol"])("%s enum cannot be coerced from an array by either migration", key => {
    const d = doc(build()), h = d.nodes.find(n => n.data.productionGeneratedHistory)!.data.productionGeneratedHistory as Record<string, unknown>;
    h[key] = [h[key]];
    expect(() => migrateCanvasDocument(d)).toThrow(); expect(() => migrateCanvasDocumentLight(d)).toThrow();
  });
  it("portable copy remaps output/inputs/constraint, retains original identity and nullable estimate; broken references reject", async () => {
    const records = assets(), blobs = (id: string) => new Blob([Uint8Array.from(task.f.store.loadVerifiedImageBytes(principal.tenantId, "project-a", id)!.body)], { type: records.find(a => a.id === id)!.mimeType });
    const archive = await createProjectPackage({ projectName: "owned", document: doc(build()), constraints: [view.constraint], assets: records }, async id => blobs(id));
    const copy = remapProjectPackage(await parseProjectPackage(archive), "copy-doc", "copy-project"), h = parseProductionCanvasHistory(copy.document.nodes.find(n => n.data.productionGeneratedHistory)!.data.productionGeneratedHistory);
    expect(h).toMatchObject({ evidence: "imported-copy-history", originProjectId: "project-a", estimatedCostMinor: null, artifactFingerprint: view.artifactFingerprint }); expect(h.assetId).not.toBe(view.image.asset.id);
    expect(h.inputAssetIds.every(id => copy.assets.some(a => a.asset.id === id))).toBe(true); expect(h.constraintSnapshotId).toBe(copy.constraints[0].id);
    const next = remapProjectPackage(copy, "copy-two", "copy-two-project"); expect(parseProductionCanvasHistory(next.document.nodes.find(n => n.data.productionGeneratedHistory)!.data.productionGeneratedHistory).originProjectId).toBe("project-a");
    const broken = doc(build()); (broken.nodes.find(n => n.data.productionGeneratedHistory)!.data.productionGeneratedHistory as Record<string, unknown>).inputChecksums = ["a".repeat(64), ...view.requestDraft.inputs.slice(1).map(r => r.checksumSha256), view.requestDraft.operation === "edit" ? view.requestDraft.mask!.checksumSha256 : ""];
    await expect(createProjectPackage({ projectName: "bad", document: broken, constraints: [view.constraint], assets: records }, async id => blobs(id))).rejects.toThrow();
  });
  it("result client only freshly reads lineage before/after joint port, current fees not cached permissions", async () => {
    const replies = [view, { ...view, jobStatus: "succeeded", billing: { ...view.billing, state: "settled", actualMinor: 25, reservedMinor: 0 } }];
    const fetcher = vi.fn(async () => { const text = JSON.stringify(replies.shift()); return new Response(text, { headers: { "content-type": "application/json", "cache-control": "no-store", "content-length": String(Buffer.byteLength(text)) } }); }); vi.stubGlobal("fetch", fetcher);
    const port = { readProductionResult: vi.fn(async () => ({ asset: view.image.asset, inputAssets: assets().slice(0, -1) })) };
    const result = await new ProductionGeneratedAssetClient({ generatedReadUiEnabled: true, tenantId: "tenant-a", mode: view.mode }, new AbortController().signal).result("project-a", view.image.asset.id, port);
    expect(result.view.billing.actualMinor).toBe(25); expect(fetcher).toHaveBeenCalledTimes(2); expect(port.readProductionResult).toHaveBeenCalledOnce(); expect(fetcher.mock.calls.every(([path]: any) => path.endsWith("/lineage"))).toBe(true);
  });
});
