/**
 * Run a real A2A server on localhost.
 *
 *   A2A_PEER_ALICE=$(openssl rand -hex 16) pnpm serve
 *
 * Uses the stub echo adapter, so it needs no API key: the point is to exercise
 * discovery, authentication, and the task round trip end to end with curl or a
 * real A2A client.
 *
 * @module dsh-a2a/example/serve
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compose } from './compose.ts'

const PORT = Number(process.env['A2A_PORT'] ?? 9900)

const token = process.env['A2A_PEER_ALICE']
if (token === undefined || token.length === 0) {
  // Bind safety: with no credential configured there is nobody who could be
  // authenticated, so serving would only ever answer 401.
  console.error('Set A2A_PEER_ALICE to a token before starting.\n')
  console.error('  bash:       A2A_PEER_ALICE=demo123 pnpm serve')
  console.error('  PowerShell: $env:A2A_PEER_ALICE = "demo123"; pnpm serve')
  process.exit(1)
}

const workspaceRoot = process.env['A2A_WORKSPACE_ROOT']
  ?? await mkdtemp(join(tmpdir(), 'dsh-a2a-serve-'))

// `immediate` is what exercises the polling path: the peer gets a non-terminal
// task and must come back with tasks/get for the result.
const sendMode = process.env['A2A_SEND_MODE'] === 'immediate' ? 'immediate' : 'block'

const app = await compose({
  port: PORT,
  workspaceRoot,
  peers: { alice: 'A2A_PEER_ALICE' },
  sendMode,
})

const origin = `http://127.0.0.1:${app.port}`
console.log(`
dsh-a2a listening on ${origin}

  Agent Card   ${origin}/.well-known/agent-card.json
  JSON-RPC     ${origin}/a2a
  Workspaces   ${workspaceRoot}/<peer>
  sendMode     ${sendMode}

Try it:

  curl -s ${origin}/.well-known/agent-card.json      (PowerShell: curl.exe)

  curl -s ${origin}/a2a \\
    -H "authorization: Bearer $A2A_PEER_ALICE" \\
    -H 'content-type: application/json' \\
    -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{
          "message":{"kind":"message","messageId":"m1","role":"user",
                     "parts":[{"kind":"text","text":"hello"}]}}}'

Ctrl-C to stop.
`)

let stopping = false
const shutdown = (): void => {
  if (stopping) return
  stopping = true
  console.log('\nstopping…')
  void app.stop().then(
    () => { process.exit(0) },
    (error: unknown) => {
      console.error(`teardown failed: ${String(error)}`)
      process.exit(1)
    },
  )
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
