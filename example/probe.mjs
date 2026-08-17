/**
 * Probe a running A2A server and report what it actually answers.
 *
 * Runs identically in bash and PowerShell — it is plain Node, so no shell
 * quoting rules apply to the JSON payloads.
 *
 *   node example/probe.mjs [url] [token]
 *   node example/probe.mjs http://127.0.0.1:9922 demo123
 *
 * Exits non-zero if anything answered differently than documented, so it works
 * as a smoke check against a real deployment, not only the demo.
 */

const origin = (process.argv[2] ?? process.env.A2A_ORIGIN ?? 'http://127.0.0.1:9922').replace(/\/$/, '')
const token = process.argv[3] ?? process.env.A2A_PEER_ALICE ?? 'demo123'

const rpcUrl = `${origin}/a2a`
const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }

let passed = 0
let failed = 0

/** Print one checked result. */
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  [32mok[0m   ${label}${detail === undefined ? '' : `  [90m${detail}[0m`}`)
  } else {
    failed += 1
    console.log(`  [31mFAIL[0m ${label}${detail === undefined ? '' : `  ${detail}`}`)
  }
}

/** POST one JSON-RPC request. */
async function rpc(body, extraHeaders = {}) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : {} }
}

/** Build a message/send or message/stream request. */
function send(id, text, { method = 'message/send', contextId } = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      message: {
        kind: 'message',
        messageId: `probe-${id}`,
        role: 'user',
        parts: [{ kind: 'text', text }],
        ...contextId === undefined ? {} : { contextId },
      },
    },
  }
}

/** Read an SSE response into decoded JSON-RPC envelopes. */
async function stream(body) {
  const response = await fetch(rpcUrl, { method: 'POST', headers, body: JSON.stringify(body) })
  const frames = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value !== undefined) buffer += decoder.decode(value, { stream: true })
    let at = buffer.indexOf('\n\n')
    while (at !== -1) {
      const line = buffer.slice(0, at).split('\n').find(part => part.startsWith('data: '))
      buffer = buffer.slice(at + 2)
      if (line !== undefined) frames.push(JSON.parse(line.slice(6)))
      at = buffer.indexOf('\n\n')
    }
    if (done) break
  }
  return { contentType: response.headers.get('content-type'), frames }
}

console.log(`\nProbing ${origin}\n`)

// ── Discovery ────────────────────────────────────────────────────────────
console.log('Discovery')
const cardResponse = await fetch(`${origin}/.well-known/agent-card.json`)
const card = await cardResponse.json()
check('agent card served anonymously', cardResponse.status === 200)
check('protocolVersion', card.protocolVersion === '0.3.0', card.protocolVersion)
check('preferredTransport JSONRPC', card.preferredTransport === 'JSONRPC')
check('supportedInterfaces present (v1.0 readers)', Array.isArray(card.supportedInterfaces))
check('declares the bearer scheme', card.securitySchemes?.bearer?.scheme === 'bearer')
check('streaming advertised', card.capabilities?.streaming === true)
check('pushNotifications honestly false', card.capabilities?.pushNotifications === false)
check('legacy agent.json also answers',
  (await fetch(`${origin}/.well-known/agent.json`)).status === 200)

// ── Authentication ───────────────────────────────────────────────────────
console.log('\nAuthentication')
const noAuth = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(send(1, 'hi')),
})
check('no credential rejected 401', noAuth.status === 401)
check('401 body is still a JSON-RPC envelope', (await noAuth.json()).jsonrpc === '2.0')
const badToken = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
  body: JSON.stringify(send(2, 'hi')),
})
check('unknown token rejected 401', badToken.status === 401)
check('GET on the rpc route rejected 405', (await fetch(rpcUrl)).status === 405)
check('unknown route 404', (await fetch(`${origin}/nope`)).status === 404)

// ── message/send ─────────────────────────────────────────────────────────
console.log('\nmessage/send')
const sent = await rpc(send(10, 'hello probe'))
const task = sent.body.result
check('accepted', sent.status === 200 && sent.body.error === undefined)
check('returns a task', task?.kind === 'task', task?.id)
check('mints a contextId', typeof task?.contextId === 'string')
check('carries the real turn ending in metadata',
  typeof task?.metadata?.dsh?.stopReason === 'string' || task?.status?.state === 'working',
  task?.metadata?.dsh?.stopReason)

// ── tasks/get, including after settlement ────────────────────────────────
console.log('\ntasks/get  (the projection path)')
await new Promise(resolve => setTimeout(resolve, 600))
const polled = await rpc({ jsonrpc: '2.0', id: 11, method: 'tasks/get', params: { taskId: task.id } })
check('answers after the task settled', polled.body.error === undefined,
  polled.body.error?.message)
check('reports a terminal state', ['completed', 'failed', 'canceled', 'rejected']
  .includes(polled.body.result?.status?.state), polled.body.result?.status?.state)
const polledAgain = await rpc({ jsonrpc: '2.0', id: 12, method: 'tasks/get', params: { taskId: task.id } })
check('idempotent across repeated polls',
  polledAgain.body.result?.status?.state === polled.body.result?.status?.state)
const missing = await rpc({ jsonrpc: '2.0', id: 13, method: 'tasks/get', params: { taskId: 'never-existed' } })
check('unknown task is -32001', missing.body.error?.code === -32001)

// ── Context continuation ─────────────────────────────────────────────────
console.log('\nContext continuation')
const second = await rpc(send(20, 'second turn', { contextId: task.contextId }))
check('same contextId accepted', second.body.result?.contextId === task.contextId)
const foreign = await rpc(send(21, 'peek', { contextId: 'made-up-context' }))
check('unknown contextId is -32602', foreign.body.error?.code === -32602)

// ── Streaming ────────────────────────────────────────────────────────────
console.log('\nmessage/stream')
const streamed = await stream(send(30, 'stream me', { method: 'message/stream' }))
check('content-type is text/event-stream', streamed.contentType?.includes('text/event-stream'))
check('opens with a non-final status', streamed.frames[0]?.result?.final === false)
check('delivers an artifact update',
  streamed.frames.some(frame => frame.result?.kind === 'artifact-update'))
check('closes with exactly one final frame',
  streamed.frames.filter(frame => frame.result?.final === true).length === 1)
check('final frame is last', streamed.frames.at(-1)?.result?.final === true)
const streamTaskId = streamed.frames[0]?.result?.taskId
check('every frame correlates to the request id',
  streamed.frames.every(frame => frame.id === 30))

// ── resubscribe ──────────────────────────────────────────────────────────
console.log('\ntasks/resubscribe')
await new Promise(resolve => setTimeout(resolve, 300))
const again = await stream({ jsonrpc: '2.0', id: 31, method: 'tasks/resubscribe', params: { taskId: streamTaskId } })
check('settled task gets one terminal frame', again.frames.length === 1)
check('and it is final', again.frames[0]?.result?.final === true)
const noSuch = await rpc({ jsonrpc: '2.0', id: 32, method: 'tasks/resubscribe', params: { taskId: 'never-existed' } })
check('unknown task is -32001', noSuch.body.error?.code === -32001)

// ── Dialects ─────────────────────────────────────────────────────────────
console.log('\nv1.0 dialect')
const v1 = await rpc({
  jsonrpc: '2.0', id: 40, method: 'SendMessage',
  params: { message: { messageId: 'probe-v1', role: 'ROLE_USER', parts: [{ text: 'v1 dialect' }] } },
})
check('v1.0 method name accepted', v1.body.error === undefined)
check('renders the v1.0 state spelling',
  String(v1.body.result?.status?.state).startsWith('TASK_STATE_'), v1.body.result?.status?.state)
const versioned = await rpc(send(41, 'versioned'), { 'a2a-version': '1.0' })
check('A2A-Version 1.0 accepted', versioned.body.error === undefined)
const badVersion = await rpc(send(42, 'bad'), { 'a2a-version': '9.9' })
check('unsupported A2A-Version is -32602', badVersion.body.error?.code === -32602)

// ── Content types ────────────────────────────────────────────────────────
console.log('\nContent types')
const withFile = await rpc({
  jsonrpc: '2.0', id: 50, method: 'message/send',
  params: {
    message: {
      kind: 'message', messageId: 'probe-file', role: 'user',
      parts: [
        { kind: 'text', text: 'see this' },
        { kind: 'file', file: { name: 'a.txt', mimeType: 'text/plain', uri: 'https://x/a.txt' } },
      ],
    },
  },
})
const fileText = withFile.body.result?.artifacts?.[0]?.parts?.[0]?.text ?? ''
check('file part reaches the model as a reference', fileText.includes('[file name=a.txt'), fileText)
const withData = await rpc({
  jsonrpc: '2.0', id: 51, method: 'message/send',
  params: {
    message: {
      kind: 'message', messageId: 'probe-data', role: 'user',
      parts: [{ kind: 'data', data: { n: 42 } }],
    },
  },
})
check('data part reaches the model as JSON',
  (withData.body.result?.artifacts?.[0]?.parts?.[0]?.text ?? '').includes('[data {"n":42}]'))
const flattened = await rpc({
  jsonrpc: '2.0', id: 52, method: 'message/send',
  params: { message: { messageId: 'probe-flat', role: 'ROLE_USER', parts: [{ text: 'flat part' }] } },
})
check('v1.0 member-presence text part parsed', flattened.body.error === undefined)

// ── Deliberately unsupported ─────────────────────────────────────────────
console.log('\nDeliberately unsupported')
for (const method of ['tasks/list', 'ListTasks', 'agent/getAuthenticatedExtendedCard']) {
  const answer = await rpc({ jsonrpc: '2.0', id: 60, method, params: {} })
  check(`${method} is -32601`, answer.body.error?.code === -32601)
}
for (const method of ['tasks/pushNotificationConfig/set', 'ListTaskPushNotificationConfigs']) {
  const answer = await rpc({ jsonrpc: '2.0', id: 61, method, params: { taskId: 'x' } })
  check(`${method} is -32003`, answer.body.error?.code === -32003)
}

// ── Malformed input ──────────────────────────────────────────────────────
console.log('\nMalformed input')
const badJson = await fetch(rpcUrl, { method: 'POST', headers, body: '{not json' })
check('unparseable body is -32700', (await badJson.json()).error?.code === -32700)
const emptyMessage = await rpc(send(70, '   '))
check('whitespace-only message is -32602', emptyMessage.body.error?.code === -32602)
const noMethod = await rpc({ jsonrpc: '2.0', id: 71, method: 'tasks/teleport', params: {} })
check('unknown method is -32601', noMethod.body.error?.code === -32601)

console.log(`\n${passed} ok, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
