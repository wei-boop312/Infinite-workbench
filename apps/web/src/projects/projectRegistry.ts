const STORAGE_KEY = "ai-commerce-canvas.imported-projects";

export type ImportedProject = {
  documentId: string;
  projectId: string;
  label: string;
  importedAt: string;
};

function isImportedProject(value: unknown): value is ImportedProject {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ImportedProject>;
  return typeof candidate.documentId === "string" && candidate.documentId.length > 0
    && typeof candidate.projectId === "string" && candidate.projectId.length > 0
    && typeof candidate.label === "string" && candidate.label.length > 0
    && typeof candidate.importedAt === "string" && !Number.isNaN(Date.parse(candidate.importedAt));
}

export function loadImportedProjects(): ImportedProject[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isImportedProject) : [];
  } catch {
    return [];
  }
}

export function registerImportedProject(project: ImportedProject): ImportedProject[] {
  const projects = loadImportedProjects().filter((entry) => entry.documentId !== project.documentId);
  const next = [...projects, project];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
