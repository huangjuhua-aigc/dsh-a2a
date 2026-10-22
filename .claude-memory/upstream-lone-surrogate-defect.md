---
name: upstream-lone-surrogate-defect
description: "DSH's model streaming path intermittently emits lone surrogates in non-ASCII replies; dsh-a2a guards against it at the outbound boundary"
metadata: 
  node_type: memory
  type: project
  originSessionId: c040d3c1-2741-49e0-8821-7603360cbd18
  modified: 2026-08-22T13:55:34.226Z
---

The DeepSeek Harness model streaming path (`@deepseek-ai/dsh-llm-deepseek` side, pinned at `0.1.0-rc.6`) decodes SSE bytes without a chunk-safe decoder, so a multi-byte character split across a chunk boundary leaves its orphan bytes behind as lone surrogates. A split `议` (U+8BAE = `E8 AE AE`) leaves `\uDCAE`. Only non-ASCII replies show it — Chinese, Japanese, emoji — and it is **invisible in a terminal**, so eyeballing output is not a valid check. Detect by scanning code points for the `0xD800–0xDFFF` range.

Measured 2026-08-22: three live replies carried 13, 10 and 12 lone surrogates, and the same three questions against the pre-v1.0 code carried them too — so it predates the A2A v1.0 upgrade and is not caused by this plugin. It is **intermittent**: six later samples, including one 1595-character reply, showed none at all.

`wellFormed()` in [src/security.ts](src/security.ts) replaces them with U+FFFD, composed into `redactOutbound()` so the single outbound text path cannot pick up only half of what "safe to send" means. It is documented as removable once the upstream decoder is chunk-safe.

**Why:** `JSON.stringify` emits `"\udcae"`, which is legal JSON syntax but decodes to a string a peer cannot re-encode — Python's `json.loads` accepts it and the result raises on `.encode('utf-8')`. A transport must not ship that regardless of who produced it.

**How to apply:** Do not "fix" a reported mojibake bug inside this plugin's serialization — it round-trips correctly; check the upstream decoder first. Before claiming any encoding fix is verified live, confirm the defect actually reproduces in that session; it often does not. When the harness dependency is bumped, re-test with a long non-ASCII generation and drop `wellFormed()` if upstream is clean. Related: [[dsh-a2a-server-process-quirk]]
