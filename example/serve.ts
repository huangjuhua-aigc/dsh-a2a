/**
 * Run a real A2A server on localhost.
 *
 *   A2A_PEERS="alice:demo123" pnpm serve
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

/**
 * Peer names are arbitrary — the plugin only requires
 * `[A-Za-z0-9][A-Za-z0-9_-]*`, since a name becomes a workspace directory.
 * `alice` is this demo's default, not a protocol fixture.
 *
 * `A2A_PEERS` accepts either form:
 *
 *   A2A_PEERS="alice,bob"            names only; tokens come from the
 *                                    credential reference A2A_PEER_<NAME>
 *   A2A_PEERS="alice:tok1,bob:tok2"  token inline, for a quick demo
 *
 * The inline form writes the value into the process environment, which is the
 * credential seam's top layer — so the plugin still resolves a reference and
 * never receives a raw token in its configuration.
 */
const PEER_SPEC = process.env['A2A_PEERS'] ?? 'alice'

/** Credential reference name for one peer. */
const refFor = (peer: string): string => `A2A_PEER_${peer.toUpperCase().replace(/-/g, '_')}`

const peers: Record<string, string> = {}
for (const entry of PEER_SPEC.split(',')) {
  const [rawName, ...rest] = entry.trim().split(':')
  const peer = (rawName ?? '').trim()
  if (peer.length === 0) continue
  const ref = refFor(peer)
  const inline = rest.join(':').trim()
  if (inline.length > 0) process.env[ref] = inline
  peers[peer] = ref
}

const unconfigured = Object.entries(peers)
  .filter(([, ref]) => (process.env[ref] ?? '').length === 0)
  .map(([peer, ref]) => `${peer} → ${ref}`)

if (Object.keys(peers).length === 0 || unconfigured.length > 0) {
  // Bind safety: with no credential configured there is nobody who could be
  // authenticated, so serving would only ever answer 401.
  if (unconfigured.length > 0) {
    console.error(`No token for: ${unconfigured.join(', ')}\n`)
  } else {
    console.error('A2A_PEERS named no usable peer.\n')
  }
  console.error('  Name the peers and give each a token:\n')
  console.error('    bash:       A2A_PEERS="alice:demo123" pnpm serve')
  console.error('    PowerShell: $env:A2A_PEERS = "alice:demo123"; pnpm serve\n')
  console.error('  Several peers:\n')
  console.error('    A2A_PEERS="alice:tok1,bob:tok2"\n')
  console.error('  Or name them only, and store each token under its reference:\n')
  console.error('    A2A_PEERS="alice,bob"   with A2A_PEER_ALICE / A2A_PEER_BOB set')
  process.exit(1)
}

const workspaceRoot = process.env['A2A_WORKSPACE_ROOT']
  ?? await mkdtemp(join(tmpdir(), 'dsh-a2a-serve-'))

// `immediate` is what exercises the polling path: the peer gets a non-terminal
// task and must come back with GetTask for the result.
const sendMode = process.env['A2A_SEND_MODE'] === 'immediate' ? 'immediate' : 'block'

// Two failures are common enough to be worth explaining rather than dumping:
// a port left bound by an earlier run, and no model credential configured.
const app = await compose({
  port: PORT,
  workspaceRoot,
  peers,
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
  JSON-RPC     ${origin}/a2a   (A2A v1.0)
  Workspaces   ${workspaceRoot}/<peer>
  Peers        ${Object.keys(peers).join(', ')}
  sendMode     ${sendMode}
  model        ${app.model.provider}/${app.model.id}

Try it:

  curl -s ${origin}/.well-known/agent-card.json      (PowerShell: curl.exe)

  curl -s ${origin}/a2a \\
    -H "authorization: Bearer <token>" \\
    -H 'content-type: application/json' \\
    -H 'a2a-version: 1.0' \\
    -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{
          "message":{"messageId":"m1","role":"ROLE_USER",
                     "parts":[{"text":"hello"}]}}}'

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
