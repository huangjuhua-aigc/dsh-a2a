/** Optional three-repository integration: actual DSH harness, deterministic model, real Relay and Connector. */
import { it, expect } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { compose } from '../example/compose.ts'

it.skipIf(!process.env['A2A_RELAY_SOURCE'] || !process.env['A2A_CONNECTOR_SOURCE'])('runs discovery, authenticated chat, extended card and SSE through Relay against the real DSH transport', async () => {
  // Keep the external services on Node's production loader: Vitest 2's Vite predates node:sqlite.
  const nativeRequire = createRequire(import.meta.url)
  const { createRelay } = nativeRequire(join(process.env['A2A_RELAY_SOURCE']!, 'src/server.mjs'))
  const { Connector } = nativeRequire(join(process.env['A2A_CONNECTOR_SOURCE']!, 'src/connector.mjs'))
  const root = await mkdtemp(join(tmpdir(), 'dsh-relay-'))
  process.env['A2A_RELAY_TEST_VISITOR'] = 'test-relay-visitor'
  process.env['A2A_RELAY_TEST_OWNER'] = 'test-relay-owner'
  const app = await compose({ forceStub: true, workspaceRoot: root, peers: { alice: 'A2A_RELAY_TEST_VISITOR' }, adminTokenEnv: 'A2A_RELAY_TEST_OWNER' })
  const reserved = createServer(); await new Promise<void>(done => reserved.listen(0, '127.0.0.1', done))
  const address = reserved.address(); if (!address || typeof address === 'string') throw new Error('No port')
  await new Promise<void>(done => reserved.close(() => done()))
  const origin = `http://127.0.0.1:${address.port}`, relay = createRelay({ origin, allowHttp: true })
  await new Promise<void>(done => relay.server.listen(address.port, '127.0.0.1', done))
  let status: Record<string, any> = {}
  const connector = new Connector({ config: { relayOrigin: origin, allowHttp: true, localRpcUrl: app.rpcUrl, localCardUrl: app.cardUrl, displayName: 'DSH integration' },
    state: { registrations: {}, desiredEnabled: true, revision: 1, operationId: randomUUID() }, save: async () => {}, onStatus: (s: Record<string, any>) => { status = s } })
  try {
    void connector.start(); await expect.poll(() => status['state'], { timeout: 10000 }).toBe('online')
    const card = await (await fetch(status['publicCardUrl'])).json() as any
    expect(card.supportedInterfaces[0].url).toBe(status['publicRpcUrl'])
    const rpc = (method: string, params: unknown = {}, token = 'test-relay-visitor') => fetch(status['publicRpcUrl'], { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'a2a-version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    expect((await rpc('GetExtendedAgentCard', {}, 'test-relay-owner')).status).toBe(401)
    const extended = await (await rpc('GetExtendedAgentCard')).json() as any
    expect(extended.result.supportedInterfaces[0].url).toBe(status['publicRpcUrl'])
    expect(extended.result.skills.some((s: any) => s.id === 'internal-diagnostics')).toBe(true)
    const params = { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: '真实 DSH 中继测试 🌈' }] } }
    const reply = await (await rpc('SendMessage', params)).json() as any
    expect(reply.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(reply.result.task.artifacts[0].parts[0].text).toContain('真实 DSH 中继测试 🌈')
    const stream = await rpc('SendStreamingMessage', { message: { ...params.message, messageId: randomUUID() } })
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    const text = await stream.text()
    expect(text).toContain('TASK_STATE_COMPLETED'); expect(text).toContain('真实 DSH 中继测试 🌈')
    expect((await fetch(`${origin}/r/${status['publicationId']}/a2a/admin/contexts`)).status).toBe(404)
  } finally {
    connector.stop(); await relay.close(); await app.stop()
    delete process.env['A2A_RELAY_TEST_VISITOR']; delete process.env['A2A_RELAY_TEST_OWNER']
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
