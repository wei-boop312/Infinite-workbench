import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { ProductionGeneratedAssetLineageSchema, GeneratedAssetLineageSchema } from "../packages/contracts/src/index";
import { ImageProductionGeneratedAssetReadHarness, ProductionGeneratedAssetReads } from "../apps/api/src/productionGeneratedAssetReads";
import { handleProductionGeneratedAssetHttp } from "../apps/api/src/productionGeneratedAssetHttp";
import { acquireGeneratedTransfer } from "../apps/api/src/generatedTransferSlots";
import { createApiServer } from "../apps/api/src/index";
import { LocalGeneratedAssetReads } from "../apps/api/src/generatedAssetReads";
import { SqliteRunKernel } from "../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import { ImageProductionBillingReviewHarness } from "../apps/api/src/productionImageBillingReview";
import { ImageProductionBillingSettlementHarness } from "../apps/api/src/productionImageBillingSettlement";
import { imageSnapshotFingerprint as fp } from "../apps/api/src/imageProviderContract";
import { productionExpected } from "../apps/api/src/productionImageConfirmationIntegrity";
import { productionBillingTaskFixture as fixture } from "./helpers/production-billing-task-fixture";
import { principal } from "./helpers/image-task-fixture";
import * as decoder from "../apps/api/src/staticImageDecoder";
import * as protocol from "../apps/api/src/productionImageProtocol";

type Task = Awaited<ReturnType<typeof fixture>>;
const actor = { ...principal, actorId: "other" }, servers: Server[] = [], sockets: IncomingMessage[] = [];
afterEach(async () => { vi.useRealTimers(); for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } vi.restoreAllMocks(); });
function options(t: Task, stateStore = t.f.store, runKernel = t.f.kernel) {
  return { generatedReadEnabled: true as const, tenantId: principal.tenantId, stateStore, runKernel,
    assetAuthorizer: t.auth, runAuthorizer: t.auth };
}
function reader(t: Task) { return new ImageProductionGeneratedAssetReadHarness(options(t)); }
function id(t: Task) { return t.saved().productionImageArtifact!.image.asset.id; }
async function image(o: Parameters<typeof fixture>[0] = {}) { const t = await fixture(o); await t.artifacts.ingest(...t.args); return t; }
async function api(port?: ImageProductionGeneratedAssetReadHarness, configure?: (s: Server) => void) {
  const s = createApiServer({ productionGeneratedAssets: port }); servers.push(s); configure?.(s);
  await new Promise<void>(r => s.listen(0, "127.0.0.1", r)); const address = s.address(); if (!address || typeof address === "string") throw new Error();
  return `http://127.0.0.1:${address.port}`;
}
const uri = (asset: string, kind = "content") => `/v1/projects/project-a/production-generated-assets/${asset}/${kind}`;
function unchanged(t: Task, snapshot: unknown) { expect(t.f.store.load()).toEqual(snapshot); expect(t.send).toHaveBeenCalledTimes(1); }

describe("6D9A actual production read-only artifacts, owned zero-fee fixtures", () => {
  for (const protocolName of ["openai", "openai-compatible", "google"] as const) for (const manual of [false, true]) {
    it(`${protocolName}/${manual ? "unknown" : "known"} preserves original bytes, inputs and cost basis without task actions`, async () => {
      const t = await image({ protocol: protocolName, manual, edit: true }), r = reader(t), before = t.f.store.load();
      t.price.read.mockClear(); t.price.verify.mockClear(); const save = vi.spyOn(t.f.store, "save"), decode = vi.spyOn(decoder, "decodeStaticImage"), normalize = vi.spyOn(protocol, "prepareProductionImageProtocol");
      const lineage = r.lineage(actor, "project-a", id(t)), content = r.read(actor, "project-a", id(t));
      expect(content.body).toEqual(t.output); expect(content.metadata.image).toEqual(t.saved().productionImageArtifact!.image);
      expect(lineage).toMatchObject({ mode: "production-contract-fixture", executionAuthorized: false, realExecutionEnabled: false,
        batchId: t.args[2], jobId: t.args[3], jobStatus: "billing_unknown", requestDraft: { operation: "edit", inputs: [{ assetId: "source" }] },
        billing: { state: "unknown", estimatedMinor: manual ? null : 25, reservedMinor: 40, maxCostMinor: 40, currentMaxCostMinor: 40 } });
      expect(lineage.preparationFingerprint).toBe(t.preparation.snapshotFingerprint); expect(lineage.executionFingerprint).toBe(fp(t.saved().productionImageExecution));
      expect(lineage.billing.actualMinor).toBeUndefined(); expect(GeneratedAssetLineageSchema.safeParse(lineage).success).toBe(false);
      expect(JSON.stringify([lineage, content.metadata])).not.toMatch(/credentialRef|baseUrl|idempotencyKey|workerId|leaseId|leaseOwnerId|b64_json|opaque-never-resolved|never-called/);
      lineage.constraint.brandRules.style = "caller-only"; content.body.fill(0); expect(r.read(actor, "project-a", id(t)).body).toEqual(t.output);
      expect(r.lineage(actor, "project-a", id(t)).constraint).toEqual(t.preparation.constraint); unchanged(t, before);
      for (const spy of [save, decode, normalize, t.price.read, t.price.verify]) expect(spy).not.toHaveBeenCalled();
    });
  }
  describe("scope, integrity and history", () => {
    let t: Task;
    beforeEach(async () => { t = await image({ edit: true }); });
    it("binary only needs asset:read, lineage independently needs run:read; original worker is unchanged", () => {
      const before = t.f.store.load(); for (const p of ["run:execute", "run:confirm", "run:create", "run:reconcile-billing", "provider:read", "asset:write"]) t.denied.add(p);
      const r = reader(t); expect(r.lineage(actor, "project-a", id(t)).jobId).toBe(t.args[3]); t.denied.add("run:read");
      expect(r.read(actor, "project-a", id(t)).body).toEqual(t.output); expect(() => r.lineage(actor, "project-a", id(t))).toThrow(); unchanged(t, before);
    });
    it.each(["asset:read", "run:read"])("%s denied before private reads", p => {
      t.denied.add(p); const load = vi.spyOn(t.f.store, "load"), raw = vi.spyOn(t.f.store, "loadProductionImageResponse");
      expect(() => reader(t).lineage(actor, "project-a", idFromSaved)).toThrow(); expect(load).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
    });
    // This fixed arbitrary id avoids the fixture's private saved() read in early-denial assertions.
    const idFromSaved = "any-output";
    it("missing lineage policy closes before reads without disabling asset-only binary", () => {
      const r = new ImageProductionGeneratedAssetReadHarness({ ...options(t), runAuthorizer: undefined }), asset = id(t), load = vi.spyOn(t.f.store, "load");
      expect(() => r.lineage(actor, "project-a", asset)).toThrow(); expect(load).not.toHaveBeenCalled(); expect(r.read(actor, "project-a", asset).body).toEqual(t.output);
    });
    it.each([false, 1, "true", Promise.resolve(true), Promise.reject(new Error("owned async refusal")).catch(() => false)])("strict synchronous policy rejects %s", value => {
      vi.spyOn(t.auth, "allows").mockReturnValue(value as never); const load = vi.spyOn(t.f.store, "load");
      expect(() => reader(t).read(actor, "project-a", idFromSaved)).toThrow(); expect(load).not.toHaveBeenCalled();
    });
    it.each(["tenant", "project", "actor", "id"])("invalid %s scope does not read", bad => {
      const load = vi.spyOn(t.f.store, "load"); expect(() => reader(t).read(bad === "tenant" ? { ...actor, tenantId: "foreign" } : bad === "actor" ? { ...actor, actorId: "" } : actor,
        bad === "project" ? "foreign" : "project-a", bad === "id" ? "bad\n" : idFromSaved)).toThrow(); expect(load).not.toHaveBeenCalled();
    });
    it.each(["supportsProductionImageResponses", "supportsProductionImageArtifacts"] as const)("disabled %s cannot skip evidence validation", method => {
      const r = reader(t), load = vi.spyOn(t.f.store, "load"); vi.spyOn(t.f.store, method).mockReturnValue(false);
      expect(() => r.read(actor, "project-a", idFromSaved)).toThrow(); expect(load).not.toHaveBeenCalled();
    });
    it("default closed and exact same store instance required", () => {
      const load = vi.spyOn(t.f.store, "load"); expect(() => new ProductionGeneratedAssetReads().read(actor, "project-a", "any")).toThrow(); expect(load).not.toHaveBeenCalled();
      const second = new SqliteRunKernelStateStore(t.f.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true });
      try { expect(() => new ImageProductionGeneratedAssetReadHarness({ ...options(t), stateStore: second })).toThrow(); } finally { second.close(); }
    });
    it("caller option reassignment cannot change the configured actual store or tenant", () => {
      const configured = options(t), r = new ImageProductionGeneratedAssetReadHarness(configured); configured.tenantId = "foreign"; configured.stateStore = undefined as never; configured.runKernel = undefined as never;
      expect(r.read(actor, "project-a", id(t)).body).toEqual(t.output); t.denied.add("asset:read"); expect(() => r.read(actor, "project-a", id(t))).toThrow();
    });
    it("production cannot relabel fixture or old local GeneratedImageRecord", () => {
      const asset = id(t); expect(() => new ProductionGeneratedAssetReads(options(t)).read(actor, "project-a", asset)).toThrow();
      expect(() => new LocalGeneratedAssetReads({ tenantId: principal.tenantId, stateStore: t.f.store, authorizer: t.auth }).read(actor, "project-a", asset)).toThrow();
    });
    it("expired quote and disabled directory only recover immutable history", () => {
      t.f.advance(100_000); t.f.register({ ...t.config, revision: 2, enabled: false }); t.price.read.mockClear(); t.price.verify.mockClear().mockReturnValue(false);
      const before = t.f.store.load(), save = vi.spyOn(t.f.store, "save"), r = reader(t);
      expect(r.lineage(actor, "project-a", id(t)).requestDraft.connectionRevision).toBe(1); expect(r.read(actor, "project-a", id(t)).body).toEqual(t.output);
      unchanged(t, before); expect(save).not.toHaveBeenCalled(); expect(t.price.read).not.toHaveBeenCalled(); expect(t.price.verify).not.toHaveBeenCalled();
    });
    it("cross-connection and restart reads recover the same IDs without writes", () => {
      const asset = id(t), before = t.f.store.load(), view = reader(t).lineage(actor, "project-a", asset);
      const second = new SqliteRunKernelStateStore(t.f.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true });
      try { const kernel = new SqliteRunKernel({ stateStore: second, authorizer: t.auth, budgets: before!.budgets, clock: t.f.clock }), r = new ImageProductionGeneratedAssetReadHarness(options(t, second, kernel));
        const save = vi.spyOn(second, "save"); expect(r.lineage(actor, "project-a", asset)).toEqual(view); expect(r.read(actor, "project-a", asset).body).toEqual(t.output); expect(save).not.toHaveBeenCalled();
      } finally { second.close(); } unchanged(t, before);
    });
    it("unrelated expired production lease is not recovered by either read", async () => {
      const preparation = t.preparations.createPreparation(principal, { projectId: "project-a", idempotencyKey: "owned-unrelated-lease", connectionId: t.config.id,
        connectionRevision: 1, model: t.config.models[0].model, capabilityVersion: t.config.models[0].version, constraintSnapshotId: "constraint-a",
        protection: "none", operation: "generate", inputAssetIds: [], parameters: t.preparation.requestDraft.parameters });
      const record = t.f.store.loadProductionImagePreparation(principal.tenantId, "project-a", "production-contract-fixture", preparation.id)!;
      const confirmed = await t.preparations.confirmPreparation(principal, "project-a", preparation.id, productionExpected(record));
      t.f.kernel.claimProductionImageBatch(principal, "project-a", confirmed.aggregate.batch.id, { workerId: "unrelated", maxJobs: 1 }); t.f.advance(100_000);
      const before = t.f.store.load(), r = reader(t); expect(r.lineage(actor, "project-a", id(t)).jobStatus).toBe("billing_unknown"); expect(r.read(actor, "project-a", id(t)).body).toEqual(t.output);
      unchanged(t, before); expect(t.f.store.load()!.batches[1].aggregate.jobs[0].status).toBe("leased");
    });
    it("removing all task artifact fields with a valid snapshot still refuses orphan lineage", () => {
      const asset = id(t), s = t.f.store.load()!, b = s.batches[0]; delete b.productionImageArtifact; delete b.productionImageArtifactFingerprint;
      b.aggregate.jobs[0].outputAssetIds = []; b.aggregate.audit = b.aggregate.audit.filter(a => a.eventType !== "production-image-artifact-verified");
      t.f.store.transaction(() => t.f.store.save(s)); expect(() => t.f.kernel.validateProductionBillingSnapshot(s)).not.toThrow();
      expect(() => reader(t).lineage(actor, "project-a", asset)).toThrow();
    });
    it.each(["raw", "artifact", "constraint", "input", "catalog", "metadata-full"])("%s missing, drifted or over-cap evidence fails closed", bad => {
      const asset = id(t), r = reader(t);
      if (bad === "raw") vi.spyOn(t.f.store, "loadProductionImageResponse").mockReturnValue(null);
      else if (bad === "artifact") vi.spyOn(t.f.store, "loadProductionImageArtifact").mockReturnValue(null);
      else if (bad === "metadata-full") vi.spyOn(t.f.store, "imageMetadataBytes").mockReturnValue(16 * 1024 * 1024);
      else if (bad === "input") { const db = new DatabaseSync(t.f.path); try { db.prepare("UPDATE verified_images SET body = ? WHERE asset_id = 'source'").run(Buffer.from("bad")); } finally { db.close(); } }
      else t.f.store.transaction(() => { const c = t.f.store.loadCatalog()!; if (bad === "constraint") c.projects[0].constraints[0].brandRules.style = "changed";
        else c.projects[0].assets.find(a => a.id === asset)!.originalName = "changed"; t.f.store.saveCatalog(c); });
      expect(() => r.read(actor, "project-a", asset)).toThrow(); expect(() => r.lineage(actor, "project-a", asset)).toThrow();
    });
    it.each(["raw-body", "raw-marker", "artifact-marker", "image-body", "task-artifact", "task-result"])("actual SQLite %s corruption is rejected", bad => {
      const asset = id(t), db = new DatabaseSync(t.f.path);
      try {
        if (bad === "raw-body") db.prepare("UPDATE production_image_responses SET body = ?").run(Buffer.from("{}"));
        else if (bad === "raw-marker") db.exec("DELETE FROM production_image_response_presence");
        else if (bad === "artifact-marker") db.exec("DELETE FROM production_image_artifact_presence");
        else if (bad === "image-body") db.prepare("UPDATE verified_images SET body = ? WHERE asset_id = ?").run(Buffer.from("bad"), asset);
        else t.f.store.transaction(() => { const s = t.f.store.load()!, b = s.batches[0]; if (bad === "task-artifact") { delete b.productionImageArtifact; delete b.productionImageArtifactFingerprint; }
          else { delete b.productionImageResult; delete b.productionImageResultFingerprint; } t.f.store.save(s); });
      } finally { db.close(); }
      expect(() => reader(t).read(actor, "project-a", asset)).toThrow();
    });
    it.each(["revoke", "drift", "fault"])("private read callback %s rolls back side effects and clears raw copies", bad => {
      const asset = id(t), before = t.f.store.load(), catalog = t.f.store.loadCatalog(), original = t.f.store.loadProductionImageResponse.bind(t.f.store); let copy: Buffer | undefined;
      vi.spyOn(t.f.store, "loadProductionImageResponse").mockImplementationOnce((...args) => {
        const raw = original(...args); copy = raw?.body;
        if (bad === "revoke") t.revoke();
        else { const c = t.f.store.loadCatalog()!; c.projects[0].constraints[0].brandRules.style = "callback-write"; t.f.store.saveCatalog(c); }
        if (bad === "fault") { copy?.fill(0); throw new Error("owned-secret-read"); } return raw;
      });
      expect(() => reader(t).read(actor, "project-a", asset)).toThrow(); expect(copy?.every(n => n === 0)).toBe(true); expect(t.f.store.loadCatalog()).toEqual(catalog); unchanged(t, before);
    });
    it("output read revocation clears every borrowed copy, never returns bytes", () => {
      const asset = id(t), original = t.f.store.loadVerifiedImageBytes.bind(t.f.store), copies: Buffer[] = [];
      vi.spyOn(t.f.store, "loadVerifiedImageBytes").mockImplementation((...args) => { const img = original(...args); if (args[2] === asset) { if (img) copies.push(img.body); t.denied.add("asset:read"); } return img; });
      expect(() => reader(t).read(actor, "project-a", asset)).toThrow(); expect(copies.length).toBeGreaterThan(0); expect(copies.every(b => b.every(n => n === 0))).toBe(true);
    });
    it.each(["private", "mode", "estimate", "state", "input", "image", "money"])("public schema rejects %s repair or privacy injection", bad => {
      const view = reader(t).lineage(actor, "project-a", id(t)), changed = structuredClone(view);
      if (bad === "private") (changed as unknown as Record<string, unknown>).workerId = "private-worker";
      else if (bad === "mode") changed.mode = "production";
      else if (bad === "estimate") changed.billing.estimatedMinor = 0;
      else if (bad === "state") changed.billing.state = "settled";
      else if (bad === "input") changed.transformedInputs[0].originalChecksumSha256 = "0".repeat(64);
      else if (bad === "image") changed.image.asset.width = 8193;
      else changed.billing.currentMaxCostMinor = 0;
      expect(ProductionGeneratedAssetLineageSchema.safeParse(changed).success).toBe(false);
    });
  });
  it.each([0, 40])("manual cap %d preserves unknown with no fabricated actual fee", async cap => {
    const t = await image({ cap }); expect(reader(t).lineage(actor, "project-a", id(t)).billing).toEqual({ state: "unknown", currency: "CNY", estimatedMinor: null, maxCostMinor: cap, currentMaxCostMinor: cap, reservedMinor: cap });
  });
  it("pending candidate and genuine production not-connected history are not output permission", async () => {
    const t = await fixture(), p = await fixture({ productionStartOnly: true });
    expect(() => reader(t).read(actor, "project-a", "candidate")).toThrow(); expect(() => new ProductionGeneratedAssetReads(options(p)).read(actor, "project-a", "none")).toThrow();
    expect(p.saved().productionImageExecution!.mode).toBe("production"); expect(p.saved().productionImageAttempt).toBeUndefined(); expect(p.send).not.toHaveBeenCalled();
  });
  it("deleting all response fields with a valid unknown projection still cannot hide an orphan raw body", async () => {
    const t = await fixture(), x = t.f.store.load()!, b = x.batches[0], j = b.aggregate.jobs[0]; t.f.advance(30_000);
    j.finishedAt = new Date(t.f.clock()).toISOString(); j.failureCode = "production-lease-expired-after-intent";
    delete b.productionImageResult; delete b.productionImageResultFingerprint; b.aggregate.audit = b.aggregate.audit.filter(a => a.eventType !== "production-image-returned");
    const unknown = b.aggregate.audit.find(a => a.eventType === "billing-unknown")!; unknown.createdAt = j.finishedAt; unknown.metadata.reason = j.failureCode;
    b.aggregate.ledger.find(l => l.settlement === "unknown")!.createdAt = j.finishedAt; t.f.store.transaction(() => t.f.store.save(x));
    expect(() => t.f.kernel.validateProductionBillingSnapshot(x)).not.toThrow(); expect(() => reader(t).lineage(actor, "project-a", "none")).toThrow();
  });
  it("settled artifact remains read-only with full cost history, not another billing permission", async () => {
    const t = await image(), store = t.f.store; let billing: ImageProductionBillingSettlementHarness;
    const source = { kind: "contract-fixture" as const, realExecutionEnabled: false as const, verify: vi.fn(() => true) };
    const kernel = new SqliteRunKernel({ ...t.kernelOptions, stateStore: store, authorizer: t.auth, budgets: store.load()!.budgets, clock: t.f.clock,
      productionImageBillingPolicy: { usesStateStore: s => billing?.billingPolicy.usesStateStore(s) ?? false, authorizeScope: (p,j,a) => billing?.billingPolicy.authorizeScope(p,j,a) ?? false, validateCommit: (p,r) => billing?.billingPolicy.validateCommit(p,r) ?? false } });
    const opts = { ...options(t, store, kernel), providerAuthorizer: t.auth, clock: t.f.clock, billingSource: source };
    billing = new ImageProductionBillingSettlementHarness({ ...opts, billingSettlementEnabled: true }); const review = new ImageProductionBillingReviewHarness({ ...opts, billingReviewEnabled: true });
    const args = [actor, "project-a", t.args[2], t.args[3]] as const, snapshot = review.inspect(...args);
    billing.settle(...args, { reviewId: "owned-read-review", expectedSnapshotFingerprint: fp(snapshot), expectedCurrency: snapshot.currency,
      expectedReservedMinor: snapshot.reservedMinor, expectedMaxCostMinor: snapshot.maxCostMinor, actualCostMinor: 25, resolution: "charged",
      evidence: { sourceId: "owned-bill", sourceVersion: "v1", evidenceRef: "fake-only", checksumSha256: "a".repeat(64), observedAt: snapshot.unknownAt } });
    for (const p of ["run:reconcile-billing", "run:execute", "provider:read", "asset:write"]) t.denied.add(p); source.verify.mockClear(); const before = store.load(), r = new ImageProductionGeneratedAssetReadHarness(opts);
    expect(r.lineage(actor, "project-a", id(t))).toMatchObject({ jobStatus: "succeeded", billing: { state: "settled", actualMinor: 25, reservedMinor: 0, estimatedMinor: null } });
    expect(r.read(actor, "project-a", id(t)).body).toEqual(t.output); expect(source.verify).not.toHaveBeenCalled(); unchanged(t, before);
    store.transaction(() => { const s = store.load()!, b = s.batches[0]; delete b.productionImageBilling; delete b.productionImageBillingFingerprint; delete b.aggregate.productionBilling; store.save(s); });
    expect(() => r.read(actor, "project-a", id(t))).toThrow();
  });
});

describe("explicit production generated HTTP, no daily routing", () => {
  let t: Task, r: ImageProductionGeneratedAssetReadHarness, asset: string;
  beforeEach(async () => { t = await image(); r = reader(t); asset = id(t); });
  it("owned actual HTTP reads exact binary and bounded private lineage, default API stays 404", async () => {
    const base = await api(r), before = t.f.store.load(), response = await fetch(base + uri(asset)); expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(t.output); expect(response.headers.get("content-length")).toBe(String(t.output.length));
    expect(response.headers.get("content-type")).toBe("image/png"); expect(response.headers.get("x-content-sha256")).toBe(t.saved().productionImageArtifact!.image.checksumSha256);
    expect(response.headers.get("x-canvas-binary-version")).toBe("production-generated-image-v1"); expect(response.headers.get("x-canvas-image-mode")).toBe("production-contract-fixture");
    for (const [h, v] of [["cache-control", "private, no-store"], ["vary", "Authorization"], ["x-content-type-options", "nosniff"], ["cross-origin-resource-policy", "same-origin"], ["referrer-policy", "no-referrer"]]) expect(response.headers.get(h)).toBe(v);
    const lineage = await fetch(base + uri(asset, "lineage")); expect(lineage.status).toBe(200); expect(await lineage.json()).toEqual(r.lineage(principal, "project-a", asset));
    expect(response.headers.get("access-control-allow-origin")).toBeNull(); const daily = await api();
    for (const kind of ["lineage", "content"]) for (const method of ["GET", "POST"]) expect((await fetch(daily + uri(asset, kind), { method })).status).toBe(404); unchanged(t, before);
  });
  it.each(["query", "range", "post", "head", "escaped-id", "encoding", "get-body", "anonymous"])("rejects HTTP %s before reader calls", async bad => {
    const base = await api(r), read = vi.spyOn(r, "read"), lineage = vi.spyOn(r, "lineage"); let status: number;
    if (bad === "anonymous") { vi.spyOn(t.auth, "authenticate").mockReturnValue(null as never); status = (await fetch(base + uri(asset))).status; }
    else if (bad === "get-body") status = await new Promise<number>((resolve, reject) => { const req = httpRequest(base + uri(asset), { method: "GET", headers: { "content-length": "2" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); }); req.on("error", reject); req.end("{}"); });
    else status = (await fetch(base + uri(bad === "escaped-id" ? "bad%2Fid" : asset) + (bad === "query" ? "?proof=caller" : ""),
      { method: bad === "post" ? "POST" : bad === "head" ? "HEAD" : "GET", headers: bad === "range" ? { range: "bytes=0-1" } : bad === "encoding" ? { "content-encoding": "gzip" } : {} })).status;
    expect(status).toBe(bad === "range" ? 416 : bad === "post" || bad === "head" ? 405 : bad === "anonymous" ? 401 : 400); expect(read).not.toHaveBeenCalled(); expect(lineage).not.toHaveBeenCalled();
  });
  it.each(["promise", "foreign", "private-error"])("authentication %s refuses private reads and private errors", async bad => {
    const base = await api(r), load = vi.spyOn(t.f.store, "load"); vi.spyOn(t.auth, "authenticate").mockImplementation(() => {
      if (bad === "private-error") throw new Error("owned-secret-auth"); return (bad === "promise" ? Promise.resolve(principal) : { ...principal, tenantId: "foreign" }) as never;
    });
    const response = await fetch(base + uri(asset)); expect(response.ok).toBe(false); expect(await response.text()).not.toContain("owned-secret"); expect(load).not.toHaveBeenCalled();
  });
  it.each(["private", "wrong-scope", "wrong-hash", "mime", "private-error"])("bad injected port %s fails closed with fixed error", async bad => {
    const good = r.read(principal, "project-a", asset), base = await api(r);
    vi.spyOn(r, "read").mockImplementation(() => { if (bad === "private-error") throw new Error("owned-private-key-endpoint");
      const metadata = structuredClone(good.metadata); if (bad === "private") (metadata as unknown as Record<string, unknown>).credentialRef = "owned-private-key";
      if (bad === "wrong-scope") metadata.projectId = "foreign"; if (bad === "wrong-hash") metadata.image.checksumSha256 = "0".repeat(64); if (bad === "mime") metadata.image.asset.mimeType = "image/jpeg";
      return { metadata, body: Buffer.from(good.body) }; });
    const response = await fetch(base + uri(asset)); expect(response.status).toBe(503); expect(await response.text()).not.toContain("owned-private"); good.body.fill(0);
  });
  it("lineage JSON refuses private fields and changed image id", async () => {
    const view = r.lineage(principal, "project-a", asset), base = await api(r); vi.spyOn(r, "lineage").mockReturnValue({ ...view, workerId: "owned-private" } as never);
    const response = await fetch(base + uri(asset, "lineage")); expect(response.status).toBe(503); expect(await response.text()).not.toContain("owned-private");
    vi.spyOn(r, "lineage").mockReturnValue({ ...view, image: { ...view.image, asset: { ...view.image.asset, id: "foreign" } } }); expect((await fetch(base + uri(asset, "lineage"))).status).toBe(503);
  });
  it("two response-lifetime slots release on close, shared with old binary transfers", async () => {
    let hold = true; const base = await api(r, server => server.prependListener("request", (_req, response) => { const end = response.end.bind(response);
      response.end = ((...args: unknown[]) => { if (hold && response.statusCode === 200) { response.flushHeaders(); return response; }
        return (end as (...args: unknown[]) => ServerResponse)(...args); }) as ServerResponse["end"]; }));
    const pause = () => new Promise<IncomingMessage>((resolve, reject) => { const req = httpRequest(base + uri(asset), res => { res.pause(); sockets.push(res); resolve(res); }); req.on("error", reject); req.end(); });
    const a = await pause(), b = await pause(); expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
    expect((await fetch(base + uri(asset, "lineage"))).status).toBe(429); expect(acquireGeneratedTransfer()).toBeUndefined();
    a.destroy(); b.destroy(); await new Promise(r => setTimeout(r, 50)); hold = false; const available = await fetch(base + uri(asset)); expect(available.status).toBe(200); expect(Buffer.from(await available.arrayBuffer())).toEqual(t.output);
  });
  it("absolute 30-second response deadline destroys held transfer and clears owned bytes", () => {
    vi.useFakeTimers(); const body = r.read(principal, "project-a", asset), emitter = new EventEmitter(), response = Object.assign(emitter, {
      headersSent: false, writeHead: vi.fn(), setHeader: vi.fn(), end: vi.fn(), destroy: vi.fn(() => emitter.emit("close")), once: emitter.once.bind(emitter),
    }) as unknown as ServerResponse;
    vi.spyOn(r, "read").mockReturnValue(body); expect(handleProductionGeneratedAssetHttp({ url: uri(asset), method: "GET", headers: {} } as IncomingMessage, response, r)).toBe(true);
    vi.advanceTimersByTime(30_000); expect(response.destroy).toHaveBeenCalledTimes(1); expect(body.body.every(n => n === 0)).toBe(true);
    const release = acquireGeneratedTransfer(); expect(release).toBeDefined(); release?.(); release?.();
  });
  it.each(["aborted", "deadline"])("%s observed before write refuses a late synchronous port response", bad => {
    const body = r.read(principal, "project-a", asset), request = { url: uri(asset), method: "GET", headers: {}, aborted: false };
    const emitter = new EventEmitter(), response = Object.assign(emitter, { headersSent: false, writeHead: vi.fn(), setHeader: vi.fn(), end: vi.fn(), destroy: vi.fn(), once: emitter.once.bind(emitter) }) as unknown as ServerResponse;
    vi.spyOn(r, "read").mockImplementation(() => { if (bad === "aborted") request.aborted = true; else vi.spyOn(performance, "now").mockReturnValue(100_000); return body; });
    vi.spyOn(performance, "now").mockReturnValue(0);
    handleProductionGeneratedAssetHttp(request as IncomingMessage, response, r); expect(response.writeHead).toHaveBeenCalledWith(503, expect.anything());
    expect(body.body.every(n => n === 0)).toBe(true); emitter.emit("close");
  });
});
