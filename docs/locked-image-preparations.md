# 原锁区B1：实际权威准备与价格前政策冻结

最新B3增量见[实际保护租约与未发送安全取消](locked-image-leases.md)：原完整v2准备/政策保持不可变，实际任务领取/未启动恢复/取消已独立本地验收2123单元/集成、193Chrome、6构建。原后续意图/发送/产物/保护公开缓存UI仍未完成；旧none/local不升级，不把准备或租约当发送许可。

最新增量：2026-10-05 08:40[原B2实际确认](locked-image-confirmations.md)已本地验收2051单元/集成、192Chrome、6构建，完整v2政策/请求/实际任务与max预留同库原子保存，旧none不升级。仅显式内部确认接线，原领取/发送/产物/保护UI仍关闭；下方是B1验收时点的原记录，旧“B2待实施/无确认”不覆盖本增量。

2026-10-05 07:40（上海）本地验收。原硬锁区有限B的第一步，不增加最终目标、不重复纯A。[整体设计](locked-image-task-binding-design.md)仍要求确认/任务/产物/公开缓存回流一致验收；不是端到端硬锁、供应商接受或完整项目完成。

## 实际入口与默认关闭

`LockedProductionImagePreparations`只接受原server-pricing工厂；独立`LockedImageProductionPreparationHarness`只接受contract-fixture/realfalse。显式preparationEnabled、lockedPreparationEnabled、精确租户、同一实际SQLite store/kernel与独立同步严格true的lockedPreparationPolicy缺一即关闭。配置引用及权限/价格端口函数身份冻结，不能在native await中交换存储或端口；可信政策仍可撤权。私有读取前后provider:read、run:read、asset:read，创建另需run:create；另一独立获授权人可读历史，保留原createdBy及价格scope，不借confirm/execute/billing/assetwrite。

没有HTTP、App/UI、人工确认、任务/预留/租约、请求准备或发送入口。返回仅内部有界编号/mode/unconfirmed/not-run及不透明完整SHA，全execution/real旗标false；无完整连接/政策、提示词、地址、凭证、worker/lease或执行key。schema/SHA/草稿及可注入可信回调不是实际发送或产物许可。

## 可信价格前冻结真实输入

- 新准备严格编辑、pixel-exact、product.pixels与唯一命名且绑定同一蒙版的非空编辑区域；源图/蒙版方向后尺寸与明确原输出规格一致，禁止auto。旧none准备/确认不能追加A草稿升级。
- 原目录声明在任何收据/BLOB getter前检查每输入30MiB、合计64MiB、8192/1600万像素。完整约束/顺序、注册元信息SHA、实际收据/原字节SHA、源图身份和PNG蒙版来源绑定均核验。
- 同库读取有界自有源图/蒙版后，在SQL外共用原完整静态native解码两槽，autoOrient/sRGB/RGBA8。白色alpha255编辑，其余alpha0..254锁定；非白有alpha拒绝，两区必须非零。只计算源图/蒙版规范像素SHA/数量，不验证供应商输出或合成/重编码/放宽JPEG差异。
- 严格locked-image-input-policy-v1冻结完整实际源图/蒙版收据、原字节/元信息身份、完整约束SHA/输入顺序/输出规格、规范化/蒙版规则、规范像素SHA/两区数量/时间，进入完整basis/snapshot及可信价格scope，端口收到深复制完整上下文。固定RGBA8不是原编码/ICC/高位深样本/任意解码器一致或品牌语义保证。
- 最终同库同步事务重核权限、实际输入/完整约束、原连接能力/修订、实际配置预算/币种/时钟；相同动作并发胜者已存在时仅恢复，不再读价格。首次read/verify各一次，known与manual unknown-null保留，不补0/max为估价。政策不进入供应商任意参数。
- 当前Google原协议不能携带绑定蒙版，目录声明不能制造协议支持，价格前拒绝；正向仅OpenAI/compatible自有已支持能力，不为凑三协议成功放宽能力/极性或改协议。

## 原子保存与纯历史恢复

严格JSON schemaVersion2准备及独立读取器，用原SQLite v8准备/存在标记双表、唯一动作、1000份/16MiB共享/512KiB单份容量，无物理迁移/新预算库。原v1读取/确认/协议拒绝v2，v1/none/local/mock/用户记录原义保留。记录及标记每个实际SQL写后同步核权/输入约束/价格期限/预算/容量；故障、撤权、受测可信回调漂移/取消整体回滚新准备及同事务副作用，不删历史腾空间。

重复、同库/另一SQLite连接竞争、独立读者、报价过期/后续目录停用及重启恢复原编号/完整指纹。核当前read权限、原完整收据/原字节/约束、历史原连接修订和实际配置预算；不再解码、price read/verify/询价、协议重建/保存/预留/核账/发送。删正文/标记、字段丢失/漂移及部分重算SHA失败关闭；完整DB一致伪造/回滚仍无外部签名保证。

两准备槽、默认5秒最多30秒、原native5秒槽、单调时钟/绝对取消保持。非合作native未结清仍占槽，迟到不保存，自有原字节/像素尽力清零，不改调用者材料；receipt-only读取也清零其自有BLOB副本。无SQL锁内await，非生产沙箱/跨进程全局硬闸门/强制native终止/可靠JS-native擦除。

## 验收与真实失败记录

新增84项单元/集成、1Chrome；相关314项通过，后补独立读者和两SQLite连接竞争。最终第二完整pnpm check：1981项单元/集成（56文件）、191项Chrome、6构建全部通过。Chrome期间源码冻结，新增仅四次未开放准备/确认GET/POST404、预算不变与真实闸门false，不冒充保护UI。自有小PNG/蒙版、假价格、临时SQLite/4173零费用；生产工厂从头用自有假server-pricing验known/manual，不改标local或读真实账单。

首API两处number/ISO时间及已窄化尺寸类型修复。首70新测试68失败来自自有mask模式/Google比例枚举误配；后4失败是自有register函数遮蔽目录注册，修原接口后全部重验，不放宽合同。Google正向期待改成原协议不支持绑定mask的负向价格前拒绝。

首完整1979中1944通过/35失败及1未处理拒绝：旧HTTPS首用例在全量默认并发下8086ms超过原5秒，后续证据/预算断言连锁失败，构建/Chrome未运行。旧12项native正向及旧131+新82共213定向通过后，实质修复为Vitest最多4 worker约束本机CPU/SQLite/native争用，并将旧未调用的预建Promise.reject测试值改为调用时才创建。保留全部原断言/默认hook/test/生产时限/依赖，不加重试、不吞实际失败。补2边界后第二完整1981/191/6全部通过，原Zod/Rollup注释/NO_COLOR非致命警告保留。

## 下一步与未完成

原B2从此实际v2准备扩严格新确认/请求身份：完整政策进入原价格scope/人工期待/请求/任务快照，同库一次确认及原max预留，最终和实际写后同步核验，私有pending不接受本准备对象作许可。随后原租约/意图/attempt/raw、SQL外像素核验、不可变保护证据/产物原子恢复、严格公开谱系/缓存/回流。不能仅改旧enum，不能为已核账无图任务补图改变原结论。

后续未实现，原确认/执行/产物/公开回读/cache/canvas的pixel-exact/product.pixels仍拒绝，日常真实执行关闭。真实供应商、公网/保险库、真实价格账单/生产会话、阶段4及完整项目未完成，不跳过阶段4推进MCP6/视频7。

此次人类明确恢复至全部冻结阶段完成或本周剩余<=20%（codex周已用>=80%）。07:40实际周已用56%/剩余44%，07:43重读57%/43%，原automation ACTIVE；开始/里程碑结束/约10分钟检查，命中或不可读安全保存报告暂停，不因下周重置恢复，不重置/购买/换模型。账号共享取整/周期检查不承诺零误差。未读用户钥匙/环境/保险库、建生产根/导入真实凭证价格账单、供应商DNS网络付费、账号外发/部署推送或主动重启5173。
