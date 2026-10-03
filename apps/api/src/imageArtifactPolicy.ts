import type { ConfirmedImageExecution, ImageFixtureResult } from "@canvas/contracts";
import type { ImageProviderAuthorizer } from "./imageProviders";
import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import { imageSnapshotFingerprint } from "./imageProviderContract";
import { validateLocalImageAssetPolicy } from "./imageAssetPolicy";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";
import { parseOpenAiImageResponse } from "./openaiImageProtocol";
import { parseCompatibleImageResponse } from "./compatibleImageProtocol";
import { parseGoogleImageResponse } from "./googleImageProtocol";
import { RunKernelError, type RunKernelOptions } from "./runKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";

export function parseStoredImageResponse(execution: ConfirmedImageExecution, response: { record: Extract<ImageFixtureResult, { kind: "returned" }>; body: Buffer }) {
  const { record, body } = response;
  const parse = execution.preparation.connection.protocol === "openai" ? parseOpenAiImageResponse : execution.preparation.connection.protocol === "openai-compatible" ? parseCompatibleImageResponse : parseGoogleImageResponse;
  const parsed = parse(execution.request, execution.requestFingerprint, { status: record.status, contentType: record.contentType, requestId: record.requestId, body });
  if (imageSnapshotFingerprint(parsed.outcome) !== imageSnapshotFingerprint(record.outcome)) throw new RunKernelError(409, "image_output_response_changed", "原始响应解析与持久化快照不一致");
  return parsed;
}

// Trusted server policy, no authorization supplied by the response caller.
// Read/write permissions and actual inputs are current; connection/quote are
// the immutable values valid at dispatch, not a new send authorization.
export function createImageArtifactValidator(options: {
  tenantId: string; stateStore: SqliteRunKernelStateStore; providerAuthorizer: ImageProviderAuthorizer;
  assetAuthorizer: ObjectStorageAuthorizer; maxMetadataBytes?: number;
}): NonNullable<RunKernelOptions["validateImageArtifact"]> {
  const quota = options.maxMetadataBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(quota) || quota < 0 || quota > 16 * 1024 * 1024) throw new Error("产物元数据容量配置无效");
  return (principal, execution, result, record, extraBytes = 0) => options.stateStore.transaction(() => {
    const { request, preparation } = execution;
    if (principal.tenantId !== options.tenantId || request.tenantId !== principal.tenantId
      || !options.providerAuthorizer.allows(principal, request.projectId, "provider:read")
      || !options.assetAuthorizer.allows(principal, request.projectId, "asset:write")
      || (request.operation === "edit" && !options.assetAuthorizer.allows(principal, request.projectId, "asset:read"))) throw new RunKernelError(403, "image_output_permission_denied", "产物所需当前权限不足");
    const saved = options.stateStore.loadImagePreparation(principal.tenantId, request.projectId, preparation.id);
    if (!saved || imageSnapshotFingerprint(saved) !== imageSnapshotFingerprint(preparation)) throw new RunKernelError(409, "image_output_confirmation_changed", "原始准备和完整确认不一致");
    const response = options.stateStore.loadImageFixtureResponse(principal.tenantId, request.projectId, request.jobId);
    if (!response || imageSnapshotFingerprint(response.record) !== imageSnapshotFingerprint(result)) throw new RunKernelError(409, "image_output_response_changed", "任务缺少匹配原始响应");
    validateLocalImageAssetPolicy(options.stateStore, request);
    if (record) {
      const parsed = parseStoredImageResponse(execution, response);
      if (!parsed.candidate || parsed.candidate.checksumSha256 !== record.image.checksumSha256
        || parsed.candidate.mimeType !== record.image.asset.mimeType || parsed.candidate.body.byteLength !== record.image.asset.byteSize
        || imageSnapshotFingerprint(parsed.outcome) !== imageSnapshotFingerprint(record.providerOutcome)) throw new RunKernelError(409, "image_output_candidate_changed", "产物不属于实际原始响应");
    }
    const recordBytes = record ? Buffer.byteLength(JSON.stringify(record)) : 0;
    if (!Number.isSafeInteger(extraBytes) || extraBytes < 0 || extraBytes > 512 * 1024 || recordBytes > 512 * 1024
      || options.stateStore.imageMetadataBytes(principal.tenantId, request.projectId) + imageTaskMetadataBytes(options.stateStore.load(), principal.tenantId, request.projectId) + extraBytes > quota) {
      throw new RunKernelError(413, "image_output_metadata_quota", "产物元数据容量不足，不删除历史或释放未知预留");
    }
    return undefined;
  });
}
