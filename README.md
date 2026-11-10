# AI Commercial Workspace / 商业无限画布工作台

本仓库保存截至2026-11-10的项目计划、实现代码、测试与验收证据。当前是本地开发阶段，完整云端MVP及五场景尚未全部验收。

## 目录

- `00_PROJECT_OVERVIEW.md` 与 `01_PRODUCT` 至 `05_PROJECT_MANAGEMENT`：产品、架构、技术、开发和项目管理文档。
- `implementation/`：应用、服务端、worker、契约、数据库迁移、工具、测试和验收证据。
- 稳定入口：`implementation/docs/IMPLEMENTATION_STATUS.md`。
- 暂停与续做：`implementation/docs/PAUSE_HANDOFF.md`。

## 分支

- `main`：已完整验证的本地版本；全量3002项、六包构建、12条本地浏览器及真实CPU路径通过。
- `codex/agent-recovery-pending-validation`：恢复交互候选，仅两条针对性浏览器验证通过；构建和全量待继续，尚未合入稳定版。

不包含本机账号数据库、用户素材、私有备份、运行缓存、node_modules或密钥。外部原始DOCX及历史聊天附件未复制；来源与复用范围见项目文档。既有Git提交历史保留；旧路径提交位于整理目录前。

## 本地使用

在 `implementation` 中安装锁定依赖并执行命令（Node要求见package.json）：

```powershell
cd implementation
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm local:dev
```

入口默认仅监听 `http://127.0.0.1:4310/`。真实CPU缩放还需显式配置已有ComfyUI与Python路径，参见开发部署文档；不自动下载模型、不接付费供应商。仓库不包含已完成云部署、模型接入或全部许可批准的承诺。
