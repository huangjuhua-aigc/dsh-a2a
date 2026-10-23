/**
 * The host briefing: merged into a context's FIRST visitor message, once.
 *
 * The merge target is the submitted text rather than a turn of its own, so
 * these tests pin the two observable consequences: the first reply is shaped by
 * the briefing, and the second message travels without it.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compose, type Composition } from '../example/compose.ts'

const ALICE_TOKEN = 'tok-alice-preamble'

let workspaceRoot: string
let app: Composition | undefined

async function rpc(url: string, body: unknown): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ALICE_TOKEN}`,
      'a2a-version': '1.0',
    },
    body: JSON.stringify(body),
  })
  return await response.json() as Record<string, any>
}

function sendRequest(id: number, text: string, contextId?: string): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'SendMessage',
    params: {
      message: {
        messageId: `m-${id}`,
        role: 'ROLE_USER',
        parts: [{ text }],
        ...contextId === undefined ? {} : { contextId },
      },
    },
  }
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-a2a-pre-'))
  process.env['A2A_PEER_ALICE'] = ALICE_TOKEN
  app = await compose({
    forceStub: true,
    workspaceRoot,
    peers: { alice: 'A2A_PEER_ALICE' },
  })
})

afterEach(async () => {
  await app?.stop()
  app = undefined
  delete process.env['A2A_PEER_ALICE']
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('the host briefing', () => {
  it('reaches the model with the first message when the file exists', async () => {
    // The briefing is agent-level data at the workspace ROOT, shared by every
    // visitor — not one file per visitor directory.
    await mkdir(join(workspaceRoot, '.hop'), { recursive: true })
    await writeFile(
      join(workspaceRoot, '.hop', 'handoff.md'),
      '最近在做 dsh-a2a 升级，关键决定：出站用 skill 形态。',
    )
    const first = await rpc(app!.rpcUrl, sendRequest(1, '你好'))
    // The echo adapter replies with the last user text it saw, so the briefing
    // riding along with the first message is observable in the reply.
    const text = first.result.task.artifacts[0].parts[0].text as string
    expect(text).toContain('host briefing')
    expect(text).toContain('dsh-a2a 升级')
    expect(text).toContain('你好')
  })

  it('rides along exactly once', async () => {
    await mkdir(join(workspaceRoot, '.hop'), { recursive: true })
    await writeFile(join(workspaceRoot, '.hop', 'handoff.md'), '只应出现一次的背景')
    const first = await rpc(app!.rpcUrl, sendRequest(1, '第一条'))
    const contextId = first.result.task.contextId as string
    const second = await rpc(app!.rpcUrl, sendRequest(2, '第二条', contextId))
    expect((first.result.task.artifacts[0].parts[0].text as string)).toContain('只应出现一次的背景')
    expect((second.result.task.artifacts[0].parts[0].text as string)).not.toContain('只应出现一次的背景')
  })

  it('is silently absent when no briefing file exists', async () => {
    const reply = await rpc(app!.rpcUrl, sendRequest(1, ' plain '))
    expect((reply.result.task.artifacts[0].parts[0].text as string)).not.toContain('host briefing')
  })
})
