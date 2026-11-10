# API规格

2026-11-10任务只读追加：本地GET /v1/projects/{p}/runs支持limit/cursor；GET /runs/{r}/events支持after_sequence及JSON分页，Accept:text/event-stream启用SSE，原生重连时Last-Event-ID优先于初始URL游标。每帧复核会话与项目权限，注销/撤销成员会关闭流。GET /usage返回十进制字符串的limit/reserved/knownSettled及独立的执行unknown、费用unknown、未完整登记计数；不把未知成本归零。原预算来源为开发数据，尚无正式收费或云费用账本。当前新增查询/界面已专项和真实浏览器验证，全量48676待结束，日常服务尚未加载本节新增接口。

2026-11-10本地开发追加：POST /v1/projects/{p}/runs/{r}/cancel 已在隔离副本实现，JSON仅接受reason（最多500字符），按服务端会话与项目编辑权限判断，返回202及实际state/requested/reused。queued取消为cancelled并关闭outbox；running先cancel_requested，匹配中断证据且无产物、自有进程已停才确认cancelled；提交不明保留unknown，已有结果继续归档。GET run追加eventSequence、output和cancellation；前端拒绝迟到的较旧事件序号。日常服务仍为迁移006版本，新007/008须全量回归及备份升级后加载；不据此称云端取消已完成。

状态：建议的38操作契约草案，按源方案正文重建，未声称等同其未提供的原接口附件。所有端点尚未实现。前缀/v1，JSON UTF-8，时间ISO8601 UTC。

## 公共协议

成功返回`{data,request_id}`；错误返回`{error:{code,message,details,retryable},request_id}`。创建异步run返回202和run_id，仅表示入队。集合分页采用cursor、limit；事件按sequence游标。写请求携带Idempotency-Key，服务端将key绑定用户、项目、操作和请求hash；异参重用返回409。

同源HttpOnly Secure Cookie鉴权；状态写操作检查CSRF/Origin。资源查询先验证归属，跨租户404，角色不足403，修订/租约冲突409，输入或图校验422，限流或预算不足429。401需重新登录。签名上传下载是短期能力URL，不作为普通API身份凭据。

表内E表示owner/creator/designer，R表示有项目读取权，O表示owner。即使单用户模式也执行服务端权限判断。所有project路由先检查project_id归属。

## 操作清单

| # | 方法及路径 | 请求关键字段 | 响应data | 权限及副作用 |
| --- | --- | --- | --- | --- |
| 01 | GET /auth/login | return_to受允许列表限制 | OIDC重定向 | 公共；初始化登录 |
| 02 | GET /auth/callback | code,state | 会话重定向 | 校验state/nonce；建立session |
| 03 | POST /auth/logout | CSRF | logged_out | 登录；销毁session |
| 04 | GET /me | 无 | user,organizations | 登录；只读 |
| 05 | POST /projects | name | project | 登录；创建项目及画布 |
| 06 | GET /projects | cursor,limit | items,next_cursor | 登录；只列有权项目 |
| 07 | GET /projects/{p} | 无 | project,role | R；只读 |
| 08 | PATCH /projects/{p} | name,base_revision | project | E；更新元数据 |
| 09 | DELETE /projects/{p} | confirmation | deleted_at | O；软删，Agent另需高风险审批 |
| 10 | POST /projects/{p}/lease | canvas_id,takeover=false | lease_token,fencing_token,expires_at | E；获取/显式接管租约 |
| 11 | PATCH /projects/{p}/lease | lease_token,fencing_token | expires_at | E；续租 |
| 12 | DELETE /projects/{p}/lease | lease_token,fencing_token | released | E；释放本人有效租约 |
| 13 | GET /projects/{p}/canvas | revision可选 | canvas,objects,edges,bindings | R；读取一致快照 |
| 14 | PATCH /projects/{p}/canvas | base_revision,lease_token,fencing_token,operations | revision,applied_operation_ids | E；原子保存 |
| 15 | POST /projects/{p}/uploads | filename,byte_size,declared_mime | upload_id,put_url,expires_at | E；预留额度和上传记录 |
| 16 | POST /projects/{p}/uploads/{u}/complete | client_hash可选 | asset_version,state | E；服务端核验，不信任client_hash |
| 17 | GET /projects/{p}/assets/{a} | 无 | asset,versions | R；资产元数据 |
| 18 | POST /projects/{p}/asset-versions/{v}/download | disposition | url,expires_at,sha256 | R；签名下载并审计 |
| 19 | DELETE /projects/{p}/assets/{a} | reason | deleted_at,reference_summary | E；引用保护软删，高风险需审批 |
| 20 | POST /projects/{p}/workflows | name | workflow | E；逻辑工作流 |
| 21 | GET /projects/{p}/workflows/{w} | 无 | workflow,versions | R；只读 |
| 22 | POST /projects/{p}/workflows/{w}/versions | graph,dependencies,schema_version | version_id,content_hash | E；校验后INSERT |
| 23 | GET /projects/{p}/workflow-versions/{v} | 无 | immutable_version | R；只读 |
| 24 | POST /projects/{p}/templates | name | template | E；逻辑模板 |
| 25 | POST /projects/{p}/templates/{t}/versions | workflow_version_id,parameter_schema,form_schema,mapping,output_schema | version_id,content_hash | E；固定图版本 |
| 26 | GET /projects/{p}/template-versions/{v} | 无 | immutable_version | R；普通表单可读 |
| 27 | POST /projects/{p}/bindings | task_line_id,input_refs,version_refs,mapping | binding_id | E；不可变绑定 |
| 28 | GET /projects/{p}/bindings | object_id或workflow_version_id,task_line_id可选 | items,input_changed | R；双向查看同源 |
| 29 | POST /projects/{p}/runs | source,parameters,authorization_ref,budget_ref | run_id,state,snapshot_hash | E；冻结预算、快照、outbox，202 |
| 30 | GET /projects/{p}/runs/{r} | 无 | state,steps,outputs,usage,errors | R；只读 |
| 31 | GET /projects/{p}/runs/{r}/events | after_sequence或Last-Event-ID | SSE事件流 | R；持久游标续传 |
| 32 | POST /projects/{p}/runs/{r}/cancel | reason | state | E；尽力取消，202 |
| 33 | POST /projects/{p}/runs/{r}/replay | authorization_ref,budget_ref | new_run_id,replay_of | E；新run，重新授权和计费 |
| 34 | POST /projects/{p}/agent/sessions | level,scope,limits | session_id,policy_version | E；建立受限授权 |
| 35 | POST /projects/{p}/agent/sessions/{s}/messages | text,selected_refs | message_id,proposal_ids,state | E；读写按等级，202 |
| 36 | POST /projects/{p}/approvals | action_id,arguments_hash,decision | approval_id,expires_at | E；绑定当前修订和nonce |
| 37 | GET /projects/{p}/usage | from,to,currency | actual,reserved,unknown,limits | R；区分未知费用 |
| 38 | POST /projects/{p}/exports | schema_version,include_assets=false | export_id,run_id | E；异步清单导出，202 |

登录回调是重定向协议例外，SSE是流式例外，文件字节直接走签名URL。授权状态、导出结果通过run查询。Agent消息里的撤销授权意图不可由模型自行处理；实现需提供可信UI/服务端撤销入口，具体扩展接口在TASK-02冻结，不以本清单冒充完整OpenAPI。

## 关键请求约束

RunCreate.source是互斥联合：`{kind:"binding",binding_id}`、`{kind:"template",template_version_id,input_refs}`或`{kind:"workflow",workflow_version_id,input_refs}`。不接受latest作为历史输入；服务端解析并冻结固定版本。input_refs包含object_id、object_revision及asset_version_id（适用时），并校验ready、归属与端口类型。

CanvasSave.operations仅允许已注册的create/update/delete及展示edge操作；每操作有operation_id及目标对象修订。更新不得修改对象身份或将普通edge转换为执行边。系统回填与用户保存发生冲突时409并返回当前revision，不静默覆盖。

版本、参数schema、mapping、文件类型和大小均服务端验证。schema变更需版本化，所有JSON示意在实现阶段生成机器可读OpenAPI/JSON Schema并进行契约测试。Cookie、签名URL、Key不进入日志或导出。

## 本地已实施扩展：只恢复归档
`POST /v1/projects/{projectId}/runs/{runId}/recover-archive`，Cookie身份、同源及x-workspace-local:1，JSON请求体严格为{}；不接收actor、lease、artifact ID或provider URL。当前项目编辑者可发起，viewer403、不可见项目404。响应200为{state:'succeeded',reused,output}；已完成请求复用既有结果。409包含ARCHIVE_BUSY、NO_VERIFIED_ARTIFACT、ARTIFACT_NOT_FOUND、ARTIFACT_INTEGRITY_FAILED、ARCHIVE_LEASE_INVALID及ARCHIVE_NOT_RECOVERABLE；未配置能力503。内部错误不回显文件路径/凭据。

GET runtime的archiveRecoveryEnabled表示是否配置归档适配器；GET run的archiveRecoveryAvailable仅是当前编辑权限、unknown/archiving状态与持久产物记录的候选标记，真正执行时必须重新校验不可变DB证据、历史快照、缓存hash/完整解码及独立租约。恢复只写资产与新画布结果，不调用生成/编译，不建立第二次外部提交；没有可信产物的unknown不提供自动重试。该扩展属于本地TASK-23部分交付，不替代云供应商核查或原生多连接验收。

### 2026-11-10 本地画布操作扩展（全量待终态）
POST /v1/projects/{p}/canvas-operations接收严格{id,baseRevision,objects,lease:{token,fencing}}，id为固定操作UUID、objects为1..100个不同对象的新修订。服务器Cookie身份决定actor，当前编辑权限和租约不可省略。成功返回{revision,objects:[{id,revision}],reused}。相同actor/ID/确切语义body重试复用回执（不依赖旧租约仍有效）；异参409，不可借同ID重写。每对象追加修订及editor日志，批次任一失败整批回滚。原PATCH canvas保留兼容。

对象deleted为可选布尔字段：软删/恢复都追加新修订，不删除资产或固定历史版本。GET canvas仅列未删对象，GET runtime.canvasOperationsEnabled表示新保存能力就绪。20步撤销只保存本会话用户对象逆操作，不撤销后台运行或历史资产；页面未确认请求保留为显式重试，不能自动重发生成。

### 本地多选/组合/属性协议（2026-11-10）
普通对象新增可选locked:boolean与groupId:UUID|null。组合为平面成员关系，成员使用世界坐标及独立对象ID；不新增工作流边或改变执行语义。几何、删除或groupId改变在previous.locked=true时被服务端拒绝，必须先保存单独解锁修订，再编辑；文字及标题不受几何锁限制。旧PATCH和原子操作共用同一规则，OBJECT_LOCKED返回409。批次任一失败整体回滚。

属性、整组移动、复制/删除均追加新修订并纳入本会话20步撤销；复制新ID且仅重用获授权资产版本，组合ID重新映射，工具binding不复制。GET runtime.canvasSelectionEnabled表明高级画布协议可用；旧服务缺少能力标记时不发送新字段。可选JSON字段属于前向兼容扩展，严格旧schema不保证降级写入兼容。

### 本地未归位结果与放置（2026-11-10，迁移012）
GET /v1/projects/{p}/unplaced-results支持limit/cursor，返回与runs清单相同的分页形状，仅包含有ready输出但当前无活卡的任务；游标绑定筛选并保留PostgreSQL微秒。GET run.output增加unplaced:boolean，object_id/object_revision可空，canPlaceOutput表示当前编辑权限，不能替代POST时重新鉴权。

POST /v1/projects/{p}/runs/{r}/place-output请求严格为{id:UUID,baseRevision,x,y,lease:{token,fencing}}。不允许actor、资产ID、URL或运行参数。返回{revision,objectId,assetVersionId,object,alreadyPlaced,reused}；新放置一次性追加卡片、editor日志、placement记录、操作回执与output_placed事件。同ID/actor/确切参数复用回执，异参409；复用已提交回执不要求原租约仍有效，但当前用户仍须有编辑权限。全新写入须有效租约且无用户修订冲突；仅独立后台追加可重基。已有活卡则不重复放置。

初始输出与后续placement都是不可变历史；security_invoker视图在底层RLS范围内投影当前活卡。删卡不删资产、不改run/attempt，用户再次放置只重用已验证私有PNG，不编译、不生成、不收费。409包括RESULT_NOT_READY、LEASE_CONFLICT、REVISION_CONFLICT、IDEMPOTENCY_CONFLICT；无资产适配器503，viewer403，不可见项目/任务404。服务能力标记为unplacedResultsEnabled与resultPlacementEnabled。CLI/备份需要前向迁移，旧严格schema不保证新nullable输出的降级兼容。

### 本地UTF-8资料文件（2026-11-10，迁移013）
POST /v1/projects/{p}/documents接收二进制字节，X-File-Name为URL编码原文件名，Content-Type为允许文本类型/明确兼容别名；身份只取Cookie，仍要求同源和X-Workspace-Local:1。当前支持.txt/.md/.csv UTF-8，最大2MiB；返回机器DocumentAsset协议(id/projectId/sha256/ready/mime/name/byteSize/字符行数/BOM/encoding)，不接受客户端hash或actor。viewer403，不可见项目404，编码/类型/文件名422，超额413。共享项目文件额度64MiB。

GET /v1/projects/{p}/documents/{id}返回鉴权JSON预览，含原件sha、byteSize、UTF8字符行统计、text与truncated。预览截断保护代理对；不渲染HTML/Markdown或执行CSV公式。?download=1重新鉴权后返回完整原件attachment/nosniff，保留原始BOM、换行和字节。图片assets端点不接受document ID，反之亦然。资源记录与对象修订按kind复合FK隔离；ASSET_KIND_MISMATCH作为422拒绝。删除卡不删除历史文件或释放历史资产配额。documentFilesEnabled表示持久适配器可用。

### 普通画布展示关系（2026-11-10，迁移014）
GET canvas新增edges（当前未删除展示边；端点被软删时客户端隐藏，历史不改）。canvas-operations可选edges数组，objects允许空但二者合计1..100项；边严格为{id,projectId,revision,sourceObjectId,targetObjectId,kind:display,label?,deleted?}。对象/边同事务，边每项增加画布修订，返回可选edges修订回执；旧无edges请求不改变回执形状。端点同项目且当前存活，新建/恢复时验证；端点不可换绑。EDGE_ENDPOINT_NOT_FOUND、EDGE_REVISION_CONFLICT、EDGE_IDENTITY_CONFLICT为409。展示关系不能作为工作流edges、binding或run参数，严格schema拒绝执行字段。

### 普通任务卡（2026-11-10，迁移015）
WorkspaceObject新增type:task、runId，严格拒绝客户端任务状态或结果URL。runId必须当前可读同项目既有运行；DB生成引用复合FK作第二道约束，固定引用不可换绑。使用原canvas-operations与PATCH布局保存接口，复制/软删/撤销不创建或取消run。GET canvas返回卡片，仅含引用；实时状态/固定输入/输出继续读取GET run，日志读取原events/SSE，无新执行端点。taskCardsEnabled控制创建入口，旧服务不声明时不开放。失权/不存在按原403/404，引用换绑OBJECT_IDENTITY_CONFLICT为409。

### 模型能力与费用预检（2026-11-10，本地协议基础）
GET /v1/model-capabilities登录后返回服务器固定能力目录，只有已验证本地缩放配置可ready/queue_only；提取/分析/策划未配置，费用unknown且不含amount。无HTTP供应商注册/Key/任意URL接口。POST /v1/projects/{p}/model-preflight严格为{capabilityId,capabilityVersion,operation,parameters}，当前编辑权限与同源保护；校验维度/像素上限，固定版本或能力不匹配拒绝。它不创建任务/预算冻结，返回submitted=false/executionAuthorized=false；不能把预检当执行授权。未配置文本能力仅空参数返回needs_configuration，包含资料/指令等参数则拒绝。

本地resize运行仍只从既有固定binding入口创建，新增快照v2冻结modelCapability及其hash；旧v1快照不改写且原幂等key继续复用。worker和usage验证v2能力白名单/指纹；真实文本/云图片供应商未启用，不把已知本地零供应商费用推广到未知模型。

### 本地资料候选/人工确认（2026-11-10，迁移016）
GET /v1/projects/{p}/document-facts/{assetId}[?revision=N]返回{currentRevision,canEdit,document}；无候选时document=null，历史缺失404，失权404。document固定provenance=deterministic-local-key-value-v1、sourceSha256、decoded-utf8-no-bom-utf16坐标/行号/quote、原始候选及人工状态，不代表AI推理。POST同路径严格为{id,action:extract,lease}或{id,action:save,baseRevision,facts,lease}。facts项仅{id,name,value,unit,userConfirmed,excluded}；来源/作者/置信度不能由客户端改写。新命令需编辑权限和有效租约；旧ID回执重试复用，不依赖旧租约仍有效，当前权限仍检查。事实单独baseRevision，不改变canvas revision。

最多50条，保存body单独256KiB；其他JSON仍64KiB。FACT_REVISION_CONFLICT、FACT_IDENTITY_CONFLICT、FACT_UNKNOWN_UNCONFIRMABLE、FACT_CONFLICT_UNRESOLVED、FACT_INTEGRITY_FAILED与幂等/租约冲突为409，viewer写403，严格字段422。首次整理明确不外发、不调用模型或生成任务；重复整理已有版本不覆盖人工确认。documentFactsEnabled控制UI入口；历史只读，人工编辑/确认追加新修订，原件与旧候选保持不变。

### 人工视觉策划与确认事实目录（2026-11-10，迁移017）
GET /v1/projects/{p}/confirmed-facts支持limit(默认5份资料，最多20)/cursor，返回各当前事实版本中已确认、未排除/非未知的事实及固定原文；即使本页无已确认条目，游标仍按资料head前进。GET /visual-plans支持limit(默认20，最多50)/cursor；游标同时绑定项目与目录类型。GET /visual-plans/{id}[?revision=N]返回{canEdit,currentRevision,document,sourceChanges}；历史内容固定，sourceChanges仅反映现今来源版本变化。

POST /visual-plans/{id}严格为{id:operationUUID,baseRevision:0或当前版本,draft,lease:{token,fencing}}。draft包含title/goal/audience/style/assumptions/shots/factRefs；shot包括id/title/description/copy/angleConstraints/assetVersionIds/output(width,height,format)，factRef为assetVersionId/revision/factId。服务端从当前已确认事实和ready图像登记中填充证据/hash，禁止客户端作者、任意URL、证据或执行参数。body单独256KiB；旧全局64KiB不放宽。保存不创建run、预算冻结或画布修订；同ID严格回执复用。

PLAN_REVISION_CONFLICT、PLAN_FACT_REFERENCE_STALE、PLAN_FACT_UNCONFIRMED、PLAN_FACT_CONFLICT、PLAN_INTEGRITY_FAILED为409；viewer写403，不可见引用404，未知字段422。text可选planSource:{planId,revision}，同项目不可变版本FK校验；它是文字副本来源，不意味着卡片编辑同步原计划。普通保存/复制/撤销仍不触发执行。visualPlansEnabled控制界面；此为manual-authoring-v1，模型网关自动plan.draft继续未配置。


### 2026-11-10 本地Agent授权审查基础
TASK-19 LOCAL_PARTIAL：迁移018，鉴权GET /v1/agent-review-tools；项目内GET/POST /agent-review-grants、POST /agent-review-grants/{id}/proposals、POST /agent-review-grants/{id}/revoke、GET /agent-review-proposals/{id}、POST /agent-review-proposals/{id}/approve。严格review_only，当前角色/来源/期限/hash/nonce/撤销约束，全部无执行权；无execute路由。28项专项、六包构建、实际CPU与磁盘重开通过，全量及日常部署待终态。审批消费与run/snapshot/outbox原子事务、自主循环未完成，旧审查记录不能自动升级执行授权。详见实施状态与证据。


### 2026-11-10 本地可执行Agent单action（LOCAL_PARTIAL）
FR-10/TASK-19/20：新mode local_resize_execute / policy local-agent-execute-v1；旧review_only不升级。GET /v1/agent-execution-tools；项目内GET/POST /agent-execution-grants、POST /agent-execution-grants/{id}/proposals、POST /agent-execution-grants/{id}/revoke、GET /agent-execution-proposals/{id}、POST /agent-execution-proposals/{id}/approve、POST /agent-executions。L1严格hash/nonce，L0拒绝，L2/L3只允许明确固定本地零供应商费用缩放。019消费记录与schema3快照/run/outbox同事务，worker启动前/领取/提交前重复核验当前权限、输入、期限和撤销；提交后尽力取消，已验证结果可独立归档。65项专项、六包构建、磁盘重开/真实CPU/撤销后其他编辑者恢复及原手工浏览器回归通过，全量和日常部署待终态。界面、有限自主循环、真实模型/云图及完整T15未完成。详情见implementation/docs/AGENT_EXECUTION_INTEGRATION.md。


### 2026-11-10 本地Agent操作界面
FR-10/TASK-19/20仍LOCAL_PARTIAL。新增GET /agent-execution-grants/{id}/proposals读取原主体/项目下最多8提案及消费任务回执；新能力标记agentExecutionPanelEnabled启用面板。明确新授权→提案→独立审批→明确执行，固定intent写前持久/无自动重发/丢回复重开同ID确认，viewer可撤回旧授权，ready结果保留。25专项、六包构建、12条本地浏览器、viewer补测、真实256×256 CPU界面和原手工CPU回归通过，全量/服务刷新待终态。无新迁移或依赖；完整自主循环/真实模型未完成。详见implementation/docs/IMPLEMENTATION_STATUS.md。
