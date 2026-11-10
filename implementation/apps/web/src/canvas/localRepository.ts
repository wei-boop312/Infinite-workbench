import type { CanvasDocument } from "@canvas/contracts";
import { migrateCanvasDocumentLight } from "@canvas/canvas-schema/light";

const KEY_PREFIX = "ai-commerce-canvas.document.";

export class RevisionConflictError extends Error {
  constructor(public readonly remote: CanvasDocument) {
    super(`保存冲突：远端修订为 ${remote.revision}`);
    this.name = "RevisionConflictError";
  }
}

export class LocalCanvasRepository {
  constructor(readonly documentId: string) {}

  private get key(): string {
    return `${KEY_PREFIX}${this.documentId}`;
  }

  load(): CanvasDocument | null {
    const raw = localStorage.getItem(this.key);
    return raw ? migrateCanvasDocumentLight(JSON.parse(raw)) : null;
  }

  save(document: CanvasDocument, expectedRevision: number): CanvasDocument {
    const remote = this.load();
    const remoteRevision = remote?.revision ?? 0;
    if (remoteRevision !== expectedRevision) {
      if (!remote) throw new Error("画布修订已不存在");
      throw new RevisionConflictError(remote);
    }

    const saved = migrateCanvasDocumentLight({
      ...document,
      id: this.documentId,
      revision: expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    });
    localStorage.setItem(this.key, JSON.stringify(saved));
    return saved;
  }

  saveRecoveryCopy(document: CanvasDocument): CanvasDocument {
    const recoveredId = `${document.id}-recovery-${Date.now()}`;
    const recovered = migrateCanvasDocumentLight({
      ...document,
      id: recoveredId,
      revision: 1,
      updatedAt: new Date().toISOString(),
    });
    localStorage.setItem(`${KEY_PREFIX}${recoveredId}`, JSON.stringify(recovered));
    return recovered;
  }

  remove(): void {
    localStorage.removeItem(this.key);
  }

  subscribe(listener: (document: CanvasDocument) => void): () => void {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== this.key || !event.newValue) return;
      listener(migrateCanvasDocumentLight(JSON.parse(event.newValue)));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }
}
