# 技术栈与验证门槛

状态：技术选型建议，未安装、锁版本或跑兼容测试。源方案中的版本观察不作为本项目依赖锁。

2026-11-09复用初审补充：已定位React/TypeScript + React Flow + Node/SQLite旧画布，以及Python插件2.15.2，限定测试可复跑。下表仍为原候选，不代表已经决定重写。优先比较“保留TypeScript任务内核并由Python适配Comfy”和新建FastAPI方案；普通视图保留React Flow或迁Konva均需双层协议与同数据集原型证据。详见[复用审计](../05_PROJECT_MANAGEMENT/REUSE_AUDIT.md)。

| 层 | 首选候选 | 采用前证据 |
| --- | --- | --- |
| 前端 | React、TypeScript | 旧项目审计；React与绑定库peer兼容 |
| 普通画布 | Konva及react-konva | 缩略图、选区、DOM文字输入、500对象基准 |
| 专业视图 | React Flow的React包 | 节点端口、布局和50节点100边基准 |
| API | FastAPI、Pydantic | 既有代码复用判断、异步IO与契约原型 |
| 数据 | PostgreSQL、版本化迁移工具 | 复合外键、RLS、事务并发及恢复 |
| 文件 | 托管S3兼容私有对象存储 | 地区、签名策略、CORS、hash、恢复验证 |
| 队列 | Celery、RabbitMQ | runtime与broker兼容、至少一次投递及worker故障 |
| 推理 | 一个云模型适配器、受控ComfyUI | 账号/地域可用性、权重许可、真实产物与用量 |
| 通知 | SSE并回退轮询 | 持久游标、鉴权、断线重放 |
| 部署 | Docker Compose候选 | 精确镜像digest、健康检查、备份恢复 |

共享契约以JSON Schema为核心，生成TypeScript类型并由Pydantic校验，避免两套独立字段定义。版本锁包括runtime、lockfile、容器digest、模型hash、节点包和编译器版本。

## 备选取舍

tldraw、Excalidraw仅为普通画布候选，需评估授权及商业媒体编辑差距；BullMQ只在旧Node实现明显可复用时考虑，不同时维持两套主队列。LangGraph、Temporal、SeaweedFS为后续复杂度出现后的候选；Dify不直接作多租户底座。许可描述按[核验清单](LICENSE_AUDIT.md)执行，未复核前不视作采购或合规结论。

## TASK-03原型

固定数据集验证：画布对象编辑保存→模板参数绑定→run入队→真实输出→私有桶→画布回填。记录安装锁、命令、exit code、提交、request ID与费用。原型证明接口组合可行，不替代完整权限、恢复和用户验收。若旧实现满足架构与许可，优先保留，不按本文候选栈强制重写。

## 成本与容量

费用按实例/DB/MQ、平均存储、请求、外发、模型tokens、图片计费数、GPU占用小时、备份和人工分项估算。API图片与独立Comfy任务分别计费，同一产出采用替代路径时扣除被替代项。源方案报价是历史情景，本次不转写为当前报价或已批准预算。单图时长、失败率与峰值并发实测后才能估GPU数量。
