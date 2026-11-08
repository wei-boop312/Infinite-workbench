import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { LocalWorkspaceDatabase } from "./localWorkspaceDatabase.ts";
import type { LocalWorkspaceAssets } from './localWorkspaceAssets.ts';
import { RunKernelError } from './runKernel.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function reply(response:ServerResponse,status:number,data:unknown){
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  response.end(JSON.stringify(status>=400?{error:{code:data},request_id:randomUUID()}:{data,request_id:randomUUID()}));
}
async function body(request:IncomingMessage){
  if(!request.headers['content-type']?.startsWith('application/json'))throw new Error('INVALID_BODY');
  let size=0;const parts:Buffer[]=[];
  for await(const part of request){const bytes=Buffer.from(part);size+=bytes.length;if(size>65536)throw new Error('BODY_TOO_LARGE');parts.push(bytes);}
  const value=JSON.parse(Buffer.concat(parts).toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_BODY');
  return value as Record<string,unknown>;
}
function fields(data:Record<string,unknown>,keys:string[]){if(Object.keys(data).some(k=>!keys.includes(k)))throw new Error('INVALID_BODY');}
function cookie(request:IncomingMessage){return (request.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('workspace_session='))?.slice(18)??'';}

/** Loopback development API. No cloud OIDC, CORS, public registration or model execution. */
export function createLocalWorkspaceHttp(db:LocalWorkspaceDatabase,options:{origin:()=>string;clientFile?:string;assets?:LocalWorkspaceAssets}){
  const failures=new Map<string,{count:number;until:number}>();
  return createServer(async(request,response)=>{
    try{
      const expected=new URL(options.origin());
      if(!['127.0.0.1','localhost'].includes(expected.hostname)||expected.protocol!=='http:'||request.headers.host!==expected.host){reply(response,403,'ORIGIN_REJECTED');return;}
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress??'')){reply(response,403,'LOOPBACK_ONLY');return;}
      const method=request.method??'GET',url=new URL(request.url??'/',expected);
      if(method==='GET'&&url.pathname==='/'&&options.clientFile){
        response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin'});
        response.end(readFileSync(options.clientFile));return;
      }
      if(!['GET','HEAD'].includes(method)&&(request.headers.origin!==expected.origin||request.headers['x-workspace-local']!=='1')){reply(response,403,'ORIGIN_REJECTED');return;}
      if(url.pathname==='/v1/auth/setup'&&method==='GET'){reply(response,200,{required:await db.needsLocalSetup()});return;}
      if(url.pathname==='/v1/auth/setup'&&method==='POST'){
        const input=await body(request);fields(input,['username','password']);
        if(typeof input.username!=='string'||typeof input.password!=='string')throw new Error('INVALID_BODY');
        await db.setupLocalOwner(input.username,input.password);
        const session=await db.login(input.username,input.password);
        response.setHeader('set-cookie',`workspace_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        reply(response,201,{user:session.user});return;
      }
      if(url.pathname==='/v1/auth/login'&&method==='POST'){
        const current=failures.get('loopback');if(current&&current.until>Date.now()&&current.count>=5){reply(response,429,'LOGIN_RATE_LIMIT');return;}
        const input=await body(request);fields(input,['username','password']);
        if(typeof input.username!=='string'||typeof input.password!=='string')throw new Error('INVALID_BODY');
        try{
          const session=await db.login(input.username,input.password);failures.delete('loopback');
          response.setHeader('set-cookie',`workspace_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
          reply(response,200,{user:session.user,expires_at:session.expiresAt});
        }catch(error){failures.set('loopback',{count:current&&current.until>Date.now()?current.count+1:1,until:current&&current.until>Date.now()?current.until:Date.now()+60_000});throw error;}
        return;
      }
      const user=await db.authenticate(cookie(request));
      if(url.pathname==='/v1/me'&&method==='GET'){reply(response,200,{user});return;}
      if(url.pathname==='/v1/auth/logout'&&method==='POST'){
        await db.logout(cookie(request));response.setHeader('set-cookie','workspace_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');reply(response,200,{logged_out:true});return;
      }
      if(url.pathname==='/v1/projects'){
        if(method==='GET'){reply(response,200,{items:(await db.asActor(user.id,tx=>tx.query("SELECT id,name FROM workspace.projects WHERE deleted_at IS NULL ORDER BY created_at,id"))).rows});return;}
        if(method==='POST'){
          const input=await body(request);fields(input,['name']);
          if(typeof input.name!=='string'||!input.name.trim()||input.name.length>240)throw new Error('INVALID_BODY');
          const projectId=randomUUID();await db.seedProject(projectId,input.name.trim(),[{userId:user.id,role:'owner'}]);
          reply(response,201,{id:projectId,name:input.name.trim()});return;
        }
      }
      const route=/^\/v1\/projects\/([^/]+)(?:\/(canvas|lease|assets)(?:\/([^/]+))?)?$/.exec(url.pathname);
      if(!route||!uuid.test(route[1])){reply(response,404,'NOT_FOUND');return;}
      const projectId=route[1],role=(await db.asActor(user.id,tx=>tx.query<{role:string}>("SELECT m.role FROM workspace.project_members m JOIN workspace.projects p ON p.id=m.project_id WHERE p.id=$1 AND p.deleted_at IS NULL",[projectId]))).rows[0]?.role;
      if(!role){reply(response,404,'NOT_FOUND');return;}
      if(method==='GET'&&route[2]==='assets'&&uuid.test(route[3]??'')&&options.assets){
        const result=await options.assets.download(user.id,projectId,route[3]);
        response.writeHead(200,{'content-type':result.asset.mime,'content-length':result.bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff',
          'content-disposition':`${url.searchParams.get('download')==='1'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(result.asset.original_name)}`});
        response.end(result.bytes);return;
      }
      if(method==='GET'&&route[2]==='canvas'){
        const result=await db.asActor(user.id,async tx=>({
          revision:Number((await tx.query<{revision:number}>("SELECT revision FROM workspace.canvases WHERE project_id=$1",[projectId])).rows[0].revision),
          objects:(await tx.query<{payload:unknown}>("SELECT r.payload FROM workspace.objects o JOIN workspace.object_revisions r ON r.project_id=o.project_id AND r.object_id=o.id AND r.revision=o.current_revision WHERE o.project_id=$1 ORDER BY o.id",[projectId])).rows.map(r=>r.payload),
        }));reply(response,200,result);return;
      }
      if(role==='viewer'){reply(response,403,'ACCESS_DENIED');return;}
      if(method==='POST'&&route[2]==='assets'&&!route[3]&&options.assets){
        let size=0;const parts:Buffer[]=[];
        for await(const part of request){const bytes=Buffer.from(part);size+=bytes.length;if(size>8*1024*1024)throw new Error('ASSET_SIZE_EXCEEDED');parts.push(bytes);}
        const name=decodeURIComponent(String(request.headers['x-file-name']??'image.png'));
        reply(response,201,await options.assets.upload(user.id,projectId,Buffer.concat(parts),String(request.headers['content-type']??''),name));return;
      }
      if(method==='POST'&&route[2]==='lease'){
        const input=await body(request);fields(input,['takeover']);if(input.takeover!==undefined&&typeof input.takeover!=='boolean')throw new Error('INVALID_BODY');
        reply(response,200,await db.acquireLease(user.id,projectId,input.takeover===true));return;
      }
      if(method==='PATCH'&&route[2]==='lease'){
        const input=await body(request);fields(input,['token','fencing']);
        if(typeof input.token!=='string'||!Number.isSafeInteger(input.fencing))throw new Error('INVALID_BODY');
        reply(response,200,await db.renewLease(user.id,projectId,{token:input.token,fencing:Number(input.fencing)}));return;
      }
      if(method==='PATCH'&&route[2]==='canvas'){
        const input=await body(request);fields(input,['object','baseRevision','lease']);
        const lease=input.lease as {token:string;fencing:number};
        if(!Number.isSafeInteger(input.baseRevision)||Number(input.baseRevision)<0||!lease||typeof lease.token!=='string'||!Number.isSafeInteger(lease.fencing)||Object.keys(lease).some(k=>!['token','fencing'].includes(k)))throw new Error('INVALID_BODY');
        const revision=await db.saveObject(user.id,projectId,input.object,Number(input.baseRevision),lease);reply(response,200,{revision});return;
      }
      if(method==='DELETE'&&!route[2]){
        if(role!=='owner'){reply(response,403,'ACCESS_DENIED');return;}
        await db.asActor(user.id,tx=>tx.query("UPDATE workspace.projects SET deleted_at=now() WHERE id=$1",[projectId]));reply(response,200,{deleted:true});return;
      }
      reply(response,404,'NOT_FOUND');
    }catch(error){
      if(error instanceof RunKernelError){reply(response,error.status,error.code);return;}
      const message=error instanceof Error?error.message:'';
      const status=['UNAUTHENTICATED','LOGIN_FAILED'].includes(message)?401:message==='NOT_FOUND'?404:
        ['LEASE_CONFLICT','REVISION_CONFLICT','OBJECT_REVISION_CONFLICT','LOCAL_SETUP_COMPLETE'].includes(message)?409:['BODY_TOO_LARGE','ASSET_SIZE_EXCEEDED','ASSET_QUOTA_EXCEEDED'].includes(message)?413:
        ['INVALID_BODY','INVALID_LOCAL_CREDENTIALS','ASSET_TYPE_REJECTED','INVALID_ASSET_NAME'].includes(message)||error instanceof SyntaxError||error instanceof URIError||(error instanceof Error&&error.name==='ZodError')?422:500;
      reply(response,status,status===500?'INTERNAL_ERROR':message==='INVALID_BODY'?'INVALID_BODY':status===422?'INVALID_INPUT':message);
    }
  });
}
