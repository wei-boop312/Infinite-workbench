# 许可证核验清单

状态：未完成审计。以下名称及许可线索来自源方案，不是本次联网核验结论或法律意见；未复制任何依赖、代码或权重。实施时对实际tag/commit、完整许可证和使用方式重新核查，不能凭项目名批准商用。

实施更新：后续已在隔离副本按原锁安装依赖并复制插件核心及其MIT文本，未复制权重。119个已安装依赖的package元数据与许可文件hash已清点，见implementation/docs/evidence/2026-11-09/baseline-inventory.json（相对项目根）。4个平台包缺独立许可文件的检出线索、根项目权属和第三方资料范围仍未闭合，不视为商用批准。上句“未复制”仅描述初次文档整理时点。

| 候选 | 源方案许可线索 | 必须核验 |
| --- | --- | --- |
| Konva、React Flow、FastAPI | MIT | 实际版本LICENSE、版权及NOTICE保留、传递依赖 |
| React、TypeScript及绑定库 | 未在正文完整审计 | 各包精确版本、许可与依赖树 |
| ComfyUI核心 | GPL-3.0线索 | 精确许可证、修改/分发方式及对应义务；独立服务不自动豁免所有义务 |
| 模型权重及自定义节点 | 不随核心授权 | 权重来源、商用限制、输出条款、节点代码依赖与签名审核 |
| Celery | BSD-3-Clause线索 | 代码及附属文档不同版权项 |
| RabbitMQ | MPL-2.0线索 | 修改文件、分发方式、插件及Erlang相关许可 |
| PostgreSQL及S3服务 | 正文未完整列明 | DB版本许可、云服务合同与地区条款 |
| tldraw | 生产授权密钥要求线索 | 实际生产授权范围、价格、条款和品牌义务 |
| Excalidraw、LangGraph、Temporal、BullMQ核心 | MIT线索 | 指定版本；商业/Pro扩展另核 |
| SeaweedFS | Apache-2.0线索 | LICENSE、NOTICE和传递依赖 |
| Dify | 额外多租户及标识条件线索 | 完整许可及SaaS场景授权；未核验前不采用为底座 |
| 云模型API、字体、图标及素材 | 独立条款 | 数据外发、训练使用、保留、地域、商用及转授权 |

## 审计记录格式

每项记录component、version/commit、source_url、retrieved_at、license_expression、license_file_hash、modifications、distribution_mode、obligations、dependency_manifest、reviewer、status、evidence_path。状态为NOT_REVIEWED、REVIEWING、APPROVED_FOR_SCOPE或BLOCKED；当前全部NOT_REVIEWED。APPROVED必须说明批准的使用范围，不能推广为所有未来场景。

## 门槛

TASK-01清点旧仓库与依赖；TASK-03冻结候选；构建时生成SBOM、NOTICE及模型manifest。私用MVP前取得所用模型和素材的实际授权依据；公开分发、对外收费或市场交易前重新按实际运营范围审核。许可证缺失或不明确时暂停采用该组件，保留其他独立任务。

源方案列出的上游核验入口可由组件名称定位，但本次未访问网页，不引用其历史描述为最新事实。审计状态与技术可运行状态分别维护，任何一项通过都不能替代另一项。
