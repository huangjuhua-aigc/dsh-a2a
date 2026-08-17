/**
 * Server-Sent Events framing for `message/stream` and `tasks/resubscribe`.
 *
 * A2A streams JSON-RPC responses, not bare events: each frame carries the same
 * envelope the unary methods return, correlated by the original request id.
 *
 * @module dsh-a2a/protocol/sse
 */

import { jsonRpcResult } from './jsonrpc.ts'

/**
 * Encode one payload as an SSE `data:` frame.
 *
 * Newlines inside the JSON would terminate the frame early, so the payload is
 * serialized compactly (JSON.stringify emits no raw newlines) and terminated
 * with the blank line SSE requires.
 * @param id - the JSON-RPC id of the request this stream answers.
 * @param payload - the already-dialect-rendered event.
 * @returns the wire text of one frame.
 */
export function sseFrame(id: string | number | null, payload: unknown): string {
  return `data: ${JSON.stringify(jsonRpcResult(id, payload))}\n\n`
}
