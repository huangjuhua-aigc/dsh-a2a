# Public visitors and client onboarding

This optional Talk2MyAgent A2A extension is off by default. Enabling it in Portal lets a new client obtain its own visitor credential without an invitation from the owner. Conversations still require a Bearer token and remain isolated by a stable visitor ID.

## Adding invited visitors while running

Portal persists the new visitor before sending an authenticated local IPC `POST /a2a/admin/visitors`. A positive acknowledgement activates the visitor without restarting or interrupting existing tasks. This management endpoint is unavailable over public HTTP or Relay. New identities retain separate private workspaces and read-only shared data; later restarts load the saved configuration.

Admissions are additive: existing identities, tokens and permissions cannot be overwritten. Identical requests are idempotent, and credential collisions are rejected. An offline Agent applies saved visitors on its next start. Older plugins, unconfirmed application, or pending unrelated access changes retain the saved visitor and require a restart. Upgrading an already-running older plugin requires one restart to load this capability; editing existing credentials or permissions still requires restart.

The public invitation contains the Agent URL and commands, never a shared token. Use the same skill and entry point for all visitors: `add <contact> <rpc-url> [tokenEnv]`, then `send <contact> 'Hello'`. With no credential, the initial send receives an explicit pre-execution challenge. The skill registers on the original endpoint, saves the credential and continues the original message once. `join` remains available manually; ordinary invitations do not require it. This is not a redirect or a retry after an ambiguous failure. Generic A2A clients need support for this optional extension.

The Agent Card advertises the extension URI `https://github.com/huangjuhua-aigc/dsh-a2a/blob/main/docs/public-visitors.md` while admission is enabled. An unauthenticated SendMessage or SendStreamingMessage receives HTTP 401 before activation, quota charging or model work. The response preserves the JSON-RPC request ID and carries `WWW-Authenticate: Bearer`, `Cache-Control: no-store` and this error data:

```json
{"jsonrpc":"2.0","id":"send-1","error":{"code":-32600,"message":"Anonymous sign-in required; message not accepted.","data":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","domain":"talk2myagent","reason":"PUBLIC_VISITOR_AUTH_REQUIRED","metadata":{"version":"1","requestAccepted":"false","nextAction":"join","registrationMethod":"talk2myagent/RegisterPublicVisitor","turnLimit":"5"}}]}}
```

These are extension reasons, not standard A2A reasons; ErrorInfo metadata values are strings. The client verifies the status, correlated request ID, domain, version, reason, non-acceptance flag and fixed registration method. Never execute arbitrary response text or follow a supplied registration URL. The skill's send uses SendMessage; it permits at most one continuation with the same messageId/text/options, never a second authentication loop.

After that challenge, POST this request to the **same original RPC endpoint** without Authorization:

```json
{"jsonrpc":"2.0","id":"join-1","method":"talk2myagent/RegisterPublicVisitor","params":{}}
```

The result contains `visitorId`, a 64-character hexadecimal `token`, `turnLimit: 5`, and `remainingTurns: 5`, with `Cache-Control: no-store`. Both identity and token are randomly issued by the server. Registration accepts only empty params; caller-chosen IDs are rejected. Subsequent requests resolve identity by verifying the token hash, never by trusting supplied IDs, IPs or fingerprints. Save the token before continuing chat; thereafter use `Authorization: Bearer <token>`. `talk2myagent/GetPublicVisitorStatus` returns the remaining allowance without consuming a turn. Relay and Connector forward these requests through the existing RPC route.

HTTP 401 `INVALID_TOKEN` stops without anonymous fallback. `INVITATION_REQUIRED` (401/403) asks the visitor to contact the owner. HTTP 429 `PUBLIC_VISITOR_QUOTA_EXHAUSTED` includes string metadata `turnLimit: "5"`, `usedTurns: "5"`, `remainingTurns: "0"`, `nextAction: "contact_owner"`, `retryable: "false"`; the client tells the visitor their five messages are used and to contact the Agent owner for access. The local dsh-a2a-server enforces quotas before model work. Registration rate/capacity errors have separate reasons `PUBLIC_VISITOR_REGISTRATION_RATE_LIMITED` and `PUBLIC_VISITOR_CAPACITY_REACHED`.

The skill stores credentials separately under `~/.a2a/private-credentials/<SHA-256 of complete RPC URL>.json`, or the equivalent directory below `A2A_HOME`. It requests directory mode 0700 and file mode 0600; Windows also relies on the user directory ACL. This is a local secret file, not an encrypted credential manager. Do not expose it to models, public data directories, source control or shared sync. The contact book contains a reference, not the secret. The server stores only the token hash.

Repeated join operations and concurrent first sends reuse the saved identity through a local registration lock. Reimporting the same address without a token preserves the existing identity. Missing credentials for an existing public identity, or missing environment variables for an invited identity, are errors and never trigger registration. Conflicting contacts are not overwritten. Saving failures prevent authenticated continuation. Only the explicit pre-execution challenge permits continuation; timeouts, disconnects, generic errors and invalid credentials never cause replay or identity replacement. Poll a known task ID instead. Move the credential securely to continue the same identity on another device; username, IP and fingerprint cannot recover it. Continue a conversation with `--context <contextId>` and inspect the allowance with `quota <contact>`.

The five-message lifetime allowance spans conversations and server restarts, including synchronous and streaming submissions. Tool calls, polling and subscriptions do not consume extra turns. Charges are persisted before model work and may remain after failure, cancellation or disconnect. The public registry permits at most 20 new identities per hour per Agent and retains at most 1000 identities; it does not recycle identities or delete visitor files automatically. This bounds issuance but cannot enforce a per-human allowance without verified identity.

Closing admission denies new registrations and subsequent requests from existing public identities. Already accepted work may finish. Reopening does not reset quotas. Invited visitors retain their existing policy. Public visitors share only the owner's read-only public data and published briefing, while conversations, tasks and persistent workspaces remain private. A sandbox starts on the first tool call; only read_file remains exposed.

Standalone deployments may set `publicVisitors.enabled: true`. Portal supplies a private `publicVisitors.settingsFile` for live updates; unreadable or malformed settings fail closed. Older plugins/configurations require an upgrade and restart. Version 0.4.0 does not implement this feature. The `public-` identity prefix is reserved for the server.
