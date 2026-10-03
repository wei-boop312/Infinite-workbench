import { randomUUID } from "node:crypto";
import { ImageFixtureResultSchema, type ExecuteRunJobRequest, type ImageFixtureResult } from "@canvas/contracts";
import { LocalImageTaskLeases, type FirstImageStart } from "./imageTaskLeases";
import { imagePayloadSha256 } from "./imageRequestPayload";
import { MAX_IMAGE_PROTOCOL_RESPONSE_BYTES, unknownImageResponse, type ImageProtocolResponse } from "./imageProtocolResponse";
import { parseOpenAiImageResponse } from "./openaiImageProtocol";
import { parseCompatibleImageResponse } from "./compatibleImageProtocol";
import { parseGoogleImageResponse } from "./googleImageProtocol";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";
import { RunKernelError, type RunPrincipal } from "./runKernel";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import { SqliteRunKernelStateStore, SqliteStateStoreError } from "./sqliteRunKernelStore";

export type LocalFixtureTransport = {
  mode: "local-fixture"; realExecutionEnabled: false;
  // Explicit test transport, never passed an endpoint, auth plan or connection.
  send(request: { method: "POST"; path: string; contentType: string; body: Buffer }, signal: AbortSignal): Promise<ImageProtocolResponse>;
};
// No production worker, HTTP route, network implementation or secret lookup.
// The injected transport is trusted local test code, not user-supplied script.
export class LocalFixtureImageExecutor {
  private readonly leases: LocalImageTaskLeases;
  private readonly timeout: number;
  private readonly metadataQuota: number;
  private readonly binaryQuota: number;
  constructor(private readonly options: { stateStore: SqliteRunKernelStateStore; runKernel: SqliteRunKernel; transport: LocalFixtureTransport;
    clock?: () => number; timeoutMs?: number; maxMetadataBytes?: number; maxProjectBytes?: number }) {
    if (options.transport?.mode !== "local-fixture" || options.transport.realExecutionEnabled !== false || typeof options.transport.send !== "function") throw new Error("必须显式配置零费用本地假传输");
    this.timeout = options.timeoutMs ?? 5000; this.metadataQuota = options.maxMetadataBytes ?? 16 * 1024 * 1024; this.binaryQuota = options.maxProjectBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 30000 || !Number.isSafeInteger(this.metadataQuota) || this.metadataQuota < 0 || this.metadataQuota > 16 * 1024 * 1024
      || !Number.isSafeInteger(this.binaryQuota) || this.binaryQuota < 0 || this.binaryQuota > 512 * 1024 * 1024) throw new Error("本地传输容量或超时配置无效");
    this.leases = new LocalImageTaskLeases(options);
  }
  async execute(principal: RunPrincipal, jobId: string, lease: ExecuteRunJobRequest) {
    if (this.options.transport.mode !== "local-fixture" || this.options.transport.realExecutionEnabled !== false) throw new RunKernelError(503, "image_fixture_transport_disabled", "本地假传输配置已改变");
    return this.leases.withFirstStart(principal, jobId, lease, (context) => this.firstAttempt(principal, lease, context));
  }
  private async firstAttempt(principal: RunPrincipal, lease: ExecuteRunJobRequest, context: FirstImageStart): Promise<void> {
    const { execution, prepared } = context, request = execution.request;
    // Write-ahead attempt must commit before the transport is invoked. If this
    // throws (even after write), there is no send and the intent cannot re-send.
    const attempt = this.options.runKernel.beginImageFixtureAttempt(principal, request.jobId, lease, prepared);
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: Extract<ImageFixtureResult, { kind: "interrupted" }>["failureCode"] = "fixture-transport-error";
    try {
      const timedOut = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { failure = "fixture-timeout"; controller.abort(); reject(new Error("fixture-timeout")); }, this.timeout); });
      const path = "path" in prepared ? prepared.path : new URL(prepared.endpointUrl).pathname;
      const response = await Promise.race([this.options.transport.send({ method: "POST", path, contentType: prepared.contentType, body: Buffer.from(prepared.body) }, controller.signal), timedOut]);
      clearTimeout(timer);
      failure = "fixture-response-invalid";
      if (!response || !Buffer.isBuffer(response.body) || response.body.byteLength > MAX_IMAGE_PROTOCOL_RESPONSE_BYTES || !Number.isInteger(response.status)
        || response.status < 100 || response.status > 599 || typeof response.contentType !== "string" || !/^[\x20-\x7e]{1,256}$/.test(response.contentType)) throw new Error("fixture-response-invalid");
      const body = Buffer.from(response.body);
      const requestId = response.requestId && /^[A-Za-z0-9_.:-]{1,160}$/.test(response.requestId) ? response.requestId : undefined;
      const copied = { status: response.status, contentType: response.contentType, requestId, body };
      const parse = execution.preparation.connection.protocol === "openai" ? parseOpenAiImageResponse : execution.preparation.connection.protocol === "openai-compatible" ? parseCompatibleImageResponse : parseGoogleImageResponse;
      const parsed = parse(request, execution.requestFingerprint, copied);
      const result = ImageFixtureResultSchema.parse({ schemaVersion: 1, mode: "local-fixture", id: `fixture-result-${randomUUID()}`, attemptId: attempt.id, kind: "returned",
        receivedAt: this.at(), outcome: parsed.outcome, status: copied.status, contentType: copied.contentType, requestId,
        bodyChecksumSha256: imagePayloadSha256(body), bodyByteSize: body.byteLength });
      failure = "fixture-response-save-failed";
      this.options.stateStore.transaction(() => {
        const { tenantId, projectId, jobId } = request;
        if (this.options.stateStore.localImageBinaryBytes(tenantId, projectId) + body.byteLength > this.binaryQuota) throw new RunKernelError(413, "image_fixture_binary_quota", "本地响应容量不足");
        // Append task evidence first inside the SAME outer transaction. The raw
        // body is saved before commit; either both survive or neither does.
        this.options.runKernel.recordImageFixtureResult(principal, jobId, result, body);
        this.assertMetadata(tenantId, projectId);
        this.options.runKernel.getBatch(principal, execution.batchId);
      });
    } catch (error) {
      // Never infer free billing from exception text, HTTP status, bad image or
      // a save failure. Do not store arbitrary transport error strings/secrets.
      const result = ImageFixtureResultSchema.parse({ schemaVersion: 1, mode: "local-fixture", id: `fixture-result-${randomUUID()}`, attemptId: attempt.id, kind: "interrupted",
        receivedAt: this.at(), failureCode: failure, outcome: unknownImageResponse(request, execution.requestFingerprint, failure).outcome });
      try {
        this.options.stateStore.transaction(() => { this.options.runKernel.recordImageFixtureResult(principal, request.jobId, result); this.assertMetadata(request.tenantId, request.projectId); });
      } catch (saveError) {
        if (saveError instanceof RunKernelError) throw saveError;
        throw new RunKernelError(503, saveError instanceof SqliteStateStoreError ? saveError.code : "run_state_unavailable", "本地响应证据未能保存，原派发尝试保留，不会重发");
      }
      if (failure === "fixture-response-save-failed") {
        if (error instanceof RunKernelError) throw error;
        throw new RunKernelError(503, "run_state_unavailable", "本地响应保存失败，已保留未知计费证据");
      }
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  private assertMetadata(tenantId: string, projectId: string): void {
    const snapshot = this.options.stateStore.load();
    if (imageTaskMetadataBytes(snapshot, tenantId, projectId) + this.options.stateStore.imageMetadataBytes(tenantId, projectId) > this.metadataQuota) throw new RunKernelError(413, "image_metadata_quota", "本地响应元数据容量不足");
  }
  private at(): string { return new Date((this.options.clock ?? Date.now)()).toISOString(); }
}
