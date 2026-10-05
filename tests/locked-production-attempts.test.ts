import { LockedProductionImageTaskReconstruction, LockedImageProductionReconstructionHarness } from "../apps/api/src/lockedProductionImageTaskReconstruction";
import { createLockedProductionImageLeaseFixturePolicy, createLockedProductionImageLeasePolicy, type LockedProductionImageLeasePolicy } from "../apps/api/src/lockedProductionImageLeasePolicy";
import type { RunKernelOptions } from "../apps/api/src/runKernel";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VerifiedImageSchema, ConfirmedProductionImageExecutionSchema, ProductionImageExecutionRequestSchema, ConfirmedLockedProductionImageExecutionSchema } from "../packages/contracts/src/index";
import { LockedImageProductionPreparationHarness, LockedProductionImagePreparations, type LockedImagePriceContext } from "../apps/api/src/lockedProductionImagePreparations";
import { assertLockedConfirmation, lockedExpected } from "../apps/api/src/lockedProductionImageProtocol";
import * as protocol from "../apps/api/src/lockedProductionImageProtocol";
import * as decoder from "../apps/api/src/staticImageDecoder";
import { imageSnapshotFingerprint as fp, validateProductionImageProviderRequest } from "../apps/api/src/imageProviderContract";
import { assetMetadataFingerprint } from "../apps/api/src/assetMetadata";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { at, connection, principal, setupImageTask, sha } from "./helpers/image-task-fixture";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
let source: Buffer, mask: Buffer;
const owned: ReturnType<typeof setupImageTask>[] = [], connections: SqliteRunKernelStateStore[] = [];
const children: ChildProcess[] = [];
beforeAll(async () => { const png = (p: number[]) => sharp(Buffer.from(p), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  source = await png([10,20,30,255,40,50,60,255]); mask = await png([0,0,0,0,255,255,255,255]); });
afterEach(() => { vi.restoreAllMocks(); children.splice(0).forEach(c => { if (c.exitCode === null) c.kill(); }); connections.splice(0).forEach(c => c.close()); owned.splice(0).forEach(f => f.cleanup()); });
function fixture(opts: { manual?: boolean; cap?: number; protocol?: "openai" | "openai-compatible"; encoding?: "json-images" | "multipart-image-array" | "multipart-image-single"; production?: boolean; timeout?: number; enabled?: boolean; lease?: boolean; quota?: number; start?: boolean; startTimeout?: number; response?: boolean; send?: (c: any) => Promise<any>; kernel?: Partial<RunKernelOptions> } = {}) {
  let service: LockedImageProductionPreparationHarness | LockedProductionImagePreparations;
  let leasePolicy: LockedProductionImageLeasePolicy, leaseAllowed: unknown = true;
  let reconstruction: LockedProductionImageTaskReconstruction | LockedImageProductionReconstructionHarness, startAllowed: unknown = true, responseAllowed: unknown = true;
  const leaseGate: LockedProductionImageLeasePolicy = { usesStateStore: s => leasePolicy.usesStateStore(s), authorizeScope: (p, project, purpose) => leasePolicy.authorizeScope(p, project, purpose),
    validate: (p, e, purpose, bytes) => leasePolicy.validate(p, e, purpose, bytes) };
  const f = setupImageTask({ productionResponses: true, productionArtifacts: true,
    kernel: { validateLockedProductionImageConfirmation: (p, e) => service.authorizeConfirmation(p, e), ...(opts.lease === false ? {} : { lockedProductionImageLeasePolicy: leaseGate }),
      ...(opts.start === false ? {} : { lockedProductionImageStartPolicy: { usesStateStore: s => reconstruction.usesStateStore(s), authorizeScope: (p, project) => reconstruction.authorizeScope(p, project), validateStart: (p, e, l, i) => reconstruction.validateStart(p, e, l, i) } }), lockedProductionImageResponsePolicy: { usesStateStore: s => reconstruction.responsePolicy.usesStateStore(s), authorizeScope: (p,project) => reconstruction.responsePolicy.authorizeScope(p,project), validateAttempt: (p,e,l,i,a) => reconstruction.responsePolicy.validateAttempt(p,e,l,i,a), validateResult: (p,e,l,i,a,r) => reconstruction.responsePolicy.validateResult(p,e,l,i,a,r) }, ...opts.kernel } }); owned.push(f);
  const denied = new Set<string>(); let policy: unknown = true, allowed: unknown = true;
  const authorizer = { authenticate: () => principal, allows: (p: typeof principal, project: string, permission: string) =>
    p.tenantId === principal.tenantId && ["writer", "reader"].includes(p.actorId) && project === "project-a" && !denied.has(permission) ? allowed as boolean : false };
  const base = connection(), config = connection({ protocol: opts.protocol ?? "openai", models: [{ ...base.models[0], sizes: { allowAuto: false, presets: [{ width: 2, height: 1 }] },
    mask: { mode: "prompt-guidance", polarity: opts.protocol === "openai-compatible" ? "white-edit" : "transparent-edit" } }],
    ...(opts.protocol === "openai-compatible" ? { compatibility: { version: "owned", editEncoding: opts.encoding ?? "json-images", responseEncoding: "images-b64-json-v1",
      auth: { scheme: "bearer" }, endpoints: { generate: "/images/generations", edit: "/images/edits" }, extraParameters: [] } } : {}) }); f.register(config);
  for (const [id, body, purpose] of [["source", source, "source"], ["mask", mask, "mask"]] as const) {
    const a = { id, projectId: "project-a", kind: "image", purpose, storageKey: `owned:${id}`, originalName: `${id}.png`, mimeType: "image/png", byteSize: body.length,
      width: 2, height: 1, contentFingerprint: `sha256:${sha(body)}`, createdAt: at, ...(purpose === "mask" ? { sourceAssetId: "source" } : {}) };
    const r = VerifiedImageSchema.parse({ schemaVersion: 1, id: `receipt-${id}`, tenantId: principal.tenantId, asset: a, checksumSha256: sha(body),
      registeredMetadataSha256: assetMetadataFingerprint(a as any), decoder: "sharp-full-decode-v1", verifiedBy: "owned", verifiedAt: at,
      ...(purpose === "mask" ? { sourceChecksumSha256: sha(source) } : {}) });
    f.store.transaction(() => { f.store.saveVerifiedImage(r, body); const c = f.store.loadCatalog()!; c.projects[0].assets.push(r.asset); f.store.saveCatalog(c); });
  }
  f.store.transaction(() => { const c = f.store.loadCatalog()!, x = c.projects[0].constraints[0]; x.lockedPaths = ["product.pixels"];
    x.editableRegions = [{ id: "region", description: "原锁区", maskAssetId: "mask" }]; x.outputSpec = { width: 2, height: 1, format: "png" }; f.store.saveCatalog(c); });
  const pricePort = { kind: opts.production ? "server-pricing" : "contract-fixture", realExecutionEnabled: false,
    read: vi.fn((c: LockedImagePriceContext) => ({ schemaVersion: 1, scope: c.scope, quote: { id: "owned-price", version: "owned-v1", currency: "CNY",
      source: opts.manual ? "manual-budget" : "server-price-table", maxCostMinor: opts.cap ?? 40, ...(opts.manual ? {} : { estimatedCostMinor: 25 }), expiresAt: new Date(f.clock() + 60_000).toISOString() },
      evidence: { kind: opts.production ? opts.manual ? "server-approved-budget" : "server-verified-price" : "contract-fixture", ...(opts.production ? {} : { realExecutionEnabled: false }),
        sourceRevision: "owned", evidenceRef: "owned-price", checkedBy: "owned", checkedAt: c.requestedAt } })), verify: vi.fn((): unknown => true) };
  const options = { preparationEnabled: true as const, lockedPreparationEnabled: true as const, lockedConfirmationEnabled: opts.enabled === false ? undefined : true as const,
    tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel, clock: f.clock, timeoutMs: opts.timeout, pricePort: pricePort as any,
    authorizer, runAuthorizer: authorizer, assetAuthorizer: authorizer, lockedPreparationPolicy: () => true, lockedConfirmationPolicy: () => policy as boolean };
  service = opts.production ? new LockedProductionImagePreparations(options) : new LockedImageProductionPreparationHarness(options);
  const leaseOptions = { lockedLeaseEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, pricePort: pricePort as any,
    runAuthorizer: authorizer, providerAuthorizer: authorizer, assetAuthorizer: authorizer, clock: f.clock, maxMetadataBytes: opts.quota,
    lockedLeasePolicy: () => leaseAllowed as boolean };
  leasePolicy = opts.production ? createLockedProductionImageLeasePolicy(leaseOptions) : createLockedProductionImageLeaseFixturePolicy(leaseOptions);
  const rebuildOptions = { lockedReconstructionEnabled: true as const, lockedStartEnabled: true as const, tenantId: principal.tenantId, stateStore: f.store, runKernel: f.kernel,
    leasePolicy: leaseGate, lockedStartPolicy: () => startAllowed as boolean, clock: f.clock, timeoutMs: opts.startTimeout, lockedResponseEnabled: opts.response === false ? undefined : true as const, lockedResponsePolicy: () => responseAllowed as boolean, fixtureTransport: { mode: "contract-fixture" as const, realExecutionEnabled: false as const, send: vi.fn(opts.send ?? (async () => response())) } };
  reconstruction = opts.production ? new LockedProductionImageTaskReconstruction(rebuildOptions) : new LockedImageProductionReconstructionHarness(rebuildOptions);
  const select = (action = "locked-owned") => ({ projectId: "project-a", idempotencyKey: action, connectionId: config.id, connectionRevision: 1, model: config.models[0].model,
    capabilityVersion: config.models[0].version, constraintSnapshotId: "constraint-a", operation: "edit", inputAssetIds: ["source"], maskAssetId: "mask", protection: "pixel-exact",
    parameters: { prompt: "原人工锁区指令", n: 1, size: { width: 2, height: 1 }, quality: "auto", background: "auto", outputFormat: "png" } });
  const prepare = async (action = "locked-owned") => { const v = await service.createPreparation(principal, select(action)); return f.store.loadLockedProductionImagePreparation(principal.tenantId, "project-a", v.mode, v.id)!; };
  const confirm = (p: Awaited<ReturnType<typeof prepare>>, actor = principal, expected: unknown = lockedExpected(p), signal?: AbortSignal) => service.confirmPreparation(actor, "project-a", p.id, expected, { signal });
  return { ...f, reconstruction, rebuildOptions, send: rebuildOptions.fixtureTransport.send, responseAllow: (v: unknown) => { responseAllowed = v; }, startAllow: (v: unknown) => { startAllowed = v; }, service, options, authorizer, config, select, prepare, confirm, pricePort, leasePolicy, leaseOptions, leaseGate, leaseAllow: (v: unknown) => { leaseAllowed = v; }, deny: (p: string) => denied.add(p), policy: (p: unknown) => { policy = p; }, allow: (v: unknown) => { allowed = v; } };
}
async function unchanged(f: ReturnType<typeof fixture>, action: () => unknown) {
  const s = f.store.load(), c = f.store.loadCatalog(); await expect(Promise.resolve().then(action)).rejects.toThrow(); expect(f.store.load()).toEqual(s); expect(f.store.loadCatalog()).toEqual(c);
}



function response() { return { status: 200, contentType: "application/json", requestId: "owned-response", body: Buffer.from(JSON.stringify({ created: 1, data: [{ b64_json: source.toString("base64") }] })) }; }
describe("protected response rollback and recovery boundaries",()=>{
  for(const phase of ["attempt","result"]) for(const failure of ["fault","revoke","clock","cancel","catalog","capacity"]) it(phase+" actual task SQL after-write "+failure+" rolls back",async()=>{
    const f=await ready(), abort=new AbortController(), save=f.store.save.bind(f.store); let triggered=false;
    vi.spyOn(f.store,"save").mockImplementation(s=>{save(s);const b=s.batches[0];if(triggered || !(phase==="attempt"?b.lockedProductionImageAttempt&&!b.lockedProductionImageResult:b.lockedProductionImageResult?.kind==="returned"))return;triggered=true;
      if(failure==="fault")throw new Error("private database error");if(failure==="revoke")f.responseAllow(false);if(failure==="clock")f.advance(-1);if(failure==="cancel")abort.abort();
      if(failure==="catalog"){const c=f.store.loadCatalog()!;c.projects[0].constraints[0].brandRules.style="changed";f.store.saveCatalog(c);}
      if(failure==="capacity"){const c=f.store.loadCatalog()!;c.projects[0].constraints[0].brandRules.style="x".repeat(512*1024);f.store.saveCatalog(c);}
    });
    const catalog=f.store.loadCatalog();await f.execute(abort.signal).catch(()=>undefined);expect(triggered).toBe(true); const s=f.store.load()!.batches[0];
    if(phase==="attempt"){expect(f.send).not.toHaveBeenCalled();expect(s.lockedProductionImageAttempt).toBeUndefined();expect(s.aggregate.batch.status).toBe("running");}
    else {expect(f.send).toHaveBeenCalledTimes(1);expect(s.lockedProductionImageAttempt).toBeDefined();expect(s.lockedProductionImageResult?.kind).not.toBe("returned");
      expect(f.store.loadLockedProductionImageResponse(principal.tenantId,"project-a","production-contract-fixture",f.v.jobId)).toBeNull();}
    expect(s.reservedMinor).toBe(40);expect(s.aggregate.jobs[0].actualCostMinor).toBeUndefined();expect(f.store.loadCatalog()).toEqual(catalog);
  });
  for(const write of [1,2]) it("raw "+write+" actual SQL write revoked rolls back both tables and result",async()=>{
    const f=await ready(), writeRaw=f.store.saveLockedProductionImageResponse.bind(f.store);let hit=0;
    vi.spyOn(f.store,"saveLockedProductionImageResponse").mockImplementation((r,b,check,limits)=>writeRaw(r,b,()=>{hit++;if(hit===write)f.responseAllow(false);check();},limits));
    await expect(f.execute()).rejects.toThrow();expect(hit).toBe(write);const s=f.store.load()!.batches[0];expect(s.lockedProductionImageAttempt).toBeDefined();
    expect(s.lockedProductionImageResult).toBeUndefined();expect(s.aggregate.batch.status).toBe("running");expect(s.reservedMinor).toBe(40);
    expect(f.store.loadLockedProductionImageResponse(principal.tenantId,"project-a","production-contract-fixture",f.v.jobId)).toBeNull();
  });
  for(const change of ["quote","lease","job","body","wire"]) it("callback guard "+change+" refuses changed live consumption and closes",async()=>{
    const f=await ready({kernel:change==="job"?{jobTimeoutMs:1000}:undefined});let guard!:()=>void;
    f.send.mockImplementation(async c=>{guard=c.assertCurrent;if(change==="quote")f.pricePort.verify.mockReturnValue(false);
      if(change==="lease")f.advance(30000);if(change==="job")f.advance(1000);if(change==="body")c.wire.body[0]^=1;if(change==="wire")c.wire.path="/changed";c.assertCurrent();return response();});
    await f.execute().catch(()=>undefined);expect(()=>guard()).toThrow();expect(f.store.load()!.batches[0].reservedMinor).toBe(40);expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("response source/input drift cannot save raw; original source is not deleted",async()=>{
    const f=await ready();f.send.mockImplementation(async()=>{const c=f.store.loadCatalog()!;c.projects[0].assets.find(a=>a.id==="source")!.originalName="changed";f.store.transaction(()=>f.store.saveCatalog(c));return response();});
    await expect(f.execute()).rejects.toThrow();expect(f.store.load()!.batches[0].lockedProductionImageResult).toBeUndefined();expect(f.store.loadVerifiedImageBytes(principal.tenantId,"project-a","source")).toBeDefined();
  });
  it("noncooperative ports retain both slots after timeout, late responses never commit",async()=>{
    let settleA!: (r:any)=>void,settleB!: (r:any)=>void;const a=await ready({startTimeout:150,send:()=>new Promise(r=>{settleA=r;})}),b=await ready({startTimeout:150,send:()=>new Promise(r=>{settleB=r;})}),c=await ready();
    try{await expect(a.execute()).rejects.toThrow();await expect(b.execute()).rejects.toThrow();expect(a.inspect().result?.kind).toBe("interrupted");expect(b.inspect().result?.kind).toBe("interrupted");
      await expect(c.execute()).rejects.toThrow();expect(c.send).not.toHaveBeenCalled();const before=a.store.load();settleA(response());settleB(response());await new Promise(r=>setTimeout(r,10));expect(a.store.load()).toEqual(before);await c.execute();expect(c.send).toHaveBeenCalledTimes(1);
    }finally{settleA?.(response());settleB?.(response());await new Promise(r=>setTimeout(r,10));}
  });
  it("pre-cancel does not create intent or attempt",async()=>{const f=await ready(),a=new AbortController();a.abort();await unchanged(f,()=>f.execute(a.signal));expect(f.send).not.toHaveBeenCalled();});
  it("post-attempt cancellation saves bounded interruption only",async()=>{const f=await ready(),a=new AbortController();f.send.mockImplementation(async()=>{a.abort();return response();});await f.execute(a.signal).catch(()=>undefined);
    expect(f.inspect().result?.kind).toBe("interrupted");expect(f.inspect().aggregate.ledger.map(x=>x.settlement)).toEqual(["reserved","unknown"]);expect(f.inspect().aggregate.jobs[0].actualCostMinor).toBeUndefined();});
  it("closed private proof refuses direct attempt/result replay",async()=>{const f=await ready();await f.execute();const c=f.inspect();
    await unchanged(f,()=>f.kernel.beginLockedImageAttempt(principal,"project-a",f.v.batchId,f.v.jobId,f.input,c.attempt!));
    const raw=f.store.loadLockedProductionImageResponse(principal.tenantId,"project-a","production-contract-fixture",f.v.jobId)!;
    await unchanged(f,()=>f.kernel.recordLockedImageResult(principal,"project-a",f.v.batchId,f.v.jobId,f.input,c.result!,raw.body));raw.body.fill(0);});
  for(const mode of ["attempt","attempt-fp","result","result-fp","policy","audit","lease","intent","marker","body","orphan-all"]) it("full restore rejects "+mode+" even partial SHA recalculation",async()=>{
    const f=await ready();await f.execute();if(mode==="marker"||mode==="body"){const db=new DatabaseSync(f.path);try{if(mode==="marker")db.exec("DELETE FROM production_image_response_presence");else db.prepare("UPDATE production_image_responses SET body=?").run(Buffer.from("bad"));}finally{db.close();}}
    else {const s=f.store.load()!,b=s.batches[0];if(mode==="attempt"){b.lockedProductionImageAttempt!.actorId="reader";b.lockedProductionImageAttemptFingerprint=fp(b.lockedProductionImageAttempt);}
      if(mode==="attempt-fp")b.lockedProductionImageAttemptFingerprint="f".repeat(64);if(mode==="result"){b.lockedProductionImageResult!.outcome.artifactStatus="absent";b.lockedProductionImageResultFingerprint=fp(b.lockedProductionImageResult);}
      if(mode==="result-fp")b.lockedProductionImageResultFingerprint="f".repeat(64);if(mode==="policy")b.lockedProductionImageAttempt!.protectionPolicyFingerprint="f".repeat(64);
      if(mode==="audit")b.aggregate.audit=b.aggregate.audit.filter(a=>a.eventType!=="production-image-attempted");if(mode==="lease")b.lockedProductionImageLeases![0].actorId="reader";if(mode==="intent")b.lockedProductionImageDispatchIntentFingerprint="f".repeat(64);
      if(mode==="orphan-all"){delete b.lockedProductionImageAttempt;delete b.lockedProductionImageAttemptFingerprint;delete b.lockedProductionImageResult;delete b.lockedProductionImageResultFingerprint;
        const at=new Date(Date.parse(b.lockedProductionImageLeases![0].expiresAt)).toISOString();b.aggregate.jobs[0].failureCode="locked-lease-expired-after-intent";b.aggregate.jobs[0].finishedAt=at;b.aggregate.ledger[1].createdAt=at;
        b.aggregate.audit=b.aggregate.audit.filter(a=>!["production-image-attempted","production-image-returned"].includes(a.eventType));const audit=b.aggregate.audit.find(a=>a.eventType==="billing-unknown")!;audit.createdAt=at;audit.metadata.reason="locked-lease-expired-after-intent";}
      f.store.transaction(()=>f.store.save(s)); }
    expect(()=>f.kernel.getBatch(principal,f.v.batchId)).toThrow();
  });
  it("original sequential price time progress remains accepted",async()=>{const f=await ready();f.pricePort.verify.mockImplementation(()=>{f.advance(1);return true;});await f.execute();expect(f.inspect().result?.kind).toBe("returned");});
  it("legacy cancel and retry never release protected unknown",async()=>{const f=await ready();await f.execute();const s=f.store.load();
    expect(()=>f.kernel.cancelBatch(principal,f.v.batchId)).toThrow();expect(()=>f.kernel.retryJob(principal,f.v.jobId,{expectedEstimatedCostMinor:25,expectedCurrency:"CNY",idempotencyKey:"retry"})).toThrow();expect(f.store.load()).toEqual(s);});
});
async function ready(opts: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(opts), preparation = await f.prepare(), v = await f.confirm(preparation);
  const l = f.kernel.claimLockedProductionImageBatch(principal, "project-a", v.batchId, { workerId: "owned-worker", maxJobs: 1 }).leases[0], input = { workerId: l.workerId, leaseId: l.leaseId };
  const execute = (signal?: AbortSignal, actor = principal) => f.reconstruction.executeFixture(actor, "project-a", v.batchId, v.jobId, input, { signal });
  const start = () => f.reconstruction.start(principal, "project-a", v.batchId, v.jobId, input);
  const inspect = () => f.kernel.inspectLockedImageAttempt(principal, "project-a", v.batchId, v.jobId, input);
  return { ...f, preparation, v, l, input, execute, start, inspect };
}
describe("protected first live attempt and complete raw transaction", () => {
it("two actual OS processes send once and preserve the same max ledger",async()=>{
    const f=await ready(), running=await Promise.all([1,2].map(()=>new Promise<{start():void;result:Promise<any>}>((resolve,reject)=>{
      const child=fork(fileURLToPath(new URL("./fixtures/locked-production-attempt-process.ts",import.meta.url)),[],{execArgv:["--import","tsx"],stdio:["ignore","ignore","pipe","ipc"]});children.push(child);
      let done!:(v:any)=>void,fail!:(e:Error)=>void;const result=new Promise((r,j)=>{done=r;fail=j;});void result.catch(()=>undefined);
      child.on("error",e=>{reject(e);fail(e);});child.on("exit",code=>{if(code!==0){const e=new Error("owned child failed");reject(e);fail(e);}});
      child.on("message",(m:any)=>m.ready?resolve({start:()=>child.send("go"),result}):done(m));
      child.send({path:f.path,batch:f.v.batchId,job:f.v.jobId,now:f.clock(),input:f.input,raw:response().body.toString()});
    })));running.forEach(r=>r.start());const results=await Promise.all(running.map(r=>r.result));expect(results.every(r=>r.ok)).toBe(true);
    expect(results.reduce((n,r)=>n+r.calls,0)).toBe(1);expect(f.inspect().result?.kind).toBe("returned");expect(f.inspect().aggregate.ledger).toHaveLength(2);expect(f.store.load()!.batches[0].reservedMinor).toBe(40);
  });
  for (const protocol of ["openai", "openai-compatible"] as const) for (const manual of [false,true]) it(protocol+" "+manual+" commits actual attempt before callback, retains max", async () => {
    const f = await ready({ protocol, manual }); const send = f.send.getMockImplementation()!;
    f.send.mockImplementation(async c => { const s = f.store.load()!.batches[0]; expect(s.lockedProductionImageAttempt?.state).toBe("attempted");
      expect(s.lockedProductionImageResult).toBeUndefined(); expect(s.aggregate.audit.filter(a=>a.eventType==="production-image-attempted")).toHaveLength(1); c.assertCurrent(); return send(c); });
    const result = await f.execute(), s = f.store.load()!.batches[0];
    expect(result.started).toBe(true); expect(result.executionAuthorized).toBe(false); expect(result.realExecutionEnabled).toBe(false);
    expect(s.aggregate.jobs[0]).toMatchObject({status:"billing_unknown",failureCode:"locked-response-returned",estimatedCostMinor:manual?null:25});
    expect(s.aggregate.jobs[0].outputAssetIds).toEqual([]); expect(s.aggregate.jobs[0].actualCostMinor).toBeUndefined();
    expect(s.aggregate.ledger.map(l=>l.settlement)).toEqual(["reserved","unknown"]); expect(s.reservedMinor).toBe(40);
    expect(s.lockedProductionImageResult?.outcome).toMatchObject({artifactStatus:"pending-validation",billing:{state:"unknown"}});
    const raw=f.store.loadLockedProductionImageResponse(principal.tenantId,"project-a",s.aggregate.batch.imageMode!,f.v.jobId)!;
    expect(raw.record.schemaVersion).toBe(2); expect(raw.body).toEqual(response().body); raw.body.fill(0);
    expect(()=>f.store.loadProductionImageResponse(principal.tenantId,"project-a",s.aggregate.batch.imageMode!,f.v.jobId)).toThrow();
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.kernel.getBudget(principal,"project-a")).toMatchObject({reservedMinor:40,spentMinor:0});
  });
  for (const encoding of ["multipart-image-array","multipart-image-single"] as const) it("original "+encoding+" wire matches", async () => {
    const f=await ready({protocol:"openai-compatible",encoding}); f.send.mockImplementation(async c=>{ expect(c.wire.contentType).toContain("multipart/form-data; boundary=");
      expect(sha(c.wire.body)).toBe(f.preparation ? f.store.load()!.batches[0].lockedProductionImageExecution!.protocol.payloadChecksumSha256 : ""); return response(); });
    await f.execute(); expect(f.inspect().result?.kind).toBe("returned");
  });
  it("manual zero cap remains unknown and has one zero reservation", async()=>{const f=await ready({manual:true,cap:0});await f.execute();const s=f.store.load()!.batches[0];
    expect(s.jobReservations).toEqual([[f.v.jobId,0]]);expect(s.aggregate.ledger).toHaveLength(2);expect(s.aggregate.jobs[0].estimatedCostMinor).toBeNull();expect(s.aggregate.jobs[0].actualCostMinor).toBeUndefined();});
  it("parallel first flows invoke once", async()=>{const f=await ready();await Promise.all([f.execute(),f.execute()]);expect(f.send).toHaveBeenCalledTimes(1);expect(f.inspect().aggregate.ledger).toHaveLength(2);});
  it("standalone historical start cannot create attempt",async()=>{const f=await ready();await f.start();await f.execute();expect(f.send).not.toHaveBeenCalled();expect(f.inspect().attempt).toBeUndefined();});
  it("repeat and restart do not normalize, verify, save or resend",async()=>{const f=await ready();await f.execute();const before=f.store.load();f.advance(90_000);f.pricePort.verify.mockClear();
    const decode=vi.spyOn(decoder,"decodeStaticImage"), prepare=vi.spyOn(protocol,"prepareLockedProductionImageProtocol"), save=vi.spyOn(f.store,"save");
    expect((await f.execute()).started).toBe(false);expect(decode).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();expect(f.pricePort.verify).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();expect(f.store.load()).toEqual(before);
    const other=new SqliteRunKernelStateStore(f.path,{productionResponseStorageEnabled:true,productionArtifactStorageEnabled:true});connections.push(other);
    const kernel=new SqliteRunKernel({authorizer:f.authorizer,budgets:[{tenantId:principal.tenantId,projectId:"project-a",currency:"CNY",limitMinor:1000}],clock:f.clock,stateStore:other}); expect(kernel.getBatch(principal,f.v.batchId)).toEqual(f.inspect().aggregate);expect(f.send).toHaveBeenCalledTimes(1);
  });
  for(const permission of ["run:read","run:execute","provider:read","asset:read"]) it("denies "+permission+" before private bytes",async()=>{
    const f=await ready();f.deny(permission);const read=vi.spyOn(f.store,"loadVerifiedImageBytes");await expect(f.execute()).rejects.toThrow();expect(read).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();
  });
  for(const value of [false,null,"true",()=>Promise.resolve(true),()=>Promise.reject(new Error("private"))]) it("strict independent response policy "+String(value),async()=>{
    const f=await ready();f.responseAllow(typeof value==="function"?value():value);await unchanged(f,()=>f.execute());expect(f.send).not.toHaveBeenCalled();
  });
  it("default response closed",async()=>{const f=await ready({response:false});await unchanged(f,()=>f.execute());expect(f.send).not.toHaveBeenCalled();});
  it("production never consumes the fixture transport",async()=>{const f=await ready({production:true});await unchanged(f,()=>f.execute());expect(f.send).not.toHaveBeenCalled();});
  for(const mutation of ["actor","project","lease"]) it("rejects original "+mutation+" mismatch",async()=>{const f=await ready(); await unchanged(f,()=>mutation==="actor"?f.execute(undefined,{...principal,actorId:"reader"}):f.reconstruction.executeFixture(principal,mutation==="project"?"other":"project-a",f.v.batchId,f.v.jobId,mutation==="lease"?{...f.input,leaseId:"other"}:f.input));expect(f.send).not.toHaveBeenCalled();});
  for(const bad of ["transport","envelope","json","url","usage"]) it("bad "+bad+" keeps unknown max",async()=>{
    const f=await ready({send:async()=>{if(bad==="transport")throw new Error("secret");if(bad==="envelope")return {...response(),body:"not-buffer"};
      const data=bad==="json"?"{":JSON.stringify({created:1,data:[bad==="url"?{url:"https://never.invalid"}:{b64_json:source.toString("base64")}],...(bad==="usage"?{usage:{total_tokens:1}}:{})});return {...response(),body:Buffer.from(data)};}});
    await f.execute();expect(f.inspect().aggregate.batch.status).toBe("billing_unknown");expect(f.inspect().aggregate.ledger).toHaveLength(2);expect(f.inspect().aggregate.jobs[0].actualCostMinor).toBeUndefined();
  });
  it("late original response preserves existing expiry unknown and does not verify expired price",async()=>{
    const f=await ready({kernel:{leaseDurationMs:1000},send:async()=>{f.advance(1000);f.kernel.reconcileLockedProductionImageBatch(principal,"project-a",f.v.batchId);f.pricePort.verify.mockClear();return response();}});
    await f.execute();const c=f.inspect();expect(c.result?.kind).toBe("returned");expect(c.aggregate.jobs[0].failureCode).toBe("locked-lease-expired-after-intent");expect(c.aggregate.ledger).toHaveLength(2);expect(f.pricePort.verify).not.toHaveBeenCalled();
  });
  for(const manual of [false,true]) it("complete returned confirmation history "+manual+" is read-only after expiry",async()=>{
    const f=await ready({manual});await f.execute();f.advance(90000);f.pricePort.verify.mockClear();f.pricePort.read.mockClear();const before=f.store.load(),save=vi.spyOn(f.store,"save"),decode=vi.spyOn(decoder,"decodeStaticImage");
    expect(f.service.getConfirmation(principal,"project-a",f.preparation.id)).toMatchObject({status:"billing_unknown",estimatedCostMinor:manual?null:25,reservedMinor:40,executionAuthorized:false,realExecutionEnabled:false});
    expect(await f.confirm(f.preparation)).toMatchObject({batchId:f.v.batchId,status:"billing_unknown"});expect(f.store.load()).toEqual(before);expect(save).not.toHaveBeenCalled();expect(decode).not.toHaveBeenCalled();expect(f.pricePort.verify).not.toHaveBeenCalled();expect(f.pricePort.read).not.toHaveBeenCalled();expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("independent read identity needs no execution/create/confirm/billing permission",async()=>{
    const f=await ready();await f.execute();for(const p of ["run:execute","run:create","run:confirm","run:reconcile-billing","asset:write"])f.deny(p);
    expect(f.service.getConfirmation({...principal,actorId:"reader"},"project-a",f.preparation.id)).toMatchObject({confirmedBy:"writer",status:"billing_unknown",reservedMinor:40});
  });
  it("interrupted confirmation history remains original unknown",async()=>{
    const f=await ready({send:async()=>{throw new Error("private");}});await f.execute();expect(f.service.getConfirmation(principal,"project-a",f.preparation.id)).toMatchObject({status:"billing_unknown",reservedMinor:40});
  });
  it("confirmation history rejects orphan raw after deleting all response task fields",async()=>{
    const f=await ready();await f.execute();const s=f.store.load()!,b=s.batches[0];delete b.lockedProductionImageResult;delete b.lockedProductionImageResultFingerprint;
    const at=b.lockedProductionImageLeases![0].expiresAt;b.aggregate.jobs[0].failureCode="locked-lease-expired-after-intent";b.aggregate.jobs[0].finishedAt=at;b.aggregate.ledger[1].createdAt=at;
    b.aggregate.audit=b.aggregate.audit.filter(a=>a.eventType!=="production-image-returned");const audit=b.aggregate.audit.find(a=>a.eventType==="billing-unknown")!;audit.createdAt=at;audit.metadata.reason="locked-lease-expired-after-intent";
    f.store.transaction(()=>f.store.save(s));expect(()=>f.service.getConfirmation(principal,"project-a",f.preparation.id)).toThrow();
  });
  it("read callback drift is rejected and same-store side effects roll back",async()=>{
    const f=await ready();await f.execute();const c=f.store.loadCatalog(),read=f.store.loadLockedProductionImageResponse.bind(f.store);vi.spyOn(f.store,"loadLockedProductionImageResponse").mockImplementation((...args)=>{
      const raw=read(...args),catalog=f.store.loadCatalog()!;catalog.projects[0].constraints[0].brandRules.style="drift";f.store.saveCatalog(catalog);return raw;
    });expect(()=>f.service.getConfirmation(principal,"project-a",f.preparation.id)).toThrow();expect(f.store.loadCatalog()).toEqual(c);
  });
});
