import { expect, test, type Page } from "@playwright/test";
import { ownedLockedGeneratedTask } from "../helpers/locked-generated-task";
import { createApiServer } from "../../apps/api/src/index";
test.use({serviceWorkers:"block"});
const cleanups:Array<()=>Promise<void>>=[];
test.afterEach(async()=>{for(const c of cleanups.splice(0))await c();});
async function fixture(page:Page,options:Parameters<typeof ownedLockedGeneratedTask>[0]={}){
  const t=await ownedLockedGeneratedTask(options),port=t.reader(),view=port.lineage(t.actor,"project-a",t.id),before=t.store.load();
  const server=createApiServer({lockedProductionGeneratedAssets:port});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const a=server.address();if(!a||typeof a==="string")throw Error();const origin=`http://127.0.0.1:${a.port}`;
  let hold=false,corrupt=false,deny=false,reads=0,release:(()=>void)|undefined;const requests:{method:string;path:string}[]=[];
  cleanups.push(async()=>{hold=false;release?.();await page.unrouteAll({behavior:"wait"});server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));t.cleanup();});
  await page.addInitScript(()=>{
    localStorage.setItem("ai-commerce-canvas.imported-projects",JSON.stringify([{documentId:"owned-locked-cache-doc",projectId:"project-a",label:"自有保护缓存测试",importedAt:"2026-10-13T00:00:00Z"}]));
    localStorage.setItem("ai-commerce-canvas.active-document","owned-locked-cache-doc");
  });
  await page.route("**/src/main.tsx",async route=>{
    const r=await route.fetch(),original=await r.text(),text=original.replace("jsxDEV(App, {},",'jsxDEV(App, { lockedProductionGeneratedRead: { lockedGeneratedReadUiEnabled: true, tenantId: "tenant-a", mode: "production-contract-fixture" } },');
    if(text===original)throw Error("owned trusted App config injection failed");await route.fulfill({response:r,body:text});
  });
  await page.route(/\/studio-api\/v1\/projects\/[^/]+\/locked-production-generated-assets\/[^/]+\/(?:lineage|content)$/,async route=>{
    const path=new URL(route.request().url()).pathname.replace(/^\/studio-api/,"");requests.push({method:route.request().method(),path});
    if(path.endsWith("/lineage")){reads++;if(deny&&reads>=2)t.denied.add("run:read");}
    const r=await route.fetch({url:origin+path,maxRedirects:0});if(hold&&path.endsWith("/content"))await new Promise<void>(resolve=>release=resolve);
    if(corrupt&&path.endsWith("/content"))await route.fulfill({response:r,body:Buffer.alloc(t.source.length)});else await route.fulfill({response:r});
  });
  await page.goto("/");await page.getByRole("button",{name:"任务与预算",exact:true}).click();
  const panel=page.getByRole("region",{name:"保护原图只读缓存"});await expect(panel).toBeVisible();await panel.getByLabel("保护原图资产编号").fill(t.id);
  const cache=async()=>{await panel.getByRole("button",{name:"缓存保护原图",exact:true}).click();await expect(panel.getByRole("status")).toContainText("已缓存");};
  return {t,id:t.id,view,before,panel,requests,cache,setHold:()=>hold=true,release:()=>{hold=false;release?.();},corrupt:()=>corrupt=true,deny:()=>deny=true};
}
async function cached(page:Page,id:string){
  return page.evaluate(async id=>{
    const {assetRepository}=await import("/src/assets/assetRepository.ts"),original=await assetRepository.getBlob(id,"original"),proxy=await assetRepository.getBlob(id,"proxy");
    const q=indexedDB.open("ai-commerce-canvas-assets"),db=await new Promise<IDBDatabase>((r,j)=>{q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
    try {const tx=db.transaction(["lockedProductionGeneratedCaches","productionGeneratedCaches","generatedCaches"],"readonly"),
      read=(name:string)=>new Promise<any>((r,j)=>{const q=tx.objectStore(name).get(id);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
      const [marker,none,local]=await Promise.all([read("lockedProductionGeneratedCaches"),read("productionGeneratedCaches"),read("generatedCaches")]);
      const sha=async(b:Blob)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await b.arrayBuffer())),x=>x.toString(16).padStart(2,"0")).join("");
      return {assets:await assetRepository.list("project-a"),version:db.version,marker,none,local,bytes:original?.size??0,type:original?.type,
        sha:original?await sha(original):null,proxyBytes:proxy?.size??0,proxySha:proxy?await sha(proxy):null};
    } finally {db.close();}
  },id);
}
for(const protocol of ["openai","openai-compatible"] as const)for(const manual of [false,true])test(`protected ${protocol}/${manual} actual SQLite + HTTP + IDB independent v2 cache/reload, no graph/budget write`,async({page})=>{
  const f=await fixture(page,{protocol,manual}),nodes=await page.locator(".react-flow__node").count();await f.cache();const c=await cached(page,f.id);
  expect(c.version).toBe(5);expect(c.assets).toEqual([f.view.image.asset]);expect(c.marker.lineage).toEqual(f.view);expect(c.marker).toMatchObject({version:2,namespace:"locked-production-generated-image-v2"});
  expect(c.sha).toBe(f.view.image.checksumSha256);expect(c.proxyBytes).toBeGreaterThan(0);expect(c.marker.proxy.checksumSha256).toBe(c.proxySha);expect(c.local).toBeUndefined();expect(c.none).toBeUndefined();
  await f.cache();expect((await cached(page,f.id)).marker).toEqual(c.marker);await f.panel.getByRole("button",{name:"重新核验保护原图缓存"}).click();await expect(f.panel.getByRole("status")).toContainText("已核验");
  await expect(f.panel.getByRole("article")).toContainText(manual?"未知（不是零费用）":"CNY 25 最小单位");await expect(f.panel.getByRole("article")).toContainText("原锁区 1 像素");
  expect(await page.locator(".react-flow__node").count()).toBe(nodes);expect(f.t.store.load()).toEqual(f.before);expect(f.requests.every(r=>r.method==="GET"&&/\/(lineage|content)$/.test(r.path))).toBe(true);
  await expect(f.panel.getByRole("button",{name:/确认|执行|核账/})).toHaveCount(0);
  await expect(f.panel.getByRole("button",{name:"核验保护原图并回画布",exact:true})).toBeVisible();
  await page.reload();await page.getByRole("button",{name:"资产库 1",exact:true}).click();const library=page.getByRole("complementary",{name:"项目资产库"});await expect(library.locator("img")).toBeVisible();await expect(library.getByRole("button",{name:"添加到画布"})).toBeDisabled();
  expect(f.t.store.load()).toEqual(f.before);
});
test("first await freezes complete v2 input for native cache and read; old none/local methods reject",async({page})=>{
  const f=await fixture(page);
  const r=await page.evaluate(async({view,bytes})=>{
    const {assetRepository}=await import("/src/assets/assetRepository.ts"),signal=new AbortController().signal,original=new Blob([Uint8Array.from(atob(bytes),x=>x.charCodeAt(0))],{type:view.image.asset.mimeType});
    const input=structuredClone(view),writing=assetRepository.cacheLockedProductionGenerated(input,original,signal,async()=>structuredClone(view));input.protection.policyFingerprint="0".repeat(64);
    const asset=await writing,readInput=structuredClone(view),reading=assetRepository.readLockedProductionGenerated(readInput,signal);readInput.constraint.brandRules.style="caller-changed";
    let none=false,local=false;try{await assetRepository.readProductionGenerated(view as never,signal);}catch{none=true;}try{await assetRepository.readGenerated(view.image,signal);}catch{local=true;}
    return {asset,read:await reading,none,local};
  },{view:f.view,bytes:f.t.source.toString("base64")});
  expect(r).toEqual({asset:f.view.image.asset,read:f.view.image.asset,none:true,local:true});expect(f.t.store.load()).toEqual(f.before);
});
for(const bad of ["bytes","permission"] as const)test(`protected ${bad} response or final server read failure cannot cache or retry`,async({page})=>{
  const f=await fixture(page);if(bad==="bytes")f.corrupt();else f.deny();await f.panel.getByRole("button",{name:"缓存保护原图",exact:true}).click();await expect(f.panel.getByRole("alert")).toBeVisible();
  const c=await cached(page,f.id);expect(c.assets).toHaveLength(0);expect(c.bytes).toBe(0);expect(c.marker).toBeUndefined();expect(f.requests).toHaveLength(bad==="bytes"?2:3);expect(f.t.store.load()).toEqual(f.before);
});
test("actual IDB write-after failure/cancel rolls back protected metadata/original/proxy/mark",async({page})=>{
  const f=await fixture(page);
  for(const kind of ["failure","abort"] as const){
    await page.evaluate(({id,kind})=>{const put=IDBObjectStore.prototype.put;(window as any).__ownedPut=put;IDBObjectStore.prototype.put=function(v,...args){const r=put.call(this,v,...args);
      if(this.name==="blobs"&&v.assetId===id){if(kind==="failure")throw Error("owned-after-write");this.transaction.abort();}return r;};},{id:f.id,kind});
    await f.panel.getByRole("button",{name:"缓存保护原图",exact:true}).click();await expect(f.panel.getByRole("alert")).toBeVisible();const c=await cached(page,f.id);
    expect(c.assets).toHaveLength(0);expect(c.bytes).toBe(0);expect(c.proxyBytes).toBe(0);expect(c.marker).toBeUndefined();await page.evaluate(()=>{IDBObjectStore.prototype.put=(window as any).__ownedPut;});
  }
  await f.cache();expect(f.t.store.load()).toEqual(f.before);
});
for(const bad of ["marker","local","none","original","proxy","metadata","sha","proxy-sha","policy","proof"] as const)test(`protected damaged ${bad} fails read without deleting lawful offline original`,async({page})=>{
  const f=await fixture(page);await f.cache();
  await page.evaluate(async({id,bad})=>{
    const q=indexedDB.open("ai-commerce-canvas-assets"),db=await new Promise<IDBDatabase>(r=>{q.onsuccess=()=>r(q.result);});
    const tx=db.transaction(["assets","blobs","lockedProductionGeneratedCaches","productionGeneratedCaches","generatedCaches"],"readwrite"),marks=tx.objectStore("lockedProductionGeneratedCaches");
    if(["marker","local","none"].includes(bad)){marks.delete(id);if(bad!=="marker")tx.objectStore(bad==="local"?"generatedCaches":"productionGeneratedCaches").put({assetId:id,version:1});}
    else if(bad==="original"||bad==="proxy")tx.objectStore("blobs").delete(`${id}:${bad}`);
    else {const store=tx.objectStore(bad==="metadata"?"assets":bad==="sha"||bad==="proxy-sha"?"blobs":"lockedProductionGeneratedCaches"),r=store.get(bad==="sha"?`${id}:original`:bad==="proxy-sha"?`${id}:proxy`:id);
      r.onsuccess=()=>{const v=r.result;if(bad==="metadata")v.originalName="drift.png";else if(bad==="sha"||bad==="proxy-sha")v.blob=new Blob([new Uint8Array(v.blob.size)],{type:v.blob.type});
        else v.lineage.protection[bad==="policy"?"policyFingerprint":"pixelProofFingerprint"]="0".repeat(64);store.put(v);};}
    await new Promise<void>((r,j)=>{tx.oncomplete=()=>r();tx.onabort=()=>j(tx.error);});db.close();
  },{id:f.id,bad});
  await f.panel.getByRole("button",{name:"重新核验保护原图缓存"}).click();await expect(f.panel.getByRole("alert")).toBeVisible();const c=await cached(page,f.id);
  expect(c.assets).toHaveLength(1);if(bad!=="original")expect(c.bytes).toBe(f.t.source.length);expect(f.t.store.load()).toEqual(f.before);
});
test("ordinary restore/new id/foreign global id cannot create protected marker or overwrite another project",async({page})=>{
  const f=await fixture(page);
  await page.evaluate(async({asset,bytes})=>{const {assetRepository}=await import("/src/assets/assetRepository.ts");await assetRepository.restore("project-a",[{asset,original:new Blob([Uint8Array.from(atob(bytes),x=>x.charCodeAt(0))],{type:asset.mimeType})}]);},{asset:f.view.image.asset,bytes:f.t.source.toString("base64")});
  await f.panel.getByRole("button",{name:"缓存保护原图",exact:true}).click();await expect(f.panel.getByRole("alert")).toContainText("冲突");expect((await cached(page,f.id)).marker).toBeUndefined();
  const copied=await page.evaluate(async({view,bytes})=>{const {assetRepository}=await import("/src/assets/assetRepository.ts"),v=structuredClone(view);v.image.asset.id="owned-protected-copy";
    await assetRepository.restore("project-a",[{asset:v.image.asset,original:new Blob([Uint8Array.from(atob(bytes),x=>x.charCodeAt(0))],{type:v.image.asset.mimeType})}]);try{await assetRepository.readLockedProductionGenerated(v,new AbortController().signal);return false;}catch{return true;}},{view:f.view,bytes:f.t.source.toString("base64")});expect(copied).toBe(true);
  await page.evaluate(async({asset,bytes})=>{const {assetRepository}=await import("/src/assets/assetRepository.ts");await assetRepository.remove("project-a",asset.id);await assetRepository.restore("foreign",[{asset:{...asset,projectId:"foreign"},original:new Blob([Uint8Array.from(atob(bytes),x=>x.charCodeAt(0))],{type:asset.mimeType})}]);},{asset:f.view.image.asset,bytes:f.t.source.toString("base64")});
  await f.panel.getByRole("button",{name:"缓存保护原图",exact:true}).click();await expect(f.panel.getByRole("alert")).toContainText("冲突");expect((await cached(page,f.id)).bytes).toBe(f.t.source.length);expect(f.t.store.load()).toEqual(f.before);
});
test("actual independent protected overage settlement changes current fee, never original cache/protection identity",async({page})=>{
  const f=await fixture(page,{manual:true});await f.cache();const marker=(await cached(page,f.id)).marker;f.t.settle(65);const settled=f.t.store.load();
  await f.panel.getByRole("button",{name:"重新核验保护原图缓存"}).click();await expect(f.panel.getByRole("status")).toContainText("已核验");await expect(f.panel.getByRole("article")).toContainText("实费 CNY 65 最小单位");
  expect((await cached(page,f.id)).marker).toEqual(marker);await f.cache();expect((await cached(page,f.id)).marker).toEqual(marker);expect(f.t.store.load()).toEqual(settled);
});
for(const action of ["close","project"] as const)test(`protected ${action} cancels held original response without late cache/UI`,async({page})=>{
  const f=await fixture(page);f.setHold();await f.panel.getByRole("button",{name:"缓存保护原图",exact:true}).click();await expect.poll(()=>f.requests.some(r=>r.path.endsWith("/content"))).toBe(true);
  if(action==="close")await page.getByRole("button",{name:"关闭任务面板"}).click();else await page.getByLabel("切换项目").selectOption("phase-1-campaign");f.release();
  await expect.poll(async()=>(await cached(page,f.id)).bytes).toBe(0);expect(f.t.store.load()).toEqual(f.before);
  if(action==="close"){await page.getByRole("button",{name:"任务与预算",exact:true}).click();await expect(page.getByRole("region",{name:"保护原图只读缓存"}).getByRole("status")).toHaveCount(0);}
});
test("v4 incremental migration retains both old none/local records and bytes, adds only independent protected store",async({page})=>{
  await page.addInitScript(()=>{
    const q=indexedDB.open("ai-commerce-canvas-assets",4);q.onupgradeneeded=()=>{const db=q.result,a=db.createObjectStore("assets",{keyPath:"id"});a.createIndex("projectId","projectId");a.createIndex("projectFingerprint",["projectId","contentFingerprint"]);const b=db.createObjectStore("blobs",{keyPath:"key"});b.createIndex("assetId","assetId");db.createObjectStore("generatedCaches",{keyPath:"assetId"});db.createObjectStore("productionGeneratedCaches",{keyPath:"assetId"});};
    q.onsuccess=()=>{const db=q.result,tx=db.transaction(["assets","blobs","generatedCaches","productionGeneratedCaches"],"readwrite");
      tx.objectStore("assets").put({id:"old-none",projectId:"old-project",kind:"image",purpose:"generated",originalName:"old.png",storageKey:"old:original",mimeType:"image/png",byteSize:3,createdAt:"2026-10-13T00:00:00Z"});
      tx.objectStore("blobs").put({key:"old-none:original",assetId:"old-none",role:"original",blob:new Blob([new Uint8Array([1,2,3])])});
      tx.objectStore("generatedCaches").put({assetId:"old-local",metadata:"keep-local"});tx.objectStore("productionGeneratedCaches").put({assetId:"old-none",lineage:"keep-none"});tx.oncomplete=()=>db.close();};
  });
  const f=await fixture(page);await f.cache();
  const r=await page.evaluate(async()=>{
    const {assetRepository}=await import("/src/assets/assetRepository.ts"),q=indexedDB.open("ai-commerce-canvas-assets"),db=await new Promise<IDBDatabase>(r=>{q.onsuccess=()=>r(q.result);});
    try{const tx=db.transaction(["generatedCaches","productionGeneratedCaches","lockedProductionGeneratedCaches"],"readonly"),read=(s:string,id:string)=>new Promise<any>(r=>{const q=tx.objectStore(s).get(id);q.onsuccess=()=>r(q.result);});
      const [local,none,protectedOld]=await Promise.all([read("generatedCaches","old-local"),read("productionGeneratedCaches","old-none"),read("lockedProductionGeneratedCaches","old-none")]);
      return {version:db.version,local,none,protectedOld,assets:await assetRepository.list("old-project"),bytes:Array.from(new Uint8Array(await(await assetRepository.getBlob("old-none","original"))!.arrayBuffer()))};
    }finally{db.close();}
  });expect(r.version).toBe(5);expect(r.local).toEqual({assetId:"old-local",metadata:"keep-local"});expect(r.none).toEqual({assetId:"old-none",lineage:"keep-none"});expect(r.protectedOld).toBeUndefined();expect(r.bytes).toEqual([1,2,3]);expect(r.assets[0].id).toBe("old-none");expect(f.t.store.load()).toEqual(f.before);
});
test("390px protected read observation displays finite domain and unknown money without overflow",async({page})=>{
  await page.setViewportSize({width:390,height:844});const f=await fixture(page,{manual:true,cap:0});await f.cache();await f.panel.getByRole("button",{name:"只读保护原图谱系"}).click();
  await expect(f.panel.getByRole("article")).toContainText("固定autoOrient/sRGB/RGBA8域");await expect(f.panel.getByRole("article")).toContainText("实费 未测得");expect(await f.panel.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await page.screenshot({path:"test-results/locked-production-cache-390.png"});
});
test("daily App has no query/window/localStorage protection cache switch or default route",async({page})=>{
  await page.addInitScript(()=>{(window as any).lockedProductionGeneratedRead={lockedGeneratedReadUiEnabled:true,tenantId:"tenant-a",mode:"production"};localStorage.setItem("lockedProductionGeneratedRead",JSON.stringify((window as any).lockedProductionGeneratedRead));});
  await page.goto("/?lockedGeneratedReadUiEnabled=true&mode=production");await page.getByRole("button",{name:"任务与预算",exact:true}).click();await expect(page.getByRole("region",{name:"保护原图只读缓存"})).toHaveCount(0);
  const before=await(await page.request.get("/studio-api/v1/projects/project-main-image/budget",{headers:{"x-canvas-local":"1"}})).json();for(const kind of ["lineage","content"])expect((await page.request.get(`/studio-api/v1/projects/project-main-image/locked-production-generated-assets/unknown/${kind}`,{headers:{"x-canvas-local":"1"}})).status()).toBe(404);
  expect(await(await page.request.get("/studio-api/v1/projects/project-main-image/budget",{headers:{"x-canvas-local":"1"}})).json()).toEqual(before);expect(await(await page.request.get("/studio-api/health",{headers:{"x-canvas-local":"1"}})).json()).toMatchObject({realExecutorsEnabled:false});
});
