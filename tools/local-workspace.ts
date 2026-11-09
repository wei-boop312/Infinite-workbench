import { resolve } from "node:path";
import { mkdirSync,existsSync,readFileSync } from "node:fs";
import { LocalWorkspaceDatabase } from "../apps/api/src/localWorkspaceDatabase.ts";
import { createLocalWorkspaceHttp } from "../apps/api/src/localWorkspaceHttp.ts";
import { LocalWorkspaceAssets } from '../apps/api/src/localWorkspaceAssets.ts';
import { recordedCompilerPin } from '../apps/worker/src/compileResize.ts';
import {LocalRunExecution} from '../apps/api/src/localRunExecution.ts';
import {LocalResizeWorker} from '../apps/worker/src/localResizeWorker.ts';
import {OwnedComfyRuntime} from '../apps/worker/src/ownedComfyRuntime.ts';
import {LocalRunDispatcher} from '../apps/worker/src/localRunDispatcher.ts';
import {LocalRunArtifactStore} from '../apps/api/src/localRunArtifactStore.ts';
const directory=resolve('work/local-workspace');mkdirSync(directory,{recursive:true});
const db=await LocalWorkspaceDatabase.open(process.cwd(),resolve(directory,'postgres'));
const origin='http://127.0.0.1:4310';
const assets=new LocalWorkspaceAssets(db,resolve(directory,'assets'));
const artifacts=new LocalRunArtifactStore(resolve(directory,'run-artifacts'));
const pin=recordedCompilerPin(process.cwd()).sourceTreeSha256;
const configFile=resolve(directory,'runtime.json'),config=existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):{};
const pythonExecutable=process.env.WORKSPACE_COMFY_PYTHON??config.pythonExecutable,comfyMain=process.env.WORKSPACE_COMFY_MAIN??config.comfyMain;
const dispatcher=pythonExecutable&&comfyMain?new LocalRunDispatcher(db,()=>new LocalResizeWorker(new LocalRunExecution(db,pin),assets,
  new OwnedComfyRuntime({root:process.cwd(),pythonExecutable,comfyMain,compilerSourceSha256:pin}),artifacts),(error,runId)=>console.error('本地缩放任务异常',runId,(error as Error).message),
  (actor,project,run)=>new LocalRunExecution(db,pin).recoverExpired(actor,project,run)):undefined;
const server=createLocalWorkspaceHttp(db,{origin:()=>origin,clientFile:resolve('apps/web/local-workspace.html'),assets,compilerSourceSha256:pin,onRunQueued:dispatcher?()=>dispatcher.wake():undefined});
server.on('error',async error=>{console.error(error.message);await db.close();process.exitCode=1;});
server.listen(4310,'127.0.0.1',()=>{dispatcher?.start();console.log(`本地工作台：${origin}；仅监听本机，数据保存在work/local-workspace。CPU缩放：${dispatcher?'已配置':'未配置'}。`);});
let closing=false;const close=()=>{if(closing)return;closing=true;server.emit('workspace-shutdown');server.close(()=>{void (async()=>{await dispatcher?.close();await db.close();})();});};
process.on('SIGINT',close);process.on('SIGTERM',close);
