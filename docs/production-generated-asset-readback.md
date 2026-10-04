# 6D9A 独立生产谱系与生成原图只读回读

最新增量：6D9B浏览器独立原图缓存已本地验收（1800单元/集成、160Chrome、6构建），见[production-generated-asset-cache.md](production-generated-asset-cache.md)。下一步原受控画布回流；以下A时点边界保留为历史，不代表当前尚无浏览器缓存。

2026-10-05 02:19（上海）。原冻结的生产产物回读/缓存/回流项有限分步：A 服务端独立谱系与二进制，随后浏览器缓存与受控回流。没有新增最终功能。A本地验收：首完整pnpm check为1756项单元/集成（52文件）、134项Chrome、6构建全部通过，新增78项/1Chrome；相关315项/API通过。本步骤不是浏览器缓存/回画布、真实供应商/生产会话/价格费用或阶段4完成。日常真实执行关闭。

## 独立合同与严格读取权限

`ProductionGeneratedAssetMetadataSchema` 与 `ProductionGeneratedAssetLineageSchema` 只表示已经保存的历史产物，不作为发送、产物提交、缓存标记或费用许可。生产和production-contract-fixture与旧local数值报价/GeneratedImageRecord分开，不能改标或把manual的unknown/null补0或max。

元信息只含精确范围、实际原图收据/元数据、产物指纹及execfalse/realfalse；谱系另有原批次/任务编号、原公开连接修订能力、完整冻结设计/约束/参数、输入蒙版原SHA尺寸字节顺序与转换、原完整准备/价格/确认/请求/负载不透明指纹、人工确认人/时间以及金额依据。unknown仍保留原max预留、actual缺失；已独立核账有图的succeeded显示实际金额与零预留、当前结算上限，不改原quote。核账来源私有证据/worker/lease/execution key/私有地址/端点/鉴权/凭证/wire/raw/Base64和供应商URL不公开。公共schema/hash不证明实际权限。

`ProductionGeneratedAssetReads` 默认无配置拒绝。可信服务器必须明确generatedReadEnabled=true、精确tenant、同一实际store/kernel及原包/产物存储开关；构造固定配置引用，不允许调用者重赋选项切换实际数据库。独立`ImageProductionGeneratedAssetReadHarness`只读原contract-fixture产物，不能把自有假oracle/回环验收改标生产。二进制私有读取前后只需严格同步tenant/project/asset:read；谱系独立另需run:read。不借provider:read、run:execute/create/confirm/reconcile-billing或asset:write，不改原运行领取人/worker/lease。Promise/truthy不构成许可。

## 同一实际事务中的完整历史与字节

只读事务复用`validateProductionImageReadSnapshot`（原6D8A确认历史也调用同一纯读取核验）。实际内核验证完整保存快照、当前预算和实际配置期限；项目内原准备/确认/job/key/batch、原租约历史、永久not-connected意图、attempt/returned响应、产物、独立费用历史、公开摘要/审计/账本/预算共同校验。当前权威输入/蒙版、原约束、SHA/尺寸/字节顺序仍逐份核验，输入声明64MiB读前守卫不变。

原包双表/整份原字节SHA重新解析，候选SHA/MIME/字节须等于已经提交的产物。产物BLOB/收据/双表标记/独立谱系/目录/完整任务指纹联合核验；实际输出字节SHA、声明精确长度、MIME magic与原已完整解码收据尺寸须一致。不重新解码/归一化输出、重新处理候选或提交产物。关闭存储开关不能跳过证据；删除全部任务响应或产物字段并重算有效unknown关系仍拒绝孤立原包/谱系，删费用字段/摘要、标记缺失和部分重算SHA也不能绕过。完整数据库一致伪造或回滚没有外部签名/反回滚保证。

最终权限、整个实际任务快照与目录再次核验；读取中撤权、输入/目录漂移、受测可信回调写入或故障失败关闭，回调事务内副作用整体回滚。原包/候选及数据库借出的输出副本尽力清零，输出独立复制；调用者可修改返回值而不改数据库。不是恶意可信回调沙箱、跨进程全局硬闸门或JS/native可靠擦除。

报价过期/目录停用、unknown及已核账历史可读；没有报价read/verify/询价、原请求重建/发送、任务保存、租约恢复、核账/结算或差额释放。读取不会恢复项目内无关过期生产租约。unknown zero-cap也保留原估价语义，不把not-connected、好图或usage缺失推导为零费用。

## 只由明确注入开放的同源 GET

`createApiServer({ productionGeneratedAssets })` 才开放：

- `/v1/projects/:project/production-generated-assets/:asset/lineage`
- `/v1/projects/:project/production-generated-assets/:asset/content`

日常Vite bridge与默认API仍404；没有日常查询/window/env/localStorage启用开关、写入/执行/产物/费用路由。只接GET，无query、Range、GET正文、压缩或外部URL；同步身份核验，精确路径范围，固定错误不透传私密异常。所有成功/错误private no-store、Vary Authorization、nosniff、same-origin与no-referrer，无CORS放宽。

JSON严格白名单512KiB；二进制20MiB/8192/1600万像素，精确Content-Type/Content-Length/X-Content-SHA256及production-generated-image-v1版本、原模式与产物SHA。拒绝重定向/代理下载URL或范围续传；二进制CSP sandbox。新JSON/二进制与原local二进制共用同进程两个响应生命期槽，满429，finish/close/故障只释放一次。绝对30秒销毁未结束响应，同步端口返回后再核单调期限/已观察取消，不接受迟到结果；同步CPU或恶意可信端口无法被强制终止，不承诺期限内回收全局资源或送达。

SQLite v8/ICRD1不变，无迁移或用户记录修改。读取核16MiB共享元数据，512KiB单份、32MiB原包/512MiB项目、64MiB输入读前、20MiB输出及原准备/解码两槽/默认5秒最多30秒、auto/4096平方/pixel-exact/product.pixels拒绝保持；无SQL锁内await、删除历史腾空间或旧商品锁/假单价/幂等/配置指纹修改。

## 零费用验收与边界

新增实际临时SQLite、自有完整图片/假oracle/假费用来源、回环HTTP回归覆盖三协议known/unknown/编辑输入、独立身份权限、严格同步政策/关闭开关/同库配置、过期停用/跨连接重启/无关租约不恢复、零上限/已核账、SQL正文/标记损坏、孤立证据/费用字段删除、撤权/写入回滚与副本清零、隐私白名单、HTTP精确正文/身份/方法/query/Range/压缩/GET正文/坏注入端口、两响应槽/取消/期限。生产工厂从头创建的not-connected历史无产物仍拒绝，没有将fixture改标生产或真实费用证明。

首次API编译两处字段名错配已修为原准备snapshotFingerprint和完整确认fp；初始70项通过，补期限后相关315项/API通过，追加孤立谱系/无关租约/身份边界77项通过，最后补固定配置引用1项后首完整1756/134/6全部通过。Chrome源码全程冻结，不调全局超时/依赖，不吞错或靠重试冒充验收，Zod/NO_COLOR非致命警告保留。新增Chrome只核两未开放端点GET/POST404、预算/真实执行闸门，不冒充浏览器生产缓存/回流或供应商验收。02:19实际周已用30%/剩余70%，低于已用50%停止线，原automation保持ACTIVE。

下一步仅原浏览器独立生产原图缓存与受控画布回流、原专项。真实供应商/模型/金额/根/凭证配置和最低成本请求仍须具体另授权；未读用户钥匙/环境/保险库、导入真实价格账单、供应商DNS网络付费、外发/账号/推送部署或主动重启5173。MCP阶段6、视频阶段7。
