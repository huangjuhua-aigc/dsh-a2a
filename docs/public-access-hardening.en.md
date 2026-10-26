# 0.3.0 deployment and migration guide

[English](public-access-hardening.en.md) · [简体中文](public-access-hardening.md)

This guide covers `dsh-a2a-server@0.3.0` with DSH `>=0.2.1-rc.2 <0.3.0`. For a local configuration UI, use the companion [Talk2MyAgent Portal](https://github.com/huangjuhua-aigc/Talk2MyAgent/blob/main/README.en.md). For standalone plugin configuration, see the [README](../README.md).

## Visitor access and owner access

Visitors can chat, receive the public opening briefing and use `read_file` within the owner's selected data directory. The default root is `isolation.workspaceRoot`; `isolation.peerWorkspaces.<peer>` overrides both that peer's working directory and authorized read root. Relative tool paths resolve from the data root, not the automatically created per-peer working directory.

The visitor agent receives a dedicated public system prompt and suppresses optional host runtime context. Only the controlled `read_file` tool is exposed. Inherited write, shell, network and cross-session tools are blocked. Host plugins remain trusted code: do not add custom plugins that forcibly inject private material into public conversations.

The reader provides UTF-8 text and directory listings. `read_file({"path":"."})` lists the data root; `offset` (1-based) and `limit` page through lines or entries. Limits are 2 MiB per file, 32,000 returned characters and 500 lines/entries per call, with at most 1,000 scanned directory entries. Binary files, PDF/Office extraction and OCR are unsupported.

Canonical path checks reject paths outside the authorized root, symlinks, junctions, hard links, Windows alternate data streams and device paths. The plugin's private state directory is excluded even when located beneath the root. The files you select are available to admitted visitors. A working directory or a `read-only` preset alone is not an OS filesystem sandbox; commands and other future tools need their own isolation design.

Owner RPC and monitoring run on authenticated local IPC: a Windows named pipe or a private Unix socket. Public HTTP does not accept the owner token or expose monitoring routes. The local owner can use trusted maintenance tools to generate the public briefing.

Omitting `trustedPeers` admits configured, authenticated visitors. An explicit `trustedPeers: []` denies every visitor. Admitted visitors receive chat and bounded file reading; no additional tools are implied by their trusted status.

## Resource limits and task behavior

| Limit | Default |
| --- | --- |
| Concurrent tasks, global / per peer | 8 / 2 |
| Daily tasks per peer | 200, persisted per UTC day |
| Resident contexts | 64; evict idle contexts first, reject if all are busy |
| Task deadline | 120 seconds |
| Model calls per task | 8 |
| Output tokens per model call | 4,096 |
| Input / task output characters | 32,000 / 64,000 |
| SSE subscriptions / buffer per task | 4 / 256 KiB |
| SSE heartbeat | 15 seconds |
| Result retention / stored contexts / checkpoint size | 24 hours / 256 / 4 MB |

Admission failures return HTTP 429. Concurrent submissions to the same context return 409 to prevent mixed replies. Deadlines cancel the agent; execution continues to occupy its slot until cancellation finishes. Model adapters must respect `AbortSignal`; process supervision is still needed for an adapter that does not stop. These controls bound work rather than exact monetary spend.

Task results survive resident-agent eviction. Within retention, clients can query settled tasks and continue using the same `contextId`. Cold restoration creates a new harness session with preserved history, identity and turn count. Restart marks interrupted tasks failed without rerunning them. A checkpoint write failure fails the task and prevents further work in that context until recovery is addressed.

SSE disconnects release subscriptions and heartbeats. A buffer overflow disconnects the stream; clients can still use `GetTask`. `messageId` is not an idempotency key: proxies must not automatically replay `SendMessage`.

## Upgrade an existing deployment

1. Stop the agent. Update its installed plugin and the companion Portal together. Installing a package does not replace an already running process.
2. Install into the saved profile, replacing `YOUR_PROFILE` below with its actual name. Do not use `--from-default-profile` during an upgrade because it recreates the profile.
3. Save the agent configuration in the updated Portal so its generated patch includes `admin.socketPath`, then restart. Old HTTP owner/monitoring integrations must migrate to local IPC.
4. Check each visitor's permission to chat and read the workspace. A configuration with every visitor disabled now correctly denies all visitors. Your selected workspace remains the readable data directory; it does not need to be converted into briefing text.
5. Keep state private. By default, checkpoints live beneath `~/.dsh-a2a/` and contain conversation text. Use one process per state directory and protect backups and logs as private data.

```sh
dsh plugin --profile YOUR_PROFILE add dsh-a2a-server@0.3.0
```

For HTTPS deployment, advertise the full external URL, keep the backend on loopback, and forward only `/a2a` and `/.well-known/agent-card.json`. The Portal appends `/a2a` and uses loopback binding for full HTTPS domain URLs. Preserve backend path suffixes when configuring a proxy. Verify the card URL, visitor authentication, permitted file reads, briefing and owner monitoring after restart.

The existing Unicode guard for malformed upstream streaming replies remains in place; this release does not claim to fix the upstream decoder.

## Access from another network with Tailscale

Install and connect Tailscale on both the agent host and the device that sends A2A requests. Use the same tailnet or share the host with the intended visitor. A remote cloud agent also needs Tailscale on its actual execution machine. The visitor needs both network access and their own A2A token.

Start the agent on `127.0.0.1:3080` and confirm its local Agent Card works. On the host, inspect existing Serve rules before adding these two paths:

```sh
tailscale serve status
tailscale serve --bg --https=443 --set-path=/a2a http://127.0.0.1:3080/a2a
tailscale serve --bg --https=443 --set-path=/.well-known/agent-card.json http://127.0.0.1:3080/.well-known/agent-card.json
tailscale serve status
```

Keep both backend URL suffixes. If port 443 is already used, choose an unused HTTPS port such as 8443, update every command and include that port in the external URL. Do not reset or overwrite unrelated Serve rules. Follow the CLI's first-use HTTPS setup prompts. See the [official Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

Copy the actual HTTPS hostname from `status` into Portal → Edit configuration → Network → Custom address. Keep the local port at 3080. Save, stop and start the agent. Access policies must allow the visitor to reach the host's HTTPS port. Do not expose the Portal port 17890 or forward the whole DSH Web listener.

From a visitor device on another network, such as a phone hotspot, fetch `https://YOUR-HOST.ts.net/.well-known/agent-card.json`. Its `supportedInterfaces` must advertise the external HTTPS `/a2a` address. Then send an authenticated A2A message and request a known file inside the selected directory. Opening `/a2a` in a browser does not provide a chat UI.

Tailscale Serve is available to authorized Tailscale devices; it does not make the agent available to arbitrary internet visitors. Funnel is a separate public publishing feature. See the [English Portal setup and visitor CLI instructions](https://github.com/huangjuhua-aigc/Talk2MyAgent/blob/main/README.en.md#access-from-another-network-with-tailscale) and [Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve).

## Automatic public briefing

Agents created by the current Portal have automatic briefing enabled by default. The maintenance instruction summarizes relevant local project memories, then writes the completed public briefing directly to `<workspace>/.hop/handoff.md`. There is no draft approval step. Portal displays the content, modification time and one persistent on/off switch, without a briefing task list.

- Updates run on first activation and then hourly while the agent is online.
- Disabling stops future runs, preserves the current file and lets active work finish.
- Closing Portal does not stop an online agent's updates. After downtime, it performs one overdue update rather than replaying every missed interval.
- Settings and scheduling time persist across restart to prevent immediate duplicate work.
- New visitor conversations receive the current formal briefing. Existing conversations do not automatically reload it.
- The maintenance prompt asks the model to preserve the old briefing when there is nothing new or generation fails; content quality depends on the configured model.

Legacy Portal briefing tasks are cleaned up only when they match the known workspace and maintenance prompt. Existing `handoff.draft.md` files are not automatically published.

Standalone plugin installations need `briefing.prompt`, an absolute `briefing.settingsFile` and owner administration configured. Merely installing the package does not inspect local memories or start automatic briefing work.

## Validation and remaining deployment checks

The 0.3.0 implementation passed 217 plugin tests across 15 files, TypeScript checks, build and a declared-runtime import check. Companion coverage includes API/CLI and browser UI tests. Tests exercise real temporary filesystem reads and local protocol/IPC paths with deterministic model adapters.

Coverage includes root restrictions, link/path rejection, tool denial, public-context isolation, owner-token rejection over HTTP, empty allow-lists, quotas, deadlines, SSE cleanup, durable recovery and automatic briefing behavior. Detailed historical results are in the [test report (Chinese)](test-report-2026-10-26.md).

Real paid-model output, production presets, Linux socket permissions and a two-device cross-network deployment still need verification in the deployment environment. Documentation work does not restart existing services, change credentials or configure a live tunnel.
