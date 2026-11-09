import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { LocalWorkspaceDatabase } from "../apps/api/src/localWorkspaceDatabase.ts";
import { createLocalWorkspaceHttp } from "../apps/api/src/localWorkspaceHttp.ts";

describe('本地身份到项目/租约/保存的真实HTTP闭环',()=>{
  let db:LocalWorkspaceDatabase,server:Server,origin='',cookie='',otherCookie='',project='';
  let queuedNotifications=0,runId='';
  const password='owned-http-password-2026-very-long';
  async function request(path:string,method='GET',value?:unknown,session=cookie,from=origin){
    return fetch(origin+path,{method,headers:{origin:from,'content-type':'application/json','x-workspace-local':'1',cookie:session},body:value===undefined?undefined:JSON.stringify(value)});
  }
  beforeAll(async()=>{
    db=await LocalWorkspaceDatabase.open(process.cwd());await db.registerLocalUser('owner_http',password);await db.registerLocalUser('other_http',password);
    server=createLocalWorkspaceHttp(db,{origin:()=>origin,compilerSourceSha256:'b'.repeat(64),onRunQueued:()=>{queuedNotifications++;}});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
    const address=server.address();if(!address||typeof address==='string')throw new Error('NO_ADDRESS');origin=`http://127.0.0.1:${address.port}`;
  });
  afterAll(async()=>{if(server){server.emit('workspace-shutdown');await new Promise<void>(done=>server.close(()=>done()));}if(db)await db.close();});
  it('未登录拒绝；跨站登录被拒绝；真实登录仅通过HttpOnly cookie发session',async()=>{
    expect((await request('/v1/me')).status).toBe(401);
    expect((await request('/v1/runtime')).status).toBe(401);
    expect((await request('/v1/auth/login','POST',{username:'owner_http',password},'','https://external.example')).status).toBe(403);
    const login=await request('/v1/auth/login','POST',{username:'owner_http',password},'');
    expect(login.status).toBe(200);expect(login.headers.get('set-cookie')).toContain('HttpOnly');
    cookie=login.headers.get('set-cookie')!.split(';')[0];expect(JSON.stringify(await login.json())).not.toContain('token');
    const other=await request('/v1/auth/login','POST',{username:'other_http',password},'');otherCookie=other.headers.get('set-cookie')!.split(';')[0];
    expect((await(await request('/v1/runtime')).json()).data).toEqual({resizeEnabled:true,runCancellationEnabled:true,runHistoryEnabled:true,eventStreamsEnabled:true,archiveRecoveryEnabled:false,canvasOperationsEnabled:true,canvasSelectionEnabled:true,scope:'local-cpu-resize-only'});
  });
  it('项目归属由session决定，不接受伪造actor，其他用户看不到',async()=>{
    expect((await request('/v1/projects','POST',{name:'产品',actorId:randomUUID()})).status).toBe(422);
    const created=await request('/v1/projects','POST',{name:'产品'});expect(created.status).toBe(201);project=(await created.json()).data.id;
    expect((await(await request('/v1/projects')).json()).data.items).toHaveLength(1);
    expect((await(await request('/v1/projects','GET',undefined,otherCookie)).json()).data.items).toHaveLength(0);
    expect((await request(`/v1/projects/${project}/canvas`,'GET',undefined,otherCookie)).status).toBe(404);
  });
  it('取得租约后真实保存与读取，修订冲突不会覆盖已保存内容',async()=>{
    const lease=(await(await request(`/v1/projects/${project}/lease`,'POST',{})).json()).data;
    expect((await request(`/v1/projects/${project}/lease`,'PATCH',{token:lease.token,fencing:lease.fencing})).status).toBe(200);
    expect((await request(`/v1/projects/${project}/lease`,'PATCH',{token:'stale',fencing:lease.fencing})).status).toBe(409);
    const object={id:randomUUID(),projectId:project,revision:1,type:'text',text:'人工确认事实',x:20,y:30,width:200,height:100};
    const response=await request(`/v1/projects/${project}/canvas`,'PATCH',{object,baseRevision:0,lease:{token:lease.token,fencing:lease.fencing}});
    expect(response.status).toBe(200);
    expect((await request(`/v1/projects/${project}/canvas`,'PATCH',{object:{...object,revision:2,text:'旧请求'},baseRevision:0,lease:{token:lease.token,fencing:lease.fencing}})).status).toBe(409);
    const read=(await(await request(`/v1/projects/${project}/canvas`)).json()).data;
    expect(read.revision).toBe(1);expect(read.objects).toEqual([object]);
  });
  it('通过真实HTTP发布模板和绑定，仅服务端解析固定快照，重复提交不重建任务',async()=>{
    const graph={id:randomUUID(),workflowId:randomUUID(),projectId:project,version:1,nodes:[
      {id:'source',type:'input.asset',config:{}},{id:'resize',type:'comfy.execute',config:{templateId:'core_image_resize_v2'}},{id:'output',type:'output.asset',config:{}}
    ],edges:[{source:'source',sourcePort:'asset',target:'resize',targetPort:'asset'},{source:'resize',sourcePort:'asset',target:'output',targetPort:'asset'}]};
    expect((await request(`/v1/projects/${project}/workflow-versions`,'POST',graph)).status).toBe(201);
    const template={id:randomUUID(),templateId:randomUUID(),projectId:project,version:1,workflowVersionId:graph.id,operation:'image.resize',parameters:'resize-parameters-v1'};
    expect((await request(`/v1/projects/${project}/template-versions`,'POST',template)).status).toBe(201);
    const actor=(await(await request('/v1/me')).json()).data.user.id,asset=randomUUID();
    await db.asActor(actor,tx=>tx.query("INSERT INTO workspace.asset_versions VALUES($1,$2,$3,'ready','owned-http-fixture')",[project,asset,'a'.repeat(64)]));
    const lease=(await(await request(`/v1/projects/${project}/lease`,'POST',{})).json()).data;
    const source={id:randomUUID(),projectId:project,revision:1,type:'image',assetVersionId:asset,x:0,y:0,width:100,height:100};
    const tool={id:randomUUID(),projectId:project,revision:1,type:'tool',templateVersionId:template.id,x:200,y:0,width:100,height:100};
    for(const [index,object] of [source,tool].entries())expect((await request(`/v1/projects/${project}/canvas`,'PATCH',{object,baseRevision:index+1,lease:{token:lease.token,fencing:lease.fencing}})).status).toBe(200);
    const binding={id:randomUUID(),projectId:project,taskLineId:randomUUID(),sourceObjectId:source.id,sourceObjectRevision:1,toolObjectId:tool.id,toolObjectRevision:1,templateVersionId:template.id};
    expect((await request(`/v1/projects/${project}/bindings`,'POST',binding)).status).toBe(201);
    const send=(payload:unknown)=>fetch(`${origin}/v1/projects/${project}/runs`,{method:'POST',headers:{origin,'content-type':'application/json','x-workspace-local':'1','idempotency-key':'http-owned-once',cookie},body:JSON.stringify(payload)});
    expect((await send({bindingId:binding.id,parameters:{width:256,height:256},snapshot:{authorized:true}})).status).toBe(422);
    expect(queuedNotifications).toBe(0);
    const first=await send({bindingId:binding.id,parameters:{width:256,height:256}});expect(first.status).toBe(202);const id=(await first.json()).data.id;runId=id;
    expect((await(await send({bindingId:binding.id,parameters:{width:256,height:256}})).json()).data).toMatchObject({id,reused:true});
    expect(queuedNotifications).toBe(2);
    const result=(await(await request(`/v1/projects/${project}/runs/${id}`)).json()).data;
    expect(result.state).toBe('queued');expect(result.eventSequence).toBe(0);expect(result.snapshot.source.id).toBe(source.id);expect(result.snapshot.authorization.actorId).toBe(actor);
    expect((await request(`/v1/projects/${project}/runs/${id}`,'GET',undefined,otherCookie)).status).toBe(404);
    expect((await request(`/v1/projects/${project}/runs/${id}/cancel`,'POST',{reason:'forbidden'},otherCookie)).status).toBe(404);
    expect((await request(`/v1/projects/${project}/runs/${id}/cancel`,'POST',{reason:'x',snapshot:{}})).status).toBe(422);
    const cancellation=await request(`/v1/projects/${project}/runs/${id}/cancel`,'POST',{reason:'HTTP排队取消'});expect(cancellation.status).toBe(202);
    expect((await cancellation.json()).data.state).toBe('cancelled');
    expect((await(await request(`/v1/projects/${project}/runs/${id}`)).json()).data).toMatchObject({state:'cancelled',eventSequence:1});
    expect((await request(`/v1/projects/${project}/runs/${id}/cancel`)).status).toBe(404);
    const list=(await(await request(`/v1/projects/${project}/runs?limit=1`)).json()).data;expect(list.items).toHaveLength(1);expect(list.items[0]).toMatchObject({id,state:'cancelled'});
    expect((await(await request(`/v1/projects/${project}/runs/${id}/events?after_sequence=0`)).json()).data).toMatchObject({items:[{sequence:1,stage:'cancelled'}],nextSequence:1});
    expect((await(await request(`/v1/projects/${project}/usage`)).json()).data).toMatchObject({actual:{complete:true,unknownRunCount:0},localResize:{runCount:1,providerCostAmount:'0'}});
    expect((await request(`/v1/projects/${project}/usage`,'GET',undefined,otherCookie)).status).toBe(404);
    expect((await request(`/v1/projects/${project}/runs/${id}/events`,'GET',undefined,otherCookie)).status).toBe(404);
  });
  it('SSE持久游标续传不重复；注销后连接停止，不再泄漏事件',async()=>{
    const controller=new AbortController(),headers={origin,cookie,accept:'text/event-stream'};
    const path=`${origin}/v1/projects/${project}/runs/${runId}/events`;
    const readFrame=async(reader:ReadableStreamDefaultReader<Uint8Array>)=>{let text='';const decoder=new TextDecoder();while(!text.includes('\n\n')){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value,{stream:true});}return text;};
    try{
      const first=await fetch(path,{headers,signal:controller.signal});expect(first.status).toBe(200);expect(first.headers.get('content-type')).toContain('text/event-stream');
      const reader=first.body!.getReader(),frame=await readFrame(reader);expect(frame).toContain('id: 1\nevent: run_event');expect(frame).toContain('"stage":"cancelled"');await reader.cancel();
      const resumed=await fetch(path+'?after_sequence=0',{headers:{...headers,'last-event-id':'1'},signal:controller.signal});expect(resumed.status).toBe(200);
      await request('/v1/auth/logout','POST',{});
      const resumedReader=resumed.body!.getReader(),revoked=await readFrame(resumedReader);expect(revoked).toContain('event: access_revoked');expect(revoked).not.toContain('event: run_event');await resumedReader.cancel();
    }finally{controller.abort();}
    const login=await request('/v1/auth/login','POST',{username:'owner_http',password},'');cookie=login.headers.get('set-cookie')!.split(';')[0];
  });
  it('SSE连接期间撤销项目成员，仍有效的session也不能继续读日志',async()=>{
    const actor=(await(await request('/v1/me')).json()).data.user.id,controller=new AbortController();
    const admin=(db as unknown as {db:{query:(sql:string,params:unknown[])=>Promise<unknown>}}).db;
    const stream=await fetch(`${origin}/v1/projects/${project}/runs/${runId}/events?after_sequence=1`,{headers:{cookie,accept:'text/event-stream'},signal:controller.signal});expect(stream.status).toBe(200);
    try{
      await admin.query('DELETE FROM workspace.project_members WHERE project_id=$1 AND user_id=$2',[project,actor]);
      const reader=stream.body!.getReader(),decoder=new TextDecoder();let text='';while(!text.includes('\n\n')){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value,{stream:true});}
      expect(text).toContain('event: access_revoked');expect(text).not.toContain('event: run_event');await reader.cancel();
    }finally{controller.abort();await admin.query("INSERT INTO workspace.project_members VALUES($1,$2,'owner')",[project,actor]);}
  });
  it('HTTP锁定对象不能借旧PATCH或原子操作同时解锁移动，先解锁再编辑才成功',async()=>{
    const p=(await(await request('/v1/projects','POST',{name:'owned HTTP locked geometry'})).json()).data.id;
    try{const rawLease=(await(await request(`/v1/projects/${p}/lease`,'POST',{})).json()).data,lease={token:rawLease.token,fencing:rawLease.fencing};
    const object={id:randomUUID(),projectId:p,revision:1,type:'text',text:'owned locked fact',x:0,y:0,width:260,height:180,locked:true};
    expect((await request(`/v1/projects/${p}/canvas-operations`,'POST',{id:randomUUID(),baseRevision:0,objects:[object],lease})).status).toBe(200);
    expect((await request(`/v1/projects/${p}/canvas`,'PATCH',{object:{...object,revision:2,x:90},baseRevision:1,lease})).status).toBe(409);
    expect((await request(`/v1/projects/${p}/canvas-operations`,'POST',{id:randomUUID(),baseRevision:1,objects:[{...object,revision:2,locked:false,x:90}],lease})).status).toBe(409);
    expect((await request(`/v1/projects/${p}/canvas-operations`,'POST',{id:randomUUID(),baseRevision:1,objects:[{...object,revision:2,locked:false}],lease})).status).toBe(200);
    expect((await request(`/v1/projects/${p}/canvas-operations`,'POST',{id:randomUUID(),baseRevision:2,objects:[{...object,revision:3,locked:false,x:90}],lease})).status).toBe(200);
    expect((await(await request(`/v1/projects/${p}/canvas`)).json()).data.objects[0]).toMatchObject({revision:3,locked:false,x:90});
    }finally{expect((await request(`/v1/projects/${p}`,'DELETE')).status).toBe(200);}
  });
  it('项目软删后RLS和API都不再返回对象；注销后cookie立即无效',async()=>{
    expect((await request(`/v1/projects/${project}`,'DELETE')).status).toBe(200);
    expect((await request(`/v1/projects/${project}/canvas`)).status).toBe(404);
    const me=(await(await request('/v1/me')).json()).data.user;
    expect((await db.asActor(me.id,tx=>tx.query('SELECT * FROM workspace.objects'))).rows).toHaveLength(0);
    expect((await request('/v1/auth/logout','POST',{})).status).toBe(200);
    expect((await request('/v1/me')).status).toBe(401);
  });
});
