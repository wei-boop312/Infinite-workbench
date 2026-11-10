import { ConfirmedProductionImageExecutionSchema, type ConfirmedProductionImageExecution } from "@canvas/contracts";
import { imageSnapshotFingerprint, validateProductionImageProviderRequest } from "./imageProviderContract";
import { validateProductionImageConfirmationExpectations } from "./productionImageProtocol";

export function productionConfirmationKey(e: ConfirmedProductionImageExecution): string {
  return `production-image-confirm:${e.mode}:${e.preparation.id}`;
}
export function productionExpected(p: ConfirmedProductionImageExecution["preparation"]) {
  const q = p.pricing.quote;
  return { expectedSnapshotFingerprint: p.snapshotFingerprint, expectedPricingFingerprint: imageSnapshotFingerprint(p.pricing),
    expectedCurrency: q.currency, expectedMaxCostMinor: q.maxCostMinor,
    estimate: q.source === "manual-budget" ? { state: "unknown" as const } : { state: "known" as const, expectedEstimatedCostMinor: q.estimatedCostMinor } };
}
// Historical integrity only. No current permission, oracle, lease or send authority.
export function assertProductionConfirmation(input: unknown): ConfirmedProductionImageExecution {
  const e = ConfirmedProductionImageExecutionSchema.parse(input), p = e.preparation, s = e.protocol;
  validateProductionImageConfirmationExpectations(p, productionExpected(p));
  const { snapshotFingerprint, ...unsealed } = s;
  if (imageSnapshotFingerprint(p.pricing) !== s.pricingFingerprint || imageSnapshotFingerprint(unsealed) !== snapshotFingerprint
    || imageSnapshotFingerprint({ connection: p.connection, request: s.request }) !== s.requestFingerprint) throw new Error("生产确认协议摘要不一致");
  validateProductionImageProviderRequest(p.connection, s.request, e.confirmedAt);
  const refs = s.request.operation === "edit" ? [...s.request.inputs, ...(s.request.mask ? [s.request.mask] : [])] : [];
  const capability = p.connection.models.find((m) => m.model === s.request.model && m.version === s.request.capabilityVersion)!;
  for (const [i, ref] of refs.entries()) {
    const t = s.transformedInputs[i];
    const mask = s.request.operation === "edit" && i === s.request.inputs.length;
    if (t.originalChecksumSha256 !== ref.checksumSha256 || t.assetId !== ref.assetId
      || t.transform !== (mask ? capability.mask.polarity === "transparent-edit" ? "internal-white-to-transparent-mask-v1" : "internal-white-mask-v1" : "exif-srgb-png-v1")) throw new Error("生产确认输入转换不一致");
  }
  return e;
}
