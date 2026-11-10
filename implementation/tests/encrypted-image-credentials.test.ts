import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EncryptedImageCredentials, SqliteImageCredentialStore, type EncryptedImageCredentialOptions, type ImageCredentialContext,
  type ImageRootKeyPort, type ImageRootKeyRequest } from "../apps/api/src/encryptedImageCredentials";
import type { ImageCredentialScope } from "../apps/api/src/imageEgressContract";

const ownedStores: SqliteImageCredentialStore[] = [], ownedDirs: string[] = [], keys: Buffer[] = [];
afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
  for (const store of ownedStores.splice(0)) store.close();
  for (const key of keys.splice(0)) key.fill(0);
  for (const dir of ownedDirs.splice(0)) rmSync(dir, { recursive: true }); // Only this test's mkdtemp directories.
});
const signal = () => new AbortController().signal;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(limits: ConstructorParameters<typeof SqliteImageCredentialStore>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "owned-image-credentials-")); ownedDirs.push(dir);
  const path = join(dir, "credentials.sqlite"), store = new SqliteImageCredentialStore(path, limits); ownedStores.push(store);
  const root = randomBytes(32), root2 = randomBytes(32); keys.push(root, root2);
  const secret = Buffer.from(randomBytes(24).toString("hex")), context = {
    binding: { tenantId: "tenant-a", projectId: "project-a", connectionId: "connection-a", credentialRef: "opaque-reference" },
    actorId: "administrator", connectionRevision: 1, expectedVersion: 0,
  };
  const roots = new Map([[1, root], [2, root2]]), requests: ImageRootKeyRequest[] = [];
  const rootKeys: ImageRootKeyPort = { withRootKey: vi.fn(async (request, _signal, use) => {
    requests.push(structuredClone(request)); const key = roots.get(request.root.version)!;
    await use({ request: structuredClone(request), key });
  }) };
  const options: EncryptedImageCredentialOptions = { credentialAccessEnabled: true, tenantId: "tenant-a", store, rootKeys,
    writeRoot: { id: "owned-root", version: 1 }, authorize: vi.fn(() => true), clock: () => 1791078600000 };
  const scope: ImageCredentialScope = { ...context.binding, actorId: "worker", connectionRevision: 1, requestFingerprint: "a".repeat(64), payloadChecksumSha256: "b".repeat(64) };
  const service = new EncryptedImageCredentials(options);
  const create = () => service.create(context, secret, signal());
  const consume = (use = vi.fn(async () => undefined), version = 1) => service.consume(scope, version, signal(), use);
  const sql = (work: (db: DatabaseSync) => void) => { const db = new DatabaseSync(path); try { work(db); } finally { db.close(); } };
  const rows = () => { let values: Array<{ record: string; digest: string }> = []; sql(db => { values = db.prepare("SELECT record,digest FROM credential_events ORDER BY version").all() as typeof values; }); return values; };
  // Rewrite public digest too: the tests must exercise authenticated encryption,
  // not merely catch an unkeyed checksum mismatch.
  const tamper = (mutate: (record: Record<string, any>) => void) => sql(db => {
    const row = db.prepare("SELECT scope_id,version,record FROM credential_events ORDER BY version DESC LIMIT 1").get()!;
    const record = JSON.parse(row.record as string); mutate(record); const serialized = JSON.stringify(record), digest = createHash("sha256").update(serialized).digest("hex");
    db.prepare("UPDATE credential_events SET record=?,digest=? WHERE scope_id=? AND version=?").run(serialized, digest, row.scope_id!, row.version!);
    db.prepare("UPDATE credential_heads SET digest=? WHERE scope_id=?").run(digest, row.scope_id!);
  });
  return { dir, path, store, root, root2, roots, secret, context, rootKeys, requests, options, scope, service, create, consume, sql, rows, tamper };
}

describe("默认关闭的独立密文底座：只使用自有随机测试材料", () => {
  it("未配置服务拒绝且没有根钥匙回调；不自动打开默认文件或网络", async () => {
    const f = fixture(); await expect(new EncryptedImageCredentials().create(f.context, f.secret, signal())).rejects.toThrow("image_credential_not_configured");
    await expect(new EncryptedImageCredentials().consume(f.scope, 1, signal(), async () => undefined)).rejects.toThrow("image_credential_not_configured");
    expect(f.rootKeys.withRootKey).not.toHaveBeenCalled(); expect(f.rows()).toEqual([]);
  });
  it.each([{ credentialAccessEnabled: false }, { tenantId: 1 }, { writeRoot: { id: "x", version: 0 } }, { rootKeys: {} }, { timeoutMs: 30001 }, { timeoutMs: 0 }, { authorize: undefined }])("拒绝无效配置 %j", changed => {
    const f = fixture(); expect(() => new EncryptedImageCredentials({ ...f.options, ...changed } as never)).toThrow("image_credential_configuration_invalid");
  });
  it("独立存储拒绝相对/空路径和其他数据库，原用户表及版本保持不变", () => {
    for (const path of ["", "credentials.sqlite", "../credentials.sqlite"]) expect(() => new SqliteImageCredentialStore(path)).toThrow("configuration_invalid");
    const f = fixture(), other = join(f.dir, "other.sqlite"), db = new DatabaseSync(other); db.exec("CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES('preserve'); PRAGMA user_version=5"); db.close();
    expect(() => new SqliteImageCredentialStore(other)).toThrow("configuration_invalid");
    const check = new DatabaseSync(other); expect(check.prepare("SELECT value FROM user_data").get()!.value).toBe("preserve");
    expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(5); check.close();
  });
  it("创建只保存AES-256-GCM密文/范围/版本，不落明文或根钥匙；回调临时Buffer清零", async () => {
    const f = fixture(), created = await f.create(), use = vi.fn(async lease => { expect(lease.secret).toEqual(f.secret); expect(lease.scope).toEqual(f.scope); lease.assertCurrent(); });
    expect(created).toMatchObject({ schemaVersion: 1, version: 1, state: "active", binding: f.context.binding, root: { id: "owned-root", version: 1 } });
    expect(Object.keys(created).sort()).toEqual(["actorId", "binding", "connectionRevision", "createdAt", "root", "schemaVersion", "state", "version"]);
    await f.consume(use); expect(use).toHaveBeenCalledTimes(1); expect(use.mock.calls[0][0].secret.every((byte: number) => byte === 0)).toBe(true);
    expect(() => use.mock.calls[0][0].assertCurrent()).toThrow("cancelled"); expect(f.root.some(byte => byte !== 0)).toBe(true); expect(f.secret.some(byte => byte !== 0)).toBe(true);
    const record = JSON.parse(f.rows()[0].record); expect(record.algorithm).toBe("AES-256-GCM"); expect(Buffer.from(record.nonce, "base64")).toHaveLength(12); expect(Buffer.from(record.tag, "base64")).toHaveLength(16);
    for (const name of readdirSync(f.dir)) { const bytes = readFileSync(join(f.dir, name)); expect(bytes.includes(f.secret)).toBe(false); expect(bytes.includes(f.root)).toBe(false); }
  });
  it("重启/跨连接恢复仍使用原不可变密文与范围，不返回秘密", async () => {
    const f = fixture(); await f.create(); const before = f.rows(); f.store.close();
    const store2 = new SqliteImageCredentialStore(f.path); ownedStores.push(store2);
    const service2 = new EncryptedImageCredentials({ ...f.options, store: store2 });
    await service2.consume(f.scope, 1, signal(), async lease => { expect(lease.secret).toEqual(f.secret); });
    expect(f.rows()).toEqual(before); expect(f.requests.at(-1)).toMatchObject({ context: { operation: "consume", execution: f.scope }, credentialVersion: 1, root: { id: "owned-root", version: 1 } });
  });
  it.each([Buffer.alloc(0), Buffer.alloc(4097, 65), Buffer.from("has space"), Buffer.from("line\n"), Buffer.from([255])])("无效秘密拒绝且不保存 %j", async secret => {
    const f = fixture(); await expect(f.service.create(f.context, secret, signal())).rejects.toThrow("secret_invalid"); expect(f.rows()).toEqual([]); expect(f.requests).toEqual([]);
  });
  it("输入秘密在首个await前复制，调用者后来修改不会改变密文", async () => {
    const f = fixture(), original = Buffer.from(f.secret), done = f.create(); f.secret.fill(65); await done;
    await f.consume(vi.fn(async lease => { expect(lease.secret).toEqual(original); }));
  });
  it.each(["tenantId", "projectId", "connectionId", "credentialRef"])("%s 跨范围不能读取原凭证", async field => {
    const f = fixture(); await f.create(); const use = vi.fn();
    await expect(f.service.consume({ ...f.scope, [field]: "other" }, 1, signal(), use)).rejects.toThrow(field === "tenantId" ? "scope_invalid" : "not_found");
    expect(use).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(1);
  });
  it.each([{ connectionRevision: 2 }, { requestFingerprint: "bad" }, { payloadChecksumSha256: "bad" }, { actorId: undefined }, { unexpected: true }])("无效/漂移消费范围 %j", async changed => {
    const f = fixture(); await f.create(); const use = vi.fn();
    await expect(f.service.consume({ ...f.scope, ...changed } as never, 1, signal(), use)).rejects.toThrow(/scope_invalid|version_conflict/); expect(use).not.toHaveBeenCalled();
  });
  it.each([false, undefined, 1, Promise.resolve(true)])("同步可信政策必须严格true：%s", async decision => {
    const f = fixture(), storeRead = vi.spyOn(f.store, "read"); const service = new EncryptedImageCredentials({ ...f.options, authorize: () => decision as never });
    await expect(service.create(f.context, f.secret, signal())).rejects.toThrow("permission_denied"); expect(storeRead).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
  });
  it("根钥匙返回后撤权不落库，消费前撤权不调用使用者", async () => {
    const f = fixture(); let allowed = true;
    const rootKeys: ImageRootKeyPort = { withRootKey: async (request, abort, use) => { await f.rootKeys.withRootKey(request, abort, use); allowed = false; } };
    const service = new EncryptedImageCredentials({ ...f.options, rootKeys, authorize: () => allowed });
    await expect(service.create(f.context, f.secret, signal())).rejects.toThrow("permission_denied"); expect(f.rows()).toEqual([]);
    await f.create(); allowed = true; const use = vi.fn(); await expect(service.consume(f.scope, 1, signal(), use)).rejects.toThrow("permission_denied"); expect(use).not.toHaveBeenCalled();
  });
  it("写后最终政策失败原子回滚事件与头，不留下伪版本", async () => {
    const f = fixture(); let commit = 0; const service = new EncryptedImageCredentials({ ...f.options, authorize: (_ctx, phase) => phase !== "before-commit" || ++commit < 2 });
    await expect(service.create(f.context, f.secret, signal())).rejects.toThrow("permission_denied"); expect(f.rows()).toEqual([]);
    expect(f.store.read(f.context.binding)).toBeNull(); await f.create(); expect(f.rows()).toHaveLength(1);
  });
  it("轮换追加新版本及新随机nonce，原版本保留，旧期望版本拒绝", async () => {
    const f = fixture(); await f.create(); const first = f.rows()[0], changed = Buffer.from(randomBytes(24).toString("hex"));
    const rotated = await f.service.rotate({ ...f.context, expectedVersion: 1 }, changed, signal()); expect(rotated.version).toBe(2); expect(f.rows()[0]).toEqual(first);
    const second = JSON.parse(f.rows()[1].record); expect(second.previousDigest).toBe(first.digest); expect(second.nonce).not.toBe(JSON.parse(first.record).nonce);
    await expect(f.consume()).rejects.toThrow("version_conflict"); await f.consume(vi.fn(async lease => { expect(lease.secret).toEqual(changed); }), 2);
    await expect(f.service.rotate({ ...f.context, expectedVersion: 1 }, changed, signal())).rejects.toThrow("version_conflict"); expect(f.rows()).toHaveLength(2);
  });
  it("根钥匙版本显式轮换；旧钥匙不可读不静默选择新钥匙或覆盖历史", async () => {
    const f = fixture(); await f.create(); const first = f.rows()[0], service = new EncryptedImageCredentials({ ...f.options, writeRoot: { id: "owned-root", version: 2 } });
    await service.rotate({ ...f.context, expectedVersion: 1 }, f.secret, signal()); expect(f.rows()[0]).toEqual(first);
    f.roots.delete(1); await service.consume(f.scope, 2, signal(), async lease => { expect(lease.secret).toEqual(f.secret); });
    f.roots.delete(2); await expect(service.consume(f.scope, 2, signal(), vi.fn())).rejects.toThrow("key_invalid"); expect(f.rows()).toHaveLength(2);
  });
  it("撤销是认证追加事件，重复撤销不追加，不能在同引用上复活", async () => {
    const f = fixture(); await f.create(); const first = f.rows()[0]; const result = await f.service.revoke({ ...f.context, expectedVersion: 1 }, signal());
    expect(result).toMatchObject({ state: "revoked", version: 2 }); expect(f.rows()[0]).toEqual(first); expect(JSON.parse(f.rows()[1].record).ciphertext).toBe("");
    await expect(f.consume(vi.fn(), 2)).rejects.toThrow("revoked"); expect(await f.service.revoke({ ...f.context, expectedVersion: 2 }, signal())).toEqual(result); expect(f.rows()).toHaveLength(2);
    await expect(f.service.rotate({ ...f.context, expectedVersion: 2 }, f.secret, signal())).rejects.toThrow("revoked");
    await expect(f.create()).rejects.toThrow("version_conflict");
  });
  it("并发创建/跨SQLite连接轮换CAS只有一个提交，无覆盖或两个活版本", async () => {
    const f = fixture(), both = await Promise.allSettled([f.create(), f.create()]); expect(both.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(f.rows()).toHaveLength(1);
    const secondStore = new SqliteImageCredentialStore(f.path); ownedStores.push(secondStore); const second = new EncryptedImageCredentials({ ...f.options, store: secondStore });
    const rotations = await Promise.allSettled([f.service.rotate({ ...f.context, expectedVersion: 1 }, f.secret, signal()), second.rotate({ ...f.context, expectedVersion: 1 }, f.secret, signal())]);
    expect(rotations.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(f.rows()).toHaveLength(2);
  });
  it("已借出期间轮换：使用者发送前assertCurrent拒绝旧版本，临时Buffer随后清零", async () => {
    const f = fixture(); await f.create(); const entered = deferred(), finish = deferred(); let check!: () => void, borrowed!: Buffer;
    const consuming = f.service.consume(f.scope, 1, signal(), async lease => { check = lease.assertCurrent; borrowed = lease.secret; entered.resolve(); await finish.promise; });
    await entered.promise; await f.service.rotate({ ...f.context, expectedVersion: 1 }, f.secret, signal()); expect(() => check()).toThrow("version_conflict"); finish.resolve();
    await expect(consuming).rejects.toThrow("version_conflict"); expect(borrowed.every(byte => byte === 0)).toBe(true);
  });
  it.each(["nonce", "tag", "ciphertext", "actorId", "createdAt", "root", "algorithm", "schemaVersion", "version", "connectionRevision", "binding", "previousDigest"])("密文或认证元数据 %s 篡改，即使重算SHA也拒绝且不暴露明文", async field => {
    const f = fixture(); await f.create(); f.tamper(value => {
      if (["nonce", "tag", "ciphertext"].includes(field)) { const bytes = Buffer.from(value[field], "base64"); bytes[0] ^= 1; value[field] = bytes.toString("base64"); }
      else if (field === "root") value.root.version = 2;
      else if (field === "binding") value.binding.projectId = "other";
      else if (field === "previousDigest") value.previousDigest = "c".repeat(64);
      else if (typeof value[field] === "number") value[field]++;
      else value[field] = "tampered";
    });
    const use = vi.fn(); await expect(f.consume(use)).rejects.toThrow(/corrupt|version_conflict/); expect(use).not.toHaveBeenCalled();
    await expect(f.service.rotate({ ...f.context, expectedVersion: 1 }, f.secret, signal())).rejects.toThrow(/corrupt|version_conflict/); expect(f.rows()).toHaveLength(1);
  });
  it.each(["short-tag", "bad-base64", "extra-field", "wrong-key"])("拒绝非规范编码、标签、字段或钥匙 %s", async kind => {
    const f = fixture(); await f.create();
    if (kind === "wrong-key") f.roots.set(1, f.root2);
    else f.tamper(value => { if (kind === "short-tag") value.tag = Buffer.alloc(8).toString("base64"); if (kind === "bad-base64") value.nonce += " "; if (kind === "extra-field") value.private = "extra"; });
    const use = vi.fn(); await expect(f.consume(use)).rejects.toThrow("corrupt"); expect(use).not.toHaveBeenCalled();
  });
  it("孤立头/缺事件/头回退在仍有历史时拒绝，不默认为未配置", async () => {
    const f = fixture(); await f.create(); await f.service.rotate({ ...f.context, expectedVersion: 1 }, f.secret, signal());
    f.sql(db => { db.prepare("UPDATE credential_heads SET version=1,digest=?").run(f.rows()[0].digest); });
    await expect(f.consume()).rejects.toThrow("corrupt");
    f.sql(db => db.exec("DELETE FROM credential_heads")); await expect(f.consume()).rejects.toThrow("corrupt");
  });
  it.each(["no-callback", "twice", "wrong-binding", "short-key", "private-error"])("受控根钥匙端口失败关闭 %s", async kind => {
    const f = fixture(); const rootKeys: ImageRootKeyPort = { withRootKey: async (request, _abort, use) => {
      if (kind === "private-error") throw new Error("PRIVATE_SECRET_PRIVATE_PATH"); if (kind === "no-callback") return;
      const lease = { request: structuredClone(request), key: f.root };
      if (kind === "wrong-binding") lease.request.context.binding.projectId = "other"; if (kind === "short-key") lease.key = Buffer.alloc(31);
      await use(lease); if (kind === "twice") { try { await use(lease); } catch { /* Catching by trusted port cannot turn failure into success. */ } }
    } };
    const service = new EncryptedImageCredentials({ ...f.options, rootKeys });
    await expect(service.create(f.context, f.secret, signal())).rejects.toThrow(/^image_credential_(key_port_invalid|key_invalid|operation_failed)$/); expect(f.rows()).toEqual([]);
  });
  it("回调异常固定脱敏且不把返回值/Buffer透传为服务结果", async () => {
    const f = fixture(); await f.create(); let borrowed!: Buffer;
    await expect(f.service.consume(f.scope, 1, signal(), async lease => { borrowed = lease.secret; throw new Error("SECRET_AND_PATH"); })).rejects.toThrow(/^image_credential_operation_failed$/);
    expect(borrowed.every(byte => byte === 0)).toBe(true);
    expect(await f.service.consume(f.scope, 1, signal(), async lease => lease.secret as never)).toBeUndefined(); expect(f.rows()).toHaveLength(1);
  });
  it("取消/超时阻止后续借用和提交；非合作端口未结束仍占两个槽", async () => {
    const f = fixture(), entered1 = deferred(), entered2 = deferred(), finish = deferred(); let count = 0;
    const rootKeys: ImageRootKeyPort = { withRootKey: async (_request, _abort, _use) => { (++count === 1 ? entered1 : entered2).resolve(); await finish.promise; } };
    const service = new EncryptedImageCredentials({ ...f.options, rootKeys, timeoutMs: 10 }), first = service.create(f.context, f.secret, signal()), second = service.create(f.context, f.secret, signal());
    const settlements = Promise.allSettled([first, second]); await Promise.all([entered1.promise, entered2.promise]);
    expect((await settlements).every(result => result.status === "rejected" && result.reason.message === "image_credential_cancelled")).toBe(true);
    await expect(f.create()).rejects.toThrow("capacity"); expect(f.rows()).toEqual([]); finish.resolve(); await new Promise(resolve => setImmediate(resolve)); await f.create();
  });
  it("消费取消清零已经借出的Buffer且关闭guard，非合作消费未结束不重新发起", async () => {
    const f = fixture(); await f.create(); const entered = deferred(), finish = deferred(), controller = new AbortController(); let borrowed!: Buffer, check!: () => void;
    const consuming = f.service.consume(f.scope, 1, controller.signal, async lease => { borrowed = lease.secret; check = lease.assertCurrent; entered.resolve(); await finish.promise; });
    const assertion = expect(consuming).rejects.toThrow("cancelled"); await entered.promise; controller.abort(); await assertion; await new Promise(resolve => setImmediate(resolve));
    expect(borrowed.every(byte => byte === 0)).toBe(true); expect(() => check()).toThrow("cancelled"); finish.resolve(); await new Promise(resolve => setImmediate(resolve)); expect(f.rows()).toHaveLength(1);
  });
  it("预先取消不读取存储或钥匙，晚到的根回调不能恢复授权", async () => {
    const f = fixture(), abort = new AbortController(); abort.abort(); const read = vi.spyOn(f.store, "read");
    await expect(f.service.create(f.context, f.secret, abort.signal)).rejects.toThrow("cancelled"); expect(read).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
    let late!: Parameters<ImageRootKeyPort["withRootKey"]>[2], request!: ImageRootKeyRequest;
    const service = new EncryptedImageCredentials({ ...f.options, rootKeys: { withRootKey: async (req, _sig, use) => { late = use; request = req; } } });
    await expect(service.create(f.context, f.secret, signal())).rejects.toThrow("key_port_invalid");
    await expect(late({ request, key: f.root })).rejects.toThrow("key_port_invalid"); expect(f.rows()).toEqual([]);
  });
  it.each([{ maxBytes: 1 }, { maxVersions: 1 }, { maxReferences: 1 }])("容量限制不删除历史或部分更新 %j", async limits => {
    const f = fixture(limits);
    if (limits.maxBytes) { await expect(f.create()).rejects.toThrow("capacity"); expect(f.rows()).toEqual([]); return; }
    await f.create(); const before = f.rows();
    if (limits.maxVersions) await expect(f.service.rotate({ ...f.context, expectedVersion: 1 }, f.secret, signal())).rejects.toThrow("capacity");
    else await expect(f.service.create({ ...f.context, binding: { ...f.context.binding, credentialRef: "another-reference" } }, f.secret, signal())).rejects.toThrow("capacity");
    expect(f.rows()).toEqual(before); await f.consume();
  });
  it("关闭/坏存储失败不把原始SQLite路径、原因或秘密传给调用者", async () => {
    const f = fixture(); await f.create(); f.store.close(); await expect(f.consume()).rejects.toThrow(/^image_credential_storage_failed$/);
  });
  it("活版本达到限额仍有保留终止槽可撤销，不删除历史", async () => {
    const f = fixture({ maxVersions: 1 }); await f.create(); const first = f.rows()[0];
    await expect(f.service.rotate({ ...f.context, expectedVersion: 1 }, f.secret, signal())).rejects.toThrow("capacity");
    expect(await f.service.revoke({ ...f.context, expectedVersion: 1 }, signal())).toMatchObject({ state: "revoked", version: 2 });
    expect(f.rows()).toHaveLength(2); expect(f.rows()[0]).toEqual(first); await expect(f.consume(vi.fn(), 2)).rejects.toThrow("revoked");
  });
  it("字节配额为活引用预留撤销记录：不足时拒绝新活版本但可写终止事件", async () => {
    const f = fixture({ maxBytes: 20 * 1024 }); await f.create();
    const large = Buffer.alloc(4096, 65); await expect(f.service.rotate({ ...f.context, expectedVersion: 1 }, large, signal())).rejects.toThrow("capacity");
    await f.service.revoke({ ...f.context, expectedVersion: 1 }, signal()); expect(f.rows()).toHaveLength(2);
  });
  it("时间倒退与额外确认字段拒绝，不信任调用者confirmed或附带执行许可", async () => {
    const f = fixture(); await f.create(); const service = new EncryptedImageCredentials({ ...f.options, clock: () => 1 });
    await expect(service.rotate({ ...f.context, expectedVersion: 1 }, f.secret, signal())).rejects.toThrow("configuration_invalid");
    await expect(f.service.rotate({ ...f.context, expectedVersion: 1, confirmed: true } as never, f.secret, signal())).rejects.toThrow("scope_invalid");
    expect(f.rows()).toHaveLength(1);
  });
  it("根端口已执行但迟迟不返回：超时不能落库，晚回不会重新执行或借用", async () => {
    const f = fixture(), entered = deferred(), finish = deferred();
    const rootKeys: ImageRootKeyPort = { withRootKey: async (request, _abort, use) => { await use({ request, key: f.root }); entered.resolve(); await finish.promise; } };
    const service = new EncryptedImageCredentials({ ...f.options, rootKeys, timeoutMs: 10 }), creating = service.create(f.context, f.secret, signal());
    const assertion = expect(creating).rejects.toThrow("cancelled"); await entered.promise; await assertion; expect(f.rows()).toEqual([]);
    finish.resolve(); await new Promise(resolve => setImmediate(resolve)); expect(f.rows()).toEqual([]);
  });
});
