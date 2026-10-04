# 6D4A 独立生产响应解析与有界原包存储

最新集成：6D5已本地验收，见 [production-image-native-execution.md](production-image-native-execution.md)。实际首次任务续接已能通过默认关闭的内部配置联合6C凭证guard与6B原生HTTPS；本文件传输/存储原语仍不独立授权任务。production拒绝local-driver，零费用验收只有独立合同命名空间/自有驱动，未启用供应商网络或读取用户秘密。下方为原验收时点，旧“无生产接线/下一步6D5”仅历史；当前下一步为权威生产产物，真实供应商/公网/保险库/费用/UI未验收。

日期：2026-10-04（上海）。本文件记录6D4A时点边界；最新6D4B实际活续接/尝试与原响应任务事务已本地验收，6D4A+B本地底座完成，见[production-image-attempts.md](production-image-attempts.md)。真实供应商/生产Worker网络接通/权威产物与真实费用及阶段4整体仍未完成，真实执行关闭。下文“尚未写入实际任务”等为6D4A原验收时点，不覆盖最新6D4B状态。

## 已完成的边界

- `parseProductionOpenAiImageResponse`、`parseProductionCompatibleImageResponse`、`parseProductionGoogleImageResponse`使用独立生产请求/金额合同及生产任务/执行编号空间，再共享原已验收的纯响应算法。完整原连接+请求摘要必须匹配，不只比较请求本身。旧入口仍要求数值估价；manual-budget明确估价未知，不能补0、上限或混入legacy/local确认。
- `ProductionImageAttemptSchema`是独立严格attempted证据形状，绑定模式、租户项目、实际任务批次、原领取身份/租约、完整确认/意图/请求/wire摘要及尝试时间；production对应native-https标签，production-contract-fixture对应contract-fixture。这只是形状，**尚未写入实际任务快照或用于调用传输**。native-https标签不是原生网络调用证明，不能将假端口改标当实际供应商。
- `assertProductionImageAttempt`纯校验完整原生产确认、原租约、永久not-connected意图、尝试关系与原期限，不查SQLite实际任务、当前权限/目录/价格/预算。调用者自报或重算摘要不能跳过这些原关系，但返回对象不是运行、发送、凭证消费或5A产物许可。
- `parseProductionImageResponse`从完整原证据选择原协议；外层要求Buffer、原包≤32MiB、合法HTTP状态、1–256可打印ASCII的Content-Type、严格有界请求编号及ISO时间。原尝试必须在原有效期内；响应迟到可按原时间保存证据，**不构成新发送授权**。没有当前权限端口，后续服务必须在私有读取及事务前后复查。
- 原包记录含独立编号、原尝试/意图/确认指纹、原协议、状态/MIME/请求编号、接收时间、精确大小/SHA及解析outcome；不含提示词、私有地址、凭证引用、wire、Base64或输出资产编号。原BLOB可能包含供应商私有返回数据，只内部保存，未提供HTTP/浏览器读取。
- 有图只为pending-validation候选，最多20MiB且校验Base64/魔数；仍未完成权威完整解码/尺寸/约束/资产提交。新增Google正向候选夹具故意仅JPEG魔数，明确不证明1024×1024有效图片。三协议错误/URL-only/多输出/安全拦截/坏用量拒绝候选，不抓供应商URL，不自动选择输出、换模型或协议。
- 所有原响应billing=unknown；好图、坏图、缺usage均不等于零扣费或已结算。固定未知失败白名单不透传私密异常，不更新任务、账本或预留。`assertProductionImageRawResponse`重解析既有原包并比较整个记录/outcome与完整原关系，不仅比较正文SHA；拒绝后尽力清零自有候选，不改调用者原包。

## 默认关闭的底层存储

`SqliteRunKernelStateStore`增加显式内部选项`productionResponseStorageEnabled:true`；缺省读取/保存端口在接触原包前拒绝。没有HTTP、日常执行器、浏览器开关、钥匙或DNS网络接线。

SQLite v6→v7仅追加`production_image_responses`和`production_image_response_presence`，按租户/项目/模式/任务唯一，独立响应编号唯一。记录SHA与编号同步存在标记中；读取先校验存在关系、单份512KiB/原包32MiB声明长度，再读有界记录和BLOB，复查实际SHA/长度/归属。任一表/标记/正文/摘要损坏失败关闭，不假装无历史或自动重建。v7缺表、未来v8拒绝；v0–v6正常增量升级，旧用户记录/目录/原图/预算/配置保留，独立ICRD/v1不变。

保存要求已有同步外层事务，内部savepoint使正文/标记同存同回滚；外层故障也回滚。完全一致重放跨连接/重启保持原编号与原字节，冲突拒绝覆盖。容量满不删除历史：单份512KiB，与目录/准备/本地及生产响应/生成记录/任务私有证据共用16MiB逻辑元数据；原包、权威原图、生成图及既有本地原包共用项目512MiB。测试可显式调低，不能调高；不是整个SQLite/WAL/磁盘文件上限。

**这只是底层原包存储，不是6D4B的实际任务/尝试/响应/预算联合事务。** 本轮测试显式打开同一临时文件的独立连接，只验证原包存储一致性；不据此声称与内核任务同实例原子绑定。raw行、schema或fingerprint均不能给孤立响应创造产物授权，后续必须验证实际存档的完整任务链并使用同一store实例。

当前实际任务仍只有已验收6D3的not-connected意图/running或保守billing_unknown；没有持久化productionImageAttempt/result任务字段，没有回调、真实发送、响应任务审计、providerRequestId/输出资产或自动费用结算。maxCostMinor预留含zero-cap保持，旧mock/local路径继续拒绝生产。

## 本地验收记录

- 新增101项单元/SQLite集成：三协议生成/编辑与known/unknown、完整原摘要/身份/时间、迟到/坏响应、原包重解析、原文件副本、默认关闭、回滚/第二表故障、不可覆盖、跨连接重启、模式/租户项目、共享容量、损坏标记/正文/记录、v6→v7及未来版本。所有库与材料由测试自建临时目录提供，不写用户状态，不使用真实价格或秘密。
- 首定向276项中214通过/62失败：新入口错误地仅哈希请求而非完整原连接+请求，另有1处夹具把原图读取的`{receipt,body}`误当Buffer。修复完整摘要与夹具后，另一次构建发现未导出的ISO辅助schema引用，改为复用已有原包schema的时间字段，不放松日期合同；最终定向101/API构建通过。
- 最终完整`pnpm check`通过：**1208项单元/集成（45文件）、99项Chrome、6个工作区构建**。新增Chrome仅验证6次未开放原包/尝试GET/POST为404、预算及真实闸门不变，不冒充生产UI、实际发送、供应商网络/价格/计费或产物验收。Chrome期间冻结源码。
- 19:29（上海）周已用88%/剩余12%，高于当前0%停止线。原20%/50%仅历史；额度全账号共享且定期检查/取整不能保证零误差。未重置、购买或换模型。
- 未读取用户钥匙、环境或保险库；未创建生产根、导入真实凭证/价格、供应商DNS网络探测/付费、账号操作、发布/部署/推送或主动重启5173。旧商品锁/单位假价格/幂等摘要/用户记录/配置指纹保留，auto/4096平方/pixel-exact/product.pixels仍拒绝。原Zod/NO_COLOR非致命警告未改依赖绕过。

## 6D4A时点下一步（历史，已由6D4B验收完成）

先读本文件、production-image-dispatch-intents、confirmation/protocol/preparation/lease及原凭证/出站/原生网络/价格与冻结计划。不得重复本轮纯解析/存储或6D3。

需要独立默认关闭的同步可信政策，在私有快照/原包前核对实际租户项目/run:read/run:execute/provider:read/asset权限、实际完整确认/原准备/job/key/batch、原领取身份/有效原租约、not-connected意图、当前权威输入/约束/目录能力/原价格verify与预算。不能接受本轮纯对象或外部自报已确认作为提交证明。

必须在实际首次权威重建启动活续接内，于传输回调前同库提交attempted及完整指纹/审计；写前记录不保证回调运行或供应商接受。只有效首次续接调用一次，自有零费用端口只能contract-fixture；重复/崩溃/重启/超时不补发。当前B2启动没有可复用外部令牌，不能事后拿started=true返回值自证许可。

有界原响应BLOB/记录/标记、实际任务响应/审计与unknown/max预留在同一实际store实例、统一任务SQLite事务保存，写后故障/撤权/容量回滚，原尝试和预留不删除。迟到响应按原确认/尝试时间处理当次证据，当前权限及输入约束仍查；不覆盖原包或自动重试/成功结算/释放预留。存档/恢复/聚合和旧入口隔离应一起验证，部分重算摘要不能绕过任务链。metadata共用16MiB，异步传输/准备仍有界两槽，不在SQL锁内await；不是生产沙箱/跨进程资源硬闸门或可靠JS/native擦除。

后续凭证guard/固定地址HTTPS、权威产物/真实费用及生产确认UI按冻结计划推进；实际供应商/模型/金额/根与凭证配置、最低成本真实请求仍须另获明确授权。MCP阶段6，视频阶段7。
