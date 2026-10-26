/**
 * Local IPC monitoring: token gates and data shape. Public HTTP rejection is
 * exercised separately in hardening.spec.ts, including loopback proxy traffic.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compose, type Composition } from '../example/compose.ts'
import { ipc } from './ipc.ts'

const ALICE_TOKEN = 'tok-alice-admin'
const ADMIN_TOKEN = 'tok-admin-monitor'

let workspaceRoot: string
let app: Composition | undefined

async function send(text: string): Promise<Record<string, any>> {
  const response = await fetch(app!.rpcUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ALICE_TOKEN}`,
      'a2a-version': '1.0',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: { messageId: `m-${text.length}`, role: 'ROLE_USER', parts: [{ text }] } },
    }),
  })
  return await response.json() as Record<string, any>
}

async function getAdmin(path: string, token: string | undefined): Promise<{ status: number; body: Record<string, any> }> {
  return ipc(app!.managementSocket, `/a2a/admin/${path}`, token)
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-a2a-adm-'))
  process.env['A2A_PEER_ALICE'] = ALICE_TOKEN
  process.env['A2A_ADMIN_TOKEN'] = ADMIN_TOKEN
  app = await compose({
    forceStub: true,
    workspaceRoot,
    peers: { alice: 'A2A_PEER_ALICE' },
    adminTokenEnv: 'A2A_ADMIN_TOKEN',
  })
})

afterEach(async () => {
  await app?.stop()
  app = undefined
  delete process.env['A2A_PEER_ALICE']
  delete process.env['A2A_ADMIN_TOKEN']
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('the admin surface gates', () => {
  it('refuses a request with no token', async () => {
    const { status, body } = await getAdmin('contexts', undefined)
    expect(status).toBe(401)
    expect(body.error.code).toBe('unauthorized')
  })

  it('refuses the wrong token', async () => {
    const { status } = await getAdmin('contexts', 'not-the-admin-token')
    expect(status).toBe(401)
  })

  it('refuses anything but GET', async () => {
    const response = await ipc(app!.managementSocket, '/a2a/admin/contexts', ADMIN_TOKEN, 'POST')
    expect(response.status).toBe(405)
  })
})

describe('the admin surface data', () => {
  it('shows who came and what was said, after a settled exchange', async () => {
    const reply = await send('帮我看下升级进展')
    expect(reply.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    const contextId = reply.result.task.contextId as string

    const list = await getAdmin('contexts', ADMIN_TOKEN)
    expect(list.status).toBe(200)
    const context = (list.body.contexts as Record<string, any>[]).find(c => c.contextId === contextId)
    expect(context).toBeDefined()
    expect(context!.peer).toBe('alice')
    expect(context!.tasks).toHaveLength(1)
    expect(context!.tasks[0].input).toBe('帮我看下升级进展')
    expect(context!.tasks[0].output).toContain('帮我看下升级进展')
    expect(context!.active).toBe(0)

    const detail = await getAdmin(`contexts/${encodeURIComponent(contextId)}`, ADMIN_TOKEN)
    expect(detail.status).toBe(200)
    expect(detail.body.contexts).toHaveLength(1)
    expect((detail.body.contexts[0] as Record<string, any>).contextId).toBe(contextId)
  })

  it('answers 404 for a context that is not resident', async () => {
    const { status, body } = await getAdmin('contexts/nope', ADMIN_TOKEN)
    expect(status).toBe(404)
    expect(body.error.code).toBe('not_found')
  })
})
