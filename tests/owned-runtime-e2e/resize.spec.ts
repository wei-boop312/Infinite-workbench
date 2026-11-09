import {test,expect} from '@playwright/test';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import type {Server} from 'node:http';
import {LocalWorkspaceDatabase} from '../../apps/api/src/localWorkspaceDatabase';
import {LocalWorkspaceAssets} from '../../apps/api/src/localWorkspaceAssets';
import {createLocalWorkspaceHttp} from '../../apps/api/src/localWorkspaceHttp';
import {LocalRunExecution} from '../../apps/api/src/localRunExecution';
import {LocalRunDispatcher} from '../../apps/worker/src/localRunDispatcher';
import {LocalResizeWorker} from '../../apps/worker/src/localResizeWorker';
import {OwnedComfyRuntime} from '../../apps/worker/src/ownedComfyRuntime';
import {recordedCompilerPin} from '../../apps/worker/src/compileResize';
import {LocalArchiveRecovery} from '../../apps/api/src/localArchiveRecovery';
import {LocalRunArtifactStore} from '../../apps/api/src/localRunArtifactStore';
let db:LocalWorkspaceDatabase,server:Server,dispatcher:LocalRunDispatcher,origin='';
const runtimes:OwnedComfyRuntime[]=[],errors:unknown[]=[];
const archiveFailure=process.env.WORKSPACE_ACCEPT_ARCHIVE_FAILURE==='1',unplacedKind=process.env.WORKSPACE_ACCEPT_UNPLACED??'';
if(unplacedKind&&!['source','tool'].includes(unplacedKind))throw Error('INVALID_OWNED_UNPLACED_MODE');if(unplacedKind&&archiveFailure)throw Error('INCOMPATIBLE_OWNED_MODES');
let releaseUnplacedResult:()=>void;const unplacedGate=new Promise<void>(done=>{releaseUnplacedResult=done;});
const caseId=randomUUID(),evidence=resolve('docs/evidence/2026-11-10/owned-browser',caseId);
test.beforeAll(async()=>{
  mkdirSync(evidence,{recursive:true});db=await LocalWorkspaceDatabase.open(process.cwd());
  const assets=new LocalWorkspaceAssets(db,resolve('work','owned-browser-'+caseId)),pin=recordedCompilerPin(process.cwd()).sourceTreeSha256;
  if(!process.env.WORKSPACE_COMFY_PYTHON||!process.env.WORKSPACE_COMFY_MAIN)throw Error('EXPLICIT_OWNED_RUNTIME_REQUIRED');
  const artifacts=new LocalRunArtifactStore(resolve('work','owned-browser-artifacts-'+caseId));
  if(archiveFailure){const original=assets.upload.bind(assets);let failed=false;assets.upload=async(...args)=>{if(!failed&&String(args[4]).startsWith('resize-')){failed=true;throw Error('owned-browser-archive-storage-failure');}return original(...args);};}
  dispatcher=new LocalRunDispatcher(db,()=>{const Runtime=unplacedKind?class extends OwnedComfyRuntime{async result(...args:Parameters<OwnedComfyRuntime['result']>){await unplacedGate;return super.result(...args);}}:OwnedComfyRuntime;const runtime=new Runtime({root:process.cwd(),pythonExecutable:process.env.WORKSPACE_COMFY_PYTHON!,comfyMain:process.env.WORKSPACE_COMFY_MAIN!,compilerSourceSha256:pin});runtimes.push(runtime);return new LocalResizeWorker(new LocalRunExecution(db,pin),assets,runtime,artifacts);},error=>errors.push(String(error)));
  server=createLocalWorkspaceHttp(db,{origin:()=>origin,assets,compilerSourceSha256:pin,clientFile:resolve('apps/web/local-workspace.html'),archiveRecovery:new LocalArchiveRecovery(new LocalRunExecution(db,pin),artifacts,assets),onRunQueued:()=>dispatcher.wake()});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('NO_ADDRESS');origin=`http://127.0.0.1:${address.port}`;dispatcher.start();
});
test.afterAll(async()=>{releaseUnplacedResult();if(server){server.emit('workspace-shutdown');await new Promise<void>(done=>server.close(()=>done()));}if(dispatcher)await dispatcher.close();for(const runtime of runtimes)await runtime.close();if(db)await db.close();writeFileSync(resolve(evidence,'runtime-report.json'),JSON.stringify({caseId,errors,runtimes:runtimes.map(r=>r.evidence)},null,2));});
test('真实本地登录→上传→工具卡固定输入→持久队列→CPU缩放→画布回填下载→刷新不重投',async({page})=>{
  await page.goto(origin);await page.getByLabel('用户名',{exact:true}).fill('owned_browser');await page.getByLabel('密码',{exact:true}).fill('owned-browser-password-never-production');await page.getByRole('button',{name:'创建账号并进入'}).click();
  await page.getByLabel('新项目名称').fill('自有图片 CPU 闭环');await page.getByRole('button',{name:'创建项目',exact:true}).click();
  await page.getByRole('button',{name:'添加文字卡'}).click();await page.getByLabel('卡片内容').fill('人工确认：保持原产品事实');await page.locator('#current').click();await expect(page.getByRole('status').first()).toHaveText('已保存到本机');
  const sharp=createRequire(new URL('../../apps/api/package.json',import.meta.url))('sharp');
  const source=await sharp({create:{width:16,height:12,channels:3,background:'#3366cc'}}).png().toBuffer();
  await page.getByLabel('选择产品图片').setInputFiles({name:'owned-product.png',mimeType:'image/png',buffer:source});await expect(page.getByRole('status').first()).toHaveText('已保存到本机');
  await page.getByRole('button',{name:'添加缩放工具'}).click();const form=page.locator('[data-tool-form]');
  await form.getByLabel('工具输入图片').selectOption({label:'owned-product.png'});await form.getByRole('button',{name:'固定输入',exact:true}).click();
  await expect(form.getByRole('status')).toContainText('已固定图片修订');await form.getByRole('button',{name:'提交缩放任务'}).click();
  if(unplacedKind){await acceptUnplacedThroughUI(page);return;}
  if(archiveFailure){
    await expect(form.getByRole('status')).toHaveText('执行结果待核查；未自动重试',{timeout:60_000});
    await page.reload();await page.getByRole('button',{name:'任务与用量',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'任务与用量'});await dialog.locator('.task-row').click();
    await expect(dialog.getByRole('button',{name:'恢复归档（不重新生成）'})).toBeVisible();
    await page.screenshot({path:resolve(evidence,'archive-recovery-needed.png'),fullPage:true});
    const actor=(await(await page.request.get(origin+'/v1/me')).json()).data.user.id;
    const row=(await db.asActor(actor,tx=>tx.query<{project_id:string;id:string}>('SELECT project_id,id FROM workspace.runs'))).rows[0];
    const path=`/v1/projects/${row.project_id}/runs/${row.id}/recover-archive`;
    expect((await page.request.post(origin+path,{headers:{origin,'x-workspace-local':'1'},data:{actorId:actor,artifactId:'injected'}})).status()).toBe(422);
    expect((await page.request.post(origin+path,{headers:{origin:'https://outside.example','x-workspace-local':'1'},data:{}})).status()).toBe(403);
    const admin=(db as unknown as {db:{query:(sql:string,args:unknown[])=>Promise<unknown>}}).db;
    await admin.query("UPDATE workspace.project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[row.project_id,actor]);
    expect((await page.request.post(origin+path,{headers:{origin,'x-workspace-local':'1'},data:{}})).status()).toBe(403);
    await admin.query("UPDATE workspace.project_members SET role='owner' WHERE project_id=$1 AND user_id=$2",[row.project_id,actor]);
    await dialog.getByRole('button',{name:'恢复归档（不重新生成）'}).click();
    await expect(dialog.locator('#history-state')).toHaveText('已完成，结果已归档');await expect(dialog.locator('.task-row')).toContainText('已完成，结果已归档');
    await expect(dialog.getByRole('button',{name:'恢复归档（不重新生成）'})).toBeHidden();
    expect((await(await page.request.post(origin+path,{headers:{origin,'x-workspace-local':'1'},data:{}})).json()).data.reused).toBe(true);
    await expect(dialog.getByRole('log')).toContainText('开始恢复归档');
    await page.screenshot({path:resolve(evidence,'archive-recovered.png'),fullPage:true});
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.reload();
  }
  await expect(form.getByRole('status')).toHaveText('已完成，结果已归档',{timeout:60_000});
  // The page still holds its pre-output canvas revision. A result append may
  // rebase this independent edit; an intervening editor write still may not.
  await page.getByLabel('卡片内容').fill('结果返回后补充的人工事实');await page.locator('#current').click();await expect(page.getByRole('status').first()).toHaveText('已保存到本机');
  await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(page.getByLabel('卡片内容')).toHaveValue('人工确认：保持原产品事实');
  const editActor=(await(await page.request.get(origin+'/v1/me')).json()).data.user.id;expect((await db.asActor(editActor,tx=>tx.query('SELECT * FROM workspace.run_outputs'))).rows).toHaveLength(1);
  await page.getByRole('button',{name:'重做',exact:true}).click();await expect(page.getByLabel('卡片内容')).toHaveValue('结果返回后补充的人工事实');
  await page.screenshot({path:resolve(evidence,'tool-completed.png'),fullPage:true});
  const waiting=page.waitForEvent('download');await form.getByRole('link',{name:'下载缩放结果'}).click();const download=await waiting,path=await download.path();if(!path)throw Error('NO_DOWNLOAD');
  const bytes=readFileSync(path),decoded=await sharp(bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
  expect(decoded.info).toMatchObject({width:256,height:256,channels:3});expect(decoded.data.every((value:number,index:number)=>value===[51,102,204][index%3])).toBe(true);writeFileSync(resolve(evidence,'result.png'),bytes);
  await form.getByRole('button',{name:'查看画布结果'}).click();await expect(page.getByRole('img',{name:'缩放结果',exact:true})).toBeVisible();await page.screenshot({path:resolve(evidence,'result-on-canvas.png'),fullPage:true});
  await page.reload();await expect(page.locator('[data-tool-form]').getByRole('status')).toHaveText('已完成，结果已归档');
  await expect(page.getByLabel('卡片内容')).toHaveValue('结果返回后补充的人工事实');
  const actor=(await(await page.request.get(origin+'/v1/me')).json()).data.user.id;
  const runs=(await db.asActor(actor,tx=>tx.query('SELECT id,state FROM workspace.runs'))).rows;expect(runs).toHaveLength(1);expect(runs[0].state).toBe('succeeded');
  const outputs=(await db.asActor(actor,tx=>tx.query('SELECT * FROM workspace.run_outputs'))).rows;expect(outputs).toHaveLength(1);
  const preparation=(await db.asActor(actor,tx=>tx.query<{payload:{runtimeKind:string;coreFiles:unknown[]};content_hash:string}>('SELECT payload,content_hash FROM workspace.run_preparations'))).rows;expect(preparation).toHaveLength(1);expect(preparation[0].payload.runtimeKind).toBe('owned-cpu-comfy');expect(preparation[0].payload.coreFiles).toHaveLength(5);
  const artifact=(await db.asActor(actor,tx=>tx.query<{manifest:{runtimeEvidenceHash:string};manifest_hash:string}>('SELECT manifest,manifest_hash FROM workspace.run_artifacts'))).rows;expect(artifact).toHaveLength(1);expect(artifact[0].manifest.runtimeEvidenceHash).toBe(preparation[0].content_hash);
  writeFileSync(resolve(evidence,'runtime-evidence.json'),JSON.stringify(preparation[0],null,2));writeFileSync(resolve(evidence,'artifact-evidence.json'),JSON.stringify(artifact[0],null,2));
  expect(runtimes).toHaveLength(1);await expect.poll(()=>runtimes[0].evidence.stopped).toBe(true);expect(errors).toEqual(archiveFailure?['Error: owned-browser-archive-storage-failure']:[]);
  await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('workspace.tool-run.'))localStorage.removeItem(key);});await page.reload();
  await page.getByRole('button',{name:'任务与用量',exact:true}).click();const history=page.getByRole('dialog',{name:'任务与用量'});await expect(history.locator('.task-row')).toHaveCount(1);await history.locator('.task-row').click();
  await expect(history.locator('#history-state')).toHaveText('已完成，结果已归档');await expect(history.getByRole('log')).toContainText('已归档完成');
  await page.screenshot({path:resolve(evidence,'task-history.png'),fullPage:true});
  const historyWaiting=page.waitForEvent('download');await history.getByRole('link',{name:'下载任务结果'}).click();const historyDownload=await historyWaiting,historyPath=await historyDownload.path();if(!historyPath)throw Error('NO_HISTORY_DOWNLOAD');expect(readFileSync(historyPath)).toEqual(bytes);
  await history.getByRole('button',{name:'查看画布结果'}).click();await expect(page.getByRole('img',{name:'缩放结果',exact:true})).toBeVisible();expect(runtimes).toHaveLength(1);
  writeFileSync(resolve(evidence,'assertions.json'),JSON.stringify({scope:'real-browser-owned-cpu-no-model',runs,outputs,sourcePixels:'RGB(51,102,204)',resultDimensions:[256,256],userUndoPreservedBackgroundOutput:true,archiveRecoveredThroughUI:archiveFailure,reloaded:true,noSecondSubmission:true},null,2));
});


async function acceptUnplacedThroughUI(page:import('@playwright/test').Page){
  await expect(page.locator('[data-tool-form]').getByRole('status')).toHaveText('正在缩放',{timeout:60_000});
  const originalUrl=await page.getByRole('img',{name:'owned-product.png',exact:true}).getAttribute('src');if(!originalUrl)throw Error('NO_ORIGINAL_URL');const originalBefore=await(await page.request.get(origin+originalUrl)).body();
  await page.locator('.handle').filter({hasText:unplacedKind==='source'?'owned-product.png':'图片缩放 · 固定模板 v1'}).click();await page.getByRole('region',{name:'对象属性'}).getByRole('button',{name:'删除所选'}).click();await expect(page.getByRole('status').first()).toHaveText('已保存到本机');releaseUnplacedResult();
  const actor=(await(await page.request.get(origin+'/v1/me')).json()).data.user.id,p=(await(await page.request.get(origin+'/v1/projects')).json()).data.items[0].id;
  const runId=(await(await page.request.get(origin+`/v1/projects/${p}/runs`)).json()).data.items[0].id;
  const read=async()=> (await(await page.request.get(origin+`/v1/projects/${p}/runs/${runId}`)).json()).data;
  await expect.poll(async()=>(await read()).state,{timeout:60_000}).toBe('succeeded');const before=await read();expect(before.output).toMatchObject({object_id:null,unplaced:true});const resultBytes=await(await page.request.get(origin+`/v1/projects/${p}/assets/${before.output.asset_version_id}`)).body();
  const sharp=createRequire(new URL('../../apps/api/package.json',import.meta.url))('sharp'),decoded=await sharp(resultBytes).removeAlpha().raw().toBuffer({resolveWithObject:true});expect(decoded.info).toMatchObject({width:256,height:256,channels:3});expect(decoded.data.every((value:number,index:number)=>value===[51,102,204][index%3])).toBe(true);writeFileSync(resolve(evidence,'result.png'),resultBytes);
  await page.reload();await expect(page.getByRole('img',{name:'缩放结果',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'未归位结果',exact:true}).click();const dialog=page.getByRole('dialog',{name:'未归位结果'});await expect(dialog.locator('.task-row')).toHaveCount(1);await dialog.locator('.task-row').click();await expect(dialog.locator('#history-state')).toHaveText('结果已归档，尚未放回画布');await expect(dialog.getByRole('button',{name:'查看画布结果'})).toBeHidden();await expect(dialog.getByRole('log')).toContainText('原卡已移除，结果保留待放置');await page.screenshot({path:resolve(evidence,'unplaced-result.png'),fullPage:true});
  const placementPath=`/v1/projects/${p}/runs/${runId}/place-output`;
  expect((await page.request.post(origin+placementPath,{headers:{origin,'x-workspace-local':'1'},data:{actorId:actor,assetId:before.output.asset_version_id}})).status()).toBe(422);
  expect((await page.request.post(origin+placementPath,{headers:{origin:'https://outside.example','x-workspace-local':'1'},data:{}})).status()).toBe(403);
  let lost=false,requests=0,firstOperation='',firstRequest:any;await page.route('**/place-output',async route=>{requests++;if(!lost){lost=true;firstRequest=route.request().postDataJSON();firstOperation=firstRequest.id;const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort('failed');}else{if(requests===2)expect(route.request().postDataJSON().id).toBe(firstOperation);await route.continue();}});
  await dialog.getByRole('button',{name:'放到画布',exact:true}).click();await expect(dialog.locator('#history-error')).toContainText('放置未确认');await expect(page.locator('#scene')).toHaveAttribute('inert','');await expect(page.getByRole('button',{name:'添加文字卡'})).toBeDisabled();await expect(dialog.getByRole('button',{name:'确认结果放置',exact:true})).toBeEnabled();
  let committed=await read();expect(committed.output.object_id).toBeTruthy();await page.screenshot({path:resolve(evidence,'placement-response-lost.png'),fullPage:true});
  if(unplacedKind==='tool'){
    const canvas=(await(await page.request.get(origin+`/v1/projects/${p}/canvas`)).json()).data,object=canvas.objects.find((o:any)=>o.id===committed.output.object_id);
    expect((await page.request.post(origin+`/v1/projects/${p}/canvas-operations`,{headers:{origin,'x-workspace-local':'1'},data:{id:randomUUID(),baseRevision:canvas.revision,objects:[{...object,revision:object.revision+1,deleted:true}],lease:firstRequest.lease}})).status()).toBe(200);
    await page.reload();await page.getByRole('button',{name:'未归位结果',exact:true}).click();await dialog.locator('.task-row').click();await dialog.getByRole('button',{name:'确认结果放置',exact:true}).click();await expect(dialog.locator('#history-error')).toContainText('上次放置已确认');await expect(dialog.getByRole('button',{name:'放到画布',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'重试结果放置',exact:true})).toBeHidden();
    await dialog.getByRole('button',{name:'放到画布',exact:true}).click();await expect(dialog.getByRole('button',{name:'放到画布',exact:true})).toBeHidden();committed=await read();expect(requests).toBe(3);
  }else
  await dialog.getByRole('button',{name:'确认结果放置',exact:true}).click();await expect(dialog.getByRole('button',{name:'确认结果放置',exact:true})).toBeHidden();await expect(dialog.locator('#history-state')).toHaveText('已完成，结果已归档');await expect(dialog.locator('#history-list')).toHaveText('没有未归位结果');expect(requests).toBe(unplacedKind==='tool'?3:2);
  const waiting=page.waitForEvent('download');await dialog.getByRole('link',{name:'下载任务结果'}).click();const download=await waiting,path=await download.path();if(!path)throw Error('NO_RESULT_DOWNLOAD');expect(readFileSync(path)).toEqual(resultBytes);
  await dialog.getByRole('button',{name:'查看画布结果'}).click();await expect(page.getByRole('img',{name:'缩放结果',exact:true})).toBeVisible();await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(page.getByRole('img',{name:'缩放结果',exact:true})).toHaveCount(0);expect((await read()).output.unplaced).toBe(true);await page.getByRole('button',{name:'重做',exact:true}).click();await expect(page.getByRole('img',{name:'缩放结果',exact:true})).toBeVisible();expect((await read()).output.object_id).toBe(committed.output.object_id);
  await page.locator('.handle').filter({hasText:'缩放结果'}).click();await page.getByRole('region',{name:'对象属性'}).getByRole('button',{name:'删除所选'}).click();await expect(page.getByRole('img',{name:'缩放结果',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'未归位结果',exact:true}).click();await dialog.locator('.task-row').click();await dialog.getByRole('button',{name:'放到画布',exact:true}).click();await expect(dialog.locator('#history-state')).toHaveText('已完成，结果已归档');await dialog.getByRole('button',{name:'查看画布结果'}).click();await expect(page.getByRole('img',{name:'缩放结果',exact:true})).toBeVisible();await page.screenshot({path:resolve(evidence,'unplaced-result-restored.png'),fullPage:true});
  const after=await read();expect(after.snapshotHash).toBe(before.snapshotHash);expect(after.output.asset_version_id).toBe(before.output.asset_version_id);expect(after.output.object_id).not.toBe(committed.output.object_id);expect(requests).toBe(unplacedKind==='tool'?4:3);expect(runtimes).toHaveLength(1);await expect.poll(()=>runtimes[0].evidence.stopped).toBe(true);expect(errors).toEqual([]);
  const attempts=(await db.asActor(actor,tx=>tx.query('SELECT id FROM workspace.run_attempts WHERE project_id=$1',[p]))).rows,outputs=(await db.asActor(actor,tx=>tx.query('SELECT * FROM workspace.run_outputs WHERE project_id=$1',[p]))).rows,placements=(await db.asActor(actor,tx=>tx.query('SELECT object_id FROM workspace.run_output_placements WHERE project_id=$1',[p]))).rows,events=(await db.asActor(actor,tx=>tx.query<{stage:string}>('SELECT stage FROM workspace.run_events WHERE project_id=$1',[p]))).rows;
  expect(attempts).toHaveLength(1);expect(outputs).toHaveLength(1);expect(outputs[0].object_id).toBeNull();expect(placements).toHaveLength(unplacedKind==='tool'?3:2);expect(events.filter(e=>e.stage==='submitted')).toHaveLength(1);expect(events.filter(e=>e.stage==='output_placed')).toHaveLength(unplacedKind==='tool'?3:2);
  const originalBytes=await(await page.request.get(origin+originalUrl)).body();expect(originalBytes).toEqual(originalBefore);const original=await sharp(originalBytes).removeAlpha().raw().toBuffer({resolveWithObject:true});expect(original.info).toMatchObject({width:16,height:12,channels:3});expect(original.data.every((value:number,index:number)=>value===[51,102,204][index%3])).toBe(true);
  writeFileSync(resolve(evidence,'assertions.json'),JSON.stringify({scope:'actual-owned-cpu-unplaced-results',unplacedKind,snapshotHash:after.snapshotHash,attempts,outputs,placements,placementRequests:requests,submissionEvents:1,undoRedoPreservedOriginal:true,sourceUnchanged:true},null,2));
}
