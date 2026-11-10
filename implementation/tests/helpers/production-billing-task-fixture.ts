import { afterEach, vi } from "vitest";
import { ownedProductionBillingTask } from "./production-billing-task-core";
const owned: Awaited<ReturnType<typeof ownedProductionBillingTask>>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const t of owned.splice(0).reverse()) t.f.cleanup(); });
export async function productionBillingTaskFixture(options: Parameters<typeof ownedProductionBillingTask>[0] = {}) {
  const t = await ownedProductionBillingTask(options, fn => vi.fn(fn)); owned.push(t); return t;
}
