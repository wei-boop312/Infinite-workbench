import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {validateResizePrompt} from '../apps/worker/src/validateResizePrompt';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const fixture=()=>JSON.parse(readFileSync('docs/evidence/2026-11-09/owned-comfy/snapshot.json','utf8')).api_prompt;
const parameters={width:256,height:256};
it('保留编译器实际三节点图可通过，返回图不受输入后续修改影响',()=>{
  const input=fixture(),checked=validateResizePrompt(input,parameters,'owned-source.png');
  input['2'].inputs.width=512;expect(checked['2'].inputs.width).toBe(256);
});
it('拒绝额外执行节点、模型类、路径、参数漂移、旁路及输出前缀注入',()=>{
  const changes=[(p:any)=>p['4']=p['3'],(p:any)=>p['1'].class_type='CheckpointLoaderSimple',
    (p:any)=>p['1'].inputs.image='../secret.png',(p:any)=>p['2'].inputs.width=512,
    (p:any)=>p['3'].inputs.images=['1',0],(p:any)=>p['3'].inputs.filename_prefix='../escape',
    (p:any)=>p['2'].inputs.extra=true];
  for(const change of changes){const input=fixture();change(input);expect(()=>validateResizePrompt(input,parameters,'owned-source.png')).toThrow('RESIZE_PROMPT_REJECTED');}
  expect(()=>validateResizePrompt(fixture(),parameters,'../secret.png')).toThrow('RESIZE_SOURCE_NAME_REJECTED');
});
it('实时registry编译入口使用归档自有实例清单验证；只编译、不连网或提交',()=>{
  const snapshot=JSON.parse(readFileSync('docs/evidence/2026-11-09/owned-comfy/snapshot.json','utf8'));
  const compile=(registry:unknown)=>spawnSync(process.env.WORKSPACE_PYTHON??'D:/python/python.exe',['-B',resolve('tools/compile_live_resize.py')],{input:JSON.stringify({registry,parameters,source_image:'owned-source.png'}),encoding:'utf8',windowsHide:true,timeout:10_000,maxBuffer:2*1024*1024});
  const result=compile(snapshot.registry);expect(result.status,result.stderr).toBe(0);
  expect(validateResizePrompt(JSON.parse(result.stdout),parameters,'owned-source.png')).toEqual(snapshot.api_prompt);
  const rejected=compile({...snapshot.registry,CheckpointLoaderSimple:{}});expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain('Invalid owned registry');
});
