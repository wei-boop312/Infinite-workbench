import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { LockedProductionGeneratedReadScopeSchema, type LockedProductionGeneratedAssetLineage } from "../packages/contracts/src/index";
import { LockedProductionGeneratedAssetClient } from "../apps/web/src/runs/lockedProductionGeneratedAssetClient";
import { lockedProductionCacheIdentity, lockedProductionMarkerMatches } from "../apps/web/src/assets/lockedProductionGeneratedAssetPolicy";
import { ProductionGeneratedAssetClient } from "../apps/web/src/runs/productionGeneratedAssetClient";
import { ownedLockedGeneratedTask } from "./helpers/locked-generated-task";
import { createApiServer } from "../apps/api/src/index";
const scope={lockedGeneratedReadUiEnabled:true as const,tenantId:"tenant-a",mode:"production-contract-fixture" as const};
let base:Awaited<ReturnType<typeof ownedLockedGeneratedTask>>,view:LockedProductionGeneratedAssetLineage;
const servers:Server[]=[],owned:typeof base[]=[];
beforeAll(async()=>{base=await ownedLockedGeneratedTask({manual:true});view=base.reader().lineage(base.actor,"project-a",base.id);});
afterAll(()=>base.cleanup());
afterEach(async()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}for(const t of owned.splice(0))t.cleanup();});
const reply=(v:unknown,headers:Record<string,string>={})=>{const text=JSON.stringify(v);return new Response(text,{headers:{"content-type":"application/json; charset=utf-8","cache-control":"private,no-store","content-length":String(Buffer.byteLength(text)),...headers}});};
const content=(v=view,bytes=base.source,headers:Record<string,string>={})=>new Response(Uint8Array.from(bytes),{headers:{
  "content-type":v.image.asset.mimeType,"content-length":String(v.image.asset.byteSize),"cache-control":"private,no-store","x-content-sha256":v.image.checksumSha256,
  "x-canvas-binary-version":"locked-production-generated-image-v2","x-canvas-image-mode":v.mode,"x-canvas-artifact-sha256":v.artifactFingerprint,
  "x-canvas-protection-policy-sha256":v.protection.policyFingerprint,"x-canvas-pixel-proof-sha256":v.protection.pixelProofFingerprint,...headers}});
function setup(responses:Response[]=[reply(view),content(),reply(view)],abort=new AbortController()){
  const fetcher=vi.fn();for(const r of responses)fetcher.mockResolvedValueOnce(r);vi.stubGlobal("fetch",fetcher);
  const repository={cacheLockedProductionGenerated:vi.fn(async(v,_b,s,recheck)=>{s.throwIfAborted();await recheck();return v.image.asset;})};
  return {api:new LockedProductionGeneratedAssetClient(scope,abort.signal),fetcher,repository,abort};
}
describe("B9B protected original browser boundary",()=>{
  it.each([{}, {...scope,lockedGeneratedReadUiEnabled:false},{...scope,generatedReadUiEnabled:true},{...scope,mode:"local-fixture"},{...scope,tenantId:""}])("strict independent config %j",s=>{
    expect(LockedProductionGeneratedReadScopeSchema.safeParse(s).success).toBe(false);expect(()=>new LockedProductionGeneratedAssetClient(s as never,new AbortController().signal)).toThrow();
  });
  describe.each((["openai","openai-compatible"] as const).flatMap(protocol=>[false,true].map(manual=>[protocol,manual] as const)))("actual protected HTTP %s/manual=%s",(protocol,manual)=>{
    let t:typeof base;beforeEach(async()=>{t=await ownedLockedGeneratedTask({protocol,manual});owned.push(t);});
    it("only two explicit GETs, full actual protected task/bytes + fresh final read without state writes",async()=>{
      const s=createApiServer({lockedProductionGeneratedAssets:t.reader()});servers.push(s);await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const a=s.address();if(!a||typeof a==="string")throw Error();
      const before=t.store.load(),native=globalThis.fetch,fetcher=vi.fn((p:string,o:RequestInit)=>native(`http://127.0.0.1:${a.port}${p.replace(/^\/studio-api/,"")}`,o));vi.stubGlobal("fetch",fetcher);t.pricePort.read.mockClear();t.pricePort.verify.mockClear();
      const port={cacheLockedProductionGenerated:vi.fn(async(v:LockedProductionGeneratedAssetLineage,b:Blob,signal:AbortSignal,recheck:()=>Promise<LockedProductionGeneratedAssetLineage>)=>{
        expect(Buffer.from(await b.arrayBuffer())).toEqual(t.source);expect(v.protection.lockedPixelsEqual).toBe(true);expect(v.billing.estimatedMinor).toBe(manual?null:25);signal.throwIfAborted();expect(await recheck()).toEqual(v);return v.image.asset;})};
      expect(await new LockedProductionGeneratedAssetClient(scope,new AbortController().signal).cache("project-a",t.id,port)).toEqual(t.saved().lockedProductionImageArtifact!.image.asset);
      expect(fetcher.mock.calls.map(([p])=>p.split("/").at(-1))).toEqual(["lineage","content","lineage"]);
      for(const [p,o]of fetcher.mock.calls){expect(p).toContain("/locked-production-generated-assets/");expect(o).toMatchObject({method:"GET",cache:"no-store",redirect:"error",credentials:"same-origin",mode:"same-origin",referrerPolicy:"no-referrer",headers:{"x-canvas-local":"1"}});}
      expect(t.store.load()).toEqual(before);expect(t.send).toHaveBeenCalledTimes(1);expect(t.pricePort.read).not.toHaveBeenCalled();expect(t.pricePort.verify).not.toHaveBeenCalled();
    });
  });
  it.each(["tenant","project","asset","mode","constraint","private","domain","policy","proof","mask-source","count","estimate","transform","oversize"])("bad %s lineage rejected before content/IDB",async bad=>{
    const v=structuredClone(view);if(bad==="tenant")v.tenantId="other";if(bad==="project")v.projectId="other";if(bad==="asset")v.image.asset.id="other";if(bad==="mode")v.mode="production";
    if(bad==="constraint")v.constraint.brandRules.style="drift";if(bad==="private")(v as any).executionKey="secret";if(bad==="domain")(v.protection as any).domain="encoded";
    if(bad==="policy")v.protection.policyVersion="unknown" as never;if(bad==="proof")delete(v as any).protection.pixelProofFingerprint;
    if(bad==="mask-source")v.protection.mask.sourceAssetId="other";if(bad==="count")v.protection.lockedPixels=0;if(bad==="estimate")v.billing.estimatedMinor=0;
    if(bad==="transform")v.transformedInputs[0].originalChecksumSha256="0".repeat(64);if(bad==="oversize")v.image.asset.byteSize=20*1024*1024+1;
    const f=setup([reply(v)]);await expect(f.api.cache("project-a",view.image.asset.id,f.repository)).rejects.toThrow();expect(f.fetcher).toHaveBeenCalledTimes(1);expect(f.repository.cacheLockedProductionGenerated).not.toHaveBeenCalled();
  });
  it.each([{"x-canvas-binary-version":"production-generated-image-v1"},{"x-canvas-image-mode":"production"},{"x-canvas-artifact-sha256":"0".repeat(64)},
    {"x-canvas-protection-policy-sha256":"0".repeat(64)},{"x-canvas-pixel-proof-sha256":"0".repeat(64)},{"content-length":"1"},{"x-content-sha256":"0".repeat(64)},
    {"content-type":"image/webp"},{"content-encoding":"gzip"},{"cache-control":"public"}])("strict v2 body headers %j",async headers=>{
      const f=setup([reply(view),content(view,base.source,headers)]);await expect(f.api.cache("project-a",view.image.asset.id,f.repository)).rejects.toThrow();expect(f.repository.cacheLockedProductionGenerated).not.toHaveBeenCalled();
  });
  it.each(["truncated","changed","oversize"])("actual %s original rejects before IDB",async bad=>{
    const bytes=bad==="truncated"?base.source.subarray(0,16):Buffer.alloc(base.source.length+(bad==="oversize"?1:0)),f=setup([reply(view),content(view,bytes)]);
    await expect(f.api.cache("project-a",view.image.asset.id,f.repository)).rejects.toThrow();expect(f.repository.cacheLockedProductionGenerated).not.toHaveBeenCalled();
  });
  it.each(["utf8","over","empty","fragments","compressed","type","length"])("bounded %s JSON fails closed",async bad=>{
    let r:Response;if(["empty","fragments"].includes(bad))r=new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(bad==="empty"?[]:[32]));}}),{headers:{"content-length":"5000","content-type":"application/json","cache-control":"no-store"}});
    else if(bad==="utf8")r=new Response(new Uint8Array([255]),{headers:{"content-length":"1","content-type":"application/json","cache-control":"no-store"}});
    else r=reply(view,bad==="over"?{"content-length":"524289"}:bad==="compressed"?{"content-encoding":"gzip"}:bad==="type"?{"content-type":"text/html"}:{"content-length":"1"});
    const f=setup([r]);await expect(f.api.cache("project-a",view.image.asset.id,f.repository)).rejects.toThrow();expect(f.repository.cacheLockedProductionGenerated).not.toHaveBeenCalled();
  });
  it("permission failure at final actual read never retries or accepts old lineage",async()=>{
    const f=setup([reply(view),content(),new Response("private-denied",{status:403})]);await expect(f.api.cache("project-a",view.image.asset.id,f.repository)).rejects.toThrow();expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it("protected frozen identity includes policy/proof, excludes only legitimate current fees",async()=>{
    const v=structuredClone(view);v.protection.policyFingerprint="1".repeat(64);const f=setup([reply(view),content(),reply(v)]);
    await expect(f.api.cache("project-a",view.image.asset.id,f.repository)).rejects.toThrow(/冻结关系/);
    const proof=structuredClone(view);proof.protection.pixelProofFingerprint="1".repeat(64);expect(lockedProductionCacheIdentity(proof)).not.toBe(lockedProductionCacheIdentity(view));
    const settled=structuredClone(view);settled.jobStatus="succeeded";settled.billing={...settled.billing,state:"settled",reservedMinor:0,actualMinor:65,currentMaxCostMinor:65};
    const good=setup([reply(view),content(),reply(settled)]);await expect(good.api.cache("project-a",view.image.asset.id,good.repository)).resolves.toEqual(view.image.asset);expect(lockedProductionCacheIdentity(settled)).toBe(lockedProductionCacheIdentity(view));
  });
  it("bounded independent mark validates full history and proxy, cannot use old local/none marks",()=>{
    const marker={version:2 as const,namespace:"locked-production-generated-image-v2" as const,assetId:view.image.asset.id,tenantId:view.tenantId,projectId:view.projectId,mode:view.mode,
      identity:lockedProductionCacheIdentity(view),lineage:view,proxy:{checksumSha256:"a".repeat(64),byteSize:40,mimeType:"image/webp" as const,width:2,height:1}};
    expect(lockedProductionMarkerMatches(marker,view)).toBe(true);
    for(const m of [{...marker,version:1},{...marker,authority:true},{...marker,proxy:{...marker.proxy,width:3}},{...marker,lineage:{...view,billing:{...view.billing,actualMinor:0}}}])expect(lockedProductionMarkerMatches(m as never,view)).toBe(false);
  });
  it("old none client rejects v2 public schema before binary and cache",async()=>{
    const f=setup([reply(view)]),port={cacheProductionGenerated:vi.fn()};
    await expect(new ProductionGeneratedAssetClient({generatedReadUiEnabled:true,tenantId:scope.tenantId,mode:scope.mode},new AbortController().signal).cache("project-a",view.image.asset.id,port)).rejects.toThrow();expect(port.cacheProductionGenerated).not.toHaveBeenCalled();expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("verify cached original reauthorizes after local decode and never reads body/task/fees",async()=>{
    const f=setup([reply(view),reply(view)]),readLockedProductionGenerated=vi.fn(async v=>v.image.asset);
    expect(await f.api.verifyCached("project-a",view.image.asset.id,{readLockedProductionGenerated})).toEqual({view,asset:view.image.asset});expect(f.fetcher.mock.calls.every(([p])=>p.endsWith("/lineage"))).toBe(true);
  });
  it("non-cooperative fetch retains shared two slots until actually settled, no late cache",async()=>{
    const resolvers:Array<(r:Response)=>void>=[];vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(r=>resolvers.push(r))));
    const a=new AbortController(),b=new AbortController(),x=new LockedProductionGeneratedAssetClient(scope,a.signal),y=new LockedProductionGeneratedAssetClient(scope,b.signal);
    const pending=Promise.allSettled([x.cache("project-a",view.image.asset.id),y.cache("project-a",view.image.asset.id)]);a.abort();b.abort();await pending;
    await expect(new ProductionGeneratedAssetClient({generatedReadUiEnabled:true,tenantId:scope.tenantId,mode:scope.mode},new AbortController().signal).cache("project-a",view.image.asset.id)).rejects.toThrow(/正在进行/);
    for(const r of resolvers)r(reply(view));await new Promise(r=>setTimeout(r,0));const f=setup();await expect(f.api.cache("project-a",view.image.asset.id,f.repository)).resolves.toEqual(view.image.asset);
  });
  it("absolute thirty second non-cooperative fetch stops wait without freeing occupied work",async()=>{
    vi.useFakeTimers();let resolve!:(r:Response)=>void;vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(r=>resolve=r)));
    const f=new LockedProductionGeneratedAssetClient(scope,new AbortController().signal),promise=f.lineage("project-a",view.image.asset.id),denied=expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30001);await denied;resolve(reply(view));await Promise.resolve();
  });
  it("actual protected overage settlement preserves frozen artifact identity and nullable estimate",async()=>{
    const t=await ownedLockedGeneratedTask({manual:true});owned.push(t);const before=t.reader().lineage(t.actor,"project-a",t.id);t.settle(65);
    const after=t.reader().lineage(t.actor,"project-a",t.id);expect(after.billing).toMatchObject({estimatedMinor:null,actualMinor:65,currentMaxCostMinor:65,reservedMinor:0});
    expect(lockedProductionCacheIdentity(after)).toBe(lockedProductionCacheIdentity(before));expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("actual protected zero-cap unknown is not a measured zero fee",async()=>{
    const t=await ownedLockedGeneratedTask({manual:true,cap:0});owned.push(t);const v=t.reader().lineage(t.actor,"project-a",t.id);
    expect(v.billing).toEqual({state:"unknown",currency:"CNY",estimatedMinor:null,maxCostMinor:0,currentMaxCostMinor:0,reservedMinor:0});expect(v.protection.lockedPixelsEqual).toBe(true);
  });
});
