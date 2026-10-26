# Changelog

[English](CHANGELOG.md) · [简体中文](CHANGELOG.zh-CN.md)

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
