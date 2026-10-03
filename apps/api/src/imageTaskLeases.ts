import { ExecuteRunJobRequestSchema, type ExecuteRunJobRequest } from "@canvas/contracts";
import { ImageProviderContractError } from "./imageProviderContract";
import { prepareOpenAiImageRequest } from "./openaiImageProtocol";
import { prepareCompatibleImageRequest } from "./compatibleImageProtocol";
import { prepareGoogleImageRequest } from "./googleImageProtocol";
import type { TrustedImageBytes } from "./imageRequestPayload";
import type { ConfirmedImageExecution, ImageDispatchIntent, RunBatchAggregate } from "@canvas/contracts";
type Prepared = Awaited<ReturnType<typeof prepareOpenAiImageRequest>> | Awaited<ReturnType<typeof prepareCompatibleImageRequest>> | Awaited<ReturnType<typeof prepareGoogleImageRequest>>;
export type FirstImageStart = { execution: ConfirmedImageExecution; prepared: Prepared; intent: ImageDispatchIntent; aggregate: RunBatchAggregate };
import { RunKernelError, type RunPrincipal } from "./runKernel";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import { SqliteRunKernelStateStore, SqliteStateStoreError } from "./sqliteRunKernelStore";

let activePreparations = 0;

// Server-internal protocol rebuild + lease-bound write-ahead intent. It exposes
// NO HTTP route, fixture transport, secret lookup, response or asset authority.
export class LocalImageTaskLeases {
  constructor(private readonly options: { stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel; clock?: () => number }) {
    if (!options.runKernel.usesStateStore(options.stateStore)) throw new Error("图片租约必须与任务内核共用同一事务存储实例");
  }

  async prepareStart(principal: RunPrincipal, jobId: string, input: ExecuteRunJobRequest) {
    return this.prepare(principal, jobId, input);
  }

  // Trusted server continuation only; private wire context is never returned to
  // callers/replays. A persisted intent without this live continuation cannot send.
  async withFirstStart(principal: RunPrincipal, jobId: string, input: ExecuteRunJobRequest, continuation: (context: FirstImageStart) => Promise<void>) {
    return this.prepare(principal, jobId, input, continuation);
  }

  private async prepare(principal: RunPrincipal, jobId: string, input: ExecuteRunJobRequest, continuation?: (context: FirstImageStart) => Promise<void>) {
    const lease = ExecuteRunJobRequestSchema.parse(input);
    try {
      const initial = this.database(() => {
        const inspected = this.options.runKernel.inspectImageLease(principal, jobId, lease);
        // A persisted intent never authorizes a second transport call. Avoid even
        // re-decoding expired inputs during a history-only recovery.
        if (inspected.intent) return { replay: { aggregate: inspected.aggregate, intent: inspected.intent, started: false as const } };
        if (activePreparations >= 2) throw new RunKernelError(429, "image_dispatch_capacity", "本机正在准备其他图片派发");
        const execution = inspected.execution;
        const refs = execution.request.operation === "edit" ? [...execution.request.inputs, ...(execution.request.mask ? [execution.request.mask] : [])] : [];
        const images: TrustedImageBytes[] = refs.map((ref) => {
          const image = this.options.stateStore.loadVerifiedImageBytes(principal.tenantId, execution.request.projectId, ref.assetId);
          if (!image) throw new RunKernelError(422, "image_input_not_verified", "权威输入缺失");
          return image;
        });
        return { execution, images };
      });
      if (initial.replay) return initial.replay;
      activePreparations++;
      try {
        const { execution, images } = initial;
        const prepare = execution!.preparation.connection.protocol === "openai" ? prepareOpenAiImageRequest
          : execution!.preparation.connection.protocol === "openai-compatible" ? prepareCompatibleImageRequest : prepareGoogleImageRequest;
        const prepared = await prepare(execution!.preparation.connection, execution!.request, images!, new Date((this.options.clock ?? Date.now)()).toISOString());
        const started = this.options.runKernel.startImageJob(principal, jobId, lease, prepared);
        if (started.started && continuation) {
          await continuation({ execution: execution!, prepared, intent: started.intent, aggregate: started.aggregate });
          return { ...started, aggregate: this.options.runKernel.getBatch(principal, started.aggregate.batch.id) };
        }
        return started;
      } finally { activePreparations--; }
    } catch (error) {
      if (error instanceof RunKernelError) throw error;
      if (error instanceof ImageProviderContractError) throw new RunKernelError(422, error.code, "协议准备拒绝当前图片任务");
      throw new RunKernelError(503, error instanceof SqliteStateStoreError ? error.code : "run_state_unavailable", "图片执行准备或证据存储不可用，请检查持久化记录；不会自动重发");
    }
  }

  private database<T>(action: () => T): T { return this.options.stateStore.transaction(action); }
}
