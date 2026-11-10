# 工作流与执行规格

状态：源方案核心约束及本次补充契约草案。

## 图和模板

首期白名单：input.asset、input.text、llm.extract、llm.plan、image.generate、comfy.execute、output.asset。节点包含node_id、type、type_version、config、ports及独立编辑布局；edge明确源节点端口和目标端口。校验端口类型、必填输入、重复ID、环、未知节点、资源归属和节点版本。图必须为DAG；条件、循环和用户脚本后续支持。

workflow_version包含固定graph、schema_version、content_hash、依赖manifest、创建者与时间。发布新版本只INSERT，回滚修改默认指向或从旧版派生。template_version固定workflow_version_id、参数JSON Schema、UI表单、参数映射与输出schema。既有任务卡不自动升级。

ComfyUI仅验证一个API工作流及白名单映射；UI原件作为附件保留。未知节点返回清单，不自动安装代码，不宣称任意自定义节点无损往返。

## 绑定与快照

binding固定project_id、task_line_id、源对象id和revision、asset_version_id、workflow_version_id、template_version_id、节点端口映射与输出位置。双向查询同一表，避免维护两份引用数组。

RunSnapshot固定图hash、模板、参数、输入对象修订、资产hash、提示词、seed、模型标识及版本或unknown、节点/编译器/环境版本、输出规格、授权与预算引用。密钥和短效签名URL不进入快照。重放创建新run并记录replay_of，重新检查权限和费用；只保证配置可追踪，不保证第三方模型位级复现。

## 运行状态机

建议主路径为queued→running→archiving→succeeded；允许failed、unknown、needs_input、cancel_requested、cancelled。queued可取消；running取消先进入cancel_requested，确认外部停止后才cancelled，若已产出则继续归档并展示实际费用。unknown经核查可回running、进入archiving或failed；无接单证据时不能自动创建新收费attempt。succeeded要求所有必要输出ready且登记完成，供应商成功不能直接等同任务成功。

## 事务与幂等

创建run、快照、预算冻结和outbox使用同一事务。幂等键绑定操作者、项目、操作和请求hash；同键不同请求409。dispatcher确认投递后记录状态，重复投递由worker去重。每次外部提交前先落attempt与client_request_id，再记录provider_request_id。重试前区分未发送、明确拒绝、已接单和不明，禁止对超时一律重发。

建议产物唯一约束(run_id,output_key)，费用按供应商request ID或稳定用量事件去重。供应商成功而桶失败时保存外部结果定位信息并重试归档；定位信息受控保留，不作为永久资产URL。事件使用单调游标供SSE续传。

## 模型网关

请求包含run_id、step_id、capability、固定输入、model、output_spec、timeout、idempotency_key、budget_ref。响应包含submission_certainty、provider_request_id、status、outputs、usage及price_version。能力为extract、analyze、plan、generate_image；用量未知明确记unknown，不记零。调用只允许注册能力和授权外发范围，凭据仅由worker运行时取得。
