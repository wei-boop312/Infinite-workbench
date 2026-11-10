"""Compile only against the worker-owned live three-class registry. No HTTP."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'vendor/workflow-architect'))
from workflow_architect.service import ArchitectService

def main(payload):
    if not isinstance(payload, dict) or set(payload) != {'registry', 'parameters', 'source_image'}:
        raise ValueError('Invalid compile request')
    registry, parameters, filename = payload['registry'], payload['parameters'], payload['source_image']
    if not isinstance(registry, dict) or set(registry) != {'LoadImage', 'ImageScale', 'SaveImage'}:
        raise ValueError('Invalid owned registry')
    if not isinstance(parameters, dict) or set(parameters) != {'width', 'height'}:
        raise ValueError('Invalid parameters')
    width, height = parameters['width'], parameters['height']
    if any(type(v) is not int or not 64 <= v <= 8192 for v in (width, height)) or width * height > 16_000_000:
        raise ValueError('Invalid dimensions')
    if not isinstance(filename, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}\.(png|jpg|jpeg|webp)', filename):
        raise ValueError('Invalid source filename')
    service = ArchitectService()
    service.refresh(registry)
    result = service.compile({'spec': {'schema_version': '2.0', 'task': 'image_resize',
        'inputs': {'person_image': False, 'garment_image': False, 'source_image': True},
        'output': {'width': width, 'height': height, 'format': 'png'},
        'prompt': {'positive': 'Preserve the source; resize only.', 'negative': ''}},
        'input_overrides': {'source_image': filename}, 'installed_models': [], 'allow_draft': False})
    if not result['validation']['valid'] or not result['compiled'] or result['compiled']['draft']:
        raise ValueError('Live registry compilation rejected')
    return result['compiled']['api_prompt']

if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError('Compile request too large')
        sys.stdout.write(json.dumps(main(json.loads(raw)), ensure_ascii=False, separators=(',', ':')))
    except Exception as error:
        sys.stderr.write(type(error).__name__ + ': ' + str(error)[:300])
        sys.exit(1)
