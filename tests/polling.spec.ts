/**
 * What a polling peer actually experiences today.
 *
 * A2A's `GetTask` is meant to be idempotent and pollable: a peer that gets a
 * non-terminal task is told to come back for the result. These cases pin what
 * currently happens on that path, plus the `ListTasks` view over the same data.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compose, type Composition } from '../example/compose.ts'

const TOKEN = 'tok-alice-poll'
const RUNNING = ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']
let workspaceRoot: string
let app: Composition

async function rpc(body: unknown): Promise<Record<string, any>> {
  const response = await fetch(app.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  })
  return await response.json() as Record<string, any>
}

/** Build a `SendMessage` request. */
function sendRequest(id: number, text: string): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'SendMessage',
    params: {
      message: { messageId: `m${id}`, role: 'ROLE_USER', parts: [{ text }] },
    },
  }
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-a2a-poll-'))
  process.env['A2A_PEER_ALICE'] = TOKEN
  app = await compose({
    forceStub: true,
    workspaceRoot,
    peers: { alice: 'A2A_PEER_ALICE' },
    sendMode: 'immediate',
  })
})

afterEach(async () => {
  await app.stop()
  delete process.env['A2A_PEER_ALICE']
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('the polling path', () => {
  it('hands back a non-terminal task in immediate mode', async () => {
    const release = app.adapter.hold()
    const body = await rpc(sendRequest(1, 'hi'))
    expect(RUNNING).toContain(body['result'].task.status.state)
    release()
  })

  it('answers GetTask while the task is still running', async () => {
    const release = app.adapter.hold()
    const sent = await rpc(sendRequest(1, 'hi'))
    const taskId = sent['result'].task.id as string

    const polled = await rpc({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: taskId } })
    expect(polled['error']).toBeUndefined()
    expect(RUNNING).toContain(polled['result'].status.state)
    release()
  })

  it('answers with the terminal state after the task settles', async () => {
    const release = app.adapter.hold()
    const sent = await rpc(sendRequest(1, 'hi'))
    const taskId = sent['result'].task.id as string

    release()
    // Let the turn finish and the slot settle out of the live table.
    await new Promise(resolve => setTimeout(resolve, 500))

    // The slot is gone; this answer comes from the projection folded over the
    // `a2a/task` edges in the session log.
    const polled = await rpc({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: taskId } })
    expect(polled['error']).toBeUndefined()
    expect(polled['result'].status.state).toBe('TASK_STATE_COMPLETED')
    expect(polled['result'].id).toBe(taskId)
  })

  it('returns the agent OUTPUT, not just the terminal state', async () => {
    // A completed task with an empty artifact list reads as "it worked and
    // produced nothing" — worse than an error, because the peer believes it.
    const sent = await rpc(sendRequest(1, 'what is the answer'))
    const taskId = sent['result'].task.id as string
    await new Promise(resolve => setTimeout(resolve, 500))

    const polled = await rpc({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: taskId } })
    const text = polled['result'].artifacts?.[0]?.parts?.[0]?.text as string | undefined
    expect(text).toBeTruthy()
    expect(text).toContain('what is the answer')
  })

  it('stays idempotent across repeated polls of a settled task', async () => {
    const sent = await rpc(sendRequest(1, 'hi'))
    const taskId = sent['result'].task.id as string
    await new Promise(resolve => setTimeout(resolve, 500))

    const first = await rpc({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: taskId } })
    const second = await rpc({ jsonrpc: '2.0', id: 3, method: 'GetTask', params: { id: taskId } })
    expect(first['result'].status.state).toBe('TASK_STATE_COMPLETED')
    expect(second['result'].status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('carries the real harness turn ending in metadata', async () => {
    const sent = await rpc(sendRequest(1, 'hi'))
    const taskId = sent['result'].task.id as string
    await new Promise(resolve => setTimeout(resolve, 500))

    const polled = await rpc({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: taskId } })
    // A2A's state enum cannot express a token ceiling or a steering stop, so
    // the true ending rides alongside for peers that care.
    expect(polled['result'].metadata.dsh.stopReason).toBeTruthy()
  })

  it("still hides another peer's settled task", async () => {
    const app2 = await compose({
      forceStub: true,
      workspaceRoot,
      peers: { alice: 'A2A_PEER_ALICE', bob: 'A2A_PEER_BOB' },
      sendMode: 'immediate',
    })
    process.env['A2A_PEER_BOB'] = 'tok-bob-poll'
    try {
      const sent = await fetch(app2.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(sendRequest(1, 'hi')),
      })
      const taskId = ((await sent.json()) as Record<string, any>).result.task.id as string
      await new Promise(resolve => setTimeout(resolve, 500))

      // Reading through the projection must not widen visibility.
      const peeked = await fetch(app2.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok-bob-poll' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: taskId } }),
      })
      const body = await peeked.json() as Record<string, any>
      expect(body.error.code).toBe(-32001)
    } finally {
      delete process.env['A2A_PEER_BOB']
      await app2.stop()
    }
  })
})

describe('ListTasks', () => {
  it('lists both running and settled tasks, newest first', async () => {
    await rpc(sendRequest(1, 'first'))
    await new Promise(resolve => setTimeout(resolve, 400))
    await rpc(sendRequest(2, 'second'))
    await new Promise(resolve => setTimeout(resolve, 400))

    const listed = await rpc({ jsonrpc: '2.0', id: 3, method: 'ListTasks', params: {} })
    const tasks = listed['result'].tasks as Record<string, any>[]
    expect(tasks.length).toBe(2)
    expect(listed['result'].totalSize).toBe(2)
    // Descending by status timestamp: the later task comes first.
    expect(tasks[0]!.status.timestamp >= tasks[1]!.status.timestamp).toBe(true)
  })

  it('omits artifacts unless the caller asks for them', async () => {
    await rpc(sendRequest(1, 'hi'))
    await new Promise(resolve => setTimeout(resolve, 500))

    const lean = await rpc({ jsonrpc: '2.0', id: 2, method: 'ListTasks', params: {} })
    // The spec is explicit: the member must be ABSENT, not an empty array.
    expect(Object.keys(lean['result'].tasks[0])).not.toContain('artifacts')

    const full = await rpc({
      jsonrpc: '2.0', id: 3, method: 'ListTasks', params: { includeArtifacts: true },
    })
    expect(full['result'].tasks[0].artifacts[0].parts[0].text).toContain('hi')
  })

  it('filters by status', async () => {
    await rpc(sendRequest(1, 'hi'))
    await new Promise(resolve => setTimeout(resolve, 500))

    const completed = await rpc({
      jsonrpc: '2.0', id: 2, method: 'ListTasks', params: { status: 'TASK_STATE_COMPLETED' },
    })
    expect(completed['result'].tasks.length).toBe(1)

    const failed = await rpc({
      jsonrpc: '2.0', id: 3, method: 'ListTasks', params: { status: 'TASK_STATE_FAILED' },
    })
    expect(failed['result'].tasks).toEqual([])
  })

  it('filters by contextId', async () => {
    const first = await rpc(sendRequest(1, 'hi'))
    const contextId = first['result'].task.contextId as string
    await rpc(sendRequest(2, 'elsewhere'))
    await new Promise(resolve => setTimeout(resolve, 500))

    const scoped = await rpc({ jsonrpc: '2.0', id: 3, method: 'ListTasks', params: { contextId } })
    const tasks = scoped['result'].tasks as Record<string, any>[]
    expect(tasks.length).toBe(1)
    expect(tasks[0]!.contextId).toBe(contextId)
  })

  it('pages with a cursor and closes with an empty token', async () => {
    await rpc(sendRequest(1, 'one'))
    await new Promise(resolve => setTimeout(resolve, 400))
    await rpc(sendRequest(2, 'two'))
    await new Promise(resolve => setTimeout(resolve, 400))

    const page1 = await rpc({ jsonrpc: '2.0', id: 3, method: 'ListTasks', params: { pageSize: 1 } })
    expect(page1['result'].tasks.length).toBe(1)
    expect(page1['result'].pageSize).toBe(1)
    expect(page1['result'].nextPageToken).not.toBe('')

    const page2 = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'ListTasks',
      params: { pageSize: 1, pageToken: page1['result'].nextPageToken },
    })
    expect(page2['result'].tasks.length).toBe(1)
    expect(page2['result'].tasks[0].id).not.toBe(page1['result'].tasks[0].id)
    // Always present; empty string is how the last page is spelled.
    expect(page2['result'].nextPageToken).toBe('')
  })

  it('rejects a page token this server never issued', async () => {
    const body = await rpc({
      jsonrpc: '2.0', id: 2, method: 'ListTasks', params: { pageToken: 'bm90LWEtY3Vyc29y' },
    })
    expect(body['error'].code).toBe(-32602)
  })
})
