import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PublicVisitors, REGISTER_PUBLIC_VISITOR, PUBLIC_VISITOR_STATUS } from '../src/public-visitors.ts'
import { compose, type Composition } from '../example/compose.ts'
import { removeOwned } from '../src/sandbox-files.ts'

let root: string, app: Composition | undefined
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'a2a-public-visitors-'))); process.env['A2A_PUBLIC_TEST_INVITED'] = 'test-invited-only-token' })
afterEach(async () => { await app?.stop(); app = undefined; delete process.env['A2A_PUBLIC_TEST_INVITED']; await removeOwned(tmpdir(), root) })
const message = (contextId?: string) => ({ message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'hello' }], ...(contextId ? { contextId } : {}) } })
async function call(method: string, token?: string, params: unknown = {}) {
  const res = await fetch(app!.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { status: res.status, body: await res.json() as any }
}
async function boot(enabled = true, settingsFile?: string) {
  const publicRoot = join(root, 'public'); await mkdir(publicRoot, { recursive: true })
  app = await compose({ forceStub: true, workspaceRoot: publicRoot, peers: { invited: 'A2A_PUBLIC_TEST_INVITED' }, trustedPeers: ['invited'], maxContextTurns: 20,
    overrides: { publicVisitors: { enabled, ...(settingsFile ? { settingsFile } : {}) },
      storage: { directory: join(root, 'state'), retentionMs: 86400000, maxContexts: 256, maxContextBytes: 4000000 },
      isolation: { workspaceRoot: publicRoot, privateRoot: join(root, 'private'), workspaceMode: 'per-peer', peerWorkspaces: {}, execution: 'read-only' } } })
}

describe('public visitor admission and ownership', () => {
  it('challenges unauthenticated sends before model work or identity creation and never challenges rejected tokens', async () => {
    await boot()
    let modelCalls = 0
    const stream = app!.adapter.stream.bind(app!.adapter)
    app!.adapter.stream = options => { modelCalls++; return stream(options) }
    for (const method of ['SendMessage', 'SendStreamingMessage']) {
      const response = await call(method, undefined, message())
      expect(response.status).toBe(401)
      expect(response.body).toMatchObject({ jsonrpc: '2.0', id: 1, error: { data: [{ domain: 'talk2myagent', reason: 'PUBLIC_VISITOR_AUTH_REQUIRED',
        metadata: { version: '1', requestAccepted: 'false', nextAction: 'join', registrationMethod: REGISTER_PUBLIC_VISITOR, turnLimit: '5' } }] } })
    }
    expect(modelCalls).toBe(0)
    await expect(readFile(join(root, 'state/public-visitors.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const invalid = await call('SendMessage', 'invalid-token', message())
    expect(invalid.body.error.data[0].reason).toBe('INVALID_TOKEN')
    expect(invalid.body.error.data[0].metadata.nextAction).toBe('contact_owner')
    expect((await call('GetTask', undefined, { id: 'unknown' })).body.error.data[0].reason).not.toBe('PUBLIC_VISITOR_AUTH_REQUIRED')
    const visitor = (await call(REGISTER_PUBLIC_VISITOR)).body.result
    for (let i = 0; i < 5; i++) await call('SendMessage', visitor.token, message())
    expect(modelCalls).toBe(5)
    const exhausted = await call('SendMessage', visitor.token, message())
    expect(exhausted.status).toBe(429)
    expect(exhausted.body.error.data[0]).toMatchObject({ domain: 'talk2myagent', reason: 'PUBLIC_VISITOR_QUOTA_EXHAUSTED',
      metadata: { requestAccepted: 'false', turnLimit: '5', usedTurns: '5', remainingTurns: '0', nextAction: 'contact_owner', retryable: 'false' } })
    expect(modelCalls).toBe(5)
  })
  it('rejects caller-chosen identities and oversized registration bodies before issuing credentials', async () => {
    await boot()
    expect((await call(REGISTER_PUBLIC_VISITOR, undefined, { visitorId: 'owner' })).status).toBe(400)
    expect((await call(REGISTER_PUBLIC_VISITOR, undefined, { padding: 'x'.repeat(5000) })).status).toBe(413)
    expect((await call(REGISTER_PUBLIC_VISITOR)).body.result.remainingTurns).toBe(5)
    expect(JSON.parse(await readFile(join(root, 'state/public-visitors.json'), 'utf8'))).toHaveLength(1)
  })
  it('defaults closed and never turns a missing or invalid token into shared guest access', async () => {
    await boot(false)
    const closed = await call(REGISTER_PUBLIC_VISITOR)
    expect(closed.status).toBe(401); expect(closed.body.error.data[0].reason).toBe('INVITATION_REQUIRED')
    expect((await call('SendMessage', undefined, message())).status).toBe(401)
    expect((await call('SendMessage', 'unknown', message())).status).toBe(401)
  })
  it('isolates contexts and tasks, counts streams and new contexts, and persists five-turn quotas through restart', async () => {
    await boot()
    const a = (await call(REGISTER_PUBLIC_VISITOR)).body.result, b = (await call(REGISTER_PUBLIC_VISITOR)).body.result
    expect(a.visitorId).not.toBe(b.visitorId); expect(a.token).not.toBe(b.token)
    expect((await call(REGISTER_PUBLIC_VISITOR, 'invalid')).status).toBe(401)
    expect((await call('GetExtendedAgentCard', a.token)).status).toBe(403)
    const first = (await call('SendMessage', a.token, message())).body.result.task
    expect(first.status.state).toBe('TASK_STATE_COMPLETED')
    expect((await call('GetTask', b.token, { id: first.id })).body.error).toBeDefined()
    expect((await call('ListTasks', b.token)).body.result.tasks).toEqual([])
    expect((await call('SendMessage', b.token, message(first.contextId))).body.error).toBeDefined()
    expect((await call(PUBLIC_VISITOR_STATUS, b.token)).body.result.remainingTurns).toBe(5)
    for (let i = 0; i < 3; i++) expect((await call('SendMessage', a.token, message())).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    const stream = await fetch(app!.rpcUrl, { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SendStreamingMessage', params: message() }) })
    expect(stream.status).toBe(200); expect(await stream.text()).toContain('TASK_STATE_COMPLETED')
    expect((await call('GetTask', a.token, { id: first.id })).body.result.id).toBe(first.id)
    expect((await call(PUBLIC_VISITOR_STATUS, a.token)).body.result.remainingTurns).toBe(0)
    expect((await call('SendMessage', a.token, message())).status).toBe(429)
    await app!.stop(); app = undefined; await boot()
    expect((await call(PUBLIC_VISITOR_STATUS, a.token)).body.result.remainingTurns).toBe(0)
    expect((await call('SendMessage', a.token, message())).status).toBe(429)
    expect((await call('SendMessage', b.token, message())).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    for (let i = 0; i < 6; i++) expect((await call('SendMessage', 'test-invited-only-token', message())).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
  }, 30_000)
  it('only accepts five messages under concurrent requests across independent contexts', async () => {
    await boot()
    const a = (await call(REGISTER_PUBLIC_VISITOR)).body.result
    for (let i = 0; i < 4; i++) await call('SendMessage', a.token, message())
    const replies = await Promise.all([call('SendMessage', a.token, message()), call('SendMessage', a.token, message())])
    expect(replies.filter(r => r.status === 200)).toHaveLength(1)
    expect(replies.filter(r => r.status === 429)).toHaveLength(1)
    expect((await call(PUBLIC_VISITOR_STATUS, a.token)).body.result.remainingTurns).toBe(0)
  }, 15_000)
  it('binds task ownership and quota to the verified token, ignoring caller-selected IDs in metadata', async () => {
    await boot()
    const a = (await call(REGISTER_PUBLIC_VISITOR)).body.result, b = (await call(REGISTER_PUBLIC_VISITOR)).body.result
    const request = { ...message(), metadata: { visitorId: a.visitorId, peer: 'owner', remainingTurns: 999 } }
    const response = await call('SendMessage', b.token, request)
    expect(response.status).toBe(200)
    const task = response.body.result.task
    expect((await call(PUBLIC_VISITOR_STATUS, b.token)).body.result).toMatchObject({ visitorId: b.visitorId, remainingTurns: 4 })
    expect((await call(PUBLIC_VISITOR_STATUS, a.token)).body.result).toMatchObject({ visitorId: a.visitorId, remainingTurns: 5 })
    expect((await call('GetTask', a.token, { id: task.id })).body.error).toBeDefined()
    expect((await call('GetTask', b.token, { id: task.id })).body.result.id).toBe(task.id)
  })
  it('hot switch closes new and existing public access, leaves invited access and preserves identities on reopen', async () => {
    const settings = join(root, 'settings.json')
    await writeFile(settings, JSON.stringify({ enabled: true })); await boot(false, settings)
    const a = (await call(REGISTER_PUBLIC_VISITOR)).body.result
    await call('SendMessage', a.token, message())
    await writeFile(settings, JSON.stringify({ enabled: false }))
    expect((await call(REGISTER_PUBLIC_VISITOR)).status).toBe(401)
    expect((await call('ListTasks', a.token)).status).toBe(403)
    expect((await call('SendMessage', 'test-invited-only-token', message())).status).toBe(200)
    await writeFile(settings, JSON.stringify({ enabled: true }))
    expect((await call(PUBLIC_VISITOR_STATUS, a.token)).body.result.remainingTurns).toBe(4)
    await writeFile(settings, '{invalid')
    expect((await call('ListTasks', a.token)).status).toBe(403)
  })
  it('stores only token hashes, bounds registrations and never recycles exhausted identities', async () => {
    const registry = new PublicVisitors(root, { enabled: true })
    const a = registry.register()
    for (let i = 0; i < 5; i++) registry.charge(a.visitorId)
    expect(() => registry.charge(a.visitorId)).toThrow(/quota exhausted/)
    const stored = await readFile(join(root, 'public-visitors.json'), 'utf8')
    expect(stored).not.toContain(a.token)
    for (let i = 0; i < 19; i++) registry.register()
    expect(() => registry.register()).toThrow(/registration rate/)
    const restored = new PublicVisitors(root, { enabled: true })
    expect(restored.identify(a.token)).toBe(a.visitorId)
    expect(() => restored.register()).toThrow(/registration rate/)
  })
})
