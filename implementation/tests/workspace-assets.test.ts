import { randomUUID,createHash } from 'node:crypto';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { LocalWorkspaceDatabase } from '../apps/api/src/localWorkspaceDatabase.ts';
import { LocalWorkspaceAssets } from '../apps/api/src/localWorkspaceAssets.ts';
import { createRequire } from 'node:module';
const sharp=createRequire(new URL('../apps/api/package.json',import.meta.url))('sharp');
describe('TASK-06 本地私有资产适配器',()=>{
  let db:LocalWorkspaceDatabase,assets:LocalWorkspaceAssets,directory:string,bytes:Buffer;
  const project=randomUUID(),user=randomUUID(),outsider=randomUUID();
  beforeAll(async()=>{directory=mkdtempSync(join(tmpdir(),'workspace-files-'));db=await LocalWorkspaceDatabase.open(process.cwd());assets=new LocalWorkspaceAssets(db,directory);await db.seedProject(project,'图片',[{userId:user,role:'owner'}]);bytes=await sharp({create:{width:16,height:12,channels:4,background:'#3366cc'}}).png().toBuffer();});
  afterAll(async()=>{if(db)await db.close();if(directory)rmSync(directory,{recursive:true,force:true});});
  it('真实图片验证后登记ready，原字节下载和hash一致，越权读取拒绝',async()=>{
    const asset=await assets.upload(user,project,bytes,'image/png','产品.png');
    expect(asset).toMatchObject({state:'ready',width:16,height:12,sha256:createHash('sha256').update(bytes).digest('hex')});
    const result=await assets.download(user,project,asset.id);expect(result.bytes).toEqual(bytes);
    await expect(assets.download(outsider,project,asset.id)).rejects.toThrow('NOT_FOUND');
  });
  it('伪MIME、损坏内容、空文件和超限拒绝，不登记资产',async()=>{
    await expect(assets.upload(user,project,bytes,'text/html','fake.html')).rejects.toThrow('ASSET_TYPE_REJECTED');
    await expect(assets.upload(user,project,bytes.subarray(0,15),'image/png','truncated.png')).rejects.toThrow();
    await expect(assets.upload(user,project,Buffer.alloc(0),'image/png','empty.png')).rejects.toThrow('ASSET_SIZE_EXCEEDED');
    await expect(assets.upload(user,project,Buffer.alloc(8*1024*1024+1),'image/png','large.png')).rejects.toThrow('ASSET_SIZE_EXCEEDED');
    expect((await db.asActor(user,tx=>tx.query('SELECT * FROM workspace.asset_versions'))).rows).toHaveLength(1);
  });
  it('原文件被改动时不返回伪造内容，不把文件名当服务器路径',async()=>{
    const asset=await assets.upload(user,project,bytes,'image/png','../../original.png');
    writeFileSync(join(directory,project,`${asset.id}.bin`),Buffer.from('corrupt'));
    await expect(assets.download(user,project,asset.id)).rejects.toThrow('ASSET_INTEGRITY_FAILED');
  });
});
