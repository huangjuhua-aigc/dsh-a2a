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
  <img src="https://img.shields.io/badge/DSH-0.2.1--rc.2-4493F8?style=flat" alt="基于 DSH 0.2.1-rc.2 构建">
  <img src="https://img.shields.io/badge/tests-217-2EA44F?style=flat" alt="217 项测试">
</p>

`dsh-a2a-server` 让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
上的 agent 可以通过 [A2A（Agent2Agent）](https://a2a-protocol.org)协议被访问。它在
well-known 路径发布 Agent Card，并实现 **v1.0 JSON-RPC 绑定**——任何知道本部署
URL 的合规 peer 都能发现这个 agent 并向它提交任务。

本插件**只做入站**：从不主动连接其他 agent，没有 client、没有 peer 目录、没有 A2A
subagent provider。它是 `ctx.agents` 之上的传输适配层，不是能力接缝。

## 安装

需要本机配置界面或跨网络访问时，先看配套 [Talk2MyAgent 使用说明](https://github.com/huangjuhua-aigc/Talk2MyAgent)。
访客读取权限、自动简报、主人 IPC 与 Tailscale 部署详见[部署与迁移指南](https://github.com/huangjuhua-aigc/dsh-a2a/blob/main/docs/public-access-hardening.md)。

```sh
dsh plugin --profile web add dsh-a2a-server@0.3.0
```

`dsh plugin` 会在 profile 目录里转发给 pnpm，并把这个 bundle 追加进
`dsh.profile.bundles`——因为包中声明了 `dsh.bundle`。自 DSH v0.2.1-alpha.1 起，
`--profile` 必须放在所有 pnpm 参数之前——上面的写法已经是正确的。

若想直接使用本地检出，把路径指过去即可：

```sh
dsh plugin --profile web add ./path/to/dsh-a2a-server
```

| 依赖 | 由谁提供 |
| --- | --- |
| `ctx.agents` | `dsh-base` |
| `ctx.credentials` | `dsh-base` |
| `ctx.webServer` | **`dsh-web-app`** |
| `ctx.tools` 和 `ctx.systemPrompt` | 必需的访客工具及提示词隔离服务 |
| `ctx.sessionProjections`（可选） | 组合层；提供任务生命周期投影 |

必需服务齐备之前，插件保持 PENDING。`ctx.webServer` 由 `dsh-web-app` 提供而不在
`dsh-base` 中，因此 `headless` profile 需要先挂载 `@deepseek-ai/dsh-host-webserver`。
`dsh --profile <name> --dump-config` 可以打印组合出来的配置行。

### 从 0.2.x 升级

0.3.0 适配 DSH `>=0.2.1-rc.2 <0.3.0`。先停止 agent，将
`dsh-a2a-server@0.3.0` 安装到原有 profile，再重新启动；配套 Portal 也需更新。
主人 RPC 和监控已改为需要认证的本机 IPC，公网 HTTP 不接受主人凭据。
访客可聊天并读取授权目录，其他工具关闭；空白名单 `trustedPeers: []` 拒绝所有访客。
任务结果与空闲会话在保留期内可跨驱逐和重启恢复。

新版 [Talk2MyAgent Portal](https://github.com/huangjuhua-aigc/Talk2MyAgent) 默认开启每小时简报更新，
用一个开关控制，完成后直接写入 `.hop/handoff.md`。单独安装协议插件而未配置 `briefing`
不会自动执行简报任务。详见 [0.3.0 发布说明](https://github.com/huangjuhua-aigc/dsh-a2a/blob/main/CHANGELOG.zh-CN.md)。

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
| `A2A_WORKSPACE_ROOT` | 临时目录 | 访客授权资料目录，同时作为 per-peer 工作目录的父目录 |
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
| `{basePath}/admin/contexts[/<id>]` | GET | 仅本机 IPC + admin token，公网 HTTP 不挂载 |

| JSON-RPC 方法 | 状态 |
| --- | --- |
| `SendMessage` | 是否等待逐请求协商 |
| `SendStreamingMessage` | SSE |
| `GetTask` | 幂等；结算后仍可应答 |
| `ListTasks` | 游标分页、可过滤；包括保留期内的持久化任务 |
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
      description: 读取授权目录中的代码和资料，回答访客问题。
      public: true
      skills:
        - id: general
          name: general
          description: 对话与授权目录内的文件读取。
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
| `card.extendedSkills` | `[]` | 只对已认证 peer 经 `GetExtendedAgentCard` 公开的 skills |
| `peers` | `{}` | 身份 → 凭据**引用名** |
| `trustedPeers` | 全部已认证身份 | 对话与受限文件读取白名单；`[]` 拒绝所有访客 |
| `rateLimitPerMinute` | `60` | 按身份的滑动窗口 |
| `maxContextTurns` | `5` | 单个 context 接受的消息数上限，超出后 `rejected` |
| `sendMode` | `block` | 客户端未表态时的默认行为 |
| `blockTimeoutMs` | `60000` | 最长阻塞等待；到期返回任务当前状态，客户端可继续查询 |
| `contextIdleTtlMs` | `1800000` | context 的 agent 被释放前的空闲时长 |
| `maxResidentContexts` | `64` | 常驻 context 数量上限 |
| `isolation.workspaceMode` | `per-peer` | `per-peer` 或 `shared` |
| `isolation.workspaceRoot` | — | 必填；授权资料目录，同时作为访客 cwd 的父目录或共享 cwd |
| `isolation.peerWorkspaces` | `{}` | 按身份覆盖工作目录和授权读取范围 |
| `preamble.files` | `[".hop/handoff.md"]` | 主人背景简报文件（**agent 级**：相对工作区根目录解析，全体访客共用一份；绝对路径直通），合并进每个 context 的首条访客消息；文件不存在则跳过 |
| `briefing.prompt` | — | 可选的单次简报更新指令，由 Portal 配置，通过有执行预算的主人 agent 每小时运行 |
| `briefing.settingsFile` | — | 绝对路径；读取 `{ "enabled": boolean }` 设置，缺省开启，每 5 秒检查 |
| `admin.tokenEnv` | — | 本机主人 RPC 和监控的凭据引用，公网 RPC 拒绝此凭据 |
| `admin.socketPath` | 按部署生成 | Windows 命名管道或私有 Unix socket |
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
refs:
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
| 工具层 | 仅提供受控 `read_file`，不开放写入、命令、联网或跨会话工具 | 屏蔽继承工具、专用读取工具、执行校验 |
| 提示词 | 访客不继承可选的主人个性化提示与运行时上下文 | 独立的公共系统提示词 |

`per-peer`（默认）依据 `workspaceRoot` 为每个身份派生独立 `cwd`；`shared` 使用同一个目录。
这只是工作目录策略，不是文件系统沙箱。`read_file` 的读取范围默认是用户选择的
`workspaceRoot`，有 `peerWorkspaces` 覆盖时限制为该访客的专属目录。工具相对路径从
这个资料目录解析；插件私有状态目录始终排除。

`read_file({"path":"."})` 列出资料目录；文件支持 UTF-8 文本，按 `offset`/`limit`
分页。单文件上限 2 MiB，单次最多 32000 字符、500 行/项，目录扫描最多 1000 项。
拒绝越界、符号链接/junction、硬链接和 Windows ADS。主人维护能力使用独立本机 IPC，
保留可信管理工具，不能从公网入口调用。资源配额的完整配置表见英文 README。

## 边界

- 只做入站。没有出站 client、peer 目录或 A2A subagent provider。
- 只提供 JSONRPC 绑定。不提供 gRPC 与 HTTP+JSON，Card 上如实声明。
- 未实现推送通知。`push.enabled` 仅决定推送方法返回哪个错误码，Card 上声明
  `pushNotifications: false`。
- 不支持 `stateTransitionHistory`、协议扩展与 Card 签名。
- 流式只推送已提交的 assistant 消息，未实现逐 chunk 推送。
- 有并发准入、任务期限及模型调用预算；超时后等待底层适配器完成取消才释放执行名额。
  不响应取消的适配器仍需进程级监管，这些额度不是按货币计费的预算。
- 访客仅能使用有目录边界的 `read_file`；改变沙箱模式不会自动开放其他工具。
  该工具边界不替代针对恶意本机管理员的操作系统隔离。
- 触及 token 上限的任务结算为 `completed`，真实的 turn 结束原因放在
  `Task.metadata.dsh.stopReason`——A2A 的状态枚举无法表达它。
- 任务结果与空闲会话在保留期内可跨进程重启恢复；中断的任务标记失败，不重放。
- 每个 context 同时只允许一个任务，并发提交返回 409；messageId 不是提交去重键。
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
├── workspace-read.ts  授权目录内受限的 read_file
├── management.ts      本机 IPC 主人 RPC 与监控
├── state.ts           持久化任务及对话 checkpoint
├── briefing.ts        每小时简报更新与持久化调度
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
空闲后被驱逐。私有 checkpoint 保留任务结果与对话历史，冷恢复时创建新的 harness session。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test       # 15 个文件共 217 项测试
pnpm serve      # 启动监听服务
pnpm probe      # 对运行中的服务执行 67 项检查
pnpm build      # 产出 lib/
pnpm test:package # 仅声明运行依赖时验证构建产物导入
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

harness 处于 pre-release 阶段，不承诺跨重命名或重新打包的兼容性，因此兼容性通过
`engines.dsh`（`>=0.2.1-rc.2 <0.3.0`）加上按 range 声明的 `@deepseek-ai/dsh-*`
peer 依赖来表达：安装预检会拒绝任何插件未曾适配过的组合，而这个 range 也放行后续
所有的 0.2.x 补丁版本。

## 社区交流

扫码加入微信群 **A2A 产品应用和探索** —— 交流 A2A 的实际应用，也包括这个插件。

<p align="center">
  <img src="https://raw.githubusercontent.com/huangjuhua-aigc/dsh-a2a/main/assets/community-wechat.jpg" alt="微信群二维码" width="280">
</p>

若二维码已过期，欢迎提 issue，我们会更新。

## 许可

MIT
