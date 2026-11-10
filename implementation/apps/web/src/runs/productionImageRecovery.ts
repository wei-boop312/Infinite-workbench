import { ProductionImageRecoverySchema, ProductionImageUiScopeSchema, type ProductionImageRecovery, type ProductionImageUiScope } from "@canvas/contracts";

export const productionRecoveryKey = (scope: ProductionImageUiScope, projectId: string) =>
  `ai-commerce-canvas.production-preparation.${encodeURIComponent(scope.tenantId)}.${scope.mode}.${encodeURIComponent(projectId)}`;
export function readProductionRecovery(raw: string | null, scope: ProductionImageUiScope, projectId: string): ProductionImageRecovery | null {
  ProductionImageUiScopeSchema.parse(scope);
  if (raw === null) return null;
  try {
    if (new TextEncoder().encode(raw).length > 16 * 1024) throw new Error();
    const pointer = ProductionImageRecoverySchema.parse(JSON.parse(raw));
    if (pointer.tenantId !== scope.tenantId || pointer.mode !== scope.mode || pointer.projectId !== projectId) throw new Error();
    return pointer;
  } catch { throw new Error("生产只读指针损坏或跨范围；未提交。请核对历史或明确开始新动作。"); }
}
export function saveProductionRecovery(storage: Pick<Storage, "setItem" | "getItem">, scope: ProductionImageUiScope, value: ProductionImageRecovery): void {
  const raw = JSON.stringify(ProductionImageRecoverySchema.parse(value));
  readProductionRecovery(raw, scope, value.projectId);
  const key = productionRecoveryKey(scope, value.projectId);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("生产只读指针未成功保存，未提交。");
}
