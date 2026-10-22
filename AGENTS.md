# 项目说明

<!-- 2026-09-24 从 Claude Code 迁移：历史记忆明细在 .claude-memory/ 目录，索引见下。 -->

## 历史记忆索引（Claude Code 时期）

- [Upstream lone-surrogate defect](.claude-memory/upstream-lone-surrogate-defect.md) — non-ASCII replies arrive corrupted from DSH's streaming decoder; the guard in security.ts is temporary, and the bug is intermittent so "it looks fine" proves nothing
- [Demo server process quirk](.claude-memory/dsh-a2a-server-process-quirk.md) — pkill leaves the port bound, so a failed restart silently measures the old build
