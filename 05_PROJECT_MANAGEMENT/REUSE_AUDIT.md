# 历史任务与现有代码复用审计

日期：2026-11-09。范围：检索历史聊天、核对候选源码与已有验收记录，并复跑有限本地测试。结论：存在值得保留的画布与ComfyUI插件代码，应从现有实现建立迁移验证分支，暂不按新文档的候选技术栈重新开发全部模块。

本文件记录实施启动前的审计时点。后续已按用户授权建立开发副本并推进本地实现，当前状态见[实施进度](IMPLEMENTATION_PROGRESS.md)；下文“本轮未改动”等描述不覆盖后续实施轮次。

本轮没有改动旧业务源码、安装依赖、读取用户凭据、启动日常服务、调用付费供应商或部署。测试使用既有依赖和测试夹具；不把历史授权、自动续做要求、模型选择或额度停止线当成本轮执行指令。

## 证据等级与结论范围

- H：实际读取的历史聊天消息；历史助手声称通过的结果仍是历史记录。
- F：本轮查看的文件、代码及git基线。
- T：本轮重新执行的限定测试。
- U：未验证的生产、云端、模型、许可或人工视觉条件。

分类：A候选为可原样迁入的纯数据/纯逻辑，但需保留来源与目标集成验证；B为可改造复用代码；C为设计和经验借鉴；HOLD为暂不进入首版。这里不是完整仓库逐文件A/B/C/D审计，未给任何模块生产就绪或最终许可批准，不强行列D类废弃项。

## 检索到的历史任务

以下标题使用应用返回的原文，省略号也是其原始标题的一部分。Codex活动历史清单共34条，已归档清单为空；ChatGPT读取前两页共100条标题，从相关候选中读取消息。并非检索了账号所有更早聊天或其他主机。

| 来源/聊天ID | 原标题 | 阅读范围与价值 |
| --- | --- | --- |
| Codex 01a0de0a-5cb8-7912-8dc4-b4fc0c7af83a | 现在我们讨论一下关于AI在电商设计行业的应用，结合现在的AI环境，你认为AI能做到哪些，怎么在AI赋能的基础上降低多余… | 最近15轮；定位真实旧画布仓库、提交及付费执行边界 |
| Codex 01a137a3-b8a5-7043-8ad2-9baa1adc8fa0 | 现在我们讨论一下关于AI在电商设计行业的应用，结合现在的AI环境，你认为AI能做到哪些，怎么在AI赋能的基础上… (2) | 最近5轮；插件2.15.2、80提示词卡、本地知识与编译证据 |
| Codex 019fa8ba-4261-7c73-8be0-8ec1dcb01deb | E:\AI\custom_nodes\ComfyUI-WorkflowArchitect帮我检测一下为什么这个comf… | 返回的全部4轮；早期安装目录与前端路径故障，2.0能力演进 |
| Codex 019fb3cb-3d40-7062-8e1b-04692c62eda2 | ComfyUI 高级架构师与开发专家 (System Persona)[Role Definition 角色定义]你是… | 返回1轮；仅角色设定，没有可复用实现证据 |
| ChatGPT 6aed430b-9808-83ea-9ebb-68ed4ac477e8 | 商用画布需求调研 | 最近5轮；架构决策由统一节点转为双层，保留后续决定优先原则 |
| ChatGPT 6af0acf2-1910-83ea-b1ea-9fd520203f99 | 项目实施方案完善 | 返回全部1轮；直接读取用户列出的十二项约束；原文档包生成记录 |
| ChatGPT 6ad04707-7df4-83e9-90c7-ef41f07a6973 | 编写智能工作流程序 | 最近2轮；ComfyPilot计划、环境扫描/知识库/校验/真实试跑分层 |
| Codex 019f4d36-7355-7ca1-b2cc-a71b4f082462 | 当前正式工作区应为： | 最近2轮；ComfyCommerce错误记忆、预检与阶段边界 |
| Codex 019fe769-1b0c-7e90-8e2a-0f7e45cc6464 | 你现在是一位资深的 AI 全栈工程师，精通 Python、本地大模型部署、RAG（检索增强生成）架构以及数据库管理。请… | 返回全部2轮；对话导入、活跃分支、来源去重及索引设计 |
| Codex 01a01a27-6194-7ff2-8865-ccad9a78eaf8 | 分析一下目前虚拟助播的完成进度 | 最近2轮；本地规则与云模型分流、节流/队列和隔离运行时经验 |
| Codex 01a184dd-f6b5-7473-b6ae-ddefb5779e32 | 帮我给我的Comfy Desktop安装minimaxH3导演台插件，我已经下载压缩包并放在了D:\Google do… | 最近2轮；Ref2VA下载仍未完成的历史状态；不能当视频能力已验收 |
| ChatGPT 6ae93f01-aa44-83e8-bcc9-bc52dfa3402b | 创建电商风格库 | 返回全部2轮；15维风格档案、风格与产品事实分离 |
| ChatGPT 6adeb3cb-60e4-83e9-8888-218660442b38 | 总结电商SOP提示词 | 最近2轮；约束优先级、参考图职责、关联修改与版本交接 |
| ChatGPT 6ade3074-b388-83ea-82bc-f1425ad29975 | 外观锁定说明 | 最近2轮；具体视角锁定与未知面不猜测，适合转化为产品约束字段 |
| ChatGPT 6ae74126-5790-83ea-9b64-625803b3ab77 | 搜索Github项目 | 返回1轮；短剧技能的阶段化/锚点思路，仅后续研究线索，未复核上游源码 |

聊天返回可能截断长消息，附件列表与sandbox链接不等于已获取附件字节。本轮未取得198行原需求表或原实施文件ZIP；不能从历史摘要恢复其完整内容。未重新核实历史模型价格、版本推荐、第三方项目许可或当前可用性。

## 一 旧无限画布是最重要的底座候选

真实位置：`C:/Users/MECHREVO/Documents/Codex/2026-09-26/xian-z/work/ai-commerce-canvas`。

本轮git HEAD：`19499e7`，提交标题为`feat: add guarded locked image human confirmation UI`；`git status --short`无输出。已查看README、package.json、canvas-schema、document映射、接口文件清单及最近保护确认UI/交接文档。README包含早期阶段描述，不能只据其开头低估后续源码。

当前结构为React/TypeScript + React Flow前端、Node API与worker骨架、contracts、canvas-schema、testing；已有SQLite本机事务适配器、IndexedDB资产与本机开发桥接。它不是FastAPI/PostgreSQL/S3云端产品。

| 具体路径或模块 | 价值 | 分类 | 必须改造/补证 |
| --- | --- | --- | --- |
| apps/web/src/canvas/history.ts、document.ts、graphRules.ts | 手势撤销、文档往返、图校验 | B；部分纯函数A候选 | 普通画布展示关系与专业DAG拆开，不能保留普通连线执行语义 |
| packages/canvas-schema/src/index.ts及历史解析器 | v0/v1到v2迁移、未来版本拒绝、生成谱系解析 | B | 新Schema明确对象ID/节点ID、binding、固定工作流版本与云端修订 |
| apps/web/src/assets、constraints、components/MaskEditor.tsx | 资产库、不可变约束、蒙版交互与独立撤销 | B | ready资产/服务端hash为权威；输入修订与云资产映射 |
| apps/web/src/projects/projectPackage.ts | 项目打包、引用重映射、导入回滚 | B | 不沿用本地包即云备份的语义；补云授权、Schema和资源限制 |
| apps/api/src/runKernel.ts、sqliteRunKernel.ts、sqliteRunKernelStore.ts | 幂等、预算冻结、租约、核账与追加审计 | B，优先保留业务规则及负例 | 抽离存储端口迁PostgreSQL，接outbox和真实身份，不能将SQLite文件放网络盘当云数据库 |
| apps/api/src/productionImage*与lockedProductionImage* | 准备/确认/attempt/原包/产物/费用分层，未知状态保留预留 | B | 减少平行合同复杂度，统一为新run/attempt模型；逐条保留安全不变量 |
| apps/api/src/lockedImagePixelValidation.ts及相关测试 | 锁区与输出像素验证 | B | 适用尺寸、颜色、解码和蒙版合同固定后再集成；不等于生成质量保证 |
| apps/web/src/components/LockedProductionImage*与ProductionImage* | 准备、确认、恢复和结果查看UI | B | 与真实登录、模板、服务端审批联通；本地模拟reviewer不作多人鉴权 |
| objectStorage.ts、mockObjectStorage.ts与相关安全测试 | 可替换存储端口、签名授权负例 | B/C | 当前假实现不能当真实S3；跨项目内容去重不能向用户泄漏存在性 |
| packages/testing、tests/e2e与故障夹具 | 可复用的回归资产 | A/B候选 | 区分纯测试与本机开发桥接，按新契约改断言，历史数量不等于新应用通过 |

### 与现方案冲突

1. 旧普通画布以React Flow节点和workflow边组织，现方案要求普通对象与专业执行节点分离。保留交互和历史代码，设计明确的旧ID→object_id/node_id/binding映射，不能直接复用统一节点文档作为新协议。
2. 旧数据以IndexedDB、SQLite、本机存储/桥接为主，现方案默认云端。保留存储端口与故障用例，替换身份、持久化、存储和事件服务；旧离线壳不构成完整离线合并的首版承诺。
3. 旧浏览器资产支持的格式/尺寸和任务输出限制不同。新统一Schema在报价前验证，不能先收费后缩图。
4. 旧生产目录、密钥接入与执行默认关闭，历史聊天最后仍等待供应商/模型/费用等真实验收。保留这一边界，不把已有native执行代码当公网生产通过。

建议重新打开TECH_STACK的选型评估：以现有TypeScript业务内核为基线候选，Python负责Comfy编译适配，减少跨语言重写；是否保留React Flow作为普通视图或替换为Konva，先用相同数据集验证。此处是建议，不自动改变已确认的双层架构，也不直接冻结框架。

## 二 ComfyUI 工作流架构师可作为专业工具适配层

源码：`C:/Users/MECHREVO/Documents/ChatGPT/无限画布探索/ComfyUI-WorkflowArchitect`；pyproject与settings一致标2.15.2，目录LICENSE为MIT文本。此许可线索仅覆盖所查看项目的声明，不能扩展到所有内置资料、依赖、模型或节点。目录位于父仓库未跟踪区，缺独立commit基线，因此记录关键文件hash而不伪造版本提交。

| 文件/资源 | 价值 | 分类与迁移边界 |
| --- | --- | --- |
| workflow_architect/schemas.py | TaskSpec、输入/保真/输出约束及注册表结构 | B：映射为新工具输入输出Schema，不能拿TaskSpec代替运行快照 |
| registry.py、foundation.py | 读取真实object_info、能力和依赖缺口 | B：由运营方worker访问受控Comfy实例，节点登记不等于权重/许可/质量通过 |
| compiler.py、validator.py、templates.py | 受控模板确定性编译、UI/API格式区分、端口和输出校验 | B：优先抽成独立编译服务，补固定节点/环境版本和云资产绑定 |
| plan_compile.py、api_planner.py | 模型方案严格校验，人工绑定后编译，有限修订 | B：不接受任意模型节点JSON；编译授权与真实执行审批仍分开 |
| templates/prompt_library.json、prompt_library.py | 80提示词卡、变量、素材角色及检查项 | A/B候选：纯数据最先迁入工具目录；保留来源、版本、风险，未逐卡生图验收 |
| knowledge.py、research.py、offline_ai.py | 带来源知识、资料检索、本地模型入口 | B/C：适合项目知识库检索；资料不能冒充执行许可，CPU本地部署不是云产品前置 |
| protected_composite.py、local_recolor.py | 原图保留与蒙版外像素核验 | A/B候选：独立处理工具；本轮Pillow用例跳过，须在目标镜像再测 |
| detail_page.py、brand_poster.py、poster_service.py及web布局代码 | 六模块策划、事实ID引用、商品与背景分层、确定性文字布局 | B：固定流程可封装模板；既有V3最终视觉尚未签收 |
| web/js面板与本机批次恢复 | 交互和异常处理经验 | C/B：移植到新UI；浏览器指针不能当服务端队列或费用授权 |
| credentials.py | Windows DPAPI凭证保护经验 | C：云端改secret管理服务，不复制Windows绑定机制 |
| api_budget.py | 整数费用上界、来源验证及失效检查 | B：当前写死旧Hubway/gpt-5.5/0.02USD范围；应配置化，不继承旧授权或模型 |

本轮读取`restarted-2.15.2/acceptance.md`，有实际界面256×256编译与导出落地的历史证据，记录中明确未在日常画布执行导出文件。STATUS又区分真实GPU技术成功与商品视觉不合格，后者应继续保留为失败样本。

关键源码SHA256：

| 文件 | SHA256 |
| --- | --- |
| compiler.py | D207DB0B8308BDADD33C61954FAB04694668CD9E5FF98953C81ACF3FF29C1FED |
| validator.py | 504ED2CCFCCB890AF788ACCF8B336D23116C3BDF4E262B5876FAA992BB43A7EA |
| pyproject.toml | 3AFE15E9B847B34B950443C516F3977E94DD374D1A996EDFAB5AA172D37174DB |

## 三 其他相关成果

| 来源 | 本轮查看证据 | 可用部分与边界 |
| --- | --- | --- |
| E:/AI/ComfyCommerce | 目录与AGENTS、历史阶段记录 | C：manifest预检、错误追加记忆、只收录已验证成功案例、白底图和尺寸数量确定性处理。未运行其预检或审计脚本实现，不把历史规则作为当前环境事实 |
| personal-ai-data | `C:/Users/MECHREVO/Documents/Codex/2026-08-10/new-chat/outputs/personal-ai-data/app/importers/chatgpt.py`及contracts.py | B：ChatGPT导出活跃分支解析、规范会话数据与来源；本轮未复跑，许可和目标Schema待核。历史仅Stage1，不当作已运行向量RAG系统 |
| 虚拟助播 | 历史最近2轮、目录及AGENTS；core含conversation/cloud/events等 | C：简单需求走规则、复杂需求走模型、节流和队列上限。未查看核心实现或测直播OCR，不搬入画布MVP |
| E:/AI/Ecommerce_Workspace | 当前目录树 | C：从原图、抠图、背景、提示词、工作流到导出的资产分类；不是应用源码 |
| 风格库与电商SOP | 相关聊天实际消息 | A/B内容候选：风格15维、参考图职责、约束优先级、可见面与未知项、修改影响检查；要转成版本化Schema和审核模板，不承诺提示词保证外观 |
| MiniMaxH3导演台任务 | 最近历史消息 | HOLD：视频阶段参考，所读记录仍在下载，不确认现在模型已完成或8GB环境可用 |
| 外部短剧技能线索 | “搜索Github项目”历史消息 | C/HOLD：阶段化文档、角色锚点、过期追踪可借鉴；未复核上游，不采用历史Stars/许可/能力为当前事实 |

## 四 本轮复跑结果

日期2026-11-09。仅在候选仓库运行既有本地测试，没有新写镜像实现的测试，没有发起真实模型调用。

| 项目 | 命令和范围 | 结果 |
| --- | --- | --- |
| 旧画布第一组 | `node node_modules/vitest/vitest.mjs run tests/history-and-document.test.ts tests/graph-rules.test.ts tests/run-kernel.test.ts tests/object-storage-security.test.ts packages/canvas-schema/src/migration.test.ts` | exit 0；5文件25项通过；1.07秒 |
| 旧画布第二组 | `node node_modules/vitest/vitest.mjs run tests/run-kernel-leases.test.ts tests/run-kernel-billing-resolution.test.ts tests/run-kernel-billing-overage.test.ts tests/sqlite-run-kernel.test.ts tests/locked-image-pixels.test.ts` | exit 0；5文件103项通过；6.41秒 |
| 插件 | 在插件根将tests加入PYTHONPATH，`D:/python/python.exe -B -m unittest test_core test_plan_compile test_prompt_library test_protected_composite` | exit 0；73项，71通过，2跳过；2.17秒 |

插件跳过的2项是Pillow像素测试，当前D:/python未安装Pillow；本轮未为审计安装依赖。故不能把这次结果表述为像素保真复核通过。已有模板编译、提示词80卡填充和核心校验用例通过，仅证明这些限定断言。

历史“2861单元/288 Chrome/6构建”和“354 Python/115 JS模拟场景”只作为H级记录，本轮没有复跑全部、未做当前浏览器/部署/供应商验收。新AI-Commercial-Workspace本身仍只有文档，T01至T20不因此改为PASS。

## 五 推荐复用顺序

1. 建立只读候选清单和隔离迁移分支，保留旧画布commit、插件hash、许可证及测试范围；不覆盖现有工作区。
2. 用一个普通image对象、一张tool卡和一个固定模板，定义object_revision→binding→workflow_version→run_snapshot协议，完成旧ID映射；先验证双层边界。
3. 优先接插件的resize或确定性合成模板，形成无需新模型的有限纵向验证。真实执行另走服务端权限、预算和受控Comfyworker；编译通过不自动运行。
4. 迁移旧画布的history、资产/约束、用量内核及测试规则；建立真实登录、PostgreSQL、S3、outbox和事件恢复，逐一替换本机适配器。
5. 将80卡、SOP及风格档案作为有版本的资料资产加入普通用户表单，保留事实确认与视觉签收。
6. 双层协议及云持久化通过后，再加入AI提取、策划和单Agent有限循环。视频、人物换装和市场暂缓。

不建议同时运行旧Node任务内核与新Python任务真相，再让二者各自扣预算；应选一个权威状态服务，Python适配器只承担编译/推理步骤。是否最终采用Node或FastAPI在原型后决策。

## 尚未完成的审计

完整仓库许可证与依赖/模型SBOM；插件第三方资料逐项出处；旧代码覆盖率与全套回归；真实身份/云存储/数据库迁移；公网供应商及账单；工作流版本/绑定的实际迁移原型；当前设备性能与视觉签收。旧画布根目录未见LICENSE文件，本轮不据此判定无复用权，也不推定全部文件权属已确认。

下一步应把TASK-01从“尚未定位源码”更新为“已定位候选并初审，完整基线/许可/迁移验证待完成”；TASK-03先做复用原型与技术评估，不按候选栈直接开新实现。
