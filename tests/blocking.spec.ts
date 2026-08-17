/**
 * `configuration.blocking` — the client's say in whether `message/send` waits.
 *
 * A2A is async-first: the method MAY answer with a non-terminal task. Which it
 * does is negotiated, and the official SDK's own type says so:
 *
 *   blocking: bool | None
 *   "If true, the client will wait for the task to complete.
 *    The server may reject this if the task is long-running."
 *
 * So the client proposes, the deployment supplies a default, and the server may
 * still decline by timing out — with the task left running rather than failed.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compose, type Composition } from '../example/compose.ts'

const TOKEN = 'tok-alice-blocking'
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

/** Send one message, optionally stating a blocking preference. */
async function send(
  app: Composition,
  text: string,
  blocking?: boolean,
): Promise<Record<string, any>> {
  const response = await fetch(app.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: {
          kind: 'message', messageId: 'm1', role: 'user',
          parts: [{ kind: 'text', text }],
        },
        ...blocking === undefined ? {} : { configuration: { blocking } },
      },
    }),
  })
  return (await response.json() as Record<string, any>).result
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
  it('blocking:true waits even when the deployment defaults to immediate', async () => {
    const app = await serverWith('immediate')
    const task = await send(app, 'hi', true)
    expect(task.status.state).toBe('completed')
    expect(task.artifacts[0].parts[0].text).toContain('hi')
  })

  it('blocking:false returns at once even when the deployment defaults to block', async () => {
    const app = await serverWith('block')
    const release = app.adapter.hold()
    const task = await send(app, 'hi', false)
    expect(['submitted', 'working']).toContain(task.status.state)
    expect(task.artifacts).toEqual([])
    release()
  })
})

describe('the client states no preference', () => {
  it('follows a block deployment', async () => {
    const app = await serverWith('block')
    const task = await send(app, 'hi')
    expect(task.status.state).toBe('completed')
  })

  it('follows an immediate deployment', async () => {
    const app = await serverWith('immediate')
    const release = app.adapter.hold()
    const task = await send(app, 'hi')
    expect(['submitted', 'working']).toContain(task.status.state)
    release()
  })
})

describe('the server may decline a blocking request', () => {
  it('hands back a non-terminal task on timeout, and keeps working', async () => {
    // The spec's own words: "The server may reject this if the task is
    // long-running." Declining means answering non-terminally, NOT failing —
    // the task is alive and the peer polls for it.
    const app = await serverWith('immediate')
    const release = app.adapter.hold()
    const task = await send(app, 'slow', true)
    expect(['submitted', 'working']).toContain(task.status.state)

    release()
    await new Promise(resolve => setTimeout(resolve, 500))

    const polled = await fetch(app.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId: task.id } }),
    })
    const settled = (await polled.json() as Record<string, any>).result
    expect(settled.status.state).toBe('completed')
    expect(settled.artifacts[0].parts[0].text).toContain('slow')
  })
})
