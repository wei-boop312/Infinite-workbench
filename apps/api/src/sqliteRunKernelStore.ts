import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GeneratedImageRecordSchema, ImageFixtureResultSchema, ImagePreparationRecordSchema, ProductionImagePreparationRecordSchema, ProductionImageRawResponseSchema, ImageProviderRevisionSchema, LocalRunCatalogSchema, RunKernelSnapshotSchema, VerifiedImageSchema, type ProductionImageRawResponse, type ProductionImagePreparationRecord, type ImageFixtureResult, type GeneratedImageRecord, type ImagePreparationRecord, type ImageProviderRevision, type RunKernelSnapshot, type VerifiedImage } from "@canvas/contracts";
import type { RunKernelStateStore } from "./runKernelStore";
import { ProductionImageArtifactSchema, type ProductionImageArtifact } from "@canvas/contracts";
import { LockedProductionImagePreparationRecordSchema, type LockedProductionImagePreparationRecord } from "@canvas/contracts";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";
import { LockedProductionImageRawResponseSchema, type LockedProductionImageRawResponse } from "@canvas/contracts";

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
  private readonly productionResponseStorageEnabled: boolean;
  private readonly productionArtifactStorageEnabled: boolean;

  constructor(filePath: string, options: { busyTimeoutMs?: number; productionResponseStorageEnabled?: true; productionArtifactStorageEnabled?: true } = {}) {
    this.productionResponseStorageEnabled = options.productionResponseStorageEnabled === true;
    this.productionArtifactStorageEnabled = options.productionArtifactStorageEnabled === true;
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
        if (![0, 1, 2, 3, 4, 5, 6, 7, 8].includes(version)) throw new Error("不支持此数据库版本，禁止覆盖");
        if (version >= 6 && ["production_image_preparations", "production_image_preparation_presence"].some((name) => !this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))) throw new Error("生产准备表丢失，禁止重新创建");
        if (version >= 7 && ["production_image_responses", "production_image_response_presence"].some((name) => !this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))) throw new Error("生产原包表丢失，禁止重新创建");
        if (version === 8 && ["production_image_artifacts", "production_image_artifact_presence"].some((name) => !this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))) throw new Error("生产产物表丢失，禁止重新创建");
        this.database.exec(`CREATE TABLE IF NOT EXISTS kernel_state (
          kind TEXT PRIMARY KEY CHECK (kind IN ('runs', 'catalog')),
          revision INTEGER NOT NULL CHECK (revision > 0),
          payload TEXT NOT NULL,
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS state_presence (kind TEXT PRIMARY KEY) STRICT;
        CREATE TABLE IF NOT EXISTS kernel_configuration (id INTEGER PRIMARY KEY CHECK (id = 1), sha256 TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS verified_images (
          tenant_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          record TEXT NOT NULL,
          record_sha256 TEXT NOT NULL,
          body BLOB NOT NULL,
          PRIMARY KEY (tenant_id, project_id, asset_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS generated_images (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
          asset_id TEXT NOT NULL, record TEXT NOT NULL, record_sha256 TEXT NOT NULL,
          PRIMARY KEY (tenant_id, project_id, job_id),
          UNIQUE (tenant_id, project_id, asset_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS generated_image_presence (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, project_id, job_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS image_provider_revisions (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, connection_id TEXT NOT NULL,
          revision INTEGER NOT NULL, record TEXT NOT NULL, record_sha256 TEXT NOT NULL,
          PRIMARY KEY (tenant_id, project_id, connection_id, revision)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS image_provider_heads (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, connection_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, project_id, connection_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS image_preparations (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, action_key TEXT NOT NULL,
          record TEXT NOT NULL, record_sha256 TEXT NOT NULL,
          PRIMARY KEY (tenant_id, project_id, id), UNIQUE (tenant_id, project_id, action_key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS image_preparation_presence (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, action_key TEXT NOT NULL,
          PRIMARY KEY (tenant_id, project_id, id), UNIQUE (tenant_id, project_id, action_key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS image_fixture_responses (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
          record TEXT NOT NULL, record_sha256 TEXT NOT NULL, body BLOB NOT NULL,
          PRIMARY KEY (tenant_id, project_id, job_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS image_fixture_response_presence (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, project_id, job_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS production_image_preparations (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('production', 'production-contract-fixture')),
          id TEXT NOT NULL, action_key TEXT NOT NULL, record TEXT NOT NULL, record_sha256 TEXT NOT NULL,
          PRIMARY KEY (tenant_id, project_id, mode, id), UNIQUE (tenant_id, project_id, mode, action_key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS production_image_preparation_presence (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('production', 'production-contract-fixture')),
          id TEXT NOT NULL, action_key TEXT NOT NULL,
          PRIMARY KEY (tenant_id, project_id, mode, id), UNIQUE (tenant_id, project_id, mode, action_key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS production_image_responses (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('production', 'production-contract-fixture')),
          job_id TEXT NOT NULL, response_id TEXT NOT NULL, record TEXT NOT NULL, record_sha256 TEXT NOT NULL, body BLOB NOT NULL,
          PRIMARY KEY (tenant_id, project_id, mode, job_id), UNIQUE (tenant_id, project_id, mode, response_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS production_image_response_presence (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('production', 'production-contract-fixture')),
          job_id TEXT NOT NULL, response_id TEXT NOT NULL, record_sha256 TEXT NOT NULL,
          PRIMARY KEY (tenant_id, project_id, mode, job_id), UNIQUE (tenant_id, project_id, mode, response_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS production_image_artifacts (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('production', 'production-contract-fixture')),
          job_id TEXT NOT NULL, asset_id TEXT NOT NULL, record TEXT NOT NULL, record_sha256 TEXT NOT NULL,
          PRIMARY KEY (tenant_id, project_id, mode, job_id), UNIQUE (tenant_id, project_id, asset_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS production_image_artifact_presence (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('production', 'production-contract-fixture')),
          job_id TEXT NOT NULL, asset_id TEXT NOT NULL, record_sha256 TEXT NOT NULL,
          PRIMARY KEY (tenant_id, project_id, mode, job_id), UNIQUE (tenant_id, project_id, asset_id)
        ) STRICT;
        PRAGMA user_version = 8`);
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

  loadVerifiedImage(tenantId: string, projectId: string, assetId: string): VerifiedImage | null {
    const stored = this.readVerifiedImage(tenantId, projectId, assetId);
    try { return stored?.record ?? null; } finally { stored?.body.fill(0); }
  }

  loadVerifiedImageBytes(tenantId: string, projectId: string, assetId: string): { receipt: VerifiedImage; body: Buffer } | null {
    const stored = this.readVerifiedImage(tenantId, projectId, assetId);
    return stored ? { receipt: stored.record, body: stored.body } : null;
  }

  private readVerifiedImage(tenantId: string, projectId: string, assetId: string): { record: VerifiedImage; body: Buffer } | null {
    try {
      const row = this.database.prepare("SELECT record, record_sha256, body FROM verified_images WHERE tenant_id = ? AND project_id = ? AND asset_id = ?")
        .get(tenantId, projectId, assetId);
      if (!row) return null;
      if (typeof row.record !== "string" || createHash("sha256").update(row.record).digest("hex") !== row.record_sha256 || !(row.body instanceof Uint8Array)) {
        throw new Error("已验证图片记录损坏");
      }
      const record = VerifiedImageSchema.parse(JSON.parse(row.record));
      if (record.tenantId !== tenantId || record.asset.projectId !== projectId || record.asset.id !== assetId
        || record.asset.kind !== "image" || row.body.byteLength !== record.asset.byteSize
        || createHash("sha256").update(row.body).digest("hex") !== record.checksumSha256
        || record.asset.contentFingerprint !== `sha256:${record.checksumSha256}`) throw new Error("已验证图片归属或内容损坏");
      return { record, body: Buffer.from(row.body) };
    } catch (error) { throw databaseError(error); }
  }

  saveVerifiedImage(incoming: VerifiedImage, body: Buffer): void {
    if (this.depth === 0) throw new Error("必须在事务中保存图片验证结果");
    const record = VerifiedImageSchema.parse(incoming);
    if (body.byteLength !== record.asset.byteSize || createHash("sha256").update(body).digest("hex") !== record.checksumSha256) throw new Error("图片提交内容不一致");
    const payload = JSON.stringify(record);
    // Immutable asset versions. An existing identifier can only be replayed, never overwritten.
    this.database.prepare("INSERT INTO verified_images(tenant_id, project_id, asset_id, record, record_sha256, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.tenantId, record.asset.projectId, record.asset.id, payload, createHash("sha256").update(payload).digest("hex"), body);
  }

  verifiedImageBytes(tenantId: string, projectId: string): number {
    return Number(this.database.prepare("SELECT COALESCE(SUM(length(body)), 0) AS bytes FROM verified_images WHERE tenant_id = ? AND project_id = ?")
      .get(tenantId, projectId)?.bytes ?? 0);
  }

  loadGeneratedImage(tenantId: string, projectId: string, jobId: string): GeneratedImageRecord | null {
    try {
      const marker = this.database.prepare("SELECT job_id FROM generated_image_presence WHERE tenant_id = ? AND project_id = ? AND job_id = ?").get(tenantId, projectId, jobId);
      const row = this.database.prepare("SELECT asset_id, record, record_sha256 FROM generated_images WHERE tenant_id = ? AND project_id = ? AND job_id = ?").get(tenantId, projectId, jobId);
      if (!row && !marker) return null;
      if (!row || !marker || typeof row.record !== "string" || createHash("sha256").update(row.record).digest("hex") !== row.record_sha256) throw new Error("生成图片谱系已丢失或损坏");
      const record = GeneratedImageRecordSchema.parse(this.readImageMetadata(row));
      const image = this.loadVerifiedImage(tenantId, projectId, record.image.asset.id);
      if (record.request.tenantId !== tenantId || record.request.projectId !== projectId || record.request.jobId !== jobId || record.image.asset.id !== row.asset_id
        || !image || JSON.stringify(image) !== JSON.stringify(record.image)) throw new Error("生成图片正文或证明与谱系不一致");
      return record;
    } catch (error) { throw databaseError(error); }
  }

  saveGeneratedImage(incoming: GeneratedImageRecord, body: Buffer): void {
    if (this.depth === 0) throw new Error("必须在事务中保存生成图片");
    const record = GeneratedImageRecordSchema.parse(incoming);
    // Atomic only within caller transaction; identifier replay is decided by the
    // trusted output service and never implemented as INSERT OR REPLACE.
    this.saveVerifiedImage(record.image, body);
    const payload = this.imageMetadataPayload(record);
    const { tenantId, projectId, jobId } = record.request;
    this.database.prepare("INSERT INTO generated_images(tenant_id, project_id, job_id, asset_id, record, record_sha256) VALUES (?, ?, ?, ?, ?, ?)")
      .run(tenantId, projectId, jobId, record.image.asset.id, payload, createHash("sha256").update(payload).digest("hex"));
    this.database.prepare("INSERT INTO generated_image_presence(tenant_id, project_id, job_id) VALUES (?, ?, ?)").run(tenantId, projectId, jobId);
  }

  loadImageProviderHistory(tenantId: string, projectId: string): ImageProviderRevision[] {
    try {
      const heads = this.database.prepare("SELECT connection_id, revision FROM image_provider_heads WHERE tenant_id = ? AND project_id = ? LIMIT 65").all(tenantId, projectId);
      const rows = this.database.prepare("SELECT connection_id, revision, record, record_sha256 FROM image_provider_revisions WHERE tenant_id = ? AND project_id = ? ORDER BY connection_id, revision LIMIT 2049").all(tenantId, projectId);
      if (heads.length > 64 || rows.length > 2048) throw new Error("供应商目录超出本机界限");
      const latest = new Map<string, number>();
      const history = rows.map((row) => {
        const record = ImageProviderRevisionSchema.parse(this.readImageMetadata(row));
        const connection = record.connection;
        if (connection.tenantId !== tenantId || connection.projectId !== projectId || connection.id !== row.connection_id || connection.revision !== row.revision
          || connection.revision !== (latest.get(connection.id) ?? 0) + 1 || connection.revision > 32) throw new Error("供应商版本丢失或归属损坏");
        latest.set(connection.id, connection.revision);
        return record;
      });
      if (latest.size !== heads.length || heads.some((head) => typeof head.connection_id !== "string" || latest.get(head.connection_id) !== head.revision)) throw new Error("供应商当前版本与历史不一致");
      return history;
    } catch (error) { throw databaseError(error); }
  }

  saveImageProviderRevision(incoming: ImageProviderRevision): void {
    if (this.depth === 0) throw new Error("必须在事务中保存供应商版本");
    const record = ImageProviderRevisionSchema.parse(incoming);
    const connection = record.connection;
    const history = this.loadImageProviderHistory(connection.tenantId, connection.projectId).filter((item) => item.connection.id === connection.id);
    if (connection.revision !== history.length + 1 || connection.revision > 32) throw new Error("供应商版本不能覆盖或跳跃");
    const payload = this.imageMetadataPayload(record);
    this.database.prepare("INSERT INTO image_provider_revisions(tenant_id, project_id, connection_id, revision, record, record_sha256) VALUES (?, ?, ?, ?, ?, ?)")
      .run(connection.tenantId, connection.projectId, connection.id, connection.revision, payload, createHash("sha256").update(payload).digest("hex"));
    this.database.prepare("INSERT INTO image_provider_heads(tenant_id, project_id, connection_id, revision) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, project_id, connection_id) DO UPDATE SET revision = excluded.revision")
      .run(connection.tenantId, connection.projectId, connection.id, connection.revision);
  }

  loadImagePreparation(tenantId: string, projectId: string, id: string): ImagePreparationRecord | null { return this.readImagePreparation(tenantId, projectId, "id", id); }
  loadImagePreparationByAction(tenantId: string, projectId: string, key: string): ImagePreparationRecord | null { return this.readImagePreparation(tenantId, projectId, "action_key", key); }
  private readImagePreparation(tenantId: string, projectId: string, field: "id" | "action_key", value: string): ImagePreparationRecord | null {
    try {
      const row = this.database.prepare(`SELECT id, action_key, record, record_sha256 FROM image_preparations WHERE tenant_id = ? AND project_id = ? AND ${field} = ?`).get(tenantId, projectId, value);
      const marker = this.database.prepare(`SELECT id, action_key FROM image_preparation_presence WHERE tenant_id = ? AND project_id = ? AND ${field} = ?`).get(tenantId, projectId, value);
      if (!row && !marker) return null;
      if (!row || !marker || marker.id !== row.id || marker.action_key !== row.action_key) throw new Error("图片准备单已丢失或损坏");
      const record = ImagePreparationRecordSchema.parse(this.readImageMetadata(row));
      if (record.tenantId !== tenantId || record.projectId !== projectId || record.id !== row.id || record.selection.idempotencyKey !== row.action_key) throw new Error("图片准备单归属不一致");
      return record;
    } catch (error) { throw databaseError(error); }
  }

  saveImagePreparation(incoming: ImagePreparationRecord): void {
    if (this.depth === 0) throw new Error("必须在事务中保存图片准备单");
    const record = ImagePreparationRecordSchema.parse(incoming);
    const payload = this.imageMetadataPayload(record);
    this.database.prepare("INSERT INTO image_preparations(tenant_id, project_id, id, action_key, record, record_sha256) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.tenantId, record.projectId, record.id, record.selection.idempotencyKey, payload, createHash("sha256").update(payload).digest("hex"));
    this.database.prepare("INSERT INTO image_preparation_presence(tenant_id, project_id, id, action_key) VALUES (?, ?, ?, ?)")
      .run(record.tenantId, record.projectId, record.id, record.selection.idempotencyKey);
  }

  imagePreparationCount(tenantId: string, projectId: string): number {
    return Number(this.database.prepare("SELECT COUNT(*) AS count FROM image_preparation_presence WHERE tenant_id = ? AND project_id = ?").get(tenantId, projectId)?.count ?? 0);
  }
  loadProductionImagePreparation(tenantId: string, projectId: string, mode: ProductionImagePreparationRecord["mode"], id: string): ProductionImagePreparationRecord | null {
    return this.readProductionImagePreparation(tenantId, projectId, mode, "id", id);
  }
  loadProductionImagePreparationByAction(tenantId: string, projectId: string, mode: ProductionImagePreparationRecord["mode"], key: string): ProductionImagePreparationRecord | null {
    return this.readProductionImagePreparation(tenantId, projectId, mode, "action_key", key);
  }
  loadLockedProductionImagePreparation(tenant: string, project: string, mode: ProductionImagePreparationRecord["mode"], id: string): LockedProductionImagePreparationRecord | null {
    return this.readProductionImagePreparation(tenant, project, mode, "id", id, LockedProductionImagePreparationRecordSchema);
  }
  loadLockedProductionImagePreparationByAction(tenant: string, project: string, mode: ProductionImagePreparationRecord["mode"], key: string): LockedProductionImagePreparationRecord | null {
    return this.readProductionImagePreparation(tenant, project, mode, "action_key", key, LockedProductionImagePreparationRecordSchema);
  }
  private readProductionImagePreparation<T extends ProductionImagePreparationRecord | LockedProductionImagePreparationRecord = ProductionImagePreparationRecord>(tenantId: string, projectId: string, mode: ProductionImagePreparationRecord["mode"], field: "id" | "action_key", value: string, schema: { parse(input: unknown): T } = ProductionImagePreparationRecordSchema as unknown as { parse(input: unknown): T }): T | null {
    try {
      const args = [tenantId, projectId, mode, value];
      const row = this.database.prepare(`SELECT id, action_key, substr(record, 1, 524289) AS record, length(CAST(record AS BLOB)) AS bytes, record_sha256 FROM production_image_preparations WHERE tenant_id = ? AND project_id = ? AND mode = ? AND ${field} = ?`).get(...args);
      const marker = this.database.prepare(`SELECT id, action_key FROM production_image_preparation_presence WHERE tenant_id = ? AND project_id = ? AND mode = ? AND ${field} = ?`).get(...args);
      if (!row && !marker) return null;
      if (!row || !marker || marker.id !== row.id || marker.action_key !== row.action_key || typeof row.bytes !== "number" || row.bytes > 512 * 1024) throw new Error("生产准备证据丢失或超限");
      const r = schema.parse(this.readImageMetadata(row));
      if (r.tenantId !== tenantId || r.projectId !== projectId || r.mode !== mode || r.id !== row.id || r.selection.idempotencyKey !== row.action_key) throw new Error("生产准备归属不一致");
      return r;
    } catch (error) { throw databaseError(error); }
  }
  saveProductionImagePreparation(input: ProductionImagePreparationRecord): void {
    if (this.depth === 0) throw new Error("必须在事务中保存生产准备单");
    const r = ProductionImagePreparationRecordSchema.parse(input), payload = this.imageMetadataPayload(r);
    this.database.prepare("INSERT INTO production_image_preparations(tenant_id, project_id, mode, id, action_key, record, record_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(r.tenantId, r.projectId, r.mode, r.id, r.selection.idempotencyKey, payload, createHash("sha256").update(payload).digest("hex"));
    this.database.prepare("INSERT INTO production_image_preparation_presence(tenant_id, project_id, mode, id, action_key) VALUES (?, ?, ?, ?, ?)")
      .run(r.tenantId, r.projectId, r.mode, r.id, r.selection.idempotencyKey);
  }
  productionImagePreparationCount(tenantId: string, projectId: string): number {
    return Number(this.database.prepare("SELECT COUNT(*) AS count FROM production_image_preparation_presence WHERE tenant_id = ? AND project_id = ?").get(tenantId, projectId)?.count ?? 0);
  }
  // V2 JSON, original v8 tables/uniqueness/capacity, not a v1 upgrade.
  saveLockedProductionImagePreparation(input: LockedProductionImagePreparationRecord, afterWrite: () => void): void {
    if (this.depth === 0) throw new Error("必须在事务中保存锁区准备");
    const r = LockedProductionImagePreparationRecordSchema.parse(input), payload = this.imageMetadataPayload(r);
    this.database.prepare("INSERT INTO production_image_preparations(tenant_id, project_id, mode, id, action_key, record, record_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(r.tenantId, r.projectId, r.mode, r.id, r.selection.idempotencyKey, payload, createHash("sha256").update(payload).digest("hex"));
    afterWrite();
    this.database.prepare("INSERT INTO production_image_preparation_presence(tenant_id, project_id, mode, id, action_key) VALUES (?, ?, ?, ?, ?)")
      .run(r.tenantId, r.projectId, r.mode, r.id, r.selection.idempotencyKey);
    afterWrite();
  }
  imageMetadataBytes(tenantId: string, projectId: string): number {
    return Number(this.database.prepare("SELECT COALESCE((SELECT SUM(length(CAST(record AS BLOB))) FROM image_provider_revisions WHERE tenant_id = ? AND project_id = ?), 0) + COALESCE((SELECT SUM(length(CAST(record AS BLOB))) FROM image_preparations WHERE tenant_id = ? AND project_id = ?), 0) + COALESCE((SELECT SUM(length(CAST(record AS BLOB))) FROM image_fixture_responses WHERE tenant_id = ? AND project_id = ?), 0) + COALESCE((SELECT SUM(length(CAST(record AS BLOB))) FROM generated_images WHERE tenant_id = ? AND project_id = ?), 0) + COALESCE((SELECT SUM(length(CAST(record AS BLOB))) FROM production_image_preparations WHERE tenant_id = ? AND project_id = ?), 0) + COALESCE((SELECT SUM(length(CAST(record AS BLOB))) FROM production_image_responses WHERE tenant_id = ? AND project_id = ?), 0) AS bytes")
      .get(tenantId, projectId, tenantId, projectId, tenantId, projectId, tenantId, projectId, tenantId, projectId, tenantId, projectId)?.bytes ?? 0)
      + Number(this.database.prepare("SELECT COALESCE(SUM(length(CAST(record AS BLOB))), 0) AS bytes FROM production_image_artifacts WHERE tenant_id = ? AND project_id = ?").get(tenantId, projectId)?.bytes ?? 0);
  }
  imageFixtureResponseBytes(tenantId: string, projectId: string): number {
    return Number(this.database.prepare("SELECT COALESCE(SUM(length(body)), 0) AS bytes FROM image_fixture_responses WHERE tenant_id = ? AND project_id = ?").get(tenantId, projectId)?.bytes ?? 0);
  }
  localImageBinaryBytes(tenantId: string, projectId: string): number {
    return this.verifiedImageBytes(tenantId, projectId) + this.imageFixtureResponseBytes(tenantId, projectId) + this.productionImageResponseBytes(tenantId, projectId);
  }
  productionImageResponseBytes(tenantId: string, projectId: string): number {
    return Number(this.database.prepare("SELECT COALESCE(SUM(length(body)), 0) AS bytes FROM production_image_responses WHERE tenant_id = ? AND project_id = ?").get(tenantId, projectId)?.bytes ?? 0);
  }
  supportsProductionImageArtifacts(): boolean { return this.productionArtifactStorageEnabled; }
  loadProductionImageArtifact(tenant: string, project: string, mode: ProductionImageArtifact["mode"], job: string): ProductionImageArtifact | null {
    if (!this.productionArtifactStorageEnabled) throw new Error("生产产物存储默认关闭");
    try { return this.transaction(() => {
      const args = [tenant, project, mode, job];
      const row = this.database.prepare("SELECT asset_id, record_sha256, length(CAST(record AS BLOB)) AS bytes FROM production_image_artifacts WHERE tenant_id = ? AND project_id = ? AND mode = ? AND job_id = ?").get(...args);
      const marker = this.database.prepare("SELECT asset_id, record_sha256 FROM production_image_artifact_presence WHERE tenant_id = ? AND project_id = ? AND mode = ? AND job_id = ?").get(...args);
      if (!row && !marker) return null;
      if (!row || !marker || row.asset_id !== marker.asset_id || row.record_sha256 !== marker.record_sha256 || typeof row.bytes !== "number" || row.bytes > 512 * 1024) throw new Error("生产产物证据缺失或超限");
      const value = this.database.prepare("SELECT record, record_sha256 FROM production_image_artifacts WHERE tenant_id = ? AND project_id = ? AND mode = ? AND job_id = ?").get(...args)!;
      const record = ProductionImageArtifactSchema.parse(this.readImageMetadata(value));
      const sizes = this.database.prepare("SELECT length(body) AS bytes, length(CAST(record AS BLOB)) AS metadata FROM verified_images WHERE tenant_id = ? AND project_id = ? AND asset_id = ?").get(tenant, project, String(row.asset_id));
      if (record.tenantId !== tenant || record.projectId !== project || record.mode !== mode || record.jobId !== job || record.image.asset.id !== row.asset_id
        || !sizes || typeof sizes.bytes !== "number" || sizes.bytes < 1 || sizes.bytes > 20 * 1024 * 1024 || typeof sizes.metadata !== "number" || sizes.metadata > 512 * 1024) throw new Error("生产产物归属或正文容量损坏");
      const image = this.loadVerifiedImageBytes(tenant, project, record.image.asset.id);
      try { if (!image || JSON.stringify(image.receipt) !== JSON.stringify(record.image)) throw new Error("生产产物正文/收据与谱系不一致"); }
      finally { image?.body.fill(0); }
      return record;
    }); } catch (error) { throw databaseError(error); }
  }
  saveProductionImageArtifact(input: ProductionImageArtifact, body: Buffer, limits: { maxMetadataBytes?: number; maxProjectBytes?: number } = {}): void {
    if (!this.productionArtifactStorageEnabled || this.depth === 0) throw new Error("生产产物须显式同库同步事务");
    const r = ProductionImageArtifactSchema.parse(input), payload = this.imageMetadataPayload(r), hash = createHash("sha256").update(payload).digest("hex");
    const metadata = limits.maxMetadataBytes ?? 16 * 1024 * 1024, binary = limits.maxProjectBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(metadata) || metadata < 0 || metadata > 16 * 1024 * 1024 || !Number.isSafeInteger(binary) || binary < 0 || binary > 512 * 1024 * 1024
      || !Buffer.isBuffer(body) || body.byteLength !== r.image.asset.byteSize || body.byteLength > 20 * 1024 * 1024 || createHash("sha256").update(body).digest("hex") !== r.image.checksumSha256) throw new Error("生产产物容量或字节不一致");
    this.transaction(() => {
      const existing = this.loadProductionImageArtifact(r.tenantId, r.projectId, r.mode, r.jobId);
      if (existing) { if (JSON.stringify(existing) !== payload) throw new Error("生产产物历史不能覆盖"); return; }
      if (this.localImageBinaryBytes(r.tenantId, r.projectId) + body.length > binary
        || this.imageMetadataBytes(r.tenantId, r.projectId) + imageTaskMetadataBytes(this.load(), r.tenantId, r.projectId) + Buffer.byteLength(payload) > metadata) throw new Error("生产产物共享容量不足");
      this.saveVerifiedImage(r.image, body);
      this.database.prepare("INSERT INTO production_image_artifacts(tenant_id, project_id, mode, job_id, asset_id, record, record_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(r.tenantId, r.projectId, r.mode, r.jobId, r.image.asset.id, payload, hash);
      this.database.prepare("INSERT INTO production_image_artifact_presence(tenant_id, project_id, mode, job_id, asset_id, record_sha256) VALUES (?, ?, ?, ?, ?, ?)")
        .run(r.tenantId, r.projectId, r.mode, r.jobId, r.image.asset.id, hash);
    });
  }
  // Internal raw storage ONLY, default closed. Does not prove actual task,
  // attempt, permissions, transport invocation, asset authorization or billing.
  supportsProductionImageResponses(): boolean { return this.productionResponseStorageEnabled; }
  loadProductionImageResponse(tenantId: string, projectId: string, mode: ProductionImageRawResponse["mode"], jobId: string): { record: ProductionImageRawResponse; body: Buffer } | null {
    return this.readProductionResponse(tenantId, projectId, mode, jobId, ProductionImageRawResponseSchema);
  }
  loadLockedProductionImageResponse(tenantId: string, projectId: string, mode: LockedProductionImageRawResponse["mode"], jobId: string) {
    return this.readProductionResponse(tenantId, projectId, mode, jobId, LockedProductionImageRawResponseSchema);
  }
  private readProductionResponse<T extends ProductionImageRawResponse | LockedProductionImageRawResponse>(tenantId: string, projectId: string, mode: T["mode"], jobId: string, schema: { parse(input: unknown): T }): { record: T; body: Buffer } | null {
    if (!this.productionResponseStorageEnabled) throw new Error("生产原包存储默认关闭");
    if (!["production", "production-contract-fixture"].includes(mode)) throw new Error("生产原包命名空间无效");
    try {
      return this.transaction(() => {
        const row = this.database.prepare("SELECT response_id, record_sha256, length(CAST(record AS BLOB)) AS record_bytes, length(body) AS body_bytes FROM production_image_responses WHERE tenant_id = ? AND project_id = ? AND mode = ? AND job_id = ?").get(tenantId, projectId, mode, jobId);
        const marker = this.database.prepare("SELECT response_id, record_sha256 FROM production_image_response_presence WHERE tenant_id = ? AND project_id = ? AND mode = ? AND job_id = ?").get(tenantId, projectId, mode, jobId);
        if (!row && !marker) return null;
        if (!row || !marker || row.response_id !== marker.response_id || row.record_sha256 !== marker.record_sha256
          || typeof row.record_bytes !== "number" || row.record_bytes > 512 * 1024 || typeof row.body_bytes !== "number" || row.body_bytes > 32 * 1024 * 1024) throw new Error("生产原包证据丢失或超限");
        const value = this.database.prepare("SELECT record, record_sha256, body FROM production_image_responses WHERE tenant_id = ? AND project_id = ? AND mode = ? AND job_id = ?").get(tenantId, projectId, mode, jobId)!;
        const record = schema.parse(this.readImageMetadata(value));
        if (!(value.body instanceof Uint8Array)) throw new Error("生产原包正文缺失");
        const body = Buffer.from(value.body), outcome = record.outcome;
        if (record.id !== row.response_id || record.mode !== mode || outcome.tenantId !== tenantId || outcome.projectId !== projectId || outcome.jobId !== jobId
          || body.byteLength !== record.bodyByteSize || createHash("sha256").update(body).digest("hex") !== record.bodyChecksumSha256) { body.fill(0); throw new Error("生产原包归属或字节损坏"); }
        return { record, body };
      });
    } catch (error) { throw databaseError(error); }
  }
  saveProductionImageResponse(input: ProductionImageRawResponse, body: Buffer, limits: { maxMetadataBytes?: number; maxProjectBytes?: number } = {}): void {
    this.writeProductionResponse(ProductionImageRawResponseSchema.parse(input), body, limits);
  }
  saveLockedProductionImageResponse(input: LockedProductionImageRawResponse, body: Buffer, afterWrite: () => void, limits: { maxMetadataBytes?: number; maxProjectBytes?: number } = {}): void {
    this.writeProductionResponse(LockedProductionImageRawResponseSchema.parse(input), body, limits, afterWrite);
  }
  private writeProductionResponse(record: ProductionImageRawResponse | LockedProductionImageRawResponse, body: Buffer, limits: { maxMetadataBytes?: number; maxProjectBytes?: number }, afterWrite?: () => void): void {
    if (!this.productionResponseStorageEnabled) throw new Error("生产原包存储默认关闭");
    if (this.depth === 0) throw new Error("必须在事务中保存生产原包");
    const metadata = limits.maxMetadataBytes ?? 16 * 1024 * 1024, binary = limits.maxProjectBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(metadata) || metadata < 0 || metadata > 16 * 1024 * 1024 || !Number.isSafeInteger(binary) || binary < 0 || binary > 512 * 1024 * 1024
      || !Buffer.isBuffer(body) || body.byteLength !== record.bodyByteSize || createHash("sha256").update(body).digest("hex") !== record.bodyChecksumSha256) throw new Error("生产原包容量或正文不一致");
    const payload = this.imageMetadataPayload(record), { tenantId, projectId, jobId } = record.outcome;
    this.transaction(() => {
      const existing = record.schemaVersion === 2 ? this.loadLockedProductionImageResponse(tenantId, projectId, record.mode, jobId) : this.loadProductionImageResponse(tenantId, projectId, record.mode, jobId);
      if (existing) {
        try { if (JSON.stringify(existing.record) !== payload || !existing.body.equals(body)) throw new Error("生产原包历史不可覆盖"); }
        finally { existing.body.fill(0); }
        return;
      }
      if (this.localImageBinaryBytes(tenantId, projectId) + body.byteLength > binary
        || this.imageMetadataBytes(tenantId, projectId) + imageTaskMetadataBytes(this.load(), tenantId, projectId) + Buffer.byteLength(payload, "utf8") > metadata) throw new Error("生产原包共享容量不足");
      const hash = createHash("sha256").update(payload).digest("hex");
      this.database.prepare("INSERT INTO production_image_responses(tenant_id, project_id, mode, job_id, response_id, record, record_sha256, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(tenantId, projectId, record.mode, jobId, record.id, payload, hash, body);
      afterWrite?.();
      this.database.prepare("INSERT INTO production_image_response_presence(tenant_id, project_id, mode, job_id, response_id, record_sha256) VALUES (?, ?, ?, ?, ?, ?)")
        .run(tenantId, projectId, record.mode, jobId, record.id, hash);
      afterWrite?.();
    });
  }
  loadImageFixtureResponse(tenantId: string, projectId: string, jobId: string): { record: Extract<ImageFixtureResult, { kind: "returned" }>; body: Buffer } | null {
    try {
      const row = this.database.prepare("SELECT record, record_sha256, length(body) AS body_bytes FROM image_fixture_responses WHERE tenant_id = ? AND project_id = ? AND job_id = ?").get(tenantId, projectId, jobId);
      const marker = this.database.prepare("SELECT job_id FROM image_fixture_response_presence WHERE tenant_id = ? AND project_id = ? AND job_id = ?").get(tenantId, projectId, jobId);
      if (!row && !marker) return null;
      if (!row || !marker || typeof row.body_bytes !== "number" || row.body_bytes < 0 || row.body_bytes > 32 * 1024 * 1024) throw new Error("图片响应证据缺失或超限");
      const record = ImageFixtureResultSchema.parse(this.readImageMetadata(row));
      const bytes = this.database.prepare("SELECT body FROM image_fixture_responses WHERE tenant_id = ? AND project_id = ? AND job_id = ?").get(tenantId, projectId, jobId)?.body;
      if (!(bytes instanceof Uint8Array)) throw new Error("图片响应正文缺失");
      const body = Buffer.from(bytes);
      if (record.kind !== "returned" || record.outcome.tenantId !== tenantId || record.outcome.projectId !== projectId || record.outcome.jobId !== jobId
        || body.byteLength !== record.bodyByteSize || createHash("sha256").update(body).digest("hex") !== record.bodyChecksumSha256) throw new Error("图片响应归属或正文损坏");
      return { record, body };
    } catch (error) { throw databaseError(error); }
  }
  saveImageFixtureResponse(incoming: ImageFixtureResult, body: Buffer): void {
    if (this.depth === 0) throw new Error("必须在事务中保存图片响应");
    const record = ImageFixtureResultSchema.parse(incoming);
    if (record.kind !== "returned" || body.byteLength !== record.bodyByteSize || createHash("sha256").update(body).digest("hex") !== record.bodyChecksumSha256) throw new Error("图片响应提交不一致");
    const payload = this.imageMetadataPayload(record), { tenantId, projectId, jobId } = record.outcome;
    this.database.prepare("INSERT INTO image_fixture_responses(tenant_id, project_id, job_id, record, record_sha256, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run(tenantId, projectId, jobId, payload, createHash("sha256").update(payload).digest("hex"), body);
    this.database.prepare("INSERT INTO image_fixture_response_presence(tenant_id, project_id, job_id) VALUES (?, ?, ?)").run(tenantId, projectId, jobId);
  }
  private imageMetadataPayload(value: unknown): string {
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload, "utf8") > 512 * 1024) throw new Error("图片配置/准备单元数据过大");
    return payload;
  }
  private readImageMetadata(row: Record<string, unknown>): unknown {
    if (typeof row.record !== "string" || Buffer.byteLength(row.record, "utf8") > 512 * 1024
      || createHash("sha256").update(row.record).digest("hex") !== row.record_sha256) throw new Error("图片元数据摘要损坏");
    return JSON.parse(row.record);
  }

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
