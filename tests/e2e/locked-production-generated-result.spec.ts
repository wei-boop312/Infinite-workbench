import { expect, test, type Page } from "@playwright/test";
import { ownedLockedGeneratedTask } from "../helpers/locked-generated-task";
import { createApiServer } from "../../apps/api/src/index";
test.use({serviceWorkers:"block"});
const cleanups:Array<()=>Promise<void>>=[];
test.afterEach(async()=>{for(const c of cleanups.splice(0))await c();});
const key="ai-commerce-canvas.document.owned-locked-result-doc";
async function saved(page:Page){await expect.poll(()=>page.evaluate(key=>localStorage.getItem(key),key)).not.toBeNull();return page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),key);}
const histories=async(page:Page)=>(await saved(page)).nodes.filter((n:any)=>n.data.lockedProductionGeneratedHistory);
async function fixture(page:Page,options:Parameters<typeof ownedLockedGeneratedTask>[0]={}){
  const t=await ownedLockedGeneratedTask(options),port=t.reader(),view=port.lineage(t.actor,"project-a",t.id),before=t.store.load();
  const inputs=[...view.requestDraft.inputs,view.requestDraft.mask!].map(r=>{const v=t.store.loadVerifiedImageBytes(t.actor.tenantId,"project-a",r.assetId)!;return {asset:v.receipt.asset,bytes:[...v.body]};});
  // Fixed actual same-store read service, not a client-supplied lineage port.
  const server=createApiServer({lockedProductionGeneratedAssets:port});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const a=server.address();if(!a||typeof a==="string")throw Error();const origin=`http://127.0.0.1:${a.port}`,requests:{method:string;path:string}[]=[];
  let hold=false,deny=false,reads=0,release:(()=>void)|undefined;
  cleanups.push(async()=>{hold=false;release?.();await page.unrouteAll({behavior:"wait"});server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));t.cleanup();});
  await page.addInitScript(constraint=>{
    localStorage.setItem("ai-commerce-canvas.imported-projects",JSON.stringify([{documentId:"owned-locked-result-doc",projectId:"project-a",label:"自有保护回流测试",importedAt:"2026-10-13T00:00:00Z"}]));
    localStorage.setItem("ai-commerce-canvas.active-document","owned-locked-result-doc");localStorage.setItem("ai-commerce-canvas.constraints.project-a",JSON.stringify([constraint]));
  },view.constraint);
  await page.route("**/src/main.tsx",async route=>{
    const r=await route.fetch(),original=await r.text(),body=original.replace("jsxDEV(App, {},",'jsxDEV(App, { lockedProductionGeneratedRead: { lockedGeneratedReadUiEnabled: true, tenantId: "tenant-a", mode: "production-contract-fixture" } },');
    if(body===original)throw Error("owned trusted App configuration injection failed");await route.fulfill({response:r,body});
  });
  await page.route(/\/studio-api\/v1\/projects\/[^/]+\/locked-production-generated-assets\/[^/]+\/(?:lineage|content)$/,async route=>{
    const path=new URL(route.request().url()).pathname.replace(/^\/studio-api/,"");requests.push({method:route.request().method(),path});
    if(path.endsWith("/lineage")){reads++;if(deny&&reads===2)t.denied.add("run:read");}
    const r=await route.fetch({url:origin+path,maxRedirects:0});
    if(hold&&path.endsWith("/lineage")&&reads===2)await new Promise<void>(resolve=>release=resolve);
    await route.fulfill({response:r});
  });
  await page.goto("/");
  await page.evaluate(async records=>{const {assetRepository}=await import("/src/assets/assetRepository.ts");await assetRepository.restore("project-a",records.map(r=>({asset:r.asset,original:new Blob([Uint8Array.from(r.bytes)],{type:r.asset.mimeType})})));},inputs);
  await page.reload();await page.getByRole("button",{name:"任务与预算",exact:true}).click();
  const panel=page.getByRole("region",{name:"保护原图只读缓存"});await expect(panel).toBeVisible();await panel.getByLabel("保护原图资产编号").fill(t.id);await saved(page);
  const cache=async()=>{await panel.getByRole("button",{name:"缓存保护原图",exact:true}).click();await expect(panel.getByRole("status")).toContainText("已缓存");};
  const put=async()=>{await panel.getByRole("button",{name:"核验保护原图并回画布",exact:true}).click();await expect(panel.getByRole("status")).toContainText("已受控回画布");await expect.poll(async()=>(await histories(page)).length).toBe(1);};
  const mark=()=>page.evaluate(async id=>{const q=indexedDB.open("ai-commerce-canvas-assets"),db=await new Promise<IDBDatabase>((r,j)=>{q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
    try{return await new Promise<any>((r,j)=>{const q=db.transaction("lockedProductionGeneratedCaches","readonly").objectStore("lockedProductionGeneratedCaches").get(id);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});}finally{db.close();}},t.id);
  return {t,view,id:t.id,before,inputs,requests,panel,cache,put,mark,hold:()=>{hold=true;reads=0;},denyFinal:()=>{deny=true;reads=0;},release:()=>{hold=false;release?.();},held:()=>!!release};
}
for(const protocol of ["openai","openai-compatible"] as const)for(const manual of [false,true])test(`protected ${protocol}/${manual} actual controlled graph/repeat/undo/redo/reload without task or budget writes`,async({page})=>{
  const f=await fixture(page,{protocol,manual});await f.cache();const original=await saved(page),reads=f.requests.length;await f.put();
  const first=(await histories(page))[0],h=first.data.lockedProductionGeneratedHistory;
  expect(h).toMatchObject({version:2,estimateState:manual?"unknown":"known",estimatedCostMinor:manual?null:25,maxCostMinor:40,reservedMinor:40,inputAssetIds:["source","mask"],protection:f.view.protection});
  expect(first.data.generatedHistory).toBeUndefined();expect(first.data.productionGeneratedHistory).toBeUndefined();expect((await saved(page)).nodes.length-original.nodes.length).toBe(5);
  expect(f.requests.length-reads).toBe(2);await f.put();expect((await histories(page))[0]).toEqual(first);
  await page.getByRole("button",{name:"关闭任务面板"}).click();await page.getByRole("button",{name:/撤销/}).click();await expect.poll(async()=>(await histories(page)).length).toBe(0);
  await page.getByRole("button",{name:/重做/}).click();await expect.poll(async()=>(await histories(page)).length).toBe(1);await page.reload();
  expect((await histories(page))[0].data.lockedProductionGeneratedHistory).toEqual(h);expect(f.t.store.load()).toEqual(f.before);expect(f.t.send.mock.calls.length).toBe(1);
  expect(f.requests.every(r=>r.method==="GET"&&/\/(lineage|content)$/.test(r.path))).toBe(true);const final=await saved(page);
  expect(JSON.stringify(final.nodes.filter((n:any)=>n.id.startsWith("locked-production-result-")))).not.toMatch(/Base64|blob:|credentialRef|executionKey|idempotencyKey|workerId|leaseId|rawResponse/);
  expect(JSON.stringify(final)).not.toMatch(/data:image\/[^"]+;base64,|blob:|"(?:credentialRef|executionKey|idempotencyKey|workerId|leaseId|rawResponse)"\s*:/);
});
test("protected multiple inputs/mask joint read, package two copies and historical input reference protection",async({page})=>{
  const f=await fixture(page,{manual:true,twoInputs:true});await f.cache();
  await page.evaluate(()=>{const get=IDBObjectStore.prototype.get;(window as any).__ownedGet=get;(window as any).__ownedReadTransactions=[];
    IDBObjectStore.prototype.get=function(q){const all=(window as any).__ownedReadTransactions;if(this.transaction.mode==="readonly")all.push({tx:this.transaction,key:q,store:this.name});return get.call(this,q);};});
  await f.put();const h=(await histories(page))[0].data.lockedProductionGeneratedHistory;expect(h.inputAssetIds).toEqual(["source","source-2","mask"]);
  const joint=await page.evaluate(id=>{const rows=(window as any).__ownedReadTransactions,output=rows.find((r:any)=>r.key===id&&r.store==="lockedProductionGeneratedCaches");
    IDBObjectStore.prototype.get=(window as any).__ownedGet;return ["source:original","source-2:original","mask:original",`${id}:original`,`${id}:proxy`].every(k=>rows.some((r:any)=>r.key===k&&r.tx===output.tx));},f.id);expect(joint).toBe(true);
  const copied=await page.evaluate(async()=>{
    const {createProjectPackage,parseProjectPackage,remapProjectPackage}=await import("/src/projects/projectPackage.ts"),{assetRepository}=await import("/src/assets/assetRepository.ts"),{constraintRepository}=await import("/src/constraints/constraintRepository.ts");
    const d=JSON.parse(localStorage.getItem("ai-commerce-canvas.document.owned-locked-result-doc")!),archive=await createProjectPackage({projectName:"owned",document:d,constraints:constraintRepository.list("project-a"),assets:await assetRepository.list("project-a")},(id,role)=>assetRepository.getBlob(id,role));
    const one=remapProjectPackage(await parseProjectPackage(archive),"copy-one-doc","copy-one-project"),two=remapProjectPackage(one,"copy-two-doc","copy-two-project");await assetRepository.restore("copy-two-project",two.assets);
    const h=two.document.nodes.find((n:any)=>n.data.lockedProductionGeneratedHistory)!.data.lockedProductionGeneratedHistory as any,q=indexedDB.open("ai-commerce-canvas-assets"),db=await new Promise<IDBDatabase>((r,j)=>{q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
    const tx=db.transaction(["lockedProductionGeneratedCaches","productionGeneratedCaches","generatedCaches"],"readonly"),read=(s:string)=>new Promise<any>((r,j)=>{const q=tx.objectStore(s).get(h.assetId);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
    const marks=await Promise.all(["lockedProductionGeneratedCaches","productionGeneratedCaches","generatedCaches"].map(read));db.close();
    const again=await parseProjectPackage(await createProjectPackage({projectName:"copied",document:two.document,constraints:two.constraints,assets:two.assets.map(a=>a.asset)},(id,role)=>assetRepository.getBlob(id,role)));
    return {h,marks,again:again.document.nodes.find((n:any)=>n.data.lockedProductionGeneratedHistory)!.data.lockedProductionGeneratedHistory};
  });
  expect(copied.h).toMatchObject({evidence:"imported-copy-history",originProjectId:"project-a",estimatedCostMinor:null,protection:h.protection});expect(copied.h.assetId).not.toBe(h.assetId);
  expect(copied.h.protectedSourceAssetId).toBe(copied.h.inputAssetIds[0]);expect(copied.h.protectedMaskAssetId).toBe(copied.h.inputAssetIds.at(-1));expect(copied.marks).toEqual([undefined,undefined,undefined]);expect(copied.again).toEqual(copied.h);
  await page.getByRole("button",{name:"关闭任务面板"}).click();await page.evaluate(key=>{const d=JSON.parse(localStorage.getItem(key)!),gone=d.nodes.filter((n:any)=>["source","source-2","mask"].includes(n.data.assetId)).map((n:any)=>n.id);d.nodes=d.nodes.filter((n:any)=>!gone.includes(n.id));d.edges=d.edges.filter((e:any)=>!gone.includes(e.source)&&!gone.includes(e.target));localStorage.setItem(key,JSON.stringify(d));},key);
  await page.reload();await page.getByRole("button",{name:/资产库/}).click();const lib=page.getByRole("complementary",{name:"项目资产库"});
  for(const input of f.inputs){const item=lib.locator("article").filter({hasText:input.asset.originalName});await expect(item.locator("button.remove")).toBeDisabled();await expect(item.locator("button.remove")).toHaveText(`使用中 ${input.asset.id==="source"?3:input.asset.id==="mask"?2:1}`);}
  expect(f.t.store.load()).toEqual(f.before);
});
for(const damage of ["not-cached","marker","local","none","output-bytes","proxy","output-meta","input-missing","input-sha","input-size","input-meta","mask-missing","mask-sha","mask-source","policy","proof","constraint","permission"] as const)test(`protected ${damage} return fails without partial graph or deleting lawful offline files`,async({page})=>{
  const f=await fixture(page);if(damage!=="not-cached")await f.cache();
  if(damage==="permission")f.t.denied.add("run:read");
  else if(damage==="constraint")await page.evaluate(()=>{const k="ai-commerce-canvas.constraints.project-a",c=JSON.parse(localStorage.getItem(k)!);c[0].brandRules={changed:"not-original"};localStorage.setItem(k,JSON.stringify(c));});
  else if(damage!=="not-cached")await page.evaluate(async({id,damage})=>{
    const q=indexedDB.open("ai-commerce-canvas-assets"),db=await new Promise<IDBDatabase>((r,j)=>{q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
    const tx=db.transaction(["assets","blobs","lockedProductionGeneratedCaches","productionGeneratedCaches","generatedCaches"],"readwrite"),done=new Promise<void>((r,j)=>{tx.oncomplete=()=>r();tx.onabort=()=>j(tx.error);});
    const read=(s:string,k:string)=>new Promise<any>((r,j)=>{const q=tx.objectStore(s).get(k);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
    if(["marker","local","none"].includes(damage)){tx.objectStore("lockedProductionGeneratedCaches").delete(id);if(damage!=="marker")tx.objectStore(damage==="local"?"generatedCaches":"productionGeneratedCaches").put({assetId:id,version:1});}
    if(damage==="input-missing"||damage==="mask-missing")tx.objectStore("blobs").delete(`${damage==="mask-missing"?"mask":"source"}:original`);
    if(["output-bytes","input-sha","mask-sha","proxy"].includes(damage)){const k=damage==="proxy"?`${id}:proxy`:`${damage==="output-bytes"?id:damage==="mask-sha"?"mask":"source"}:original`,b=await read("blobs",k);b.blob=new Blob([new Uint8Array(b.blob.size)],{type:b.blob.type});tx.objectStore("blobs").put(b);}
    if(["output-meta","input-size","input-meta","mask-source"].includes(damage)){const a=await read("assets",damage==="output-meta"?id:damage==="mask-source"?"mask":"source");if(damage==="input-size")a.width=3;else if(damage==="mask-source")a.sourceAssetId="foreign";else a.originalName="changed.png";tx.objectStore("assets").put(a);}
    if(damage==="policy"||damage==="proof"){const m=await read("lockedProductionGeneratedCaches",id);m.lineage.protection[damage==="policy"?"policyFingerprint":"pixelProofFingerprint"]="a".repeat(64);tx.objectStore("lockedProductionGeneratedCaches").put(m);}
    await done;db.close();
  },{id:f.id,damage});
  const original=await saved(page),reads=f.requests.length;await f.panel.getByRole("button",{name:"核验保护原图并回画布"}).click();await expect(f.panel.getByRole("alert")).toBeVisible();
  expect(await histories(page)).toHaveLength(0);expect((await saved(page)).nodes).toEqual(original.nodes);expect(f.requests.length-reads).toBeLessThanOrEqual(2);expect(f.t.store.load()).toEqual(f.before);
  if(damage!=="not-cached")expect(await page.evaluate(async id=>{const {assetRepository}=await import("/src/assets/assetRepository.ts");return (await assetRepository.getBlob(id,"original"))!.size;},f.id)).toBe(f.view.image.asset.byteSize);
});
for(const action of ["close","project","constraint-drift"] as const)test(`protected ${action} during final lineage discards late graph`,async({page})=>{
  const f=await fixture(page);await f.cache();f.hold();await f.panel.getByRole("button",{name:"核验保护原图并回画布"}).click();await expect.poll(f.held).toBe(true);
  if(action==="close")await page.getByRole("button",{name:"关闭任务面板"}).click();if(action==="project")await page.getByLabel("切换项目").selectOption("phase-1-campaign");
  if(action==="constraint-drift")await page.evaluate(()=>{const k="ai-commerce-canvas.constraints.project-a",c=JSON.parse(localStorage.getItem(k)!);c[0].brandRules={final:"changed"};localStorage.setItem(k,JSON.stringify(c));});
  f.release();if(action==="constraint-drift")await expect(f.panel.getByRole("alert")).toBeVisible();else if(action==="close")await expect(f.panel).toBeHidden();else{await expect(page.getByLabel("切换项目")).toHaveValue("phase-1-campaign");await expect(f.panel.getByRole("status")).toHaveCount(0);}
  expect(await histories(page)).toHaveLength(0);expect(f.t.store.load()).toEqual(f.before);
});
test("protected final actual server read after joint native input validation denies revoked permission",async({page})=>{
  const f=await fixture(page);await f.cache();f.denyFinal();const reads=f.requests.length;await f.panel.getByRole("button",{name:"核验保护原图并回画布"}).click();await expect(f.panel.getByRole("alert")).toBeVisible();
  expect(f.requests.length-reads).toBe(2);expect(await histories(page)).toHaveLength(0);expect(f.t.store.load()).toEqual(f.before);expect(await f.mark()).toBeTruthy();
});
for(const when of ["before","after"] as const)test(`protected actual different-person overage settlement ${when} first return preserves immutable history`,async({page})=>{
  const f=await fixture(page,{manual:true});await f.cache();const marker=await f.mark();if(when==="after")await f.put();const first=when==="after"?(await histories(page))[0]:undefined;f.t.settle(65);const settled=f.t.store.load();await f.put();
  if(when==="after")expect((await histories(page))[0]).toEqual(first);else expect((await histories(page))[0].data.lockedProductionGeneratedHistory).toMatchObject({estimatedCostMinor:null,actualMinor:65,reservedMinor:0,billingState:"settled",currentMaxCostMinor:65});
  await f.panel.getByRole("button",{name:"只读保护原图谱系"}).click();await expect(f.panel.getByRole("article")).toContainText("实费 CNY 65 最小单位");expect(await f.mark()).toEqual(marker);expect(f.t.store.load()).toEqual(settled);expect(f.t.send.mock.calls.length).toBe(1);
});
test("protected output deletion can be restored only after new joint permission without duplicate relations",async({page})=>{
  const f=await fixture(page);await f.cache();await f.put();const first=await saved(page);await page.getByRole("button",{name:"关闭任务面板"}).click();
  await page.evaluate(key=>{const d=JSON.parse(localStorage.getItem(key)!),id=d.nodes.find((n:any)=>n.data.lockedProductionGeneratedHistory).id;d.nodes=d.nodes.filter((n:any)=>n.id!==id);d.edges=d.edges.filter((e:any)=>e.source!==id&&e.target!==id);localStorage.setItem(key,JSON.stringify(d));},key);
  await page.reload();await page.getByRole("button",{name:"任务与预算",exact:true}).click();await f.panel.getByLabel("保护原图资产编号").fill(f.id);await f.put();
  expect((await saved(page)).nodes.length).toBe(first.nodes.length);expect((await saved(page)).edges.length).toBe(first.edges.length);expect(f.t.store.load()).toEqual(f.before);
});
test("protected zero-cap unknown return and 390px history remain explicit without overflow",async({page})=>{
  await page.setViewportSize({width:390,height:844});const f=await fixture(page,{manual:true,cap:0});await f.cache();await f.put();const h=(await histories(page))[0].data.lockedProductionGeneratedHistory;
  expect(h).toMatchObject({estimatedCostMinor:null,maxCostMinor:0,reservedMinor:0,billingState:"unknown"});expect(h.actualMinor).toBeUndefined();await page.getByRole("button",{name:"关闭任务面板"}).click();
  const inspector=page.getByRole("complementary",{name:"保护生产结果历史"});await expect(inspector).toContainText("未知（不是零费用）");await expect(inspector).toContainText(f.view.protection.pixelProofFingerprint);
  expect(await inspector.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:"test-results/locked-production-result-390.png"});expect(f.t.store.load()).toEqual(f.before);
});
