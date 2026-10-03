import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { AssetSchema, VerifiedImageSchema, type Asset, type VerifiedImage } from "@canvas/contracts";
import type { ObjectStorageAuthorizer, StoragePrincipal } from "./objectStorageGateway";
import { RunKernelError } from "./runKernel";
import { SqliteRunKernelStateStore, SqliteStateStoreError } from "./sqliteRunKernelStore";
import { decodeStaticImage, imageMagicMime, rejectStaticImageAnimation, MAX_STATIC_IMAGE_PIXELS } from "./staticImageDecoder";

export interface VerifiedAssetPort {
  authenticate(request: IncomingMessage): StoragePrincipal | null;
  verify(principal: StoragePrincipal, projectId: string, assetId: string, request: IncomingMessage): Promise<VerifiedImage>;
  get(principal: StoragePrincipal, projectId: string, assetId: string): VerifiedImage;
}
export const MAX_VERIFIED_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_VERIFIED_IMAGE_PIXELS = MAX_STATIC_IMAGE_PIXELS;

export function assetMetadataFingerprint(asset: Asset): string {
  return createHash("sha256").update(JSON.stringify(AssetSchema.parse(asset))).digest("hex");
}

function reject(code: string, message: string, status = 422): never { throw new RunKernelError(status, code, message); }

// Binary ingestion occurs outside the task database lock. Only validated immutable
// bytes and the server-issued receipt are committed, and all later reads re-hash bytes.
export class LocalVerifiedAssets implements VerifiedAssetPort {
  private active = 0;
  constructor(private readonly options: {
    stateStore: SqliteRunKernelStateStore;
    authorizer: ObjectStorageAuthorizer;
    findAsset: (tenantId: string, projectId: string, assetId: string) => Asset | null;
    maxProjectBytes?: number;
  }) {}

  authenticate(request: IncomingMessage) { return this.options.authorizer.authenticate(request); }

  get(principal: StoragePrincipal, projectId: string, assetId: string): VerifiedImage {
    if (!this.options.authorizer.allows(principal, projectId, "asset:read")) reject("verified_asset_not_found", "图片验证记录不存在", 404);
    return this.database(() => this.options.stateStore.transaction(() => this.requireImage(principal.tenantId, projectId, assetId)));
  }

  requireImage(tenantId: string, projectId: string, assetId: string): VerifiedImage {
    const registered = this.options.findAsset(tenantId, projectId, assetId);
    if (!registered || registered.kind !== "image") reject("verified_asset_not_found", "图片不存在或不属于当前项目", 404);
    const record = this.options.stateStore.loadVerifiedImage(tenantId, projectId, assetId);
    if (!record) reject("run_asset_not_verified", "图片原文件尚未通过服务端校验");
    if (record.registeredMetadataSha256 !== assetMetadataFingerprint(registered)) reject("verified_asset_metadata_changed", "登记资产已变化，请创建新版本");
    if (record.asset.purpose === "mask") {
      const sourceId = record.asset.sourceAssetId;
      if (!sourceId || sourceId === assetId) reject("verified_mask_source_invalid", "蒙版来源无效");
      const source = this.options.stateStore.loadVerifiedImage(tenantId, projectId, sourceId);
      const sourceRegistered = this.options.findAsset(tenantId, projectId, sourceId);
      if (!source || !sourceRegistered || source.asset.purpose === "mask" || source.registeredMetadataSha256 !== assetMetadataFingerprint(sourceRegistered)
        || source.checksumSha256 !== record.sourceChecksumSha256
        || source.asset.width !== record.asset.width || source.asset.height !== record.asset.height) reject("verified_mask_source_invalid", "蒙版底图验证不匹配");
    }
    return record;
  }

  async verify(principal: StoragePrincipal, projectId: string, assetId: string, request: IncomingMessage): Promise<VerifiedImage> {
    if (!this.options.authorizer.allows(principal, projectId, "asset:write")) reject("verified_asset_permission_denied", "没有图片写入权限", 403);
    const registered = this.database(() => this.options.findAsset(principal.tenantId, projectId, assetId));
    if (!registered || registered.kind !== "image") reject("verified_asset_not_found", "图片不存在或不属于当前项目", 404);
    if (!Number.isSafeInteger(registered.byteSize) || registered.byteSize <= 0 || registered.byteSize > MAX_VERIFIED_IMAGE_BYTES) {
      reject("verified_asset_too_large", "图片大小超出校验限制", 413);
    }
    if (this.active >= 2) reject("verified_asset_busy", "本机正在核验其他图片，请稍后重试", 429);
    const contentType = request.headers["content-type"];
    const checksum = request.headers["x-content-sha256"];
    if (typeof contentType !== "string" || contentType !== registered.mimeType
      || typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) reject("verified_asset_headers_invalid", "图片类型或摘要请求头无效", 400);
    const contentLength = request.headers["content-length"];
    if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) !== registered.byteSize)) {
      reject("verified_asset_size_mismatch", "上传大小与登记记录不一致");
    }
    this.active += 1;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > registered.byteSize || bytes > MAX_VERIFIED_IMAGE_BYTES) reject("verified_asset_too_large", "上传图片超过允许大小", 413);
        chunks.push(buffer);
      }
      if (bytes !== registered.byteSize) reject("verified_asset_size_mismatch", "实际接收字节数与登记记录不一致");
      const body = Buffer.concat(chunks);
      const actualChecksum = createHash("sha256").update(body).digest("hex");
      if (actualChecksum !== checksum || (registered.contentFingerprint && registered.contentFingerprint !== `sha256:${actualChecksum}`)) {
        reject("verified_asset_checksum_mismatch", "实际图片摘要与输入不一致");
      }
      const mime = imageMagicMime(body);
      if (!mime || mime !== registered.mimeType) reject("verified_asset_mime_mismatch", "图片魔数与文件类型不一致");
      rejectStaticImageAnimation(body, mime);
      const metadataHash = assetMetadataFingerprint(registered);
      // Fast replay still consumes and verifies the full uploaded body; metadata alone cannot revive missing bytes.
      const existing = this.database(() => this.options.stateStore.loadVerifiedImage(principal.tenantId, projectId, assetId));
      if (existing) {
        if (existing.checksumSha256 !== actualChecksum || existing.registeredMetadataSha256 !== metadataHash) reject("verified_asset_version_conflict", "同一资产编号不能覆盖为另一份内容", 409);
        return this.database(() => this.options.stateStore.transaction(() => this.requireImage(principal.tenantId, projectId, assetId)));
      }
      const { width, height, hasAlpha } = await decodeStaticImage(body, mime);
      if ((registered.width !== undefined && registered.width !== width) || (registered.height !== undefined && registered.height !== height)) {
        reject("verified_asset_dimensions_mismatch", "图片真实尺寸与登记记录不一致");
      }
      return this.database(() => this.options.stateStore.transaction(() => {
        const current = this.options.findAsset(principal.tenantId, projectId, assetId);
        if (!current || assetMetadataFingerprint(current) !== metadataHash
          || !this.options.authorizer.allows(principal, projectId, "asset:write")) reject("verified_asset_metadata_changed", "核验期间资产或权限已变化");
        const replay = this.options.stateStore.loadVerifiedImage(principal.tenantId, projectId, assetId);
        if (replay) {
          if (replay.checksumSha256 !== actualChecksum || replay.registeredMetadataSha256 !== metadataHash) reject("verified_asset_version_conflict", "资产版本冲突", 409);
          return this.requireImage(principal.tenantId, projectId, assetId);
        }
        if (this.options.stateStore.localImageBinaryBytes(principal.tenantId, projectId) + bytes > (this.options.maxProjectBytes ?? 512 * 1024 * 1024)) {
          reject("verified_asset_project_quota", "项目图片镜像空间不足", 413);
        }
        let sourceChecksumSha256: string | undefined;
        if (registered.purpose === "mask") {
          if (mime !== "image/png" || !hasAlpha || !registered.sourceAssetId || registered.sourceAssetId === assetId) reject("verified_mask_source_invalid", "蒙版必须为有透明通道的 PNG 并绑定底图");
          const source = this.requireImage(principal.tenantId, projectId, registered.sourceAssetId);
          if (source.asset.purpose === "mask" || source.asset.width !== width || source.asset.height !== height) reject("verified_mask_source_invalid", "蒙版尺寸或底图不匹配");
          sourceChecksumSha256 = source.checksumSha256;
        }
        const scope = createHash("sha256").update(JSON.stringify([principal.tenantId, projectId, assetId])).digest("hex");
        const { proxyStorageKey: _proxy, ...base } = registered;
        const record = VerifiedImageSchema.parse({ schemaVersion: 1, id: `verification-${randomUUID()}`, tenantId: principal.tenantId,
          asset: { ...base, mimeType: mime, width, height, byteSize: bytes, contentFingerprint: `sha256:${actualChecksum}`, storageKey: `local-verified:${scope}` },
          checksumSha256: actualChecksum, registeredMetadataSha256: metadataHash, sourceChecksumSha256, decoder: "sharp-full-decode-v1",
          verifiedBy: principal.actorId, verifiedAt: new Date().toISOString() });
        this.options.stateStore.saveVerifiedImage(record, body);
        return record;
      }));
    } finally { this.active -= 1; }
  }

  private database<T>(action: () => T): T {
    try { return action(); }
    catch (error) {
      if (error instanceof SqliteStateStoreError) throw new RunKernelError(503, error.code, "图片校验数据库不可用");
      throw error;
    }
  }
}
