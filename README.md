# dsh-a2a

Inbound [A2A (Agent2Agent)](https://a2a-protocol.org) protocol server for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Publishes an
Agent Card at a well-known URI and serves the **v0.3.0 JSON-RPC binding**, so any
compliant peer that knows this deployment's URL can discover it and submit tasks
to a harness agent.

**Inbound only.** This plugin never connects to another agent: there is no client,
no peer directory, and no A2A subagent provider. It is a transport adapter, not a
capability seam.

## Install

```sh
dsh plugin --profile web add dsh-a2a          # published package
dsh plugin --profile web add ./path/to/dsh-a2a # local checkout
```

`dsh plugin` forwards to pnpm inside the profile directory and appends this
bundle to `dsh.profile.bundles`, because the package declares `dsh.bundle`.
Then configure the layer (see [Configuration](#configuration)).

### Pick a profile that has an HTTP carrier

The plugin injects `ctx.agents`, `ctx.webServer`, and `ctx.credentials`, and
stays PENDING until all three exist. **`ctx.webServer` ships in `dsh-web-app`,
not in `dsh-base`** — so on a `headless` profile this bundle loads and then sits
there: nothing serves, and nothing errors, because a PENDING fiber is a normal
Cordis state rather than a failure.

| Profile | Result |
|---|---|
| `web` | works |
| `headless` | PENDING — mount `@deepseek-ai/dsh-host-webserver` first |

`dsh --profile <name> --dump-config` prints the composed rows, which is the
quickest way to confirm the carrier is there.

## Try it locally

The demo always runs a real model — `deepseek-official/deepseek-v4-flash`, or
whatever `DEEPSEEK_MODEL` names. A missing credential is an error, not a silent
fall back to a stub that would answer nothing useful.

The credential is resolved through `ctx.credentials`, so it may live in the
process environment, `$DSH_HOME/.credentials.yaml`, or either `.env` layer —
whichever a harness install already uses works here unchanged. The test suite
forces the stub instead: a real model would make assertions about exact reply
text meaningless and would spend tokens on every run.

`A2A_SEND_MODE=immediate` is what exercises the polling path: the peer gets a
non-terminal task and must come back with `tasks/get` for the result.

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

PowerShell has no `VAR=value cmd` prefix — set the variables first. And `curl`
is an alias for `Invoke-WebRequest`, so call `curl.exe` explicitly or use
`Invoke-RestMethod`.

```powershell
pnpm install
$env:A2A_PEER_ALICE = "demo123"
$env:A2A_PORT = "9922"
$env:A2A_SEND_MODE = "immediate"
pnpm serve
```

In a second terminal:

```powershell
curl.exe -s http://127.0.0.1:9922/.well-known/agent-card.json

$h = @{ authorization = "Bearer demo123" }
$body = '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","messageId":"m1","role":"user","parts":[{"kind":"text","text":"hello"}]}}}'
$sent = Invoke-RestMethod -Uri http://127.0.0.1:9922/a2a -Method Post -Headers $h -ContentType 'application/json' -Body $body
$sent.result | ConvertTo-Json -Depth 5

# The task is settled by now and its slot is gone; this answer comes from the
# projection folded over the session log.
$taskId = $sent.result.id
$poll = Invoke-RestMethod -Uri http://127.0.0.1:9922/a2a -Method Post -Headers $h -ContentType 'application/json' `
  -Body "{`"jsonrpc`":`"2.0`",`"id`":2,`"method`":`"tasks/get`",`"params`":{`"taskId`":`"$taskId`"}}"
$poll.result | ConvertTo-Json -Depth 5
```

### One-shot probe

With a server running, sweep every documented behavior and get a pass/fail
checklist. Plain Node, so the JSON payloads dodge both shells' quoting rules:

```sh
pnpm probe                                        # defaults to :9922 / demo123
node example/probe.mjs http://127.0.0.1:9922 demo123
```

It exits non-zero on any mismatch, so it also works as a smoke check against a
real deployment.

## What it serves

| Route | Purpose |
|---|---|
| `GET /.well-known/agent-card.json` | Agent Card (v0.3 canonical path) |
| `GET /.well-known/agent.json` | Same card, pre-0.3 clients |
| `POST /a2a` | JSON-RPC endpoint; SSE methods answer on the same route |

| Method | Status |
|---|---|
| `message/send` | ✅ blocking negotiated per request |
| `message/stream` | ✅ SSE, both dialects |
| `tasks/get` | ✅ idempotent, answers after settlement |
| `tasks/cancel` | ✅ real cancellation, not just a dropped reply |
| `tasks/resubscribe` | ✅ live task, or one terminal frame for a settled one |
| `tasks/pushNotificationConfig/*` | ⛔ not implemented; card advertises `pushNotifications: false` |

Both dialects are accepted: v0.3 (`message/send`, `"working"`, `kind`-tagged
parts) is the mainline, and the v1.0 spellings (`SendMessage`,
`TASK_STATE_WORKING`, member-presence parts) are normalized on the way in and
rendered back in whichever dialect the request used.

## Configuration

```yaml
- id: a2a-server
  name: dsh-a2a
  config:
    basePath: /a2a
    publicUrl: https://agents.example.com/a2a   # behind a reverse proxy
    provider: deepseek-official
    model: deepseek-chat

    card:
      name: dsh-harness
      description: Reads code, runs commands, reports findings.
      public: true            # discovery expects an anonymous read
      skills:                 # DECLARED, never projected from ctx.tools
        - id: general
          name: general
          description: General-purpose task execution.
          tags: [coding, research]

    # tokenEnv is a credential REFERENCE name, not a token. Values live in
    # ~/.dsh/.credentials.yaml or the process environment.
    peers:
      alice: { tokenEnv: A2A_PEER_ALICE }
      bob:   { tokenEnv: A2A_PEER_BOB }
    trustedPeers: [alice]     # omit to allow every authenticated peer
    rateLimitPerMinute: 60
    maxContextTurns: 5

    sendMode: block           # default when the client states no preference
    blockTimeoutMs: 60000     # after which a blocking request is declined
    contextIdleTtlMs: 1800000
    maxResidentContexts: 64

    isolation:
      workspaceMode: per-peer # per-peer (default) | shared
      workspaceRoot: /srv/dsh/a2a   # required, no default
      peerWorkspaces:               # optional per-peer override
        alice: /srv/project

    push:
      enabled: false          # reserved; see Known limitations
```

Every field above is read by the code. Nothing is accepted that is not
enforced — the deny-list, stream granularity, task-timeout and SSRF knobs from
the design are absent until their implementations land, so a deployment cannot
set a security option and believe something honors it.

### Refused at load

- `isolation.workspaceRoot` is required
- peer names must match `[A-Za-z0-9][A-Za-z0-9_-]*` (they become directory names)
- `tokenEnv` must be a POSIX identifier, so a pasted token is rejected
- `trustedPeers` and `peerWorkspaces` may only name declared peers
- `basePath` must start with `/`

### Credentials

Configuration carries **references**; values live with the credential provider:

```yaml
# ~/.dsh/.credentials.yaml
A2A_PEER_ALICE: 9f3c1e7a2b8d4f60a15e93c7d2b48f61
```

The reference must be a POSIX identifier, so pasting a real token into
`tokenEnv` fails at load rather than silently becoming a lookup that never
resolves. Rotation needs no restart: credentials resolve per request.

There is deliberately **no shared bearer token**. Peer isolation is built on
authenticated identity, so two peers sharing one credential would share one
identity and could read each other's contexts.

## Isolation

Three layers, the first two structural:

| Layer | Guarantee | Mechanism |
|---|---|---|
| Model context | Peer A's conversation cannot enter peer B's model request | Separate `contextId` → separate Session → separate log |
| Protocol access | Peer B cannot read, continue, or cancel peer A's context or task | Ownership by authenticated identity; a foreign id answers exactly like an absent one |
| Tooling | Peer A's agent cannot use tools to read peer B's session | `workspaceMode: per-peer` (default) |

`per-peer` gives each identity its own `cwd`. Cross-session tooling authorizes
by exact `cwd` equality, so distinct workspaces isolate peers through the
mechanism that already exists — and cut the filesystem side channel too.

`shared` is the collaborative posture (several machines maintaining one
repository). It must be chosen deliberately: under it, peer A's files are
readable by peer B.

## Security posture

- **No credential ⇒ no service.** An empty `peers` table answers every request 401.
- **No TLS.** `ctx.webServer` provides none; put a reverse proxy in front for any
  non-loopback exposure.
- **Approvals are deterministically rejected.** Nobody watches an A2A-driven
  agent, so the policy is pinned to `never` on the agent's own log rather than
  waiting out a prompt no human will answer.
- **Injection defanging is noise reduction, not a boundary.** The boundary is the
  sandbox scope and the rejected approval.
- **Replies are scrubbed** of credential-shaped strings before leaving.
- **Tool results never reach a peer** — A2A's opaque-execution principle.

## Blocking is negotiated, not fixed

A2A is async-first: `message/send` may answer with a non-terminal task. Whether
it waits is settled per request, in this order:

1. `params.configuration.blocking` — the client's stated preference
2. `sendMode` — the deployment default for a client that states none
3. `blockTimeoutMs` — after which the server declines to keep waiting

Declining means answering with a **non-terminal task, not a failure**: the task
is still running and `tasks/get` will have the result. The spec allows exactly
this — *"The server may reject this if the task is long-running."*

```jsonc
{ "method": "message/send", "params": {
    "message": { "kind": "message", "messageId": "m1", "role": "user",
                 "parts": [{ "kind": "text", "text": "…" }] },
    "configuration": { "blocking": true } } }
```

## Task durability

Task state is folded out of the session log by an `a2aTask` projection unit, so
`tasks/get` keeps answering after a task settles — which is what makes the
polling path usable at all. `message/stream` and push notifications are optional
A2A capabilities; `tasks/get` is the baseline every peer can rely on.

The terminal edge carries the agent's committed output, not just the state — the
projection contract's whole-value rule. Without it a polling peer would receive
`completed` with an empty artifact list, which reads as "it worked and produced
nothing" rather than prompting a retry.

The projection registry (`ctx.sessionProjections`) is an optional dependency. A
composition without it still serves, but logs a warning and cannot answer for a
task once it settles.

Surviving a process restart additionally needs session persistence composed;
that path is not wired yet.

## Known limitations

- Push notifications are not implemented; the card advertises them as absent.
- Only the JSONRPC binding is served (no gRPC, no HTTP+JSON).
- No extended Agent Card, `stateTransitionHistory`, extensions, or card signatures.
- A token ceiling settles a task as `completed`, not a distinct state; the real
  harness turn ending rides in `Task.metadata.dsh.stopReason`.
- Any config change restarts the plugin and cancels in-flight tasks.
- `streamGranularity` is not configurable: streaming emits committed assistant
  messages only. Per-chunk streaming is designed but unbuilt.
- No orphan-task watchdog: a task wedged non-terminal stays that way.
- `push.enabled` only selects which error the push methods return; there is no
  sender, and therefore no SSRF fence to configure.
- Cross-session tool denial is not implemented. Peer isolation rests on
  `workspaceMode: per-peer`, which is enforced.
- Task state survives settlement but not a restart: session persistence is not
  composed yet, so the projection has no log to cold-fold after a reboot.
- `workspaceMode: per-peer` is a poor default for collaborating peers — they must
  set `shared` explicitly or each will see only its own empty directory.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test          # 129 tests: protocol, security, tasks, contexts, projection, end-to-end, SSE, polling
pnpm serve         # a real server on localhost
```

The end-to-end suite boots a real Cordis composition with a real agent loop and
drives it over real HTTP — the same composition `pnpm serve` runs, so what the
tests prove is what you run.

## Compatibility

Built against the `0.1.0-rc.6` line of the harness packages. The harness is
pre-release and explicitly does not promise compatibility across renames or
repackaging, so peer dependencies are pinned exactly: a breaking upstream change
should fail at install rather than at runtime.

## License

MIT
