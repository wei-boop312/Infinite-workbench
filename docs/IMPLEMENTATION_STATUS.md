# 当前实施进度

2026-11-09。此目录是旧画布19499e7的隔离开发副本，当前分支codex/cloud-mvp-migration。原仓库业务文件未修改，未推送。上级方案文档继续作为产品边界；本文件覆盖复制进来的旧自动交接文档，不恢复其自动任务或付费授权。

## 本轮交付

1. 复制旧仓库受版本管理的内容，按原pnpm-lock.yaml安装依赖。离线安装因缺少缓存元数据失败，随后冻结锁安装通过，未升级依赖。使用Node24.22.1、pnpm11.25.0、D:/python/python.exe；packageManager原声明仍为pnpm11.19.0，实际运行差异保留。
2. 对317个基线文件、保留的插件文件与119个已安装依赖生成可复核清单，记录git内容hash和工作副本字节hash；CRLF差异不误报业务修改。分类为按路径建议，不能冒充逐行人工审查。
3. 新增普通对象、展示edge、专业工作流、模板和绑定Schema。旧CanvasDocument v2保持原义，未静默升级全部用户项目。
4. 实现离线契约验证器WorkspacePrototype：不可变发布、对象修订、双向引用、inputChanged、固定运行快照、幂等与跨项目拒绝。该验证器仅在内存，不含登录/数据库/预算/队列，不向HTTP开放。
5. 复制插件MIT声明和核心源码，使用归档registry实际编译resize，输出真实Comfy UI图及API prompt。快照固定源码树及registry指纹；仅编译不提交。
6. 提供旧image/text/tool切片显式迁移：保留旧完整文档、标题正文、几何及映射，旧边隔离。缺映射、分组、多媒体及不支持对象拒绝整份迁移，不能称完整项目导入完成。

## 可复核入口

- `pnpm exec vitest run tests/workspace-prototype.test.ts tests/workspace-migration.test.ts`：新契约与迁移回归。
- `pnpm exec tsx tools/workspace-demo.ts`：生成示例快照、UI/API图、机器可读Schema和编译报告。
- `node tools/audit-baseline.mjs`：生成当前来源/依赖清单，不读取密钥或模型。
- `pnpm test`、`pnpm build`、`pnpm exec playwright test tests/e2e/canvas.spec.ts`：保留代码回归。

Python路径可通过WORKSPACE_PYTHON指定，要求绝对路径。示例使用归档清单里的owned-probe.png名称与合成资产hash映射，不包含真实图片字节、上传或缩放执行。prepared_not_submitted表示准备态，不是排队或生成成功。JSON Schema对参数宽高作基础约束，跨字段总像素限制还必须调用WorkspaceParametersSchema。

证据位于`docs/evidence/2026-11-09`。完整旧代码测试、最终新增测试、构建和浏览器测试分开记录。全量测试启动后又完成了新迁移/指纹补丁，因此最终新增代码以末轮专项测试和构建为准，不将首轮全量结果套到未加载的新用例。

## 本地开发追加交付

用户已明确“尚无云环境，先完成本地开发与验证”，并授权按方案自动审批推进。因此以下内容在本机隔离实现，没有采购或配置云服务，也不把本机存储改成正式产品的默认部署决定。

- 使用锁定的`@electric-sql/pglite@0.5.15`运行本机PostgreSQL WASM开发引擎，按三份迁移建立项目/成员、对象修订/租约、版本/绑定、预算/run/outbox、私有身份会话及资产元数据。它支持真实SQL和事务，见[PGlite官方说明](https://pglite.dev/docs/about)和[事务接口](https://pglite.dev/docs/api)。原生PostgreSQL多连接竞争、连接池和云端恢复仍须另验，不能从本机引擎结果推导。
- 应用事务切换到NOLOGIN/NOBYPASSRLS的workspace_app角色，用SET LOCAL绑定服务端会话身份。RLS启用且强制；测试验证跨项目、viewer写入、designer删项目、复合FK、不可变历史与软删后的子资源关闭。owner可读自身墓碑元数据以完成软删，API不再返回已删项目。实现参考[PostgreSQL行安全文档](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)。
- 本地首个账号设置、scrypt密码校验、哈希存储会话、HttpOnly/SameSite Cookie、注销与过期、仅回环Host/Origin、写请求标记和登录限流已实现。它是本地身份适配器，不冒充云OIDC或公网认证完成。
- 本地项目创建、双层普通对象切片保存、60秒编辑租约/20秒续租、fencing与修订冲突、文字自动保存、画布平移缩放/拖动与重开已接入HTTP和预览界面。
- 图片使用旧代码的完整解码器：校验魔数/MIME、尺寸及hash，字节保存在独立私有目录，数据库只存元数据。支持PNG/JPEG/WebP，每图8MiB、每项目64MiB。下载再次鉴权并核对字节hash。DB提交失败可能留下未引用文件，当前保留不盲删；自动孤儿回收和生产解析沙箱仍待实现。
- 在隔离CPU ComfyUI实例完成真实三节点resize：16×12自有合成图片上传→实际节点清单编译→单次提交→256×256真实产物→尺寸/像素/原件hash核验。owned-comfy/report.json记录prompt_id和输出hash，子进程已结束。没有生成模型、GPU推理或供应商调用；这不是普通卡片到生成图片的全MVP闭环。

本机入口由`pnpm local:dev`启动，地址`http://127.0.0.1:4310`，首次打开设置自己的本机账号。数据在git忽略的work/local-workspace，未创建演示用户进日常数据库。旧React Flow工作台仍保留，新入口是验证身份与持久化的轻量预览，并未完成全部画布编辑能力迁移。

## 最终验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 最新完整单元/集成 | 75文件、2893项通过，331.92秒 | evidence/2026-11-09/final-unit-tests.log |
| 新模块最终专项 | 6文件、32项通过 | evidence/2026-11-09/final-workspace-tests.log |
| 构建 | 6包通过 | evidence/2026-11-09/build.log |
| 原完整Chrome | 288项通过，13.2分钟 | evidence/2026-11-09/browser-tests.log |
| 新入口Chrome | 1条完整交互通过，包含首个账号、登录、项目、文字拖动/刷新、注销重登、图片上传/重开及原字节下载 | evidence/2026-11-09/local-browser-tests.log |
| 真实CPU Comfy | 256×256技术验收通过，原件不变，实例已停止 | evidence/2026-11-09/owned-comfy/report.json |

完整测试与专项存在重叠，不相加。保留早期失败记录：首次软删HTTP返回500，定位为新行RLS检查，改为owner墓碑读取、子资源统一拒绝并增加回归后通过；旧导入路径和审计脚本错误也已修复。Comfy验收中Pillow旧getdata接口产生弃用提示，未修改用户运行时。

## 阶段状态

| 任务 | 状态 | 本轮边界 |
| --- | --- | --- |
| TASK-01 | IN_PROGRESS | 来源、120个当前依赖、全量单元及288浏览器基线已验证；完整权属/许可仍未闭合 |
| TASK-02 | IN_PROGRESS | 第一条resize切片已形成机器Schema与测试；198项原表、剩余接口及产品未决项尚未全部冻结 |
| TASK-03 | IN_PROGRESS | 双层原型及隔离实时Comfy resize通过；引擎比较、云纵向与图片模型仍待 |
| TASK-04 | LOCAL_PARTIAL | 本机迁移/RLS、复合FK、预算/run/outbox同事务和恢复通过；生产角色/多连接及完整字段域待补 |
| TASK-05 | LOCAL_PARTIAL | 真实本地账号/会话/项目HTTP通过；生产OIDC和云部署未做 |
| TASK-06 | LOCAL_PARTIAL | 本机图片上传/原件下载/归属/hash通过；S3签名、缩略图与清理待补 |
| TASK-07/08 | LOCAL_PARTIAL | 新入口普通卡片拖动、缩放、自动保存/租约/重开通过；旧编辑能力尚未全部接到新持久化 |
| TASK-14 | ACCEPTANCE_ONLY | 隔离CPU三节点实际执行通过；生产worker、图像生成模板和状态机仍待接入 |
| 其他 | TODO | 没有将技术切片写成五场景MVP完成 |

## 当前缺口和下一步

下一步为持久化工作流/模板、普通工具卡绑定、dispatcher/attempt/结果回填与事实/策划。用户已要求先本机验证，云环境不作为当前本地开发的暂停理由。GPU/外部模型及其实际质量、生产云数据库/存储/身份待后续环境具备时验证，不冒充已接通。

当前采用TypeScript内核加Python编译适配，仅作为已验证的复用方向，不代表已冻结所有生产框架。完整云端闭环仍需真实环境。没有购买资源、云端部署、外部付费请求、用户素材执行或模型权重下载。

许可清单显示4个已安装平台包目录缺少独立LICENSE文件：两个版本@esbuild/win32-x64与两个平台@rollup包。需核对上层包覆盖关系及分发NOTICE；不直接判为无许可，也不标为商用批准。根旧仓库未见LICENSE，用户自有代码与第三方内容权属还需按实际交付范围核验。

保留构建中的Zod注释和513.90kB chunk提示，未调大阈值掩盖。完整进度及未决不以测试数量替代。

## 2026-11-10 版本持久化推进
新增LocalWorkflowVersions仓储，实际SQL保存工作流与模板固定版本；旧版本不可修改，读取核对内容hash，跨项目与越权访问拒绝。新增2项专项测试及6包构建通过；本轮全量回归正在执行，结果在work/version-full-test.log，未写成已通过。工具卡绑定与执行回填尚待后续接入。

2026-11-10追加：上轮全量76文件2895项通过（work/version-full-test.log）。本轮新增SQL工具绑定，固定源对象/工具修订、资产sha256与模板版本，双向对象引用查询及input_changed通过3项专项测试，API构建通过。全量2895发生在本次绑定补丁前，不能声称含新用例的全量已通过。HTTP/界面绑定、任务快照/执行与回填仍待。

## 2026-11-10 持续目标 运行快照入队
用户要求推进至codex10080分钟周额度剩余<=20%停止；本轮读取已用26%/剩余74%。新增LocalBoundRuns：服务端解析固定绑定、源/工具修订、资产sha、图/模板hash及编译器source pin；零供应商费用resize策略，快照/run/outbox同事务，幂等键拒绝异参。HTTP发布/绑定/提交/读取已接通，拒绝前端快照或授权字段。9项专项和6包构建通过；全量回归运行中，工具会话71326，日志work/bound-run-full-test.log。下一步等待该确切会话，再接工具卡界面、执行器与结果回填。queued不代表执行或生成成功。

## 2026-11-10 工具卡界面推进
新增内置固定resize模板幂等安装、持久绑定顺序迁移004、工具卡选择图片/固定修订/参数表单/入队/只读恢复。浏览器链路通过，重复刷新只保留一条任务，未宣称执行。全量会话71326仍确认运行，work/bound-run-full-test.log已出现旧费用/响应/产物边界用例超时失败；保留诊断记录，不计为通过，不改worker/超时/断言。等待该会话结束后须隔离复核受影响套件，再做最终冻结回归。新增模板幂等用例和最终截图待复跑。下一步受控执行与结果回填，日常服务尚未重启加载新HTTP模块。

## 2026-11-10 执行租约及回归诊断
上面的全量会话71326已结束：76文件中7失败，2899项中21失败、2878通过，543.36秒。失败涉及旧费用、attempt、产物、公开HTTP及结果画布等超时；不是最终通过。单独复核multipart仍复现超时，不能仅归因于并行负载。inspector CPU采样记录在work/multipart-diagnostic.cpuprofile，规范化指纹序列化为最大热点；正在验证保持旧hash规则的减少分配补丁，没有缓存快照、提高超时或减少worker。

新增迁移005及内部LocalRunExecution：固定快照/编译器/资产校验、单次领取、60秒令牌租约、提交前持久确切请求、一次提交边界、响应归档态及顺序事件。未提交过期标failed，已提交过期标unknown，均不自动重投。8项专项通过（work/execution-final-tests.log），6包构建通过（work/execution-build.log）。尚无真实worker连接及产物ready/回画布；archiving不表示成功。迁移尚未应用日常数据库，现有本地服务未受执行补丁影响。周额度最近已用29%/剩余71%。

## 2026-11-10 ready结果归档与内部worker
新增迁移006输出关联；只有私有适配器校验后的ready PNG、匹配快照尺寸/hash及已持久provider request ID可完成。新结果对象追加、画布revision递增、output关联、完成事件与succeeded同事务；不改输入对象，重复回填不增卡。内部LocalResizeWorker串接私有原件、出站三节点验证、提交前持久请求、单次POST、先存回执、产物校验及回填；异常在提交前failed、提交后unknown，绝不自动重发。

12项仓储/worker专项通过（worker-archive-tests.log），其中运行端明确为mock，不作为真实Comfy通过。6包构建通过（worker-archive-build.log）。实时registry Python编译入口用归档自有实例清单进行纯离线验证，3项通过（live-resize-compiler-tests.log）；没有连网或执行。后续必须实现自有隔离CPU runtime并做真实纵向/界面验收。迁移005/006未应用日常数据库。

指纹优化保留旧字节协议及修改后重算，缓存的仅是最多1024个属性名的JSON转义文本，不缓存对象、内容、权限或digest。2项兼容测试通过；最初仅减少entry分配的80项套件仍有1超时失败（fingerprint-targeted-tests.log），追加属性名编码优化后原multipart两项通过（76项筛选未运行，multipart-optimized-tests.log）。新的全量会话4798仍运行，日志work/ready-output-full-test.log已出现旧HTTP用例5048ms超时，不能称整体绿；本次worker/回执和编译入口新增于全量启动之后，须以专项加最终冻结回归验证。最近周额度已用30%/剩余70%。

## 2026-11-10 真实CPU与浏览器闭环
会话4798已结束：78文件/2908项，2907通过、1项旧public HTTP超时（393.90秒）。该确切用例单独复核通过（另80项筛选未运行），不是全量通过。最终冻结回归会话77798正在执行，work/frozen-runtime-full-test.log；期间不并行启动真实CPU/浏览器压力。

OwnedComfyRuntime实际启动独立CPU实例，每任务独立端口和目录；禁用custom/API节点，隔离环境且离线，不借用日常实例。上传比对字节；live三类registry用保留编译器编译，核对编译器pin及出站白名单图；确切请求先持久，只有一次POST；回执先保存，history绑定prompt ID与确切图，只读取自有output路径。产物校验、ready归档、原子回画布和原字节下载已走通。实例关闭后保留证据。

自有合成图真实worker验收在owned-worker/da676b78-ddd3-4a29-b2c3-0450ed286b2a：256×256均匀RGB、原件不变、数据库关闭重开、历史任务拒绝再领取均通过，ownedPid22420已停止。没有模型权重或收费调用。它只证明resize，不证明AI图像生成质量。

新增本地串行dispatcher读取持久outbox，领取同事务标记dispatched；恢复过期claimed为failed、submitted/returned为unknown，从不重投。身份撤销/项目软删不会启动新执行；当前回收同样受原actor编辑权限约束，生产独立worker角色与撤销后的管理员核查仍待。GUI自动只读轮询、结果下载和显式载入结果已接通；载入前保存队列及编辑generation检查，拒绝覆盖未保存内容。新图片/文字默认移到已有卡片右侧，修复刷新后随机遮挡下载链接；旧坐标不改。

最新24项专项及6包构建通过；原浏览器流程修复重叠后通过（card-placement-browser.log），真实浏览器CPU闭环通过（final-runtime-owned-browser.log，owned-browser/552f3e62-ce10-4c07-977b-ce5ec4f64cd2）。后者覆盖登录、HTTP上传/固定绑定/入队、单次真实resize、下载像素、画布结果、刷新仅一任务/一输出和实例停止。截图已人工查看。保留重叠失败日志，不以强制点击或更长超时掩盖。

直接Node启动曾暴露staticImageDecoder→runKernel→verifiedAssets循环初始化；将同一个RunKernelError类移至无依赖模块并保留旧入口re-export，实际独立Node启动回归通过。尚未更新日常4310服务，升级须先停旧实例、保留PGlite与资产备份、再应用迁移，不能同时打开同一数据库目录。最近额度已用31%/剩余69%。

## 2026-11-10 冻结通过与本机升级
会话77798已结束：80文件、2915项全部通过，310.47秒（frozen-runtime-full-test.log）。这是5b32fca执行闭环阶段的全量证据，不覆盖后续新迁移007。滚动升级兼容页面2条浏览器测试通过：新增runtime接口尚未提供时，已有账号仍可登录并打开项目。

已实际升级日常4310服务：识别并仅停止本项目旧node进程，保留私有DB/资产备份；1051个文件逐一SHA256比对；在独立restore-check副本验证迁移1–3→1–6、17张旧表摘要一致，再启动新版。没有打开同一数据库路径两次，没有创建测试用户进日常DB。摘要在local-upgrade-summary.json，原始备份及含私有数据摘要的核验报告只留git忽略的work/local-workspace/backups。新入口GET200、未登录me401、CPU缩放已配置，后台launcher9020。升级脚本的旧进程停止属于本地开发迁移，不是生产零停机方案。

## 2026-11-10 编辑与结果追加解耦（待最终冻结）
新增007画布变更journal，记录editor与run_output，不修改既有修订。保存遇到旧画布revision时，仅在期间journal完整且全是独立结果追加时允许重基；对象修订/租约仍校验，人工编辑或历史journal空缺仍拒绝覆盖。结果对象、journal、run成功同事务。

28项相关测试和API构建通过；真实CPU浏览器在结果返回后用旧画布revision编辑文字成功，刷新仍保留该人工事实、仅一任务/一产物（canvas-journal-owned-browser.log，owned-browser/46b5714c-e8f3-47f3-8164-0aa14e0179fc）。007未应用日常DB；当前线上本机服务仍为迁移006阶段。新代码须随下个阶段做完整回归和备份升级，不能将上面的2915通过直接套用。最近额度已用33%/剩余67%。

## 2026-11-10 取消与完成竞争（待全量）
迁移008新增不可变取消请求、允许无attempt的排队取消事件、扩展attempt cancelled终态。排队取消原子关闭outbox且不产生attempt；领取后未提交的取消由提交边界拒绝；提交后仅记录cancel_requested，不靠取消意愿判断外部结果。worker仅对每任务自有进程的确切prompt ID请求interrupt；严格匹配已存请求图、provider ID、中断消息、无输出及自有进程停止后才确认cancelled。错图/错ID/已有输出/未停进程/丢提交回执均不能伪装成功，保留unknown或继续ready归档。已完成后不新建取消记录，重复请求/确证不重复事件。

新HTTP取消路由、能力标记、工具卡取消/只读轮询及单调事件序号已接通；旧服务未声明取消能力时不显示按钮。42项专项、6包构建、2条普通浏览器、1条真实CPU正常闭环通过。实际提交后取消验收在owned-cancellation/b1bd891b-51b8-4980-96a7-9f67388d9a69：4096×3906白名单CPU缩放中断，provider_request_id f3489f65-cc1f-469a-ad4b-7f9cb839f6bf，中断历史匹配、无产物、ownedPid61488已停、原件不变、数据库重开仍cancelled且拒绝再领取。没有模型或收费请求。单元竞争覆盖本地串行引擎，不据此宣称原生云多连接已验。

首轮viewer取消专项发现FOR UPDATE受RLS提前过滤，服务错误语义与预期不同；增加受RLS约束的只读可见性/编辑权限检查，再锁定并重验，原断言保留后通过。失败日志留证。

全量会话44873正在运行，work/cancellation-full-test.log；不并行跑真实CPU/浏览器压力。007/008尚未应用日常数据库，当前4310服务保持006已验证版本。后续还需unknown人工核查/归档恢复、用量视图、取消的云供应商与GPU边界、事实/策划及Agent等，不将本地resize切片写成完整项目完成。周额度已用36%/剩余64%。

## 2026-11-10 取消阶段冻结与第二次本机升级
会话44873已结束：80文件、2925项全部通过，295.24秒（cancellation-full-test.log）。迁移007/008随后实际加载日常4310服务：1072文件备份hash一致，独立restore-check副本迁移6→8后20张既有表摘要一致，未重置用户与资料。原始核验报告保留私有备份目录，脱敏摘要为cancellation-upgrade-summary.json；launcher61616。当前日常服务具备编辑/结果追加解耦与取消能力，下一节新历史界面仍待升级。

## 2026-11-10 任务历史、事件流及用量（待全量）
新增LocalRunQueries：项目RLS只读任务清单、按created_at+UUID翻页（游标保留PostgreSQL微秒，避免JS毫秒截断漏行）、持久事件游标、开发预算与费用完整性。列表和用量先验证快照hash；不返回lease token、内部请求或原始未知payload。明确区分执行unknown、费用unknown及尚未完整登记；不能因reserved=0就断言未知供应商实际费用为0。本地已验证白名单resize的供应商费用为0，金额用十进制字符串传输，不做浮点加总。当前用量核验扫描本项目快照，尚未完成生产容量基准/独立费用ledger迁移。

GET runs/events提供JSON分页与Accept:text/event-stream的SSE；按序号续传、原生重连Last-Event-ID优先、逐帧重新核对session/项目权限、背压等待、心跳与连接上限。注销或成员撤销后发access_revoked并关闭；服务主动关闭会清理流。36项专项与6包构建通过，覆盖微秒分页完整、viewer/越权、未知费用、损坏hash失败关闭、SSE续传/注销/成员撤销。

“任务与用量”弹窗、日志与结果下载/定位已接入；旧服务未声明能力时隐藏入口。两条普通浏览器与真实CPU浏览器通过：清空workspace.tool-run客户端指针后，仍从服务器历史找回同一产物、下载原字节并定位画布，保持仅一次运行。最新截图已查看，证据在owned-browser/12c96512-bab1-4688-9adb-965be085e028及history-final-*.log。

全量会话48676运行中，work/history-full-test.log；不将上阶段2925套用本节新增代码。日常服务仍为前一取消阶段，待此阶段通过再备份升级。人工核查unknown的证据恢复/再归档、运行环境完整来源、事实/策划、Agent和云端目标仍未完成。最近额度已用39%/剩余61%。

## 2026-11-10 历史阶段验收与第三次本机升级
历史全量会话48676已结束：81文件、2931项全部通过，296.16秒；日志归档为docs/evidence/2026-11-10/history-full-test.log。第三次本机备份升级在04:28完成：1076个文件hash一致，独立副本22张既有表摘要一致，迁移8→8，入口http://127.0.0.1:4310就绪，launcher62640。当前日常服务为历史/事件流/用量阶段；没有将后续未冻结代码直接加载日常数据库。

## 2026-11-10 运行来源、产物缓存与独立归档恢复（全量运行中）
新增迁移009/010：不可变编译准备记录及产物清单、独立60秒归档租约和不可逆execution_fenced围栏。实际Python、桥文件、5项Comfy核心文件和registry均有来源hash；证据仅含允许字段，不接受文档或任务payload扩大执行范围。PNG经完整解码后先写私有不可变缓存并flush，再将清单hash绑定数据库，之后才转存资产与回填画布。

归档恢复只处理已有数据库证据和匹配缓存的结果，接口实现无runtime、compiler、URL或prompt端口；使用当前项目编辑权限、新租约及历史快照的原编译器pin。原执行令牌被围栏永久阻断；重复领取、错令牌、过期完成和无证据恢复被拒绝。没有提交回执或没有已持久产物证据的unknown仍需核查，不能自动重发。当前服务层已实现，HTTP/界面入口尚待接入，不能宣称用户可直接恢复。

24项缓存/worker/恢复专项通过，API包构建通过。真实CPU验收4511a22c-6e07-4899-b790-2352164b2010：模拟资产存储故障后unknown，关闭并重开数据库，使用不同当前compiler pin成功恢复同一历史产物；重复恢复复用结果，事件仅一次submitted，原件不变，像素256×256 RGB(51,102,204)，自有PID63408已停。真实CPU来源/缓存普通闭环及浏览器分别另有b79f6c4b与a60087fa证据。均无模型或付费供应商调用。

从第三次原始备份另建独立restore-check副本，迁移8→10通过，22张既有表所有原有列摘要一致；改进核验器按升级前实际列集合核验，新增列不会被永远忽略。未操作日常DB。当前全量会话2498运行中：work/archive-full-test.log；6包构建会话74479：work/archive-build.log。上节2931通过仅属于旧冻结版本。本周额度最近已用42%/剩余58%，按用户条件继续至剩余20%停止。

### 归档阶段冻结结果
会话2498已结束：82文件、2939项全部通过，301.43秒；会话74479六包构建通过（保留现有web分包体积提示）。日志归档在docs/evidence/2026-11-10/archive-{full-test,build,recovery-tests,migration-drill}.log。服务层可作为下一HTTP/UI切片的基线，日常服务仍是迁移008，009/010尚未加载。

## 2026-11-10 用户可操作的归档恢复入口（全量运行中）
TASK-23/T10/T12本地部分：新增严格空body的POST /v1/projects/{p}/runs/{r}/recover-archive。服务器session决定actor，同源/loopback校验、项目角色先于执行，不能传入artifact/lease/URL。GET run返回仅供UI展示的archiveRecoveryAvailable候选字段；真正恢复重新验证历史快照、DB证据和私有缓存。旧服务没有archiveRecoveryEnabled时隐藏按钮，viewer不可操作。任务详情中的恢复按钮不会触发生成，日志显示开始恢复及完成；SSE推进详情与列表状态，失败保留产物待核查。

36项专项及API构建通过。真实CPU浏览器故障验收fad4cad8-37ae-464d-b425-38440bc97f0d通过：资产存储失败→刷新→服务器历史找回unknown→按钮恢复→下载原字节→只一run/attempt/output，原件不变、自有进程停止。额外验证伪造actor/产物参数422、外站请求403、临时viewer403、再次POST复用结果；截图已查看。初次截图发现列表状态滞后，修正后补断言并复跑通过。正常CPU浏览器b171a870-fb10-412e-a891-75f41db17f81通过；2条本地登录/保存/旧runtime兼容通过。首次普通浏览器命令误写不存在配置文件，失败记录work/archive-local-browser.log保留，改为实际playwright.workspace.config.ts后通过work/archive-local-browser-corrected.log。

全量会话46990：work/archive-ui-full-test.log；构建会话34532：work/archive-ui-build.log。前节2939通过尚不覆盖本节HTTP/UI；当前日常4310仍迁移008，待通过后再备份升级。周额度最近44%已用/56%剩余。

### 恢复入口冻结结果
全量46990已结束：82文件2939项全部通过，300.95秒；六包构建及真实故障/正常CPU浏览器、2条本地浏览器已通过，证据归档archive-ui-*.log等。未提高超时或减少worker。准备第四次本机备份升级，原始核验报告留私有备份目录，仅交付脱敏统计。

### 第四次日常服务升级完成
05:21备份升级完成：1076个文件hash核对一致，独立restore-check副本迁移8→10，22张既有表原有数据摘要一致；launcher22816。日常http://127.0.0.1:4310的登录设置接口200，首页包含恢复入口；没有重置账号/项目。脱敏证据archive-ui-upgrade-summary.json，完整私有备份在work/local-workspace/backups/20261110-052142-63e6dbf4-5d9e-40e4-ab71-e3bf41914b07。此时日常服务已加载009/010、来源记录、产物缓存及恢复HTTP/UI。后续将补普通画布20步撤销、多选/组合、属性等核心依赖；云端、事实提取、策划及完整Agent仍未完成。

## 2026-11-10 20步持久撤销重做与原子画布操作（全量运行中）
TASK-07/08/T02新增本地核心切片。迁移011新增不可变canvas_operations记录；严格UUID操作ID、baseRevision、最多100个不同对象及编辑租约，整批原子提交。相同actor/操作ID/确切body重试复用原回执，不新增修订；异参拒绝；viewer拒绝。只有完整run_output追加日志可跨旧画布基准重基，用户写冲突仍拒绝。软删在新对象修订中记录deleted，不删除旧修订、资产、任务或输出；新绑定不能引用已删除修订。GET canvas仅列当前未删对象，历史引用保留。

参考已审计旧canvas/history.ts的有界历史思路，按B类改造为逐对象用户命令，不回滚整张画布快照。当前实现创建/文字编辑/拖动的20步撤销重做，支持Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl/Cmd+Y；输入框保留原生文字快捷键。新分支清空redo；会话/项目切换清空本地历史，重开保留最终服务器修订。恢复后台结果不会加入用户撤销栈。

保存前生成固定操作ID；失败保留确切待确认请求，显示“重试保存”和不含lease的“下载未保存内容”，阻止继续编辑或切换丢失内容。未知响应不自动重试；显式重试可识别已提交结果。下载为本页内容恢复材料，尚不是完整项目导出/导入或IndexedDB崩溃恢复。旧服务未声明canvasOperationsEnabled时保留旧保存路径、隐藏撤销按钮，不请求新脚本。

31项专项、4条本地浏览器通过：连续22次编辑精确撤销20步、创建撤销/重做、快捷键、新分支、重开、图片撤销保留原字节、成功写入但回复丢失后仅一修订、viewer403。首轮专项2失败：viewer FOR UPDATE提前受RLS过滤的错误语义、测试输出日志缺少真实FK目标；分别补只读权限预检与完整fixture对象后通过，失败日志保留。没有减少断言或调整超时。

真实CPU正常浏览器fb7f9f88-a72d-44a4-9e85-48e14af29d44及故障恢复浏览器25ba2e7e-3266-4f9d-ad78-ffba682dc413通过：后台结果返回后撤销文字、重做、下载、重开，始终只有一run/attempt/output；自有进程停止、无模型。20步历史截图已查看。

全量会话70091：work/canvas-history-full-test.log；六包构建74367：work/canvas-history-build.log。迁移011尚未应用日常DB，日常4310保持迁移010与旧保存能力。多选、基础组合、属性/锁定、完整文件对象/展示连线等仍待，不能将TASK-07整体标DONE。最近周额度已用45%/剩余55%。

### 画布撤销阶段冻结结果
全量70091已结束：83文件2943项全部通过，305.68秒；六包构建通过。专项与浏览器证据归档canvas-history-*.log，截图及真实自有CPU证据如上。准备第五次本机备份升级，011未通过前不加载日常DB。冻结代码不将本阶段写成完整画布或完整五场景完成。

### 第五次日常服务升级完成
05:38备份升级完成：1092文件hash一致，独立restore-check副本迁移10→11，25张既有表所有原有列摘要一致；launcher46768。日常入口及workspace-editor.js均200，源码模块含BoundedEditHistory。账号、项目和资产未重置；私有原始报告在work/local-workspace/backups/20261110-053803-19dabd53-a14d-4fd3-bd75-e2f497d101be；脱敏统计canvas-history-upgrade-summary.json。当前日常服务已具备原子画布操作、软删修订、20步用户撤销重做和未确认保存的手动重试。周额度已用46%/剩余54%，继续下一就绪项，保持20%停止条件。

## 2026-11-10 多选、平面组合、属性与锁定（全量运行中）
TASK-07/09/T02本地切片：Shift点选/Shift空白框选（按当前平移缩放逆变换）、组合成员自动展开选择、整组世界坐标移动、平面groupId、解除组合、复制和软删均使用同一原子保存及20步撤销协议。复制派生对象ID并重映射组合ID，引用原私有资产版本，不复制文件字节或历史binding；复制工具卡仍需显式固定输入。单对象属性可改标题、位置和尺寸，多选显示范围。新增locked/groupId是可选字段，不重写历史payload，无新SQL迁移。

参照旧App.tsx的复制ID映射、groupSelection/ungroupSelection与边界计算思路作B类改造：新对象协议采用平面成员及世界坐标，不照搬旧父子React Flow执行边/相对坐标，不引入嵌套组合。锁定在旧PATCH和原子入口共同校验：几何、删除或组合归属改变必须先单独解锁；同时解锁并移动拒绝。文字/标题仍可编辑，锁定副本默认可移动。普通组合不改变工作流执行依赖。

33项专项与6条本地浏览器通过，包含混合批次锁定失败整体回滚、旧入口绕过拒绝、复制保留私有原件、组移动一次撤销、组合重开、属性按同一对象ID重开、缩放框选无原生文字高亮。真实CPU正常0b68f6fd-c517-412f-a328-bcce16bce892和故障恢复5d30ce09-0b6f-460a-8aa7-b97ceeb3eddf均通过，自有进程停止、仅一run/attempt/output，无模型及付费请求。属性/框选截图已查看。

失败与修正：首轮点击工具控件触发自动选中属性栏，布局变化使取消点击落空；排除button/input/textarea/select/a后原流程恢复。多选解散后单击成员未收窄，增加“未拖动时收窄选择”语义。重开测试原用first()误依赖UUID排序，改按同一对象ID核对，未减少身份/数值断言。浏览器fixture改为每个非首次账号场景显式准备账号/项目，避免失败后worker重建空DB的级联登录超时。专项中非法类型fixture夹带text被严格schema拒绝、HTTPfixture误传expiresAt、多项目fixture未清理影响旧全局计数，均修正fixture并保留失败日志。未改超时、worker或重试设置。

GET runtime新增canvasSelectionEnabled；旧缓存服务不声明则隐藏高级操作，新HTML不会向旧schema提交这些字段。前向可选字段不代表可任意降级旧严格schema：新增字段写入后，应前向修复或按私有备份恢复，不把旧二进制回滚称为无损。

全量52860：work/canvas-selection-full-test.log；构建83366：work/canvas-selection-build.log。当前日常4310仍为上一20步历史版本（schema11），本节锁定/组合能力未加载，待终态通过后备份升级。完整文件卡、展示连线、资料提取/策划、模型网关及云端目标仍未完成；本周最近已用48%/剩余52%。

### 多选属性阶段冻结结果
全量52860已结束：83文件2946项全部通过，306.41秒；六包构建通过。证据归档canvas-selection-*.log等。下一项明确缺口：原卡在执行中被删除时，finishArtifact当前仍追加结果卡；计划书要求转入未归位资产列表，后续需补该列表和只放置既有结果的动作，不能重发生成。本阶段不据此宣称完整五场景已签收。

### 第六次日常服务升级完成
05:58备份升级完成：1096文件hash一致，独立restore-check副本11→11，26张既有表所有原有列摘要一致；launcher63920。日常入口200、首页含新能力判定，重开项目后可多选/组合/属性/锁定。未重置账号、项目或素材；私有备份work/local-workspace/backups/20261110-055813-242817fe-e635-4598-9566-5581bdf05590；脱敏统计canvas-selection-upgrade-summary.json。最新周额度已用49%/剩余51%；下一优先任务为原卡删除后的未归位结果保留与显式放置，再继续其余文件/资料/策划及云目标，完整项目未完成。

## 2026-11-10 未归位结果与显式再放置（全量运行中）
TASK-15/23、T09/T10本地闭环：迁移012允许初始run_outputs的object_id/object_revision成对为空，仍保留ready资产、原attempt、SHA和原始输出回执。完成归档时在canvas锁内检查当前源卡和工具卡；任何原卡已删则只归档、记录result_unplaced/completed，不追加结果卡或虚增画布修订。原始输出回执不可修改。

新增不可变run_output_placements和run_placement_requests；current_run_outputs为security_invoker视图，在调用者权限与底层强制RLS下读取最新仍存活且引用同一资产的卡片。原自动回填或后续放置的卡片删掉/更换资产即再次未归位，撤销删除可重新找回已有放置；不篡改旧placement或run输出。该视图不是owner权限旁路，专项验证跨项目读取为零。

LocalRunPlacement仅有DB/私有资产端口，无runtime、compiler、provider URL或生成端口。每次重新验证当前编辑权限、原快照hash、私有字节hash及PNG资产；新写入需要有效租约、基准修订和固定操作ID。固定ID重试复用回执，异参拒绝；不同ID但已有活卡只返回既有卡，不新增。用户放置写editor日志并可撤销，更新output_placed持久事件；不会创建run/attempt/outbox或再次prompt。

GET /v1/projects/{p}/unplaced-results提供微秒游标分页，游标绑定unplaced筛选，不能与全部任务游标混用。POST runs/{r}/place-output严格接收操作ID/baseRevision/x/y/lease，不接收actor、asset ID或URL。“未归位结果”入口提供下载、放置及查看；viewer只读，服务能力未声明时隐藏新动作。

UI先持久不含lease的操作指针再POST，不自动重试。响应丢失可显式确认同一ID，确认前阻止继续编辑，重开仍能核查；旧回执确认时卡已移除则清理旧指针并允许新的显式放置。新放置计入20步用户撤销。默认同步当前画布并寻找空位，避免挡住现有卡片；此修正来自实际浏览器首次失败，不使用force click。

43项专项及11项契约通过；6条本地浏览器、正常CPU和归档故障恢复回归通过。最终真实CPU删源卡5b9e77b6-1dcb-4e3f-9785-b78fd9c50248、删工具卡2f5a51df-3f25-4103-b003-d9b11f49544a通过：执行中删除→只归档→重开→下载→真实放置成功但回复丢失→固定ID确认→撤销/重做→删结果后再次放置，快照/资产不变，原件字节完全一致，只一run/attempt/初始output及一次本机prompt提交，自有进程停止；无模型或付费请求。工具卡用例额外覆盖旧放置卡已删后的重开确认。截图已查看。正常/归档回归证据分别a4ccb394-777c-4527-a3c9-d9f99c48cd7b、50bc9816-e893-40ab-869f-af06655adb7e。

首轮真实用例96ac1915-6908-43f5-ab58-798c63deee5b在放置/响应确认/撤销重做已通过后，因默认坐标与文字卡重叠导致真实点击被遮挡而失败；日志和图片保留，修复空位算法后通过，没有增加timeout/worker或弱化点击断言。原件完整性最终增加直接前后字节对比。

全量32768：work/unplaced-full-test.log；六包构建42289：work/unplaced-build.log。012尚未应用日常数据库，当前4310仍为上一多选/属性阶段schema11。最新周额度已用52%/剩余48%；文件卡、展示连线、资料事实/策划、模型网关、Agent和云端目标仍待，不标完整项目完成。

### 未归位结果阶段冻结结果
全量32768已结束：83文件2951项全部通过，308.21秒；六包构建通过。专项、契约、6条本地与4类真实CPU浏览器证据归档unplaced-*.log；保留首次遮挡失败日志与图片。准备第七次本机备份升级，按原26张表数据核验前向迁移11→12，不删除旧回执或重置用户资料。

### 第七次日常服务升级完成
06:30备份升级完成：1096文件hash一致，独立restore-check副本迁移11→12，26张既有表所有原有列摘要一致；launcher18100。日常入口200且首页含“未归位结果”，账号/项目/素材未重置。私有原始报告在work/local-workspace/backups/20261110-063038-dc8e4122-303f-4cdd-9ad8-9347fb5093e7；脱敏统计unplaced-upgrade-summary.json。提交68432f9。最新周额度已用53%/剩余47%；继续私有文件卡与后续就绪任务，完整五场景/云端/模型与Agent仍未完成。

## 2026-11-10 私有UTF-8资料文件卡（全量运行中）
FR-02、TASK-06/07/09、T02/T03本地切片。迁移013新增asset_versions.kind（旧资产默认image）、只读asset_documents元数据，以及asset_files与object_revisions的类型复合FK。普通file对象只引用document，image对象只引用image；旧PATCH/原子保存两入口先检查类型，数据库生成asset_kind再强制约束，不能伪装文件进入图片端口。历史payload与字节不改写，原子编辑/锁定/组合/20步撤销继续适用。

首个资料格式切片为UTF-8 TXT、Markdown、CSV，每文件2MiB、与图片共享每项目64MiB额度。服务端按文件名后缀/允许MIME及完整fatal UTF8解码校验，拒绝非法编码、NUL/非文本控制字节、主动格式后缀、伪MIME、超额和路径式文件名。存储保留原BOM/CRLF/Unicode字节，SHA覆盖原件；统计按解码后Unicode字符/行计算。JSON只读预览至多20000个UTF16单元且不拆代理对，原件下载每次鉴权、attachment/nosniff/CSP，完整字节不变。Markdown不解析成HTML，CSV不解释公式，资料内容不作为工具指令。

上传先校验与配额/当前权限，再在私有目录WX+flush写字节，登记ready版本；预览先授权再读文件并核对长度/hash，损坏或失权拒绝。复制仅复用版本，软删卡片不删原件，不通过删卡释放历史资产额度。配额专项使用明确标注的元数据夹具，不当作真实64MiB吞吐/容量验收。

HTTP新增POST /v1/projects/{p}/documents、GET /documents/{id}预览、?download=1下载；documentFilesEnabled控制入口。UI新增“添加资料”、资料卡、只读预览与下载、复制撤销和重开；预览弹窗内快捷键不影响背景画布。旧缓存服务不声明能力时隐藏新按钮。离线WorkspacePrototype仍只处理图片实验，明确拒绝资料，不能冒充真实身份/私有持久适配器。

38项资产/资料/HTTP/版本/契约专项通过；7条本地浏览器通过，验证真实登录上传、BOM/中文/emoji/指令字符串预览、原件下载、复制/撤销/重开，脚本标签不执行、没有run提交、伪装image/直接file绑定均422。真实自有CPU回归c85a9b2f-5442-43b3-9883-408aac61612f通过。磁盘验收documents/764cf114-6190-4a91-8288-a97c049693e7关闭并重开真实PGlite目录：原件89字节/sha一致、3条不可变file修订、1活卡/1存储版本、跨项目拒绝、文件冒充图片拒绝。预览/文件卡截图已查看。无新依赖，无模型或付费调用。

全量48943：work/documents-full-test.log；六包构建42751：work/documents-build.log。013未应用日常数据库，4310仍schema12。PDF/Office/任意二进制、资料编辑新版本、AI提取/确认/分析/策划、完整文件导出及云端仍待，不能标完整文件/五场景通过。最近周额度已用55%/剩余45%。

### 资料卡最终边界修复与复核（待全量终态）
首次全量84文件2958项中2957通过、1失败：旧对象改类型用例预期OBJECT_IDENTITY_CONFLICT，因新增资产查验顺序得到NOT_FOUND。调整为先执行既有对象身份/锁定约束，再查验引用资产；保留原断言，77项专项及第二次全量2958项全部通过，证据documents-full-test.log、documents-fixed-full-test.log，未放宽超时或worker。

追加UUID大小写及缺失payload引用回归后，修复013内引用CHECK为UUID语义比较并显式拒绝NULL（原字符串比较误拒绝大写UUID）。before-fix用例实际失败，修复后27项专项通过。013尚未部署日常库，没有改写已部署迁移；最终磁盘验收新case bb316fdb-b026-44aa-bb4d-ae2ba3869d6a通过，旧case保留为早期证据。最终全量work/documents-final-full-test.log运行中，最终六包构建work/documents-final-build.log通过。周额度07:09已用57%/剩余43%。

### 资料卡最终冻结结果
最终全量88227：84文件2959项全部通过，301.77秒；最终六包构建通过。7条本地浏览器、实际自有CPU、最终磁盘重开证据与失败修复日志已保留。本阶段没有新增依赖、真实模型或付费调用。下一步先备份升级日常4310（schema12→13），再推进普通展示连线；完整文件格式、资料提取/事实确认/策划、Agent及云目标仍未完成。

### 第八次日常服务升级完成
07:15备份升级完成：1106文件hash一致，独立restore-check副本12→13，28张既有表所有原有列数据摘要一致；launcher40136。入口200、首页含添加资料；账号/项目/素材未重置。私有备份work/local-workspace/backups/20261110-071506-8f042d2a-cc66-4678-8f30-fde4dd1f726c；脱敏统计documents-upgrade-summary.json。代码提交34b0628。周额度已用58%/剩余42%，未达到停止阈值。继续推进普通展示连线等就绪项，完整项目未完成。

## 2026-11-10 普通画布展示连线（全量运行中）
FR-02、TASK-07/08/09、T02本地切片。迁移014新增display_edges当前指针与不可变display_edge_revisions，项目内端点复合外键，强制RLS与只读历史；新连线/恢复活连线要求两个当前活端点，删除允许隐藏端点。端点身份不可换绑，标签纯文字最多240字符。kind固定display，不接受执行字段；没有binding/run/outbox/attempt副作用。

对象和连线共用原子canvas-operation、租约、画布修订、固定ID请求hash与不可变回执。objects可空但对象/边合计1..100项，UUID重复按大小写无关语义拒绝；旧无edges请求形状与回执保留。canvas_changes新增editor_edge精确指向边修订；边编辑属于用户编辑，不允许旧基准跨过重基，后台结果append规则不变。

UI两个所选对象可指定起终点/标签添加，属性内编辑标签和删除；SVG/textContent展示，拖动即时跟随，标签不是HTML。关系与对象共用20步命令历史，复制只带两端均在选择中的内部连线，创建/复制/撤销原子保存。节点软删时隐藏关系但不篡改其历史，撤销节点恢复显示。响应丢失后显式同ID重试，未保存JSON包含边且不含租约。

27项资料/HTTP/原子保存/展示边专项通过；8条本地浏览器最终通过，新增覆盖真实服务完成POST后丢回复→同ID确认、标签纯文本、混合复制/删除撤销、节点隐藏恢复和重开，零run提交。正常实际CPU回归5748287d-af46-47c6-9ea8-72e2b56bdc3d通过。磁盘验收d3398035-9673-456c-b4b2-26f3b34f7e7f关闭重开后2个边修订hash不变，旧回执复用且当前画布仍revision4，跨项目0行，runs/bindings/outbox/attempts均0；无模型调用。截图已查看。

首次浏览器两失败均保留：旧标题断言因新增h3匹配多项，限定原h2且仍断言原文本；新用例节点恢复后属性无选择，补真实点击选择再删关系。未放宽timeout/worker/断言。首次磁盘脚本因未创建自有父目录ENOENT失败，补mkdir后新case通过；保留失败report。全量55401：work/display-edges-full-test.log；六包构建41927：work/display-edges-build.log。014尚未应用日常库，4310仍schema13。最新周额度59%已用/41%剩余。任务卡、资料事实/分析/策划、模型网关、Agent、导出与云目标仍待，不标完整项目完成。

### 迁移字节冻结复核
部署前将新增014统一为仓库要求的LF，git hash-object --no-filters与暂存blob一致（df442e6a7610fb9dff1ab6aeb13204235f4866e7）；SHA256 054735f5ec26535f1d73511ae4e038087aeaab16debeac7ff40b70b7800af8ed。SQL语义未变，旧已部署迁移未修改。最终磁盘验收另建cdf62a77-f883-413f-87fe-5b287e7d07a9，通过关闭重开、历史hash及原回执复用，早期case按原字节留存不重开。

### 展示连线最终冻结结果
全量55401终态：85文件2964项全部通过，311.60秒；六包构建与最终8条浏览器通过。实际CPU回归及最终LF迁移磁盘重开通过，无依赖/模型/付费调用新增。准备第九次本机备份升级13→14；任务卡等后续范围保持待办。

### 第九次日常服务升级完成
07:28备份升级完成：1115文件hash一致，独立restore-check副本13→14，29张既有表所有原有列数据摘要一致；launcher61144。入口200且首页脚本包含添加展示关系；账号/项目/素材未重置。私有备份work/local-workspace/backups/20261110-072816-11975f95-ba2a-4619-a363-94e8cec58562；脱敏统计display-edges-upgrade-summary.json。代码提交dd7c0f8。周额度已用59%/剩余41%，尚未达到停止条件。下一项独立任务卡及后续事实/策划/模型/Agent/导出/云目标仍待，保持完整目标进行中。

## 2026-11-10 独立运行任务卡（全量运行中）
FR-02/07、TASK-07/09/15、T02/T09本地切片。新增普通task对象严格仅接收runId与公共布局/标题/锁定字段；不接收state、结果URL、执行参数或费用。迁移015生成task_run_id并使用(project_id,task_run_id)复合FK到既有runs，缺引用拒绝。旧PATCH与原子保存两入口均检查当前可见同项目run；固定run引用不可换绑，复制可引用同一运行。卡片软删/撤销只追加对象历史，不取消运行、不改快照/产物、不重新enqueue。

工具卡和任务历史新增“添加任务卡”，均先等待未完成编辑、同步画布、取得空位，再以固定操作ID/原子回执保存，回复丢失显式同ID确认。任务卡提供持久状态、固定输入/模板修订摘要、日志、查看结果与鉴权下载；日志复用持久事件/SSE历史入口，指定运行不在第一页时可单独读取，不需要浏览器旧pointer。运行状态仅从GET run读取，同一项目/run的活卡共享一个只读轮询，序号防回退，重绘/切项目停止旧监听；复制不会增加执行请求。离线Prototype明确拒绝task持久引用，不能冒充真实适配器。

18项任务卡/HTTP/原子保存专项通过；9条本地浏览器最终通过，覆盖服务器已保存但回复丢失、同ID确认、复制/删除/撤销重做、取消状态同步、指定日志、历史再添加及重开。当前项目仅一run、客户端只一次POST runs，任务卡不能作为图片绑定输入（422）。真实CPU浏览器f3b0c955-d64e-4bd6-8fd5-9ea341fbf0b2通过：ready任务卡下载与原结果字节相同，重开仍成功，只有一run/attempt/output与一个自有CPU进程，最终停止；截图已查看。磁盘验收daf0bdd0-6ec8-4402-bc82-991ed3da358d为明确无worker的引用契约fixture：关闭重开后1活卡/3修订，原queued run/快照不变，原回执复用、0attempt/1原outbox，跨项目0行，不当作真实生成证明。实际生成证据仅来自上述CPU场景。

全量48301：work/task-cards-full-test.log；构建20925已通过：work/task-cards-build.log。015尚未应用日常库，4310仍schema14。未新增依赖、模型或付费调用。完整资料提取/事实确认/分析策划、模型网关、Agent、导出恢复、云端与性能仍待，不标完整项目完成。

### 任务卡指定日志补充验证
额外对任务列表第一页注入“省略所指运行”的传输夹具，运行详情及事件仍来自真实服务；从任务卡直接打开指定日志成功，不依赖列表首30项。修正回退行插入前清理空列表说明，避免已有指定运行时仍显示“此项目还没有任务”。最终9条浏览器通过20.8秒，未新增运行或伪造成功状态；这是UI分页路径注入，不宣称真实大规模任务性能验收。

### 任务卡最终冻结结果
全量48301终态：86文件2967项全部通过，315.36秒。最终六包构建50660与9条浏览器通过，正常真实CPU与磁盘引用重开通过。准备第十次本机备份升级14→15；保留原账号/项目/原件，不启动新模型或付费适配器。完整项目目标仍进行中。

### 第十次日常服务升级完成
07:40备份升级完成：1118文件hash一致，独立restore-check副本14→15，31张既有表所有原有列数据摘要一致；launcher64768。入口200且首页含添加任务卡；账号/项目/素材未重置。私有备份work/local-workspace/backups/20261110-074024-76d3215a-0be5-4f75-8794-15d284e98d51；脱敏统计task-cards-upgrade-summary.json。代码提交1535ac8。周额度已用61%/剩余39%，尚未达到停止条件。下一步模型网关能力/费用未知协议及资料事实/分析策划等就绪部分，实际付费/云调用因账号与环境未配置仍不启用；完整目标保持进行中。

## 2026-11-10 模型能力网关协议与本地路由（全量运行中）
TASK-16、FR-07/08/09的LOCAL_PARTIAL。复核旧imageProviderContract及版本/报价指纹约束后，仅借鉴“固定能力/版本、指纹与未知费用不归零”，没有把旧租户/报价/付费执行接口直接挂到新工作区。新增服务端固定目录：local-comfy-resize、document-facts、fact-analysis、visual-plan。只有本机CPU缩放声明已验证零供应商费用，ready/queue_only/not_configured区分配置与排队条件；ready表示执行入口已配置，不替代实时健康/质量验收。提取/分析/策划均provider=unconfigured、model=null、cost=unknown，无金额字段，无远端适配器或Key读取。

新增严格机器契约model-capability/model-cost/model-preflight；费用known用十进制字符串，unknown不接受amount=0等伪字段。GET /v1/model-capabilities要求登录，仅给出服务器自有脱敏目录；POST /v1/projects/{p}/model-preflight要求当前项目编辑权限、同源与严格固定能力ID/version/operation/参数。不接受URL、actor、Key、任意provider参数。预检明确submitted=false/executionAuthorized=false，不创建run/snapshot/outbox/attempt，不冻结预算；未配置能力空参数只返回needs_configuration/未知费用，有输入参数则拒绝，不外发资料。

LocalBoundRuns改为通过同一网关冻结能力，新增快照schemaVersion2和modelCapability descriptor/hash，worker领取及归档校验器重新验证版本、整段hash与本地白名单；单纯重算篡改内容hash也不能扩权。旧v1历史仍按原本地白名单验证，不添加字段或重写hash。原resize请求hash/幂等policy不变，所以升级后旧幂等key可以原样复用回执；usage认识v2并验证能力指纹，损坏时关闭，不给假零费用。此为新工作区统一协议基础及既有CPU适配，不声称已完成真正云LLM提取/分析/策划。

50项网关/版本/费用/worker/HTTP专项通过；真实HTTP验证未登录401、外项目404、篡参422、版本409以及预检后0run/snapshot/attempt/outbox、预算无冻结/支出。旧v1真实SQL夹具幂等重读与领取通过，原hash不变；v2缺指纹拒绝worker和usage。首次新增测试因根测试目录不能解析@canvas/contracts别名而加载失败，改为本仓库相对契约导入，保留失败日志，未改业务断言。真实CPU浏览器a3e4be83-3429-407e-929e-d1ab910a26a1通过：新v2正常执行/任务卡结果下载/重开和单次提交闭环，无新模型或付费请求；自有进程最终停止。六包构建已通过。

全量87893：work/model-gateway-full-test.log运行中。无数据库DDL，日常4310仍前一任务卡阶段二进制，schema15；新代码须待全量终态后备份重启。真正文本模型供应商账号/许可与实际调用、资料来源事实、分析策划、Agent、JSON导出恢复、原生多连接与性能仍待；无云/付费环境不作为其余就绪本地任务停止理由。

### 模型网关协议最终冻结结果
全量87893终态：87文件2972项全部通过，311.03秒；六包构建与真实CPU浏览器通过。另为实际CPU证据增加SQL快照版本/能力pin的直接断言与脱敏导出，避免仅根据调用路径推断v2运行；不变更运行代码或放宽原有断言。代码无DDL，不改旧v1快照和既有幂等请求hash。最新周额度已用62%/剩余38%；准备本机备份重启。
最终实际CPU SQL证据d995a1cf-1533-4f18-b6ef-0d56d9b03b65通过：数据库schemaVersion=2、local-comfy-resize v1、ready、零供应商费用及capabilityHash已直接断言并导出model-capability-pin.json；同一结果字节、任务卡重开和单次运行约束继续通过。未读取用户日常数据。

### 第十一次日常服务备份重启完成
07:52完成：1124文件hash一致，独立restore-check副本15→15（无DDL），31张既有表全部原有列数据摘要一致；launcher27416。入口200、未登录能力目录401；未在日常库添加测试账号或素材。私有备份work/local-workspace/backups/20261110-075226-0cce5553-32af-4537-9dc9-d0573012ed66；脱敏统计model-gateway-upgrade-summary.json。代码提交b3b51b5。周额度已用62%/剩余38%，未达到停止阈值。后续推进有原件来源的本地规则资料候选/人工确认等就绪基础，并保留真实模型/分析策划/Agent/导出/云端门槛；完整目标进行中。

## 2026-11-10 资料来源候选与人工事实确认（全量运行中）
FR-09、TASK-17/T14的LOCAL_PARTIAL基础；不替代未配置的真实模型提取/分析/策划。新增确定性local-key-value-v1，仅识别UTF-8资料中明确“字段：值”（可带列表前缀），每原件至多50候选、字段80/值1000字符、单行引用1200；未匹配/超限行计数并最多列200行，原件仍完整保留。不推断产品属性/单位/缺项，不解析CSV公式或执行资料指令；confidence=null，候选默认未确认。未知值标记，同名不同值冲突显式保留；冲突未处理或未知值不能确认，需明确排除冲突候选或人工核对修改。

迁移016新增document_fact_sets当前指针、不可变document_fact_revisions和固定请求ID回执。事实固定原document资产版本/SHA、BOM移除后但保留原换行的UTF16 start/end、原文行号/完整quote；人工修改保留original/name/value及source，不改原件或旧候选。userConfirmed/excluded、manuallyEdited/unknown由严格输入及服务端派生；客户端不能传source、quote、confidence或author。历史读校验payload hash和资产来源；项目内document复合FK、强制RLS与当前编辑权限/单编辑租约保护，新保存另有事实baseRevision。事实写入不增加画布修订，不创建run/outbox/attempt/模型调用。固定ID响应丢失可原样确认（即使原租约失效），异参拒绝；不同ID重新整理已有原件不重置人工事实。

新增GET /document-facts/{assetId}与?revision=N，当前/历史均鉴权；POST action=extract/save要求当前角色、租约、严格body，facts路由单独256KiB上限，其余JSON仍64KiB。read返回canEdit供UI只读；历史版本不可原地改写。UI资料卡“资料事实”按能力标记加载独立模块，明确本地规则与人工确认；字段修改清除本地确认，逐条勾选/排除，显示原文、来源hash、冲突/未整理数量，历史只读。facts弹窗快捷键不操作背景画布。未保存关闭有保留/明确放弃路径，导出草稿不含租约；写前localStorage持久固定请求且不自动POST，网络丢回复可关闭/重开再确认。确定拒绝不冻结表单，保留编辑供修正；未知提交保留重试记录。

24项来源/资料/HTTP/网关专项通过；真实HTTP覆盖大于64KiB的50条长字段保存，viewer只读、来源/actor/租约额外字段拒绝。10条本地浏览器通过：原文中的脚本仅文本、丢回复重开同ID确认、人工修改自动清除确认、冲突处理、历史原值不变、草稿下载/明确放弃和刷新恢复、原件字节不变、零run提交。截图document-facts-confirmed.png已查看。真实CPU回归fb588676-05d3-4cf8-b867-fa9492096921通过，原有v2运行/任务卡下载不受影响，自有进程最终停止。

实际磁盘关闭重开验收9f756316-c3f8-4cd4-9804-70fe71ed43fb通过：原件sha3775c418e5a1645f499fadba6662402721d7fdf5d5425c6546485fe478eb9cd1及字节不变，原文锚点精确，v1未确认与v2人工确认同时保留，2事实修订/2回执，旧ID重试复用，外项目拒绝，0run/画布修订。无依赖、模型或付费请求新增。

保留两次测试返工：首次不可变性测试先被应用角色无UPDATE权限挡住，改为分别断言应用拒绝与特权测试连接触发IMMUTABLE_HISTORY，不为通过测试增加权限；首次HTTP夹具误传服务内部lease.expiresAt而严格422，改为token/fencing并保留额外字段422断言。失败日志均保留，业务限制/超时/worker未放宽。

全量14683：work/document-facts-full-test.log；六包构建64480已通过。016未应用日常库，4310仍schema15的能力协议版本，待终态后备份升级。图片/文字卡来源、多原件合并、新增人工来源条目、真实AI提取/分析与可编辑策划、Agent、导出/云端/性能仍待，不能标完整T14或全部事实功能完成。最近周额度64%已用/36%剩余。

### 资料事实阶段最终冻结结果
全量14683终态：88文件2977项全部通过，308.06秒；六包构建、10条本地浏览器、真实CPU与磁盘重开通过。无依赖、模型或付费调用新增。准备第十二次本机备份升级15→16，保留原账号、资料与旧事实版本；源方案完整模型提取/分析/策划及五场景目标仍未完成。

### 第十二次日常服务升级完成
08:12完成：1120文件hash一致，独立restore-check副本15→16，31张既有表全部原有列数据摘要一致；launcher61796。入口200、资料事实模块200、首页含资料事实入口；未在日常库新增测试账号或素材。私有备份work/local-workspace/backups/20261110-081208-da1df219-4e7d-472e-a0a0-2b20d71abbb6；脱敏统计document-facts-upgrade-summary.json。代码提交a7d7d06。最终周额度复核已用66%/剩余34%，未达到停止条件。后续继续多源事实/策划与其他本地就绪项，真实模型和完整五场景目标仍未完成。

## 2026-11-10 可编辑人工视觉策划与固定来源（全量复跑中）
FR-09、TASK-18/T14的LOCAL_PARTIAL。模型网关中的自动plan.draft仍未配置，本阶段provenance固定manual-authoring-v1，不生成占位AI结果，不把人工编辑当模型分析。策划包含名称、goal/audience/style、逐镜头description/copy/angleConstraints、图片资产引用/输出规格和assumptions；最多20镜头/50事实/50独立图片。来源必须是当前仍已确认且未排除/非未知的事实，服务端冻结事实完整内容、原件SHA、事实版本hash和版本作者；不从客户端接收证据或作者。同名不同值跨资料冲突拒绝。图片必须同项目ready图像资产，保存SHA与名称。新保存若事实版本已更新/撤回则拒绝，客户端必须明确核对重选，旧策划及其固定证据不改写。

迁移017新增visual_plans指针、不可变visual_plan_revisions、fact/asset引用与固定操作回执；复合FK、强制RLS、当前编辑权限/单编辑租约、策划baseRevision保护。保存只写策划，不改画布修订，不建run/outbox/attempt。相同ID/参数重试返回原回执，即使原租约失效也可确认，但当前权限仍检查。GET list/current/history校验payload hash；current sourceChanges投影只提示当前事实head变化，不篡改旧证据。已确认来源与策划列表提供绑定项目/类型的keyset游标，不用浏览器列表位置当身份。

普通text对象可带planSource(planId/revision)作来源引用；DB生成列与复合FK约束同项目既有策划版本，缺版本/跨项目拒绝。文字副本可独立编辑，引用表示来源而非与原策划同步；复制/软删/撤销只影响普通画布，不改策划历史，不形成执行绑定。旧离线Prototype明确拒绝该持久引用。原schema16已有数据不改写，新增列只投影已有payload。

UI新增“视觉策划”列表、人工新建/编辑、镜头增删/排序/图片选择/输出规格、确认事实勾选与原文查看、历史只读、显式重读重选来源、草稿下载及放到画布文字副本。卡片入口固定原策划版本；可查看最新但不自动改副本。写前持久不含lease的固定请求；成功已提交却丢回复可关闭重开确认；提交前丢请求且重开后来源已变，则回滚拒绝并保留草稿，关闭仍需明确处理。补正共享恢复逻辑：对重开后的确定拒绝重新标记dirty，避免恢复草稿被当作已保存关闭；事实面板同步保留该状态。无自动POST、外发、生成或收费。

25项策划/事实/画布/HTTP专项通过，11条本地浏览器通过。策划用例真实验证镜头排序、图片/事实选择、保存后丢回复→重开同ID确认、第二次提交前丢请求→重开时同步更新事实→拒绝并保留草稿→重选→新版本、历史只读、旧版放画布撤销重做、卡片查看原版与最新。单独补测文字副本修改并重开，API原版文案及当前策划版本均不变，0run提交。截图visual-plan-editor.png与visual-plan-canvas-copy.png已查看。六包构建与实际CPU回归12a95cc4-d8d8-4531-9192-ab1ad70bb19b通过，原缩放/归档/任务卡未受影响。

实际磁盘验收c5a1345a-51c7-4c57-ae56-b5bda54545df通过：2个策划修订/2回执，旧策划hash不变、来源事实固定v2、图片和资料原字节保持，旧ID确认仍返回原v1而current保持v2，文字副本固定v1，跨项目拒绝，0run/outbox/model请求。原始资料sha439477c695b27bcb0faa0137e4907b41bc3655faad847829ef230873b88bdd60。

首轮全量85631：89文件2982项中2981通过、1个旧locked-production-native契约用例触发原5000ms测试超时（实际6247ms）；保留visual-plans-full-first-failure.log。未改旧供应商实现、超时、worker或断言。同名4场景隔离复跑通过（43因-t筛选跳过），12.11秒；这是隔离验证，不冒充47项全通过。初次全量同时有构建/自有CPU用例，但超时原因未确定，不能仅凭重跑推断已修复。最终全量59478 work/visual-plans-final-full-test.log独立运行中；本地4310仍schema16，未部署017。最近周额度已用68%/剩余32%。真实AI提取/分析/自动策划、Agent、导出恢复、云端/原生多连接/性能及完整五场景验收仍未完成。

兼容边界：017新增text.planSource写入后，旧S16严格对象schema不保证可编辑这些新副本；优先前向修复，降级需按私有备份恢复并核对升级后新增数据，不能称无损二进制回滚。既有无该字段的历史对象不改写。

### 人工策划阶段最终冻结结果
最终全量59478：89文件2982项全部通过，329.96秒，无跳过。原4worker配置、5000ms测试/生产期限及断言未改，未针对超时修改旧业务实现；本次完整复跑未复现旧用例超时，但根因仍未确定，首轮失败与隔离日志继续保留。六包构建、11条本地浏览器、独立文字副本编辑补测、真实CPU及磁盘重开通过。无依赖/模型/付费调用新增。准备第十三次本机备份升级16→17；完整项目与真实AI场景仍未完成。

### 第十三次日常服务升级完成
08:46完成：1130文件hash一致，独立restore-check副本16→17，34张既有表全部原有列数据摘要一致；launcher64620。入口200、策划模块200、首页包含视觉策划；账号/项目/原件未重置，未在日常库添加测试账号或素材。私有备份work/local-workspace/backups/20261110-084631-0d78b420-b8ae-4df1-a087-a35921c6b29c；脱敏统计visual-plans-upgrade-summary.json。代码提交6b6d0e5。最终额度复核已用70%/剩余30%，未达到停止条件。人工可编辑策划已就绪，自动AI分析/策划未配置；下一就绪范围为Agent权限与审批基础、导出/性能等，完整目标继续进行中。


## 2026-11-10 TASK-19 授权审查基础（LOCAL_PARTIAL，非执行授权）
新增迁移018与LocalAgentReview，固定review_only/local-agent-review-v1；L0建议、L1审批、L2/L3范围判定全部返回executed=false、executionAuthorized=false。仅支持已配置的零供应商费用本地缩放工具目录，不接模型、shell、任意URL、删除、覆盖、发布或支付。冻结主体/项目、绑定与对象修订hash、资产SHA、模板/工作流版本、模型能力hash、参数、费用0、期限、次数/像素上限；审批hash覆盖完整提案，nonce项目内唯一且大小写归一。固定请求重试不延长授权，换参数拒绝。

授权/提案/审批/撤销不可变，强制RLS、同项目复合FK与父记录主体约束；提案计数数据库触发器只允许逐一增加并受授权上限约束。当前角色、来源修订、能力变化、过期、撤销在每次新提案/审批及审查中重新核验；viewer仍可撤回自己的旧授权，恢复角色不会恢复已撤销授权。嵌套路由改为明确动作白名单，拒绝错误资源/动作组合。原手工runs请求仍严格拒绝agentApproval注入，无execute路由。

28项四文件针对性测试、六包构建、真实CPU浏览器回归通过。首个HTTP测试发现旧嵌套路由只允许runs导致提案404，已改明确白名单并保留失败日志，未降低限制。真实CPU证据87f871f6-cd79-4599-b779-708fb3dc8e3c。实际磁盘关闭重开b3232238-0242-42e2-88b4-a2fb022915d4通过：提案hash、nonce重试、原有效期保持，撤销后阻断，0run/outbox/attempt/model调用。全量测试仍运行，018尚未部署日常库。

重要未完成项：审批尚未一次性消费并与run/snapshot/outbox同事务创建，尚无自主循环或执行授权UI。以后接入执行必须使用新的明确执行policy/mode和重新授权，不能把这些review_only记录静默升级成执行权限；执行前撤销/过期及当前权限检查必须接线。完整TASK-19/20、自动AI/云图、导出恢复、原生多连接与性能验收继续待办。

### 授权审查阶段最终冻结结果
全量90文件2988项全部通过，298.12秒；六包构建、真实CPU与磁盘重开通过。原测试期限、4worker与断言不变，无付费调用或新增依赖。准备本机备份升级17→18；审批消费/任务原子创建和执行撤销守卫仍未接线。


### 第十四次日常服务升级完成
09:19完成：1152文件hash一致，独立restore-check副本17→18，39张既有表全部原有列数据摘要一致；launcher33492，入口200。私有备份work/local-workspace/backups/20261110-091859-49aef18a-50fe-4add-b078-aca8944aeb17，脱敏统计agent-review-upgrade-summary.json。代码提交5a883cf；未在日常库添加测试账号或素材。review_only授权记录不会执行任务，也不能未来静默升级为执行授权。最近周额度已用73%/剩余27%，继续审批消费/任务原子事务及运行前撤销检查，达到剩余20%时保存并暂停；完整实施目标仍未完成。


## 2026-11-10 Agent任务原子创建接线第一步（仍LOCAL_PARTIAL）
将LocalBoundRuns.create的已有真实创建事务提取为内部createInTransaction。默认create仍通过db.asActor调用同一实现；内部入口验证数据库当前actor与可信actor一致、当前项目编辑权限，不接客户端authorization或review_only记录。预算串行锁、固定绑定/版本核验、v2快照、run/outbox仍同事务；原手工requestHash与返回格式保持。

27项四文件专项通过：调用方在成功创建后抛错整体rollback；数据库最后outbox INSERT注入失败时无孤立snapshot/run/预算变化；重试可创建新run；原hash/去重不变；同项目其他designer不能替换actor，viewer不能写。另有真实磁盘验收93cf12d1-305a-49c3-a45d-ec8ded4fa2ab，两次关闭重开：第一次rollback后snapshot/run/outbox/attempt全0；第二次提交后各1/1/1/0，hash不变且请求复用原run。这是持久排队证据，不是执行成功；未启动dispatcher或供应商。

六包构建通过，全量测试运行中。待完成新的明确执行授权mode/policy、一次性消费记录、Agent身份requestHash/新快照、claim/beforeSubmit撤销与有效期核验、UI与真实CPU验收；尚未把审查nonce当执行授权。接线调用链/锁序和提交边界详见docs/AGENT_EXECUTION_INTEGRATION.md，设计不等于已实现。未新增迁移/依赖或付费调用，日常4310仍为已部署审查版本。

### 共享事务入口冻结结果
全量91文件2991项全部通过，298.27秒；六包构建、真实磁盘两次重开与自有CPU浏览器a0093f60-8a7c-441a-8781-609a06fd42bc通过（13.7秒）。无新增迁移/依赖/付费调用，未改变超时或4worker配置；日常4310保留上一稳定审查版本。本次保存共享事务入口及后续接线设计，下一步实际接入新执行授权、nonce消费、快照与worker guard，不能把设计称为已实现。本周额度已用74%/剩余26%，目标保持active，继续至20%条件。


## 2026-11-10 可执行本地Agent单action内核（FR-10/TASK-19/20 LOCAL_PARTIAL）
新增明确local_resize_execute/local-agent-execute-v1模式，旧review_only记录不升级。L0拒绝、L1逐提案hash/nonce审批、L2/L3固定零供应商费用缩放范围；授权仍限600秒/8提案及固定像素/绑定/来源/能力hash。模式隔离列表/游标，执行UUID归一；不新增模型/付费/URL/Shell/高风险工具。

迁移019不可变agent_execution_consumptions，唯一提案/run/非空nonce、原审批nonce复合FK、强制RLS及SQL触发核对。执行核验与schema3快照/run/outbox/消费在同一事务，消费插入失败全回滚。手工hash与v1/v2不变。新增执行命名空间HTTP及可信actor/当前角色检查，不接受客户端scope/actor注入。响应创建状态不是运行成功；查run获取实际状态。

worker启动前预检、claim、beforeSubmit重复核验消费pin/当前权限/来源/能力/有效期/撤销；伪造pin无消费拒绝，已撤销工作不启动CPU或读输入。撤销先释放grant锁后尽力取消run，避免反向锁序；角色不足可取消不可用，但撤销持久，恢复角色不会复活授权。submitted边界已先完成的任务按已提交处理，ready结果保留，archive-only不检查新的执行许可，也不再生成。

65项七文件专项、六包构建通过。磁盘重开+真实CPU62568892-fc11-4845-8254-56219b08359c通过，各1消费/run/snapshot/outbox/attempt/output，64×64正确像素/原件不变/运行时停止，重试及ready后撤销不重投。归档故障685cb617-75ff-4b93-b988-a1ea7ec0f510通过：撤销、原actor降为只读后另一编辑者从缓存恢复，不再次生成。原手工浏览器CPU a6c937ed-e712-4c82-a78a-bb041bb8fdf5通过。初始类型推断与测试夹具base/RLS错误码/本机HTTP header返工失败日志保留，未改权限/超时/worker来通过。

全量79128 work/agent-execution-full-test.log运行中，019未应用日常库。下一步界面与有限工具循环仍未实现，不标完整FR-10/TASK-19/20/T15完成。原生多连接并发、真实AI/云图、导出恢复/性能和完整五场景仍待。旧S18不能保证处理新执行mode/v3，优先前向修复，降级需核对私有备份与新增数据。详见AGENT_EXECUTION_INTEGRATION.md。

### 可执行单action阶段最终冻结结果
全量92文件3001项全部通过，298.52秒；六包构建、65项专项、真实CPU与磁盘重开、撤销后其他编辑者纯归档恢复、原手工浏览器CPU回归通过。原超时/4worker/断言不变，无依赖/付费调用新增。准备备份升级18→19。界面、提案/回执读取体验与有限自主循环仍待，不能标完整Agent完成。


### 第十五次日常服务升级完成
09:49完成：1163文件hash一致，独立restore-check副本18→19，44张既有表全部原有列数据摘要一致；launcher30224。入口200，新执行目录未登录401；账号/项目/原件不重置，未在日常库新增测试账号或素材。私有备份work/local-workspace/backups/20261110-094857-fd188b33-bda0-450d-b642-bf02f78e2319；脱敏统计agent-execution-upgrade-summary.json。代码提交512c1e3。周额度已用76%/剩余24%，目标保持active，继续至用户20%停止条件。

下一就绪工作：实现授权/提案/逐项审批/执行/撤销的人类操作界面；补GET按授权读取提案及消费run回执（当前每授权最多8提案），使刷新后不依赖浏览器唯一记忆。所有写操作固定ID/nonce持久且不自动POST，明确重试响应丢失；当前可读但无编辑权限者仍能撤回自己旧授权。后端已支持单action真实执行，不代表有限Agent循环/完整工具目录或模型已配置；完整实施目标继续。


## 2026-11-10 本地Agent授权操作界面（FR-10/TASK-19/20 LOCAL_PARTIAL）
新增workspace-agent.js独立原生dialog，以agentExecutionPanelEnabled能力标记启用；旧服务器无该标记则隐藏入口，既有滚动升级回归通过。工具/固定输入、L0至L3、期限/提案次数/像素数与明确执行范围勾选后创建新执行授权；新授权不运行任务。用户创建固定参数提案，核对固定输入/版本/SHA/费用0/期限/hash，再独立审批和明确执行，不自动审批或自动生成。字段/数字上限本地提示，服务端仍为权威。纯textContent与Option，不执行来源文字。

新增GET /agent-execution-grants/{id}/proposals，限定原主体/项目/模式、最多8提案；当前编辑权限、审批nonce和不可变消费run回执可重开读取，消费pin与授权/提案hash关系校验。列表返回当前canEdit，不靠失效lease推断授权。viewer不能新建/审批/执行，仍可撤回自己的旧授权。

每用户/项目一条固定写intent，含固定ID/nonce但无cookie、lease或key；先成功localStorage保存再POST，不自动重发。响应丢失后保留重试记录与完整请求，可下载/关闭/重开明确重试；确定拒绝保留记录供下载或明确清除。存储失败停止提交。读取期间禁用依赖选择的操作，切换提案清除人工勾选，审批后还需再次明确执行。关闭忙事务受限；项目/generation隔离异步响应。完成结果可手动读取、下载、查看画布；使用服务端消费回执阻止已消费提案再次执行。当前是人类单提案界面，不是自主循环。

25项三文件专项、六包构建、完整12条本地浏览器通过（25.0秒）；另独立viewer撤回补测通过。浏览器实测：提交已commit却丢回复→关闭→刷新→无自动POST→同ID明确重试，服务端只有1run/outbox/消费、0attempt；再次刷新从服务端回执恢复，执行禁用；撤销关闭队列；新授权后降viewer可撤回但不能新建。截图agent-panel-pending/revoked/viewer-withdraw已查看并修正勾选框布局/中文状态。

真实CPU界面4cb9f373-fced-4838-a083-d477763359db通过：逐项审批→执行→256×256真实图→下载原像素/查看画布→刷新回执恢复无第二POST→ready后撤销保留成果，各1run/attempt/outbox/消费/output，原件不变，自有进程停止；原手工CPU e351e8af-26a9-426c-a916-499bca5bde13通过。已保留runtime契约新增能力字段、首轮references参数名、CPU验收SQL错列三份失败日志，未降断言/权限/超时/worker。7079dd31-ff65-4771-be85-26a3870b5fb5为首轮CPU浏览器用例失败证据（已生成/下载后断言SQL错列），不能称整体通过；88f30952-be02-4019-a33f-d3f4f37d2674和4cb最终通过。

全量45011 work/agent-panel-full-test.log运行中。没有新迁移或依赖；4310暂保留上一稳定后端（新静态入口因旧runtime无能力标记而隐藏），待通过后备份刷新schema19→19服务。有限自主工具循环/完整审计、真实AI/云图、项目导出恢复、原生多连接/性能和完整五场景仍待，不能标完整FR-10完成。最近周额度已用78%/剩余22%，达到20%保存并暂停。

### 授权界面阶段最终冻结结果
全量92文件3002项全部通过，295.81秒；六包构建、25专项、完整12条浏览器、viewer撤回补测、Agent真实CPU界面与原手工CPU回归通过，超时/4worker/断言未放宽。准备第十六次备份刷新schema19→19服务，无新迁移或付费调用。周额度已用79%/剩余21%；完整目标未完成，20%时保存并暂停。
