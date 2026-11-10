# 6D2A 独立生产发送前协议准备（未确认）

2026-10-04（上海）。6D2 的第一子步骤，**不是 6D2 整体验收、预算预留、生产任务或真实供应商接通**。入口 `productionImageProtocol.ts`；没有 SQLite、权限、价格读取、凭证、DNS、网络或 HTTP 端口。日常工作台未接线。

## 未知估价与旧合同隔离

`ProductionImageExecutionRequestSchema` 从 quote-free 原 draft 扩展候选 jobId/key 与独立生产报价。manual-budget 只有上限，严格禁止 estimatedCostMinor，包括 0、undefined 或上限值；server-price-table 必须有安全整数估价且不超过上限。字段名含 execution 不代表存在实际任务或执行授权。

人工期待合同 `ConfirmProductionImagePreparationSchema` 要求原整体准备 SHA、完整价格依据 SHA、币种、上限，以及 `estimate.state=known` 的精确估价或 `estimate.state=unknown`。manual-budget 不能提交 known，核验估价不能提交 unknown。不接受旧期待估价字段、客户端确认/授权布尔值或其他附加字段。比较期待摘要仍**不证明人工已核对或当前价格可信**。

三协议新增独立生产构造函数，复用相同受控字段编码、原图归一化与转换谱系，不给旧 quote 补价格。旧构造入口继续解析原严格合同；未知估价的生产请求不能进入旧入口。server-price-table 的原始请求结构可能与旧请求相同，类型或字段相同并不是命名空间/工作负载许可：后续统一任务事务必须验证完整服务端生产准备、独立确认及实际任务，而不能仅凭 request schema 或摘要放行。

6D1 的静态 validation-only 有效性标记也改用生产合同，不再在内存中伪造 estimatedCostMinor=0；该临时标记不是价格依据，仍不返回/持久化/预留。

## 纯协议准备及绑定

- 校验完整原服务端准备 schema、选择/basis/整体 SHA、原约束 SHA 和蒙版关系。价格范围、原人工选择、参数、输入顺序、输出和证据必须属于同一记录。内部 SHA 只证明一致性，不是对抗可整体重写受信数据库的签名。
- 候选身份严格采用 `production-image-job-UUID` / `production-image-execution-UUID`，不接受旧编号、原动作键或静态 validation-only 标记。这里不创建任务、检查编号是否已经占用或预留预算；必须由后续同库事务生成/冻结独立实际编号。
- 时间不得倒退到原准备之前，也不得达到价格有效期。三协议生产入口要求显式规格，单边 8192、1600 万像素，拒绝 auto、4096×4096 和 pixel-exact。原权威资产政策继续拒绝 product.pixels；供应商蒙版不是硬像素保护。
- 从指定收据取原图/蒙版，拒绝缺失、重复或跨项目编号；按原输入顺序完整归一化并记录原 SHA、实际传输 SHA 和转换版本。只复制所需原文件，首 await 前冻结，合计最多 64 MiB；失败或完成尽力清零自有副本，不修改调用者 Buffer。这不是浏览器/跨进程资源沙箱或可靠的 JS/native 擦除保证。
- OpenAI 使用原明确生成/编辑路径与 JSON 图片引用；中转按原显式 API root、端点、鉴权计划及 JSON/多段表单；Google 沿用已验收的固定 v1 / responseFormat 枚举、JPEG / INLINE，不静默换协议或模型。
- 返回的临时 snapshot 包含 mode、原准备/完整价格依据摘要、实际请求摘要、真实负载 SHA/长度/Content-Type、转换谱系与协议版本。多段表单摘要基于实际 boundary 和原字节，不用 JSON 描述冒充已发送内容。整体 snapshot SHA 包含命名空间与这些关系。
- snapshot 固定 `confirmationState=unconfirmed / executionAuthorized=false / realExecutionEnabled=false / protocolPreparation=prepared`。原数据库准备仍 `unconfirmed / protocolPreparation=not-run`，不被覆盖。临时 wire 含原图数据及私有地址/不透明鉴权引用，只用于内部准备，不进入浏览器、画布、项目包或账本；媒体画布仍只存 assetId。

## 刻意未提供的权限与事务能力

此模块接收的是可信服务器加载的原记录和权威原文件，不是可以直接开放给客户端的 API。它不读取当前目录、重新核验当前价格源版本、查询实际权限/输入/约束或可用预算。调用者给的时间、期待摘要、候选任务字段或 prepared snapshot 不能构成执行许可。归一化 await 期间可能发生撤权、价格过期或输入漂移，**后续确认服务必须在准备前/后及最终事务再次核验**。

本步骤没有改变 RunBatch/RunJob/账本合同；旧任务仍必须有原数值估价。不得为了接生产 manual-budget 把 unknown 填成 0、把 maxCostMinor 当 estimatedCostMinor，或直接调用旧 local 确认/自动结算。真实生产确认、原子预算预留及持久化任务快照还没有实现。

## 验证

新增 51 项自有临时 SQLite/假价格端口测试通过：三协议生成/编辑、已估价与未知估价、表单 boundary、实际 SHA/转换、摘要/币种/上限错配、过期/倒退时间、输入篡改/缺失/重复/跨项目、首 await 前快照、候选身份和旧合同隔离；准备后任务、预算及存档原准备保持不变。不读取用户秘密、真实价格或供应商网络。

完整 `pnpm check`：836 项单元/集成（42 文件）、93 项 Chrome、6 个工作区构建通过。新增 Chrome 只验证生产未知估价不能进入旧本地确认、生产确认仍 404、预算不变及真实闸门关闭。不是生产确认 UI、当前权限/价格事务、供应商能力、实际发送或计费验收。

## 下一步：6D2B 同库完整人工确认与预算/任务快照

1. 在现有统一任务层增加独立生产命名空间；实际 job/key/编号由服务端生成。完整原准备、输入/约束/连接能力/参数及价格依据属于同一实际人工确认，未知估价显式表达，不能放松旧 local/mock 合同。
2. 从同一实际 SQLite 实例读原准备，前后复查租户/项目/provider/run/asset 权限、当前目录修订、权威输入/约束，以及可信价格来源/版本/有效期/范围；verify 必须同步严格 true，确认不能重新询价或用 source 标签代替核验。
3. 调用本步骤的纯协议准备，在最终事务匹配实际 wire/转换/请求和完整确认；确认、maxCostMinor 一次预留、逐任务编号及不可变执行快照原子提交。两套存储或调用者自报 prepared/confirmed 均不能放行。
4. 重复/并发/跨连接恢复只返回原确认，不重建负载/重复预留；过期/取消的历史不是新授权。写后故障/撤权/漂移要回滚，预算竞争和 zero-cap 取消仍须守恒，元数据继续共享 16 MiB/单份 512 KiB。
5. 生产任务暂时只 queued/cancelled，旧 mock 与 local 执行、领取、超时、重试或已知费用结算明确拒绝。独立生产租约/发送响应证据、产物/真实费用在后续步骤验收。

仍只自有假价格、随机材料和临时存储零费用测试，不开放生产 HTTP/UI/网络。真实供应商/模型/金额、根与凭证配置及最低成本真实请求须另获明确授权；MCP/视频仍为阶段 6/7。
