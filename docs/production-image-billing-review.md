# 6D7A 实际生产任务只读核账快照与费用来源核验

2026-10-04 23:04（上海）本地零费用验收通过：完整 pnpm check 为1498项单元/集成（48文件）、104项Chrome、6个工作区构建。新增60项核账单元/集成、1Chrome；原12组三协议HTTPS组合将首次发送与已提交历史分开，保留全部断言，额外12项。冻结的生产核账原项有限拆为A只读核验/B同库结算及第二人超额审批，不新增最终功能。A完成，B、真实费用、生产确认UI、真实供应商与阶段4整体仍未完成，日常真实执行关闭。

## 独立权限与默认关闭

ProductionImageBillingReviewService及独立ImageProductionBillingReviewHarness默认关闭。必须显式billingReviewEnabled、租户、同一实际SqliteRunKernelStateStore/kernel、原包/产物存储开关和独立同步run/provider/asset政策。生产仅server-billing来源端口，production-contract-fixture仅contract-fixture/realExecutionEnabled=false；标签不能把夹具原任务改标生产。同路径的另一store不能代替同一实际实例。

私有任务/原准备、原图、原包或产物读取前后要求tenant/project/run:read/run:reconcile-billing/provider:read/asset:read严格同步true；Promise、truthy值、缺配置或私密异常均失败关闭。核账人可以是另一名独立获授权身份，不需要run:execute/asset:write，不借用原领取人的权限，不改原actor/worker/lease，不生成发送许可。没有HTTP、日常UI、用户账单读取器、真实费用来源实现或结算接线。

## 当前实际证据

inspect只接项目/批次/任务编号。实际同库快照经当前内核纯完整恢复校验，联合核对原完整生产准备/确认/job/key/batch、原领取人及运行租约历史、永久not-connected意图、持久attempt/returned或interrupted关系、审计/unknown账本/项目预算与max预留含zero-cap。纯恢复校验不读SQL、不恢复租约或保存任务；当前实际内核另核配置租约时长、任务超时与项目预算配置，不能用只读默认期限覆盖非默认设置。

要求实际billing_unknown，不把queued/leased/running或客户端schema/confirmed当核账依据。原准备完整指纹、权威输入/蒙版顺序、尺寸/字节SHA、完整收据与原约束逐份核验；原输入64MiB守卫保持。实际原包presence/记录/正文SHA重解析全部原结果，已提交产物presence/BLOB/收据/谱系/目录/任务/候选SHA联合匹配。不重建wire、归一化或完整解码，不重新verify/read价格、询价、重排或发送；历史报价过期或目录停用不抹原证据，也不授权新消费。

后续BLOB读取后再次核当前原输入/约束及任务指纹；删掉全部任务响应字段、重算有效未知恢复关系后也不能忽略孤立原包。缺/乱标记、正文、审计、目录或部分重算SHA失败关闭。全库一致伪造/备份回滚没有外部签名或反回滚保证。

返回的内部快照冻结完整实际任务链指纹、币种、原max/预留、独立known/unknown估价、已提交输出编号与原运行身份，不含prompt、地址、凭证引用、wire、原执行key、Base64或临时URL。它不是公开HTTP合同或当前发送/产物许可。

## 人工期待与可信来源

verify严格接受原快照SHA、币种、原预留/上限期待、动作编号、人工charged/not-charged及整数安全实费、来源编号/版本/证据引用/SHA和人工观察时间。引用是有界内部编号而非URL或账单正文；观察时间不得早于原unknown或晚于当前可信时刻。manual-budget仍unknown/null，不补0或上限进入旧数值quote/GeneratedImageRecord。

独立同步可信费用端口一次核验完整当前上下文与冻结人工请求，传入自有深复制。来源标签、证据schema/SHA、usage缺失、好图/坏图/超时或客户端已核账不能证明实际费用；只有部署方另配置的可信端口负责真实账单核验。本轮只自有假来源/假费用证据，没有读取或验收真实账单。端口后重新读取完整实际任务、当前权限/原图约束和预算，漂移、撤权、时钟倒退/未来时刻或容量失败拒绝；可信回调在事务内造成的受测漂移整体回滚，不是JavaScript沙箱或不可信插件隔离。

返回仅verified-uncommitted草稿，settlementCommitted=false/settlementAuthorized=false/execfalse/realfalse。超过原预留只标记requiresIndependentOverageApproval，不批准、不改批次或项目上限。A不持久化费用证据、审计或动作、不改变任务/账本/预算，不释放预留，重复/跨连接重启只读恢复相同原证据，不声称已完成实际幂等结算。纯A对象/SHA不可作为B提交证明；B必须从实际同库任务重读并独立核验来源。

## 原资源和旧路径

SQLite v8/ICRD1不变，无新数据库表、版本迁移或生产状态枚举放宽。共享16MiB元数据/单份512KiB、32MiB原包/512MiB项目、原输出20MiB/8192/1600万像素、原解码/准备两槽和执行期限保持；新核验是有界同步只读流程，无SQL锁内await。自有raw/candidate/产物读取副本尽力清零，不修改持久原件，不保证JS/native可靠擦除或跨进程全局硬闸门/生产沙箱。未删除历史腾空间、调高容量或更改旧商品锁/假单价/幂等摘要/配置指纹/用户记录。auto/4096平方/pixel-exact/product.pixels拒绝保持。

旧resolveBillingUnknown/requestBillingOverage/reviewBillingOverage及mock/local自动成功、生产取消释放/重试仍拒绝生产，未把A草稿接入旧核账。B真正结算前所有原unknown/max预留保持，包括0上限；产物与费用独立。

## 验收及失败记录

60项新增覆盖三协议生成编辑/knownunknown/有图坏图、独立核账人权限、配置及命名空间、完整人工期待、严格同步来源/秘密错误屏蔽、深复制、来源后撤权/原输入约束/任务漂移及事务回滚、历史过期停用、zero-cap/超预留不结算、同库重放/第二连接重启、原包/产物/目录/审计损坏、孤立原包、读取后清零、容量/时钟、实际配置期限与旧费用隔离。另1Chrome仅六次未开放核账/结算/超额GET/POST 404、预算及真实闸门不变，不冒充生产核账UI或真实供应商。

首次pnpm test --文件名未限制Vitest范围，实际全量1482项通过，未当作完整构建/Chrome验收；改用pnpm exec vitest run后58项/API构建通过，补2项后首完整1486中1485通过，旧6D5 openai/manual/edit组合在5秒内同时执行完整发送、预算读取与历史重放超时，构建/Chrome未运行。将12组首次活发送和已提交历史分成独立测试阶段、缓存同一次before-write快照，全部预算/原包/凭证/一次发送/历史不重发断言保留，原默认5秒hook/test及生产时限不变，没有全局调时限或靠重试吞错。相关191项通过，实际配置期限单项通过；最终完整1498/104/6全部通过，Chrome期间源码全程冻结。原Zod/NO_COLOR非致命警告保留，不改依赖。

全程仅自有假oracle/图片/费用证据、独立临时SQLite/4173零费用验收。无用户钥匙/环境/保险库读取、真实根/凭证/价格/账单导入、供应商DNS/网络付费、账号/外部消息/推送部署或主动重启5173。周用量开始6%/94%、22:41至22:52为8%/92%、22:56至22:59为9%/91%、23:04验收10%/90%；当前停止线周已用≥50%，原automation ACTIVE，定期读取共享额度不能保证零误差，不重置/购买/换模型。

## 下一步6D7B

在同一实际统一任务SQLite事务内，建立独立不可变生产费用证据/人工结论、任务状态、审计、账本、预算结算与差额释放及完整恢复，不接受A草稿、标签或旧local证据作许可。B默认关闭，独立当前核账权限/原任务链/权威原输入约束/预算及可信费用来源在实际写后复查，故障撤权容量回滚。超预留须不同人的run:approve-billing-overage独立审批，不提高项目预算、不改原确认quote/原响应或谱系。完整产物且人工核账后才succeeded，无图核账后failed；knownunknown估价保持，不自动重试或图/usage推断费用。

同步完善生产私有费用指纹、存档、公开聚合、原意图/attempt/raw/产物在已结算状态下恢复、通用预算守恒与幂等竞争，不能只改enum或放开旧核账。重复/并发/跨连接重启只恢复原结论、不二次结算；原领取人worker/lease不被核账人替换。只自有假费用端口/临时存储/4173零费用验收，不启用日常HTTP/UI或真实费用导入。之后生产确认UI、只读生产谱系/缓存/回流及原专项按冻结计划；具体供应商/模型/金额/根/凭证配置与最低成本真实请求仍需另获用户明确授权。MCP阶段6、视频阶段7。
