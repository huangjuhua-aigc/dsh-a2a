import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compose, type Composition } from '../example/compose.ts'
import { LiveVisitors } from '../src/live-visitors.ts'
import { removeOwned } from '../src/sandbox-files.ts'
import { ipc } from './ipc.ts'

const alice = 'fixture-alice-live-token', owner = 'fixture-owner-live-token'
const bob = { name: 'visitor-' + 'b'.repeat(24), token: 'fixture-bob-live-token', trusted: true }
let root: string, app: Composition | undefined
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'a2a-live-visitors-')))
  process.env['A2A_LIVE_ALICE'] = alice; process.env['A2A_LIVE_OWNER'] = owner
  await mkdir(join(root, 'public'))
})
afterEach(async () => {
  await app?.stop(); app = undefined
  delete process.env['A2A_LIVE_ALICE']; delete process.env['A2A_LIVE_OWNER']; delete process.env['A2A_LIVE_BOB']
  await removeOwned(tmpdir(), root)
})
async function boot(withBob = false) {
  process.env['A2A_LIVE_BOB'] = bob.token
  app = await compose({ forceStub: true, workspaceRoot: join(root, 'public'), adminTokenEnv: 'A2A_LIVE_OWNER',
    peers: { alice: 'A2A_LIVE_ALICE', ...(withBob ? { [bob.name]: 'A2A_LIVE_BOB' } : {}) },
    trustedPeers: ['alice', ...(withBob ? [bob.name] : [])], overrides: {
      isolation: { workspaceRoot: join(root, 'public'), privateRoot: join(root, 'private'), workspaceMode: 'per-peer', peerWorkspaces: {}, execution: 'read-only' },
      storage: { directory: join(root, 'state'), retentionMs: 86400000, maxContexts: 256, maxContextBytes: 4000000 },
    } })
}
const add = (body: unknown = bob, token: string | undefined = owner) => ipc(app!.managementSocket, '/a2a/admin/visitors', token, 'POST', body)
async function rpc(token: string, method = 'SendMessage', params: unknown = { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'hello' }] } }) {
  const response = await fetch(app!.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { status: response.status, body: await response.json() as any }
}

describe('live invited visitor admission', () => {
  it('only accepts local owner IPC, never public HTTP or a visitor token', async () => {
    await boot()
    expect((await rpc(bob.token)).status).toBe(401)
    expect((await fetch(`${app!.rpcUrl}/admin/visitors`, { method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: JSON.stringify(bob) })).status).toBe(404)
    expect((await add(bob, alice)).status).toBe(401)
    expect((await ipc(app!.managementSocket, '/a2a/admin/visitors', undefined, 'POST', bob)).status).toBe(401)
    expect((await add()).body).toEqual({ name: bob.name, applied: true })
    expect((await rpc(bob.token)).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
  })
  it('adds during an active task, preserves Alice context and denies Bob access to it', async () => {
    await boot()
    const release = app!.adapter.hold()
    try {
      const task = (await rpc(alice, 'SendMessage', { message: { messageId: 'ongoing', role: 'ROLE_USER', parts: [{ text: 'ongoing' }] }, configuration: { returnImmediately: true } })).body.result.task
      expect(['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED']).toContain(task.status.state)
      expect((await add()).status).toBe(200)
      expect(['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED']).toContain((await rpc(alice, 'GetTask', { id: task.id })).body.result.status.state)
      expect((await rpc(bob.token, 'GetTask', { id: task.id })).body.error).toBeDefined()
      expect((await rpc(bob.token, 'SendMessage', { message: { messageId: 'cross', contextId: task.contextId, role: 'ROLE_USER', parts: [{ text: 'cross' }] } })).body.error).toBeDefined()
      release()
      await expect.poll(async () => (await rpc(alice, 'GetTask', { id: task.id })).body.result.status.state).toBe('TASK_STATE_COMPLETED')
      const continued = await rpc(alice, 'SendMessage', { message: { messageId: 'continue', contextId: task.contextId, role: 'ROLE_USER', parts: [{ text: 'still here' }] } })
      expect(continued.body.result.task.contextId).toBe(task.contextId)
      expect((await rpc(bob.token)).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    } finally { release() }
  })
  it('is idempotent, rejects credential collisions and never upgrades an existing identity', async () => {
    await boot()
    const results = await Promise.all([add(), add()])
    expect(results.map(r => r.status)).toEqual([200, 200])
    for (const body of [{ ...bob, token: alice }, { ...bob, token: owner }, { ...bob, token: 'replacement-token' },
      { ...bob, trusted: false }, { ...bob, name: 'visitor-' + 'c'.repeat(24) }]) expect((await add(body)).status).toBe(409)
    for (const body of [{ ...bob, name: 'owner' }, { ...bob, name: '../bob' }, { ...bob, name: 'public-' + 'c'.repeat(32) },
      { ...bob, token: 'short' }, { ...bob, workspaceRoot: root }]) expect((await add(body)).status).toBe(400)
    const denied = { name: 'visitor-' + 'd'.repeat(24), token: 'fixture-untrusted-token', trusted: false }
    expect((await add(denied)).status).toBe(200)
    expect((await rpc(denied.token)).status).toBe(403)
    expect((await rpc(bob.token)).status).toBe(200)
  })
  it('retains Bob files and task identity after restarting with the saved peer config', async () => {
    await boot(); await add()
    const task = (await rpc(bob.token)).body.result.task
    await writeFile(join(root, 'private', bob.name, 'keep.txt'), 'bob-private')
    const contexts = (await ipc(app!.managementSocket, '/a2a/admin/contexts', owner)).body.contexts
    expect(contexts.find((c: any) => c.contextId === task.contextId).cwd).toBe(join(root, 'private', bob.name))
    await app!.stop(); app = undefined; await boot(true)
    expect((await rpc(bob.token, 'GetTask', { id: task.id })).body.result.id).toBe(task.id)
    expect(await readFile(join(root, 'private', bob.name, 'keep.txt'), 'utf8')).toBe('bob-private')
    expect((await add()).status).toBe(200)
    expect((await rpc(alice, 'GetTask', { id: task.id })).body.error).toBeDefined()
  })
  it('does not reuse a public identity or retain plaintext admission tokens', () => {
    const registry = new LiveVisitors(new Set(['alice']), ['alice'])
    expect(() => registry.add(bob, new Map([['alice', alice]]), owner, true)).toThrow(/credential/)
    registry.add(bob, new Map([['alice', alice]]), owner)
    expect(registry.identify(bob.token)).toEqual({ name: bob.name, trusted: true })
    expect(JSON.stringify(registry, (_, value) => value instanceof Map ? [...value] : value)).not.toContain(bob.token)
  })
})
