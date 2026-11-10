# 6D5 生产凭证 guard 与固定地址 HTTPS 接线

日期：2026-10-04（上海）。范围：默认关闭的服务端接线和自有零费用验证；不是实际供应商、生产公网/SSRF/保险库或阶段4整体验收。

## 入口与实际任务许可

ProductionImageTaskReconstruction.executeNative 需要显式 credentialNetwork.sendingEnabled:true、EncryptedImageCredentials 的凭证开关/独立存储/根端口/同步政策/指定版本，以及 NativeImageNetworkClient 的网络开关/精确目标/同步政策；仍须同一任务SQLite内核/租约/启动/原包响应政策。没有缺省配置、HTTP、浏览器配置/钥匙入口或日常Worker接线。仅 start/reconstruct、B1摘要、纯schema或客户端confirmed/started不生成续接许可。

只有实际首次权威重建、同库启动和attempted写前提交的内部活流程调用一次；当前权限、完整原生产确认/准备/实际job/key/batch、原领取人worker/lease/永久not-connected意图、期限、当前连接完整修订能力、权威原图蒙版SHA/尺寸/大小/顺序/原约束、原价格verify和预算联合检查。server-pricing生产政策与contract-fixture假oracle隔离；本轮没有真实价格源。重复/竞争/崩溃/重启仍只读历史，不新重建/读取凭证/DNS/补发。attempted不保证供应商接受。

ImageProductionReconstructionHarness.executeNetworkFixture 只接受production-contract-fixture/local-driver/realExecutionEnabled=false；生产构造拒绝任何localDrivers。旧executeFixture/fixtureTransport仍独立，不能与新凭证网络配置混用或改标生产。ProductionImageCredentialNetwork本身是内部传输原语，不独立读SQLite许可；它依赖活流程私有实际任务guard，不是允许调用者传任意对象的授权服务或脚本沙箱。

## 凭证与协议绑定

credentialVersion只接受同步明确正整数版本，不选最新；Promise/拒绝Promise/错版本失败关闭。消费scope绑定实际tenant/project/actor、connection/revision/ref、原requestFingerprint和实际payloadSHA；根版本来自经完整认证的6C事件及显式根端口。6C库、根读取前后、消费/最终政策仍严格同步true；借出Buffer不返回浏览器/任务/画布/包/日志。

从完整冻结连接恢复三协议原端点与鉴权，核对实际wire/requestSHA/长度/Content-Type与原确认，不使用null补0或上限进入legacy数值quote。官方OpenAI为原base路径的images/generations或edits；兼容中转为已冻结枚举端点与bearer/受控header；Google为固定v1/models/:model:generateContent及x-goog-api-key。不静默改协议、参数或模型，不承诺供应商真实接受行为。

在根/消费政策、DNS前、连接lookup和证书通过后before-write调用实际SQL attempt-current检查及credential assertCurrent；网络/凭证独立同步政策也在检查两边执行，Promise或非true拒绝。轮换/撤销使旧guard失效。归一化在SQL锁外；原当前wire/原图/确认关系仍逐项重查。指定版本/返回字符串不替代工作负载授权。

## 网络与当次响应

共用6B原生客户端，全A/AAAA、TTL、公网地址政策、固定lookup地址/族/无OS回退、原Host/SNI、rejectUnauthorized/Node checkServerIdentity、TLSv1.2/HTTP1.1、私有一次性Agent/无代理/会话池、原始响应头/大小/分片/取消限制保持；证书通过且最后guard成功才req.end。禁止重定向/重试，没有回环目标白名单。不是证书公钥指纹固定。

收到完整当次原包后使用当前历史权限、原实际attempt/完整确认/租约/意图/权威输入约束/预算检查，不再拿已过期报价或目录停用授权新发送。消费最终政策或凭证轮换撤销后的失败不能擦去已收到的当次证据；只在当前历史核验仍通过且未取消时返回同一原包，绝不再次消费/发送。撤权、取消或损坏仍拒绝提交。原包与任务/标记/审计/unknown账本/max预留沿6D4B同实例事务保存；好图/坏图、网络/保存故障均不自动成功、释放预留或认定零收费。候选仍pending-validation。

原包、正文和自有秘密副本尽力清零；HTTP鉴权字符串/Node/OpenSSL内部副本不能可靠擦除。凭证库与任务库不是跨库全局ACID，最终同步guard不是外部反回滚签名或恶意可信回调沙箱；撤权不能追回已发请求。原元数据/图片大小、两槽/未结清保留槽、5秒默认/30秒最大政策不变，不保证跨进程资源闸门或硬中断同步代码。

## 本地验收与下一步

新增42项接线测试覆盖三协议known/unknown生成编辑、实际attempt写前、精确scope/auth/wire、默认关闭/模式隔离、读取权限、版本/Promise/根前后漂移、网络同步政策、TLS before-write权限价格租约/连接/原图约束/轮换撤销、迟到与最终消费拒绝后原包保持。自有随机根/秘密、独立内存ICRD1、临时任务SQLitev7和假DNS记录；5项实际自有回环TLS服务测试涵盖成功、CA失败、主机名失败、握手后撤权零POST及重定向拒绝，仅独立local-driver。没有实际生产Native公网DNS请求或部署防火墙/SSRF/保险库验收，假价格不是真实单价。

另将旧SQLite领取/结算多进程组合拆为独立竞争用例（新增1项），保留全部结算/预算断言；新Chrome只验6个未开放GET/POST与预算/日常真实闸门，不冒充生产确认UI。本轮失败记录：首API编译发现返回值可能undefined，已显式拒绝修复。首新增112项中4失败为3处撤权后测试仍调用受保护预算读取、1处目录夹具调用不存在接口，修正自有夹具，不放松权限或迟到响应保存政策；随后113项通过，补同步政策/权威输入回归后相关260项通过。首完整1327中1项新组合超5秒，缓存同一已提交快照仍在第二完整1327出现该项和旧多进程领取+结算超时；将确认夹具准备置于beforeEach、把领取和结算竞争拆独立用例，保留全部断言和原默认5秒/生产执行时限，不调全局超时或靠重试吞错。新增持久化领取断言字段workerId错配修为实际leaseOwnerId，相关133项通过；最终完整1328/101/6全通过，Chrome源码全程冻结。Zod/NO_COLOR非致命警告保留，不改依赖。用量20:20为93%/7%、20:26为94%/6%、20:36为95%/5%、20:45为96%/4%、20:50为97%/3%；全账号共享/取整及定期检查不能承诺零误差，未重置/购买/换模型。

下一步6D6权威生产产物底座（冻结路线图原项），不重复6A–6D5或本地闭环。先读production-image-native-execution/attempts/responses、generated-image-ingestion/image-task-artifacts/generated-asset-readback及完整确认/意图/租约/价格文档、phase4-provider-plan/automatic-progress和outputs最新验收。候选pending-validation不能当合格图片或5A许可；从同一实际任务SQLite恢复完整确认/准备/原运行租约/领取人/意图/attempt/returned原包与实际字节SHA，当前严格权限/原权威输入约束/预算必须核验。独立生产known/unknown合同与谱系，不能把null补0/上限或把local-fixture记录改名进入legacy生成记录。完整有界解码/尺寸MIME格式/输出约束和锁区政策通过后，产物BLOB/收据/谱系/目录/实际任务绑定须同一实例事务原子提交和恢复，写后撤权故障容量回滚，不覆盖历史、重发或释放unknown max预留；生产默认关闭且只自有假oracle/原包/临时存储零费用测试。好图坏图和保存失败与真实费用分开，原响应不可覆写；生产费用与确认UI及原专项随后按冻结计划，不套用旧mock/local已知费用自动成功/核账。真实供应商/模型/金额/根/凭证及最低成本真实请求仍需另获用户明确授权，不代选付费模型价格。MCP阶段6/视频7。

实现参考：运行时Node24.19.0 [HTTPS Agent](https://nodejs.org/download/release/v24.19.0/docs/api/https.html#new-agentoptions)、[TLS身份核验](https://nodejs.org/download/release/v24.19.0/docs/api/tls.html#tlscheckserveridentityhostname-cert)，及当前24.x [GCM完整认证](https://nodejs.org/docs/latest-v24.x/api/crypto.html#deciphersetauthtagbuffer-encoding)。未升级依赖或读取任何用户秘密。
