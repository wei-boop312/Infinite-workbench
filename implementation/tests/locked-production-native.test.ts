import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createServer, request as httpsRequest } from "node:https";
import { once } from "node:events";
import type { Socket } from "node:net";
import { LockedProductionImageTaskReconstruction, LockedImageProductionReconstructionHarness } from "../apps/api/src/lockedProductionImageTaskReconstruction";
import { SqliteRunKernelStateStore } from "../apps/api/src/sqliteRunKernelStore";
import * as protocol from "../apps/api/src/lockedProductionImageProtocol";
import { lockedResponse, prepareLockedTaskFixture } from "./helpers/locked-production-task-fixture";
import { ownedProductionNetwork } from "./helpers/production-network-fixture";
import { principal, sha } from "./helpers/image-task-fixture";
import { ownedTestCertificate, ownedTestKey } from "./helpers/owned-tls-fixture";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
let source: Buffer, mask: Buffer;
const owned: Awaited<ReturnType<typeof prepareLockedTaskFixture>>[] = [];
const networks: Awaited<ReturnType<typeof ownedProductionNetwork>>[] = [];
beforeAll(async () => {
  const png = (p: number[]) => sharp(Buffer.from(p), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  source = await png([10,20,30,255,40,50,60,255]); mask = await png([0,0,0,0,255,255,255,255]);
});
afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve)); vi.restoreAllMocks();
  for (const n of networks.splice(0)) n.cleanup(); for (const f of owned.splice(0)) f.cleanup();
});
async function live(opts: Parameters<typeof prepareLockedTaskFixture>[2] = {}) {
  const f = await prepareLockedTaskFixture(source, mask, { ...opts, baseUrl: "https://owned.fixture.invalid/v1" }); owned.push(f);
  const response = lockedResponse(source), n = await ownedProductionNetwork(f.config, f.clock, response); networks.push(n);
  const core = f.connectNetwork(n.options), args = [principal, "project-a", f.v.batchId, f.v.jobId, f.input] as const;
  return { f, n, core, args, response, execute: (signal?: AbortSignal) => core.executeNetworkFixture(...args, { signal }),
    saved: () => f.store.load()!.batches[0] };
}
type Live = Awaited<ReturnType<typeof live>>;
const retained = (t: Live) => {
  const s = t.saved(); expect(s.reservedMinor).toBe(t.f.preparation.pricing.quote.maxCostMinor);
  expect(s.aggregate.jobs[0].actualCostMinor).toBeUndefined(); expect(s.aggregate.jobs[0].outputAssetIds).toEqual([]);
  expect(s.lockedProductionImageDispatchIntent?.transport).toBe("not-connected"); expect(s.productionImageExecution).toBeUndefined();
};

describe.each((["openai", "openai-compatible"] as const).flatMap(protocol => [false,true].map(manual => [protocol,manual] as const)))(
  "protected network %s manual=%s", (kind, manual) => {
    let t: Live;
    beforeEach(async () => { t = await live({ protocol: kind, manual }); });
    it("keeps complete v2 identity, original wire and one raw response", async () => {
      const { f, n } = t;
      n.hooks.write = () => { expect(t.saved().lockedProductionImageAttempt?.state).toBe("attempted"); expect(t.saved().lockedProductionImageResult).toBeUndefined(); };
      const originalRaw = Buffer.from(t.response.body);
      await t.execute(); const b = t.saved(), headers = n.captures[0].headers as Record<string,string>;
      expect(b.lockedProductionImageExecution?.schemaVersion).toBe(2); expect(b.lockedProductionImageExecution?.preparation.protectionPolicy).toEqual(f.preparation.protectionPolicy);
      expect(b.lockedProductionImageResult?.kind).toBe("returned"); expect(b.lockedProductionImageAttempt?.transport).toBe("contract-fixture");
      expect(b.aggregate.jobs[0].estimatedCostMinor).toBe(manual ? null : 25); retained(t);
      expect(n.options.localDrivers!.request).toHaveBeenCalledTimes(1); expect(n.options.credentials.rootKeys.withRootKey).toHaveBeenCalledTimes(1);
      expect(n.options.credentialVersion).toHaveBeenCalledWith(expect.objectContaining({ actorId: principal.actorId,
        requestFingerprint: b.lockedProductionImageAttempt!.requestFingerprint, payloadChecksumSha256: b.lockedProductionImageAttempt!.payloadChecksumSha256 }));
      expect(sha(n.captures[0].sentBody!)).toBe(b.lockedProductionImageAttempt!.payloadChecksumSha256);
      expect(headers.authorization).toBe("Bearer " + n.secret.toString()); expect(headers["content-length"]).toBe(String(n.captures[0].sentBody!.length));
      expect(JSON.stringify(b)).not.toContain(n.secret.toString());
      const raw = f.store.loadLockedProductionImageResponse(principal.tenantId, "project-a", "production-contract-fixture", f.v.jobId)!;
      expect(raw.body).toEqual(originalRaw); expect(raw.record).toEqual(b.lockedProductionImageResult); raw.body.fill(0); originalRaw.fill(0);
    });
    describe("already committed original history", () => {
      beforeEach(async () => { await t.execute(); });
      it("does not consume, normalize, quote, save or send again after expiry or restart", async () => {
        const before = t.f.store.load(); t.f.advance(90_000); t.f.register({ ...t.f.config, revision: 2, enabled: false });
        vi.mocked(t.n.options.credentials.rootKeys.withRootKey).mockClear(); t.f.pricePort.read.mockClear(); t.f.pricePort.verify.mockClear();
        const normalize = vi.spyOn(protocol, "prepareLockedProductionImageProtocol"), save = vi.spyOn(t.f.store, "save");
        expect((await t.execute()).started).toBe(false);
        const second = new SqliteRunKernelStateStore(t.f.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true });
        try { expect(second.load()).toEqual(before); } finally { second.close(); }
        expect(t.f.store.load()).toEqual(before); expect(t.n.options.credentials.rootKeys.withRootKey).not.toHaveBeenCalled();
        expect(normalize).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(t.f.pricePort.read).not.toHaveBeenCalled(); expect(t.f.pricePort.verify).not.toHaveBeenCalled();
        expect(t.n.options.localDrivers!.request).toHaveBeenCalledTimes(1);
      });
    });
  });

describe("protected native boundary and current guards", () => {
  let t: Live;
  beforeEach(async () => { t = await live(); });
  it("default/mixed/native-fixture configurations reject before private reads, roots or DNS", async () => {
    const read = vi.spyOn(t.f.store, "load"), { args, f, n } = t;
    await expect(new LockedProductionImageTaskReconstruction().executeNative(...args)).rejects.toThrow();
    await expect(new LockedImageProductionReconstructionHarness().executeNetworkFixture(...args)).rejects.toThrow();
    expect(() => new LockedProductionImageTaskReconstruction({ ...f.rebuildOptions, fixtureTransport: undefined, credentialNetwork: n.options })).toThrow();
    expect(() => new LockedImageProductionReconstructionHarness({ ...f.rebuildOptions, credentialNetwork: n.options })).toThrow();
    await expect(t.core.executeNative(...args)).rejects.toThrow(); await expect(t.core.executeFixture(...args)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(n.options.credentials.rootKeys.withRootKey).not.toHaveBeenCalled(); expect(n.options.localDrivers!.createResolver).not.toHaveBeenCalled();
  });
  it.each(["run:read", "run:execute", "provider:read", "asset:read"])("%s withdrawal prevents private credential and DNS reads", async permission => {
    t.f.deny(permission); const read = vi.spyOn(t.f.store, "load"); await expect(t.execute()).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(t.n.options.credentials.rootKeys.withRootKey).not.toHaveBeenCalled(); expect(t.n.captures).toHaveLength(0);
  });
  it.each(["missing", "version", "promise", "rejected", "root-permission", "root-time"])("%s cannot authorize credential consumption", async variant => {
    const n = t.n;
    if (variant === "version") vi.mocked(n.options.credentialVersion).mockReturnValue(2);
    if (variant === "promise" || variant === "rejected") vi.mocked(n.options.credentialVersion).mockImplementation(() =>
      (variant === "promise" ? Promise.resolve(1) : Promise.reject(new Error("owned-private"))) as never);
    if (variant === "missing") await n.credentials.revoke({ ...n.context, expectedVersion: 1 }, new AbortController().signal);
    if (variant === "root-permission") n.hooks.root = () => t.f.responseAllow(false);
    if (variant === "root-time") n.hooks.root = () => t.f.advance(60_000);
    await t.execute().catch(() => undefined);
    expect(n.options.localDrivers!.createResolver).not.toHaveBeenCalled(); expect(t.saved().lockedProductionImageAttempt).toBeDefined(); retained(t);
  });
  it.each(["false", "promise", "rejected"])("network policy %s must be synchronous true", async variant => {
    vi.mocked(t.n.options.network.authorize).mockImplementation(() =>
      (variant === "false" ? false : variant === "promise" ? Promise.resolve(true) : Promise.reject(new Error("owned-private"))) as never);
    await t.execute(); expect(t.n.options.localDrivers!.createResolver).not.toHaveBeenCalled(); expect(t.n.captures).toHaveLength(0);
    expect(t.saved().lockedProductionImageResult?.kind).toBe("interrupted"); retained(t);
  });
  it.each(["permission", "price", "lease", "rotate", "revoke", "connection", "input", "constraint"])("TLS before-write %s drift prevents body write", async variant => {
    t.n.hooks.tls = async () => {
      if (variant === "permission") t.f.responseAllow(false);
      else if (variant === "price") t.f.pricePort.verify.mockReturnValue(false);
      else if (variant === "lease") t.f.advance(30_000);
      else if (variant === "rotate") await t.n.credentials.rotate({ ...t.n.context, expectedVersion: 1 }, t.n.secret, new AbortController().signal);
      else if (variant === "revoke") await t.n.credentials.revoke({ ...t.n.context, expectedVersion: 1 }, new AbortController().signal);
      else if (variant === "connection") t.f.register({ ...t.f.config, revision: 2 });
      else { const c = t.f.store.loadCatalog()!; if (variant === "input") c.projects[0].assets.find(a => a.id === "source")!.originalName = "changed";
        else c.projects[0].constraints[0].brandRules.style = "changed"; t.f.store.transaction(() => t.f.store.saveCatalog(c)); }
    };
    if (variant === "permission") {
      await expect(t.execute()).rejects.toThrow();
      expect(t.saved().lockedProductionImageAttempt).toBeDefined(); expect(t.saved().lockedProductionImageResult).toBeUndefined();
    } else await t.execute().catch(() => undefined);
    expect(t.n.captures).toHaveLength(1); expect(t.n.captures[0].sentBody).toBeUndefined();
    expect(t.saved().lockedProductionImageResult?.kind).not.toBe("returned"); retained(t);
  });
  it("received response survives final credential-policy withdrawal without another consume", async () => {
    vi.mocked(t.n.options.credentials.authorize).mockImplementation(() => !t.n.captures.some(c => c.sentBody));
    await t.execute(); expect(t.saved().lockedProductionImageResult?.kind).toBe("returned"); expect(t.n.captures).toHaveLength(1); retained(t);
  });
  it.each([1,2])("raw actual SQL insert %s withdrawal rolls back both tables", async write => {
    const check = t.n.options.network.authorize, policy = t.f.store.saveLockedProductionImageResponse.bind(t.f.store); let writes = 0;
    vi.spyOn(t.f.store, "saveLockedProductionImageResponse").mockImplementation((r,b,after,limits) => policy(r,b,() => {
      if (++writes === write) t.f.responseAllow(false); after();
    },limits));
    await expect(t.execute()).rejects.toThrow(); expect(t.saved().lockedProductionImageResult).toBeUndefined();
    expect(t.f.store.loadLockedProductionImageResponse(principal.tenantId,"project-a","production-contract-fixture",t.f.v.jobId)).toBeNull();
    expect(t.saved().lockedProductionImageAttempt).toBeDefined(); expect(t.n.captures).toHaveLength(1); retained(t);
    expect(check).toHaveBeenCalled(); expect(writes).toBe(write);
  });
});

describe.each(["valid", "ca", "hostname", "before-write-revoke", "redirect"])("owned real TLS %s (not production public networking)", variant => {
  let t: Live;
  beforeEach(async () => { t = await live(); });
  it("preserves the v2 task guard, TLS checks and unknown reservation", async () => {
    const peers: Socket[] = [], seen: Buffer[] = [];
    const server = createServer({ cert: ownedTestCertificate, key: ownedTestKey }, (req,res) => {
      const chunks: Buffer[] = []; req.on("data", data => chunks.push(data)); req.on("end", () => {
        seen.push(Buffer.concat(chunks));
        if (variant === "redirect") { res.writeHead(302, { Location: "https://another.invalid/" }); res.end(); }
        else { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": t.response.body.length }); res.end(t.response.body); }
      });
    });
    server.on("connection", s => peers.push(s)); server.listen(0,"127.0.0.1"); await once(server,"listening");
    const port = (server.address() as {port:number}).port;
    t.n.options.localDrivers!.request = vi.fn((original, callback) => {
      expect(original.hostname).toBe("owned.fixture.invalid"); expect(original.servername).toBe("owned.fixture.invalid"); expect(original.rejectUnauthorized).toBe(true);
      const request = httpsRequest({ ...original, port, ...(variant === "ca" ? {} : { ca: ownedTestCertificate }),
        ...(variant === "hostname" ? { servername: "wrong.fixture.invalid" } : {}), lookup: (_host,_opts,done) => done(null,"127.0.0.1",4) },callback);
      if (variant === "before-write-revoke") request.on("socket", socket => socket.prependListener("secureConnect", () => t.f.responseAllow(false)));
      return request;
    });
    // Capture this explicitly injected owned driver before constructing the service.
    t.core = t.f.connectNetwork(t.n.options);
    try {
      await t.core.executeNetworkFixture(...t.args).catch(() => undefined);
      if (variant === "valid") { expect(t.saved().lockedProductionImageResult?.kind).toBe("returned"); expect(seen).toHaveLength(1);
        expect(sha(seen[0])).toBe(t.saved().lockedProductionImageAttempt!.payloadChecksumSha256); }
      else { expect(t.saved().lockedProductionImageResult?.kind).not.toBe("returned"); expect(seen).toHaveLength(variant === "redirect" ? 1 : 0); }
      retained(t);
    } finally { for (const p of peers) p.destroy(); await new Promise<void>((resolve,reject) => server.close(e => e ? reject(e) : resolve())); }
  });
});

describe.each(["multipart-image-array", "multipart-image-single"] as const)("protected original %s", encoding => {
  let t: Live;
  beforeEach(async () => { t = await live({ protocol: "openai-compatible", encoding, manual: true }); });
  it("keeps exact boundary/body and policy identity, without a synthetic estimate", async () => {
    await t.execute(); const s = t.saved(), headers = t.n.captures[0].headers as Record<string,string>;
    expect(s.lockedProductionImageResult?.kind).toBe("returned"); expect(s.aggregate.jobs[0].estimatedCostMinor).toBeNull();
    expect(headers["content-type"]).toBe(s.lockedProductionImageExecution!.protocol.contentType);
    expect(headers["content-type"]).toMatch(/^multipart\/form-data; boundary=canvas-[a-f0-9]{40}$/);
    expect(sha(t.n.captures[0].sentBody!)).toBe(s.lockedProductionImageAttempt!.payloadChecksumSha256); retained(t);
  });
});
describe("protected zero cap", () => {
  let t: Live;
  beforeEach(async () => { t = await live({ manual: true, cap: 0 }); });
  it("still freezes full identity and unknown fees, never fills estimate/actual with zero", async () => {
    await t.execute(); expect(t.saved().lockedProductionImageResult?.kind).toBe("returned"); retained(t);
    expect(t.saved().aggregate.jobs[0].estimatedCostMinor).toBeNull();
    expect(t.saved().jobReservations).toEqual([[t.f.v.jobId,0]]);
  });
});
describe("protected received history within original absolute deadline", () => {
  let t: Live;
  beforeEach(async () => { t = await live({ priceDurationMs: 1000, kernel: { leaseDurationMs: 1000 } }); });
  it("preserves the original raw after price/lease expiry and directory shutdown, with no new verify", async () => {
    let originalReason: string | undefined, originalFinished: string | undefined;
    t.n.hooks.write = () => {
      t.f.advance(1100); t.f.register({ ...t.f.config, revision: 2, enabled: false });
      t.f.kernel.reconcileLockedProductionImageBatch(principal,"project-a",t.f.v.batchId);
      originalReason = t.saved().aggregate.jobs[0].failureCode; originalFinished = t.saved().aggregate.jobs[0].finishedAt;
      t.f.pricePort.verify.mockClear();
    };
    await t.execute(); const s = t.saved();
    expect(s.lockedProductionImageResult?.kind).toBe("returned"); expect(s.aggregate.jobs[0].failureCode).toBe(originalReason);
    expect(s.aggregate.jobs[0].finishedAt).toBe(originalFinished); expect(s.aggregate.ledger.map(x => x.settlement)).toEqual(["reserved","unknown"]);
    expect(t.f.pricePort.verify).not.toHaveBeenCalled(); expect(t.n.captures).toHaveLength(1); retained(t);
  });
});

describe("protected network actual task write rollback", () => {
  let t: Live;
  beforeEach(async () => { t = await live(); });
  it.each(["fault","revoke","clock","capacity","cancel"])("returned task SQL after-write %s keeps original attempt and max", async failure => {
    const save = t.f.store.save.bind(t.f.store), abort = new AbortController(), catalog = t.f.store.loadCatalog(); let hit = false;
    vi.spyOn(t.f.store,"save").mockImplementation(s => {
      save(s); if (hit || s.batches[0].lockedProductionImageResult?.kind !== "returned") return; hit = true;
      if (failure === "fault") throw new Error("owned SQL failure");
      if (failure === "revoke") t.f.responseAllow(false);
      if (failure === "clock") t.f.advance(-1);
      if (failure === "cancel") abort.abort();
      if (failure === "capacity") { const c = t.f.store.loadCatalog()!; c.projects[0].constraints[0].brandRules.style = "x".repeat(512*1024); t.f.store.saveCatalog(c); }
    });
    await t.execute(abort.signal).catch(() => undefined); expect(hit).toBe(true);
    expect(t.saved().lockedProductionImageAttempt).toBeDefined(); expect(t.saved().lockedProductionImageResult?.kind).not.toBe("returned");
    expect(t.f.store.loadLockedProductionImageResponse(principal.tenantId,"project-a","production-contract-fixture",t.f.v.jobId)).toBeNull();
    expect(t.f.store.loadCatalog()).toEqual(catalog); expect(t.n.captures).toHaveLength(1); retained(t);
  });
});
