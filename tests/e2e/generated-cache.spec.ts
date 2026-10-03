import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
test.use({ serviceWorkers: "block" });
const sharp = createRequire(new URL("../../apps/api/package.json", import.meta.url))("sharp");
let png: Buffer;
test.beforeAll(async () => { png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#3070b0" } }).png().toBuffer(); });
const at="2026-10-04T00:00:00.000Z", id="generated-cache-browser";
// Public receipt/task/binary fixtures only. Actual server artifact authority was
// tested separately; this does NOT seed or enable a provider in the daily bridge.
async function prepare(page: Page, mode: "good"|"corrupt"|"denied"="good") {
  let projectId=""; const requests: {method:string;url:string}[]=[];
  const sum=createHash("sha256").update(png).digest("hex");
  const receipt=()=>({schemaVersion:1,id:"verification-browser",tenantId:"local-studio",registeredMetadataSha256:"0".repeat(64),checksumSha256:sum,
    decoder:"sharp-full-decode-v1",verifiedBy:"local-designer",verifiedAt:at,asset:{id,projectId,kind:"image",purpose:"generated",originalName:`${id}.png`,
      contentFingerprint:`sha256:${sum}`,storageKey:"local-verified:immutable-browser-fixture",mimeType:"image/png",byteSize:png.length,width:1024,height:1024,createdAt:at}});
  await page.route("**/studio-api/v1/projects/*/run-batches",async route=>{
    const response=await route.fetch(); projectId=decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
    const fixture={batch:{id:"cache-batch",tenantId:"local-studio",projectId,constraintSnapshotId:"fixture-constraint",tool:"image-generate",adapterId:"image-adapter",
      inputAssetIds:[],idempotencyKey:"cache-confirm",status:"billing_unknown",expectedOutputs:1,estimatedCostMinor:25,maxCostMinor:30,currency:"CNY",confirmedBy:"local-designer",confirmedAt:at,createdAt:at},
      jobs:[{id:"cache-job",batchId:"cache-batch",outputIndex:0,attempt:1,executorKind:"provider",adapterId:"image-adapter",idempotencyKey:"cache-execute",status:"billing_unknown",inputAssetIds:[],outputAssetIds:[id],estimatedCostMinor:25,createdAt:at}],ledger:[],audit:[],billingOverages:[]};
    await route.fulfill({response,json:[fixture,...await response.json()]});
  });
  await page.route(`**/studio-api/v1/projects/*/assets/${id}/verification`,async route=>{
    requests.push({method:route.request().method(),url:route.request().url()}); await route.fulfill({json:receipt(),headers:{"cache-control":"no-store"}});
  });
  await page.route(`**/studio-api/v1/projects/*/generated-assets/${id}/content`,async route=>{
    requests.push({method:route.request().method(),url:route.request().url()});
    await route.fulfill(mode==="denied" ? {status:403,json:{error:"denied"},headers:{"cache-control":"private, no-store"}} : {status:200,body:mode==="corrupt"?Buffer.alloc(png.length):png,
      headers:{"cache-control":"private, no-store","content-type":"image/png","content-length":String(png.length),"x-content-sha256":sum,"x-canvas-binary-version":"generated-image-v1"}});
  });
  await page.goto("/"); await page.getByLabel("导入本地资产").setInputFiles({name:"source.png",mimeType:"image/png",buffer:png});
  await expect(page.getByRole("button",{name:"资产库 1"})).toBeVisible(); await page.getByRole("button",{name:"关闭资产库"}).click();
  await page.getByRole("button",{name:"任务与预算",exact:true}).click(); const panel=page.getByRole("complementary",{name:"任务与预算"});
  await expect(panel.getByRole("button",{name:"缓存输出 1 原图"})).toBeEnabled();
  return {panel,requests,receipt,getProject:()=>projectId};
}
async function readCache(page: Page, projectId: string) {
  return page.evaluate(async ({projectId,id})=>{
    const {assetRepository}=await import("/src/assets/assetRepository.ts"); const assets=await assetRepository.list(projectId),original=await assetRepository.getBlob(id,"original"),proxy=await assetRepository.getBlob(id,"proxy");
    const sum=original?Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await original.arrayBuffer())),b=>b.toString(16).padStart(2,"0")).join(""):null;
    return {assets,originalSize:original?.size??0,originalType:original?.type,proxySize:proxy?.size??0,sum};
  },{projectId,id});
}
test("生成原图和本地代理原子缓存、刷新/重放/项目包保留不可变编号，不改画布或预算",async ({page})=>{
  const f=await prepare(page),beforeNodes=await page.locator(".react-flow__node").count();
  const budgetPath=`/studio-api/v1/projects/${encodeURIComponent(f.getProject())}/budget`,readOptions={headers:{"x-canvas-local":"1"}};
  const budgetBefore=await (await page.request.get(budgetPath,readOptions)).json();
  await f.panel.getByRole("button",{name:"缓存输出 1 原图"}).click(); await expect(f.panel).toContainText("原文件已缓存到项目资产库"); await expect(page.getByRole("button",{name:"资产库 2"})).toBeVisible();
  const cached=await readCache(page,f.getProject()); expect(cached.assets.find(a=>a.id===id)).toEqual(f.receipt().asset); expect(cached.originalSize).toBe(png.length); expect(cached.proxySize).toBeGreaterThan(0); expect(cached.sum).toBe(f.receipt().checksumSha256);
  expect(cached.assets.find(a=>a.id===id)?.proxyStorageKey).toBeUndefined(); expect(await page.locator(".react-flow__node").count()).toBe(beforeNodes); await expect(f.panel).toContainText("预留 ¥0.30");
  const reimport=await page.evaluate(async({projectId,body})=>{const {assetRepository}=await import("/src/assets/assetRepository.ts");return assetRepository.importFiles(projectId,[new File([Uint8Array.from(atob(body),c=>c.charCodeAt(0))],"source-again.png",{type:"image/png"})]);},{projectId:f.getProject(),body:png.toString("base64")});
  expect(reimport.assets[0].purpose).toBe("source");expect(reimport.assets[0].id).not.toBe(id);expect((await readCache(page,f.getProject())).assets).toHaveLength(2);
  await f.panel.getByRole("button",{name:"缓存输出 1 原图"}).click(); await expect(f.panel).toContainText("原文件已缓存到项目资产库"); expect((await readCache(page,f.getProject())).assets).toHaveLength(2); expect(f.requests.every(r=>r.method==="GET")).toBe(true);
  await page.reload(); await page.getByRole("button",{name:"资产库 2"}).click(); const library=page.getByRole("complementary",{name:"项目资产库"}),card=library.locator("article").filter({hasText:`${id}.png`});
  await expect(card.locator("img")).toBeVisible(); await expect(card.getByRole("button",{name:"添加到画布"})).toBeDisabled();
  const portable=await page.evaluate(async ({projectId})=>{
    const {assetRepository}=await import("/src/assets/assetRepository.ts"),{createProjectPackage,parseProjectPackage,remapProjectPackage}=await import("/src/projects/projectPackage.ts");
    const document={schemaVersion:2,id:"cache-document",projectId,revision:0,nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},updatedAt:"2026-10-04T00:00:00Z"};
    const archive=await createProjectPackage({projectName:"cache-fixture",document,constraints:[],assets:await assetRepository.list(projectId)},(id,role)=>assetRepository.getBlob(id,role));
    const parsed=await parseProjectPackage(archive),remapped=remapProjectPackage(parsed,"copy-doc","copy-project");return {asset:parsed.assets.find(r=>r.asset.purpose==="generated")!.asset,size:parsed.assets.find(r=>r.asset.purpose==="generated")!.original.size,copyId:remapped.assets.find(r=>r.asset.purpose==="generated")!.asset.id};
  },{projectId:f.getProject()}); expect(portable.asset).toEqual(f.receipt().asset);expect(portable.size).toBe(png.length);expect(portable.copyId).not.toBe(id);
  expect(await (await page.request.get(budgetPath,readOptions)).json()).toEqual(budgetBefore);
  expect(await (await page.request.get("/studio-api/health",readOptions)).json()).toMatchObject({realExecutorsEnabled:false,generatedAssetReadEnabled:true});
});
for(const mode of ["corrupt","denied"] as const)test(`生成图片${mode}响应不缓存、不造节点或自动重试`,async({page})=>{
  const f=await prepare(page,mode),before=await page.locator(".react-flow__node").count();await f.panel.getByRole("button",{name:"缓存输出 1 原图"}).click();
  await expect(f.panel.getByRole("alert")).toBeVisible();const cached=await readCache(page,f.getProject());expect(cached.assets).toHaveLength(1);expect(cached.originalSize).toBe(0);expect(cached.proxySize).toBe(0);expect(f.requests).toHaveLength(2);expect(await page.locator(".react-flow__node").count()).toBe(before);await expect(f.panel).toContainText("预留 ¥0.30");
});
test("IndexedDB写入后故障回滚元数据/原图/代理/标记，人工再缓存可恢复",async({page})=>{
  const f=await prepare(page);await page.evaluate(()=>{const original=IDBObjectStore.prototype.put;(window as any).__cachePut=original;IDBObjectStore.prototype.put=function(value,...args){if(this.name==="blobs"&&value.assetId==="generated-cache-browser")throw new Error("fixture-write-failure");return original.call(this,value,...args);};});
  await f.panel.getByRole("button",{name:"缓存输出 1 原图"}).click();await expect(f.panel.getByRole("alert")).toContainText("fixture-write-failure");expect((await readCache(page,f.getProject())).assets).toHaveLength(1);expect((await readCache(page,f.getProject())).originalSize).toBe(0);
  await page.evaluate(()=>{IDBObjectStore.prototype.put=(window as any).__cachePut;});await f.panel.getByRole("button",{name:"缓存输出 1 原图"}).click();await expect(f.panel).toContainText("原文件已缓存到项目资产库");expect((await readCache(page,f.getProject())).assets).toHaveLength(2);
});
test("同assetId的其他项目记录不被覆盖；事务取消不留半条生成资产",async({page})=>{
  const f=await prepare(page);const result=await page.evaluate(async({receipt,body})=>{
    const {assetRepository}=await import("/src/assets/assetRepository.ts");const original=new Blob([Uint8Array.from(atob(body),c=>c.charCodeAt(0))],{type:"image/png"});
    const foreign={...receipt.asset,projectId:"foreign-project"};await assetRepository.restore("foreign-project",[{asset:foreign,original}]);
    let conflict="";try{await assetRepository.cacheGenerated(receipt,original,new AbortController().signal);}catch(e){conflict=String(e);}
    const foreignAfter=(await assetRepository.list("foreign-project"))[0];await assetRepository.remove("foreign-project",receipt.asset.id);
    const c=new AbortController(),put=IDBObjectStore.prototype.put;let aborted="";
    IDBObjectStore.prototype.put=function(value,...args){if(this.name==="blobs"&&value.assetId===receipt.asset.id)c.abort();return put.call(this,value,...args);};
    try{await assetRepository.cacheGenerated(receipt,original,c.signal);}catch(e){aborted=String(e);}finally{IDBObjectStore.prototype.put=put;}
    return {conflict,foreignAfter,aborted,assets:await assetRepository.list(receipt.asset.projectId),original:!!await assetRepository.getBlob(receipt.asset.id,"original"),proxy:!!await assetRepository.getBlob(receipt.asset.id,"proxy")};
  },{receipt:f.receipt(),body:png.toString("base64")});expect(result.conflict).toContain("冲突");expect(result.foreignAfter.projectId).toBe("foreign-project");expect(result.aborted).not.toBe("");expect(result.assets).toHaveLength(1);expect(result.original).toBe(false);expect(result.proxy).toBe(false);
});

for(const format of ["jpeg","webp"] as const)test(`${format}原文件保留真实尺寸/格式，尺寸伪报不留缓存`,async({page})=>{
  const f=await prepare(page),body=await sharp(png)[format]().toBuffer(),sum=createHash("sha256").update(body).digest("hex"),r=f.receipt();
  const receipt={...r,checksumSha256:sum,asset:{...r.asset,id:`generated-${format}`,mimeType:`image/${format}`,originalName:`generated.${format}`,byteSize:body.length,contentFingerprint:`sha256:${sum}`}};
  const result=await page.evaluate(async({receipt,body})=>{
    const {assetRepository}=await import("/src/assets/assetRepository.ts"),blob=new Blob([Uint8Array.from(atob(body),c=>c.charCodeAt(0))],{type:receipt.asset.mimeType});
    const asset=await assetRepository.cacheGenerated(receipt,blob,new AbortController().signal);let bad="";
    try{await assetRepository.cacheGenerated({...receipt,asset:{...receipt.asset,id:"generated-fake-size",width:512}},blob,new AbortController().signal);}catch(e){bad=String(e);}
    const original=await assetRepository.getBlob(asset.id,"original"),proxy=await assetRepository.getBlob(asset.id,"proxy");return {asset,size:original?.size,type:original?.type,proxy:!!proxy,bad,badAsset:(await assetRepository.list(asset.projectId)).find(a=>a.id==="generated-fake-size")};
  },{receipt,body:body.toString("base64")});expect(result.asset).toEqual(receipt.asset);expect(result.size).toBe(body.length);expect(result.type).toBe(`image/${format}`);expect(result.proxy).toBe(true);expect(result.bad).toContain("实际尺寸");expect(result.badAsset).toBeUndefined();
});

test("v2资产库增量升级保留旧元数据/原文件；并发重放与同内容独立输出不混号",async({page})=>{
  await page.addInitScript(()=>{const request=indexedDB.open("ai-commerce-canvas-assets",2);request.onupgradeneeded=()=>{const db=request.result,a=db.createObjectStore("assets",{keyPath:"id"});a.createIndex("projectId","projectId");a.createIndex("projectFingerprint",["projectId","contentFingerprint"]);const b=db.createObjectStore("blobs",{keyPath:"key"});b.createIndex("assetId","assetId");};request.onsuccess=()=>{const db=request.result,t=db.transaction(["assets","blobs"],"readwrite");t.objectStore("assets").put({id:"legacy-v2",projectId:"legacy-project",kind:"image",purpose:"source",originalName:"legacy.png",storageKey:"indexeddb://legacy",mimeType:"image/png",byteSize:3,createdAt:"2026-09-27T00:00:00Z"});t.objectStore("blobs").put({key:"legacy-v2:original",assetId:"legacy-v2",role:"original",blob:new Blob([new Uint8Array([1,2,3])],{type:"image/png"})});t.oncomplete=()=>db.close();};});
  const f=await prepare(page);const result=await page.evaluate(async({receipt,body})=>{
    const {assetRepository}=await import("/src/assets/assetRepository.ts"),blob=new Blob([Uint8Array.from(atob(body),c=>c.charCodeAt(0))],{type:"image/png"});
    const [first,second]=await Promise.all([assetRepository.cacheGenerated(receipt,blob,new AbortController().signal),assetRepository.cacheGenerated(receipt,blob,new AbortController().signal)]);
    await assetRepository.cacheGenerated({...receipt,asset:{...receipt.asset,id:"generated-independent"}},blob,new AbortController().signal);
    return {ids:[first.id,second.id],assets:await assetRepository.list(receipt.asset.projectId),legacy:await assetRepository.list("legacy-project"),legacyBytes:Array.from(new Uint8Array(await (await assetRepository.getBlob("legacy-v2","original"))!.arrayBuffer()))};
  },{receipt:f.receipt(),body:png.toString("base64")});expect(result.ids).toEqual([id,id]);expect(result.assets).toHaveLength(3);expect(result.assets.filter(a=>a.purpose==="generated").map(a=>a.id).sort()).toEqual([id,"generated-independent"].sort());expect(result.legacy[0]).toMatchObject({id:"legacy-v2",storageKey:"indexeddb://legacy",byteSize:3});expect(result.legacyBytes).toEqual([1,2,3]);
});
