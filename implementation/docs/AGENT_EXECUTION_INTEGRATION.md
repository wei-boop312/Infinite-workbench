# 本地Agent执行授权接线

2026-11-10，FR-10 / TASK-19/20 / T15 LOCAL_PARTIAL。本文记录当前后端单action实现；不是完整Agent工具循环或界面验收。

## 明确授权与模式隔离

旧review_only/local-agent-review-v1保持仅审查。新建local_resize_execute/local-agent-execute-v1授权、提案及L1审批后，才可调用新的执行入口。共享既有不可变授权表，但解析器校验各自mode/policy，列表/游标绑定模式，跨命名空间拒绝；旧记录不自动升级。新执行UUID统一小写，旧审查请求hash保持。

工具仅为固定local-comfy-resize-v1，供应商费用0 USD，不含模型、任意URL、Shell、删除、覆盖、发布或支付。L0不能执行；L1逐提案校验hash与nonce；L2/L3仅在明确授予的固定来源/工具/期限/次数/像素范围内执行，不代表无限授权。

## 原子消费与快照

LocalAgentExecution.execute在同一db.asActor事务内核对当前编辑权限，锁budget后锁grant state，验证完整提案/授权/当前来源/能力/期限/撤销及审批。createInTransaction写入schema3 snapshot、run、outbox，再插入不可变agent_execution_consumptions，一起commit或rollback。消费记录唯一project/proposal、project/run，以及非空project/nonce，L1 nonce通过复合FK关联原审批。SQL触发器额外核对明确执行mode/policy、L0、撤销、期限、主体、审批及快照参数/绑定/消费身份。消费插入失败不会残留run或outbox。

schema3 agentExecution冻结consumptionId、grantId、proposalId、对应hash、approvalHash、nonce与policy；原手工schema1/2和requestHash不改。Agent requestHash另包含完整消费pin，不能撞成普通手工run。相同固定执行ID与完整参数重试只返回原receipt/run，已撤销后也可确认旧回执，但当前编辑权限仍需满足；不会重新入队。换ID或参数复用已消费提案拒绝。

HTTP返回creationState=queued表示创建时状态，实际状态必须读取GET /runs/{id}，不能把创建回执称为提交或成功。

## 执行前检查与提交边界

LocalResizeWorker先preflightStart，避免为已阻断任务启动运行时或读取输入。启动后claim重新校验；beforeSubmit再校验：原actor当前编辑权限、消费记录与快照关系、授权mode/policy/hash、能力配置、来源当前修订、期限及撤销。未消费或伪造pin不能启动。

beforeSubmit持久submitted意图成功是提交边界。撤销先于此边界阻止新POST许可；此边界已先完成的任务按已提交处理，尽力取消/核查，不能承诺撤回已发请求。原单次POST、unknown不重投、私有图像解码/hash/归档状态机保持。

撤销先提交grant状态并释放grant锁，再调用原run取消事务，避免grant→既有run与worker run→grant形成反向等待。queued取消关闭outbox，submitted请求取消；ready成果不改写。当前角色不足等导致取消不可用会返回cancellationUnavailableCount，撤销本身仍持久生效；不擅自提高权限。已撤销且未消费的新任务被阻断；历史回执确认不是重新授权。

## 归档与兼容

已提交结果的纯归档恢复不重跑active授权检查，不发生成请求；当前有权限的其他编辑者可凭已验证缓存归档，原actor撤权/降为只读不抹除历史证据。旧schema1/2手工流程保持。新schema3用量识别固定本地零供应商费用并校验能力与Agent pin。

019新增消费表与审批nonce复合唯一约束，不改旧payload。写入新执行模式后，旧schema18审查列表解析器和worker不能保证识别新模式/v3；优先前向修复，降级需要按私有备份恢复并核对升级后新增数据，不能声称无损二进制回滚。

## 证据及未完成范围

65项七文件专项通过，包含并发重试单消费、消费写入故障全回滚、L0/L1/L2/L3、旧review不能升级、nonce/hash、来源/权限/能力/过期/撤销、提交后取消、HTTP隔离、UUID和伪造pin、阻断任务不启动runtime。六包构建通过。真实CPU+磁盘重开62568892-fc11-4845-8254-56219b08359c生成64×64、原件不变、各一消费/run/snapshot/outbox/attempt/output，ready后撤销保留成果；685cb617-75ff-4b93-b988-a1ea7ec0f510注入归档故障，撤销并将原actor降为只读后由另一编辑者成功恢复，未二次生成。原手工浏览器CPU回归a6c937ed-e712-4c82-a78a-bb041bb8fdf5通过。

PGlite为真实PostgreSQL WASM但不是原生多连接并发证明；本轮没有提高超时/worker或修改断言掩盖失败。初始类型推断、夹具画布base、RLS拒绝代码、HTTP本机header夹具问题保留失败日志，未为通过增加权限。

待办：用户可操作的授权/提案/审批/撤销界面、有限Agent工具循环与完整审计/纠错额度、真实模型/云图及完整T15/五场景、原生PG多连接压力和性能。已写后端不等于完整FR-10完成。全量测试正在运行，019尚未升级日常库。

最终冻结：全量92文件3001项全部通过（298.52秒），原测试期限与4worker不变；准备日常库备份升级18→19。

部署终态：日常服务已备份核对后升级18→19，1163文件/44既有表保持，入口200。接下来补按授权提案与消费回执读取及操作界面，完整Agent循环仍待。


## 操作界面阶段更新
新增按授权GET提案/消费回执（最多8项、原主体/项目/模式隔离），workspace-agent面板支持明确新授权、提案、审批、执行、撤销、任务/成果读取与服务端重开恢复。写前固定intent按用户/项目持久，无自动POST；未知结果明确重试，拒绝记录可导出/明确清除。viewer可撤回旧授权。25专项、六包构建、12条本地浏览器、独立viewer补测、真实Agent CPU界面与原手工CPU均通过；全量及日常刷新待终态。有限自主循环/完整工具审计仍未完成。

界面最终冻结：92文件3002项全部通过（295.81秒），六包构建/12条浏览器与两条真实CPU路径通过，准备schema19→19备份刷新服务。

界面部署终态：67608df已备份刷新日常服务，schema19保持，1171文件/45既有表核对一致，入口及模块200。后续核验多授权pending目标定位、提交前丢请求/来源变化拒绝与中文错误说明，有限自主循环仍未完成。
