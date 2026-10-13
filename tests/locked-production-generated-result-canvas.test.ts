import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import type { LockedProductionGeneratedAssetLineage } from "../packages/contracts/src/index";
import { migrateCanvasDocument } from "../packages/canvas-schema/src/index";
import { migrateCanvasDocumentLight, parseLockedProductionCanvasHistory, parseProductionCanvasHistory, parseGeneratedCanvasHistory } from "../packages/canvas-schema/src/light";
import { ownedLockedGeneratedTask } from "./helpers/locked-generated-task";
import { buildLockedProductionResultGraph } from "../apps/web/src/canvas/lockedProductionGeneratedResult";
import { snapshotToDocument, documentToSnapshot } from "../apps/web/src/canvas/document";
import { createHistoryState, historyReducer } from "../apps/web/src/canvas/history";
import { createProjectPackage, parseProjectPackage, remapProjectPackage } from "../apps/web/src/projects/projectPackage";
import { LockedProductionGeneratedAssetClient } from "../apps/web/src/runs/lockedProductionGeneratedAssetClient";
import type { CanvasSnapshot, StudioNode } from "../apps/web/src/canvas/model";
let task: Awaited<ReturnType<typeof ownedLockedGeneratedTask>>, view: LockedProductionGeneratedAssetLineage;
const owned: typeof task[] = [], empty: CanvasSnapshot = { nodes: [], edges: [] };
beforeAll(async()=>{task=await ownedLockedGeneratedTask({manual:true,twoInputs:true}); view=task.reader().lineage(task.actor,"project-a",task.id);});
afterAll(()=>task?.cleanup()); afterEach(()=>{vi.unstubAllGlobals();for(const t of owned.splice(0))t.cleanup();});
const assets=(t=task,v=view)=>[...v.requestDraft.inputs,v.requestDraft.mask!].map(r=>t.store.loadVerifiedImage(t.actor.tenantId,"project-a",r.assetId)!.asset).concat(v.image.asset);
const build=(v=view,current=empty)=>buildLockedProductionResultGraph(current,v,"project-a",assets(task,v),[v.constraint],{x:0,y:0});
const output=(s:CanvasSnapshot)=>s.nodes.find(n=>n.type==="studio"&&n.data.lockedProductionGeneratedHistory)! as StudioNode;
const doc=(s:CanvasSnapshot)=>snapshotToDocument("owned-locked-result-doc","project-a",1,s,{x:0,y:0,zoom:1});
describe("B9C independent protected canvas observations",()=>{
  for(const protocol of ["openai","openai-compatible"] as const)for(const manual of [true,false])it(`${protocol}/${manual} actual protected chain graph with independent nullable money`,async()=>{
    const t=await ownedLockedGeneratedTask({protocol,manual});owned.push(t);const v=t.reader().lineage(t.actor,"project-a",t.id),before=t.store.load();
    const g=buildLockedProductionResultGraph(empty,v,"project-a",assets(t,v),[v.constraint],{x:0,y:0}),h=output(g).data.lockedProductionGeneratedHistory!;
    expect(h).toMatchObject({version:2,estimateState:manual?"unknown":"known",estimatedCostMinor:manual?null:25,maxCostMinor:40,reservedMinor:40,protection:v.protection});
    expect(output(g).data.generatedHistory).toBeUndefined();expect(output(g).data.productionGeneratedHistory).toBeUndefined();
    expect(()=>parseProductionCanvasHistory(h)).toThrow();expect(()=>parseGeneratedCanvasHistory(h)).toThrow();
    const saved=doc(g);expect(migrateCanvasDocument(saved)).toEqual(migrateCanvasDocumentLight(saved));expect(t.store.load()).toEqual(before);
  });
  it("multiple sources/mask order, single undo/redo, both migrations and refresh keep proof and only assetId media",()=>{
    const g=build(),h=output(g).data.lockedProductionGeneratedHistory!;
    expect(h.inputAssetIds).toEqual(["source","source-2","mask"]);expect(g.nodes).toHaveLength(6);expect(g.edges).toHaveLength(5);
    expect(g.edges.every(e=>e.deletable===false&&e.selectable===false)).toBe(true);
    let s=historyReducer(createHistoryState(empty),{type:"commit",next:g});expect(s.past).toHaveLength(1);s=historyReducer(s,{type:"undo"});expect(s.present).toEqual(empty);
    s=historyReducer(s,{type:"redo"});expect(output(documentToSnapshot(migrateCanvasDocumentLight(doc(s.present)))).data.lockedProductionGeneratedHistory).toEqual(h);
    expect(JSON.stringify(doc(g))).not.toMatch(/Base64|blob:|https:|credentialRef|executionKey|idempotencyKey|workerId|leaseId|rawResponse/);
  });
  it("repeat validates relationships without rewriting old unknown after actual independent overage settlement",async()=>{
    const t=await ownedLockedGeneratedTask({manual:true});owned.push(t);const v=t.reader().lineage(t.actor,"project-a",t.id);
    const first=buildLockedProductionResultGraph(empty,v,"project-a",assets(t,v),[v.constraint],{x:0,y:0});t.settle(65);
    const latest=t.reader().lineage(t.actor,"project-a",t.id),before=t.store.load();
    expect(buildLockedProductionResultGraph(first,latest,"project-a",assets(t,latest),[latest.constraint],{x:0,y:0})).toBe(first);
    expect(output(first).data.lockedProductionGeneratedHistory).toMatchObject({billingState:"unknown",reservedMinor:40,estimatedCostMinor:null,currentMaxCostMinor:40});
    expect(latest.billing.actualMinor).toBe(65);expect(t.store.load()).toEqual(before);expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("zero cap unknown never means actual zero cost",async()=>{
    const t=await ownedLockedGeneratedTask({manual:true,cap:0});owned.push(t);const v=t.reader().lineage(t.actor,"project-a",t.id);
    const h=output(buildLockedProductionResultGraph(empty,v,"project-a",assets(t,v),[v.constraint],{x:0,y:0})).data.lockedProductionGeneratedHistory!;
    expect(h).toMatchObject({estimatedCostMinor:null,maxCostMinor:0,reservedMinor:0,billingState:"unknown"});expect(h.actualMinor).toBeUndefined();
  });
  it("deleted output restores without duplicate sources and an unchanged repeated graph does not repair removed visual sources",()=>{
    const g=build(),removed={nodes:g.nodes.filter(n=>!n.id.endsWith("-output")),edges:g.edges.filter(e=>!e.target.endsWith("-output"))};
    expect(build(view,removed).nodes).toHaveLength(6);const withoutSource={nodes:g.nodes.slice(1),edges:g.edges.slice(1)};expect(build(view,withoutSource)).toBe(withoutSource);
  });
  it.each(["output-kind","source-kind","source-asset","edge","none-history","policy","proof"])("repeat rejects same-ID %s conflict",damage=>{
    const g=structuredClone(build()),o=output(g);
    if(damage==="output-kind")o.data.kind="image";if(damage==="source-kind")(g.nodes[0] as StudioNode).data.kind="text";
    if(damage==="source-asset")(g.nodes[0] as StudioNode).data.assetId="foreign";if(damage==="edge")g.edges[0].selectable=true;
    if(damage==="none-history")o.data.productionGeneratedHistory={} as any;
    if(damage==="policy")o.data.lockedProductionGeneratedHistory!.protection.policyFingerprint="a".repeat(64);
    if(damage==="proof")o.data.lockedProductionGeneratedHistory!.protection.pixelProofFingerprint="a".repeat(64);
    expect(()=>build(view,g)).toThrow();
  });
  it.each(["constraint-missing","constraint-drift","constraint-duplicate","input-missing","input-sha","input-size","input-duplicate","mask-source","output-meta","project","position"])("%s refuses a partial graph",damage=>{
    const a=structuredClone(assets()),c=[structuredClone(view.constraint)];let p="project-a",x=0;
    if(damage==="constraint-missing")c.length=0;if(damage==="constraint-drift")c[0].brandRules={changed:"not-original"};if(damage==="constraint-duplicate")c.push(c[0]);
    if(damage==="input-missing")a.shift();if(damage==="input-sha")a[0].contentFingerprint="sha256:"+ "a".repeat(64);if(damage==="input-size")a[0].width=3;if(damage==="input-duplicate")a.push(a[0]);
    if(damage==="mask-source")a[2].sourceAssetId="source-2";if(damage==="output-meta")a.at(-1)!.originalName="changed";if(damage==="project")p="foreign";if(damage==="position")x=Infinity;
    expect(()=>buildLockedProductionResultGraph(empty,view,p,a,c,{x,y:0})).toThrow();expect(empty.nodes).toHaveLength(0);
  });
  it.each(["extra","unknown-zero","unknown-max","known-null","reserve","mode","scope","output","input","hash","double-local","double-none","domain","version","source-binding","policy","proof","pixel-count","private-proof","array-enum"])("%s malformed v2 history is rejected by full and light migration",damage=>{
    const d=doc(build()),data=d.nodes.find(n=>n.data.lockedProductionGeneratedHistory)!.data,h=data.lockedProductionGeneratedHistory as any;
    if(damage==="extra")h.executionKey="no";if(damage==="unknown-zero")h.estimatedCostMinor=0;if(damage==="unknown-max")h.estimatedCostMinor=40;if(damage==="known-null")h.estimateState="known";
    if(damage==="reserve")h.reservedMinor=0;if(damage==="mode")h.mode="local-fixture";if(damage==="scope")h.originProjectId="foreign";if(damage==="output")h.assetId="foreign";
    if(damage==="input")h.inputAssetIds=["source","source"];if(damage==="hash")h.inputChecksums=["x"];if(damage==="double-local")data.generatedHistory={};if(damage==="double-none")data.productionGeneratedHistory={};
    if(damage==="domain")h.protection.domain="original-encoded-bytes";if(damage==="version")h.version=1;if(damage==="source-binding")h.protection.mask.sourceAssetId="foreign";
    if(damage==="policy")delete h.protection.policyFingerprint;if(damage==="proof")delete h.protection.pixelProofFingerprint;if(damage==="pixel-count")h.protection.lockedPixels=0;
    if(damage==="private-proof")h.protection.raw="no";if(damage==="array-enum")h.evidence=[h.evidence];
    expect(()=>migrateCanvasDocument(d)).toThrow();expect(()=>migrateCanvasDocumentLight(d)).toThrow();
  });
  it("capacity/initial size and bounded 16KiB history without trimming",()=>{
    const g=build();expect(g.nodes.every(n=>Number(n.initialWidth)>0&&Number(n.initialHeight)>0)).toBe(true);
    expect(()=>build(view,{nodes:Array.from({length:10_000},(_,i)=>({...g.nodes[0],id:"full-"+i})),edges:[]})).toThrow(/容量/);
    expect(()=>build(view,{nodes:[],edges:Array.from({length:20_000},(_,i)=>({...g.edges[0],id:"full-"+i}))})).toThrow(/容量/);
    const h=structuredClone(output(g).data.lockedProductionGeneratedHistory) as any;h.padding="x".repeat(16*1024);expect(()=>parseLockedProductionCanvasHistory(h)).toThrow();
  });
  it("package two copies remap local refs, preserve original immutable protection and money, no permission markers",async()=>{
    const records=assets(),blob=async(id:string)=>new Blob([Uint8Array.from(task.store.loadVerifiedImageBytes(task.actor.tenantId,"project-a",id)!.body)],{type:records.find(a=>a.id===id)!.mimeType});
    const archive=await createProjectPackage({projectName:"owned",document:doc(build()),constraints:[view.constraint],assets:records},blob);
    const one=remapProjectPackage(await parseProjectPackage(archive),"copy-doc","copy-project"),two=remapProjectPackage(one,"copy-two-doc","copy-two-project");
    for(const copied of [one,two]){const h=parseLockedProductionCanvasHistory(copied.document.nodes.find(n=>n.data.lockedProductionGeneratedHistory)!.data.lockedProductionGeneratedHistory);
      expect(h).toMatchObject({evidence:"imported-copy-history",originProjectId:"project-a",estimatedCostMinor:null,protection:view.protection});
      expect(h.assetId).not.toBe(view.image.asset.id);expect(h.protectedSourceAssetId).toBe(h.inputAssetIds[0]);expect(h.protectedMaskAssetId).toBe(h.inputAssetIds.at(-1));
      expect(copied.assets.some(a=>a.asset.id===h.protectedMaskAssetId&&a.asset.sourceAssetId===h.protectedSourceAssetId)).toBe(true);
      expect(migrateCanvasDocument(copied.document)).toEqual(migrateCanvasDocumentLight(copied.document));
    }
    const again=await parseProjectPackage(await createProjectPackage({projectName:"copy",document:two.document,constraints:two.constraints,assets:two.assets.map(a=>a.asset)},async id=>two.assets.find(a=>a.asset.id===id)!.original));
    expect(parseLockedProductionCanvasHistory(again.document.nodes.find(n=>n.data.lockedProductionGeneratedHistory)!.data.lockedProductionGeneratedHistory).protection).toEqual(view.protection);
    await expect(createProjectPackage({projectName:"bad",document:doc(build()),constraints:[view.constraint],assets:records},async id=>{const b=await blob(id);return new Blob([new Uint8Array(b.size)],{type:b.type});})).rejects.toThrow(/SHA/);
    const bytes=new Uint8Array(await archive.arrayBuffer());bytes[bytes.length-1]^=1;await expect(parseProjectPackage(new Blob([bytes]))).rejects.toThrow(/SHA/);
  });
  it.each(["input-limit","total-limit","output-limit","kind"])("protected package %s declaration rejects before any original getter",async damage=>{
    const d=doc(build()),records=structuredClone(assets()),h=d.nodes.find(n=>n.data.lockedProductionGeneratedHistory)!.data.lockedProductionGeneratedHistory as any;
    if(damage==="input-limit")records[1].byteSize=31*1024*1024;
    if(damage==="total-limit"){records.slice(0,3).forEach(a=>a.byteSize=22*1024*1024);h.protection.source.byteSize=h.protection.mask.byteSize=22*1024*1024;}
    if(damage==="output-limit")records.at(-1)!.byteSize=21*1024*1024;if(damage==="kind")records[1].kind="video";
    const getter=vi.fn(async()=>new Blob());await expect(createProjectPackage({projectName:"owned-bounded",document:d,constraints:[view.constraint],assets:records},getter)).rejects.toThrow(/保护历史声明/);
    expect(getter).not.toHaveBeenCalled();
  });
  it("result client freshly reads actual lineage on both sides of joint port; no binary/write/retry",async()=>{
    const replies=[view,view];const fetcher=vi.fn(async()=>{const text=JSON.stringify(replies.shift());return new Response(text,{headers:{"content-type":"application/json","cache-control":"no-store","content-length":String(Buffer.byteLength(text))}});});vi.stubGlobal("fetch",fetcher);
    const port={readLockedProductionResult:vi.fn(async()=>({asset:view.image.asset,inputAssets:assets().slice(0,-1)}))};
    const r=await new LockedProductionGeneratedAssetClient({lockedGeneratedReadUiEnabled:true,tenantId:view.tenantId,mode:view.mode},new AbortController().signal).result("project-a",view.image.asset.id,port);
    expect(r.view.protection).toEqual(view.protection);expect(fetcher).toHaveBeenCalledTimes(2);expect(port.readLockedProductionResult).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.every(([p]:any)=>p.endsWith("/lineage"))).toBe(true);
  });
});
