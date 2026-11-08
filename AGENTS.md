# 商业工作区迁移实施规则

先读上级00_PROJECT_OVERVIEW.md、04_DEVELOPMENT/PROJECT_RULES.md及本仓库docs/IMPLEMENTATION_STATUS.md。当前分支从旧画布19499e7隔离复制，旧仓库只读，不继承旧聊天的自动续做/额度/模型与费用授权。不可推送到旧仓库，origin的push URL已禁用。

业务基线为双层、云端、固定版本与快照；旧React Flow画布和本机存储仍保留为回归基线，不声称完成云改造。workspacePrototype是离线契约验证器，没有真实身份/数据库/执行权限，不接公开HTTP。不能把prepared_not_submitted称作已入队或生成成功。

Python编译仅使用vendor保留模块和归档registry，不注册日常Comfy路由，不下载权重，不读取原保险库。运行时由WORKSPACE_PYTHON显式指定Python，不修改Comfy内置Python。真实worker执行需另满足身份、预算、持久化和运行状态机依赖。

新增行为先跑针对风险的测试，再pnpm test和pnpm build；前端变更还需实际浏览器。测试不访问用户素材或真实供应商，记录真实失败及跳过，不改超时/worker/阈值掩盖故障。许可清点不是法律批准；缺口按证据记录。
