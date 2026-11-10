import {contentHash} from './workspacePrototype.ts';
export function matchesOwnedOutputHistory(history:unknown,providerId:string,prompt:unknown){
  const h=history as Record<string,any>;
  if(!h||!Array.isArray(h.prompt)||h.prompt[1]!==providerId||!h.prompt[2]||!prompt||contentHash(h.prompt[2])!==contentHash(prompt)||!h.outputs||Object.keys(h.outputs).join(',')!=='3'||!Array.isArray(h.outputs['3']?.images)||h.outputs['3'].images.length!==1)return false;
  const image=h.outputs['3'].images[0];
  return image?.type==='output'&&image.subfolder==='workflow_architect'&&typeof image.filename==='string'&&/^[A-Za-z0-9_-]+\.png$/.test(image.filename)&&
    (h.status?.status_str==='success'||(h.status?.status_str==='error'&&Array.isArray(h.status.messages)&&h.status.messages.some((event:unknown)=>Array.isArray(event)&&event[0]==='execution_interrupted'&&event[1]?.prompt_id===providerId)));
}
