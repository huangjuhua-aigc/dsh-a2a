# dsh-a2a

[English](README.md) · 简体中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**入站** [A2A（Agent2Agent）](https://a2a-protocol.org)协议服务端。它在 well-known 路径上发布 Agent Card，并提供 **v0.3.0 JSON-RPC 绑定**——任何知道本部署 URL 的合规 peer 都能发现它，并向 harness agent 提交任务。

**只做入站。** 本插件从不主动连接别的 agent：没有 client、没有 peer 目录、没有 A2A subagent provider。它是一个**传输适配层**，不是能力接缝。

## 安装

```sh
dsh plugin --profile web add ./path/to/dsh-a2a   # 本地检出
dsh plugin --profile web add dsh-a2a             # 发布之后
```

> 尚未发布到 npm，目前请用本地检出那条。`npm pack` 已验证 tarball 里
> `lib/` 和 `cordis.patch.yml` 都在，只差 `npm publish` 这一步。

`dsh plugin` 会在 profile 目录里转发给 pnpm，并把这个 bundle 追加进 `dsh.profile.bundles`——因为包里声明了 `dsh.bundle`。装完再配置这一层（见[配置](#配置)）。

### 选一个带 HTTP 载体的 profile

插件注入 `ctx.agents`、`ctx.webServer`、`ctx.credentials`，三者齐备之前一直停在 PENDING。**`ctx.webServer` 由 `dsh-web-app` 提供，不在 `dsh-base` 里**——所以在 `headless` profile 上，这个 bundle 会加载完就杵在那儿：什么都没服务，也什么都不报错，因为 PENDING 在 Cordis 里是正常状态而不是故障。

| Profile | 结果 |
|---|---|
| `web` | 正常工作 |
| `headless` | PENDING —— 需先挂载 `@deepseek-ai/dsh-host-webserver` |

`dsh --profile <name> --dump-config` 会打印组合后的配置行，这是确认载体在不在最快的办法。

## 本地试跑

demo **一定会跑真实模型**——`deepseek-official/deepseek-v4-flash`，或者 `DEEPSEEK_MODEL` 指定的那个。缺凭据是错误，而不是悄悄退回到一个答不出任何有用内容的 stub。

凭据经 `ctx.credentials` 解析，所以它可以放在进程环境变量、`$DSH_HOME/.credentials.yaml`、或任一 `.env` 层里——harness 装机时本来用哪种，这里原样可用。测试套件反过来强制用 stub：真实模型会让"断言回复原文"这件事失去意义，而且每跑一次都烧 token。

`A2A_SEND_MODE=immediate` 是用来走**轮询路径**的：peer 会拿到一个非终态 task，必须再用 `tasks/get` 回来取结果。

### bash / zsh

```sh
pnpm install
A2A_PEER_ALICE=demo123 A2A_PORT=9922 A2A_SEND_MODE=immediate pnpm serve
```

```sh
curl -s http://127.0.0.1:9922/.well-known/agent-card.json

curl -s http://127.0.0.1:9922/a2a   -H "authorization: Bearer demo123"   -H 'content-type: application/json'   -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{
        "message":{"kind":"message","messageId":"m1","role":"user",
                   "parts":[{"kind":"text","text":"hello"}]}}}'
```

### PowerShell

PowerShell 没有 `VAR=value cmd` 这种前缀写法，得先设变量。另外 `curl` 是 `Invoke-WebRequest` 的别名，所以要显式调 `curl.exe`，或者改用 `Invoke-RestMethod`。

```powershell
pnpm install
$env:A2A_PEER_ALICE = "demo123"
$env:A2A_PORT = "9922"
$env:A2A_SEND_MODE = "immediate"
pnpm serve
```

另开一个终端：

```powershell
curl.exe -s http://127.0.0.1:9922/.well-known/agent-card.json

$h = @{ authorization = "Bearer demo123" }
$body = '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","messageId":"m1","role":"user","parts":[{"kind":"text","text":"hello"}]}}}'
$sent = Invoke-RestMethod -Uri http://127.0.0.1:9922/a2a -Method Post -Headers $h -ContentType 'application/json' -Body $body
$sent.result | ConvertTo-Json -Depth 5

# 此刻 task 已经结算、槽位已经释放；下面这个答案来自
# 在 session log 上折叠出来的 projection。
$taskId = $sent.result.id
$poll = Invoke-RestMethod -Uri http://127.0.0.1:9922/a2a -Method Post -Headers $h -ContentType 'application/json' `
  -Body "{`"jsonrpc`":`"2.0`",`"id`":2,`"method`":`"tasks/get`",`"params`":{`"taskId`":`"$taskId`"}}"
$poll.result | ConvertTo-Json -Depth 5
```

> **中文回复显示成乱码?** 那是 Windows PowerShell 5.1 的解码问题,不是服务端的问题。`Invoke-RestMethod` 只在响应头明确带 `charset` 时才按它解码,否则对 `application/json` 回退到 ISO-8859-1,于是 UTF-8 的中文就变成 `ä½ å¥½` 这样。改用 `Invoke-WebRequest` 自己解:
>
> ```powershell
> $resp = Invoke-WebRequest -Uri http://127.0.0.1:9922/a2a -Method Post -Headers $h -ContentType 'application/json' -Body $body
> $json = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray()) | ConvertFrom-Json
> ```
>
> 或者直接用 `curl.exe`（必要时先 `chcp 65001`）。

### 一次性探针

服务起着的时候，把所有已文档化的行为扫一遍，输出一张通过/失败清单。用纯 Node 写的，所以 JSON 载荷能绕开两种 shell 的引号规则：

```sh
pnpm probe                                        # 默认 :9922 / demo123
node example/probe.mjs http://127.0.0.1:9922 demo123
```

任何一项对不上就以非零码退出，所以它也能当作打到真实部署上的冒烟检查。

## 它对外提供什么

| 路由 | 用途 |
|---|---|
| `GET /.well-known/agent-card.json` | Agent Card（v0.3 规范路径） |
| `GET /.well-known/agent.json` | 同一张卡，兼容 0.3 之前的客户端 |
| `POST /a2a` | JSON-RPC 端点；SSE 方法也在这条路由上应答 |

| 方法 | 状态 |
|---|---|
| `message/send` | ✅ 是否阻塞逐请求协商 |
| `message/stream` | ✅ SSE，两种方言都支持 |
| `tasks/get` | ✅ 幂等，结算之后仍可应答 |
| `tasks/cancel` | ✅ 真正取消，不是丢掉回复了事 |
| `tasks/resubscribe` | ✅ 活任务续订；已结算的给一帧终态 |
| `tasks/pushNotificationConfig/*` | ⛔ 返回 `-32003`；卡上如实声明 `pushNotifications: false` |
| `tasks/list` · `ListTasks` | ⛔ 返回 `-32601`；v1.0 才有的方法，未实现 |
| `agent/getAuthenticatedExtendedCard` | ⛔ 返回 `-32601`；无扩展卡 |

两种方言都接受：v0.3（`message/send`、`"working"`、`kind` 标记的 part）是主线，v1.0 的写法（`SendMessage`、`TASK_STATE_WORKING`、按成员存在判断的 part）在入口处归一化，出口再按请求本身用的方言渲染回去。

## 它是怎么工作的

```
src/
├── protocol/          零依赖库：不碰 Cordis、不碰 HTTP、不碰 harness
│   ├── wire.ts        A2A 词汇表，统一归一到 v0.3 拼写
│   ├── normalize.ts   v0.3 <-> v1.0 方言双向翻译
│   ├── jsonrpc.ts     信封框架与 A2A 错误码
│   ├── card.ts        Agent Card 构造
│   └── sse.ts         SSE 帧编码
├── index.ts           Cordis 插件本体：接线、agent 归属、拆卸
├── router.ts          HTTP + JSON-RPC 分发；不依赖 Cordis，因此可单测
├── contexts.ts        contextId -> Activation 注册表与驻留策略
├── tasks.ts           任务槽位与三段式 turn 关联
├── projection.ts      在 session log 上折叠出的 a2aTask 读模型
├── security.ts        认证、限流、注入去势、外发脱敏
├── config.ts          schema，以及加载期就会拒绝的跨字段校验
└── types.ts           向 SessionEventMap / MessageSourceMap 的声明合并
```

三个决定塑造了其余一切：

**task 是一个区间，不是一个 turn。** 一条提交进来的消息，如果工具排出了更多工作，可能横跨好几个 turn。所以结算用三个钩子而不是一个：`agent/inbox/claimed` 把消息绑到某个 turn，`turn/end` 记录那个 turn 的结束原因，`agent.whenIdle()` 在整个 agent 安静下来后才结算。模型错误立刻判失败；token 上限则结算为 `completed`，真实结束原因放进 `Task.metadata.dsh.stopReason`——因为 A2A 的状态枚举表达不了它。

**任务状态活在 session log 里。** 每一次生命周期迁移都是一条 `a2a/task` 事件，由 projection unit 折叠成 `tasks/get` 对外提供的读模型。终态那条边同时携带 agent 已提交的输出——这是 projection 契约的「整值规则」——所以轮询的 peer 拿到的是答案本身，而不只是「活干完了」这个事实。

**HTTP 没有连接生命周期，所以驻留必须显式管理。** 每个 `contextId` 对应一个 Activation，空闲后被驱逐，持久化的 Session 留在原地。这是本设计唯一偏离 `dsh-acp` 的地方——后者的 stdio 连接天然拥有自己的 session。

## 配置

```yaml
- id: a2a-server
  name: dsh-a2a
  config:
    basePath: /a2a
    publicUrl: https://agents.example.com/a2a   # 挂在反向代理后面时填
    protocolVersion: 0.3.0    # 卡上声明的协议版本
    provider: deepseek-official
    model: deepseek-v4-flash

    card:
      name: dsh-harness
      description: 读代码、跑命令、汇报结论。
      public: true            # 发现流程预期这是匿名可读的
      skills:                 # 显式声明，绝不从 ctx.tools 投影出来
        - id: general
          name: general
          description: 通用任务执行。
          tags: [coding, research]
      provider:               # 可选，卡上的发布方署名
        organization: Example Inc.
        url: https://example.com

    # tokenEnv 是凭据的【引用名】，不是 token 本身。
    # 值放在 ~/.dsh/.credentials.yaml 或进程环境变量里。
    peers:
      alice: { tokenEnv: A2A_PEER_ALICE }
      bob:   { tokenEnv: A2A_PEER_BOB }
    trustedPeers: [alice]     # 不填 = 放行所有通过鉴权的 peer
    rateLimitPerMinute: 60
    maxContextTurns: 5

    sendMode: block           # 客户端没表态时的部署默认值
    blockTimeoutMs: 60000     # 超过这个时间就拒绝继续阻塞
    contextIdleTtlMs: 1800000
    maxResidentContexts: 64

    isolation:
      workspaceMode: per-peer # per-peer（默认）| shared
      workspaceRoot: /srv/dsh/a2a   # 必填，无默认值
      peerWorkspaces:               # 可选，按 peer 覆盖
        alice: /srv/project

    push:
      enabled: false          # 预留；见"已知限制"
```

上面每一个字段都被代码真正读取。**没有任何"接受了但不生效"的配置**——设计里的 deny-list、流式粒度、任务超时、SSRF 开关，在它们的实现落地之前一律不出现在 schema 里，免得部署方设了一个安全选项、还以为有东西在执行它。

### 加载即拒绝的情况

- `isolation.workspaceRoot` 必填
- peer 名字必须匹配 `[A-Za-z0-9][A-Za-z0-9_-]*`（它会变成目录名）
- `tokenEnv` 必须是 POSIX 标识符，所以粘贴进来的真 token 会被拒
- `trustedPeers` 和 `peerWorkspaces` 只能引用已声明的 peer
- `basePath` 必须以 `/` 开头

### 凭据

配置里携带的是**引用**，值放在凭据提供方那里：

```yaml
# ~/.dsh/.credentials.yaml
A2A_PEER_ALICE: 9f3c1e7a2b8d4f60a15e93c7d2b48f61
```

引用名必须是 POSIX 标识符——所以把真 token 粘进 `tokenEnv` 会在加载期直接失败，而不是悄悄变成一个永远解析不出来的查找键。轮换不需要重启：凭据是每请求解析的。

这里**刻意没有共享 bearer token**。peer 隔离建立在"已鉴权的身份"之上，两个 peer 共用一份凭据就等于共用一个身份，彼此的 context 就能互相读到。

## 隔离

三层，前两层是结构性的：

| 层 | 保证 | 机制 |
|---|---|---|
| 模型上下文 | peer A 的对话进不了 peer B 的模型请求 | 不同 `contextId` → 不同 Session → 不同 log |
| 协议访问 | peer B 读不到、续不了、也取消不了 peer A 的 context 或 task | 按已鉴权身份判归属；别人的 id 与不存在的 id 应答完全一致 |
| 工具 | peer A 的 agent 无法用工具读到 peer B 的 session | `workspaceMode: per-peer`（默认） |

`per-peer` 给每个身份独立的 `cwd`。跨 session 的工具按 `cwd` 严格相等来授权，所以不同工作目录**用现成的机制**就把 peer 隔开了——顺带也切断了文件系统这条侧信道。

`shared` 是协作姿态（多台机器维护同一个仓库），必须显式选择：在它之下，peer A 的文件对 peer B 可读。

## 安全姿态

- **没有凭据就没有服务。** `peers` 表为空时，所有请求一律 401。
- **不提供 TLS。** `ctx.webServer` 不带 TLS；任何非 loopback 的暴露都请在前面放反向代理。
- **审批一律确定性拒绝。** 没人在旁边盯着一个由 A2A 驱动的 agent，所以策略在该 agent 自己的 log 上被钉死为 `never`，而不是干等一个不会有人回答的提示。
- **注入去势是降噪，不是边界。** 边界是沙箱范围和那个被拒绝的审批。
- **回复在出站前被洗过**，形似凭据的字符串会被清掉。
- **工具结果永不外传给 peer** —— A2A 的"执行不透明"原则。

## 阻塞是协商出来的，不是写死的

A2A 是 async-first 的：`message/send` 可以用一个非终态 task 来应答。这一轮到底等不等，按下面的顺序逐请求决定：

1. `params.configuration.blocking` —— 客户端明示的偏好
2. `sendMode` —— 客户端没表态时的部署默认值
3. `blockTimeoutMs` —— 超过它服务端就拒绝继续等

**拒绝继续等 ≠ 失败**：应答的是一个非终态 task，任务仍在跑，`tasks/get` 能拿到结果。规范明确允许这么做——*"若任务长时间运行，服务端可以拒绝阻塞。"*

```jsonc
{ "method": "message/send", "params": {
    "message": { "kind": "message", "messageId": "m1", "role": "user",
                 "parts": [{ "kind": "text", "text": "…" }] },
    "configuration": { "blocking": true } } }
```

## 任务持久性

任务状态由一个 `a2aTask` projection 单元从 session log 里折叠出来，所以 task 结算之后 `tasks/get` 仍然答得出来——**这正是轮询路径能用的前提**。`message/stream` 和推送通知都是 A2A 的可选能力，`tasks/get` 才是每个 peer 都能依赖的底线。

终态那条边携带的是 agent **已提交的输出**，而不只是一个状态——这是 projection 契约的"整值"规则。少了它，轮询的 peer 会收到一个 `completed` 配一个空 artifact 列表，读起来像"跑成功了但什么都没产出"，而不是提示它该重试。

projection 注册表（`ctx.sessionProjections`）是可选依赖。没有它的组合照样能服务，但会打一条警告，并且在 task 结算之后就答不出来了。

**扛住进程重启**还需要额外组合 session 持久化，那条路径尚未接通。

## 已知限制

- 推送通知未实现；卡上如实声明为不支持。
- 只提供 JSONRPC 绑定（没有 gRPC，没有 HTTP+JSON）。
- 没有扩展版 Agent Card，没有 `stateTransitionHistory`、extensions、卡签名。
- 触到 token 上限会把 task 结算为 `completed`，而不是一个单独的状态；真实的 harness 轮次结束原因放在 `Task.metadata.dsh.stopReason` 里。
- 任何配置变更都会重启插件，并取消进行中的 task。
- `streamGranularity` 不可配置：流式只发出已提交的 assistant 消息。逐块流式设计过，但没实现。
- 没有孤儿任务看门狗：卡在非终态的 task 就一直卡着。
- `push.enabled` 只决定推送方法返回哪种错误；没有发送器，因此也没有 SSRF 围栏可配。
- 跨 session 的工具拒绝未实现。peer 隔离靠的是 `workspaceMode: per-peer`，那个是真正执行的。
- 任务状态能扛过结算，但扛不过重启：session 持久化尚未组合，重启后 projection 没有 log 可以冷折叠。
- 对需要协作的 peer 来说，`workspaceMode: per-peer` 是个糟糕的默认值——它们必须显式设 `shared`，否则各自只会看到一个空目录。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test          # 129 个测试，9 个文件：协议、安全、任务、上下文、
                   # projection、端到端、SSE、轮询、阻塞
pnpm serve         # 在 localhost 上起一个真实服务
```

端到端套件会启动一个真实的 Cordis 组合、跑真实的 agent loop、并通过真实 HTTP 驱动它——和 `pnpm serve` 跑的是同一个组合，所以**测试证明的就是你实际运行的东西**。

## 兼容性

针对 harness 包的 `0.1.0-rc.6` 线构建。harness 尚处预发布阶段，且明确不承诺跨重命名或重新打包的兼容性，因此 peer dependencies 全部精确锁版本：上游的破坏性变更应该在安装时就失败，而不是等到运行时。

## 许可

MIT
