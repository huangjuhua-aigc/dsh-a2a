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
  <img src="https://img.shields.io/badge/A2A-v1.0%20JSON--RPC-4D6BFE?style=flat" alt="A2A v1.0 JSON-RPC 绑定">
  <img src="https://img.shields.io/badge/DSH-0.1.0--rc.6-4493F8?style=flat" alt="基于 DSH 0.1.0-rc.6 构建">
  <img src="https://img.shields.io/badge/tests-160-2EA44F?style=flat" alt="160 项测试">
</p>

`dsh-a2a-server` 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
上的 agent 可以通过 [A2A（Agent2Agent）](https://a2a-protocol.org)协议被访问。它在
well-known 路径发布 Agent Card，并实现 **v1.0 JSON-RPC 绑定**——任何知道本部署
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
| `ctx.sessionProjections`（可选） | 组合层；启用后 `GetTask` 在任务结算后仍可应答 |

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
  -H 'a2a-version: 1.0' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{
        "message":{"messageId":"m1","role":"ROLE_USER",
                   "parts":[{"text":"hello"}]}}}'
```

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `A2A_PEERS` | `alice` | `名字[:token]` 列表；每个 peer 都必须有 token |
| `A2A_PORT` | `9900` | 监听端口 |
| `A2A_SEND_MODE` | `block` | `block` 或 `immediate` |
| `A2A_WORKSPACE_ROOT` | 临时目录 | per-peer 工作目录的父目录 |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | 向适配器请求的模型 id |

一次性探针会对运行中的服务执行 67 项检查，任何一项不符即以非零码退出：

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

| JSON-RPC 方法 | 状态 |
| --- | --- |
| `SendMessage` | 是否等待逐请求协商 |
| `SendStreamingMessage` | SSE |
| `GetTask` | 幂等；结算后仍可应答 |
| `ListTasks` | 游标分页、可过滤；仅覆盖常驻的 context |
| `CancelTask` | 取消正在执行的 turn |
| `SubscribeToTask` | 续订活任务；终态任务返回 `-32004` |
| `GetExtendedAgentCard` | 已认证 peer 可见的额外 skill；未配置时 `-32007` |
| `*TaskPushNotificationConfig` | `-32003` |

**只提供 A2A v1.0。** v0.3 的方法名、`kind` 判别字段、小写枚举、嵌套 `file`
part 是被**删除**而不是做了别名：本服务写出的每一个回包都是 v1.0 JSON，v0.3
客户端本就读不懂，所以“应答一个 v0.3 请求”只会让故障离成因更远。已退役的方法回
`-32601` 并直接告知新名字；显式的 `A2A-Version: 0.3` 回 `-32009`
（`VersionNotSupportedError`）。不带 `A2A-Version` 头的请求按 1.0 处理——这是本接口
在 Card 上声明的唯一版本。

具体到线上，与 v0.3 的差异：

| 关注点 | v0.3 | 本服务的 v1.0 |
| --- | --- | --- |
| 任务引用 | `params.taskId` | `params.id` |
| `SendMessage` 结果 | 裸 `Task` | `{ "task": … }` |
| 任务状态 | `"working"` | `"TASK_STATE_WORKING"` |
| 消息角色 | `"user"` | `"ROLE_USER"` |
| Part | `{"kind":"text","text":…}` | `{"text":…}`；文件 part 展平为 `url`/`raw`/`filename`/`mediaType` |
| 流帧 | `{"kind":"status-update",…,"final":true}` | `{"statusUpdate":{…}}`；流关闭即终态信号 |
| 流首帧 | 一帧非终态 status update | `Task` 对象本身 |
| 等待控制 | `configuration.blocking` | `configuration.returnImmediately`（语义反转，默认等待） |
| Card 端点 | `url` + `preferredTransport` | `supportedInterfaces[]`，每条自带 `protocolVersion` |
| Card 鉴权 | `securitySchemes` + `security` | scheme 包在 `httpAuthSecurityScheme` 里；改用 `securityRequirements` |
| 扩展 Card | `supportsAuthenticatedExtendedCard` | `capabilities.extendedAgentCard` |
| A2A 错误细节 | 无 | `error.data[]` 携带 `google.rpc.ErrorInfo`，含 `reason` 与 `domain` |

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
│   ├── wire.ts        A2A v1.0 词汇表：只有一种形状，不需要翻译
│   ├── parse.ts       入站解析与方法表
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
pnpm probe      # 对运行中的服务执行 67 项检查
pnpm build      # 产出 lib/
```

端到端测试会启动真实的 Cordis 组合与真实的 agent loop，并通过 HTTP 驱动它；模型使用
确定性的 stub 适配器，使断言不依赖模型输出。

## 与官方项目的关系

本项目基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 构建。

官方项目提供 agent 运行时、插件系统，以及本插件所消费的各个能力接缝。本项目提供：

- 入站的 A2A v1.0 JSON-RPC 绑定
- Agent Card 构造与入站请求解析
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
