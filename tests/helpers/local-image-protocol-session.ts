import { createHash } from "node:crypto";
import type { ImageExecutionRequest } from "../../packages/contracts/src/index";
import {
  parseOpenAiImageResponse, unknownImageResponse,
  type ImageProtocolResponse, type ParsedImageProtocolResponse, type PreparedImageProtocolRequest,
} from "../../apps/api/src/openaiImageProtocol";

// TEST-ONLY, in-memory transport. This is not the durable worker/idempotency layer.
export class LocalImageProtocolSession<TPrepared extends Pick<PreparedImageProtocolRequest, "body" | "requestFingerprint" | "payloadChecksumSha256"> = PreparedImageProtocolRequest> {
  private readonly entries = new Map<string, { fingerprint: string; payloadHash: string; result: Promise<ParsedImageProtocolResponse> }>();
  constructor(private readonly fixture: (prepared: TPrepared, signal: AbortSignal) => Promise<ImageProtocolResponse>, private readonly timeoutMs = 50) {}

  run(request: ImageExecutionRequest, prepared: TPrepared): Promise<ParsedImageProtocolResponse> {
    if (createHash("sha256").update(prepared.body).digest("hex") !== prepared.payloadChecksumSha256) throw new Error("fixture_payload_changed");
    const key = JSON.stringify([request.tenantId, request.projectId, request.jobId, request.idempotencyKey]);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== prepared.requestFingerprint || existing.payloadHash !== prepared.payloadChecksumSha256) throw new Error("fixture_confirmation_changed");
      return existing.result;
    }
    const controller = new AbortController();
    const result = new Promise<ParsedImageProtocolResponse>((resolve) => {
      const timer = setTimeout(() => {
        controller.abort(); resolve(unknownImageResponse(request, prepared.requestFingerprint, "image_response_timeout"));
      }, this.timeoutMs);
      Promise.resolve().then(() => this.fixture(prepared, controller.signal)).then(
        (response) => { clearTimeout(timer); if (!controller.signal.aborted) resolve(parseOpenAiImageResponse(request, prepared.requestFingerprint, response)); },
        () => { clearTimeout(timer); resolve(unknownImageResponse(request, prepared.requestFingerprint, "image_transport_uncertain")); },
      ).catch(() => { clearTimeout(timer); resolve(unknownImageResponse(request, prepared.requestFingerprint, "image_response_unparseable")); });
    });
    this.entries.set(key, { fingerprint: prepared.requestFingerprint, payloadHash: prepared.payloadChecksumSha256, result });
    return result;
  }
}
