# 阶段 4 里程碑 1：供应商图片合同

日期：2026-10-03。只实现**严格合同及无网络的服务端校验**，没有启用供应商执行器、凭证读取或真实生成。阶段 0 的 `ProviderConnectionSchema` 保留原有兼容性，不能用于证明真实图片能力。

## 已实现的边界

- `packages/contracts/src/imageProviders.ts`：按租户/项目保存连接、显式协议/适配器/模型、连接修订和模型能力版本。每个 RunJob 固定一个输出；参数不接受未声明字段、客户端密钥或供应商隐式模型。
- 能力按模型声明：生成/编辑、输入 MIME/数量/字节/像素/单边上限、提示词长度、输出格式/背景/保真/压缩、尺寸预设及自定义边界。支持某协议不意味着支持该协议所有模型或参数。
- 蒙版能力只有“不支持”或“模型引导”；极性未核对时拒绝带蒙版请求。此处没有转换/转发蒙版；`pixel-exact` 一律拒绝，待真实资产回流阶段实现可验证的锁区保护后再开放。
- 连接配置、连通诊断、模型能力声明、本地假响应证据和真实请求验收分开表示。非声明证据必须有引用与时间；这些记录由可信服务端管理，本里程碑没有开放客户端写入或伪造验收状态的入口。
- 报价明确来源/版本/币种、整数估算与上限、有效期；缺少用量不记零。响应的产物状态与扣费状态分开：损坏图片可以已收费，返回字节仍只是待验证产物，不是已完成画布资产。

## 服务端调用顺序

`apps/api/src/imageProviderContract.ts` 的校验器不发起网络、不读取环境变量和凭证：

1. `validateImageProviderRequest` 校验配置和请求，拒绝跨租户/项目、旧修订、过期报价、不支持的能力或尺寸。
2. `validateImageProviderInputs` 接收**从权威资产服务读取**的收据，校验底图实际摘要/尺寸/字节及蒙版来源。客户端传来的结构化收据不是证明，不得直接传入此函数。
3. 整个连接及请求做排序规范化 SHA-256 摘要；`requireImageConfirmation` 与**服务端已保存的人工确认摘要**比对。地址、凭证引用、模型、能力、报价、币种、原图、约束或参数有任何变化，都不能沿用旧确认。
4. `assertRealImageExecutionAllowed` 固定拒绝真实执行，无客户端布尔开关。后续执行服务必须在解析凭证、网络连接和任何可能扣费的动作前调用闸门；本里程碑尚未接到任务内核。

公开视图省略基础地址和凭证引用，固定显示 `realExecutionEnabled=false`。`/health` 增加 `imageProviderMode=contracts-only`，原有 `realExecutorsEnabled=false` 不变。未配置状态仍没有可用的供应商目录或真实模型选择界面。

后续 5B1 已增加持久化目录及未确认准备接口；注入该服务时健康检查改为 `catalog-and-preparations-only`，未注入仍是 `contracts-only`。没有新增真实执行许可，详见 `image-provider-preparations.md`。

## 验证与限制

新增 17 项本地合同/HTTP 测试与 1 项 Chrome 闸门回归；覆盖严格参数、归属/能力/报价变更、输入及蒙版证明、费用与产物分离、真实执行拒绝。测试只用 `.invalid` 样例地址、假模型、凭证引用和回环 HTTP，不调用外网。

最终 `pnpm check` 通过：21 个测试文件、134 项单元/集成、6 个工作区构建、29 项真实 Chrome 回归。

首次构建发现 TypeScript 空值收窄及 Node 原生 TypeScript 子模块扩展名问题，已修复后重新执行完整检查。`.ts` 导出与 `allowImportingTsExtensions` 配合仓库既有 `noEmit` 构建使用。

基础地址目前只做 HTTPS 和无凭证/查询参数/片段的语法限制，**不是完整 SSRF 防护**。真实网络传输、DNS/重定向策略、凭证加密、持久化连接目录、报价来源、已确认参数与事务任务内核整合仍须后续完成；此合同通过不等于这些功能通过。

参数边界参考当时已实际打开的[官方编辑参考](https://developers.openai.com/api/reference/resources/images/methods/edit)及[官方图片指南](https://developers.openai.com/api/docs/guides/image-generation)。能力由服务端按选定模型明确声明，没有替用户选择付费模型或价格；模型蒙版不能据此宣称像素硬锁定。
