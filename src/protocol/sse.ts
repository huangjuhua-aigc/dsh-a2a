/**
 * Server-Sent Events framing for `SendStreamingMessage` and `SubscribeToTask`.
 *
 * A2A streams JSON-RPC responses, not bare events: each frame carries the same
 * envelope the unary methods return, correlated by the original request id.
 * The payload is always a `StreamResponse` — v1.0 identifies an event by the
 * member it is wrapped in, so a bare event on the wire is unreadable.
 *
 * @module dsh-a2a/protocol/sse
 */

import { jsonRpcResult } from './jsonrpc.ts'
import type { A2AStreamResponse } from './wire.ts'

/**
 * Encode one payload as an SSE `data:` frame.
 *
 * Newlines inside the JSON would terminate the frame early, so the payload is
 * serialized compactly (JSON.stringify emits no raw newlines) and terminated
 * with the blank line SSE requires.
 * @param id - the JSON-RPC id of the request this stream answers.
 * @param payload - the StreamResponse to carry.
 * @returns the wire text of one frame.
 */
export function sseFrame(id: string | number | null, payload: A2AStreamResponse): string {
  return `data: ${JSON.stringify(jsonRpcResult(id, payload))}\n\n`
}
