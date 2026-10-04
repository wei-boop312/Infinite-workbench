# 阶段 4 里程碑 6B：原生 DNS 与固定地址 HTTPS

日期：2026-10-04（上海）。状态：**6B 已本地验收，完整 pnpm check 为 631 项单元/集成（39 文件）、91 项 Chrome、6 个工作区构建通过**。原生客户端默认关闭，没有日常桥接接线、浏览器执行端点或真实供应商请求；不是生产 Worker、任务授权或阶段 4 整体验收。

## 原生实现与测试边界

`NativeImageNetworkClient` 使用 Node 内置 Resolver 与 HTTPS。无配置拒绝；配置须显式 networkEnabled=true、服务端租户/精确目标名单和同步可信 authorize，默认实例不解析域名或发送请求。没有读取环境、文件、用户密钥或导入凭证的代码，没有注入 request/lookup/CA 的原生构造参数。

`ImageNetworkDriverHarness` 是**独立 local-driver 测试入口**，realExecutionEnabled=false，拒绝 production/改标记。测试驱动可向自有回环 UDP DNS 和 TLS 服务路由，仅用于验证 Node 行为；生产公网政策完全不放宽。TLS 集成在驱动里先检查原参数，之后显式替换回环路由和测试 CA；因此**不是公网实际地址固定、部署路由/防火墙或生产 SSRF 全部验收**。新生成自签名证书/测试私钥是公开夹具，没有读取用户现有钥匙，也不安装系统 CA；运行不依赖 OpenSSL。

共用 `imageEgressPolicy.ts` 的原 URL/域名/IP 策略，以及有界响应读取；6A 原合同类的导出兼容，旧 contract-fixture 模式未改名或接到原生客户端。浏览器和现有 local-fixture 确认/租约/账本没有开启真实发送。所有测试状态独立，日常 5173 与用户存档不重启、不覆盖。

## DNS 与地址固定

按本机 **Node v24.19.0** 运行验证，并核对 [Node DNS](https://nodejs.org/docs/latest-v24.x/api/dns.html)、[HTTPS](https://nodejs.org/api/https.html)、[HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html) 与 [TLS](https://nodejs.org/api/tls.html) 官方资料。Resolver 使用 DNS 协议，不依赖 OS lookup/hosts；全 A 和 AAAA 各发起一次查询，ttl=true，最多 32 项，一坏整体拒绝，不能先找好地址掩盖其他坏项。[Node DNS](https://nodejs.org/docs/latest-v24.x/api/dns.html)

- 每请求独立 Resolver，tries=1；这表示对每个配置名称服务器的尝试数，不承诺只有一个 DNS 数据包，c-ares/系统 DNS 名单的故障转移和 CNAME 行为仍需部署验收。ENODATA 仅视为空族；ENOTFOUND、SERVFAIL、超时等一律失败关闭，无应用层重新解析/重试。
- 记录必须有整数 TTL 1..2³²−1；有效期限从查询开始算，取全部记录最小 TTL 与 30 秒上限的较小值。TTL=0 保守拒绝，时钟无效/倒退或过期拒绝；不是完整 CNAME 链 TTL/全球路由证明。
- 共用原始 HTTPS URL 校验，拒绝规范化可隐藏的 IP/整数/编码地址、凭证、查询/片段、百分号、反斜线、点路径。精确域名/端口名单，允许明确非默认端口，API 根路径保留；不使用通配/后缀匹配。
- 公网地址政策和部署额外阻断不变：拒绝 IANA 特殊、多播/保留、mapped/NAT64/ULA/link-local/zone/文档等地址及 168.63.129.16；额外 IPv6 阻断按数值等价。只增阻断，不允许为回环测试加入允许例外。
- 从全部核验记录选定一个 address/family；HTTPS lookup 仅回调该份值，一次消费，无第二次解析、OS 回退、地址轮询或 autoSelectFamily。

## HTTPS 与发送前最后复查

每请求创建私有一次性 HTTPS Agent：keepAlive=false、maxSockets/maxTotalSockets=1、maxCachedSessions=0、proxyEnv={}，最终销毁，不使用 globalAgent、环境代理、共享连接池或 TLS 会话缓存。Node 文档说明代理可由 globalAgent/环境开启，因此这里显式使用空代理配置的私有 Agent。[Node HTTP 代理说明](https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support)

保留原 hostname、Host（含明确非默认端口）和 servername/SNI；rejectUnauthorized=true，使用 Node checkServerIdentity，最低 TLSv1.2、ALPN 仅 HTTP/1.1，不接受调用者自定义 CA、验证回调、socket 或代理头。这里是标准 CA/主机名验证，**不是供应商证书/公钥指纹固定**。[Node HTTPS](https://nodejs.org/api/https.html)、[Node TLS](https://nodejs.org/api/tls.html)

DNS 前、创建连接前/固定 lookup 内、证书通过后的 **before-write** 均严格同步复查可信政策。Promise 不当授权；范围含租户/项目/调用者/连接修订/凭证引用/请求指纹/实际负载 SHA。正文先复制并核 SHA；TLS secureConnect 且 authorized=true、政策与 DNS TTL 再通过，才调用 req.end 一次；此前不排队 HTTP 头或正文。自有实际 TLS 集成证明不受信 CA、错主机名、握手后撤权和过期都没有 POST 到达服务。

此范围校验**不是实际用户确认/运行租约**；客户端不查询 SQLite、权威约束、输入收据或预算。真实集成必须用服务端实际生产任务、完整冻结确认/报价、租约、输入/约束及发送事务实现 authorize，并先重建/匹配三协议原端点、鉴权及负载。不能给本地假确认换 mode 或让调用者自报已确认。当前没有满足这些要求的日常接线或执行许可。

## 有界读取、故障和费用

请求最多 64 MiB、原始响应最多 32 MiB，可调低；严格固定五个上游头（Content-Type/精确 Content-Length/Accept/Accept-Encoding/一个受控认证头），Host/Connection 由客户端构造，Cookie、任意头、代理/transfer-encoding 注入拒绝。认证只有 1..4096 可打印非空字符，bearer 前缀单独核验，不读凭证引用所指的秘密。

响应原始头不折叠或静默截断：maxHeadersCount=0 后核验 rawHeaders 最多 100 项/16 KiB，并由 Node parser 提前限制总头大小；重复、控制字符、重定向/Location、非 JSON 和压缩拒绝。沿用 8 MiB 单片、4096 个非空分片与实际/声明长度匹配；半包、未 complete 或 trailer 拒绝。不跟随产物 URL，不自动重试/换地址/模型。

总时限默认 5 秒、最多 30 秒，取消覆盖查询、连接、TLS、等待/读取；Resolver.cancel、响应/请求 destroy 与 Agent.destroy 收尾。每实例含失败单次；同进程共享两个槽，未结清 DNS/迭代操作或 request.close 保留槽，不能以超时无限腾空后台工作。原生 cancel/销毁由真实本地服务测试；恶意可信驱动不是沙箱，可能占满容量，不是跨进程全局硬闸门。

临时 Buffer 尽力清零/头引用删除；Node 内部头字符串、调用者原件或恶意驱动副本不能保证擦除。异常固定白名单码，不透传私密 message/code/cause。只返回原始协议包，不创造发送/响应持久化证据、产物或账本；失败/好图均不能据此记零费、释放未知预留。原图/输出 8192/1600 万像素政策、锁区拒绝、费用核账以及既有资产/画布闭环保持不变。

## 验收与下一步

新增 70 项网络回归：默认关闭、严格范围/摘要/头/信号/时钟、全 A/AAAA/TTL/额外数值阻断、固定 lookup、非默认端口、私有 Agent、容量/不合作取消、固定错误与单次失败；实际自有 UDP Resolver/cancel 和 TLS 服务的正向、CA/主机名拒绝、握手后撤权/过期、重定向、截断/取消、压缩、重复/数量/大小头。初轮两个失败为在请求完成/取消后才测试 lookup，已改为存活请求期间核验；测试驱动取消改幂等，客户端保留 error 监听处理迟到错误，未忽略未处理异常。

定向最终 144/144（新 70 + 原 74）和 API 构建通过；首轮完整 629/91/6 全通过，复核补充信号/时钟及原始头数量后重新完整 pnpm check，**631/91/6 全通过**，没有忽略失败或未处理异常。Chrome 扩展既有关闭入口回归：原生网络 GET/POST 仍 404，预算/闸门不变；不是浏览器供应商网络成功。既有 Zod 注释/NO_COLOR 非致命警告保留，未为本轮改依赖。没有真实供应商 DNS/网络探测、用户密钥、付费、部署或推送。

下一步 **6C 受控加密凭证底座与零费用测试**：先核对既有凭证引用/SQLite 安全边界和 Node 官方 crypto 资料，建立默认关闭的版本化密文、租户/项目/连接绑定、轮换/撤销及临时消费合同，仅测试自有随机材料。不得自动读取文件/环境/系统保险库或导入用户密钥；根密钥提供与生产启用仍需单独配置/授权。之后再实现独立生产确认/任务/租约及发送/响应证据、可信报价/费用整合，不复用 local-fixture 或旧 mock 自动结算。最低成本真实请求仍须另获明确供应商、模型、金额和凭证配置授权。MCP/视频仍按阶段 6/7 推进。
