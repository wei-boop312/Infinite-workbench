import { SqliteRunKernel } from "../../apps/api/src/sqliteRunKernel";
import { SqliteRunKernelStateStore } from "../../apps/api/src/sqliteRunKernelStore";
import { RunKernelError, type RunKernelOptions } from "../../apps/api/src/runKernel";
import type { CreateRunBatchRequest, ReviewBillingOverage } from "../../packages/contracts/src/index";

type Command = {
  path: string;
  mode: "create" | "confirm" | "claim" | "execute" | "review" | "crash-confirm";
  batchId?: string;
  jobId?: string;
  workerId?: string;
  leaseId?: string;
  overageId?: string;
  review?: ReviewBillingOverage;
  request?: CreateRunBatchRequest;
  providerLimits?: RunKernelOptions["providerLimits"];
};
const principal = { tenantId: "tenant-a", actorId: "owner" };
let store: SqliteRunKernelStateStore;
let kernel: SqliteRunKernel;
let command: Command;
process.on("message", (message: Command | "go") => {
  if (message !== "go") {
    command = message;
    const options: RunKernelOptions = { authorizer: { authenticate: () => null, allows: () => true },
      budgets: [{ tenantId: "tenant-a", projectId: "project-a", currency: "CNY", limitMinor: 100 }],
      unitEstimateMinor: 40, unitActualMinor: 30, maxConcurrentJobs: 2, providerLimits: command.providerLimits };
    store = new SqliteRunKernelStateStore(command.path);
    kernel = new SqliteRunKernel({ ...options, stateStore: store });
    process.send?.({ ready: true });
    return;
  }
  try {
    let rejection: RunKernelError | undefined;
    const result = store.transaction(() => {
      // Deliberately overlap separate OS processes while they hold the writer lock.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      try {
        if (command.mode === "create") return kernel.createBatch(principal, command.request!);
        if (command.mode === "confirm" || command.mode === "crash-confirm") {
          const confirmed = kernel.confirmBatch(principal, command.batchId!, { expectedEstimatedCostMinor: 80, expectedCurrency: "CNY" });
          if (command.mode === "crash-confirm") process.exit(27); // No COMMIT; SQLite must undo the entire confirmation.
          return confirmed;
        }
        if (command.mode === "claim") return kernel.claimBatch(principal, command.batchId!, { workerId: command.workerId!, maxJobs: 1 });
        if (command.mode === "execute") return kernel.executeLeasedJob(principal, command.jobId!, { workerId: command.workerId!, leaseId: command.leaseId! });
        return kernel.reviewBillingOverage({ ...principal, actorId: "reviewer" }, command.jobId!, command.overageId!, command.review!);
      } catch (error) {
        if (!(error instanceof RunKernelError)) throw error;
        rejection = error;
        return undefined;
      }
    });
    if (rejection) throw rejection;
    store.close();
    process.send?.({ ok: true, result }, () => process.disconnect());
  } catch (error) {
    store.close();
    process.send?.({ ok: false, error: error instanceof RunKernelError ? error.code : String(error) }, () => process.disconnect());
  }
});
