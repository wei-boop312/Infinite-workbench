# 原锁区B3：实际租约、未启动到期恢复与安全取消

2026-10-05 09:39（上海）本地验收完成。沿[B2实际确认](locked-image-confirmations.md)与[完整绑定设计](locked-image-task-binding-design.md)，仅完成原受保护任务链的租约/未发送恢复与取消有限步骤，不是硬锁输出或项目完成。首完整pnpm check：2123单元/集成（58文件）、193Chrome、6构建全部通过；新增72项/1Chrome。

## 独立默认关闭政策与原实际身份

新增createLockedProductionImageLeasePolicy及独立contract-fixture工厂，必须显式lockedLeaseEnabled、精确tenant、同一实际SQLite store/kernel、独立同步严格true的lockedLeasePolicy与原包/产物开关。生产仅server-pricing verify，fixture仅contract-fixture/realfalse；不含价格read/询价、凭证/根/网络读取器或HTTP接线。捕获配置与可信函数身份，实际事务检查操作者/端口身份不能漂移；授权回调获得独立身份副本。

所有私有准备/目录/输入读取前后严格tenant/project/run:read/provider:read/asset:read。领取、检查和明确恢复另run:execute；安全取消另独立run:cancel，不借create/confirm/execute/核账/asset:write。只读历史可由另获read的人使用，不改原价格scope/准备人/运行领取人。检查先核实际job/原领取人actor/worker/lease，再读原输入；相同worker但不同actor不能冒用。

原实际v2准备双表、完整保护政策/请求/协议确认、job/key/batch/原审计账本与统一预算联合核验。当前完整原约束、原图蒙版SHA/尺寸/字节元信息/收据/顺序和绑定须一致；权威目录声明30MiB/份、64MiB合计、8192/1600万像素在任何收据/BLOB getter前守卫。当前动作核完整连接原修订能力与原可信价格verify/范围/期限，保留原准备人price scope，不重新read报价。规范像素只沿用B1原政策，本步骤不native解码/重建wire/比较候选输出，不把schema/SHA/租约当发送许可。

## 同库租约、恢复和预算守恒

内部claimLockedProductionImageBatch、inspectLockedProductionImageLease、reconcileLockedProductionImageBatch和cancelLockedProductionImageBatch无HTTP。独立严格v2 lockedProductionImageLeases绑定实际确认指纹、完整原保护政策指纹、实际领取人/worker/lease和期限；在原统一任务快照追加可选JSON字段，SQLite仍v8，无物理迁移/新预算库。租约/实际job字段/job-leased审计同库保存，原job/key/批次/确认与known或unknown-null估价不变，max预留不变，zero-cap仍完整关系。

共享原项目/供应商并发、领取数量和持久时间窗，不另造调度许可，不生成batch-dispatched/job-started。普通构造、确认历史或预算读取不隐式重排新保护租约。明确reconcile仅未启动到期leased清活字段回queued，追加不可变到期审计；保留完整租约历史与max。重新领取须新当前政策/原price verify，过期报价不能新领取。

已领取活历史/已取消重复领取只恢复原结论，返回leases空，不恢复新租约/报价verify/read/解码/重建/保存/再预留。独立连接/OS进程实际同时领取只有一份租约，重启只读恢复原编号。历史报价过期/目录停用仍可读和明确未启动到期恢复/安全取消，不因此产生发送许可；当前原输入约束、严格权限与实际配置预算/期限继续核验，不用默认30秒覆盖实际非默认期限。

未发送取消仅允许queued/leased且全链证明没有意图/attempt/raw/产物/费用。job/batch取消、原正max的单笔释放账本/审计与项目reserved减除、含zero-cap的预留映射清除同库原子保存；原确认/政策/租约历史保留，不改原领取人。释放账本actualMinor=0仅为未发送预留释放记账，不在任务写actualCostMinor或宣称测得费用0；unknown估价保持null，原实费仍无结论。不同连接/进程同时取消只释放一次，重复不写入或二次减预算。

旧通用取消/领取/mock/local/旧production执行与费用入口仍拒绝新分支。以后意图/running/unknown任务不能继承此取消释放，当前严格状态核验仍只允许queued/leased/未发送cancelled。

## 实际写后核验、容量及损坏恢复

同一实际SQLite同步事务中保存后重读全实际任务与原准备，核当前严格权限/原输入约束/原价格及期限、预算币种/配置/容量和实际租约身份；最终全快照无漂移。写后撤权、时钟倒退/绝对期限或租约耗尽、故障、容量不足、输入/目录漂移和受测同库可信回调副作用整体回滚新租约/恢复/取消/预算，不删历史腾空间、不缩上限或提高项目预算。无SQL锁内await。

恢复联合核原完整政策/确认、实际job活字段、独立租约/原actor/worker/期限、完整审计/账本/max与预算。删确认/政策/租约/审计、部分改actor/期限并重算摘要、混入旧证据或孤立raw/产物均失败关闭；关闭原包/产物开关不能绕过。整库一致伪造/回滚没有外部签名保证，可信回调不是沙箱。

历史最多512份且合计512KiB，与原确认/审计/账本计共享16MiB；原30MiB/份/64MiB输入读前、32MiB原包/512MiB项目、20MiB输出/8192/1600万像素、原两槽/native时限、默认5秒最多30秒/单调绝对期限和auto/4096平方拒绝保持。此步仅同步租约事务，不增加native工作或发送槽；不能强制终止恶意同步CPU或宣称跨进程全局资源硬闸门/生产沙箱/可靠JS-native擦除。SQLite v8/ICRD1/IDB v4、旧v1-none/local/mock商品锁/假价格/幂等/配置指纹与用户记录保持。

## 验收与失败记录

新增72项：生产工厂known/manual unknown、兼容JSON/两种multipart确认历史、零cap、独立权限/原领取人、严格同步政策、原price verify失败、实际写后撤权/时钟/故障/目录漂移回滚、权威声明读前、共享并发时间窗、两SQLite连接和两个真实OS进程领取/取消竞争、重启/损坏恢复、非默认租约/过期报价停用历史、配置/操作者/端口漂移与旧路径拒绝。仅自有小PNG/蒙版/假价格和owned临时SQLite；从头生产工厂也只有假server-pricing，无真实供应商调用。

首API编译两处purpose漏参、一处新v2请求不符合旧资产编码器合同，补完整purpose和明确仅供原资产核验的v1基础字段投影，未放宽v2身份或旧schema。修后API及原B2/原租约265项通过；新增62项、相关132项通过。复核补权威读前/首无效时钟/活历史纯恢复/实际写后端口漂移后66/API通过，再补进程/同库开关/独立读者等，相关336项通过。最后补操作者漂移1项、活租约内真正过期报价恢复，最终72/API通过；首完整2123/193/6全部通过。不调时限/依赖/最多4 Vitest worker、不加重试/吞错，原Zod/Rollup/NO_COLOR非致命警告保持。

新增Chrome仅四条日常关闭租约/检查/恢复/取消路由8次GET/POST404、预算不变及真实闸门false，不冒充保护UI或供应商端到端。Chrome期间所有源文件冻结，193项全部通过后才编辑验收文档。

## 下一步和未完成

原受保护SQL外实际wire重建/not-connected意图/启动后unknown恢复，再attempt/returned整包的首次活续接仍未实现，无发送/响应/产物/费用/保护UI入口。只沿同一实际v2准备确认/保护政策/job/key/batch/原实际领取人worker/lease核权限/原输入约束/price verify/预算与完整原wire，不接受本租约对象/schema/SHA/A草稿补建许可；写意图后不能释放max或自动重试/成功。

之后从原returned包取候选，SQL外完整原源图/蒙版像素比较，保护证据/原输出BLOB收据双表目录任务指纹审计原子保存恢复；自有输入不可提前清零，已核账无图不补图改结论。再严格公开保护谱系/原图、生产缓存冻结身份/IDB原子保存、画布有界保护观察及迁移/撤销重做/引用保护/包副本imported-copy-history。全部一致验收前保护UI仍关闭；旧none任务不升级、旧local标记/ordinary restore/副本或纯builder不能造许可。Google原绑定mask不支持仍价格前拒绝。

09:39实际codex10080分钟周已用67%/剩余33%，未命中剩余<=20%（已用>=80%）停止线。开始/里程碑结束/约10分钟实际读取，命中或不可读停止开发、安全保存报告暂停原automation，下周重置不恢复，须用户再明确授权，不重置/购买/换模型，账号共享取整/周期检查不能承诺零误差。

真实供应商接受/公网SSRF路由防火墙/生产保险库ACL备份/真实价格账单/生产会话仍未验收，阶段4与完整项目未完成，不跳过进入MCP6/视频7、不无限追加。仅自有零费用临时存储，未读用户钥匙/环境/保险库、建生产根、导入真实凭证价格账单、供应商DNS网络付费、账号外发/推送部署或主动重启5173；具体供应商/模型/金额/根/凭证和最低成本请求须另授权。
