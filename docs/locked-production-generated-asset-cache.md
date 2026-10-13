# 原保护缓存B9B：独立浏览器原图与只读保护观察

2026-10-14 02:52（上海）。冻结原保护回读/缓存/回流有限A服务端读取/B浏览器缓存/C受控画布保护观察与人工UI出口，本次只完成B。首完整pnpm check：2653项单元/集成（66文件）、225项Chrome、6构建全部通过，新增52项/25Chrome；新52与旧44共96项、相关4文件253项及Web构建通过，首定向25Chrome全部通过。完整check/Chrome期间全部源码冻结，11个改动源/回归文件实际SHA前后相同。A/B1–B8/B9A、旧none/local闭环保持，不重复或改标升级。保护画布回流与人工准备/确认UI、真实供应商/公网/保险库/真实价格账单/生产会话、阶段4与完整项目仍未完成，日常真实执行关闭。

## 显式可信配置与独立只读客户端

可信App只由严格LockedProductionGeneratedReadScope的lockedGeneratedReadUiEnabled=true、精确tenant/mode显式配置才挂载独立LockedProductionGeneratedAssetPanel；日常main无配置，无query/window/env/localStorage启用开关。原[B9A服务](locked-production-generated-asset-readback.md)两GET仍须明确同库注入，默认API/日常bridge404。与同时存在的其他生产只读配置核对tenant/mode，不挂载旧RunBatchAggregate/LocalRunPanel模拟列表或操作，不读取执行key/worker/lease。本面板只有谱系/原图缓存/重新核验按钮，没有保护准备/确认、执行、费用或回画布按钮；普通生成资产添加到画布仍拒绝。

LockedProductionGeneratedAssetClient固定localStudioFetch同源GET原locked-production-generated-assets/:asset/lineage与content，local标记/no-store/same-origin凭据/禁止重定向/no-referrer。严格完整v2谱系、tenant/project/asset/mode、完整原约束SHA、mask→source绑定、原版本/产物及policy/pixelProof不透明SHA核验；精确原图MIME/长度/实际SHA、版本locked-production-generated-image-v2/模式/产物/政策/像素证据响应头匹配。JSON512KiB、原图20MiB、4096非空分片/精确声明与实际长度、严格UTF8及绝对30秒取消保持，不压缩/截断/静默换协议或调用旧任务恢复/attempt/raw/生成/产物/费用接口。

谱系和缓存生命周期使用既有production-lineage/production-cache两槽池，与旧none读取共用而非再加全局容量；本地验证也复用production-local-validation两槽。非合作fetch/read/native未结清仍占对应槽，迟到不提交或更新UI、迟到bitmap关闭；不是强制native终止或跨进程全局硬闸门。关闭/切项目/StrictMode清理旧客户端和AbortSignal，最终UI回调核当前客户端/取消。可注入自有port/repository调用、schema/hash/clientverified或响应头不构成实际服务器许可。

## 独立不可变缓存身份与原子迁移

IndexedDB v4→v5只追加lockedProductionGeneratedCaches，保留assets/blobs/generatedCaches/productionGeneratedCaches与旧原图和代理。独立version=2/namespace=locked-production-generated-image-v2完整历史谱系/保护标记只排除当前billing/jobStatus于冻结身份，政策/像素证据、原输入/完整原约束、人工确认、原请求/转换及全部其他关系仍绑定。合理独立核账不变新图/新发送；旧历史谱系和费用观察不覆写，当前完整任务和费用仍由服务器核验。标记白名单/512KiB，代理另外冻结SHA/长度/精确WebP类型/派生尺寸。

assetRepository在首次await前复制完整v2输入，核实际原图SHA/MIME/长度/native完整尺寸，并生成独立本地WebP代理。原输出未缩放/重编码/合成；代理不替代原文件、源图或蒙版。native完成后再次新读服务器完整谱系/当前读取权限并核冻结身份一致，才在同一IDB事务保存元数据/原图/代理/独立保护标记；写后故障/取消整体回滚。已有同编号必须完整元数据/标记和代理描述一致，旧local/none标记、ordinary restore/复制新id、孤立blobs或同全局id跨项目冲突不能升级或覆盖。重复显式缓存保留原标记/历史；手动重新获权缓存只能补回匹配原描述的字节，不是自动重发或新许可。

重新核验先新读当前服务器谱系，中间同一IDB只读快照核完整元数据/保护标记/original/proxy及旧标记隔离、实际两份SHA/native完整尺寸，最后再次新读服务器全链并核冻结身份。本步尚不把原source-mask original纳入画布输入联合快照或写画布历史；那是有限C下一步，不能把缓存验收冒充回流验收。只保留合法离线副本，不因失败/撤权删除良好文件，不宣称事后撤权销毁已授权本机副本；服务器/IDB不是全局ACID或正式多租户离线ACL。

## 只读保护与金额观察边界

展示原B7已保存政策/像素证据及不透明指纹：fixedautoOrient/sRGB/RGBA8、白色alpha255编辑、alpha0..254锁定、两区非零、checked-not-applied/fixed-rgba8-only。浏览器native尺寸验证不重新进行服务器锁区像素比较，不代表原编码字节/ICC/高位深/任意解码器一致或品牌语义保证，没有容差放行JPEG或合成重编码。完整服务器[B9A](locked-production-generated-asset-readback.md)当前v2准备确认/政策/任务租约意图attempt/returned整包、保护产物BLOB收据双表目录/完整指纹/独立费用审计账本预算与原source-mask约束联合核验保持，不借execute/provider/create/confirm/billing/assetwrite读取许可。

known原估价与manual unknown/null、原max、当前结算上限/预留/实费分别显示；zero-cap与未测实费不补0，不用上限冒充估价或升级旧数值GeneratedImageRecord。实际不同人65费用超额结算后缓存冻结身份和原unknown费用观察不改，当前结算上限/费用由服务器读出。缓存/谱系/像素观察不授权生成、核账结算/释放unknown、任务租约恢复/报价read或verify/询价或发送。

SQLite v8/ICRD1不变，IDB增量v5，不改用户商品锁/假单价/幂等/配置指纹或旧记录原义。服务器原30MiB单输入/64MiB合计读前、32MiB原包/512MiB项目、16MiB共享/512KiB单份元数据、20MiB输出/8192/1600万像素/auto4096拒绝、原两槽及默认5秒最多30秒/native时限保持。无SQL锁内await、删历史腾空间或新增日常执行路由；非生产沙箱、全局硬闸门、可靠JS/native擦除或外部反回滚签名。

## 验收与非致命提示

52项新单元涵盖严格独立配置、实际v2 SQLite+HTTP两协议known/manual、完整谱系/保护/约束/绑定与私有字段错配、版本/模式/三个指纹/长度/MIME/SHA/压缩/no-store、UTF8/分片/容量、最终撤权、合理核账冻结身份、旧none隔离、当前缓存先后新读与非合作fetch共享两槽/绝对30秒。另实际B8不同人超额65结算及manual zero-cap无实费0断言；初50通过，补2后新52+旧44=96通过，相关4文件253通过。

25项新增Chrome以实际owned HTTP/临时SQLite/4173/IDB验证OpenAI/compatible×known/manual缓存重复刷新、首await复制、旧none/local拒绝、错误原字节/最后撤权、实际IDB写后故障取消原子回滚、10种元数据/原图/代理/标记/政策/像素证明损坏、普通restore/复制新id/跨项目冲突、真实独立假来源超额结算后标记不变、关闭/切项目迟到回调、v4→v5旧记录原字节保留和390px无横溢。定向首25全部通过，截图人工核对可读；完整首2653/225/6全部通过，原断言/默认hook/test/生产时限/最多4Vitest worker/依赖不变，没有套件失败、吞错或靠重试掩盖。本次旧v3→v4迁移用例只把当前最终版本期待4改5，全部原数据/原字节/旧标记断言保留；先检查真实B8 record.status/reviewId字段修正自有helper，不冒充失败回归。文件定位未命中不算测试执行。

原Zod/Rollup/NO_COLOR非致命警告保持。新Web主chunk500.94kB超过默认500kB提示，构建成功，未调阈值/依赖掩盖；不是已验证性能优化。正向只独立contract-fixture/自有PNG source-mask/假价格费用/临时SQLite/回环HTTP/4173/IDB，不种日常真实目录价格、不读用户秘密/供应商DNS网络付费/推送部署或重启5173，不冒充真实账单/公网/保险库/生产会话。

## 有限下一步

提交前git diff --cached --check指出两个新测试文件EOF多余空行，验收完成且解除冻结后只删除这两行，未改变测试逻辑/断言/运行源码；完整运行前后11文件SHA相同的冻结证据仍指本轮实际验收时点，不把格式清理说成新测试或另一次完整验收。

原B9C受控画布保护观察：每次当前服务器完整v2谱系→同一IDB只读快照核原图/独立保护标记/代理和原source-mask original的实际SHA/native尺寸/元信息/顺序/mask→source绑定/完整原约束→再次服务器→末端当前客户端/项目/输入/完整约束范围无await一次提交。独立有界保护历史只必要政策/证据关系，媒体仅assetId，原费用观察与当前费用分开；重复冲突核验、输出删除补回、一次撤销、完整/轻量迁移、刷新撤销重做、输入引用保护、包副本重映射/imported-copy-history保持且不造缓存许可。再保护人工准备/确认UI有限出口，不新增最终目标或无限草稿，不放宽Google绑定mask能力/极性，不跳过阶段4进入MCP6/视频7；全部冻结阶段真正完成才报告项目完成，真实供应商/模型/金额/根/凭证/最低成本请求仍需具体另授权。

02:52实际Codex10080分钟周已用37%/剩余63%，未命中原剩余<=20%（已用>=80%）停止线，原automation ACTIVE；每次开始/里程碑结束/约10分钟实际读取，命中或周不可读立即安全保存报告暂停，不因下周重置自行恢复、须人类明确再授权，不重置/购买/换模型绕过，账号共享取整/周期检查不承诺零误差。
