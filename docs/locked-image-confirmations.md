# 原锁区B2：实际确认、独立请求身份与同库预算预留

2026-10-05 08:40（上海）本地验收完成。原硬锁区有限B的第二步，沿用[B1实际准备](locked-image-preparations.md)和[完整绑定设计](locked-image-task-binding-design.md)，不是新最终目标，也不是端到端锁区、真实供应商或完整项目完成。最终第二完整pnpm check：2051单元/集成（57文件）、192Chrome、6构建全部通过，新增70项/1Chrome。

## 默认关闭与实际权限

`LockedProductionImagePreparations`和独立`LockedImageProductionPreparationHarness`追加内部`confirmPreparation/getConfirmation/authorizeConfirmation`，生产仍只server-pricing、夹具仍只contract-fixture/realfalse。除原准备双开关、精确tenant及独立政策，还须显式`lockedConfirmationEnabled`、独立同步严格true的`lockedConfirmationPolicy`、同一实际store/kernel、新内核确认政策和原包/产物存储开关；缺失在私有确认读取前关闭。配置/端口函数身份捕获，不能await中交换store/kernel/价格函数。

确认读取前后provider:read、run:read、asset:read同步严格true，写入另run:create/run:confirm及原准备人。人工期待严格v2：原完整准备/价格SHA、币种、known原估价或unknown、原max及完整保护政策SHA。先同库重读实际准备、实际收据/原字节元信息SHA、输入蒙版顺序和完整原约束、原连接修订能力、原可信价格verify/范围/期限及实际配置预算币种；不重新read/询价，不把B1公开对象、A草稿/schema/SHA/client confirmed当许可。原价格scope保留原准备人。

`getConfirmation`另一独立获read权限者可用，不需create/confirm/execute/billing/assetwrite，不改原createdBy或任务身份。当前原输入约束/权限/实际预算仍核验，旧报价过期或目录新修订停用可读既有确认，不verify/read价格、native解码、重建wire、恢复租约、保存任务、预留/核账/释放或发送。返回只有有界历史编号、状态、非许可摘要与原币种/估价/max/预留，不返回aggregate、execution key/worker/lease/地址/鉴权/凭证/wire/raw/Base64/URL。

## 严格新身份与原wire

旧v1准备、请求、确认、local/mock合同保持原义；新增严格v2请求/协议/确认合同，完整原保护政策进入实际request与其SHA及确认/任务存档，不仅附标签。旧none确认无法事后添加政策升级，旧入口/未知版本不能吞字段或改标。

新命名协议入口只把明确定义的基础协议字段送入原编码器；完整v2 request参与请求指纹和compatible真实multipart boundary。政策/收据/像素摘要不成为任意供应商字段。SQL锁外用同库读取的原图/蒙版副本做原完整输入归一化和JSON/多段表单编码，保留原转换、真实wire SHA/长度/Content-Type。OpenAI按原transparent-edit极性，compatible按原明确profile；Google仍不能携带绑定蒙版而在B1价格前拒绝，不为凑三协议成功放宽能力或极性。

本步规范像素政策来自B1，尚未比较供应商输出锁区。固定autoOrient/sRGB/RGBA8并非原编码字节/ICC/高位深/品牌语义保证。不能把pixel-exact字段、prepared wire或完整请求SHA当发送或保护产物许可。

## 实际SQL事务与恢复

私有pending只匹配当次完整v2确认/操作者/实际wire及活单调时钟，结束移除；新内核默认关闭，直接重放确认对象或旧入口拒绝。SQLite v8原统一任务快照增加可选`lockedProductionImageExecution`，不物理迁移、不复用旧productionImageExecution或local记录，不改变原配置指纹/预算存储。服务端产生原生产命名空间job/execution/batch UUID，批次幂等空间独立`locked-production-image-confirm`。

完整准备/政策/请求/协议确认、实际queued job/batch、四条原确认审计、单笔reserved账本与max预留同一实际SQLite事务保存。manual仍unknown/null，不把max或0当估价/实费；zero-cap仍保留完整确认及零预留关系，无实费字段。预算不足整体回滚，不缩小上限或提高项目预算。实际SQL写后重新恢复核完整原准备与实际任务、确认/aggregate/指纹无漂移，再核权限/输入约束/price verify/币种/时钟/容量，受测回调副作用、撤权、取消、期限/容量/故障整体回滚。

重复、同库并发、另一实际SQLite连接竞争/重启恢复同一原确认和编号，不二次询价/verify/解码/预留/保存或创建新任务。恢复严格核原准备双表、完整政策/协议SHA、job/key/batch/四审计/单笔账本/预留与预算；删政策/确认/映射/审计字段、混入旧生产或本地证据、部分重算摘要失败关闭。B2仅queued，无租约/意图/attempt/raw/产物/费用；原包/产物开关不能关闭以绕过孤立证据核验。整库一致伪造或回滚没有外部签名保证。

旧领取/执行/重建/响应/产物/核账/重试入口不接此分支，旧通用取消也拒绝并保留max预留，不能套用旧生产或mock取消释放；受保护任务的后续政策与安全取消在原后续接线中完成。本步没有HTTP、公开人工UI、费用或发送路由。

## 资源与验收记录

原输入30MiB/份、64MiB读前合计、8192/1600万像素、16MiB共享元数据/单份512KiB、原准备1000份、原两槽/native时限/默认5秒最多30秒保持。新确认两槽/绝对取消及单调时钟，非合作协议/native工作未结清不释放槽，迟到不提交。自有原图/蒙版和wire副本尽力清零，不清调用者材料；非SQL锁内await、生产沙箱、跨进程全局硬闸门、强制native终止或可靠JS-native擦除，不删除历史腾空间。原32MiB原包/512MiB项目、20MiB输出、auto/4096平方拒绝、旧商品锁/假价格/幂等/用户记录和SQLite v8/ICRD1/IDB v4保持。

新增70项单元/集成、1Chrome。正向从头生产工厂仅自有假server-pricing known/unknown；协议/竞争测试仅独立contract-fixture、自有小PNG/蒙版、实际临时SQLite，兼容JSON/两种multipart。没有读取真实价格/账单、凭证、根或实际网络请求。

首API编译发现新存档映射误按对象而非原二元组、独立可选政策缺窄化，已按原格式/严格配置修复。首新47项、相关226项/API、补容量/孤立证据后相关281项/API通过；首完整2051项单元/集成（57文件）、192Chrome、6构建通过。随后复核补强已确认后只读撤权文案断言，明确失败：旧共用提示误称“未确认、预留或发送”。修为保留原准备编号只读核对、不授权发送，不以读取失败证明未提交；相关154项/API通过。08:40最终第二完整2051/192/6全部通过，不用首完整旧断言结果冒充最终验收。所有原断言/默认hook/test/生产时限/依赖保留，无重试/吞错掩盖；两轮Chrome期间源码均冻结，原Zod/NO_COLOR非致命警告保留。

新Chrome只验证三条未开放确认/历史/续接路由的六次GET/POST404、预算不变和真实false，不冒充保护UI或供应商验收。

08:40里程碑结束实际codex10080分钟周已用62%/剩余38%，低于新80%停止线，原automation继续ACTIVE。开始07:50实际57%/43%，之后58/59/60/61%逐次检查；每次开始/结束/约10分钟实际读取，remaining<=20%或不可读即停止新开发、安全保存报告暂停，不因下周重置恢复，须人类明确授权，不重置/购买/换模型绕过。账号共享取整/周期检查不保证零误差。

## 下一步与未完成

原受保护任务租约/意图/attempt/returned整包活续接及原max预留/unknown恢复仍未实现，当前全部后续入口关闭。沿同一实际完整v2准备确认/job/key/batch及新保护政策接原领取人worker/lease、当前权限/权威输入约束/price verify/原wire与预算，不接受本B2对象/纯schema/SHA补建许可。随后SQL外从returned原包核候选和原源图蒙版锁区，自有原图不可在像素核验前清零；版本化保护证据与原输出BLOB/收据/双表/目录/任务/指纹/审计原子保存恢复，缺证据/孤立raw/费用字段损坏关闭，历史不重处理/报价/发送/核账，不自动成功/重试/释放unknown，已核账无图不补图改结论。

再接严格公开保护谱系/原图、独立生产缓存冻结身份和IDB原子保存、有界画布保护观察、完整/轻量迁移/撤销重做/引用保护/包副本imported-copy-history。全部一致验收前不开放显式保护UI，旧local标记/ordinary restore/复制新id不能造许可。不重复A/B1/6A–6D9/local闭环或无限设计草稿，不跳过阶段4推进MCP6/视频7。

真实供应商接受、公网SSRF路由/防火墙、生产保险库ACL/备份、真实价格账单/生产会话未验收，阶段4及完整项目未完成。仅本地自有零费用，未读用户钥匙/环境/保险库、建生产根或导入真实凭证价格账单、供应商DNS网络付费/账号外发/部署推送或主动重启5173；具体供应商/模型/金额/根/凭证及最低成本请求须另授权。
