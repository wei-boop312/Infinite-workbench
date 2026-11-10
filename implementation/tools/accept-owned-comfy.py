"""Zero-model CPU resize against an isolated ComfyUI process; no daily instance."""
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
import uuid
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PYTHON = Path('E:/AI/ComfyUI_windows_portable/python_embeded/python.exe')
MAIN = Path('E:/AI/ComfyUI_windows_portable/ComfyUI/main.py')
PORT = 18188
BASE = f'http://127.0.0.1:{PORT}'
def sha(value): return hashlib.sha256(value).hexdigest()
def http(path, body=None, mime='application/json'):
    request = urllib.request.Request(BASE+path, data=body, headers={'Content-Type':mime}, method='POST' if body is not None else 'GET')
    with urllib.request.urlopen(request, timeout=3) as response: return json.loads(response.read())

def main():
    if not PYTHON.is_file() or not MAIN.is_file(): raise RuntimeError('Configured read-only Comfy runtime missing')
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', PORT)) == 0: raise RuntimeError('Owned test port occupied; existing process preserved')
    case = ROOT/'work'/('owned-comfy-'+uuid.uuid4().hex)
    case.mkdir(parents=True)
    for name in ('input','output','user','temp','frontend','cache'): (case/name).mkdir()
    command = [str(PYTHON),'-B',str(MAIN),'--cpu','--listen','127.0.0.1','--port',str(PORT),
               '--disable-all-custom-nodes','--disable-api-nodes','--base-directory',str(case),
               '--user-directory',str(case/'user'),'--input-directory',str(case/'input'),
               '--output-directory',str(case/'output'),'--temp-directory',str(case/'temp'),'--front-end-root',str(case/'frontend')]
    env = {'SystemRoot':'C:/Windows','WINDIR':'C:/Windows','PATH':'C:/Windows/System32',
           'HF_HOME':str(case/'cache'),'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1',
           'USERNAME':'owned-workspace-test','USERPROFILE':str(case/'user'),
           'APPDATA':str(case/'cache'),'LOCALAPPDATA':str(case/'cache'),'TEMP':str(case/'temp'),'TMP':str(case/'temp')}
    output = ROOT/'docs/evidence/2026-11-09/owned-comfy'
    output.mkdir(parents=True, exist_ok=True)
    report = {'scope':'isolated-owned-CPU-no-model-not-daily', 'command':command,'submitted':False,'status':'starting'}
    child = None
    try:
        with (case/'stdout.log').open('xb') as out, (case/'stderr.log').open('xb') as err:
            child = subprocess.Popen(command, cwd=case, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                     creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        report['owned_pid'] = child.pid
        deadline=time.monotonic()+40
        while True:
            if child.poll() is not None: raise RuntimeError('Owned Comfy exited: '+(case/'stderr.log').read_text(errors='replace')[-1000:])
            try:
                stats=http('/system_stats');break
            except Exception:
                if time.monotonic()>deadline: raise RuntimeError('Owned Comfy readiness timeout')
                time.sleep(.25)
        fixture = io.BytesIO();Image.new('RGB',(16,12),(51,102,204)).save(fixture,format='PNG');source=fixture.getvalue()
        boundary='owned-'+uuid.uuid4().hex
        upload=(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="owned-source.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+source+f'\r\n--{boundary}--\r\n'.encode())
        uploaded=http('/upload/image',upload,'multipart/form-data; boundary='+boundary)
        filename=uploaded['name']
        registry={}
        for name in ('LoadImage','ImageScale','SaveImage'): registry.update(http('/object_info/'+name))
        sys.path.insert(0,str(ROOT/'vendor/workflow-architect'))
        from workflow_architect.service import ArchitectService
        service=ArchitectService();service.refresh(registry)
        compiled=service.compile({'spec':{'schema_version':'2.0','task':'image_resize',
            'inputs':{'person_image':False,'garment_image':False,'source_image':True},
            'output':{'width':256,'height':256,'format':'png'},'prompt':{'positive':'Preserve the source; resize only.','negative':''}},
            'input_overrides':{'source_image':filename},'installed_models':[],'allow_draft':False})
        if not compiled['validation']['valid'] or compiled['compiled'] is None: raise RuntimeError('Live registry compilation failed')
        prompt=compiled['compiled']['api_prompt']
        if sorted(n['class_type'] for n in prompt.values())!=['ImageScale','LoadImage','SaveImage']: raise RuntimeError('Unexpected executable classes')
        snapshot={'source_sha256':sha(source),'registry':registry,'ui_workflow':compiled['compiled']['ui_workflow'],
                  'api_prompt':prompt,'parameters':{'width':256,'height':256},'scope':'owned-cpu-no-model','expected_cost':'0-no-provider-request'}
        (output/'snapshot.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2),encoding='utf-8')
        report.update(status='submitting',attempt_id=str(uuid.uuid4()),source_sha256=sha(source))
        (output/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        # Exactly one POST. A lost submission reply is not automatically retried.
        receipt=http('/prompt',json.dumps({'prompt':prompt,'client_id':'owned-workspace-test'}).encode())
        report.update(submitted=True,prompt_id=receipt['prompt_id'],status='running')
        deadline=time.monotonic()+30;history=None
        while time.monotonic()<deadline:
            history=http('/history/'+receipt['prompt_id']).get(receipt['prompt_id'])
            if history:break
            time.sleep(.2)
        if not history or history.get('status',{}).get('status_str')!='success': raise RuntimeError('Owned resize did not finish successfully')
        files=[image for node in history.get('outputs',{}).values() for image in node.get('images',[])]
        if len(files)!=1:raise RuntimeError('Unexpected output count')
        image=files[0];path=(case/'output'/image.get('subfolder','')/image['filename']).resolve()
        if not path.is_relative_to((case/'output').resolve()):raise RuntimeError('Output escaped owned directory')
        raw=path.read_bytes()
        with Image.open(io.BytesIO(raw)) as result:
            result.load()
            if result.size!=(256,256) or set(result.convert('RGB').getdata())!={(51,102,204)}: raise RuntimeError('Dimensions or deterministic source pixels mismatch')
        (output/'result.png').write_bytes(raw)
        (output/'history.json').write_text(json.dumps(history,ensure_ascii=False,indent=2),encoding='utf-8')
        report.update(status='passed',width=256,height=256,output_sha256=sha(raw),source_unchanged=sha((case/'input'/filename).read_bytes())==sha(source),
                      models_loaded=False,provider_requests=0,case_directory=str(case))
    except Exception as error:
        report.update(status='failed',error=str(error)[:1500])
        raise
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:child.wait(timeout=10)
            except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
        report['owned_process_stopped']=child is not None and child.poll() is not None
        (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))

if __name__=='__main__':main()
