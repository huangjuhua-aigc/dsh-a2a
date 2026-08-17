<h1 align="center">dsh-a2a-server</h1>

<p align="center">
  <strong>为 DeepSeek Harness 提供入站 A2A 协议服务。</strong><br>
  发布 Agent Card，接收任何合规 peer 提交的任务。<br>
  万物皆「插件」，它就是其中之一。
</p>

<p align="center">
  <a href="https://github.com/huangjuhua-aigc/dsh-a2a/blob/main/README.md">English</a> · <a href="https://github.com/huangjuhua-aigc/dsh-a2a/blob/main/README.zh-CN.md"><b>简体中文</b></a>
</p>

<p align="center"><sub>社区维护的插件，并非 DeepSeek 官方产品。</sub></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-a2a-server"><img src="https://img.shields.io/npm/v/dsh-a2a-server?style=flat&label=npm&color=CB3837" alt="npm 版本"></a>
  <a href="https://github.com/huangjuhua-aigc/dsh-a2a/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/A2A-v0.3.0%20JSON--RPC-4D6BFE?style=flat" alt="A2A v0.3.0 JSON-RPC 绑定">
  <img src="https://img.shields.io/badge/DSH-0.1.0--rc.6-4493F8?style=flat" alt="基于 DSH 0.1.0-rc.6 构建">
  <img src="https://img.shields.io/badge/tests-129-2EA44F?style=flat" alt="129 项测试">
</p>

`dsh-a2a-server` 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
上的 agent 可以通过 [A2A（Agent2Agent）](https://a2a-protocol.org)协议被访问。它在
well-known 路径发布 Agent Card，并实现 **v0.3.0 JSON-RPC 绑定**——任何知道本部署
URL 的合规 peer 都能发现这个 agent 并向它提交任务。

本插件**只做入站**：从不主动连接其他 agent，没有 client、没有 peer 目录、没有 A2A
subagent provider。它是 `ctx.agents` 之上的传输适配层，不是能力接缝。

## 安装

```sh
dsh plugin --profile web add dsh-a2a-server
```

`dsh plugin` 会在 profile 目录里转发给 pnpm，并把这个 bundle 追加进
`dsh.profile.bundles`——因为包中声明了 `dsh.bundle`。

若想直接使用本地检出，把路径指过去即可：

```sh
dsh plugin --profile web add ./path/to/dsh-a2a-server
```

| 依赖 | 由谁提供 |
| --- | --- |
| `ctx.agents` | `dsh-base` |
| `ctx.credentials` | `dsh-base` |
| `ctx.webServer` | **`dsh-web-app`** |
| `ctx.sessionProjections`（可选） | 组合层；启用后 `tasks/get` 在任务结算后仍可应答 |

三个必需服务齐备之前，插件保持 PENDING。`ctx.webServer` 由 `dsh-web-app` 提供而不在
`dsh-base` 中，因此 `headless` profile 需要先挂载 `@deepseek-ai/dsh-host-webserver`。
`dsh --profile <name> --dump-config` 可以打印组合出来的配置行。

## 快速开始

仓库自带的示例组合会运行真实模型并启动一个监听服务。

```sh
pnpm install
A2A_PEERS="alice:demo123" A2A_PORT=9922 pnpm serve
```

```powershell
$env:A2A_PEERS = "alice:demo123"
$env:A2A_PORT = "9922"
pnpm serve
```

peer 名字是任意的——`alice` 只是这个 demo 的默认值，不是协议规定。可以声明任意多个，
token 既可以内联，也可以存在派生出来的凭据引用下：

```sh
A2A_PEERS="ops:tok1,research:tok2"   # 内联
A2A_PEERS="ops,research"             # token 取自 A2A_PEER_OPS / A2A_PEER_RESEARCH
```

模型凭据经 `ctx.credentials` 解析，因此 harness home、任一 `.env` 层或进程环境中已有的
`DEEPSEEK_API_KEY` 都会被直接采用。缺少凭据时启动失败。

获取 Card 并提交任务：

```sh
curl -s http://127.0.0.1:9922/.well-known/agent-card.json

curl -s http://127.0.0.1:9922/a2a \
  -H "authorization: Bearer demo123" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{
        "message":{"kind":"message","messageId":"m1","role":"user",
                   "parts":[{"kind":"text","text":"hello"}]}}}'
```

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `A2A_PEERS` | `alice` | `名字[:token]` 列表；每个 peer 都必须有 token |
| `A2A_PORT` | `9900` | 监听端口 |
| `A2A_SEND_MODE` | `block` | `block` 或 `immediate` |
| `A2A_WORKSPACE_ROOT` | 临时目录 | per-peer 工作目录的父目录 |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | 向适配器请求的模型 id |

一次性探针会对运行中的服务执行 48 项检查，任何一项不符即以非零码退出：

```sh
pnpm probe                                        # 默认 :9922 / demo123
node example/probe.mjs http://127.0.0.1:9922 demo123
```

## 对外接口

| 路由 | 方法 | 认证 |
| --- | --- | --- |
| `/.well-known/agent-card.json` | GET | 默认公开 |
| `/.well-known/agent.json` | GET | 默认公开 |
| `{basePath}`（默认 `/a2a`） | POST | 必须携带 Bearer |

| JSON-RPC 方法 | v1.0 别名 | 状态 |
| --- | --- | --- |
| `message/send` | `SendMessage` | 是否阻塞逐请求协商 |
| `message/stream` | `SendStreamingMessage` | SSE |
| `tasks/get` | `GetTask` | 幂等；结算后仍可应答 |
| `tasks/cancel` | `CancelTask` | 取消正在执行的 turn |
| `tasks/resubscribe` | `SubscribeToTask` | 续订活任务，或给一帧终态 |
| `tasks/pushNotificationConfig/*` | `*TaskPushNotificationConfig` | `-32003` |
| `tasks/list` | `ListTasks` | `-32601` |
| `agent/getAuthenticatedExtendedCard` | `GetExtendedAgentCard` | `-32601` |

两种方言都接受。v0.3（`message/send`、`"working"`、带 `kind` 的 part）是主线；v1.0
拼写（`SendMessage`、`TASK_STATE_WORKING`、成员存在式 part）在入站时被归一化，并按请求
所用的方言渲染回去。

入站消息可携带 text、file、data 三类 part。file 与 data 会以方括号引用的形式进入模型
上下文。回复为纯文本。

认证、限流与信任门分别以 HTTP `401`、`429`、`403` 应答，响应体仍是合法的 JSON-RPC 错误
信封。属于其他 peer 的任务，应答方式与不存在的任务完全一致。

## 配置

```yaml
- id: a2a-server
  name: dsh-a2a-server
  config:
    basePath: /a2a
    publicUrl: https://agents.example.com/a2a   # 写入 Card 的对外地址
    protocolVersion: 0.3.0
    provider: deepseek-official
    model: deepseek-v4-flash

    card:
      name: dsh-harness
      description: 读代码、执行命令、给出结论。
      public: true
      skills:
        - id: general
          name: general
          description: 通用任务执行。
          tags: [coding, research]
      provider:
        organization: Example Inc.
        url: https://example.com

    peers:
      alice: { tokenEnv: A2A_PEER_ALICE }
      bob:   { tokenEnv: A2A_PEER_BOB }
    trustedPeers: [alice]
    rateLimitPerMinute: 60
    maxContextTurns: 5

    sendMode: block
    blockTimeoutMs: 60000
    contextIdleTtlMs: 1800000
    maxResidentContexts: 64

    isolation:
      workspaceMode: per-peer
      workspaceRoot: /srv/dsh/a2a
      peerWorkspaces:
        alice: /srv/project

    push:
      enabled: false
```

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `basePath` | `/a2a` | JSON-RPC 路由 |
| `publicUrl` | 由 `Host` 推导 | 写入 Card 的可路由地址 |
| `protocolVersion` | `0.3.0` | Card 上声明的协议版本 |
| `provider` · `model` | — | 本服务创建的每个 agent 使用的模型路由 |
| `card.public` | `true` | 无需凭据即可获取 Card |
| `card.skills` | `[]` | 声明的 skills；为空时回退到一条 `general` |
| `peers` | `{}` | 身份 → 凭据**引用名** |
| `trustedPeers` | 全部已认证身份 | 允许执行任务的身份白名单 |
| `rateLimitPerMinute` | `60` | 按身份的滑动窗口 |
| `maxContextTurns` | `5` | 单个 context 接受的消息数上限，超出后 `rejected` |
| `sendMode` | `block` | 客户端未表态时的默认行为 |
| `blockTimeoutMs` | `60000` | 超过后拒绝继续阻塞 |
| `contextIdleTtlMs` | `1800000` | context 的 agent 被释放前的空闲时长 |
| `maxResidentContexts` | `64` | 常驻 context 数量上限 |
| `isolation.workspaceMode` | `per-peer` | `per-peer` 或 `shared` |
| `isolation.workspaceRoot` | — | 必填；父目录或共享 cwd |
| `isolation.peerWorkspaces` | `{}` | 按身份覆盖工作目录 |
| `push.enabled` | `false` | 保留字段，见[边界](#边界) |

以下情况在加载期即被拒绝：缺少 `isolation.workspaceRoot`；peer 名不匹配
`[A-Za-z0-9][A-Za-z0-9_-]*`；`tokenEnv` 不是 POSIX 标识符；`trustedPeers` 或
`peerWorkspaces` 引用了未声明的 peer；`basePath` 不以 `/` 开头。

### 凭据

配置中携带的是凭据**引用名**，而非凭据值：

```yaml
peers:
  alice: { tokenEnv: A2A_PEER_ALICE }
```

```yaml
# ~/.dsh/.credentials.yaml
A2A_PEER_ALICE: <32-byte-hex-from-openssl-rand>
```

`ctx.credentials` 在每次请求时跨四层解析该引用——进程环境、托管文档、`<cwd>/.env`、
`$DSH_HOME/.env`——因此轮换 token 在下一次请求即生效，无需重启。peer 身份只来自所出示
的凭据，请求体中的任何内容都无法声明身份。本插件不提供共享 bearer token：隔离建立在
互不相同的身份之上。

## 隔离

| 层 | 保证 | 机制 |
| --- | --- | --- |
| 模型上下文 | 一个 peer 的对话不会进入另一个 peer 的模型请求 | 不同 `contextId` → 不同 Session → 不同 log |
| 协议访问 | peer 无法读取、续接或取消他人的 context 与任务 | 按认证身份判定归属 |
| 工具层 | peer 的 agent 无法借工具读取他人的 session | `workspaceMode: per-peer` |

`per-peer`（默认）依据 `workspaceRoot` 为每个身份派生独立 `cwd`。`shared` 则把所有 peer
放进同一个目录，适用于协作维护同一个仓库的场景；此模式下一个 peer 写入的文件对其他 peer
可读。

## 边界

- 只做入站。没有出站 client、peer 目录或 A2A subagent provider。
- 只提供 JSONRPC 绑定。不提供 gRPC 与 HTTP+JSON，Card 上如实声明。
- 未实现推送通知。`push.enabled` 仅决定推送方法返回哪个错误码，Card 上声明
  `pushNotifications: false`。
- 不支持扩展 Agent Card、`stateTransitionHistory`、协议扩展与 Card 签名。
- 流式只推送已提交的 assistant 消息，未实现逐 chunk 推送。
- 无孤儿任务看门狗：卡在非终态的任务会一直保持该状态。
- 未实现跨会话工具拒绝；隔离依赖 `workspaceMode`。
- 触及 token 上限的任务结算为 `completed`，真实的 turn 结束原因放在
  `Task.metadata.dsh.stopReason`——A2A 的状态枚举无法表达它。
- 任务状态可以跨结算存活，但无法跨进程重启：未组合 session 持久化，重启后 projection
  没有日志可供冷折叠。
- `ctx.webServer` 不提供 TLS。任何非回环地址的暴露都应置于反向代理之后。
- 修改配置会重启插件并取消进行中的任务。

## 架构

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

**task 是一个区间，不是一个 turn。** 一条提交进来的消息，如果工具排出了更多工作，可能
横跨好几个 turn，因此结算使用三个钩子：`agent/inbox/claimed` 把消息绑到某个 turn，
`turn/end` 记录该 turn 的结束原因，`agent.whenIdle()` 在整个 agent 安静后才结算。

**任务状态活在 session log 里。** 生命周期迁移是 `a2a/task` 事件，由 projection unit
折叠成读模型。终态那条边携带已提交的输出，因此折叠结果可以直接给出答案，无需回头翻消息
历史。

**驻留是显式管理的。** HTTP 没有连接生命周期，因此每个 `contextId` 对应一个 Activation，
空闲后被驱逐，持久化的 Session 留在原地。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test       # 9 个文件共 129 项测试
pnpm serve      # 启动监听服务
pnpm probe      # 对运行中的服务执行 48 项检查
pnpm build      # 产出 lib/
```

端到端测试会启动真实的 Cordis 组合与真实的 agent loop，并通过 HTTP 驱动它；模型使用
确定性的 stub 适配器，使断言不依赖模型输出。

## 与官方项目的关系

本项目基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 构建。

官方项目提供 agent 运行时、插件系统，以及本插件所消费的各个能力接缝。本项目提供：

- 入站的 A2A v0.3.0 JSON-RPC 绑定
- Agent Card 构造与方言归一化
- A2A task 与 harness turn 之间的映射
- 按 peer 的认证、隔离与工作目录策略

harness 处于 pre-release 阶段，不承诺跨重命名或重新打包的兼容性，因此 peer 依赖精确锁定
在 `0.1.0-rc.6`。

## 社区交流

扫码加入微信群 **A2A 产品应用和探索** —— 交流 A2A 的实际应用，也包括这个插件。

<p align="center">
  <img src="https://raw.githubusercontent.com/huangjuhua-aigc/dsh-a2a/main/assets/community-wechat.jpg" alt="微信群二维码" width="280">
</p>

若二维码已过期，欢迎提 issue，我们会更新。

## 许可

MIT
