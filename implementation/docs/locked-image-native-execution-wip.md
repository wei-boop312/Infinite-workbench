# 原锁区B6接线WIP：2026-10-05触线停止历史记录

2026-10-13用户明确重新授权后，原B6已完成[本地验收](locked-image-native-execution.md)：最终第二完整2304单元/集成、196Chrome、6构建全通过。旧7项失败未稳定复现，不断言根因已证明；新验证/精确断言和子进程退出收尾记录见新入口。下面保留2026-10-05停止时点的WIP/未验收/PAUSED及旧比例，不覆盖当前人类授权与B6结果；阶段4/项目/真实供应商仍未完成，保护输出及日常真实执行仍关闭。

2026-10-05 11:55（上海）实际读取rateLimitsByLimitId.codex的10080分钟周窗口：usedPercent=80、remaining=20%，命中用户明确停止线。已立即停止新增开发并通过应用工具暂停原automation；下周重置或用量降低不自行恢复，须用户明确重新授权。账号共享取整/周期检查不保证零误差，不重置、购买或换模型绕过。

最后完整验收仍为[B5](locked-image-attempts.md)提交447c1c4的2257单元/集成、195Chrome、6构建。本文件保存停止时的有限接线改动，**不是B6完成、保护输出像素通过、真实供应商或项目完成**。

## 已写但未验收

- 原内部ProductionImageCredentialNetwork接受完整v1或v2确认身份，保持原完整request/payload SHA，不将v2改标none或填unknown估价；它仍不是实际任务授权服务。
- LockedProductionImageTaskReconstruction追加默认关闭executeNative/独立executeNetworkFixture，只有明确sending/credential/network配置及原实际同库响应、启动、租约政策才可走当次首次活流程。混用fixtureTransport、生产注入local-driver、范围错配或缺配置拒绝；没有日常HTTP/App接线。
- 原B5内部attempt前实际同库写后核验保持；原wire不变性与实际完整v2任务/原actor-worker-lease/当前权限、输入约束、价格/预算仍检查。已收到整包改用完整历史检查，不重新消费发送；自有网络返回副本和取消迟到副本尽力清零，原unknown/max不释放。
- 这些是源码中的WIP意图，尚未完成B6接受出口，不把schema、返回对象、已有attempt或historical started当补发许可。尚未证明新的受保护分支实际TLS、凭证轮换撤销、全部写后故障/资源/恢复组合通过。

## 实际验证和失败，停止后不修复

触线前API构建通过。新增7项在原受保护attempt套件中，使用自有随机根/秘密、独立内存ICRD1和显式local-driver，无实际供应商DNS/网络；原准备/确认/任务仅owned临时SQLite和自有小PNG/蒙版/假价格。

触线前已启动pnpm exec vitest run tests/locked-production-attempts.test.ts tests/production-image-attempts.test.ts，收尾结果212项中205通过、7失败（2文件，1过/1失败）。受保护套件81项有7失败，旧production套件通过。新4项known/manual OpenAI/compatible正向和1项已提交历史超原5秒；旧非合作端口槽用例也超原5秒，旧两个OS进程一次调用用例报owned child failed，另有其临时目录清理EPERM。不能把失败归因为已证实的CPU争用或只靠重试掩盖，具体原因须重新授权后诊断。

未重跑完整pnpm check、未做新Chrome/6构建验收，未调任何默认时限、worker、依赖或吞错。额度命中后不新增修复或测试；安全保存WIP与上述失败。原完整B5基线不能算本WIP验收。测试清理报错仅涉及其自有临时目录；未递归删除该残留或用户目录。

## 重新授权后的原下一步

先实际周用量/Git/适用AGENTS，再读本停止记录和B5、原锁区B1–B4/绑定设计、原凭证/网络/生产任务合同。保留此WIP，先查5项新超时与旧槽/进程失败及本轮新增afterEach资源生命周期；不放宽原5秒/最多4 worker/断言/能力，修复后完善原B6自有TLS/撤权版本、真实写后回滚/预算恢复/并发历史出口。相关单元/集成/Chrome/6构建全部通过才标B6完成，不制造新目标或无限纯草稿。

后续仍为原returned候选与完整source-mask SQL外像素核验、版本不可变产物、独立保护费用及严格公开谱系/缓存/画布回流。Google原mask能力/极性不放宽，旧none/local/ordinary restore/包副本不造许可，已核账无图不得补图改结论。全部一致验收前保护UI仍关闭，不跳过阶段4进入MCP6/视频7。

日常真实执行仍关闭，真实供应商/公网SSRF路由防火墙/生产保险库ACL备份/真实价格账单/生产会话、阶段4及完整项目未完成。未读用户钥匙/环境/保险库、建生产根、导入真实凭证价格账单、供应商DNS网络付费、账号外发/推送部署或主动重启5173；实际供应商/模型/金额/根/凭证和最低成本请求必须具体另授权。
