/**
 * What a polling peer actually experiences today.
 *
 * A2A's `tasks/get` is meant to be idempotent and pollable: a peer that gets a
 * non-terminal task is told to come back for the result. These cases pin what
 * currently happens on that path.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compose, type Composition } from '../example/compose.ts'

const TOKEN = 'tok-alice-poll'
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

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-a2a-poll-'))
  process.env['A2A_PEER_ALICE'] = TOKEN
  app = await compose({
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
    const body = await rpc({
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
    })
    expect(['submitted', 'working']).toContain(body['result'].status.state)
    release()
  })

  it('answers tasks/get while the task is still running', async () => {
    const release = app.adapter.hold()
    const sent = await rpc({
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
    })
    const taskId = sent['result'].id as string

    const polled = await rpc({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId } })
    expect(polled['error']).toBeUndefined()
    expect(['submitted', 'working']).toContain(polled['result'].status.state)
    release()
  })

  it('answers with the terminal state after the task settles', async () => {
    const release = app.adapter.hold()
    const sent = await rpc({
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
    })
    const taskId = sent['result'].id as string

    release()
    // Let the turn finish and the slot settle out of the live table.
    await new Promise(resolve => setTimeout(resolve, 500))

    // The slot is gone; this answer comes from the projection folded over the
    // `a2a/task` edges in the session log.
    const polled = await rpc({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId } })
    expect(polled['error']).toBeUndefined()
    expect(polled['result'].status.state).toBe('completed')
    expect(polled['result'].id).toBe(taskId)
  })

  it('returns the agent OUTPUT, not just the terminal state', async () => {
    // A `completed` task with an empty artifact list reads as "it worked and
    // produced nothing" — worse than an error, because the peer believes it.
    const sent = await rpc({
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'what is the answer' }] } },
    })
    const taskId = sent['result'].id as string
    await new Promise(resolve => setTimeout(resolve, 500))

    const polled = await rpc({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId } })
    const text = polled['result'].artifacts?.[0]?.parts?.[0]?.text as string | undefined
    expect(text).toBeTruthy()
    expect(text).toContain('what is the answer')
  })

  it('stays idempotent across repeated polls of a settled task', async () => {
    const sent = await rpc({
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
    })
    const taskId = sent['result'].id as string
    await new Promise(resolve => setTimeout(resolve, 500))

    const first = await rpc({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId } })
    const second = await rpc({ jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { taskId } })
    expect(first['result'].status.state).toBe('completed')
    expect(second['result'].status.state).toBe('completed')
  })

  it('carries the real harness turn ending in metadata', async () => {
    const sent = await rpc({
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
    })
    const taskId = sent['result'].id as string
    await new Promise(resolve => setTimeout(resolve, 500))

    const polled = await rpc({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId } })
    // A2A's state enum cannot express a token ceiling or a steering stop, so
    // the true ending rides alongside for peers that care.
    expect(polled['result'].metadata.dsh.stopReason).toBeTruthy()
  })

  it("still hides another peer's settled task", async () => {
    const app2 = await compose({
      workspaceRoot,
      peers: { alice: 'A2A_PEER_ALICE', bob: 'A2A_PEER_BOB' },
      sendMode: 'immediate',
    })
    process.env['A2A_PEER_BOB'] = 'tok-bob-poll'
    try {
      const sent = await fetch(app2.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'message/send',
          params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
        }),
      })
      const taskId = ((await sent.json()) as Record<string, any>).result.id as string
      await new Promise(resolve => setTimeout(resolve, 500))

      // Reading through the projection must not widen visibility.
      const peeked = await fetch(app2.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok-bob-poll' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId } }),
      })
      const body = await peeked.json() as Record<string, any>
      expect(body.error.code).toBe(-32001)
    } finally {
      delete process.env['A2A_PEER_BOB']
      await app2.stop()
    }
  })
})
