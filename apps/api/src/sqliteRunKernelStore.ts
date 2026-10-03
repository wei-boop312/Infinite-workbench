import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalRunCatalogSchema, RunKernelSnapshotSchema, type RunKernelSnapshot } from "@canvas/contracts";
import type { RunKernelStateStore } from "./runKernelStore";

type LocalCatalog = ReturnType<typeof LocalRunCatalogSchema.parse>;
type StateKind = "runs" | "catalog";

export class SqliteStateStoreError extends Error {
  constructor(public readonly code: "run_state_busy" | "run_state_unavailable", cause: unknown) {
    super(code, { cause });
  }
}

function databaseError(error: unknown): SqliteStateStoreError {
  if (error instanceof SqliteStateStoreError) return error;
  const code = error && typeof error === "object" && "errcode" in error ? Number(error.errcode) & 0xff : 0;
  return new SqliteStateStoreError(code === 5 || code === 6 ? "run_state_busy" : "run_state_unavailable", error);
}

// Local-host adapter. Full aggregates are serialized under one database writer lock;
// this is intentionally not the normalized PostgreSQL production implementation.
export class SqliteRunKernelStateStore implements RunKernelStateStore {
  private readonly database: DatabaseSync;
  private depth = 0;
  private closed = false;

  constructor(filePath: string, options: { busyTimeoutMs?: number } = {}) {
    if (!filePath.trim()) throw new Error("数据库路径不能为空");
    const timeout = options.busyTimeoutMs ?? 1_000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 5_000) throw new Error("数据库等待时间无效");
    if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(filePath, { timeout });
    try {
      // All connections use the same durability policy, and never disable journaling.
      this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
      this.transaction(() => {
        const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version);
        if (version !== 0 && version !== 1) throw new Error("不支持此数据库版本，禁止覆盖");
        this.database.exec(`CREATE TABLE IF NOT EXISTS kernel_state (
          kind TEXT PRIMARY KEY CHECK (kind IN ('runs', 'catalog')),
          revision INTEGER NOT NULL CHECK (revision > 0),
          payload TEXT NOT NULL,
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS state_presence (kind TEXT PRIMARY KEY) STRICT;
        CREATE TABLE IF NOT EXISTS kernel_configuration (id INTEGER PRIMARY KEY CHECK (id = 1), sha256 TEXT NOT NULL) STRICT;
        PRAGMA user_version = 1`);
      });
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw databaseError(error);
    }
  }

  transaction<T>(action: () => T): T {
    const nested = this.depth > 0;
    const savepoint = `kernel_${this.depth}`;
    try { this.database.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE"); }
    catch (error) { throw databaseError(error); }
    this.depth += 1;
    try {
      const result = action();
      if (result && typeof result === "object" && "then" in result) throw new Error("数据库事务不能包含异步或外部请求");
      this.database.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK"); }
      catch { /* SQLite can already have rolled back after an I/O error. */ }
      if (error && typeof error === "object" && "errcode" in error) throw databaseError(error);
      throw error;
    } finally { this.depth -= 1; }
  }

  load(): RunKernelSnapshot | null {
    try {
      const value = this.read("runs");
      return value === null ? null : RunKernelSnapshotSchema.parse(value);
    } catch (error) { throw databaseError(error); }
  }

  save(snapshot: RunKernelSnapshot): void { this.write("runs", RunKernelSnapshotSchema.parse(snapshot)); }

  loadCatalog(): LocalCatalog | null {
    try {
      const value = this.read("catalog");
      if (value === null) return null;
      const catalog = LocalRunCatalogSchema.parse(value);
      if (new Set(catalog.projects.map((project) => project.projectId)).size !== catalog.projects.length
        || catalog.projects.some((project) => new Set(project.assets.map((asset) => asset.id)).size !== project.assets.length
          || new Set(project.constraints.map((constraint) => constraint.id)).size !== project.constraints.length
          || project.assets.some((asset) => asset.projectId !== project.projectId)
          || project.constraints.some((constraint) => constraint.projectId !== project.projectId))) {
        throw new Error("数据库项目目录编号或归属无效");
      }
      return catalog;
    } catch (error) { throw databaseError(error); }
  }

  saveCatalog(catalog: LocalCatalog): void { this.write("catalog", LocalRunCatalogSchema.parse(catalog)); }

  assertConfiguration(configuration: unknown): void {
    if (this.depth === 0) throw new Error("必须在事务中核对执行配置");
    const sha256 = createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
    const saved = this.database.prepare("SELECT sha256 FROM kernel_configuration WHERE id = 1").get();
    if (saved && saved.sha256 !== sha256) throw new Error("共享任务数据库的执行或定价配置不一致");
    if (!saved) this.database.prepare("INSERT INTO kernel_configuration(id, sha256) VALUES (1, ?)").run(sha256);
  }

  revision(kind: StateKind = "runs"): number {
    return Number(this.database.prepare("SELECT revision FROM kernel_state WHERE kind = ?").get(kind)?.revision ?? 0);
  }

  close(): void {
    if (this.closed) return;
    if (this.depth !== 0) throw new Error("不能在事务中关闭数据库");
    this.database.close();
    this.closed = true;
  }

  private read(kind: StateKind): unknown | null {
    const row = this.database.prepare("SELECT payload, sha256 FROM kernel_state WHERE kind = ?").get(kind);
    if (!row) {
      if (this.database.prepare("SELECT kind FROM state_presence WHERE kind = ?").get(kind)) {
        throw new SqliteStateStoreError("run_state_unavailable", new Error("数据库已初始化的状态行丢失"));
      }
      return null;
    }
    if (typeof row.payload !== "string" || createHash("sha256").update(row.payload).digest("hex") !== row.sha256) {
      throw new SqliteStateStoreError("run_state_unavailable", new Error("数据库状态摘要不一致"));
    }
    return JSON.parse(row.payload);
  }

  private write(kind: StateKind, value: unknown): void {
    if (this.depth === 0) throw new Error("必须在数据库事务中保存任务状态");
    const payload = JSON.stringify(value);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    this.database.prepare(`INSERT INTO kernel_state(kind, revision, payload, sha256) VALUES (?, 1, ?, ?)
      ON CONFLICT(kind) DO UPDATE SET revision = revision + 1, payload = excluded.payload, sha256 = excluded.sha256`)
      .run(kind, payload, sha256);
    this.database.prepare("INSERT INTO state_presence(kind) VALUES (?) ON CONFLICT DO NOTHING").run(kind);
  }
}
