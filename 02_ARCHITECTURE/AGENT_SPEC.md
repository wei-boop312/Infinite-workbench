# Agent规格

状态：单Agent有限工具循环；默认L1及数值限制是建议。

## 数据与工具

输入先分类为对话、提取、分析、策划或已注册工具请求。只读取用户选择对象和确认事实。事实结构为name、value、unit、source_asset_version_id、locator、confidence、user_confirmed；另列unknowns与conflicts。策划包含goal、audience、style、shots与assumptions，每镜头保留文案、资产引用、角度约束和输出规格。原资料不因提取而变为已确认事实。

允许工具：read_project、extract_asset、write_plan、append_canvas_object、update_canvas_object、invoke_template、get_run、request_approval。每工具声明JSON Schema、版本、资源范围、风险、外发、最大费用及幂等要求。模型只提出proposal，后端权限内核决定是否转为执行命令；无直接DB写、Shell、任意URL或供应商Key访问。

## 自主等级

| 等级 | 允许范围 | 有副作用操作 |
| --- | --- | --- |
| L0 | 授权读取与建议 | Agent不执行；用户可手工运行 |
| L1 | 授权范围内对话读取 | 每个action确认 |
| L2 | 选定项目范围 | 可逆低风险自动；计费生成默认确认，除非明确额度授权 |
| L3 | 指定项目、资料、工具、期限与额度 | 范围内自主执行 |

删除、覆盖、发布、支付等高风险操作始终独立审批。等级提高、预算增加和工具扩权不能由模型批准。无明确授权范围则拒绝。用户撤销授权后不再启动新工具，已提交外部任务尽力取消并核查费用。

## 审批防变更

审批绑定action_id、canonical_arguments_sha256、tool_version、project_id、input_revisions、max_cost、currency、policy_version、expires_at、nonce。建议用规范JSON生成hash。用户批准后执行前再次校验权限、修订、hash和有效期，并原子消费nonce。参数或输入变更则新建proposal和审批，不能复用旧批准。

## 循环与审计

建议每session最多8次工具调用、2次纠错、10分钟，触限或预算不足进入needs_input。记录行动依据摘要、输入引用、工具参数、模型版本、用量和结果，不要求保存私有思维链。资料内的指令视作数据，不能改变系统权限。产品外形、配件、未知角度为显式限制，仍需人工视觉验收。

## 验证

T15覆盖L0至L3、提示注入、越权读取、审批过期、参数变更、nonce重用、撤销授权、预算并发及无限循环。任何真实付费工具调用前先通过权限内核与预算事务测试。

### 模型调用与本地资料整理边界（后续约束，未交付事实界面）
模型能力目录中的提取/分析/策划未配置时不能用占位模型或确定性文本拼接宣称真实AI。可先实施UTF-8资料的规则候选整理与人工确认，保存原asset版本/SHA、原文位置和逐条来源引用；规则候选默认未确认，人工修改或确认追加不可变修订，原件不改写。该路径与未来模型提取应有不同provenance，分析仅读取明确确认事实；未知/冲突继续显式保留。完整模型提取和策划仍须实际供应商/许可、授权外发与费用门槛验证。


### 2026-11-10 本地可执行Agent单action（LOCAL_PARTIAL）
FR-10/TASK-19/20：新mode local_resize_execute / policy local-agent-execute-v1；旧review_only不升级。GET /v1/agent-execution-tools；项目内GET/POST /agent-execution-grants、POST /agent-execution-grants/{id}/proposals、POST /agent-execution-grants/{id}/revoke、GET /agent-execution-proposals/{id}、POST /agent-execution-proposals/{id}/approve、POST /agent-executions。L1严格hash/nonce，L0拒绝，L2/L3只允许明确固定本地零供应商费用缩放。019消费记录与schema3快照/run/outbox同事务，worker启动前/领取/提交前重复核验当前权限、输入、期限和撤销；提交后尽力取消，已验证结果可独立归档。65项专项、六包构建、磁盘重开/真实CPU/撤销后其他编辑者恢复及原手工浏览器回归通过，全量和日常部署待终态。界面、有限自主循环、真实模型/云图及完整T15未完成。详情见implementation/docs/AGENT_EXECUTION_INTEGRATION.md。


### 2026-11-10 本地Agent操作界面
FR-10/TASK-19/20仍LOCAL_PARTIAL。新增GET /agent-execution-grants/{id}/proposals读取原主体/项目下最多8提案及消费任务回执；新能力标记agentExecutionPanelEnabled启用面板。明确新授权→提案→独立审批→明确执行，固定intent写前持久/无自动重发/丢回复重开同ID确认，viewer可撤回旧授权，ready结果保留。25专项、六包构建、12条本地浏览器、viewer补测、真实256×256 CPU界面和原手工CPU回归通过，全量/服务刷新待终态。无新迁移或依赖；完整自主循环/真实模型未完成。详见implementation/docs/IMPLEMENTATION_STATUS.md。
