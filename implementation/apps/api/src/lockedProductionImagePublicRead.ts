import type { LockedProductionImagePreparationRecord, RunKernelSnapshot } from "@canvas/contracts";
import { imageSnapshotFingerprint as fp, validateLockedProductionImagePreparationRequest } from "./imageProviderContract";
import { assertLockedExpectations, lockedExpected, lockedConfirmationKey, assertLockedConfirmation } from "./lockedProductionImageProtocol";
import { validateLockedProductionImagePreparationAssetPolicy } from "./imageAssetPolicy";
import { assertLockedImageRawResponse } from "./lockedProductionImageResponse";
import { assertLockedProductionImageArtifact } from "./lockedProductionImageArtifactIntegrity";
import { assetMetadataFingerprint } from "./assetMetadata";
import { imageTaskMetadataBytes } from "./imageTaskMetadata";
import type { SqliteRunKernel } from "./sqliteRunKernel";
import type { SqliteRunKernelStateStore } from "./sqliteRunKernelStore";

// Pure current-evidence read inside the caller's SAME transaction. No price,
// decode, pixel comparison, lease recovery, state write or sending capability.
export function readLockedPublicEvidence(store: SqliteRunKernelStateStore, kernel: Pick<SqliteRunKernel, "validateProductionBillingSnapshot">,
  r: LockedProductionImagePreparationRecord, snapshot: RunKernelSnapshot, check: () => void) {
  check(); kernel.validateProductionBillingSnapshot(snapshot); assertLockedExpectations(r, lockedExpected(r));
  const budget = snapshot.budgets.find(b => b.tenantId === r.tenantId && b.projectId === r.projectId);
  if (!budget || budget.currency !== r.pricing.quote.currency) throw new Error("budget currency");
  if (store.imageMetadataBytes(r.tenantId, r.projectId) + imageTaskMetadataBytes(snapshot, r.tenantId, r.projectId) > 16 * 1024 * 1024) throw new Error("metadata");
  if (r.requestDraft.operation !== "edit") throw new Error("locked edit required");
  check(); const catalog = store.loadCatalog(), catalogHash = fp(catalog), project = catalog?.projects.find(p => p.projectId === r.projectId);
  const refs = [...r.requestDraft.inputs, ...(r.requestDraft.mask ? [r.requestDraft.mask] : [])], assets = refs.map(i => project?.assets.find(a => a.id === i.assetId));
  if (assets.some(a => !a || !a.byteSize || a.byteSize > 30 * 1024 * 1024 || !a.width || !a.height || Math.max(a.width, a.height) > 8192 || a.width * a.height > 16_000_000)
    || assets.reduce((n, a) => n + a!.byteSize!, 0) > 64 * 1024 * 1024) throw new Error("inputs");
  check(); if (!store.loadImageProviderHistory(r.tenantId, r.projectId).some(h => fp(h.connection) === fp(r.connection))) throw new Error("connection");
  const request = { ...r.requestDraft, jobId: "locked-read-validation-only", idempotencyKey: "not-an-execution", quote: r.pricing.quote };
  validateLockedProductionImagePreparationRequest(r.connection, request, r.createdAt);
  validateLockedProductionImagePreparationAssetPolicy(store, request, check);
  for (const input of [r.protectionPolicy.source, r.protectionPolicy.mask]) {
    check(); const actual = store.loadVerifiedImage(r.tenantId, r.projectId, input.asset.id); check(); if (fp(actual) !== fp(input)) throw new Error("receipt");
  }
  check(); const matches = snapshot.batches.filter(s => s.aggregate.batch.tenantId === r.tenantId && s.aggregate.batch.projectId === r.projectId
    && (s.aggregate.batch.idempotencyKey === lockedConfirmationKey({ mode: r.mode, preparation: r }) || s.lockedProductionImageExecution?.preparation.id === r.id));
  if (matches.length > 1) throw new Error("confirmation"); const s = matches[0];
  if (s) {
    const e = assertLockedConfirmation(s.lockedProductionImageExecution); if (fp(e.preparation) !== fp(r)) throw new Error("preparation");
    check(); const raw = store.loadLockedProductionImageResponse(r.tenantId, r.projectId, r.mode, e.protocol.request.jobId);
    try {
      check(); const artifact = store.loadLockedProductionImageArtifact(r.tenantId, r.projectId, r.mode, e.protocol.request.jobId); check();
      if (s.lockedProductionImageResult?.kind === "returned") {
        if (!raw || fp(raw.record) !== s.lockedProductionImageResultFingerprint || fp(raw.record) !== fp(s.lockedProductionImageResult)) throw new Error("raw");
        const parsed = assertLockedImageRawResponse(raw.record, e, s.lockedProductionImageLeases?.at(-1), s.lockedProductionImageDispatchIntent, s.lockedProductionImageAttempt, raw.body);
        try {
          if (!!artifact !== !!s.lockedProductionImageArtifact || artifact && (fp(artifact) !== s.lockedProductionImageArtifactFingerprint || fp(artifact) !== fp(s.lockedProductionImageArtifact))) throw new Error("artifact");
          if (artifact) {
            assertLockedProductionImageArtifact(s, artifact); check();
            const a = store.loadCatalog()?.projects.find(p => p.projectId === r.projectId)?.assets.find(a => a.id === artifact.image.asset.id);
            if (!a || assetMetadataFingerprint(a) !== artifact.image.registeredMetadataSha256 || !parsed.candidate
              || parsed.candidate.checksumSha256 !== artifact.image.checksumSha256 || parsed.candidate.mimeType !== a.mimeType || parsed.candidate.body.length !== a.byteSize) throw new Error("output");
          }
        } finally { parsed.candidate?.body.fill(0); }
      } else if (raw || artifact || s.lockedProductionImageArtifact) throw new Error("orphan");
    } finally { raw?.body.fill(0); }
  }
  check(); validateLockedProductionImagePreparationAssetPolicy(store, request, check);
  for (const input of [r.protectionPolicy.source, r.protectionPolicy.mask]) {
    check(); if (fp(store.loadVerifiedImage(r.tenantId, r.projectId, input.asset.id)) !== fp(input)) throw new Error("receipt"); check();
  }
  check(); if (fp(store.loadLockedProductionImagePreparation(r.tenantId, r.projectId, r.mode, r.id)) !== fp(r)
    || fp(store.load()) !== fp(snapshot) || fp(store.loadCatalog()) !== catalogHash) throw new Error("changed"); check();
  return s ?? null;
}
