# 部署与恢复手册

## 已实现的本地开发入口（2026-11-10）

在implementation目录运行`pnpm local:dev`，仅监听`http://127.0.0.1:4310`，首次自行设置本机账号；私有数据保存在git忽略的work/local-workspace。新版本支持串行CPU resize，启用需给当前服务进程显式配置WORKSPACE_COMFY_PYTHON与WORKSPACE_COMFY_MAIN两个绝对路径，或在work/local-workspace/runtime.json写入仅含pythonExecutable、comfyMain的JSON。适配器每任务启动独立CPU Comfy，禁用custom/API节点、使用独立工作目录，不复用现有Comfy URL、不下载权重。未配置时任务只入队，界面明确提示未启用执行。

升级本地服务前先等待编辑保存/在途任务结束，停止确切的本服务进程，将PGlite目录和assets复制到新的私有备份目录后再启新服务。禁止两个实例同时打开同一PGlite路径。迁移按checksum逐份校验，005/006只新增执行/事件与输出关联。重启消费仅queued/outbox；已提交的过期attempt标unknown，不自动发第二次POST。回滚应用应停新消费并保留新增历史表，不运行破坏性降级。真实备份恢复/云多连接仍须单独演练；本文的启动方法不表示生产部署通过。

状态：待实现的操作规格。当前没有经本轮验证的Compose配置、镜像、部署地址或运行命令，因此本手册不声明可直接启动。

## 环境与输入

客户通过桌面浏览器使用；运营方运行Web/API、dispatcher、worker、PostgreSQL、RabbitMQ和私有S3桶，GPU为独立受控ComfyUI。首期Docker Compose是建议，正式扩容前先验证资源与恢复。单实例不是HA。开发本地环境不等于向客户提供自托管产品。

部署前需具备：确切代码commit、复用审计、锁与镜像digest、SBOM/NOTICE、身份提供商、域名/TLS、云区域、私有桶、受控GPU及审核模板、模型授权、服务端凭据、预算及并发配额、备份目的地和恢复负责人。销售地区、数据驻留和供应商地区可用性另核验。

## 配置契约

建议后端变量：APP_ORIGIN、OIDC_ISSUER、OIDC_CLIENT_ID、OIDC_CLIENT_SECRET_REF、DATABASE_URL、AMQP_URL、S3_ENDPOINT、S3_BUCKET、S3_ACCESS_KEY_REF、MODEL_PROVIDER_SECRET_REF、COMFY_BASE_URL、COMFY_AUTH_SECRET_REF、DAILY_BUDGET、MAX_ACTIVE_RUNS。秘密在运行时注入或通过引用获取；前端VITE变量仅允许非敏感公开配置。日志、导出和git不收录.env、签名URL或会话。

## 部署顺序

1. 在隔离副本构建不可变镜像，记录commit、依赖锁、digest及模型manifest。代码、契约、权限、集成与真实适配测试通过才进入部署。
2. 配置隔离网络，公网只开放443和受限运维入口。DB/MQ/GPU内网；私有桶禁止公共读，CORS精确到允许origin和方法。
3. 从备份恢复临时DB及桶，演练迁移、RLS与旧应用兼容；使用expand式兼容变更，先不drop旧列。确认恢复与回退后再处理目标环境。
4. 启动API、dispatcher、worker与反向代理；live检查进程，ready检查DB/MQ/存储。GPU离线显示生成能力degraded，项目可正常打开；启动时不盲重跑unknown。
5. 测试账号执行T01、T08、T13与T20，验证签名有效期、日志脱敏、预算冻结、下载hash、历史固定和恢复。
6. 交付私人MVP入口，关闭调试和公共注册；记录使用说明及已知问题。公开注册/收费需单独满足商业验收门槛。

## 监控

监控API错误及p95、保存冲突、队列深度与最老等待、worker心跳、unknown、归档失败、冻结预算时长、供应商429/5xx、费用、文件增长和备份成功。关联request_id、run_id、attempt_id，隐私及凭据脱敏。阈值由T19与真实业务校准，未设定商业SLA。

## 回滚与恢复

暂停新提交→保留outbox及队列→停止新消费并等待在途任务或标unknown→切上一可验证镜像及配置→恢复消费→逐项核查外部request ID。不可清空消息或重投所有收费任务。兼容迁移优先，数据损坏则恢复至新实例核对后切换，不用破坏性downgrade声称无损恢复。文件使用新key，不覆盖旧产物。

建议私用每日备份、每周恢复演练，目标RPO24小时/RTO4小时；必须测得实际值后记录。备份包含DB、文件字节、工作流依赖与配置引用。商业HA、灾备和审计保留另定预算与责任人。


### 2026-11-10 本地单action授权内核部署
512c1e3：92文件3001项全部通过（298.52秒）、65专项、六包构建、真实CPU/磁盘重开/撤销后跨编辑者纯归档与原手工浏览器回归通过。1163备份文件hash一致，44既有表原有列摘要保持，18→19，入口200/新执行目录未登录401。schema3与新执行mode不能保证旧S18二进制兼容，降级需核对私有备份与新增数据；优先前向修复。操作界面、按授权提案/回执读取、有限循环/完整T15仍待，不整体签收FR-10。周额度剩余24%，继续至20%条件。


### 2026-11-10 授权操作界面本地部署
67608df：全量92文件3002项全部通过（295.81秒）、六包构建、25专项、完整12条本地浏览器与viewer补测、真实Agent CPU界面及原手工CPU通过。1171备份文件hash一致，45既有表原有列摘要保持，schema19→19服务刷新；入口/模块200。账号项目不重置，无日常测试种子、无付费调用。多授权pending恢复定位及更多拒绝路径仍需加强，有限自主循环/真实模型与完整FR-10未完成；周额度最近剩余21%，到20%保存并暂停。
