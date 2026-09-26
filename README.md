# AI 电商视觉无限画布

阶段 0 正式工程骨架。默认只运行假执行器，不连接模型、不读取供应商密钥、不产生费用。

## 目录

- `apps/web`：React + React Flow 画布。
- `apps/api`：项目、资产、预算与任务入口骨架。
- `apps/worker`：模型 API 与 MCP 执行器进程骨架。
- `packages/contracts`：跨进程数据合同。
- `packages/canvas-schema`：画布文档版本与迁移器。
- `packages/testing`：假执行器和故障测试夹具。
- `tests/e2e`：真实浏览器的鼠标、触控、500 节点和零外部请求检查。

## 命令

```text
pnpm install
pnpm dev
pnpm check
```

## 红线

- `apps/web` 不保存或读取供应商密钥。
- 画布文档禁止媒体 Base64，只允许 `assetId`。
- API 与 MCP 共用任务、预算、审计和资产回流合同，但执行器彼此隔离。
- 生成谱系不可编辑；画布工作流边不能充当审计记录。
- 真实付费请求必须经过服务端人工确认与预算检查。

