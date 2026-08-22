/**
 * Probe a running A2A server and report what it actually answers.
 *
 * Every request here is A2A v1.0: PascalCase methods, `id` task references,
 * member-discriminated parts, `TASK_STATE_*` enums, wrapped results.
 *
 * Runs identically in bash and PowerShell — it is plain Node, so no shell
 * quoting rules apply to the JSON payloads.
 *
 *   node example/probe.mjs [url] [token]
 *   node example/probe.mjs http://127.0.0.1:9922 demo123
 *
 * The token is any peer's bearer credential; the peer's NAME does not matter
 * here, only that the token authenticates.
 *
 * Exits non-zero if anything answered differently than documented, so it works
 * as a smoke check against a real deployment, not only the demo.
 */

const origin = (process.argv[2] ?? process.env.A2A_ORIGIN ?? 'http://127.0.0.1:9922').replace(/\/$/, '')
const token = process.argv[3] ?? process.env.A2A_PROBE_TOKEN ?? 'demo123'

const rpcUrl = `${origin}/a2a`
const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  'a2a-version': '1.0',
}

let passed = 0
let failed = 0

/** Print one checked result. */
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  [32mok[0m   ${label}${detail === undefined ? '' : `  [90m${detail}[0m`}`)
  } else {
    failed += 1
    console.log(`  [31mFAIL[0m ${label}${detail === undefined ? '' : `  ${detail}`}`)
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

/** Build a SendMessage or SendStreamingMessage request. */
function send(id, text, { method = 'SendMessage', contextId } = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      message: {
        messageId: `probe-${id}`,
        role: 'ROLE_USER',
        parts: [{ text, mediaType: 'text/plain' }],
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

/**
 * Return a task's committed output text, polling when the send was non-terminal.
 *
 * `sendMode: immediate` hands back a WORKING task with no artifacts, so a probe
 * that read artifacts straight off the send response would report a failure
 * that is really just the deployment's send mode.
 */
async function settledOutput(task) {
  if (task === undefined) return ''
  const fromSend = task.artifacts?.[0]?.parts?.[0]?.text
  if (typeof fromSend === 'string' && fromSend.length > 0) return fromSend
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const polled = await rpc({ jsonrpc: '2.0', id: 900, method: 'GetTask', params: { id: task.id } })
    const text = polled.body.result?.artifacts?.[0]?.parts?.[0]?.text
    if (typeof text === 'string' && text.length > 0) return text
  }
  return ''
}

console.log(`\nProbing ${origin}  (A2A v1.0)\n`)

// Preflight: a refused connection is the overwhelmingly common failure here,
// and an unhandled fetch rejection buries that behind a stack trace.
try {
  await fetch(`${origin}/.well-known/agent-card.json`)
} catch (error) {
  const cause = error?.cause?.code ?? error?.code
  console.error(`Cannot reach ${origin}  (${cause ?? error})\n`)
  if (cause === 'ECONNREFUSED') {
    console.error('  Nothing is listening on that port. Start the server first:\n')
    console.error('    bash:       A2A_PEERS="alice:demo123" A2A_PORT=9922 pnpm serve')
    console.error('    PowerShell: $env:A2A_PEERS="alice:demo123"; $env:A2A_PORT="9922"; pnpm serve\n')
    console.error('  Then probe the port it actually printed:\n')
    console.error('    node example/probe.mjs http://127.0.0.1:9922 demo123')
  }
  process.exit(2)
}

// ── Discovery ────────────────────────────────────────────────────────────
console.log('Discovery')
const cardResponse = await fetch(`${origin}/.well-known/agent-card.json`)
const card = await cardResponse.json()
console.log(`  [90magent: ${card.name} ${card.version}[0m`)
const iface = card.supportedInterfaces?.[0]
check('agent card served anonymously', cardResponse.status === 200)
check('supportedInterfaces is the endpoint declaration', Array.isArray(card.supportedInterfaces))
check('interface protocolVersion 1.0', iface?.protocolVersion === '1.0', iface?.protocolVersion)
check('interface protocolBinding JSONRPC', iface?.protocolBinding === 'JSONRPC')
check('no v0.3 card members remain',
  card.protocolVersion === undefined && card.url === undefined
  && card.preferredTransport === undefined && card.supportsAuthenticatedExtendedCard === undefined)
check('declares the bearer scheme',
  card.securitySchemes?.bearer?.httpAuthSecurityScheme?.scheme === 'Bearer')
check('securityRequirements names it',
  Array.isArray(card.securityRequirements)
  && card.securityRequirements[0]?.schemes?.bearer !== undefined)
check('streaming advertised', card.capabilities?.streaming === true)
check('pushNotifications honestly false', card.capabilities?.pushNotifications === false)
check('legacy well-known path also answers',
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

// ── SendMessage ──────────────────────────────────────────────────────────
console.log('\nSendMessage')
const sent = await rpc(send(10, 'hello probe'))
const task = sent.body.result?.task
check('accepted', sent.status === 200 && sent.body.error === undefined)
check('result is wrapped in a task member', task !== undefined, task?.id)
check('no kind discriminator', task?.kind === undefined)
check('state uses the TASK_STATE_ spelling',
  String(task?.status?.state).startsWith('TASK_STATE_'), task?.status?.state)
check('mints a contextId', typeof task?.contextId === 'string')
check('carries the real turn ending in metadata',
  typeof task?.metadata?.dsh?.stopReason === 'string'
  || task?.status?.state === 'TASK_STATE_WORKING',
  task?.metadata?.dsh?.stopReason)

// ── GetTask, including after settlement ──────────────────────────────────
console.log('\nGetTask  (the projection path)')
await new Promise(resolve => setTimeout(resolve, 600))
const polled = await rpc({ jsonrpc: '2.0', id: 11, method: 'GetTask', params: { id: task.id } })
check('answers after the task settled', polled.body.error === undefined,
  polled.body.error?.message)
check('reports a terminal state', [
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED',
].includes(polled.body.result?.status?.state), polled.body.result?.status?.state)
const polledAgain = await rpc({ jsonrpc: '2.0', id: 12, method: 'GetTask', params: { id: task.id } })
check('idempotent across repeated polls',
  polledAgain.body.result?.status?.state === polled.body.result?.status?.state)
check('carries the agent output, not just the state',
  (polled.body.result?.artifacts?.[0]?.parts?.[0]?.text ?? '').length > 0,
  polled.body.result?.artifacts?.[0]?.parts?.[0]?.text)
const missing = await rpc({ jsonrpc: '2.0', id: 13, method: 'GetTask', params: { id: 'never-existed' } })
check('unknown task is -32001', missing.body.error?.code === -32001)
check('and carries a machine-readable reason',
  missing.body.error?.data?.[0]?.reason === 'TASK_NOT_FOUND',
  missing.body.error?.data?.[0]?.domain)
const v03Params = await rpc({ jsonrpc: '2.0', id: 14, method: 'GetTask', params: { taskId: task.id } })
check('v0.3 taskId parameter refused', v03Params.body.error?.code === -32602)

// ── ListTasks ────────────────────────────────────────────────────────────
console.log('\nListTasks')
const listed = await rpc({ jsonrpc: '2.0', id: 15, method: 'ListTasks', params: {} })
check('answers', listed.body.error === undefined, listed.body.error?.message)
check('returns a task array', Array.isArray(listed.body.result?.tasks),
  `${listed.body.result?.tasks?.length} task(s)`)
check('nextPageToken is always present', typeof listed.body.result?.nextPageToken === 'string')
check('reports totalSize', typeof listed.body.result?.totalSize === 'number')
check('omits artifacts by default',
  (listed.body.result?.tasks ?? []).every(t => t.artifacts === undefined))
const withArtifacts = await rpc({
  jsonrpc: '2.0', id: 16, method: 'ListTasks', params: { includeArtifacts: true },
})
check('includeArtifacts brings them back',
  (withArtifacts.body.result?.tasks ?? []).some(t => Array.isArray(t.artifacts)))
const paged = await rpc({ jsonrpc: '2.0', id: 17, method: 'ListTasks', params: { pageSize: 1 } })
check('honors pageSize', (paged.body.result?.tasks ?? []).length <= 1)
const filtered = await rpc({
  jsonrpc: '2.0', id: 18, method: 'ListTasks',
  params: { contextId: task.contextId, status: 'TASK_STATE_COMPLETED' },
})
check('filters by contextId and status', filtered.body.error === undefined,
  `${filtered.body.result?.tasks?.length} match(es)`)

// ── Context continuation ─────────────────────────────────────────────────
console.log('\nContext continuation')
const second = await rpc(send(20, 'second turn', { contextId: task.contextId }))
check('same contextId accepted', second.body.result?.task?.contextId === task.contextId)
const foreign = await rpc(send(21, 'peek', { contextId: 'made-up-context' }))
check('unknown contextId is -32602', foreign.body.error?.code === -32602)
const toSettled = await rpc({
  jsonrpc: '2.0', id: 22, method: 'SendMessage',
  params: {
    message: {
      messageId: 'probe-settled', role: 'ROLE_USER',
      parts: [{ text: 'continue a finished task' }], taskId: task.id,
    },
  },
})
check('message to a terminal task is -32004', toSettled.body.error?.code === -32004)

// ── Streaming ────────────────────────────────────────────────────────────
console.log('\nSendStreamingMessage')
const streamed = await stream(send(30, 'stream me', { method: 'SendStreamingMessage' }))
check('content-type is text/event-stream', streamed.contentType?.includes('text/event-stream'))
check('opens with the task object', streamed.frames[0]?.result?.task !== undefined)
check('no final flag anywhere',
  streamed.frames.every(frame => frame.result?.statusUpdate?.final === undefined))
check('delivers a wrapped artifact update',
  streamed.frames.some(frame => frame.result?.artifactUpdate !== undefined))
const lastFrame = streamed.frames.at(-1)?.result
check('closes on a terminal statusUpdate',
  lastFrame?.statusUpdate !== undefined
  && [
    'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED',
  ].includes(lastFrame.statusUpdate.status?.state),
  lastFrame?.statusUpdate?.status?.state)
const streamTaskId = streamed.frames[0]?.result?.task?.id
check('every frame correlates to the request id',
  streamed.frames.every(frame => frame.id === 30))

// ── SubscribeToTask ──────────────────────────────────────────────────────
console.log('\nSubscribeToTask')
await new Promise(resolve => setTimeout(resolve, 300))
const settledSubscribe = await rpc({
  jsonrpc: '2.0', id: 31, method: 'SubscribeToTask', params: { id: streamTaskId },
})
check('terminal task is -32004', settledSubscribe.body.error?.code === -32004,
  settledSubscribe.body.error?.message)
const noSuch = await rpc({
  jsonrpc: '2.0', id: 32, method: 'SubscribeToTask', params: { id: 'never-existed' },
})
check('unknown task is -32001', noSuch.body.error?.code === -32001)

// ── Version negotiation ──────────────────────────────────────────────────
console.log('\nVersion negotiation')
const noVersion = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(send(40, 'no version header')),
})
check('absent header is served as 1.0', (await noVersion.json()).error === undefined)
const oldVersion = await rpc(send(41, 'old'), { 'a2a-version': '0.3' })
check('A2A-Version 0.3 is -32009', oldVersion.body.error?.code === -32009,
  oldVersion.body.error?.message)
const badVersion = await rpc(send(42, 'bad'), { 'a2a-version': '9.9' })
check('unsupported A2A-Version is -32009', badVersion.body.error?.code === -32009)
check('and names the reason',
  badVersion.body.error?.data?.[0]?.reason === 'VERSION_NOT_SUPPORTED')

// ── Extended agent card ──────────────────────────────────────────────────
console.log('\nGetExtendedAgentCard')
const extended = await rpc({ jsonrpc: '2.0', id: 45, method: 'GetExtendedAgentCard' })
if (card.capabilities?.extendedAgentCard === true) {
  check('answers when the capability is advertised', extended.body.error === undefined,
    extended.body.error?.message)
  check('reveals at least as many skills as the public card',
    (extended.body.result?.skills ?? []).length >= (card.skills ?? []).length,
    `${extended.body.result?.skills?.length} vs ${card.skills?.length}`)
} else {
  check('unconfigured extended card is -32007', extended.body.error?.code === -32007)
}

// ── Content types ────────────────────────────────────────────────────────
console.log('\nContent types')
// These ask the model a question only answerable from the non-text part, which
// is what actually needs proving: that the part reached the request at all.
// Asserting on the reply's FORMAT would only ever describe the stub.
const withFile = await rpc({
  jsonrpc: '2.0', id: 50, method: 'SendMessage',
  params: {
    message: {
      messageId: 'probe-file', role: 'ROLE_USER',
      parts: [
        { text: 'Reply with only the filename attached to this message. No other words.' },
        { url: 'https://x/a.txt', filename: 'a.txt', mediaType: 'text/plain' },
      ],
    },
  },
})
// In `immediate` mode the send response is non-terminal and carries no
// artifacts yet, so the result must be read back rather than assumed.
const fileText = await settledOutput(withFile.body.result?.task)
check('file part reaches the model', fileText.includes('a.txt'), fileText.slice(0, 80))
const withData = await rpc({
  jsonrpc: '2.0', id: 51, method: 'SendMessage',
  params: {
    message: {
      messageId: 'probe-data', role: 'ROLE_USER',
      parts: [
        { text: 'Reply with only the value of n. Digits only.' },
        { data: { n: 42 }, mediaType: 'application/json' },
      ],
    },
  },
})
const dataText = await settledOutput(withData.body.result?.task)
check('data part reaches the model', dataText.includes('42'), dataText.slice(0, 80))

// ── Retired v0.3 surface ─────────────────────────────────────────────────
console.log('\nRetired v0.3 surface')
for (const method of ['message/send', 'tasks/get', 'tasks/resubscribe']) {
  const answer = await rpc({ jsonrpc: '2.0', id: 60, method, params: {} })
  check(`${method} is -32601`, answer.body.error?.code === -32601)
  check(`${method} names its replacement`,
    /renamed it to [A-Z]/.test(answer.body.error?.message ?? ''), answer.body.error?.message)
}
for (const method of [
  'CreateTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs',
]) {
  const answer = await rpc({ jsonrpc: '2.0', id: 61, method, params: { id: 'x' } })
  check(`${method} is -32003`, answer.body.error?.code === -32003)
}

// ── Malformed input ──────────────────────────────────────────────────────
console.log('\nMalformed input')
const badJson = await fetch(rpcUrl, { method: 'POST', headers, body: '{not json' })
check('unparseable body is -32700', (await badJson.json()).error?.code === -32700)
const emptyMessage = await rpc(send(70, '   '))
check('whitespace-only message is -32602', emptyMessage.body.error?.code === -32602)
const noMethod = await rpc({ jsonrpc: '2.0', id: 71, method: 'Teleport', params: {} })
check('unknown method is -32601', noMethod.body.error?.code === -32601)
const tenanted = await rpc({
  jsonrpc: '2.0', id: 72, method: 'GetTask', params: { id: task.id, tenant: 'other' },
})
check('tenant this interface never declared is -32602', tenanted.body.error?.code === -32602)

console.log(`\n${passed} ok, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
