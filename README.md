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
dsh plugin --profile <name> add dsh-a2a
```

Then configure the layer (see [Configuration](#configuration)). The plugin needs
`ctx.agents`, `ctx.webServer`, and `ctx.credentials`; it stays PENDING until all
three are composed.

## Try it locally

No API key required — the example composition mounts a stub echo adapter.

```sh
pnpm install
A2A_PEER_ALICE=$(openssl rand -hex 16) pnpm serve
```

```sh
curl -s http://127.0.0.1:9900/.well-known/agent-card.json | jq

curl -s http://127.0.0.1:9900/a2a \
  -H "authorization: Bearer $A2A_PEER_ALICE" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{
        "message":{"kind":"message","messageId":"m1","role":"user",
                   "parts":[{"kind":"text","text":"hello"}]}}}' | jq
```

## What it serves

| Route | Purpose |
|---|---|
| `GET /.well-known/agent-card.json` | Agent Card (v0.3 canonical path) |
| `GET /.well-known/agent.json` | Same card, pre-0.3 clients |
| `POST /a2a` | JSON-RPC endpoint; SSE methods answer on the same route |

| Method | Status |
|---|---|
| `message/send` | ✅ blocking or immediate |
| `message/stream` | ✅ SSE, both dialects |
| `tasks/get` | ✅ |
| `tasks/cancel` | ✅ real cancellation, not just a dropped reply |
| `tasks/resubscribe` | ✅ |
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

    sendMode: block           # block | immediate
    blockTimeoutMs: 60000
    contextIdleTtlMs: 1800000
    maxResidentContexts: 64

    isolation:
      workspaceMode: per-peer # per-peer (default) | shared
      workspaceRoot: /srv/dsh/a2a
```

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

## Known limitations

- Push notifications are not implemented; the card advertises them as absent.
- Only the JSONRPC binding is served (no gRPC, no HTTP+JSON).
- No extended Agent Card, `stateTransitionHistory`, extensions, or card signatures.
- A token ceiling settles a task as `completed`, not a distinct state; the real
  harness turn ending rides in `Task.metadata.dsh.stopReason`.
- Any config change restarts the plugin and cancels in-flight tasks.
- `workspaceMode: per-peer` is a poor default for collaborating peers — they must
  set `shared` explicitly or each will see only its own empty directory.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test          # 103 tests: protocol, security, tasks, contexts, end-to-end, SSE
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
