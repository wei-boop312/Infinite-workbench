import { SqliteRunKernel } from "../../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../../apps/api/src/sqliteRunKernelStore";
import { createLockedProductionImageLeaseFixturePolicy } from "../../apps/api/src/lockedProductionImageLeasePolicy";

// Owned contract-fixture DB only, sent by the zero-fee test. No URL/credential/network driver.
let command: { path: string; batch: string; now: number; operation: "claim" | "cancel"; worker: string };
process.on("message", message => {
  if (message !== "go") { command = message as typeof command; process.send?.({ ready: true }); return; }
  let store: SqliteRunKernelStateStore | undefined;
  try {
    store = new SqliteRunKernelStateStore(command.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true });
    const principal = { tenantId: "tenant-a", actorId: "writer" }, clock = () => command.now;
    const authorizer = { authenticate: () => principal, allows: (p: typeof principal, project: string) => p.tenantId === principal.tenantId && p.actorId === principal.actorId && project === "project-a" };
    const policy = createLockedProductionImageLeaseFixturePolicy({ lockedLeaseEnabled: true, tenantId: principal.tenantId, stateStore: store,
      pricePort: { kind: "contract-fixture", realExecutionEnabled: false, verify: () => true }, runAuthorizer: authorizer, providerAuthorizer: authorizer,
      assetAuthorizer: authorizer, lockedLeasePolicy: () => true, clock });
    const kernel = new SqliteRunKernel({ stateStore: store, authorizer, clock, budgets: [{ tenantId: principal.tenantId, projectId: "project-a", currency: "CNY", limitMinor: 1000 }], lockedProductionImageLeasePolicy: policy });
    const result = command.operation === "claim" ? kernel.claimLockedProductionImageBatch(principal, "project-a", command.batch, { workerId: command.worker, maxJobs: 1 })
      : kernel.cancelLockedProductionImageBatch(principal, "project-a", command.batch);
    store.close(); process.send?.({ ok: true, result }); process.disconnect();
  } catch { store?.close(); process.send?.({ ok: false }); process.disconnect(); }
});
