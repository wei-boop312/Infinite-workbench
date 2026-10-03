import type { ObjectStorageAuthorizer } from "./objectStorageGateway";
import type { ImageProviderAuthorizer } from "./imageProviders";
import { imageSnapshotFingerprint } from "./imageProviderContract";
import { validateLocalImageAssetPolicy } from "./imageAssetPolicy";
import { RunKernelError, type RunKernelOptions } from "./runKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";

// A trusted synchronous validator, not an authorization flag supplied by clients.
// Uses the same transaction store as the task kernel; does not resolve secrets.
export function createImageTaskValidator(options: {
  tenantId: string; stateStore: SqliteRunKernelStateStore;
  providerAuthorizer: ImageProviderAuthorizer; assetAuthorizer: ObjectStorageAuthorizer;
  maxMetadataBytes?: number;
}): NonNullable<RunKernelOptions["validateImageTask"]> {
  const quota = options.maxMetadataBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(quota) || quota < 0 || quota > 16 * 1024 * 1024) throw new Error("图片任务元数据额度无效");
  return (principal, execution, intent) => options.stateStore.transaction(() => {
    const { request, preparation } = execution;
    if (principal.tenantId !== options.tenantId || request.tenantId !== principal.tenantId
      || !options.providerAuthorizer.allows(principal, request.projectId, "provider:read")
      || (request.operation === "edit" && !options.assetAuthorizer.allows(principal, request.projectId, "asset:read"))) {
      throw new RunKernelError(403, "image_task_permission_denied", "图片租约所需权限不足");
    }
    const saved = options.stateStore.loadImagePreparation(principal.tenantId, request.projectId, preparation.id);
    if (!saved || imageSnapshotFingerprint(saved) !== imageSnapshotFingerprint(preparation)) throw new RunKernelError(409, "image_task_preparation_changed", "图片准备单证据缺失或改变");
    const current = options.stateStore.loadImageProviderHistory(principal.tenantId, request.projectId)
      .filter((item) => item.connection.id === request.connectionId).at(-1)?.connection;
    if (!current || imageSnapshotFingerprint(current) !== imageSnapshotFingerprint(preparation.connection)) throw new RunKernelError(409, "image_connection_changed", "图片连接需要重新确认");
    validateLocalImageAssetPolicy(options.stateStore, request);
    if (intent) {
      const snapshot = options.stateStore.load();
      const size = Buffer.byteLength(JSON.stringify(intent), "utf8");
      const existing = (snapshot?.batches ?? []).filter((item) => item.aggregate.batch.tenantId === principal.tenantId && item.aggregate.batch.projectId === request.projectId)
        .reduce((total, item) => total + (item.imageExecution ? Buffer.byteLength(JSON.stringify(item.imageExecution), "utf8") : 0)
          + (item.imageDispatchIntent ? Buffer.byteLength(JSON.stringify(item.imageDispatchIntent), "utf8") : 0), 0);
      if (size > 512 * 1024 || existing + size + options.stateStore.imageMetadataBytes(principal.tenantId, request.projectId) > quota) {
        throw new RunKernelError(413, "image_metadata_quota", "图片任务元数据额度不足，未留下派发意图");
      }
    }
    return undefined;
  });
}
