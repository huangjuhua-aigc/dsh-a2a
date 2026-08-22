/**
 * `configuration.returnImmediately` — the client's say in whether `SendMessage`
 * waits.
 *
 * v1.0 inverted v0.3's `blocking`. Operations are BLOCKING by default:
 *
 *   "If true, the operation returns immediately after creating the task, even
 *    if processing is still in progress. If false (default), the operation MUST
 *    wait until the task reaches a terminal ... or interrupted ... state."
 *
 * So the client proposes, the deployment supplies a default for a client that
 * says nothing, and the server may still decline a wait by timing out — with
 * the task left running rather than failed.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compose, type Composition } from '../example/compose.ts'

const TOKEN = 'tok-alice-blocking'
const RUNNING = ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']
let workspaceRoot: string
let apps: Composition[] = []

/** Boot a server with the given deployment default. */
async function serverWith(sendMode: 'block' | 'immediate'): Promise<Composition> {
  const app = await compose({
    forceStub: true,
    workspaceRoot,
    peers: { alice: 'A2A_PEER_ALICE' },
    sendMode,
    blockTimeoutMs: 3000,
  })
  apps.push(app)
  return app
}

/** Send one message, optionally stating a return preference. */
async function send(
  app: Composition,
  text: string,
  returnImmediately?: boolean,
): Promise<Record<string, any>> {
  const response = await fetch(app.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text }] },
        ...returnImmediately === undefined ? {} : { configuration: { returnImmediately } },
      },
    }),
  })
  return (await response.json() as Record<string, any>).result.task
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-a2a-blocking-'))
  process.env['A2A_PEER_ALICE'] = TOKEN
})

afterEach(async () => {
  for (const app of apps) await app.stop()
  apps = []
  delete process.env['A2A_PEER_ALICE']
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('the client states a preference', () => {
  it('returnImmediately:false waits even when the deployment defaults to immediate', async () => {
    const app = await serverWith('immediate')
    const task = await send(app, 'hi', false)
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.artifacts[0].parts[0].text).toContain('hi')
  })

  it('returnImmediately:true returns at once even when the deployment defaults to block', async () => {
    const app = await serverWith('block')
    const release = app.adapter.hold()
    const task = await send(app, 'hi', true)
    expect(RUNNING).toContain(task.status.state)
    expect(task.artifacts).toEqual([])
    release()
  })
})

describe('the client states no preference', () => {
  it('follows a block deployment', async () => {
    const app = await serverWith('block')
    const task = await send(app, 'hi')
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('follows an immediate deployment', async () => {
    const app = await serverWith('immediate')
    const release = app.adapter.hold()
    const task = await send(app, 'hi')
    expect(RUNNING).toContain(task.status.state)
    release()
  })
})

describe('the server may decline a blocking request', () => {
  it('hands back a non-terminal task on timeout, and keeps working', async () => {
    // Declining a wait means answering non-terminally, NOT failing — the task
    // is alive and the peer polls for it.
    const app = await serverWith('immediate')
    const release = app.adapter.hold()
    const task = await send(app, 'slow', false)
    expect(RUNNING).toContain(task.status.state)

    release()
    await new Promise(resolve => setTimeout(resolve, 500))

    const polled = await fetch(app.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: task.id } }),
    })
    const settled = (await polled.json() as Record<string, any>).result
    expect(settled.status.state).toBe('TASK_STATE_COMPLETED')
    expect(settled.artifacts[0].parts[0].text).toContain('slow')
  })
})
