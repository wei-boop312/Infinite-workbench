import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,symlinkSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {it,expect,beforeAll} from 'vitest';
import {LocalRunArtifactStore} from '../apps/api/src/localRunArtifactStore';
import {WorkspaceRuntimeEvidenceSchema} from '../packages/contracts/src/workspace';
let bytes:Buffer;const parameters={width:128,height:96};
const context=()=>({projectId:randomUUID(),runId:randomUUID(),attemptId:randomUUID(),snapshotHash:'a'.repeat(64),requestHash:'b'.repeat(64),runtimeEvidenceHash:'c'.repeat(64),providerRequestId:randomUUID(),history:{scope:'contract-fixture-only'}});
beforeAll(async()=>{const sharp=createRequire(new URL('../apps/api/package.json',import.meta.url))('sharp');bytes=await sharp({create:{...parameters,channels:3,background:'#3366cc'}}).png().toBuffer();});
it('校验后私有暂存，固定manifest可重开加载；重复写入不改变原件或泄漏lease字段',async()=>{
  const root=resolve('work','owned-artifact-store-'+randomUUID()),store=new LocalRunArtifactStore(root),scope=context();
  const stored=await store.stage({...scope,token:'owned-secret-not-metadata'} as any,bytes,parameters);
  const loaded=await new LocalRunArtifactStore(root).load(scope,stored.manifestHash);expect(loaded.bytes).toEqual(bytes);expect(JSON.stringify(loaded.manifest)).not.toContain('owned-secret');
  expect(await store.stage(scope,bytes,parameters)).toEqual(stored);
  await expect(store.stage({...scope,providerRequestId:'other-request'},bytes,parameters)).rejects.toThrow('ARTIFACT_IMMUTABLE_CONFLICT');
});
it('字节或manifest改写后不能仅凭自算hash恢复，必须匹配DB登记的manifest hash',async()=>{
  const root=resolve('work','owned-artifact-store-'+randomUUID()),store=new LocalRunArtifactStore(root),scope=context(),stored=await store.stage(scope,bytes,parameters);
  const directory=resolve(root,scope.projectId,scope.runId,scope.attemptId),changed=Buffer.from(bytes);changed[changed.length-1]^=1;
  writeFileSync(resolve(directory,'output.png'),changed);await expect(store.load(scope,stored.manifestHash)).rejects.toThrow('ARTIFACT_INTEGRITY_FAILED');
  const manifest=JSON.parse(readFileSync(resolve(directory,'manifest.json'),'utf8'));manifest.sha256=createHash('sha256').update(changed).digest('hex');writeFileSync(resolve(directory,'manifest.json'),JSON.stringify(manifest));
  await expect(store.load(scope,stored.manifestHash)).rejects.toThrow('ARTIFACT_INTEGRITY_FAILED');
});
it('拒绝越界路径和错误尺寸；预置junction不能在私有根外创建运行目录',async()=>{
  const root=resolve('work','owned-artifact-store-'+randomUUID()),escape=resolve('work','owned-artifact-escape-'+randomUUID()),store=new LocalRunArtifactStore(root),scope=context();mkdirSync(escape);
  symlinkSync(escape,resolve(root,scope.projectId),process.platform==='win32'?'junction':'dir');
  await expect(store.stage(scope,bytes,parameters)).rejects.toThrow('INVALID_ARTIFACT_PATH');expect(readdirSync(escape)).toEqual([]);
  await expect(store.stage({...scope,projectId:'../outside'},bytes,parameters)).rejects.toThrow();
  await expect(store.stage(context(),bytes,{width:256,height:256})).rejects.toThrow('OUTPUT_DIMENSIONS_MISMATCH');
});
it('运行来源契约不接受凭据字段、绝对路径或假冒重复核心文件',()=>{
  const evidence={schemaVersion:1,adapterVersion:'local-owned-resize-v1',runtimeKind:'contract-fixture-not-real',runtimeRef:'owned-fixture-'+randomUUID(),compilerSourceSha256:'a'.repeat(64),registrySha256:'b'.repeat(64),pythonExecutableSha256:'c'.repeat(64),bridgeSha256:'d'.repeat(64),versions:{python:null,pytorch:null,comfyui:null},coreFiles:['nodes.py','execution.py','server.py','comfy/utils.py','comfy/model_management.py'].map(path=>({path,sha256:'e'.repeat(64)}))};
  expect(WorkspaceRuntimeEvidenceSchema.safeParse(evidence).success).toBe(true);
  expect(WorkspaceRuntimeEvidenceSchema.safeParse({...evidence,apiKey:'owned-secret'}).success).toBe(false);
  expect(WorkspaceRuntimeEvidenceSchema.safeParse({...evidence,runtimeRef:'C:/private/runtime'}).success).toBe(false);
  expect(WorkspaceRuntimeEvidenceSchema.safeParse({...evidence,coreFiles:Array(5).fill(evidence.coreFiles[0])}).success).toBe(false);
});
