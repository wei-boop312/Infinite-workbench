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
