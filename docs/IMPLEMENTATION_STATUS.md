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
