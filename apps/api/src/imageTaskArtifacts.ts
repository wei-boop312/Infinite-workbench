import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import { LocalGeneratedImages } from "./generatedImages";
import { imageSnapshotFingerprint } from "./imageProviderContract";
import { parseStoredImageResponse } from "./imageArtifactPolicy";
import { prepareOpenAiImageRequest } from "./openaiImageProtocol";
import { prepareCompatibleImageRequest } from "./compatibleImageProtocol";
import { prepareGoogleImageRequest } from "./googleImageProtocol";
import { RunKernelError, type RunPrincipal } from "./runKernel";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";

let activeIngestions = 0;
// Internal, explicitly configured artifact processor. It cannot send, quote,
// release billing or take a caller-supplied candidate/confirmation/receipt.
export class LocalImageTaskArtifacts {
  constructor(private readonly options: { tenantId: string; stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel;
    authorizer: ObjectStorageAuthorizer; clock?: () => number; maxProjectBytes?: number }) {
    if (!options.runKernel.usesStateStore(options.stateStore)) throw new Error("产物与任务必须共用同一事务存储实例");
    // Reuse the 5A capacity/tenant configuration checks; this does not authorize.
    new LocalGeneratedImages({ ...options, authorizeCommit: () => { throw new Error("not-authorized"); } });
  }
  usesStateStore(store: SqliteRunKernelStateStore) { return this.options.stateStore === store; }
  async ingest(principal: RunPrincipal, jobId: string) {
    if (activeIngestions >= 2) throw new RunKernelError(429, "image_output_busy", "本机正在处理其他产物，无需重发请求");
    activeIngestions++;
    try {
      const initial = this.options.stateStore.transaction(() => {
        // This requires current permissions, actual original actor/lease, full
        // confirmation and a persisted returned response BEFORE private reads.
        const inspected = this.options.runKernel.inspectImageArtifact(principal, jobId), { execution } = inspected;
        if (principal.tenantId !== this.options.tenantId) throw new RunKernelError(404, "image_output_not_found", "产物不可用");
        const response = this.options.stateStore.loadImageFixtureResponse(principal.tenantId, execution.request.projectId, jobId)!;
        const refs = execution.request.operation === "edit" ? [...execution.request.inputs, ...(execution.request.mask ? [execution.request.mask] : [])] : [];
        const inputs = inspected.artifact ? [] : refs.map((ref) => {
          const input = this.options.stateStore.loadVerifiedImageBytes(principal.tenantId, execution.request.projectId, ref.assetId);
          if (!input) throw new RunKernelError(422, "image_output_input_missing", "实际原图不可用"); return input;
        });
        return { ...inspected, response, inputs };
      });
      const { execution, response } = initial;
      if (initial.artifact) return new LocalGeneratedImages({ ...this.options, authorizeCommit: () => { throw new Error("history-not-execution"); } }).get(principal, execution.request.projectId, jobId);
      try {
        const parsed = parseStoredImageResponse(execution, response);
        if (!parsed.candidate || parsed.outcome.failureCode || parsed.outcome.artifactStatus !== "pending-validation") throw new RunKernelError(422, "image_output_response_not_accepted", "原始响应没有可验证的图片候选");
        const prepare = execution.preparation.connection.protocol === "openai" ? prepareOpenAiImageRequest : execution.preparation.connection.protocol === "openai-compatible" ? prepareCompatibleImageRequest : prepareGoogleImageRequest;
        // Reconstruct immutable wire at original confirmation time, NOT a new
        // dispatch. No network, even if the current connection has been disabled.
        const prepared = await prepare(execution.preparation.connection, execution.request, initial.inputs, execution.confirmedAt);
        if (prepared.payloadChecksumSha256 !== execution.payloadChecksumSha256 || prepared.body.byteLength !== execution.payloadByteSize || prepared.contentType !== execution.contentType
          || imageSnapshotFingerprint(prepared.transformedInputs) !== imageSnapshotFingerprint(execution.transformedInputs)) throw new RunKernelError(409, "image_output_prepared_payload_changed", "重建字节与已发送确认不一致");
        const service = new LocalGeneratedImages({ ...this.options, authorizeCommit: (request, fingerprint, payloadHash, binding) => {
          const fresh = this.options.runKernel.inspectImageArtifact(principal, jobId);
          if (imageSnapshotFingerprint(fresh.execution) !== imageSnapshotFingerprint(execution) || imageSnapshotFingerprint(fresh.result) !== imageSnapshotFingerprint(response.record)
            || imageSnapshotFingerprint(request) !== imageSnapshotFingerprint(execution.request) || fingerprint !== execution.requestFingerprint || payloadHash !== execution.payloadChecksumSha256
            || binding.confirmedAt !== execution.confirmedAt || imageSnapshotFingerprint(binding.transformedInputs) !== imageSnapshotFingerprint(execution.transformedInputs)
            || binding.candidateChecksumSha256 !== parsed.candidate!.checksumSha256 || binding.outcomeFingerprint !== imageSnapshotFingerprint(parsed.outcome)) {
            throw new RunKernelError(409, "image_output_execution_mismatch", "产物不是该实际确认与原始响应的候选");
          }
          return undefined;
        }, onVerifiedCommit: (record) => { this.options.runKernel.attachImageArtifact(principal, record); return undefined; } });
        return await service.accept(principal, { connection: execution.preparation.connection, request: execution.request,
          confirmedFingerprint: execution.requestFingerprint, confirmedAt: execution.confirmedAt, prepared }, parsed);
      } catch (error) {
        const code = error instanceof RunKernelError && /^image_output_[a-z_]+$/.test(error.code) ? error.code : "image_output_save_failed";
        // Audit separately AFTER the asset+task transaction has rolled back.
        // A denial/corrupt/full database may also prevent this audit; the original
        // response and reservation remain, and there is NEVER a new send.
        const stage = error instanceof RunKernelError && error.status < 500 && !["image_output_project_quota", "image_output_metadata_quota", "image_output_catalog_full"].includes(code) ? "validation" : "commit";
        try { this.options.runKernel.recordImageArtifactFailure(principal, jobId, stage, code); } catch { /* Original evidence is retained; no forced permission or quota bypass. */ }
        if (error instanceof RunKernelError) throw error;
        throw new RunKernelError(503, "image_output_save_failed", "产物未能原子保存，原响应和未知预留保留");
      }
    } finally { activeIngestions--; }
  }
}
