import {spawnSync} from 'node:child_process';
import {it,expect} from 'vitest';
it('真实Node独立先导入解码器不会触发ESM循环初始化错误，并保留错误类身份',()=>{
  const child=spawnSync(process.execPath,['--import','tsx','tests/fixtures/static-decoder-entry.ts'],{encoding:'utf8',windowsHide:true,timeout:3000});
  expect(child.status,child.stderr).toBe(0);expect(child.stdout).toContain('standalone-decoder-entry-ok');
});
