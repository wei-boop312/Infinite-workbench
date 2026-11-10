import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { RunKernelSnapshotSchema, type RunKernelSnapshot } from "@canvas/contracts";

export interface RunKernelStateStore {
  load(): RunKernelSnapshot | null;
  save(snapshot: RunKernelSnapshot): void;
}

export class FileRunKernelStateStore implements RunKernelStateStore {
  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error("任务内核状态文件路径不能为空");
  }

  load(): RunKernelSnapshot | null {
    if (!existsSync(this.filePath)) return null;
    const source = readFileSync(this.filePath, "utf8");
    return RunKernelSnapshotSchema.parse(JSON.parse(source));
  }

  save(snapshot: RunKernelSnapshot): void {
    const parsed = RunKernelSnapshotSchema.parse(snapshot);
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = join(directory, `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, this.filePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}
