import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { LocalWorkspaceDatabase } from "../apps/api/src/localWorkspaceDatabase.ts";
import { createLocalWorkspaceHttp } from "../apps/api/src/localWorkspaceHttp.ts";

describe('本地身份到项目/租约/保存的真实HTTP闭环',()=>{
  let db:LocalWorkspaceDatabase,server:Server,origin='',cookie='',otherCookie='',project='';
  const password='owned-http-password-2026-very-long';
  async function request(path:string,method='GET',value?:unknown,session=cookie,from=origin){
    return fetch(origin+path,{method,headers:{origin:from,'content-type':'application/json','x-workspace-local':'1',cookie:session},body:value===undefined?undefined:JSON.stringify(value)});
  }
  beforeAll(async()=>{
    db=await LocalWorkspaceDatabase.open(process.cwd());await db.registerLocalUser('owner_http',password);await db.registerLocalUser('other_http',password);
    server=createLocalWorkspaceHttp(db,{origin:()=>origin});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
    const address=server.address();if(!address||typeof address==='string')throw new Error('NO_ADDRESS');origin=`http://127.0.0.1:${address.port}`;
  });
  afterAll(async()=>{if(server)await new Promise<void>(done=>server.close(()=>done()));if(db)await db.close();});
  it('未登录拒绝；跨站登录被拒绝；真实登录仅通过HttpOnly cookie发session',async()=>{
    expect((await request('/v1/me')).status).toBe(401);
    expect((await request('/v1/auth/login','POST',{username:'owner_http',password},'','https://external.example')).status).toBe(403);
    const login=await request('/v1/auth/login','POST',{username:'owner_http',password},'');
    expect(login.status).toBe(200);expect(login.headers.get('set-cookie')).toContain('HttpOnly');
    cookie=login.headers.get('set-cookie')!.split(';')[0];expect(JSON.stringify(await login.json())).not.toContain('token');
    const other=await request('/v1/auth/login','POST',{username:'other_http',password},'');otherCookie=other.headers.get('set-cookie')!.split(';')[0];
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
  it('项目软删后RLS和API都不再返回对象；注销后cookie立即无效',async()=>{
    expect((await request(`/v1/projects/${project}`,'DELETE')).status).toBe(200);
    expect((await request(`/v1/projects/${project}/canvas`)).status).toBe(404);
    const me=(await(await request('/v1/me')).json()).data.user;
    expect((await db.asActor(me.id,tx=>tx.query('SELECT * FROM workspace.objects'))).rows).toHaveLength(0);
    expect((await request('/v1/auth/logout','POST',{})).status).toBe(200);
    expect((await request('/v1/me')).status).toBe(401);
  });
});
