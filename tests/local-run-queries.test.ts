import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {LocalWorkspaceDatabase} from '../apps/api/src/localWorkspaceDatabase';
import {LocalRunQueries} from '../apps/api/src/localRunQueries';
import {LocalBoundRuns} from '../apps/api/src/localBoundRuns';
let db:LocalWorkspaceDatabase,queries:LocalRunQueries;const owner=randomUUID(),viewer=randomUUID(),outside=randomUUID(),project=randomUUID(),ids:string[]=[];
beforeAll(async()=>{
  db=await LocalWorkspaceDatabase.open(process.cwd());queries=new LocalRunQueries(db);await db.seedProject(project,'owned read queries',[{userId:owner,role:'owner'},{userId:viewer,role:'viewer'}]);
  for(let index=0;index<5;index++)ids.push(await db.enqueue(owner,project,{kind:'owned-unknown-capability',privateMarker:'never-in-list'},'owned-history-'+index,'0'));
  await db.asActor(owner,tx=>tx.query("UPDATE workspace.runs SET created_at='2026-11-10 00:00:00.123456+00' WHERE project_id=$1",[project]));
});
afterAll(async()=>{if(db)await db.close();});
it('任务清单微秒时间相同仍分页完整，不包含原始请求/内部私有payload',async()=>{
  const found:string[]=[];let cursor:string|undefined;
  do{const page=await queries.list(viewer,project,{limit:2,cursor});found.push(...page.items.map(item=>item.id));expect(JSON.stringify(page)).not.toContain('never-in-list');expect(JSON.stringify(page)).not.toContain('token_hash');cursor=page.nextCursor??undefined;}while(cursor);
  expect(found).toHaveLength(5);expect([...new Set(found)].sort()).toEqual([...ids].sort());
  await expect(queries.list(outside,project)).rejects.toThrow('NOT_FOUND');
  await expect(queries.list(owner,project,{limit:101})).rejects.toThrow('INVALID_BODY');
  await expect(queries.list(owner,project,{cursor:Buffer.from(JSON.stringify({projectId:randomUUID(),createdAt:new Date().toISOString(),id:ids[0]})).toString('base64url')})).rejects.toThrow('INVALID_BODY');
});
it('持久事件游标续读不重复，viewer可读，未来/负游标及越权拒绝',async()=>{
  await new LocalBoundRuns(db).cancel(owner,project,ids[0],'owned query event');
  expect(await queries.events(viewer,project,ids[0],0,1)).toMatchObject({items:[{sequence:1,stage:'cancelled',attemptId:null}],nextSequence:1,latestSequence:1,hasMore:false});
  expect((await queries.events(owner,project,ids[0],1)).items).toEqual([]);
  await expect(queries.events(owner,project,ids[0],2)).rejects.toThrow('INVALID_BODY');
  await expect(queries.events(owner,project,ids[0],-1)).rejects.toThrow('INVALID_BODY');
  await expect(queries.events(outside,project,ids[0])).rejects.toThrow('NOT_FOUND');
});
it('未知能力的费用不因reserved为零就归零，执行unknown与费用unknown分别保留',async()=>{
  await db.asActor(owner,tx=>tx.query("UPDATE workspace.runs SET state='unknown' WHERE project_id=$1 AND id=$2",[project,ids[1]]));
  const usage=await queries.usage(viewer,project);expect(usage).toMatchObject({currency:'USD',actual:{unknownRunCount:1,complete:false},executionUnknownRuns:1,unaccountedRuns:5,totalRuns:5,localResize:{runCount:0,providerCostAmount:'0'}});
  expect(typeof usage.actual.knownSettledAmount).toBe('string');expect(typeof usage.reservedAmount).toBe('string');
  await expect(queries.usage(outside,project)).rejects.toThrow('NOT_FOUND');
});
it('不可变快照hash损坏，列表和费用统计失败关闭，不给出假零费用',async()=>{
  const admin=(db as unknown as {db:{exec:(sql:string)=>Promise<unknown>;query:(sql:string,params:unknown[])=>Promise<unknown>}}).db;
  await admin.exec('ALTER TABLE workspace.run_snapshots DISABLE TRIGGER immutable_history');
  await admin.query("UPDATE workspace.run_snapshots SET content_hash=$1 WHERE project_id=$2",['0'.repeat(64),project]);
  await admin.exec('ALTER TABLE workspace.run_snapshots ENABLE TRIGGER immutable_history');
  await expect(queries.list(owner,project)).rejects.toThrow('SNAPSHOT_INTEGRITY_FAILED');await expect(queries.usage(owner,project)).rejects.toThrow('SNAPSHOT_INTEGRITY_FAILED');
});
