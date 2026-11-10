# Agent执行授权接线设计与未完成门槛

2026-11-10。这是下一阶段实施设计，下面标“待接线”的内容尚未交付，不能作为执行权限或验收证据。

## 已核对的当前调用链

- HTTP持有可信session actor，LocalBoundRuns.create通过db.asActor进入workspace_app强制RLS事务。
- createInTransaction由服务内部调用方持有同一Transaction；不自行commit，不开启嵌套事务；核对当前actor与项目编辑权限。
- 现有创建顺序为预算行FOR UPDATE、同项目幂等run查询、不可变绑定/模板/工作流/源对象/资产核验、snapshot、run、outbox。全部在同一事务。
- 原手工requestHash仍是bindingId、parameters和local-resize-only-v1；快照仍v2，不从客户端接收authorization。
- LocalRunDispatcher从持久outbox枚举，串行执行；进程内observed仅避免反复尝试，不是持久审批消费或授权。
- LocalResizeWorker启动自有CPU运行时，claim后上传，编译/验证固定图，recordPreparation，beforeSubmit持久提交意图后才单次POST。submitted后的不明确结果不重投。
- LocalRunExecution.claim锁run；beforeSubmit锁attempt再锁run。归档/取消及预算结算有各自既有锁，不能直接在撤销事务持有grant锁后遍历锁所有run。
- 现有LocalAgentReview固定review_only，无run创建端口；记录同意不产生执行权。不能修改这些旧payload或让它们自动成为可执行授权。

## 待接线的真正执行路径

1. 新的明确执行mode/policy以及新授权、新提案和对应审批。工具仅允许固定本地零供应商费用resize，沿用来源/版本/参数hash和期限/次数/像素门槛。L0禁止执行，L1逐项确认，L2/L3须明确授予范围内执行权限。
2. 审批消费与run创建必须共享createInTransaction的Transaction：锁预算和授权状态、核对当前主体/范围/hash/期限/撤销、插入唯一消费回执、快照/run/outbox，一起commit或一起rollback。禁止先consume再调用外部create，也禁止先create后另写消费记录。
3. 每提案唯一消费记录；L1绑定新的审批nonce，不能复用review_only nonce。固定执行请求重试返回原receipt/run，换参数/提案/授权拒绝。Agent请求hash必须包含授权/提案/policy身份，不能与原手工键空间中的同参数run混用。
4. 新执行快照需明确版本并冻结grant/proposal/approval/consumption身份与hash；worker从DB校验完整关系，不相信单个payload中的authorized字段。旧v1/v2手工记录及原requestHash保持兼容。
5. claim与beforeSubmit都重新核对原授权actor当前编辑权限、授权有效期/撤销、当前输入修订、固定scope与配置能力。当前用户的permission不能由快照历史声明代替。
6. 给授权状态定义一致锁顺序。候选顺序：创建budget→grant→新run；worker既有attempt/run后再grant。撤销只锁grant并提交，再在独立事务请求现有run取消，禁止grant锁内调用cancel造成反向锁等待。需以代码与测试验证，不宣称已获原生多连接证明。
7. beforeSubmit成功事务是“已开始提交”的持久边界。撤销先于该边界必须阻止新的POST许可；该边界先于撤销，则任务按已提交处理、尽力取消/核对，不能承诺收回已发出的请求。绝不重POST来核对。
8. 撤销、过期或权限丧失不能破坏已就绪成果，也不能使历史固定版本失真。已提交的结果核验/归档恢复需保留，与新执行许可分开；恢复不能发起生成。
9. Dispatcher、用量统计、快照pin校验与归档恢复必须明确支持新快照版本；未支持时拒绝，不降级为手工执行。

## 已有事务故障证据与后续验收

local-run-transaction.test.ts覆盖调用方创建后抛错时完整rollback、最后outbox INSERT故障时无孤立snapshot/run、重试可重新创建、手工hash/去重保持、其他designer不能替换actor、viewer不能写。该测试不等同于nonce已经接入消费。

下一阶段必须实际验证审批消费后崩溃rollback、同nonce并发仅一个run/outbox、不同请求冲突、源变更、过期、撤销在claim前/claim后提交前、权限撤回、历史授权不能升级、已提交后撤销/归档、磁盘重开重试，以及自有CPU真实执行与原件/结果hash。最终再跑完整测试与构建，保留所有失败。完整Agent工具循环及真实模型仍须单独完成。
