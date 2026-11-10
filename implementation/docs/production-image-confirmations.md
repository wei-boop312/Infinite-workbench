# 6D2B 生产图片完整确认与统一预算任务

最新增量6D8A独立公开合同/HTTP与实际原包产物只读恢复见 production-image-public-http.md；下方无HTTP为原内部里程碑时点，日常仍关闭，生产UI尚未实现。

日期：2026-10-04。范围：服务端内部确认合同、原子暂存任务和严格只读恢复；仅自有零费用合同夹具验收。没有生产HTTP入口、生产确认UI、执行器或真实生成验收。

## 原准备与独立确认

`ProductionImagePreparations` 默认关闭，配置准备端口后也必须明确接入同一实例 `SqliteRunKernelStateStore` 的统一内核。不同实例即使指向同一数据库路径也拒绝，不能分裂预算提交。生产 `server-pricing` 与 `ImageProductionPreparationHarness` 的 `contract-fixture` 价格端口及证据保持独立。名字含production不是执行许可。

人工期待输入只接收原准备SHA、完整价格依据SHA、币种、上限及estimate known的精确金额或unknown。不接收客户端自报任务、prepared/confirmed/source/执行授权。原完整输入/蒙版顺序、SHA、尺寸、大小、约束、连接能力、参数与价格依据都来自实际持久化准备。确认人须为原准备人，并有同步严格true的tenant/project/provider:read/run:create/run:confirm/run:read/asset:read政策；读取私有准备及原图前检查，Promise/非true关闭。本轮为保守服务端确认范围，生成也需要asset:read，尚非正式生产会话认证。

原准备永远unconfirmed/executionAuthorized=false/realExecutionEnabled=false/protocolPreparation=not-run。独立确认固定confirmed-not-dispatchable/executionAuthorized=false/realExecutionEnabled=false，内嵌纯协议仍confirmationState=unconfirmed/prepared：这是已人工确认的任务快照，不是已发送/运行租约或当前执行授权。

## 确认与预算原子性

确认前、读取原图前后、归一化后、启动统一任务事务及写后重新核验实际原准备、当前完整连接修订、权威原图/蒙版收据与目录、原约束/输出规格、预算币种、当前时间和价格verify。verify接原完整价格/范围/版本/有效期及purpose=confirm，不重新read/实时询价；source字符串本身不是可信依据。verify可撤权或推进时间，回调后再次检查；漂移须新动作，不能沿用历史准备改价。确认时间后的时钟倒退拒绝。

事务外调用6D2A三协议纯构造和原文件归一化；服务端生成独立production-image-job/production-image-execution/production-image-batch UUID，核对实际wire SHA/精确长度/Content-Type、请求摘要、原SHA/转换版本。临时wire与原图副本完成/失败尽力清零，不存入浏览器/画布/账本。异步准备同进程最多2份，不在SQLite事务中await，不是跨进程全局资源闸门或强制解码沙箱。

服务自身持有一次活续接的私有pending确认指纹/身份，内核同步 `validateProductionImageConfirmation` 默认关闭。调用者提交完整confirmed对象也不能取得该证明。可信服务端主动伪造或恶意回调不属于JavaScript沙箱保证。证明只有暂存创建用途，完成即删除，不供未来发送消费。

完整确认、实际逐任务编号、独立执行key、审计及maxCostMinor预留在现有同一SQLite任务事务提交。外层最终复查失败、保存故障、撤权/到期/漂移均回滚整个新任务与预算，原准备历史保留。按上限而非估价预留；竞争不超过既有项目预算，不提高预算，不建第二本预算账。重复/并发/跨连接或重启只恢复一个历史确认；已过期、目录停用或已取消的历史不重建负载/读原图/verify/重新询价/预留，不构成新执行授权。

## 未知估价与关闭的执行路径

manual-budget只有上限，确认、RunBatch/RunJob/账本均明确 `estimatedCostMinor/estimatedMinor=null`；0及上限不是估价。server-price-table仍保留精确数值。公开聚合新增显式imageMode，批次/任务/账本必须一致；只有独立生产或production-contract-fixture允许null，旧mock/local缺省模式仍严格拒绝null，不放松原商品锁/单位假价格/幂等摘要/配置指纹。

本里程碑生产任务仅queued/cancelled；不可带响应编号、产物、租约、重试关系、实际费用或旧local执行证据。旧mock确认/领取/派发/执行/超时检查/重试、local图片租约与自动结算路径均拒绝。前端展示“估价未知”和独立上限/预留，隐藏旧生成/重试/回画布按钮；不会把未知估价自动填入实际扣费。原有本地图片流程不变。

取消仅未发送queued任务，按上限释放；zero-cap也清除任务预留关系。释放账本保留原known/unknown估价，实际未发送为0支出；重复取消/历史确认不重新预留。后续发送后未知扣费仍必须保留预留，不能套用这里的未发送取消语义。

## 持久化、只读与边界

SQLite仍v6，任务快照只增加可选productionImageExecution，旧库记录不重写迁移；独立ICRD/v1凭证库不变。完整生产确认单份512KiB并计入既有16MiB共享元数据，超限拒绝，不删除历史腾空间；不是数据库/WAL/磁盘硬上限。预算守恒、原准备/请求/协议/转换/报价与时间、独立编号/key、审计和账本关系都在恢复时核验。部分摘要重算不能替代其他关系；整库一致伪造/备份回滚没有外部签名或反回滚保证。未来发送须从权威输入重建实际负载再次匹配原冻结摘要。

`getConfirmation`权限检查后纯只读核验实际原准备、完整任务快照和当前项目原准备关系，不恢复租约/刷新保存任务/verify/重报价/释放预算；缺配置快照或原准备损坏不假装未确认。公开确认返回金额依据、任务聚合和摘要/转换，不返回私有地址/凭证引用/wire/正文。现有整份JSON快照核验仍非生产归一化数据库。

输出8192/1600万像素政策、auto/4096平方/pixel-exact/product.pixels拒绝及原商品锁不变。未读取用户钥匙/环境/保险库，未创建生产根、导入真实凭证/价格，未调用供应商DNS/网络/付费，也未种入日常供应商或重启5173。浏览器仅公共聚合夹具展示；实际三协议确认由自有临时SQLite覆盖，不能冒充生产人工确认UI或真实价格/网络/计费。

## 本地验收

新增76项单元/集成覆盖三协议known/unknown及编辑原图、完整期待/权限/价格漂移、await撤权到期、写后回滚、同库实例、预算竞争、容量、重复/重启/只读历史、zero-cap取消和损坏恢复/旧入口隔离；新增1项Chrome公共聚合夹具展示未知估价与关闭按钮，不种入日常任务。首轮完整909/43文件、94Chrome、6构建通过；复核补充恢复校验后完整912/43文件、94Chrome、6构建再次通过。最终输入总容量提前拦截后76项定向与API构建复验通过。首次Web编译发现6处nullable估价类型问题，已修复；无冒充失败验收。Zod注释/NO_COLOR及Git换行非致命警告保留，未改依赖或数据库版本。

11:08开始周68%已用/32%剩余，11:17及11:26为70%/30%，11:35为71%/29%，未达20%停止线。不使用额度重置、购买或模型切换。

## 下一步

6D3独立生产领取/原运行租约及权威输入负载重建，默认关闭。生产任务必须有当前完整确认/原图约束/连接能力/可信价格政策/预算和身份权限；不能把本次pending证明或local-fixture租约改名后用于生产。先只用自有假价格与临时SQLite验租约竞争/到期/重复/取消/崩溃恢复，再分步接凭证guard/原生网络与持久化发送响应证据、产物及未知费用；不得提前打开发送。真实供应商/模型/金额/根和凭证配置及最低成本请求仍需另获用户明确授权。MCP阶段6、视频阶段7。
