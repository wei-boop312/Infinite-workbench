# 6D6B 实际生产产物同库事务与恢复

后续最新验收：2026-10-04 23:04（上海）6D7A只读实际生产核账/可信费用来源核验完成，见[production-image-billing-review.md](production-image-billing-review.md)，完整1498/104Chrome/6构建通过。费用原项有限分A只读核验/B同库结算与第二人超额审批，A不释放unknown/max预留、不改变原产物或账本，B仍未完成。下方下一步为本6D6B原验收时点，当前继续6D7B；实际供应商/费用/生产确认UI与阶段4仍未完成，日常执行关闭。

2026-10-04 22:17（上海）。6D6B已通过本地零费用验收；6D6A完整图片校验与B实际同库产物保存底座完成，不代表真实供应商或阶段4完成。最终完整pnpm check：1426项单元/集成（47文件）、103项Chrome、6构建全部通过；新增64项单元/集成与1Chrome。本文件只涉及冻结的B，不新增最终功能。真实供应商、公网/保险库专项、真实费用与生产确认UI尚未完成，日常真实执行关闭。

## 当前许可与原任务链

ProductionImageTaskArtifacts与独立ImageProductionArtifactHarness均默认关闭，必须显式artifactHandlingEnabled、租户、同一实际SqliteRunKernelStateStore/kernel、独立同步run/provider/asset政策及原包/产物存储开关。生产与production-contract-fixture不能互相改标；没有HTTP、浏览器入库按钮、日常执行/钥匙/网络接线。不同实例即使同路径也拒绝；Promise/非true/私密异常失败关闭，在私有快照、原包或原图前拒绝。当前需tenant/project/run:read/run:execute/provider:read/asset:read/asset:write，实际原领取人/worker/lease必须一致。

只接实际项目/批次/任务和原worker/lease身份，不接客户端收据、校验草稿、候选图片、原包或confirmed标记。来自实际任务库的完整原准备/确认、独立job/key/batch、原运行租约/领取人、永久not-connected意图、持久化attempt、returned原包与完整SHA/解析快照共同构成处理依据。queued/not-connected/attempted/interrupted或A纯对象单独均非许可；当前权威原图/蒙版SHA、尺寸、字节、順序及原约束和预算仍由既有历史政策联合核验。原价格已冻结且有效尝试由任务链证明，处理当次历史不重新verify/read或询价，不因报价过期/目录停用新发送或丢原证据。

事务外按原确认时刻、原实际job/key，从权威原图重建三协议原request、wire SHA/精确长度/Content-Type/真实multipart boundary与全部输入转换，逐项匹配原确认，而非新整体SHA。原图总声明64MiB在既有权威BLOB核验前拦截；逐份读取前后复查身份/权限/原任务。候选从完整原包重新解析，A完整静态解码严格核对尺寸/MIME/格式/背景，保持原字节，不重新编码、缩图、静默换模型或承诺硬像素保护。pixel-exact/product.pixels、auto/4096平方拒绝保持。

## 同一实际事务与独立谱系

ProductionImageArtifact是独立known/unknown生产谱系，保存完整原request/constraint/输入转换、A草稿指纹、原确认/租约/意图/attempt/响应指纹、权威图片收据及提交人/时间。manual估价仍unknown/null，不填0或上限，不使用旧GeneratedImageRecord数值quote。草稿仍decoded-uncommitted/artifactCommitted=false，是原校验阶段证据；独立record.validation=verified及任务outputAssetIds只在实际提交后成立，不改原pending-validation响应，execfalse/realfalse保持。

实际匹配负载/解码活流程的私有pending只围绕最终同步事务存在；完整schema、A草稿或摘要不能取得该证明。产物原BLOB/收据、独立谱系/双表存在标记、资产目录、实际任务私有产物/完整指纹/outputAssetIds及审计，同一实际存储实例外层SQLite事务原子保存，嵌套savepoint不分裂提交。实际SQL写后撤权、时钟变化、取消、输入/约束漂移、故障或容量超限回滚新产物，原attempt/returned原包、unknown账本和max预留保留。可信配置/回调非JavaScript沙箱。

只允许attach命令在私有活证明下读取其同一事务尚未绑定的临时谱系；普通读取/重启不得采用这个例外。恢复核对完整任务链、原准备、原包重解析、产物记录/指纹/审计/目录/收据、实际原字节SHA与候选MIME/长度；缺表/标记/BLOB/谱系或任务关系损坏失败关闭。删去全部任务产物/响应字段也不能将孤立谱系当没有历史。部分重算摘要不能绕过其他关系；全库一致伪造/删除/备份回滚没有外部签名/反回滚保证。

同库并发与另一连接/重启恢复原资产编号，只当前权限和原身份下核验历史，不重新归一化/解码、报价或发送，不重复审计、预留或产物。历史仍核对当前原输入收据/约束，不能宣称完全不读取原图。产物保存不改变billing_unknown、原finishedAt/原因/账本，max预留含zero-cap保持；好图、坏图、保存失败与真实费用分别处理，无自动成功、重试、旧mock/local核账或释放预留。

## 存储与有界资源

SQLite v7→v8仅增production_image_artifacts/production_image_artifact_presence，正文继续同库verified_images；v8缺新表与未来v9拒绝，不重建旧记录。旧用户表/任务/目录/原图/原包/预算/配置保留，独立ICRD1不变。谱系单份512KiB，谱系和任务私有产物/指纹/审计计共享16MiB；原包/原图/产物共用项目512MiB，不删历史或调高限额。读前检查声明长度再读有界记录/BLOB；不是SQLite/WAL/全磁盘硬上限。

同进程产物处理2槽，原校验/完整解码/归一化2槽保留，无无限队列。等待默认5秒最多30秒，AbortSignal/实际期限在async返回及同步写后复查；首时钟非安全整数、任何已观察时刻倒退或期限耗尽拒绝，正常毫秒推进允许，不要求全事务物理时间冻结为一个毫秒。提交时间由实际活事务冻结且不能晚于当前时刻，pending完整指纹仍逐项绑定；未结清解码即使超时仍占槽，迟到结果不能落库。自有原图/wire/raw/输出副本完成失败尽力清零，不修改调用者或持久原件；不保证JS/native可靠擦除、跨进程全局闸门、强制中断或生产恶意文件沙箱。输出20MiB、8192/1600万像素及原商品锁/单位假价/幂等摘要/配置指纹/用户记录保持。

## 验收与下一步

64项新增测试覆盖三协议生成编辑/knownunknown、实际持久attempt/原包、同库回滚/权限/模式/原身份、并发/重启/历史、坏图/zero-cap/容量与损坏，实际SQL trigger故障、异步漂移/撤权/取消、时钟/首无效时刻、未结清解码占槽/清零、孤立谱系及v7增量/v8缺表/v9未来版本拒绝。

失败记录保留：首46项42通过/4失败为兼容夹具采用不存在multipart-form枚举，修为原受控multipart-image-array后不放松协议。增加await/重启后53项52通过/1失败，重启夹具错误沿用另一连接的响应政策，改为在第二连接重新配置同库原重建政策；API曾报union receivedAt类型不窄化，已明确returned检查。相关458项/API及新增61项通过后首完整1423项/6构建通过，Chrome在入口加载因新纯关系模块经verifiedAssets→decoder→runKernel形成循环依赖而未运行；把完全相同的AssetSchema规范化SHA算法抽到无执行/解码依赖的assetMetadata模块，原导出兼容保留，未修改摘要或图片政策。75项/API/Playwright list加载通过，第二完整1423/103/6通过。审查新增正常时间推进回归明确失败，修为私有活流程单调时间守卫、不可未来提交时刻与原期限检查；正常推进、推进后倒退、写后超时3项及API通过，补首无效时钟清槽后最终完整1426/103/6全部通过。没有调全局超时、改依赖、吞错或用重试冒充成功；Chrome运行期间源码全程冻结，原Zod/NO_COLOR非致命警告保留。

新增Chrome仅六个未开放HTTP提交/谱系/下载GETPOST404和预算/真实闸门不变，不冒充生产确认UI、实际供应商或生产公网/保险库验收。所有材料均自有假oracle/图片/临时SQLite/4173零费用测试，不写日常用户状态或新供应商/价格。没有钥匙/环境/保险库读取、生产根/真实凭证价格导入、供应商DNS网络付费、账号/外部消息/部署推送或主动重启5173。

本轮用户明确重新授权停止线为本周已用≥50%（剩余≤50%），开始0%/100%，21:47为3%/97%，22:17验收为5%/95%，原automation ACTIVE。旧额度耗尽暂停仅历史，不因下一周重置自行恢复，不重置/购买/换模型；全账号共享取整及定期检查不能承诺零误差。

下一步是冻结路线图的独立生产人工核账/真实费用底座。先读本文件、生产确认/原准备/原协议/租约/意图/attempt/原响应及run-batch-cost-kernel、billing-overage-approval、phase4-provider-plan、automatic-progress与outputs最新验收，核对统一预算/账本、旧mock/local与生产恢复隔离。只有可信服务端核验实际原任务链、当前独立核账权限/权威输入约束与预算，加人工冻结的完整任务/费用证据/币种/实费和上限期待，才能在同一实际SQLite任务事务结算；source标签、usage/好图/坏图/超时和客户端已核账标记均不能替代证据。生产known/unknown估价仍独立，不补0或上限进入旧合同；有完整产物且人工核账后才succeeded，无图核账后failed，原响应及谱系不改写。超预留须不同人的独立审批且不提高项目预算，未完成前旧核账/重试/自动成功/释放路径保持拒绝。默认关闭，无日常HTTP/UI或真实账单/价格导入，本地只自有假证据/临时SQLite/4173零费用测试。后续生产确认UI、只读生产谱系/缓存/回流及原专项按冻结计划推进；实际供应商/模型/金额/根与凭证配置、最低成本真实请求须另授权，不代选付费模型价格。MCP阶段6、视频阶段7；真实供应商与阶段4整体未完成。
