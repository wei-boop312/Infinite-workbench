import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LockedProductionImageArtifactSchema, ProductionImageArtifactSchema } from "../packages/contracts/src/index";
import { LockedImageProductionArtifactHarness, LockedProductionImageTaskArtifacts } from "../apps/api/src/lockedProductionImageTaskArtifacts";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { createLockedProductionImageLeaseFixturePolicy } from "../apps/api/src/lockedProductionImageLeasePolicy";
import { LockedImageProductionReconstructionHarness } from "../apps/api/src/lockedProductionImageTaskReconstruction";
import { imageSnapshotFingerprint as fp } from "../apps/api/src/imageProviderContract";
import { assertLockedProductionImageArtifact } from "../apps/api/src/lockedProductionImageArtifactIntegrity";
import { prepareLockedTaskFixture, lockedResponse } from "./helpers/locked-production-task-fixture";
import { principal, sha } from "./helpers/image-task-fixture";
import * as decoder from "../apps/api/src/staticImageDecoder";
import * as protocol from "../apps/api/src/lockedProductionImageProtocol";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
let source: Buffer, mask: Buffer, edited: Buffer;
const owned: { cleanup(): void }[] = [], stores: SqliteRunKernelStateStore[] = [];
beforeAll(async () => {
  const png = (bytes: number[]) => sharp(Buffer.from(bytes), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  source = await png([40,70,90,255,10,20,30,255]); mask = await png([255,255,255,0,255,255,255,255]); edited = await png([40,70,90,255,1,2,3,255]);
});
afterEach(() => { vi.restoreAllMocks(); for (const s of stores.splice(0).reverse()) s.close(); for (const f of owned.splice(0).reverse()) f.cleanup(); });
function db(path: string, action: (d: DatabaseSync) => void) { const d = new DatabaseSync(path); try { action(d); } finally { d.close(); } }
async function fixture(opts: Parameters<typeof prepareLockedTaskFixture>[2] = {}, candidate?: Buffer, onScope?: () => unknown) {
  let artifact: LockedImageProductionArtifactHarness; let allowed: unknown = true;
  const policy = { usesStateStore: (s: unknown) => artifact.usesStateStore(s), authorizeScope: (p: typeof principal, j: string) => artifact.authorizeScope(p,j),
    validateCommit: (p: typeof principal, r: any) => artifact.validateCommit(p,r) };
  const f = await prepareLockedTaskFixture(source, mask, { ...opts, send: async () => lockedResponse(candidate ?? edited), kernel: { lockedProductionImageArtifactPolicy: policy } }); owned.push(f);
  const options = { lockedArtifactEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, clock: f.clock,
    runAuthorizer: f.authorizer, providerAuthorizer: f.authorizer, assetAuthorizer: f.authorizer, lockedArtifactPolicy: () => (onScope ? onScope() : allowed) as boolean };
  artifact = new LockedImageProductionArtifactHarness(options);
  await f.execute();
  const args = [principal, "project-a", f.v.batchId, f.v.jobId, f.input] as const;
  const ingest = (signal?: AbortSignal) => artifact.ingest(...args, signal);
  return { ...f, artifact, options, args, ingest, policy, artifactAllow: (v: unknown) => { allowed = v; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function state(t: Fixture) { return t.store.load()!.batches[0]; }
function invariant(t: Fixture, before: unknown) {
  expect(t.store.load()).toEqual(before);
  expect(t.store.loadLockedProductionImageArtifact(principal.tenantId,"project-a","production-contract-fixture",t.v.jobId)).toBeNull();
  expect(t.store.loadCatalog()!.projects[0].assets.map(a=>a.id)).toEqual(["source","mask"]);
}
describe.each([
  ["openai",undefined,false], ["openai",undefined,true], ["openai-compatible","json-images",false],
  ["openai-compatible","json-images",true], ["openai-compatible","multipart-image-array",true], ["openai-compatible","multipart-image-single",false],
] as const)("actual locked artifact %s/%s/manual=%s", (p, encoding, manual) => {
  let t: Fixture;
  beforeEach(async () => { t = await fixture({ protocol:p, encoding, manual }); });
  it("保留原输出字节/完整像素证据，unknown/max不结算", async () => {
    const before=state(t), r=await t.ingest(); expect(LockedProductionImageArtifactSchema.parse(r)).toEqual(r);
    expect(ProductionImageArtifactSchema.safeParse(r).success).toBe(false);
    const s=state(t); expect(s.lockedProductionImageArtifact).toEqual(r); expect(s.lockedProductionImageArtifactFingerprint).toBe(fp(r));
    expect(r.draft.pixelProof).toMatchObject({ lockedPixels:1,editablePixels:1,lockedPixelsEqual:true,candidateChecksumSha256:sha(edited) });
    expect(r.draft.pixelProof.sourcePixelsSha256).toBe(t.preparation.protectionPolicy.sourcePixelsSha256);
    expect(r.draft.money.estimate).toEqual(manual ? {state:"unknown"} : {state:"known",estimatedCostMinor:25});
    expect(s.aggregate.jobs[0]).toMatchObject({ status:"billing_unknown",outputAssetIds:[r.image.asset.id] });
    expect(s.aggregate.ledger).toEqual(before.aggregate.ledger); expect(s.reservedMinor).toBe(40); expect(s.actualMinor).toBe(0);
    expect(s.lockedProductionImageResult).toEqual(before.lockedProductionImageResult); expect(s.lockedProductionImageExecution).toEqual(before.lockedProductionImageExecution);
    const b=t.store.loadVerifiedImageBytes(principal.tenantId,"project-a",r.image.asset.id)!;
    try {expect(b.body).toEqual(edited);} finally {b.body.fill(0);}
    expect(t.send).toHaveBeenCalledTimes(1); expect(source.some(n=>n!==0)).toBe(true); expect(mask.some(n=>n!==0)).toBe(true);
  });
});
describe("locked actual artifact failure/recovery", () => {
  let t: Fixture;
  beforeEach(async () => {t=await fixture({manual:true});});
  it.each(["run:read","run:execute","provider:read","asset:read","asset:write"])("%s私有读取前拒绝", async permission => {
    const before=t.store.load(), read=vi.spyOn(t.store,"load"); t.deny(permission); await expect(t.ingest()).rejects.toMatchObject({status:403}); expect(read).not.toHaveBeenCalled(); read.mockRestore(); invariant(t,before);
  });
  it.each([false,Promise.resolve(true),undefined,"true"])("独立同步政策严格true %s", async value => {
    const before=t.store.load(); t.artifactAllow(value); await expect(t.ingest()).rejects.toMatchObject({status:403}); t.artifactAllow(true); invariant(t,before);
  });
  it("默认/错库/错mode均关闭", async () => {
    const before=t.store.load(); await expect(new LockedProductionImageTaskArtifacts().ingest(...t.args)).rejects.toMatchObject({status:503});
    const other=new SqliteRunKernelStateStore(":memory:",{productionArtifactStorageEnabled:true,productionResponseStorageEnabled:true}); stores.push(other);
    await expect(new LockedImageProductionArtifactHarness({...t.options,stateStore:other}).ingest(...t.args)).rejects.toMatchObject({status:403});
    await expect(new LockedProductionImageTaskArtifacts(t.options).ingest(...t.args)).rejects.toMatchObject({code:"locked_artifact_mode_mismatch"}); invariant(t,before);
  });
  it("只读确认历史独立权限、合法产物保持原确认", async () => {
    await t.ingest(); const before=t.store.load(); t.deny("run:execute"); t.deny("asset:write"); t.deny("run:confirm"); t.deny("run:create");
    const read=t.service.getConfirmation({...principal,actorId:"reader"},"project-a",t.preparation.id);
    expect(read).toMatchObject({confirmedBy:"writer",status:"billing_unknown",estimatedCostMinor:null,reservedMinor:40}); expect(t.store.load()).toEqual(before);
  });
  it("重复并发/重启只恢复，不解码/报价/协议重建/发送/写入", async () => {
    const [a,b]=await Promise.all([t.ingest(),t.ingest()]); expect(a).toEqual(b); const before=t.store.load();
    const decode=vi.spyOn(decoder,"decodeStaticImagePixels"), wire=vi.spyOn(protocol,"prepareLockedProductionImageProtocol"), save=vi.spyOn(t.store,"save");
    t.advance(90000); const disabled={...t.config,revision:2,enabled:false}; t.register(disabled); save.mockClear(); t.pricePort.read.mockClear();t.pricePort.verify.mockClear();
    expect(await t.ingest()).toEqual(a); expect(decode).not.toHaveBeenCalled();expect(wire).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
    expect(t.pricePort.read).not.toHaveBeenCalled();expect(t.pricePort.verify).not.toHaveBeenCalled();expect(t.send).toHaveBeenCalledTimes(1);
    const s=new SqliteRunKernelStateStore(t.path,{productionResponseStorageEnabled:true,productionArtifactStorageEnabled:true});stores.push(s);
    // Actual second connection and actual configured kernel; no fabricated task snapshot.
    const lease=createLockedProductionImageLeaseFixturePolicy({...t.leaseOptions,stateStore:s});
    let reconstruction: LockedImageProductionReconstructionHarness, artifact: LockedImageProductionArtifactHarness;
    const k=new SqliteRunKernel({...((t.kernel as any).options),stateStore:s,lockedProductionImageLeasePolicy:lease,
      lockedProductionImageStartPolicy:{usesStateStore:x=>reconstruction.usesStateStore(x),authorizeScope:(p,j)=>reconstruction.authorizeScope(p,j),validateStart:(...args)=>reconstruction.validateStart(...args)},
      lockedProductionImageResponsePolicy:{usesStateStore:x=>reconstruction.responsePolicy.usesStateStore(x),authorizeScope:(p,j)=>reconstruction.responsePolicy.authorizeScope(p,j),
        validateAttempt:(...args)=>reconstruction.responsePolicy.validateAttempt(...args),validateResult:(...args)=>reconstruction.responsePolicy.validateResult(...args)},
      lockedProductionImageArtifactPolicy:{usesStateStore:x=>artifact.usesStateStore(x),authorizeScope:(p,j)=>artifact.authorizeScope(p,j),validateCommit:(p,r)=>artifact.validateCommit(p,r)}});
    reconstruction=new LockedImageProductionReconstructionHarness({...t.rebuildOptions,stateStore:s,runKernel:k,leasePolicy:lease});
    artifact=new LockedImageProductionArtifactHarness({...t.options,stateStore:s,runKernel:k});
    expect(await artifact.ingest(...t.args)).toEqual(a);expect(s.load()).toEqual(before);
    expect(decode).not.toHaveBeenCalled();expect(wire).not.toHaveBeenCalled();expect(t.send).toHaveBeenCalledTimes(1);
  });
  it("关闭pending后内核直接重放拒绝，schema和A草稿不是许可", async () => {
    const r=await t.ingest(),before=t.store.load(); expect(t.artifact.validateCommit(principal,r)).toBe(false);
    expect(()=>t.kernel.attachLockedProductionImageArtifact(...t.args,r)).toThrow();expect(t.store.load()).toEqual(before);
  });
  it.each([0,1,2,3])("锁区RGBA通道%s差异拒绝，raw/unknown/max保留", async channel => {
    const raw=[40,70,90,255,1,2,3,255];raw[channel]--;const candidate=await sharp(Buffer.from(raw),{raw:{width:2,height:1,channels:4}}).png().toBuffer();
    const f=await fixture({manual:true},candidate), before=f.store.load();await expect(f.ingest()).rejects.toMatchObject({code:"image_locked_pixels_changed"});invariant(f,before);
  });
  it.each(["cancel","permission","constraint","clock"])("异步像素返回后%s复查", async kind => {
    const before=t.store.load(), original=decoder.decodeStaticImagePixels;let called=0;
    vi.spyOn(decoder,"decodeStaticImagePixels").mockImplementation(async (...args) => {
      const r=await original(...args);if(++called===3){if(kind==="cancel") controller.abort();if(kind==="permission")t.deny("asset:write");
        if(kind==="clock")t.advance(5000);if(kind==="constraint")t.store.transaction(()=>{const c=t.store.loadCatalog()!;c.projects[0].constraints[0].brandRules.style="changed";t.store.saveCatalog(c);});}return r;
    });const controller=new AbortController();await expect(t.ingest(controller.signal)).rejects.toBeDefined();
    expect(t.store.load()).toEqual(before);expect(t.store.loadLockedProductionImageArtifact(principal.tenantId,"project-a","production-contract-fixture",t.v.jobId)).toBeNull();
  });
  it.each([1,2,3])("实际SQL产物写%s后撤权整笔回滚", async stage => {
    const before=t.store.load(), binary=t.store.localImageBinaryBytes(principal.tenantId,"project-a"), original=t.store.saveLockedProductionImageArtifact.bind(t.store);
    vi.spyOn(t.store,"saveLockedProductionImageArtifact").mockImplementation((r,b,l,after)=>{let n=0;return original(r,b,l,()=>{if(++n===stage)t.deny("asset:write");after();});});
    await expect(t.ingest()).rejects.toBeDefined();invariant(t,before);expect(t.store.localImageBinaryBytes(principal.tenantId,"project-a")).toBe(binary);
  });
  it.each(["catalog","task"])("实际%s保存后漂移回滚", async kind => {
    const before=t.store.load(), method=kind==="catalog" ? "saveCatalog" : "save", original=(t.store[method] as Function).bind(t.store);
    vi.spyOn(t.store,method).mockImplementation((value:any)=>{original(value);t.deny("asset:write");});await expect(t.ingest()).rejects.toBeDefined();invariant(t,before);
  });
  it.each(["metadata","binary"])("%s容量不足不删除旧历史", async kind => {
    const before=t.store.load(), service=new LockedImageProductionArtifactHarness({...t.options,[kind==="metadata"?"maxMetadataBytes":"maxProjectBytes"]:1});
    await expect(service.ingest(...t.args)).rejects.toBeDefined();invariant(t,before);
  });
  it.each(["production_image_artifacts","production_image_artifact_presence"])("%s实际SQL故障回滚", async table => {
    const before=t.store.load();db(t.path,d=>d.exec(`CREATE TRIGGER owned_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'owned'); END`));
    await expect(t.ingest()).rejects.toBeDefined();invariant(t,before);
  });
  it.each(["marker","blob","task-artifact","task-result","proof","audit","catalog"])("完整恢复损坏%s拒绝", async kind => {
    const r=await t.ingest();
    if(kind==="marker")db(t.path,d=>d.exec("DELETE FROM production_image_artifact_presence"));
    if(kind==="blob")db(t.path,d=>d.prepare("UPDATE verified_images SET body=? WHERE asset_id=?").run(Buffer.from("bad"),r.image.asset.id));
    if(kind==="proof")db(t.path,d=>{const a=structuredClone(r);a.draft.pixelProof.sourcePixelsSha256="0".repeat(64);a.draftFingerprint=fp(a.draft);const p=JSON.stringify(a);d.prepare("UPDATE production_image_artifacts SET record=?,record_sha256=?").run(p,sha(Buffer.from(p)));d.prepare("UPDATE production_image_artifact_presence SET record_sha256=?").run(sha(Buffer.from(p)));});
    if(["task-artifact","task-result","audit"].includes(kind))t.store.transaction(()=>{const s=t.store.load()!,b=s.batches[0];
      if(kind==="task-artifact"){delete b.lockedProductionImageArtifact;delete b.lockedProductionImageArtifactFingerprint;b.aggregate.jobs[0].outputAssetIds=[];b.aggregate.audit=b.aggregate.audit.filter(a=>a.eventType!=="production-image-artifact-verified");}
      if(kind==="task-result"){delete b.lockedProductionImageResult;delete b.lockedProductionImageResultFingerprint;}
      if(kind==="audit")b.aggregate.audit=b.aggregate.audit.filter(a=>a.eventType!=="production-image-artifact-verified");t.store.save(s);});
    if(kind==="catalog")t.store.transaction(()=>{const c=t.store.loadCatalog()!;c.projects[0].assets=c.projects[0].assets.filter(a=>a.id!==r.image.asset.id);t.store.saveCatalog(c);});
    await expect(t.ingest()).rejects.toBeDefined();expect(()=>t.service.getConfirmation(principal,"project-a",t.preparation.id)).toThrow();
  });
  it("zero-cap unknown估价和实费不补0", async () => {
    const z=await fixture({manual:true,cap:0}),r=await z.ingest();expect(r.draft.money.estimate).toEqual({state:"unknown"});
    expect(state(z).aggregate.jobs[0].actualCostMinor).toBeUndefined();expect(state(z).jobReservations).toEqual([[z.v.jobId,0]]);
  });
  it("所有自有原图/wire/raw/候选副本尽力清零，不清供应商和调用者材料", async () => {
    const copies: Buffer[]=[], original=t.store.loadVerifiedImageBytes.bind(t.store);
    vi.spyOn(t.store,"loadVerifiedImageBytes").mockImplementation((...args)=>{const r=original(...args);if(r)copies.push(r.body);return r;});
    const r=await t.ingest();expect(copies.length).toBeGreaterThan(0);expect(copies.every(b=>b.every(n=>n===0))).toBe(true);
    expect(source.some(n=>n!==0)).toBe(true);expect(edited.some(n=>n!==0)).toBe(true);expect(assertLockedProductionImageArtifact(state(t),r)).toEqual(r);
  });
  it.each(["store","lease","artifact","usesStateStore"])("await期间实际%s配置不可替换", async kind => {
    const before=t.store.load(), real=protocol.prepareLockedProductionImageProtocol;
    vi.spyOn(protocol,"prepareLockedProductionImageProtocol").mockImplementation(async(...args)=>{const r=await real(...args),o=(t.kernel as any).options;
      if(kind==="store")o.stateStore={...o.stateStore};if(kind==="lease")o.lockedProductionImageLeasePolicy={...o.lockedProductionImageLeasePolicy};
      if(kind==="artifact")o.lockedProductionImageArtifactPolicy={...o.lockedProductionImageArtifactPolicy};return r;});
    if(kind==="usesStateStore")vi.spyOn(protocol,"prepareLockedProductionImageProtocol").mockImplementation(async(...args)=>{const r=await real(...args);(t.kernel as any).options.lockedProductionImageArtifactPolicy.usesStateStore=()=>true;return r;});
    await expect(t.ingest()).rejects.toMatchObject({code:"locked_artifact_configuration_changed"});invariant(t,before);
  });
  it.each(["sourcePixelsSha256","maskPixelsSha256","lockedPixels","candidateChecksumSha256"])("纯草稿%s改动不能成为任务保护证据", async field => {
    const r=await t.ingest(),a:any=structuredClone(r);
    a.draft.pixelProof[field]=field==="lockedPixels"?2:"0".repeat(64);a.draftFingerprint=fp(a.draft);
    expect(()=>assertLockedProductionImageArtifact(state(t),a)).toThrow();
  });
  it("权威声明64MiB读前拒绝，不先获取大BLOB", async () => {
    t.store.transaction(()=>{const c=t.store.loadCatalog()!;c.projects[0].assets[0].byteSize=31*1024*1024;t.store.saveCatalog(c);});
    const read=vi.spyOn(t.store,"loadVerifiedImageBytes");await expect(t.ingest()).rejects.toBeDefined();expect(read).not.toHaveBeenCalled();
  });
  it.each(["raw","input"])("原%s读取中权威约束漂移受测副作用整体回滚", async kind => {
    const before=t.store.load(),catalog=t.store.loadCatalog(),method=kind==="raw"?"loadLockedProductionImageResponse":"loadVerifiedImageBytes",real=(t.store[method] as Function).bind(t.store);let once=false;
    vi.spyOn(t.store,method).mockImplementation((...args:any[])=>{const r=real(...args);if(!once){once=true;const c=t.store.loadCatalog()!;c.projects[0].constraints[0].brandRules.style="drift";t.store.saveCatalog(c);}return r;});
    await expect(t.ingest()).rejects.toBeDefined();expect(t.store.load()).toEqual(before);expect(t.store.loadCatalog()).toEqual(catalog);
  });
  it.each([NaN,-1,Infinity])("首无效时钟%s关闭且不泄漏槽", async clockValue => {
    const service=new LockedImageProductionArtifactHarness({...t.options,clock:()=>clockValue});await expect(service.ingest(...t.args)).rejects.toBeDefined();
    expect(await t.ingest()).toBeDefined();
  });
  it("已取消signal不读取私有输入或提交", async () => {
    const before=t.store.load(),read=vi.spyOn(t.store,"loadVerifiedImageBytes"),c=new AbortController();c.abort();
    await expect(t.ingest(c.signal)).rejects.toMatchObject({status:499});expect(read).not.toHaveBeenCalled();invariant(t,before);
  });
  it("非合作wire未结清仍占两槽，取消迟到不能提交且清零", async () => {
    const before=t.store.load(),real=protocol.prepareLockedProductionImageProtocol,releases:(()=>void)[]=[],wires:Buffer[]=[];
    const spy=vi.spyOn(protocol,"prepareLockedProductionImageProtocol").mockImplementation(async(...args)=>{const r=await real(...args);wires.push(r.wire.body);
      await new Promise<void>(resolve=>releases.push(resolve));return r;});
    const a=new AbortController(),b=new AbortController(),work=[t.ingest(a.signal),t.ingest(b.signal)].map(p=>p.catch(e=>e));
    await vi.waitFor(()=>expect(releases).toHaveLength(2));a.abort();b.abort();expect((await Promise.all(work)).every(e=>e.status===499)).toBe(true);
    await expect(t.ingest()).rejects.toMatchObject({code:"locked_artifact_busy",status:429});releases.forEach(r=>r());
    await vi.waitFor(()=>expect(wires.every(b=>b.every(n=>n===0))).toBe(true));spy.mockRestore();invariant(t,before);expect(await t.ingest()).toBeDefined();
  });
  it("不合作解码绝对客户端期限结束，不延长等待或迟到提交", async () => {
    const before=t.store.load(),real=decoder.decodeStaticImage;let release!:()=>void;
    const spy=vi.spyOn(decoder,"decodeStaticImage").mockImplementation(async(...args)=>{const r=await real(...args);await new Promise<void>(resolve=>release=resolve);return r;});
    const service=new LockedImageProductionArtifactHarness({...t.options,timeoutMs:700});
    const start=performance.now();await expect(service.ingest(...t.args)).rejects.toBeDefined();expect(performance.now()-start).toBeLessThan(1400);
    expect(release).toBeDefined();release();spy.mockRestore();await vi.waitFor(()=>expect(t.store.load()).toEqual(before));invariant(t,before);
  });
  it("实际task SQL写后额外合法预算变动也不能混入提交", async () => {
    const before=t.store.load(),save=t.store.save.bind(t.store);let changed=false;
    vi.spyOn(t.store,"save").mockImplementation(s=>{save(s);if(s.batches.some(b=>b.lockedProductionImageArtifact)&&!changed){changed=true;const copy=structuredClone(s);
      copy.budgets.push({tenantId:"owned-other",projectId:"owned-other",currency:"CNY",limitMinor:1000,reservedMinor:0,spentMinor:0});save(copy);}});
    await expect(t.ingest()).rejects.toBeDefined();expect(changed).toBe(true);invariant(t,before);
  });
  it("最后一次授权回调目录漂移也必须整体回滚", async () => {
    let armed=false,changed=false;const f=await fixture({},undefined,()=>{if(armed){armed=false;changed=true;
      const c=f.store.loadCatalog()!;c.projects[0].constraints[0].brandRules.style="owned-final-drift";f.store.saveCatalog(c);}return true;});
    const before=f.store.load(),catalog=f.store.loadCatalog(),bytes=f.store.localImageBinaryBytes.bind(f.store);
    vi.spyOn(f.store,"localImageBinaryBytes").mockImplementation((...args)=>{const n=bytes(...args);if(state(f).lockedProductionImageArtifact&&!changed)armed=true;return n;});
    await expect(f.ingest()).rejects.toBeDefined();expect(changed).toBe(true);invariant(f,before);expect(f.store.loadCatalog()).toEqual(catalog);
  });
  it("正常毫秒时钟推进可提交，不要求所有核验同一时刻", async () => {
    const inspect=t.kernel.inspectLockedProductionImageArtifact.bind(t.kernel);
    vi.spyOn(t.kernel,"inspectLockedProductionImageArtifact").mockImplementation((...args)=>{t.advance(1);return inspect(...args);});
    const r=await t.ingest();expect(Date.parse(r.committedAt)).toBeGreaterThan(Date.parse(t.v.confirmedAt));expect(state(t).lockedProductionImageArtifact).toEqual(r);
  });
  it.each(["clock","cancel"])("final-readback之后%s仍拒绝且整笔回滚", async kind => {
    const before=t.store.load(),c=new AbortController(),read=t.kernel.finishLockedProductionImageArtifactReadback.bind(t.kernel);
    vi.spyOn(t.kernel,"finishLockedProductionImageArtifactReadback").mockImplementation((...args)=>{const r=read(...args);if(kind==="clock")t.advance(5000);else c.abort();return r;});
    await expect(t.ingest(c.signal)).rejects.toBeDefined();invariant(t,before);
  });
});
