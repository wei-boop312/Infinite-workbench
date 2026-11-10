import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {imageSnapshotFingerprint} from '../apps/api/src/imageProviderContract';
function legacy(value:any):string{
  if(Array.isArray(value))return `[${value.map(legacy).join(',')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>`${JSON.stringify(key)}:${legacy(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
it('保留既有快照hash字节规则，包含数字键、字节映射、Unicode及空值',()=>{
  const samples=[null,true,-0,NaN,{z:undefined,a:[undefined,,null],n:{'10':1,'2':2}},Buffer.from([0,128,255]),new Uint8Array(1024).fill(7),{'中':'文',quote:'"\n',a:{z:2,a:1}}];
  for(const sample of samples)expect(imageSnapshotFingerprint(sample)).toBe(createHash('sha256').update(legacy(sample)).digest('hex'));
});
it('同一对象修改后重新计算，不能复用旧权限/内容指纹',()=>{
  const sample={actor:'writer',bytes:{0:12,1:30}},before=imageSnapshotFingerprint(sample);
  sample.actor='revoked';expect(imageSnapshotFingerprint(sample)).not.toBe(before);
  const changed=imageSnapshotFingerprint(sample);sample.bytes[1]=31;expect(imageSnapshotFingerprint(sample)).not.toBe(changed);
});
