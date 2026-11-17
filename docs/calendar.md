# Local calendar booking

Authorize one Google Calendar or Feishu account in the local Portal. Tokens and application credentials are encrypted on the owner's computer. The Agent directly calls provider APIs, including refresh, with no separate calendar service and no Relay changes. See the [Portal guide](https://github.com/huangjuhua-aigc/Talk2MyAgent/blob/main/docs/calendar.en.md) / [中文说明](https://github.com/huangjuhua-aigc/Talk2MyAgent/blob/main/docs/calendar.md).

```yaml
calendar:
  connectionFile: /private/owner/calendar/agent.connection.json
  instructions: Use Asia/Shanghai, weekday afternoons only.
  mode: auto
```

Portal generates this after authorization. The v2 file contains encrypted credentials; its entire directory must be outside public data and every visitor workspace. Windows uses DPAPI for the local master key; Unix uses owner-only directory/key permissions. Do not copy tokens into prompts or shared data. Reauthorize after changing machines. Old v1 cloud capability files require reconnection.

The Agent loads the bundled `meeting-booking` skill and `calendar_find_slots`, `calendar_prepare_booking`, `calendar_confirm_booking`, `calendar_booking_status` tools at startup. Connecting/replacing a calendar requires an Agent restart to load that connection. Disconnect rejects later calls immediately, including existing conversations. Closing Portal does not affect authorization already saved locally. An in-flight write can finish before disconnect returns.

Visitor identity is captured by the backend, never model supplied. Tools reveal available slots and that visitor's booking, not other event details. Google checks the user's primary calendar; Feishu checks user free/busy and creates in the primary calendar. File/shell permissions are unchanged.

## Visitor permission boundary

The visitor-side model has only four calendar operations: find available slots, prepare a proposal, confirm that proposal, and check that visitor's booking. There is no event listing, arbitrary event lookup, cancellation, deletion, update or mailbox tool. Host-installed calendar, HTTP, command and email tools are masked and refused by the runtime guard, even if the model attempts to call them. The server binds booking ownership to authenticated identity; supplying another visitor ID or event ID in arguments grants no access.

Availability results contain time slots, not meeting titles, descriptions, locations or attendees. Reconciliation currently reads a bounded event list inside trusted backend code and returns only the matched ID; the model receives the original visitor's proposal details and status, never that provider list or later owner-added notes. The title of the visitor's own proposal is visible to that visitor.

OAuth grants to the local backend are separate from visitor permissions. Current Feishu scopes cover calendar reading and event creation, with no deletion or mailbox scope. Google's `calendar.events` grant is broader and permits event changes; see [Google's scope definitions](https://developers.google.com/workspace/calendar/api/auth). The visitor does not receive these credentials or a generic API proxy. Removing operations from a skill prompt alone would not provide this boundary; the scoped tools, output filtering, runtime guard and ownership checks enforce it.

Privacy regression tests inject private titles and notes into provider responses and verify that they never enter visitor tool results or model input. They also mount forbidden tools on the host and verify that none executes, that forged ownership cannot access another booking, and that rejected actions make no provider request. These tests use synthetic calendar data and do not modify the owner's real calendar.

Proposals expire after 15 minutes. Visitor confirmation is required before creation. The encrypted local ledger serializes all Agent processes sharing the same calendar directory and persists intent before writing. Timeout becomes `uncertain`; query the original ID, never automatically create a replacement. Google uses deterministic event IDs; Feishu idempotency keys. Other devices and calendar clients remain outside this lock.

Only automatic booking is implemented. No owner approval, IM push, email invitation, video meeting, cancellation or rescheduling. Owner prose guides the model and is not a hard scheduling policy engine.

## Google client configuration

Google requires a Desktop OAuth client belonging to the open-source user. The Portal's Google Connect button opens setup instructions and a JSON file importer when no client is configured. Users enable Calendar API, configure consent and download their Desktop client JSON from Google Cloud, then import and authorize. The configuration is encrypted per Agent in local `calendar.sqlite`, survives restart/disconnect, and can be replaced after disconnect. Deleting an Agent removes its client configuration. Existing `A2A_GOOGLE_CLIENT_ID` / `A2A_GOOGLE_CLIENT_SECRET` are optional fallbacks; imported configuration takes precedence. No shared product ID is required. Google uses loopback/random port and PKCE. Feishu uses the official registration SDK followed by device authorization; no shared confidential AppSecret or public callback server is needed. Enterprise policy can require admin approval. WeCom is removed.

Calendar booking requires `dsh-a2a-server@0.5.0` or later and the matching Portal. Upgrade the plugin in the existing Agent profile and restart the Agent once; local calendar authorization is preserved. For source development only, build this checkout and set Portal `A2A_PLUGIN_SOURCE` to its path.

## Validation

`pnpm test` includes Agent boundary and local calendar tests. `pnpm test:package` checks the packaged library/skill. Set `A2A_RELAY_SOURCE` and `A2A_CONNECTOR_SOURCE` together to enable Relay integration tests.

For the full chain set `A2A_HOST_SOURCE` to Talk2MyAgent, `A2A_PLUGIN_SOURCE` to this repository, and `A2A_RELAY_SOURCE` to the Relay repository, then run:

```sh
node --import tsx scripts/test-calendar-e2e.mjs --real-model
```

The suite exercises real Portal client JSON import/authorization code, Agent, local Relay/Connector and a real DeepSeek model. Provider HTTP endpoints and consent are simulated. It also closes Portal before booking and forces a token refresh. No real calendar is changed; live account approval and event creation still require the owner's client configuration and consent.

Separately, live Feishu and Google accounts were tested on 2026-11-17 through a local Portal, real DeepSeek Agents and A2A visitors: availability, proposal, confirmation, external event lookup, conflict exclusion and visitor isolation passed. The Feishu run found and fixed its omitted empty busy list. The Google run also verified rejection of visitor requests to list other meetings, read mail or delete the test booking. See the [Feishu live test report](test-report-calendar-live.md) and [Google live test report](test-report-google-calendar-live.md) for scope and retained test events. These live runs do not establish public Relay coverage.
