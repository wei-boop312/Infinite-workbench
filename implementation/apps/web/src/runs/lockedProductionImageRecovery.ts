import { LockedProductionImageRecoverySchema, LockedProductionImageUiScopeSchema, type LockedProductionImageRecovery, type LockedProductionImageUiScope } from "@canvas/contracts";

export const lockedProductionRecoveryKey = (scope: LockedProductionImageUiScope, projectId: string) =>
  `ai-commerce-canvas.locked-production-preparation.${encodeURIComponent(scope.tenantId)}.${scope.mode}.${encodeURIComponent(projectId)}`;
export function readLockedProductionRecovery(raw: string | null, scope: LockedProductionImageUiScope, projectId: string): LockedProductionImageRecovery | null {
  LockedProductionImageUiScopeSchema.parse(scope);
  if (raw === null) return null;
  try {
    if (new TextEncoder().encode(raw).length > 16 * 1024) throw new Error();
    const pointer = LockedProductionImageRecoverySchema.parse(JSON.parse(raw));
    if (pointer.tenantId !== scope.tenantId || pointer.mode !== scope.mode || pointer.projectId !== projectId) throw new Error();
    return pointer;
  } catch { throw new Error("保护只读指针损坏或跨范围；保留原编号及可能已有的预留，仅只读核对，不自动重发。"); }
}
export function saveLockedProductionRecovery(storage: Pick<Storage, "setItem" | "getItem">, scope: LockedProductionImageUiScope, value: LockedProductionImageRecovery): void {
  const raw = JSON.stringify(LockedProductionImageRecoverySchema.parse(value));
  readLockedProductionRecovery(raw, scope, value.projectId);
  const key = lockedProductionRecoveryKey(scope, value.projectId);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("保护只读指针未成功保存，本次不继续POST；原历史及可能已有预留保留。");
}
