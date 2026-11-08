import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { LocalWorkspaceDatabase } from "../apps/api/src/localWorkspaceDatabase.ts";

describe('TASK-05 本地身份适配器',()=>{
  let db:LocalWorkspaceDatabase,directory:string,user:{id:string;username:string};
  const password='owned-test-password-with-entropy-2026';
  beforeAll(async()=>{directory=mkdtempSync(join(tmpdir(),'workspace-auth-'));db=await LocalWorkspaceDatabase.open(process.cwd(),directory);user=await db.registerLocalUser('local_owner',password);});
  afterAll(async()=>{if(db)await db.close();if(directory)rmSync(directory,{recursive:true,force:true});});
  it('真实校验密码，错误密码和不存在账号统一失败，拒绝弱密码',async()=>{
    await expect(db.login('local_owner','wrong')).rejects.toThrow('LOGIN_FAILED');
    await expect(db.login('not_found','wrong')).rejects.toThrow('LOGIN_FAILED');
    await expect(db.registerLocalUser('weak_user','123')).rejects.toThrow('INVALID_LOCAL_CREDENTIALS');
    const session=await db.login('local_owner',password);expect(session.user).toEqual(user);
    expect(await db.authenticate(session.token)).toEqual(user);
    expect(JSON.stringify(session)).not.toContain(password);
  });
  it('伪造/过期session拒绝，注销立即失效且幂等',async()=>{
    const now=new Date(),session=await db.login('local_owner',password,now);
    await expect(db.authenticate('forged')).rejects.toThrow('UNAUTHENTICATED');
    await expect(db.authenticate(session.token,new Date(now.getTime()+13*60*60*1000))).rejects.toThrow('UNAUTHENTICATED');
    await db.logout(session.token);await db.logout(session.token);
    await expect(db.authenticate(session.token)).rejects.toThrow('UNAUTHENTICATED');
  });
  it('凭据表不向应用角色开放；账号和有效session可跨重启恢复',async()=>{
    const session=await db.login('local_owner',password);
    await expect(db.asActor(user.id,tx=>tx.query('SELECT * FROM workspace_auth.users'))).rejects.toThrow();
    await db.close();db=await LocalWorkspaceDatabase.open(process.cwd(),directory);
    expect(await db.authenticate(session.token)).toEqual(user);
    expect((await db.login('local_owner',password)).user).toEqual(user);
  });
});
