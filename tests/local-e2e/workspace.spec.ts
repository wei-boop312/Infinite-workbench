import { test,expect,type Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {randomUUID} from 'node:crypto';
import { LocalWorkspaceDatabase } from '../../apps/api/src/localWorkspaceDatabase.ts';
import { createLocalWorkspaceHttp } from '../../apps/api/src/localWorkspaceHttp.ts';
import { LocalWorkspaceAssets } from '../../apps/api/src/localWorkspaceAssets.ts';
let db:LocalWorkspaceDatabase,server:Server,origin='',directory='';
test.beforeAll(async()=>{
  db=await LocalWorkspaceDatabase.open(process.cwd());
  directory=mkdtempSync(join(tmpdir(),'workspace-browser-assets-'));
  const assets=new LocalWorkspaceAssets(db,directory);
  server=createLocalWorkspaceHttp(db,{origin:()=>origin,clientFile:resolve('apps/web/local-workspace.html'),assets,compilerSourceSha256:'b'.repeat(64)});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const a=server.address();if(!a||typeof a==='string')throw Error('NO_ADDRESS');origin=`http://127.0.0.1:${a.port}`;
});
test.afterAll(async()=>{if(server){server.emit('workspace-shutdown');await new Promise<void>(done=>server.close(()=>done()));}if(db)await db.close();if(directory)rmSync(directory,{recursive:true,force:true});});
async function editorProject(page:Page,name:string){
  await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill('preview_owner');await page.getByLabel('密码',{exact:true}).fill('owned-browser-password-very-long-2026');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByLabel('新项目名称').fill(name);await page.getByRole('button',{name:'创建项目',exact:true}).click();await expect(page.locator('#current')).toHaveText(name);
}

test('首个真实账号→登录态→项目→文字卡拖动编辑→刷新恢复→注销',async({page})=>{
  await page.goto(origin);await expect(page.getByRole('heading',{name:'创建本机账号'})).toBeVisible();
  await page.getByLabel('用户名',{exact:true}).fill('preview_owner');await page.getByLabel('密码',{exact:true}).fill('owned-browser-password-very-long-2026');
  await page.getByRole('button',{name:'创建账号并进入'}).click();await expect(page.getByText('我的项目',{exact:true})).toBeVisible();
  await page.getByLabel('新项目名称').fill('本地产品项目');await page.getByRole('button',{name:'创建项目',exact:true}).click();
  await expect(page.locator('#current')).toHaveText('本地产品项目');await page.getByRole('button',{name:'添加文字卡'}).click();
  const card=page.getByLabel('卡片内容');await card.fill('由人确认：接口数量和外观不得猜测');await page.locator('#current').click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const handle=page.locator('.handle');const box=await handle.boundingBox();if(!box)throw Error('NO_CARD');
  await page.mouse.move(box.x+30,box.y+10);await page.mouse.down();await page.mouse.move(box.x+120,box.y+80,{steps:5});await page.mouse.up();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');const left=await page.locator('.card').evaluate(e=>(e as HTMLElement).style.left);
  await page.reload();await expect(page.getByLabel('卡片内容')).toHaveValue('由人确认：接口数量和外观不得猜测');
  expect(await page.locator('.card').evaluate(e=>(e as HTMLElement).style.left)).toBe(left);
  await page.screenshot({path:'docs/evidence/2026-11-10/local-workspace.png',fullPage:true});
  await page.getByRole('button',{name:'退出登录'}).click();await expect(page.getByRole('heading',{name:'登录工作台'})).toBeVisible();
  await page.getByLabel('用户名',{exact:true}).fill('preview_owner');await page.getByLabel('密码',{exact:true}).fill('owned-browser-password-very-long-2026');
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByLabel('卡片内容')).toHaveValue('由人确认：接口数量和外观不得猜测');
  const sharp=createRequire(new URL('../../apps/api/package.json',import.meta.url))('sharp');
  const png=await sharp({create:{width:16,height:12,channels:4,background:'#3366cc'}}).png().toBuffer();
  await page.getByLabel('选择产品图片').setInputFiles({name:'owned-product.png',mimeType:'image/png',buffer:png});
  const image=page.getByRole('img',{name:'owned-product.png'});await expect(image).toBeVisible();await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const originalUrl=await image.getAttribute('src');await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(image).toHaveCount(0);if(!originalUrl)throw Error('NO_ORIGINAL_URL');expect(await (await page.request.get(origin+originalUrl)).body()).toEqual(png);await page.getByRole('button',{name:'重做',exact:true}).click();await expect(image).toBeVisible();
  await page.reload();await expect(page.getByRole('img',{name:'owned-product.png'})).toBeVisible();
  const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'下载原件'}).click();const download=await downloadPromise;
  const path=await download.path();if(!path)throw Error('NO_DOWNLOAD');expect(readFileSync(path)).toEqual(png);
  await page.screenshot({path:'docs/evidence/2026-11-10/local-workspace-with-image.png',fullPage:true});
  await page.getByRole('button',{name:'添加缩放工具'}).click();
  const form=page.locator('[data-tool-form]');await expect(form).toHaveCount(1);
  await expect(form.getByRole('button',{name:'提交缩放任务'})).toBeDisabled();
  await form.getByLabel('工具输入图片').selectOption({label:'owned-product.png'});
  await form.getByRole('button',{name:'固定输入',exact:true}).click();await expect(form.getByRole('status')).toContainText('已固定图片修订');
  await form.getByRole('button',{name:'提交缩放任务'}).click();await expect(form.getByRole('status')).toHaveText('已入队，尚未执行');
  await expect(form.getByRole('button',{name:'提交缩放任务'})).toBeDisabled();
  await page.reload();const restored=page.locator('[data-tool-form]');await expect(restored.getByRole('status')).toHaveText('已入队，尚未执行');
  const user=(await(await page.request.get(origin+'/v1/me')).json()).data.user.id;
  expect((await db.asActor(user,tx=>tx.query('SELECT * FROM workspace.runs'))).rows).toHaveLength(1);
  await page.screenshot({path:'docs/evidence/2026-11-10/tool-card-queued.png',fullPage:true});
  await restored.getByRole('button',{name:'取消任务',exact:true}).click();await expect(restored.getByRole('status')).toHaveText('已取消');
  await page.reload();await expect(page.locator('[data-tool-form]').getByRole('status')).toHaveText('已取消');
  expect((await db.asActor(user,tx=>tx.query<{state:string}>('SELECT state FROM workspace.runs'))).rows[0].state).toBe('cancelled');
  await page.screenshot({path:'docs/evidence/2026-11-10/tool-card-cancelled.png',fullPage:true});
  await page.getByRole('button',{name:'任务与用量',exact:true}).click();const history=page.getByRole('dialog',{name:'任务与用量'});
  await expect(history.locator('.task-row')).toHaveCount(1);await history.locator('.task-row').click();
  await expect(history.locator('#history-state')).toHaveText('已取消');await expect(history.getByRole('log')).toContainText('已取消');
  await expect(history.locator('#history-stream')).toHaveText('执行日志已连接');await expect(history.locator('#history-usage')).toContainText('本地CPU缩放无供应商费用');
  await page.screenshot({path:'docs/evidence/2026-11-10/task-history-cancelled.png',fullPage:true});await history.getByRole('button',{name:'关闭',exact:true}).click();
});
test('滚动升级时运行配置接口尚未提供，仍能登录并打开已有项目',async({page})=>{
  await page.route('**/v1/runtime',route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:{code:'NOT_FOUND'}})}));
  await page.goto(origin);await expect(page.getByRole('heading',{name:'登录工作台'})).toBeVisible();
  await page.getByLabel('用户名',{exact:true}).fill('preview_owner');await page.getByLabel('密码',{exact:true}).fill('owned-browser-password-very-long-2026');
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByText('我的项目',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'本地产品项目',exact:true}).click();await expect(page.getByLabel('卡片内容')).toHaveValue('由人确认：接口数量和外观不得猜测');
  await expect(page.locator('.hint')).toContainText('缩放执行尚未配置');
});


test('创建撤销与重做持久保存；连续22次编辑精确撤销20步且重开保留结果',async({page})=>{
  await editorProject(page,'20步历史-'+randomUUID().slice(0,8));
  await page.getByRole('button',{name:'添加文字卡'}).click();await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(page.locator('.card')).toHaveCount(0);await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button',{name:'重做',exact:true}).click();await expect(page.getByLabel('卡片内容')).toHaveCount(1);
  for(let index=1;index<=22;index++){await page.getByLabel('卡片内容').fill('事实 '+index);await page.locator('#current').click();await expect(page.getByRole('status')).toHaveText('已保存到本机');}
  for(let index=0;index<20;index++){await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(page.getByRole('status')).toHaveText('已保存到本机');}
  await expect(page.getByLabel('卡片内容')).toHaveValue('事实 2');await expect(page.getByRole('button',{name:'撤销',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'重做',exact:true}).click();await expect(page.getByLabel('卡片内容')).toHaveValue('事实 3');await page.locator('#current').click();await page.keyboard.press('Control+z');await expect(page.getByLabel('卡片内容')).toHaveValue('事实 2');await page.keyboard.press('Control+Shift+z');await expect(page.getByLabel('卡片内容')).toHaveValue('事实 3');
  await page.getByLabel('卡片内容').fill('新分支事实');await page.locator('#current').click();await expect(page.getByRole('status')).toHaveText('已保存到本机');await expect(page.getByRole('button',{name:'重做',exact:true})).toBeDisabled();
  await page.screenshot({path:'docs/evidence/2026-11-10/canvas-20-step-history.png',fullPage:true});
  await page.reload();await expect(page.getByLabel('卡片内容')).toHaveValue('新分支事实');await expect(page.getByRole('button',{name:'撤销',exact:true})).toBeDisabled();
});
test('保存回复丢失保留固定操作，用户重试只提交一次修订并可撤销，viewer无法软删',async({page})=>{
  await editorProject(page,'响应丢失-'+randomUUID().slice(0,8));let lost=false,operation:any;
  await page.route('**/canvas-operations',async route=>{if(!lost){lost=true;operation=route.request().postDataJSON();const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort('failed');}else await route.continue();});
  await page.getByRole('button',{name:'添加文字卡'}).click();await expect(page.getByRole('status')).toContainText('未保存：');
  await expect(page.locator('#scene')).toHaveAttribute('inert','');await expect(page.getByRole('button',{name:'添加文字卡'})).toBeDisabled();
  await expect(page.getByRole('button',{name:'下载未保存内容'})).toBeVisible();const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'下载未保存内容'}).click();const downloaded=await downloadPromise,downloadPath=await downloaded.path();if(!downloadPath)throw Error('NO_UNSAVED_EXPORT');const recovered=readFileSync(downloadPath,'utf8');expect(recovered).toContain('unsaved-local-canvas-recovery');expect(recovered).not.toContain(operation.lease.token);await page.getByRole('button',{name:'重试保存',exact:true}).click();await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const actor=(await(await page.request.get(origin+'/v1/me')).json()).data.user.id;
  expect((await db.asActor(actor,tx=>tx.query('SELECT revision FROM workspace.object_revisions WHERE project_id=$1 AND object_id=$2',[operation.objects[0].projectId,operation.objects[0].id]))).rows).toEqual([{revision:1}]);
  await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(page.locator('.card')).toHaveCount(0);await page.reload();await expect(page.locator('.card')).toHaveCount(0);
  const admin=(db as unknown as {db:{query:(sql:string,args:unknown[])=>Promise<unknown>}}).db;
  await admin.query("UPDATE workspace.project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[operation.objects[0].projectId,actor]);
  try{expect((await page.request.post(origin+`/v1/projects/${operation.objects[0].projectId}/canvas-operations`,{headers:{origin,'x-workspace-local':'1'},data:{...operation,id:randomUUID()}})).status()).toBe(403);}
  finally{await admin.query("UPDATE workspace.project_members SET role='owner' WHERE project_id=$1 AND user_id=$2",[operation.objects[0].projectId,actor]);}
});
