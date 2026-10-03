import { ImageConfirmationRecoverySchema } from "@canvas/contracts";

export const confirmationRecoveryKey = (projectId: string) => `ai-commerce-canvas.image-confirmation.${projectId}`;
export function readConfirmationRecovery(raw: string | null, projectId: string) {
  if (raw === null) return null;
  try {
    if (new TextEncoder().encode(raw).length > 16 * 1024) throw new Error();
    const pointer = ImageConfirmationRecoverySchema.parse(JSON.parse(raw));
    if (pointer.projectId !== projectId) throw new Error();
    return pointer;
  } catch { throw new Error("确认恢复指针损坏或跨项目；未恢复、未提交。请核对历史或明确开始新动作。"); }
}
