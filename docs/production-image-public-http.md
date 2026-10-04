# 6D8A 独立生产公开准备/确认合同与关闭式 HTTP 接线

2026-10-05（上海）。冻结的生产准备/人工确认项有限分为 A 公开合同与服务接线、B 实际人工确认 UI/只读指针恢复；没有新增最终功能。此入口只描述 A，**不是生产 UI、供应商价格/生成验收或阶段4完成**。日常真实执行关闭。

## 独立合同与服务配置

`ProductionImagePreparationPublicSchema`、`ProductionImageConfirmationPublicSchema`、`ProductionImageConfirmationHistorySchema` 与旧 local-fixture 合同隔离。manual-budget 估价保持 unknown/null，只展示独立 max 上限，不填0或上限；server-price-table 保留原安全整数估价。公开价格字段白名单保留来源、依据/时间规则，完整私有价格依据 SHA 只作期待摘要，不重新算公开子集 SHA 代替它。

准备包含原服务端冻结的完整约束、设计指令、连接公开能力、原图/蒙版 SHA/尺寸/字节/顺序及原参数；原记录仍永久 unconfirmed/execfalse/realfalse/not-run。确认只包含实际批次/任务编号、输入/输出编号、状态及金额的白名单，不返回 RunBatchAggregate。原 execution key、worker/lease、私有连接端点/鉴权/凭证引用、wire/raw、Base64 与下载 URL 均不在新合同中。payload SHA/长度/Content-Type 和转换摘要不是正文或发送许可；schema/hash/client confirmed 不是实际服务端许可。

`ProductionImagePublicService` 默认无配置拒绝；显式 publicPreparationEnabled=true、精确租户、同一实际 SQLite store/kernel、同库 ProductionImagePreparations 及同步权限端口才可用。原包/产物存储开关必须显式启用，不能关掉原包读取从而忽略孤立证据；这些存储开关不配置发送/产物/费用政策。独立 ImageProductionPublicHarness 只接原 contract-fixture 准备服务，不能改标生产；生产仍只接受原 server-pricing 工厂。没有新增价格/供应商配置写入口、凭证读取器或执行器。

每次私有读取前后严格 tenant/project/run:read/provider:read/asset:read 同步 true；准备另需 run:create，确认另需 run:create/run:confirm 且原准备人。Promise/truthy 不算许可。只读确认可由另获读取权限的人使用，不借 run:execute/asset:write/核账或确认权限，不改原领取身份。内核仍以实际原准备、连接修订能力、权威输入/约束、原完整可信价格 verify、币种/预算和内部活 pending 做新确认原子提交，不接受公开对象作证明。

## 明确注入才存在的 HTTP

只有 createApiServer 的 productionImagePreparations 明确注入本服务才处理以下路由：

| 路由（均在 /v1/projects/:project） | 方法 | 含义 |
| --- | --- | --- |
| /production-image-preparations | POST | 创建/恢复原独立准备，不预留预算 |
| /production-image-preparations/:id | GET | 原完整冻结准备只读视图 |
| /production-image-preparations/:id/confirm | POST | 原完整期待人工确认、同库一次 max 预留 |
| /production-image-preparations/:id/confirmation | GET | 严格只读确认或明确 null；不是重发/重确认 |

默认 API 与未改接线的日常 Vite bridge 仍404。尝试/原包/产物/费用/发送没有日常路由。所有返回 private,no-store、Vary Authorization、nosniff/same-origin/no-referrer；无查询或 Range。身份同步核验，精确路径/方法，GET 无正文；POST 严格 JSON UTF-8、不接受压缩，准备128KiB/确认16KiB、最多4096非空分片、绝对30秒正文期限。超限整体拒绝/断开，不截断后继续创建；响应512KiB。固定错误代码，不透传未知异常 message/cause 或堆栈。不是生产会话、部署 ACL/CORS/路由或互联网安全验收。

## 实际历史核验

GET 在同一实际任务 store 的只读事务内恢复完整实际原准备/确认/job/key/batch、原租约/领取人、永久 not-connected 意图、attempt/result、审计账本/预留/预算及独立费用结论；实际配置的租约/超时与预算也核验，不用默认期限覆盖非默认配置。核验当前原权威输入/蒙版字节 SHA/尺寸/顺序/收据/完整约束；原包双表标记及完整原始字节重新解析，与原结果匹配；产物 BLOB/收据/谱系/目录、候选实际字节 SHA 与原链联合核验。纯 pending-validation 不当合格图。

读取后再核全部原链/权限/输入约束及实际快照无漂移；受测回调写入/撤权/损坏失败关闭，回滚该读事务内副作用，清自有原包/候选/原图副本。删除全部任务响应字段但留下原包、产物标记/正文/关系损坏均拒绝，不能假装未确认。完整库一致伪造/回滚没有外部签名/反回滚保证，可信回调不是沙箱，字节清零不是 JS/native 可靠擦除。

报价过期、目录停用、已取消、unknown 或已独立核账历史仍可恢复，但当前权限/原输入约束/预算必须通过。历史不重新 verify/read 报价、不归一化/解码输出、不恢复租约、不保存任务、不再预留、结算或发送。未发送取消没有测得实费时不补 actualCostMinor=0；人工结算后的 actual 与原 nullable 估价分别保留。

确认 POST 的核心原子写后复查/回滚保留。HTTP 响应丢失或后续公开视图/权限失败，不能推断确认从未提交；B 必须在任何 POST 前保存有界只读指针，失败不 POST，响应不明只 GET 恢复、不自动 POST/重预留，关闭/项目切换/StrictMode 隔离旧回调。本步没有实现浏览器按钮、指针或人工核对界面，也不声称已验收这些行为。

SQLite v8/ICRD1、16MiB/单份512KiB元数据、64MiB输入读前、32MiB原包/512MiB项目、20MiB输出/8192/1600万像素与原并发/取消保护不变；auto/4096平方/pixel-exact/product.pixels 仍拒绝，旧 mock 商品锁、假单价、幂等、配置指纹与用户记录保留。没有 SQL 锁内 await 或删除历史腾空间，非跨进程全局资源硬闸门。

## 本地验收与下一步

只用自有假 oracle/图片/费用证据、独立临时 SQLite 与自有回环 HTTP/4173 Chrome。包含三协议 known/unknown、编辑实际原图顺序、生产工厂从头构造/模式隔离、并发/跨连接一次预留、严格权限/HTTP界限、实际写后回滚、unknown/取消含zero-cap/人工结算后的完整历史、原包/产物损坏和读取后撤权清副本。没有供应商 DNS/网络、真实价格/账单、用户秘密或真实付费。Chrome 新增仅日常关闭入口/预算/真实闸门回归，不冒充实际生产 UI。

首运行 Zod refined object 的 omit 在导入时报错，改为显式白名单并保留全部来源/时间规则；随后4项测试引用旧夹具错误，改实际嵌套 store 和提交实际产物；取消2项预期错误要求0实费，改断言实费未提供，不改变生产费用语义。相关回归与完整验收数见最新 outputs。

首完整1636单元/集成与6构建通过，Chrome105/106。旧模拟回画布测试在新批次POST返回前用旧“待人工确认”界面抓取批次编号：trace 的 inputValue 为 batch-da248…，实际确认/派发和两回流节点均为新 batch-c747…，节点没有 assetId、关系正确。修测试为等待实际本次 POST 响应并断言选择值等于它，再保留全部原批次/节点/谱系/刷新断言；没有改应用行为、放宽关系、调整超时或靠重试掩盖。

相关338项/API构建通过，修正旧等待竞态后定向Chrome通过；2026-10-05 00:45（上海）第二轮完整 pnpm check 最终1636项单元/集成（50文件）、106项Chrome、6构建全部通过，新增63项单元/集成与1Chrome。浏览器期间源码冻结，原Zod/NO_COLOR非致命警告保留。实际codex10080分钟周窗口已用19%/剩余81%，低于已用50%停止线，原automation ACTIVE；开始/里程碑结束/约10分钟检查，命中或不可读即安全保存停止并暂停，不因下周重置自行恢复，不重置/购买/换模型绕过。

下一步 B：实际生产准备/人工确认 UI 和严格只读恢复，先读本入口、image-confirmation-ui、生产准备/确认/协议及原公开目录合同。人逐项核对原设计/约束/权威输入/币种、known估价或unknown与独立max，并冻结原期待；任何 POST 前有界指针必须保存成功，响应不明只 GET，不复用 local 标记/动作。随后原只读生产谱系/原图缓存/回流与专项；实际供应商/模型/金额/根/凭证及最低成本真实请求仍须另授权。MCP阶段6、视频阶段7。
