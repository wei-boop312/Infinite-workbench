import {WorkspaceParametersSchema} from '@canvas/contracts';

function keys(value:unknown,expected:string[]):asserts value is Record<string,any>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('\0')!==[...expected].sort().join('\0'))throw Error('RESIZE_PROMPT_REJECTED');
}
/** Validate the actual outbound graph, not just the compiler's success flag. */
export function validateResizePrompt(raw:unknown,parameters:unknown,uploadedFilename:string){
  const size=WorkspaceParametersSchema.parse(parameters);
  if(!/^[A-Za-z0-9_-]{1,128}\.(png|jpg|jpeg|webp)$/.test(uploadedFilename))throw Error('RESIZE_SOURCE_NAME_REJECTED');
  keys(raw,['1','2','3']);
  const expected=['LoadImage','ImageScale','SaveImage'];
  for(let i=1;i<=3;i++){
    const node=raw[String(i)];keys(node,['class_type','inputs','_meta']);keys(node._meta,['title']);
    if(node.class_type!==expected[i-1]||typeof node._meta.title!=='string'||node._meta.title.length>240)throw Error('RESIZE_PROMPT_REJECTED');
  }
  const load=raw['1'].inputs,scale=raw['2'].inputs,save=raw['3'].inputs;
  keys(load,['image']);keys(scale,['image','upscale_method','width','height','crop']);keys(save,['images','filename_prefix']);
  const link=(value:unknown,id:string)=>Array.isArray(value)&&value.length===2&&value[0]===id&&value[1]===0;
  if(load.image!==uploadedFilename||!link(scale.image,'1')||scale.upscale_method!=='lanczos'||scale.width!==size.width||scale.height!==size.height||scale.crop!=='disabled'||!link(save.images,'2')||save.filename_prefix!=='workflow_architect/resize')throw Error('RESIZE_PROMPT_REJECTED');
  // Return a detached graph so a caller cannot change the checked input object.
  return structuredClone(raw);
}
