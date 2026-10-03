import { createHash, randomUUID } from "node:crypto";
import { GeneratedImageRecordSchema, ImageInputTransformSchema, ImageProviderOutcomeSchema, VerifiedImageSchema,
  type GeneratedImageRecord, type ImageExecutionRequest, type ImageProviderConnection } from "@canvas/contracts";
import type { ObjectStorageAuthorizer, StoragePrincipal } from "./objectStorageGateway";
import { requireImageConfirmation, validateImageProviderRequest } from "./imageProviderContract";
import { imagePayloadSha256, MAX_IMAGE_PROTOCOL_REQUEST_BYTES, type ImageInputTransform } from "./imageRequestPayload";
import { MAX_IMAGE_PROTOCOL_OUTPUT_BYTES, type ParsedImageProtocolResponse } from "./imageProtocolResponse";
import { decodeStaticImage } from "./staticImageDecoder";
import { constraintContentChecksum, validateLocalImageAssetPolicy } from "./imageAssetPolicy";
export { constraintContentChecksum } from "./imageAssetPolicy";
import { assetMetadataFingerprint } from "./verifiedAssets";
import { RunKernelError } from "./runKernel";
import { SqliteRunKernelStateStore, SqliteStateStoreError } from "./sqliteRunKernelStore";

export type ImageOutputContext = {
  connection: ImageProviderConnection; request: ImageExecutionRequest; confirmedFingerprint: string; confirmedAt: string;
  prepared: { body: Buffer; requestFingerprint: string; payloadChecksumSha256: string; transformedInputs: ImageInputTransform[] };
};
function reject(code: string, status = 422): never { throw new RunKernelError(status, code, "生成图片未通过权威验证，保留原任务与计费状态"); }

// Trusted server service only. No HTTP upload/result endpoint is enabled here.
// The synchronous execution-authority port is mandatory and fails closed; the
// production task/lease/budget integration must implement it in the next step.
export class LocalGeneratedImages {
  private active = 0;
  constructor(private readonly options: {
    tenantId: string;
    stateStore: SqliteRunKernelStateStore;
    authorizer: ObjectStorageAuthorizer;
    authorizeCommit: (request: ImageExecutionRequest, requestFingerprint: string, payloadChecksumSha256: string,
      binding: { confirmedAt: string; transformedInputs: readonly ImageInputTransform[] }) => undefined;
    maxProjectBytes?: number;
    clock?: () => number;
  }) {
    const quota = options.maxProjectBytes ?? 512 * 1024 * 1024;
    if (!options.tenantId.trim() || options.tenantId !== options.tenantId.trim() || options.tenantId.length > 160
      || !Number.isSafeInteger(quota) || quota < 0 || quota > 512 * 1024 * 1024) throw new Error("本机生成资产的租户或容量配置无效");
  }

  get(principal: StoragePrincipal, projectId: string, jobId: string): GeneratedImageRecord {
    return this.database(() => this.options.stateStore.transaction(() => {
      if (principal.tenantId !== this.options.tenantId || !this.options.authorizer.allows(principal, projectId, "asset:read")) reject("image_output_not_found", 404);
      const record = this.options.stateStore.loadGeneratedImage(principal.tenantId, projectId, jobId);
      if (!record) reject("image_output_not_found", 404);
      this.assertCatalogImage(record);
      return record;
    }));
  }

  async accept(principal: StoragePrincipal, context: ImageOutputContext, parsed: ParsedImageProtocolResponse): Promise<GeneratedImageRecord> {
    const actor = { tenantId: principal.tenantId, actorId: principal.actorId };
    // Confirmation was valid at dispatch. A late response after quote expiration
    // must not cause another paid execution or discard a previously authorized image.
    const validated = validateImageProviderRequest(context.connection, context.request, context.confirmedAt);
    requireImageConfirmation(validated.connection, validated.request, context.confirmedFingerprint, context.confirmedAt);
    const request = validated.request;
    const confirmedAt = context.confirmedAt;
    const outcome = ImageProviderOutcomeSchema.parse(parsed.outcome);
    const fingerprint = validated.fingerprint;
    const payloadHash = context.prepared.payloadChecksumSha256;
    const transforms = ImageInputTransformSchema.array().max(21).parse(context.prepared.transformedInputs);
    if (context.prepared.requestFingerprint !== fingerprint || context.prepared.body.byteLength > MAX_IMAGE_PROTOCOL_REQUEST_BYTES
      || imagePayloadSha256(context.prepared.body) !== payloadHash) reject("image_output_prepared_payload_changed");
    if (outcome.tenantId !== request.tenantId || outcome.projectId !== request.projectId || outcome.jobId !== request.jobId || outcome.connectionId !== request.connectionId
      || outcome.requestFingerprint !== fingerprint || outcome.providerStatus !== "returned" || outcome.artifactStatus !== "pending-validation" || outcome.failureCode !== undefined || outcome.billing.state !== "unknown" || !parsed.candidate) reject("image_output_response_not_accepted");
    const candidate = parsed.candidate;
    const mimeType = candidate.mimeType;
    if (!Buffer.isBuffer(candidate.body) || !candidate.body.byteLength || candidate.body.byteLength > MAX_IMAGE_PROTOCOL_OUTPUT_BYTES) reject("image_output_too_large", 413);
    if (mimeType !== `image/${request.parameters.outputFormat}`) reject("image_output_mime_mismatch");
    if (this.active >= 2) reject("image_output_busy", 429);
    this.active += 1;
    try {
      // Own the bytes across await; callers cannot change the artifact mid-decode.
      const body = Buffer.from(candidate.body);
      const checksum = imagePayloadSha256(body);
      if (candidate.checksumSha256 !== checksum) reject("image_output_checksum_changed");
      const refs = request.operation === "edit" ? [...request.inputs, ...(request.mask ? [request.mask] : [])] : [];
      if (transforms.length !== refs.length || refs.some((ref, index) => transforms[index]?.assetId !== ref.assetId || transforms[index]?.originalChecksumSha256 !== ref.checksumSha256)) reject("image_output_input_lineage_changed");
      const preflight = () => {
        if (actor.tenantId !== this.options.tenantId || request.tenantId !== actor.tenantId || !this.options.authorizer.allows(actor, request.projectId, "asset:write")) reject("image_output_permission_denied", 403);
        if (typeof this.options.authorizeCommit !== "function" || this.options.authorizeCommit(request, fingerprint, payloadHash, { confirmedAt, transformedInputs: transforms }) !== undefined) reject("image_output_execution_not_authorized", 403);
        if (refs.length && !this.options.authorizer.allows(actor, request.projectId, "asset:read")) reject("image_output_permission_denied", 403);
        const { catalog, project, constraint } = validateLocalImageAssetPolicy(this.options.stateStore, request);
        const existing = this.options.stateStore.loadGeneratedImage(request.tenantId, request.projectId, request.jobId);
        if (existing) {
          this.assertCatalogImage(existing);
          if (existing.requestFingerprint !== fingerprint || existing.payloadChecksumSha256 !== payloadHash || existing.image.checksumSha256 !== checksum
            || existing.confirmedAt !== confirmedAt || JSON.stringify(existing.providerOutcome) !== JSON.stringify(outcome)
            || JSON.stringify(existing.transformedInputs) !== JSON.stringify(transforms)) reject("image_output_version_conflict", 409);
        }
        return { catalog, project, constraint, existing };
      };
      const before = this.database(() => this.options.stateStore.transaction(preflight));
      if (before.existing) return before.existing;
      let decoded: Awaited<ReturnType<typeof decodeStaticImage>>;
      try { decoded = await decodeStaticImage(body, mimeType); }
      catch (error) {
        if (error instanceof RunKernelError) reject(error.code.replace(/^verified_asset_/, "image_output_"), error.status);
        return reject("image_output_decode_failed");
      }
      if (decoded.width !== before.constraint.outputSpec.width || decoded.height !== before.constraint.outputSpec.height) reject("image_output_dimensions_mismatch");
      if ((request.parameters.background === "transparent" && !decoded.hasTransparency) || (request.parameters.background === "opaque" && decoded.hasTransparency)) reject("image_output_background_mismatch");
      return this.database(() => this.options.stateStore.transaction(() => {
        const current = preflight();
        if (current.existing) return current.existing;
        if (this.options.stateStore.localImageBinaryBytes(request.tenantId, request.projectId) + body.byteLength > (this.options.maxProjectBytes ?? 512 * 1024 * 1024)) reject("image_output_project_quota", 413);
        if (current.project.assets.length >= 10_000) reject("image_output_catalog_full", 413);
        const assetId = `generated-${randomUUID()}`;
        const at = new Date((this.options.clock ?? Date.now)()).toISOString();
        const storageScope = createHash("sha256").update(JSON.stringify([request.tenantId, request.projectId, assetId])).digest("hex");
        const asset = { id: assetId, projectId: request.projectId, kind: "image" as const, purpose: "generated" as const,
          sourceAssetId: request.operation === "edit" ? request.inputs[0].assetId : undefined,
          originalName: `${assetId}.${request.parameters.outputFormat}`, storageKey: `local-verified:${storageScope}`,
          mimeType, byteSize: body.byteLength, width: decoded.width, height: decoded.height, contentFingerprint: `sha256:${checksum}`, createdAt: at };
        const image = VerifiedImageSchema.parse({ schemaVersion: 1, id: `verification-${randomUUID()}`, tenantId: request.tenantId, asset,
          registeredMetadataSha256: assetMetadataFingerprint(asset), checksumSha256: checksum, decoder: "sharp-full-decode-v1", verifiedBy: actor.actorId, verifiedAt: at });
        const record = GeneratedImageRecordSchema.parse({ schemaVersion: 1, validation: "verified", protectionApplied: "none", protocol: validated.connection.protocol,
          request, requestFingerprint: fingerprint, payloadChecksumSha256: payloadHash, transformedInputs: transforms, constraint: current.constraint, confirmedAt, providerOutcome: outcome, image });
        this.options.stateStore.saveGeneratedImage(record, body);
        current.project.assets.push(image.asset);
        this.options.stateStore.saveCatalog(current.catalog);
        // No financial/job mutation; a verified artifact is NOT settled billing.
        return record;
      }));
    } finally { this.active -= 1; }
  }

  private assertCatalogImage(record: GeneratedImageRecord): void {
    const asset = this.options.stateStore.loadCatalog()?.projects.find((project) => project.projectId === record.request.projectId)?.assets.find((item) => item.id === record.image.asset.id);
    if (!asset || assetMetadataFingerprint(asset) !== record.image.registeredMetadataSha256 || constraintContentChecksum(record.constraint) !== record.request.constraintChecksumSha256) throw new SqliteStateStoreError("run_state_unavailable", new Error("生成资产目录或约束已损坏或变化"));
  }
  private database<T>(action: () => T): T {
    try { return action(); }
    catch (error) {
      if (error instanceof RunKernelError) throw error;
      throw new RunKernelError(503, error instanceof SqliteStateStoreError ? error.code : "run_state_unavailable", "生成资产数据库不可用，未更改费用或任务状态");
    }
  }
}
