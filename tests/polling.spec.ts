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

  it('LOSES the task the moment it completes, so a poller never learns the result', async () => {
    const release = app.adapter.hold()
    const sent = await rpc({
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
    })
    const taskId = sent['result'].id as string

    release()
    // Let the turn finish and the slot settle.
    await new Promise(resolve => setTimeout(resolve, 500))

    const polled = await rpc({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId } })
    // This is the gap a projection unit closes: the task DID complete, and its
    // terminal edge is in the session log, but the process-local slot is gone
    // so the peer is told the task never existed.
    expect(polled['error'].code).toBe(-32001)
  })
})
