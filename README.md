<h1 align="center">dsh-a2a-server</h1>

<p align="center">
  <strong>Inbound A2A protocol server for DeepSeek Harness.</strong><br>
  Publish an Agent Card, accept tasks from any compliant peer.<br>
  Everything is a plugin — this is one.
</p>

<p align="center">
  <a href="https://github.com/huangjuhua-aigc/dsh-a2a/blob/main/README.md"><b>English</b></a> · <a href="https://github.com/huangjuhua-aigc/dsh-a2a/blob/main/README.zh-CN.md">简体中文</a>
</p>

<p align="center"><sub>A community plugin, not an official DeepSeek product.</sub></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-a2a-server"><img src="https://img.shields.io/npm/v/dsh-a2a-server?style=flat&label=npm&color=CB3837" alt="npm version"></a>
  <a href="https://github.com/huangjuhua-aigc/dsh-a2a/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/A2A-v0.3.0%20JSON--RPC-4D6BFE?style=flat" alt="A2A v0.3.0 JSON-RPC binding">
  <img src="https://img.shields.io/badge/DSH-0.1.0--rc.6-4493F8?style=flat" alt="Built against DSH 0.1.0-rc.6">
  <img src="https://img.shields.io/badge/tests-129-2EA44F?style=flat" alt="129 tests">
</p>

`dsh-a2a-server` makes a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
agent reachable over the [A2A (Agent2Agent)](https://a2a-protocol.org) protocol. It
serves an Agent Card at a well-known URI and implements the **v0.3.0 JSON-RPC
binding**, so any compliant peer that knows the deployment's URL can discover the
agent and submit tasks to it.

The plugin is **inbound only**: it never connects to another agent. There is no
client, no peer directory, and no A2A subagent provider. It is a transport
adapter over `ctx.agents`, not a capability seam.

## Install

```sh
dsh plugin --profile web add dsh-a2a-server
```

`dsh plugin` forwards to pnpm inside the profile directory and appends this
bundle to `dsh.profile.bundles`, because the package declares `dsh.bundle`.

To work from a checkout instead, point it at the directory:

```sh
dsh plugin --profile web add ./path/to/dsh-a2a-server
```

| Requirement | Supplied by |
| --- | --- |
| `ctx.agents` | `dsh-base` |
| `ctx.credentials` | `dsh-base` |
| `ctx.webServer` | **`dsh-web-app`** |
| `ctx.sessionProjections` (optional) | composition; enables `tasks/get` after settlement |

The plugin stays PENDING until the three required services exist. `ctx.webServer`
ships in `dsh-web-app` rather than `dsh-base`, so a `headless` profile needs
`@deepseek-ai/dsh-host-webserver` mounted before this bundle serves anything.
`dsh --profile <name> --dump-config` prints the composed rows.

## Quick start

The bundled example composition runs a real model and a listening server.

```sh
pnpm install
A2A_PEERS="alice:demo123" A2A_PORT=9922 pnpm serve
```

```powershell
$env:A2A_PEERS = "alice:demo123"
$env:A2A_PORT = "9922"
pnpm serve
```

Peer names are arbitrary — `alice` is this demo's default, not a protocol
fixture. Name as many as you like, and either carry the token inline or store it
under the derived credential reference:

```sh
A2A_PEERS="ops:tok1,research:tok2"   # inline
A2A_PEERS="ops,research"             # tokens from A2A_PEER_OPS / A2A_PEER_RESEARCH
```

The model credential is resolved through `ctx.credentials`, so an existing
`DEEPSEEK_API_KEY` in the harness home, either `.env` layer, or the process
environment is picked up unchanged. A missing credential fails the boot.

Fetch the card and submit a task:

```sh
curl -s http://127.0.0.1:9922/.well-known/agent-card.json

curl -s http://127.0.0.1:9922/a2a \
  -H "authorization: Bearer demo123" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{
        "message":{"kind":"message","messageId":"m1","role":"user",
                   "parts":[{"kind":"text","text":"hello"}]}}}'
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `A2A_PEERS` | `alice` | `name[:token]` list; a token is required for each |
| `A2A_PORT` | `9900` | Listening port |
| `A2A_SEND_MODE` | `block` | `block` or `immediate` |
| `A2A_WORKSPACE_ROOT` | temp dir | Parent of the per-peer working directories |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | Model id requested from the adapter |

A one-shot probe runs 48 checks against a live server and exits non-zero on any
mismatch:

```sh
pnpm probe                                        # defaults to :9922 / demo123
node example/probe.mjs http://127.0.0.1:9922 demo123
```

## Interface

| Route | Method | Auth |
| --- | --- | --- |
| `/.well-known/agent-card.json` | GET | Public by default |
| `/.well-known/agent.json` | GET | Public by default |
| `{basePath}` (default `/a2a`) | POST | Bearer required |

| JSON-RPC method | v1.0 alias | Status |
| --- | --- | --- |
| `message/send` | `SendMessage` | Blocking negotiated per request |
| `message/stream` | `SendStreamingMessage` | SSE |
| `tasks/get` | `GetTask` | Idempotent; answers after settlement |
| `tasks/cancel` | `CancelTask` | Cancels the running turn |
| `tasks/resubscribe` | `SubscribeToTask` | Live stream, or one terminal frame |
| `tasks/pushNotificationConfig/*` | `*TaskPushNotificationConfig` | `-32003` |
| `tasks/list` | `ListTasks` | `-32601` |
| `agent/getAuthenticatedExtendedCard` | `GetExtendedAgentCard` | `-32601` |

Both dialects are accepted. v0.3 (`message/send`, `"working"`, `kind`-tagged
parts) is the mainline; the v1.0 spellings (`SendMessage`, `TASK_STATE_WORKING`,
member-presence parts) are normalized inbound and rendered back in whichever
dialect the request used.

Inbound messages may carry text, file, and data parts. File and data parts are
rendered into the model's context as bracketed references. Replies are text.

Authentication, rate limiting, and the trust gate answer with HTTP `401`, `429`,
and `403`; the body remains a valid JSON-RPC error envelope. A task belonging to
another peer answers exactly as an absent one.

## Configuration

```yaml
- id: a2a-server
  name: dsh-a2a-server
  config:
    basePath: /a2a
    publicUrl: https://agents.example.com/a2a   # advertised on the card
    protocolVersion: 0.3.0
    provider: deepseek-official
    model: deepseek-v4-flash

    card:
      name: dsh-harness
      description: Reads code, runs commands, reports findings.
      public: true
      skills:
        - id: general
          name: general
          description: General-purpose task execution.
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

| Key | Default | Meaning |
| --- | --- | --- |
| `basePath` | `/a2a` | JSON-RPC route |
| `publicUrl` | derived from `Host` | Routable URL published on the card |
| `protocolVersion` | `0.3.0` | Version advertised on the card |
| `provider` · `model` | — | Model route for every agent this server creates |
| `card.public` | `true` | Serve the card without a credential |
| `card.skills` | `[]` | Declared skills; falls back to one `general` entry |
| `peers` | `{}` | Identity → credential **reference name** |
| `trustedPeers` | all authenticated | Allow-list of identities that may run tasks |
| `rateLimitPerMinute` | `60` | Sliding window per identity |
| `maxContextTurns` | `5` | Messages accepted per context before `rejected` |
| `sendMode` | `block` | Default when the client states no preference |
| `blockTimeoutMs` | `60000` | After which a blocking request is declined |
| `contextIdleTtlMs` | `1800000` | Idle time before a context's agent is released |
| `maxResidentContexts` | `64` | Ceiling on resident contexts |
| `isolation.workspaceMode` | `per-peer` | `per-peer` or `shared` |
| `isolation.workspaceRoot` | — | Required; parent directory or shared cwd |
| `isolation.peerWorkspaces` | `{}` | Per-identity working-directory override |
| `push.enabled` | `false` | Reserved; see [Boundaries](#boundaries) |

Configuration is refused at load when `isolation.workspaceRoot` is absent, a peer
name is not `[A-Za-z0-9][A-Za-z0-9_-]*`, a `tokenEnv` is not a POSIX identifier,
`trustedPeers` or `peerWorkspaces` names an undeclared peer, or `basePath` does
not start with `/`.

### Credentials

Configuration carries credential **references**, never values:

```yaml
peers:
  alice: { tokenEnv: A2A_PEER_ALICE }
```

```yaml
# ~/.dsh/.credentials.yaml
A2A_PEER_ALICE: <32-byte-hex-from-openssl-rand>
```

`ctx.credentials` resolves the reference per request across four layers — the
process environment, the managed document, `<cwd>/.env`, and `$DSH_HOME/.env` —
so rotating a token takes effect on the next request without a restart. Peer
identity comes from the presented credential only; nothing in a request body can
assert it. There is no shared bearer token: isolation is built on distinct
identities.

## Isolation

| Layer | Guarantee | Mechanism |
| --- | --- | --- |
| Model context | One peer's conversation cannot enter another's model request | Separate `contextId` → separate Session → separate log |
| Protocol access | A peer cannot read, continue, or cancel another's context or task | Ownership by authenticated identity |
| Tooling | A peer's agent cannot use tools to read another peer's session | `workspaceMode: per-peer` |

`per-peer` (the default) derives each identity's `cwd` from `workspaceRoot`.
`shared` places every peer in one directory, which suits peers collaborating on a
single repository; under it, files written by one peer are readable by another.

## Boundaries

- Inbound only. No outbound client, peer directory, or A2A subagent provider.
- JSONRPC binding only. gRPC and HTTP+JSON are not served, and the card says so.
- Push notifications are not implemented. `push.enabled` selects which error the
  push methods return; the card advertises `pushNotifications: false`.
- No extended Agent Card, `stateTransitionHistory`, protocol extensions, or card
  signatures.
- Streaming emits committed assistant messages. Per-chunk streaming is not
  implemented.
- No orphan-task watchdog: a task wedged non-terminal stays that way.
- Cross-session tool denial is not implemented; isolation rests on
  `workspaceMode`.
- A token ceiling settles a task as `completed`; the real turn ending travels in
  `Task.metadata.dsh.stopReason`, which A2A's state enum cannot express.
- Task state survives settlement but not a process restart: session persistence
  is not composed, so the projection has no log to cold-fold after a reboot.
- `ctx.webServer` provides no TLS. Any non-loopback exposure belongs behind a
  reverse proxy.
- A configuration change restarts the plugin and cancels in-flight tasks.

## Architecture

```
src/
├── protocol/          dependency-free library: no Cordis, no HTTP, no harness
│   ├── wire.ts        the A2A vocabulary, normalized to v0.3 spelling
│   ├── normalize.ts   v0.3 <-> v1.0 dialect translation, both directions
│   ├── jsonrpc.ts     framing and the A2A error codes
│   ├── card.ts        Agent Card construction
│   └── sse.ts         SSE frame encoding
├── index.ts           the Cordis plugin: wiring, agent ownership, teardown
├── router.ts          HTTP + JSON-RPC dispatch, free of Cordis so it unit-tests
├── contexts.ts        contextId -> Activation registry and residency policy
├── tasks.ts           task slots and the three-stage turn correlation
├── projection.ts      the a2aTask fold over the session log
├── security.ts        authentication, rate limiting, defanging, redaction
├── config.ts          schema plus the cross-field checks that fail at load
└── types.ts           declaration merges into SessionEventMap / MessageSourceMap
```

**A task is an interval, not a turn.** One submitted message may span several
turns if tools queue more work, so settlement uses three hooks:
`agent/inbox/claimed` binds the message to a turn, `turn/end` records that turn's
ending, and `agent.whenIdle()` settles once the whole agent is quiet.

**Task state lives in the session log.** Lifecycle transitions are `a2a/task`
events; a projection unit folds them into the read model. The terminal edge
carries the committed output, so the fold serves the answer without reaching
back into message history.

**Residency is explicit.** HTTP has no connection lifetime, so each `contextId`
maps to an Activation evicted when idle, leaving the durable Session behind.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test       # 129 tests across 9 files
pnpm serve      # a listening server
pnpm probe      # 48 checks against a running server
pnpm build      # emit lib/
```

The end-to-end suites boot a real Cordis composition with a real agent loop and
drive it over HTTP, using a deterministic stub adapter so assertions do not
depend on model output.

## Relationship to the official project

Built against [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

The official project supplies the agent runtime, the plugin system, and the
capability seams this plugin consumes. This project supplies:

- The A2A v0.3.0 JSON-RPC binding, served inbound
- Agent Card construction and dialect normalization
- Mapping between A2A tasks and harness turns
- Per-peer authentication, isolation, and workspace policy

The harness is pre-release and does not promise compatibility across renames or
repackaging, so peer dependencies are pinned exactly to `0.1.0-rc.6`.

## Community

Scan to join the WeChat group **A2A 产品应用和探索** — discussion of A2A in
practice, this plugin included.

<p align="center">
  <img src="https://raw.githubusercontent.com/huangjuhua-aigc/dsh-a2a/main/assets/community-wechat.jpg" alt="WeChat group QR code" width="280">
</p>

If the code has expired, open an issue and we will refresh it.

## License

MIT
