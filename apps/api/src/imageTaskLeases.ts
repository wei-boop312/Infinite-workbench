import { ExecuteRunJobRequestSchema, type ExecuteRunJobRequest } from "@canvas/contracts";
import { ImageProviderContractError } from "./imageProviderContract";
import { prepareOpenAiImageRequest } from "./openaiImageProtocol";
import { prepareCompatibleImageRequest } from "./compatibleImageProtocol";
import { prepareGoogleImageRequest } from "./googleImageProtocol";
import type { TrustedImageBytes } from "./imageRequestPayload";
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
        return this.options.runKernel.startImageJob(principal, jobId, lease, prepared);
      } finally { activePreparations--; }
    } catch (error) {
      if (error instanceof RunKernelError) throw error;
      if (error instanceof ImageProviderContractError) throw new RunKernelError(422, error.code, "协议准备拒绝当前图片任务");
      throw new RunKernelError(503, error instanceof SqliteStateStoreError ? error.code : "run_state_unavailable", "图片租约存储不可用，未发送供应商请求");
    }
  }

  private database<T>(action: () => T): T { return this.options.stateStore.transaction(action); }
}
