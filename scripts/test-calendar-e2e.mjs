/** Real Portal → owner authorization → Agent → Connector/Relay → booking tools.
 * Only the external calendar APIs are simulated. --real-model also uses the configured DeepSeek model.
 */
import assert from 'node:assert/strict'
import { connectionInfo, disconnect } from '../calendar/index.mjs'
import { withStore, digest } from '../calendar/store.mjs'
import { startProviderFixture } from '../tests/support/calendar-provider.mjs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { compose } from '../example/compose.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

const hostRoot = process.env.A2A_HOST_SOURCE, relayRoot = process.env.A2A_RELAY_SOURCE
if (!hostRoot || !relayRoot) throw new Error('Set A2A_HOST_SOURCE=Talk2MyAgent and A2A_RELAY_SOURCE=a2a-relay-server')
const { startPortal } = await import(pathToFileURL(join(hostRoot, 'packages/a2a-host/tests/support/portal.ts')).href)
const { createRelay } = await import(pathToFileURL(join(relayRoot, 'src/server.mjs')).href)
const { Connector } = await import(pathToFileURL(join(hostRoot, 'packages/a2a-connector/src/connector.mjs')).href)
const real = process.argv.includes('--real-model')
for (const provider of ['google', 'feishu']) {
  const remote = await startProviderFixture()
  process.env.CALENDAR_FIXTURE_ORIGIN = remote.origin
  // Imported once; route each iteration to its own fixture.
  const realFetch = globalThis.fetch
  globalThis.fetch = (url, init) => ['oauth2.googleapis.com', 'www.googleapis.com', 'accounts.feishu.cn', 'open.feishu.cn'].includes(new URL(url).hostname) ? remote.fetch(url, init) : realFetch(url, init)
  const portal = await startPortal(1, { calendarFixture: remote.origin, googleClientId: '' })
  let app, relay, connector
  try {
    const id = portal.agents[0].record.id, headers = { 'content-type': 'application/json', 'x-a2a-csrf': (await (await fetch(`${portal.baseURL}/api/session`)).json()).csrfToken }
    const path = `${portal.baseURL}/api/agents/${id}/calendar`
    if (provider === 'google') assert.equal((await fetch(`${path}/google-client`, { method: 'POST', headers,
      body: JSON.stringify({ document: { installed: { client_id: '1234-e2e.apps.googleusercontent.com', client_secret: 'E2E_CLIENT_SECRET' } } }) })).status, 200)
    const authorization = await (await fetch(`${path}/connect`, { method: 'POST', headers, body: JSON.stringify({ provider }) })).json()
    if (provider === 'google') {
      const url = new URL(authorization.authorizationUrl), callback = new URL(url.searchParams.get('redirect_uri'))
      callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'test' }).toString()
      assert.equal((await fetch(callback)).status, 200)
    } else { remote.approveApp(); remote.approveUser() }
    let authState
    for (let n = 0; n < 100; n++) {
      authState = await (await fetch(`${path}/poll`, { method: 'POST', headers, body: '{}' })).json()
      if (authState.status !== 'pending') break
      await new Promise(r => setTimeout(r, 100))
    }
    assert.equal(authState.status, 'connected')
    process.env.CALENDAR_E2E_TOKEN = 'calendar-e2e-visitor'
    const connectionFile = join(portal.host, 'calendar', `${id}.connection.json`)
    const connection = await connectionInfo(connectionFile)
    app = await compose({ forceStub: !real, workspaceRoot: portal.agents[0].record.config.isolation.workspaceRoot,
      peers: { visitor: 'CALENDAR_E2E_TOKEN' }, maxContextTurns: 12, blockTimeoutMs: 1000,
      overrides: { maxModelCallsPerTask: 12, taskTimeoutMs: 300_000, maxOutputTokens: 1200,
        storage: { directory: join(portal.root, 'agent-state'), retentionMs: 86400000, maxContexts: 32, maxContextBytes: 4000000 },
        calendar: { connectionFile, mode: 'auto', instructions: `This is an authorized isolated integration test. Owner allows meetings at any requested future time. Today is ${new Date().toISOString()}. Use Asia/Shanghai timezone. Use the booking tools, not read_file. Keep every reply under 100 Chinese characters; only report exact tool facts, booking ID and status.` },
        isolation: { workspaceRoot: portal.agents[0].record.config.isolation.workspaceRoot, privateRoot: join(portal.root, 'agent-workspaces'), workspaceMode: 'per-peer', peerWorkspaces: {}, execution: 'read-only' } } })
    app.ctx.on('agent/error', event => console.log('MODEL_ERROR', String(event.error?.message || event.error?.name || 'unknown')))
    await portal.stopServer()
    await withStore(connectionFile, async store => { const c = await store.connection(); c.expiresAt = 0; await store.save(c) })
    const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r))
    const port = socket.address().port; await new Promise(r => socket.close(r))
    const origin = `http://127.0.0.1:${port}`
    relay = createRelay({ origin, allowHttp: true })
    await new Promise(r => relay.server.listen(port, '127.0.0.1', r))
    let status = {}
    connector = new Connector({ config: { relayOrigin: origin, allowHttp: true, localRpcUrl: app.rpcUrl, localCardUrl: app.cardUrl, displayName: 'Calendar E2E' },
      state: { registrations: {}, desiredEnabled: true, revision: 1, operationId: randomUUID() }, save: async () => {}, onStatus: s => { status = s } })
    void connector.start()
    for (let i = 0; i < 100 && status.state !== 'online'; i++) await new Promise(r => setTimeout(r, 100))
    assert.equal(status.state, 'online')
    let command, emitted = false, contextId
    if (!real) app.adapter.stream = async function* (options) {
      if (command && !emitted) {
        emitted = true
        const id = ToolCallId(randomUUID()), args = JSON.stringify(command.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: command.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: command.name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const result = [...options.messages].reverse().find(m => m.role === 'tool')
        const text = result?.content.filter(b => b.type === 'text').map(b => b.text).join('') || 'No tool result'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const rpc = async (method, params) => {
      const response = await fetch(status.publicRpcUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer calendar-e2e-visitor', 'a2a-version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) })
      const result = await response.json()
      assert.equal(result.error, undefined, JSON.stringify(result.error))
      return result.result
    }
    const send = async (text, tool) => {
      command = tool; emitted = false
      let task = (await rpc('SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...(contextId ? { contextId } : {}) } })).task
      contextId = task.contextId
      for (let i = 0; i < 360 && !['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED'].includes(task.status.state); i++) {
        await new Promise(r => setTimeout(r, 1000)); task = await rpc('GetTask', { id: task.id })
      }
      assert.equal(task.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(task))
      const answer = task.artifacts?.flatMap(a => a.parts).map(p => p.text || '').join('') || ''
      console.log(JSON.stringify({ provider, model: real ? 'real' : 'deterministic', answer }))
      return answer
    }
    const start = new Date(Date.now() + 3 * 86400000); start.setUTCHours(6, 0, 0, 0)
    const end = new Date(start.getTime() + 30 * 60000), rangeEnd = new Date(start.getTime() + 2 * 3600000)
    const details = { start: start.toISOString(), end: end.toISOString(), timezone: 'Asia/Shanghai', title: 'A2A integration test meeting' }
    await send(`我想预约主人 ${start.toISOString()} 开始的30分钟会议，主题是 A2A integration test meeting。我使用北京时间。请先查询可用时间，暂时不要创建日程。`, { name: 'calendar_find_slots', args: { start: details.start, end: rangeEnd.toISOString(), durationMinutes: 30 } })
    await send(`请为 ${details.start} 至 ${details.end} 准备预约提案，时区 Asia/Shanghai，标题 A2A integration test meeting。当前使用的日历渠道是 ${provider}，我已了解该渠道的检查范围。请返回预约编号等我确认。`, { name: 'calendar_prepare_booking', args: details })
    const getBookings = () => withStore(connectionFile, async store => {
      const c = await store.connection()
      return store.list(`booking:${digest(`${c.provider}:${c.calendarId}`)}`)
    })
    const proposed = (await getBookings()).find(b => b.status === 'proposed')
    assert.ok(proposed, 'Agent must prepare a booking through the actual tool')
    assert.equal(remote.events.length, 0)
    await send(`确认预约 ${proposed.id}，${details.start} 至 ${details.end}，时区 Asia/Shanghai，标题 A2A integration test meeting。请现在创建。`, { name: 'calendar_confirm_booking', args: { bookingId: proposed.id, confirmed: true } })
    assert.equal(remote.events.length, 1)
    assert.equal((await getBookings()).find(b => b.id === proposed.id).status, 'confirmed')
    await send(`请查询预约 ${proposed.id} 的状态，不要重复创建。`, { name: 'calendar_booking_status', args: { bookingId: proposed.id } })
    assert.equal(remote.events.length, 1)
    assert.ok(remote.requests.some(r => r.data.grant_type === 'refresh_token'), 'Agent must refresh credentials after Portal stopped')
    await disconnect(connectionFile)
    assert.equal(await connectionInfo(connectionFile), undefined)
    console.log(`PASS ${provider}: Portal + ${real ? 'real model' : 'real Agent/deterministic model'} + Relay + Connector + calendar adapter; one event, disconnected`)
  } finally {
    connector?.stop(); await relay?.close(); await app?.stop(); await portal.close(); await remote.close(); globalThis.fetch = realFetch; delete process.env.CALENDAR_E2E_TOKEN; delete process.env.CALENDAR_FIXTURE_ORIGIN
  }
}
