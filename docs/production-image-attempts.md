# 6D4B 首次活续接、实际尝试与原响应任务事务

最新集成：6D5已本地验收，见 [production-image-native-execution.md](production-image-native-execution.md)。实际首次任务续接已能通过默认关闭的内部配置联合6C凭证guard与6B原生HTTPS；本文件传输/存储原语仍不独立授权任务。production拒绝local-driver，零费用验收只有独立合同命名空间/自有驱动，未启用供应商网络或读取用户秘密。下方为原验收时点，旧“无生产接线/下一步6D5”仅历史；当前下一步为权威生产产物，真实供应商/公网/保险库/费用/UI未验收。

日期：2026-10-04（上海）。范围：独立生产任务的尝试/原响应事务底座已通过本地零费用验收；与6D4A组成6D4本地底座。真实供应商、生产Worker/网络接通、产物和真实费用及阶段4整体仍未完成，日常真实执行关闭。

## 默认关闭与首次活续接

`productionImageResponsePolicy` 必须是显式同一实际SQLite存储实例的可信同步政策，且存储显式支持原包。缺省、不同实例（即使同路径）、Promise/拒绝的Promise、非true、私密异常均在私有快照/原包读取前失败关闭。不复用本地确认、租约、mock成功费用或6D2的pending创建证明。

`ImageProductionReconstructionHarness.executeFixture` 是独立production-contract-fixture入口，仅接受显式responseHandlingEnabled、contract-fixture/realExecutionEnabled=false零费用端口、同库内核/租约/启动政策。ProductionImageTaskReconstruction不能用这个入口发送或消费假端口；production/native-https仅是独立合同命名空间，尚无可执行生产接线。没有HTTP、日常桥接、钥匙/根/DNS网络配置或供应商探测。

只有实际首次权威重建和同库启动的内部活流程能够续接：原完整确认/准备、实际job/key/batch、原领取人/worker/lease、原not-connected意图、活期限、当前tenant/project/run:read/run:execute/provider:read/asset:read、完整连接能力修订、权威原图/蒙版SHA/尺寸/大小/顺序与原约束、原价格verify及预算均核验。归一化外SQL锁，实际三协议请求/wire SHA/长度/Content-Type/真实boundary/转换逐项匹配原确认。价格scope保留原创建人，只verify原依据，不重新read询价。

内部pending尝试证明绑定实际重建的完整指纹、操作者和AbortSignal；仅活期间存在。回调前同一任务事务提交attempted/指纹/实际身份/审计，SQL写后再查权限、价格、期限、取消/时钟/漂移；失败整体回滚新attempt，不调用回调，原意图/确认/预留保留。attempted是写前记录，不保证回调运行或供应商接受。不能从B1摘要、A纯对象、客户端confirmed或单独B2 started=true返回值事后补建许可。

回调实际调用之前及其assertCurrent检查当前实际任务/原租约/原价格/权限、任务超时、请求正文SHA及全部wire元数据不变，结束/取消后guard永久关闭。可信端口忽略guard、自行联网或复制数据不被JS沙箱阻止，不宣称任意可信代码无法绕过政策；后续必须使用受控原生客户端和凭证guard。

## 原响应、未知预留与恢复

同一实际store/kernel外层统一SQLite任务事务保存原包BLOB/完整记录/双表标记、私有任务result/指纹/审计以及billing_unknown/unknown账本与maxCostMinor预留关系。嵌套savepoint不分裂提交；写后故障/撤权/容量不足回滚整份新原包与任务响应，原attempt及预留不删除。不覆盖原包，不补发、自动重试、换模型或自动成功结算。

迟到的当次返回使用原确认连接、原尝试时间与原完整关系解析；报价/租约过期或目录停用不抹掉原证据，也不创造新发送授权。当前读取/执行权限、权威输入/约束和预算仍查。已经明确到期恢复unknown的任务可追加原当次响应，但不改原finishedAt/未知原因或追加第二笔unknown账本。

普通返回、坏图、传输/超时/无效响应及可保存的原包失败中断，都进入或保持billing_unknown，max预留含zero-cap关系不释放；manual-budget估价仍null/unknown，不补0或上限。权限/存储/元数据故障也阻止中断保存时，原attempt/running或既有unknown及max预留保持，不能声称新unknown已保存；后续仅明确reconcile按持久化期限保守恢复，不自动重发或把失败当未收费。旧mock/local取消释放/执行/重试/已知费用自动成功和旧生产核账仍拒绝。

一致重复/竞争/重启仅原身份和当前权限下只读恢复，既有意图即不补建attempt；不重新归一化/解码、price verify/read、启动或发送。重复内部写入无私有活证明仍拒绝；不能将只读历史变成重放提交权限。SQLite构造/普通读不隐式重排其他进程任务，内存显式崩溃恢复保守unknown。

恢复联合检查完整原准备/确认、租约历史、意图、attempt/result全部指纹与时间、实际任务/审计/账本/预算；returned还加载并重解析整份原包，比较完整outcome/记录。缺正文/标记、孤立raw行（即使删除全部任务响应字段）、部分重算SHA、跨身份或估价/预留损坏失败关闭。全库一致伪造/备份回滚无外部签名/反回滚保证。queued/not-connected/attempted/interrupted单独都不是5A产物许可；pending-validation候选未验完整解码尺寸或锁区。

## 有界资源与不变项

总等待默认5秒、可调低但最多30秒；同进程重建/续接两槽，端口promise未结清即使超时也占槽，不以取消腾空无限后台操作。取消不能强制停止不合作端口、同步SQL或native解码；原共享完整解码两槽不变。借出wire/原图/自有raw及候选副本尽力清零，不修改端口返回的原件，不保证JS/native/可信回调副本可靠擦除。错误只固定白名单，不透传供应商私密异常。

attempt/result/指纹、审计和unknown账本计共享16MiB逻辑元数据，单份512KiB；原文件合计64MiB读前拦截，原包32MiB与原图/生成图共用项目512MiB，输出20MiB/8192/1600万像素。SQLite仍v7，ICRD1不变；不删除历史、提高配额或称全数据库/WAL/磁盘硬限制、跨进程全局闸门或生产资源沙箱。auto/4096平方/pixel-exact/product.pixels拒绝、旧商品锁/单位假价/用户记录/幂等摘要/配置指纹保持。

## 验收与下一步

新增77项单元/集成覆盖三协议known/unknown生成编辑、回调前实际attempt、原包与任务同实例事务、权限/身份/命名空间/同库/严格同步、并发/重启/单独B2历史不补发、晚回/停用/原到期unknown保持、SQL写后故障/撤权/到期/价格/取消/时钟回滚、容量、zero-cap、坏包坏图/超时/不合作槽、guard关闭/wire漂移、原包/任务/审计/账本联合损坏和旧路径。全部自有假oracle/临时SQLite/零费用端口，不写用户状态。

首定向52中1项失败为并发第二次续接未只读恢复，已修复不重建发送。相关348中旧B2两项错误文案断言失败，保留旧入口文案；64中1项将关闭的内部写政策误当重放提交许可，改为断言拒绝且历史完整保留。首全量1274中两项多组合用例超过5秒，拆为独立组合保留全部断言，不调全局超时/吞错/用重试掩盖。第二完整1283/100/6通过；随后补attempt写后取消/时钟守卫，最终完整`pnpm check`：**1285项单元/集成（46文件）、100项Chrome、6个工作区构建全部通过**。新Chrome仅6次未开放活续接GET/POST404、预算及真实闸门不变，不冒充生产UI/实际供应商。浏览器期间源码全程冻结，Zod/NO_COLOR非致命警告保留，未改依赖或重启5173。

下一步6D5默认关闭的实际生产凭证guard/固定地址HTTPS接线与自有本地验收。先读本文件、原响应/意图/确认/协议/准备/租约及encrypted-image-credentials/native-image-network/image-egress-contract/phase4-provider-plan/automatic-progress和outputs最新记录。只沿实际首次活重建/attempt，不接受本轮返回对象作为发送许可；生产必须完整服务端政策、server-pricing及独立生产证据，不能把本轮contract-fixture端口或确认改标成真实供应商，也不能用null补0进入legacy出站合同。

使用原加密凭证明确根/引用/版本/连接修订及请求实际payload范围，读取前后和实际HTTPS before-write检查有效原attempt/租约/权限/价格/预算和credential assertCurrent；只显式可信配置，默认关闭。原生客户端保持全A/AAAA/固定地址/证书/SNI/无代理重定向重试/有界取消，不放松公网政策去连回环；独立自有DNS/TLS驱动及随机根/秘密仅零费用测试，不冒充生产公网SSRF/网络或保险库验收。不读取用户钥匙/环境/文件/系统保险库，不创建生产根、导入真实凭证价格或探测供应商。根/凭证配置、供应商/模型/金额与最低成本真实请求仍需用户另授权；权威产物/真实费用/生产确认UI及原专项随后按冻结计划，MCP阶段6/视频7。
