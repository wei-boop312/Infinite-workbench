import { SqliteRunKernelStateStore } from "../../apps/api/src/sqliteRunKernelStore";
import { SqliteRunKernel } from "../../apps/api/src/sqliteRunKernel";
import { ImageProductionBillingSettlementHarness } from "../../apps/api/src/productionImageBillingSettlement";
import type { ReviewProductionImageBilling, DecideProductionImageBilling } from "../../packages/contracts/src/index";
type Command = { path: string; now: number; batch: string; job: string; request?: ReviewProductionImageBilling; reviewId?: string; decision?: DecideProductionImageBilling };
let store: SqliteRunKernelStateStore, billing: ImageProductionBillingSettlementHarness, command: Command;
process.on("message", (message: Command | "go") => {
  try {
    if (message !== "go") {
      command = message; store = new SqliteRunKernelStateStore(command.path, { productionResponseStorageEnabled: true, productionArtifactStorageEnabled: true });
      const auth = { authenticate: () => null, allows: (p: { tenantId: string; actorId: string }, project: string) => p.tenantId === "tenant-a" && ["writer", "other"].includes(p.actorId) && project === "project-a" };
      const kernel = new SqliteRunKernel({ stateStore: store, authorizer: auth, budgets: [{ tenantId: "tenant-a", projectId: "project-a", currency: "CNY", limitMinor: 1000 }], clock: () => command.now,
        productionImageBillingPolicy: { usesStateStore: s => billing?.billingPolicy.usesStateStore(s) ?? false,
          authorizeScope: (p,j,a) => billing?.billingPolicy.authorizeScope(p,j,a) ?? false, validateCommit: (p,r) => billing?.billingPolicy.validateCommit(p,r) ?? false } });
      billing = new ImageProductionBillingSettlementHarness({ billingSettlementEnabled: true, tenantId: "tenant-a", stateStore: store, runKernel: kernel,
        runAuthorizer: auth, providerAuthorizer: auth, assetAuthorizer: auth, clock: () => command.now,
        billingSource: { kind: "contract-fixture", realExecutionEnabled: false, verify: () => true } });
      process.send?.({ ready: true }); return;
    }
    const result = store.transaction(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      return command.decision ? billing.decide({ tenantId: "tenant-a", actorId: "writer" }, "project-a", command.batch, command.job, command.reviewId!, command.decision)
        : billing.settle({ tenantId: "tenant-a", actorId: "other" }, "project-a", command.batch, command.job, command.request!);
    });
    process.send?.({ ok: true, result }); store.close(); process.disconnect();
  } catch { process.send?.({ ok: false }); store?.close(); process.disconnect(); }
});
