import type { ConstraintSnapshot } from "@canvas/contracts";

const KEY_PREFIX = "ai-commerce-canvas.constraints.";

export type ConstraintDraft = {
  productLocked: boolean;
  brandLocked: boolean;
  editableRegions: Array<{ id: string; description: string; maskAssetId?: string }>;
  brandTone: string;
  forbiddenTerms: string;
  outputWidth: number;
  outputHeight: number;
  outputFormat: "png" | "jpeg" | "webp" | "mp4";
};

export const defaultConstraintDraft: ConstraintDraft = {
  productLocked: true,
  brandLocked: true,
  editableRegions: [{ id: "region-background", description: "仅允许修改背景" }],
  brandTone: "克制、清晰、突出商品",
  forbiddenTerms: "最低价、绝对化承诺",
  outputWidth: 1200,
  outputHeight: 1200,
  outputFormat: "png",
};

function createId(): string {
  return `constraint-${crypto.randomUUID()}`;
}

export function draftFromSnapshot(snapshot: ConstraintSnapshot | null): ConstraintDraft {
  if (!snapshot) return { ...defaultConstraintDraft, editableRegions: defaultConstraintDraft.editableRegions.map((region) => ({ ...region })) };
  return {
    productLocked: snapshot.lockedPaths.includes("product.pixels"),
    brandLocked: snapshot.lockedPaths.includes("brand.identity"),
    editableRegions: snapshot.editableRegions.map((region) => ({ ...region })),
    brandTone: snapshot.brandRules.tone ?? "",
    forbiddenTerms: snapshot.brandRules.forbiddenTerms ?? "",
    outputWidth: snapshot.outputSpec.width,
    outputHeight: snapshot.outputSpec.height,
    outputFormat: snapshot.outputSpec.format,
  };
}

export function buildConstraintSnapshot(
  projectId: string,
  draft: ConstraintDraft,
  id = createId(),
  createdAt = new Date().toISOString(),
): ConstraintSnapshot {
  const editableRegions = draft.editableRegions
    .map((region) => ({ ...region, description: region.description.trim() }))
    .filter((region) => region.description.length > 0);
  if (!editableRegions.length) throw new Error("至少需要一个可编辑区域");
  if (!Number.isInteger(draft.outputWidth) || !Number.isInteger(draft.outputHeight)
    || draft.outputWidth < 64 || draft.outputHeight < 64
    || draft.outputWidth > 8192 || draft.outputHeight > 8192) {
    throw new Error("输出尺寸必须是 64–8192 之间的整数");
  }
  return {
    id,
    projectId,
    lockedPaths: [
      ...(draft.productLocked ? ["product.pixels"] : []),
      ...(draft.brandLocked ? ["brand.identity"] : []),
    ],
    editableRegions,
    brandRules: {
      tone: draft.brandTone.trim(),
      forbiddenTerms: draft.forbiddenTerms.trim(),
    },
    outputSpec: {
      width: draft.outputWidth,
      height: draft.outputHeight,
      format: draft.outputFormat,
    },
    createdAt,
  };
}

export class LocalConstraintRepository {
  list(projectId: string): ConstraintSnapshot[] {
    const raw = localStorage.getItem(`${KEY_PREFIX}${projectId}`);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((snapshot): snapshot is ConstraintSnapshot => {
        if (!snapshot || typeof snapshot !== "object") return false;
        const candidate = snapshot as Partial<ConstraintSnapshot>;
        return typeof candidate.id === "string"
          && candidate.projectId === projectId
          && Array.isArray(candidate.lockedPaths)
          && Array.isArray(candidate.editableRegions)
          && candidate.brandRules !== null
          && typeof candidate.brandRules === "object"
          && candidate.outputSpec !== null
          && typeof candidate.outputSpec === "object";
      });
    } catch {
      return [];
    }
  }

  get(projectId: string, snapshotId: string): ConstraintSnapshot | null {
    return this.list(projectId).find((snapshot) => snapshot.id === snapshotId) ?? null;
  }

  save(projectId: string, draft: ConstraintDraft): ConstraintSnapshot {
    const snapshot = buildConstraintSnapshot(projectId, draft);
    localStorage.setItem(`${KEY_PREFIX}${projectId}`, JSON.stringify([...this.list(projectId), snapshot]));
    return snapshot;
  }

  replace(projectId: string, snapshots: ConstraintSnapshot[]): void {
    if (snapshots.some((snapshot) => snapshot.projectId !== projectId)) throw new Error("约束快照不属于导入项目");
    localStorage.setItem(`${KEY_PREFIX}${projectId}`, JSON.stringify(snapshots));
  }

  remove(projectId: string): void {
    localStorage.removeItem(`${KEY_PREFIX}${projectId}`);
  }
}

export const constraintRepository = new LocalConstraintRepository();
