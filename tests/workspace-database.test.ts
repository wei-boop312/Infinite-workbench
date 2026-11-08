import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalWorkspaceDatabase } from "../apps/api/src/localWorkspaceDatabase.ts";

describe("TASK-04 本地PostgreSQL语义与RLS", () => {
  let db:LocalWorkspaceDatabase; let directory:string;
  const owner=randomUUID(),designer=randomUUID(),viewer=randomUUID(),outsider=randomUUID();
  const project=randomUUID(),other=randomUUID();
  beforeAll(async()=>{
    directory=mkdtempSync(join(tmpdir(),'workspace-pg-'));
    db=await LocalWorkspaceDatabase.open(process.cwd(),directory);
    await db.seedProject(project,'产品项目',[{userId:owner,role:'owner'},{userId:designer,role:'designer'},{userId:viewer,role:'viewer'}]);
    await db.seedProject(other,'其他项目',[{userId:outsider,role:'owner'}]);
  });
  afterAll(async()=>{if(db)await db.close();if(directory)rmSync(directory,{recursive:true,force:true});});
  it("普通运行角色不是owner或BYPASSRLS；忘写项目过滤仍看不到其他项目",async()=>{
    const result=await db.asActor(owner,async tx=>({
      role:(await tx.query<{rolsuper:boolean;rolbypassrls:boolean}>("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0],
      projects:(await tx.query<{id:string}>("SELECT id FROM workspace.projects")).rows,
    }));
    expect(result.role).toEqual({rolsuper:false,rolbypassrls:false});
    expect(result.projects).toEqual([{id:project}]);
    expect((await db.asActor(outsider,tx=>tx.query("SELECT * FROM workspace.projects WHERE id=$1",[project]))).rows).toEqual([]);
  });
  it("viewer能读但不能改；designer不能删除项目，owner可改名称",async()=>{
    expect((await db.asActor(viewer,tx=>tx.query("SELECT * FROM workspace.projects"))).rows).toHaveLength(1);
    expect((await db.asActor(viewer,tx=>tx.query("UPDATE workspace.projects SET name='越权' WHERE id=$1 RETURNING id",[project]))).rows).toHaveLength(0);
    await expect(db.asActor(designer,tx=>tx.query("UPDATE workspace.projects SET deleted_at=now() WHERE id=$1",[project]))).rejects.toThrow('PROJECT_DELETE_OWNER_ONLY');
    expect((await db.asActor(owner,tx=>tx.query("UPDATE workspace.projects SET name='已确认' WHERE id=$1 RETURNING name",[project]))).rows).toEqual([{name:'已确认'}]);
  });
  it("租约/修订保护写入，历史payload不可修改，接管使旧令牌失效",async()=>{
    const lease=await db.acquireLease(owner,project),object={id:randomUUID(),projectId:project,type:'text',revision:1,text:'事实',x:0,y:0,width:100,height:100};
    expect(await db.saveObject(owner,project,object,0,lease)).toBe(1);
    await expect(db.saveObject(owner,project,{...object,revision:2},0,lease)).rejects.toThrow('REVISION_CONFLICT');
    await expect(db.asActor(owner,tx=>tx.query("UPDATE workspace.object_revisions SET payload='{}' WHERE project_id=$1",[project]))).rejects.toThrow('IMMUTABLE_HISTORY');
    await expect(db.acquireLease(designer,project)).rejects.toThrow('LEASE_CONFLICT');
    const taken=await db.acquireLease(designer,project,true);
    expect(taken.fencing).toBeGreaterThan(lease.fencing);
    await expect(db.saveObject(owner,project,{...object,revision:2},1,lease)).rejects.toThrow('LEASE_CONFLICT');
    expect(await db.saveObject(designer,project,{...object,revision:2,text:'修订'},1,taken)).toBe(2);
    const history=(await db.asActor(viewer,tx=>tx.query<{payload:{text:string}}>("SELECT payload FROM workspace.object_revisions WHERE object_id=$1 ORDER BY revision",[object.id]))).rows;
    expect(history.map(r=>r.payload.text)).toEqual(['事实','修订']);
  });
  it("复合外键拒绝跨项目资产引用，整份对象写入回滚",async()=>{
    const asset=randomUUID();
    await db.asActor(outsider,tx=>tx.query("INSERT INTO workspace.asset_versions VALUES($1,$2,$3,'ready','fixture')",[other,asset,'a'.repeat(64)]));
    const lease=await db.acquireLease(owner,project,true);
    const object={id:randomUUID(),projectId:project,type:'image',revision:1,assetVersionId:asset,x:0,y:0,width:100,height:100};
    await expect(db.saveObject(owner,project,object,2,lease)).rejects.toThrow();
    expect((await db.asActor(owner,tx=>tx.query("SELECT * FROM workspace.objects WHERE id=$1",[object.id]))).rows).toHaveLength(0);
    expect((await db.asActor(owner,tx=>tx.query<{revision:number}>("SELECT revision FROM workspace.canvases WHERE project_id=$1",[project]))).rows[0].revision).toBe(2);
  });
  it("run/快照/预算/outbox原子提交，相同key不重复冻结，异参拒绝",async()=>{
    const first=await db.enqueue(owner,project,{inputRevision:1},'one','20');
    expect(await db.enqueue(owner,project,{inputRevision:1},'one','20')).toBe(first);
    await expect(db.enqueue(owner,project,{inputRevision:2},'one','20')).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    const summary=await db.asActor(owner,async tx=>({
      runs:(await tx.query("SELECT * FROM workspace.runs")).rows.length,
      outbox:(await tx.query("SELECT * FROM workspace.outbox")).rows.length,
      reserved:(await tx.query<{reserved_amount:string}>("SELECT reserved_amount FROM workspace.budgets WHERE project_id=$1",[project])).rows[0].reserved_amount,
    }));
    expect(summary).toEqual({runs:1,outbox:1,reserved:'20.00000000'});
    const concurrent=await Promise.allSettled([db.enqueue(owner,project,{task:2},'two','60'),db.enqueue(owner,project,{task:3},'three','60')]);
    expect(concurrent.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(concurrent.filter(r=>r.status==='rejected')).toHaveLength(1);
    // PGlite serializes these calls; this is not a native connection-race claim.
  });
  it("outbox插入故障回滚同事务预算修改，viewer不能创建run",async()=>{
    const before=(await db.asActor(owner,tx=>tx.query<{reserved_amount:string}>("SELECT reserved_amount FROM workspace.budgets WHERE project_id=$1",[project]))).rows[0].reserved_amount;
    await expect(db.asActor(owner,async tx=>{
      await tx.query("UPDATE workspace.budgets SET reserved_amount=reserved_amount+1 WHERE project_id=$1",[project]);
      await tx.query("INSERT INTO workspace.outbox(project_id,id,run_id,event_type,payload) VALUES($1,$2,$3,'bad','{}')",[project,randomUUID(),randomUUID()]);
    })).rejects.toThrow();
    expect((await db.asActor(owner,tx=>tx.query<{reserved_amount:string}>("SELECT reserved_amount FROM workspace.budgets WHERE project_id=$1",[project]))).rows[0].reserved_amount).toBe(before);
    await expect(db.enqueue(viewer,project,{task:4},'forbidden','1')).rejects.toThrow();
  });
  it("关闭重开恢复项目与任务，角色上下文不跨事务遗留",async()=>{
    await db.close(); db=await LocalWorkspaceDatabase.open(process.cwd(),directory);
    expect((await db.asActor(owner,tx=>tx.query("SELECT * FROM workspace.runs"))).rows).toHaveLength(2);
    expect((await db.asActor(outsider,tx=>tx.query("SELECT * FROM workspace.runs"))).rows).toHaveLength(0);
    expect((await db.asActor(viewer,tx=>tx.query("SELECT * FROM workspace.project_members"))).rows).toHaveLength(1);
  });
  it("owner软删项目后所有子资源的行级权限同步关闭",async()=>{
    const disposable=randomUUID();
    await db.seedProject(disposable,'删除验证',[{userId:owner,role:'owner'}]);
    await db.asActor(owner,tx=>tx.query("UPDATE workspace.projects SET deleted_at=now() WHERE id=$1",[disposable]));
    expect((await db.asActor(owner,tx=>tx.query("SELECT * FROM workspace.canvases WHERE project_id=$1",[disposable]))).rows).toHaveLength(0);
  });
});
