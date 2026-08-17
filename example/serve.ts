/**
 * Run a real A2A server on localhost.
 *
 *   A2A_PEER_ALICE=$(openssl rand -hex 16) pnpm serve
 *
 * Always runs a real model: a missing DEEPSEEK_API_KEY is an error, not a
 * silent fall back to a stub that would answer nothing useful. The stub exists
 * only for the test suite, which needs deterministic replies.
 *
 * @module dsh-a2a/example/serve
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { compose, MissingModelCredentialError } from './compose.ts'

const PORT = Number(process.env['A2A_PORT'] ?? 9900)

/** Where the harness keeps its config, for the credential diagnostic. */
const dshHome = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')

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

// Two failures are common enough to be worth explaining rather than dumping:
// a port left bound by an earlier run, and no model credential configured.
const app = await compose({
  port: PORT,
  workspaceRoot,
  peers: { alice: 'A2A_PEER_ALICE' },
  sendMode,
}).catch((error: unknown) => {
  if (error instanceof MissingModelCredentialError) {
    console.error(`No credential configured for ${error.ref}.\n`)
    console.error('  The harness resolves it from, in precedence order:\n')
    console.error('    1. the process environment')
    console.error(`    2. ${join(dshHome, '.credentials.yaml')}     <- the writable one`)
    console.error('    3. <invocation cwd>/.env')
    console.error(`    4. ${join(dshHome, '.env')}\n`)
    console.error('  Store it in the managed document:\n')
    console.error(`    ${error.ref}: sk-...\n`)
    console.error('  Or pass it for one run:\n')
    console.error(`    bash:       ${error.ref}=sk-... pnpm serve`)
    console.error(`    PowerShell: $env:${error.ref} = "sk-..."; pnpm serve`)
    process.exit(1)
  }
  if ((error as { code?: string })?.code === 'EADDRINUSE'
    || String(error).includes('EADDRINUSE')) {
    console.error(`Port ${PORT} is already in use — most likely an earlier run of this server.\n`)
    console.error('  Pick another port:')
    console.error('    bash:       A2A_PORT=9923 pnpm serve')
    console.error('    PowerShell: $env:A2A_PORT = "9923"; pnpm serve\n')
    console.error('  Or stop the old one:')
    console.error('    bash:       pkill -f example/serve.ts')
    console.error('    PowerShell: Get-Process node | Stop-Process')
    process.exit(1)
  }
  throw error
})

const origin = `http://127.0.0.1:${app.port}`
console.log(`
dsh-a2a listening on ${origin}

  Agent Card   ${origin}/.well-known/agent-card.json
  JSON-RPC     ${origin}/a2a
  Workspaces   ${workspaceRoot}/<peer>
  sendMode     ${sendMode}
  model        ${app.model.provider}/${app.model.id}

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
