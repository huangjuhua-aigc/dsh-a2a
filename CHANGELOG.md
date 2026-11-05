# Changelog

[English](CHANGELOG.md) · [简体中文](CHANGELOG.zh-CN.md)

## 0.4.1 (2026-11-05)

- Allow Portal to add invited visitors to a running Agent through authenticated local IPC, without interrupting tasks or changing existing identities. Persist first, acknowledge application, retain only token hashes in the live registry, and preserve per-visitor isolation. Older plugins require one restart after upgrading; editing existing credentials still requires restart.
- Add opt-in public visitor admission with unique private credentials, isolated contexts/workspaces and five accepted messages per identity across conversations and restarts. Invited peers keep their existing access.
- Return structured pre-execution authentication challenges and distinct invalid-token, invitation-required and quota-exhausted errors. Clients can register on demand and continue once; the server issues identities, rejects caller-chosen IDs and enforces quotas before model work. Support the Portal's live switch, persist token hashes only, and cap registrations. See the [public visitor/client guide](docs/public-visitors.en.md).

## 0.4.0 (2026-11-04)

- Exclude nested `node_modules` from Microsandbox public projections without following dependency links or changing host projects. Other links, private imports and Docker mounts remain strictly checked.

- Add owner-only local IPC `prepare-stop` to drain tasks and persist guest disks before Portal/CLI terminates the backend. Real-model Relay testing exposed lost recent writes when Windows terminated the process tree without this step.

- Add automatically prepared Microsandbox 0.7.11 execution: one VM per authenticated visitor, read-only public projections and independent persistent private disks.
- Pause after 30 idle seconds and stop after 10 idle minutes; serialize visitor tools, bound resident VMs, preserve files on stop/restart and recover abandoned instances.
- Keep conversations and credentials outside guest mounts. Migrate old private files outside public roots; reject links and unsafe directory layouts. Only read_file remains exposed to visitors.
- Verify native Python mutation boundaries, lifecycle, restart persistence, automatic preparation and Portal startup progress. See [isolation guide](docs/visitor-isolation.en.md).

## 0.3.0

Requires DeepSeek Harness `>=0.2.1-rc.2 <0.3.0` and speaks A2A 1.0 JSON-RPC.

- Restrict visitors to chat and `read_file` within the owner's selected data directory. Block path escapes, links, private plugin state and other tools; separate public prompt context from the owner's runtime context.
- Move owner RPC and monitoring to authenticated local IPC. Public HTTP accepts visitor credentials only. An empty `trustedPeers` list denies all visitors.
- Bound concurrent tasks, daily admission, execution time, model calls, outputs and stream buffers. Prevent concurrent tasks in one context from mixing answers; clean up disconnected SSE subscriptions.
- Persist task results and idle conversation history across eviction and restart within the retention window. Fail interrupted work without replaying it.
- Add the optional Portal-configured automatic briefing loop: default-on hourly updates, a persistent switch, restart-safe timing, and direct publication to `.hop/handoff.md`.
- Declare required runtime packages and verify imports without development dependencies. Preserve the guard against malformed Unicode from upstream streaming decoders.

Validation: 217 tests in 15 files, TypeScript checking, build and declared-runtime package import check. Models are deterministic test adapters; real-model and cross-network deployment verification remain separate.

### Upgrade

Stop the agent, update dsh if needed, then install into the existing profile:

```sh
dsh plugin --profile YOUR_PROFILE add dsh-a2a-server@0.3.0
```

Replace `YOUR_PROFILE` with the saved profile name and restart the agent. Upgrade the companion [Talk2MyAgent Portal](https://github.com/huangjuhua-aigc/Talk2MyAgent) for the private management endpoint and automatic briefing settings. Do not recreate an existing profile with `--from-default-profile` during an upgrade.

Old HTTP owner/monitoring integrations must migrate to local IPC. Review visitor admission and the selected data directory before exposing the service. [Migration details](https://github.com/huangjuhua-aigc/dsh-a2a/blob/main/docs/public-access-hardening.en.md).
