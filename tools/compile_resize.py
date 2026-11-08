"""Offline adapter to the retained compiler. Never uploads, queues or executes."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "workflow-architect"))
from workflow_architect.service import ArchitectService


def compile_resize(payload):
    if not isinstance(payload, dict) or set(payload) != {"parameters", "asset_version_id", "asset_sha256", "snapshot_hash", "source_image"}:
        raise ValueError("Invalid adapter request")
    params = payload["parameters"]
    if not isinstance(params, dict) or set(params) != {"width", "height"}:
        raise ValueError("Invalid parameters")
    w, h = params["width"], params["height"]
    if any(type(v) is not int or not 64 <= v <= 8192 for v in (w, h)) or w*h > 16_000_000:
        raise ValueError("Invalid dimensions")
    for key in ("asset_sha256", "snapshot_hash"):
        v = payload[key]
        if not isinstance(v, str) or len(v) != 64 or any(c not in "0123456789abcdef" for c in v):
            raise ValueError("Invalid hash")
    # This proof uses an archived registry and an explicit fixture mapping.
    # Live upload and environment validation are separate TASK-14 work.
    registry_path = ROOT / "tests" / "fixtures" / "comfy" / "object-info-recorded.json"
    registry_bytes = registry_path.read_bytes()
    registry = json.loads(registry_bytes)
    choices = registry["LoadImage"]["input"]["required"]["image"][0]
    if payload["source_image"] != "owned-probe.png" or payload["source_image"] not in choices:
        raise ValueError("Source must match the explicit fixture mapping")
    service = ArchitectService()
    service.refresh(registry)
    result = service.compile({
        "spec": {"schema_version": "2.0", "task": "image_resize",
                 "inputs": {"person_image": False, "garment_image": False, "source_image": True},
                 "output": {"width": w, "height": h, "format": "png"},
                 "prompt": {"positive": "Preserve the source; resize only.", "negative": ""}},
        "input_overrides": {"source_image": payload["source_image"]},
        "installed_models": [], "allow_draft": False,
    })
    if not result["validation"]["valid"] or result["compiled"] is None or result["compiled"]["draft"]:
        raise ValueError("Retained compiler rejected the graph")
    return {"compiled": result["compiled"], "validation": result["validation"],
            "provenance": {"generator_version": "2.15.2", "registry_kind": "recorded-fixture-not-live",
                           "registry_sha256": hashlib.sha256(registry_bytes).hexdigest(),
                           "compiler_sha256": hashlib.sha256((ROOT / "vendor/workflow-architect/workflow_architect/compiler.py").read_bytes()).hexdigest(),
                           "asset_version_id": payload["asset_version_id"], "asset_sha256": payload["asset_sha256"],
                           "snapshot_hash": payload["snapshot_hash"]},
            "execution_authorized": False, "submitted": False}


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError("Adapter request too large")
        output = compile_resize(json.loads(raw))
        sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    except Exception as exc:
        sys.stderr.write(type(exc).__name__ + ": " + str(exc)[:300])
        sys.exit(1)
