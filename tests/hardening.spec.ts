import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compose, type Composition } from '../example/compose.ts'
import { Config, type A2AServerConfig } from '../src/config.ts'
import { ipc } from './ipc.ts'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'

let root: string
let app: Composition | undefined
const token = 'test-hardening-alice'
const owner = 'test-hardening-owner'
const send = (text: string, contextId?: string) => ({ jsonrpc: '2.0', id: 1, method: 'SendMessage',
  params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text }], ...contextId ? { contextId } : {} } } })
async function rpc(body: unknown, credential = token) {
  const res = await fetch(app!.rpcUrl, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}
async function boot(overrides: Partial<A2AServerConfig> = {}) {
  app = await compose({ forceStub: true, workspaceRoot: root, peers: { alice: 'HARDEN_ALICE', bob: 'HARDEN_BOB' },
    adminTokenEnv: 'HARDEN_OWNER', overrides: { storage: { directory: join(root, 'state'), retentionMs: 86400000, maxContexts: 32, maxContextBytes: 4000000 }, ...overrides } })
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'a2a-hardening-'))
  process.env['HARDEN_ALICE'] = token; process.env['HARDEN_OWNER'] = owner; process.env['HARDEN_BOB'] = 'test-hardening-bob'
})
afterEach(async () => {
  await app?.stop(); app = undefined
  for (const key of ['HARDEN_ALICE', 'HARDEN_OWNER', 'HARDEN_BOB']) delete process.env[key]
  await rm(root, { recursive: true, force: true })
})

describe('public access boundaries', () => {
  it('preserves omitted versus explicitly empty allow lists through schema normalization', async () => {
    expect(Config({ isolation: { workspaceRoot: root } } as A2AServerConfig).trustedPeers).toBeUndefined()
    await boot({ trustedPeers: [] })
    expect((await rpc(send('hello'))).status).toBe(403)
  })
  it('rejects owner tokens and admin paths on public HTTP even from loopback', async () => {
    await boot()
    expect((await rpc(send('hello'), owner)).status).toBe(401)
    expect((await fetch(`${app!.rpcUrl}/admin/contexts`, { headers: { authorization: `Bearer ${owner}` } })).status).toBe(404)
    expect((await ipc(app!.managementSocket, '/a2a', owner, 'POST', send('local owner'))).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect((await ipc(app!.managementSocket, '/a2a', token, 'POST', send('visitor'))).status).toBe(401)
  })
  it('hides and refuses ambient tools for visitors', async () => {
    await boot()
    let executions = 0
    app!.ctx.tools.register({ name: 'private_file', description: 'read a secret', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async () => { executions++; return 'secret' },
    })
    const task = (await rpc(send('hello'))).body.result.task
    const agent = app!.ctx.agents.list().find(a => a.session.id === task.contextId)!
    expect(app!.ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(['read_file'])
    const result = await app!.ctx.tools.execute({ agent, callId: ToolCallId('test-call'), name: 'private_file', arguments: {}, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(executions).toBe(0)
  })
  it('excludes the host persona and optional private runtime context from public model input', async () => {
    await boot()
    app!.ctx.systemPrompt.section({ name: 'private-persona-test', order: 0, text: 'PERSONAL_SYSTEM_SECRET' })
    app!.ctx.systemPrompt.context({ name: 'private-memory-test', order: 0, text: 'PERSONAL_CONTEXT_SECRET' })
    let sent = ''
    const stream = app!.adapter.stream.bind(app!.adapter)
    app!.adapter.stream = options => { sent = JSON.stringify(options); return stream(options) }
    expect((await rpc(send('hello'))).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(sent).not.toContain('PERSONAL_SYSTEM_SECRET')
    expect(sent).not.toContain('PERSONAL_CONTEXT_SECRET')
  })
  it('reads actual workspace data through a model tool call and returns it over A2A', async () => {
    await writeFile(join(root, 'project.txt'), '项目进度：第 3 阶段，完成了 80%。', 'utf8')
    await boot()
    let calls = 0
    app!.adapter.stream = async function* (options): AsyncIterable<StreamChunk> {
      if (++calls === 1) {
        const id = ToolCallId('workspace-read')
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'read_file', argumentsDelta: '{"path":"project.txt"}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read_file', arguments: '{"path":"project.txt"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const fromFile = JSON.stringify(options.messages)
        expect(fromFile).toContain('项目进度：第 3 阶段')
        const reply = '读取本地项目资料：第 3 阶段，完成了 80%。'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const result = (await rpc(send('查一下项目进度'))).body.result.task
    expect(result.status.state).toBe('TASK_STATE_COMPLETED')
    expect(calls).toBe(2)
    expect(result.artifacts[0].parts[0].text).toContain('完成了 80%')
  })
  it('uses peer workspace overrides as a narrower read boundary and shadows ambient read_file', async () => {
    const { mkdir } = await import('node:fs/promises')
    const selected = join(root, 'alice-data')
    await mkdir(selected)
    await writeFile(join(selected, 'allowed.txt'), 'ALLOWED')
    await writeFile(join(root, 'other.txt'), 'NOT_FOR_ALICE')
    await boot({ isolation: { workspaceRoot: root, workspaceMode: 'per-peer', peerWorkspaces: { alice: selected } } })
    let ambientExecutions = 0
    app!.ctx.tools.register({ name: 'read_file', description: 'unrestricted host reader', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async () => { ambientExecutions++; return 'PRIVATE' },
    })
    const task = (await rpc(send('hello'))).body.result.task
    const agent = app!.ctx.agents.list().find(a => a.session.id === task.contextId)!
    const execute = (path: string) => app!.ctx.tools.execute({ agent, callId: ToolCallId('check-root'), name: 'read_file', arguments: { path }, signal: new AbortController().signal })
    const allowed = await execute('allowed.txt')
    expect(allowed.isError).not.toBe(true)
    expect(JSON.stringify(allowed)).toContain('ALLOWED')
    expect((await execute('../other.txt')).isError).toBe(true)
    expect(ambientExecutions).toBe(0)
  })
})

describe('bounded tasks', () => {
  it('caps model calls and output tokens even when a model keeps requesting forbidden tools', async () => {
    await boot({ maxModelCallsPerTask: 2, maxOutputTokens: 17 })
    let calls = 0
    app!.adapter.stream = async function* (options): AsyncIterable<StreamChunk> {
      calls++
      expect(options.maxTokens).toBe(17)
      const callId = ToolCallId(`forbidden-${calls}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: 'private_file', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'private_file', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
    const result = (await rpc(send('keep trying'))).body.result.task
    expect(calls).toBe(2)
    expect(result.status.state).toBe('TASK_STATE_FAILED')
    expect(result.metadata.dsh.stopReason).toBe('model_call_limit')
  })
  it('limits one peer without exhausting another peer\'s capacity', async () => {
    await boot({ maxConcurrentTasksPerPeer: 1, maxConcurrentTasks: 2, sendMode: 'immediate' })
    const release = app!.adapter.hold()
    expect((await rpc(send('A'))).status).toBe(200)
    expect((await rpc(send('B'))).status).toBe(429)
    expect((await rpc(send('C'), 'test-hardening-bob')).status).toBe(200)
    release()
  })
  it('enforces global admission before concurrent context creation', async () => {
    await boot({ maxConcurrentTasks: 1, sendMode: 'immediate' })
    const release = app!.adapter.hold()
    const results = await Promise.all([rpc(send('A')), rpc(send('B'))])
    expect(results.map(r => r.status).sort()).toEqual([200, 429])
    expect(app!.ctx.agents.list()).toHaveLength(1)
    release()
  })
  it('enforces resident capacity even when the global task allowance has room', async () => {
    await boot({ maxResidentContexts: 1, maxConcurrentTasks: 3, maxConcurrentTasksPerPeer: 3, sendMode: 'immediate' })
    const release = app!.adapter.hold()
    const results = await Promise.all([rpc(send('A')), rpc(send('B')), rpc(send('C'))])
    expect(results.map(r => r.status).sort()).toEqual([200, 429, 429])
    expect(app!.ctx.agents.list()).toHaveLength(1)
    release()
  })
  it('rejects a second task in the same context without mixing outputs', async () => {
    await boot({ sendMode: 'immediate' })
    const release = app!.adapter.hold()
    const first = (await rpc(send('only A'))).body.result.task
    expect((await rpc(send('never B', first.contextId))).status).toBe(409)
    release()
    await app!.ctx.agents.list()[0]!.whenIdle()
    await expect.poll(async () => (await rpc({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: first.id } })).body.result.status.state).toBe('TASK_STATE_COMPLETED')
    const task = (await rpc({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: first.id } })).body.result
    expect(task.artifacts[0].parts[0].text).toContain('only A')
    expect(task.artifacts[0].parts[0].text).not.toContain('never B')
  })
  it('aborts execution at its deadline instead of merely timing out the HTTP wait', async () => {
    await boot({ taskTimeoutMs: 60 })
    const release = app!.adapter.hold()
    const result = (await rpc(send('blocked'))).body.result.task
    expect(result.status.state).toBe('TASK_STATE_FAILED')
    expect(result.metadata.dsh.stopReason).toBe('task_timeout')
    release()
    expect((await rpc(send('next'))).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
  })
  it('caps input and output', async () => {
    await boot({ maxInputChars: 20, maxOutputChars: 4 })
    expect((await rpc(send('x'.repeat(21)))).status).toBe(413)
    const result = (await rpc(send('hello world'))).body.result.task
    expect(result.status.state).toBe('TASK_STATE_FAILED')
    expect(result.metadata.dsh.stopReason).toBe('output_limit')
    expect(result.artifacts[0].parts[0].text.length).toBeLessThanOrEqual(4)
  })
  it('persists daily quotas across restarts', async () => {
    await boot({ maxTasksPerPeerPerDay: 1 })
    expect((await rpc(send('first'))).status).toBe(200)
    await app!.stop(); await boot({ maxTasksPerPeerPerDay: 1 })
    expect((await rpc(send('second'))).status).toBe(429)
  })
})

describe('stream lifetimes', () => {
  it('heartbeats, limits subscribers, and frees admission when a client disconnects', async () => {
    await boot({ streamHeartbeatMs: 15, maxStreamsPerTask: 1, sendMode: 'immediate' })
    const release = app!.adapter.hold()
    const task = (await rpc(send('slow'))).body.result.task
    const subscribe = { jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: task.id } }
    const controller = new AbortController()
    const first = await fetch(app!.rpcUrl, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(subscribe), signal: controller.signal })
    const reader = first.body!.getReader()
    let frames = new TextDecoder().decode((await reader.read()).value)
    while (!frames.includes(': heartbeat')) frames += new TextDecoder().decode((await reader.read()).value)
    expect((await rpc(subscribe)).status).toBe(429)
    controller.abort(); await reader.cancel().catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 30))
    const nextController = new AbortController()
    const next = await fetch(app!.rpcUrl, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(subscribe), signal: nextController.signal })
    expect(next.status).toBe(200)
    nextController.abort(); await next.body?.cancel().catch(() => {})
    release()
  })
  it('disconnects an oversized stream frame while retaining the queryable task', async () => {
    await boot({ maxStreamBufferBytes: 32, sendMode: 'immediate' })
    const release = app!.adapter.hold()
    const task = (await rpc(send('slow'))).body.result.task
    await expect(fetch(app!.rpcUrl, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: task.id } }) })).rejects.toThrow()
    release()
    await expect.poll(async () => (await rpc({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: task.id } })).body.result.status.state).toBe('TASK_STATE_COMPLETED')
  })
})

describe('retention and recovery', () => {
  it('keeps results after eviction and resumes a context with its history and turn budget', async () => {
    await boot({ maxResidentContexts: 1, maxContextTurns: 2 })
    const first = (await rpc(send('first'))).body.result.task
    await rpc(send('evicts first'))
    expect(app!.ctx.agents.list()).toHaveLength(1)
    const get = { jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: first.id } }
    expect((await rpc(get)).body.result.status.state).toBe('TASK_STATE_COMPLETED')
    let restoredInput = ''
    const stream = app!.adapter.stream.bind(app!.adapter)
    app!.adapter.stream = options => { restoredInput = JSON.stringify(options.messages); return stream(options) }
    const restored = (await rpc(send('second', first.contextId))).body
    expect(restored.error).toBeUndefined()
    expect(restored.result.task.contextId).toBe(first.contextId)
    expect(restoredInput).toContain('first')
    await app!.stop(); await boot({ maxResidentContexts: 1, maxContextTurns: 2 })
    expect((await rpc(get)).body.result.artifacts[0].parts[0].text).toContain('first')
    expect((await rpc(send('third', first.contextId))).body.result.task.status.state).toBe('TASK_STATE_REJECTED')
    expect((await rpc(get, 'test-hardening-bob')).body.error.code).toBe(-32001)
  })
  it('marks interrupted checkpoints failed on restart and never replays accepted work', async () => {
    await boot({ sendMode: 'immediate' })
    const release = app!.adapter.hold()
    const task = (await rpc(send('saved'))).body.result.task
    const file = join(root, 'state', `${task.contextId}.json`)
    const interrupted = await readFile(file, 'utf8')
    await app!.stop(); app = undefined; release()
    await writeFile(file, interrupted)
    await boot()
    const restored = (await rpc({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: task.id } })).body.result
    expect(restored.status.state).toBe('TASK_STATE_FAILED')
    expect(restored.metadata.dsh.stopReason).toBe('process_restart')
    expect(app!.ctx.agents.list()).toHaveLength(0)
    expect((await rpc(send('continue', task.contextId))).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
  })
  it('expires retained results and bounds retained contexts', async () => {
    await boot({ storage: { directory: join(root, 'state'), retentionMs: 60, maxContexts: 1, maxContextBytes: 4000000 } })
    const first = (await rpc(send('first'))).body.result.task
    expect((await rpc(send('second'))).status).toBe(429)
    await app!.stop(); app = undefined
    await new Promise(resolve => setTimeout(resolve, 80))
    await boot({ storage: { directory: join(root, 'state'), retentionMs: 60, maxContexts: 1, maxContextBytes: 4000000 } })
    expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: first.id } })).body.error.code).toBe(-32001)
    expect((await readdir(join(root, 'state'))).filter(n => n === `${first.contextId}.json`)).toHaveLength(0)
  })
})
