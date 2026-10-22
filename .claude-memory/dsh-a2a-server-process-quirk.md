---
name: dsh-a2a-server-process-quirk
description: "pkill does not stop the dsh-a2a demo server; kill by listening port instead, or measurements silently hit the old process"
metadata: 
  node_type: memory
  type: project
  originSessionId: c040d3c1-2741-49e0-8821-7603360cbd18
  modified: 2026-08-22T13:55:51.481Z
---

`pnpm serve` / `npx tsx example/serve.ts` runs the HTTP listener in a **child** process that tsx spawns, so `pkill -f "example/serve.ts"` reports success while the port stays bound. Kill by port instead:

```powershell
Get-NetTCPConnection -LocalPort 9922 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }
```

**Why:** a restart that silently fails is worse than a loud one here — `serve.ts` exits `1` with `EADDRINUSE` while the OLD build keeps answering on that port, so any before/after measurement quietly compares the old code against itself. This produced one wrong conclusion during the A2A v1.0 work before it was caught.

**How to apply:** After stopping the server, assert the port is actually free before starting the next one, and confirm the new process is the one listening (its own log line) before trusting any result from it. When comparing two builds, prefer two different ports over restarting on one. Related: [[upstream-lone-surrogate-defect]]
