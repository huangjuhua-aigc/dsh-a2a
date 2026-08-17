/**
 * End-to-end: `message/stream` and `tasks/resubscribe` over real SSE.
 *
 * The stub adapter can hold a turn open, so these tests observe a task that is
 * genuinely still `working` rather than one that settled before the stream was
 * read — which is the only way in-flight behavior (resubscribe, cancel mid-run,
 * terminal frame on teardown) gets covered at all.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compose, type Composition } from '../example/compose.ts'

const ALICE_TOKEN = 'tok-alice-sse'

let workspaceRoot: string
let app: Composition

/** One decoded SSE frame: the JSON-RPC envelope carried in a `data:` line. */
interface Frame {
  jsonrpc: string
  id: string | number | null
  result: Record<string, any>
}

/**
 * Open an SSE request and yield decoded frames until the stream closes.
 * @param url - the RPC endpoint.
 * @param token - the bearer credential.
 * @param body - the JSON-RPC request.
 * @param onFrame - called per frame; return true to stop reading early.
 * @returns every frame read.
 */
async function readStream(
  url: string,
  token: string,
  body: unknown,
  onFrame?: (frame: Frame, all: Frame[]) => boolean | void,
): Promise<{ contentType: string | null; frames: Frame[] }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const contentType = response.headers.get('content-type')
  const frames: Frame[] = []
  const reader = response.body?.getReader()
  if (reader === undefined) return { contentType, frames }

  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value !== undefined) buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const line = raw.split('\n').find(part => part.startsWith('data: '))
      if (line !== undefined) {
        const frame = JSON.parse(line.slice('data: '.length)) as Frame
        frames.push(frame)
        if (onFrame?.(frame, frames) === true) {
          await reader.cancel()
          return { contentType, frames }
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
    if (done) break
  }
  return { contentType, frames }
}

/** Build a `message/stream` request. */
function streamRequest(id: number, text: string, contextId?: string): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'message/stream',
    params: {
      message: {
        kind: 'message',
        messageId: `m-${id}`,
        role: 'user',
        parts: [{ kind: 'text', text }],
        ...contextId === undefined ? {} : { contextId },
      },
    },
  }
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-a2a-sse-'))
  process.env['A2A_PEER_ALICE'] = ALICE_TOKEN
  app = await compose({ workspaceRoot, peers: { alice: 'A2A_PEER_ALICE' } })
})

afterEach(async () => {
  await app.stop()
  delete process.env['A2A_PEER_ALICE']
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('message/stream', () => {
  it('answers with an event stream', async () => {
    const { contentType } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'ping'))
    expect(contentType).toContain('text/event-stream')
  })

  it('carries every frame as a JSON-RPC envelope correlated to the request id', async () => {
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(7, 'ping'))
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      expect(frame.jsonrpc).toBe('2.0')
      expect(frame.id).toBe(7)
    }
  })

  it('opens with a non-final status update', async () => {
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'ping'))
    expect(frames[0]?.result['kind']).toBe('status-update')
    expect(frames[0]?.result['final']).toBe(false)
    expect(['submitted', 'working']).toContain(frames[0]?.result['status'].state)
  })

  it('delivers the agent output as an artifact update', async () => {
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'ping'))
    const artifact = frames.find(frame => frame.result['kind'] === 'artifact-update')
    expect(artifact).toBeDefined()
    expect(artifact?.result['artifact'].parts[0].text).toContain('echo: ping')
    expect(artifact?.result['lastChunk']).toBe(true)
  })

  it('closes with a final status update and then ends the stream', async () => {
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'ping'))
    const last = frames.at(-1)
    expect(last?.result['kind']).toBe('status-update')
    expect(last?.result['final']).toBe(true)
    expect(last?.result['status'].state).toBe('completed')
    // Exactly one final frame, and it is the last thing on the wire.
    expect(frames.filter(frame => frame.result['final'] === true)).toHaveLength(1)
  })

  it('keeps taskId and contextId stable across every frame', async () => {
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'ping'))
    const taskIds = new Set(frames.map(frame => frame.result['taskId']))
    const contextIds = new Set(frames.map(frame => frame.result['contextId']))
    expect(taskIds.size).toBe(1)
    expect(contextIds.size).toBe(1)
    expect([...taskIds][0]).toBeTruthy()
  })

  it('continues an existing context', async () => {
    const first = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'first'))
    const contextId = first.frames[0]?.result['contextId'] as string

    const second = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(2, 'second', contextId))
    expect(second.frames[0]?.result['contextId']).toBe(contextId)
    expect(second.frames.at(-1)?.result['status'].state).toBe('completed')
  })
})

describe('message/stream in the v1.0 dialect', () => {
  it('wraps status updates in a StreamResponse member with the v1.0 enum', async () => {
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendStreamingMessage',
      params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'ping' }] } },
    })
    const opening = frames[0]?.result as Record<string, any>
    expect(opening['statusUpdate']).toBeDefined()
    expect(String(opening['statusUpdate'].status.state)).toMatch(/^TASK_STATE_/)

    const final = frames.at(-1)?.result as Record<string, any>
    expect(final['statusUpdate'].status.state).toBe('TASK_STATE_COMPLETED')
    expect(final['statusUpdate'].final).toBe(true)
  })
})

describe('a task held open', () => {
  it('reports working while the turn is still running, then completes', async () => {
    const release = app.adapter.hold()
    const framesSeen: Frame[] = []
    const streaming = readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'slow'), (frame) => {
      framesSeen.push(frame)
    })
    // The opening frame must arrive before the turn produces anything.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(framesSeen.length).toBeGreaterThan(0)
    expect(framesSeen[0]?.result['final']).toBe(false)

    release()
    const { frames } = await streaming
    expect(frames.at(-1)?.result['status'].state).toBe('completed')
    expect(frames.at(-1)?.result['final']).toBe(true)
  })

  it('sends a terminal frame on teardown instead of dropping the socket', async () => {
    // A raw socket destroy is indistinguishable from a network fault, and the
    // peer would retry a task that no longer exists.
    const app2 = await compose({ workspaceRoot, peers: { alice: 'A2A_PEER_ALICE' } })
    const release = app2.adapter.hold()
    const streaming = readStream(app2.rpcUrl, ALICE_TOKEN, streamRequest(1, 'slow'))
    await new Promise(resolve => setTimeout(resolve, 200))

    await app2.stop()
    release()

    const { frames } = await streaming
    const last = frames.at(-1)
    expect(last?.result['final']).toBe(true)
    expect(last?.result['status'].state).toBe('canceled')
  })

  it('cancels a running task and settles the stream as canceled', async () => {
    const release = app.adapter.hold()
    const opened: Frame[] = []
    const streaming = readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'slow'), (frame) => {
      opened.push(frame)
    })
    await new Promise(resolve => setTimeout(resolve, 200))
    const taskId = opened[0]?.result['taskId'] as string
    expect(taskId).toBeTruthy()

    const cancelled = await fetch(app.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ALICE_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { taskId } }),
    })
    const body = await cancelled.json() as Record<string, any>
    expect(body.result.status.state).toBe('canceled')

    release()
    const { frames } = await streaming
    expect(frames.at(-1)?.result['status'].state).toBe('canceled')
    expect(frames.at(-1)?.result['final']).toBe(true)
  })
})

describe('tasks/resubscribe', () => {
  it('reattaches to a task that is still running', async () => {
    const release = app.adapter.hold()
    const opened: Frame[] = []
    const original = readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'slow'), (frame) => {
      opened.push(frame)
    })
    await new Promise(resolve => setTimeout(resolve, 200))
    const taskId = opened[0]?.result['taskId'] as string

    const resubscribed = readStream(app.rpcUrl, ALICE_TOKEN, {
      jsonrpc: '2.0', id: 9, method: 'tasks/resubscribe', params: { taskId },
    })
    await new Promise(resolve => setTimeout(resolve, 100))

    release()
    const [first, second] = await Promise.all([original, resubscribed])
    // Both streams observe the same task reaching the same terminal state.
    expect(first.frames.at(-1)?.result['status'].state).toBe('completed')
    expect(second.frames.at(-1)?.result['status'].state).toBe('completed')
    expect(second.frames.at(-1)?.result['taskId']).toBe(taskId)
  })

  it('delivers the outcome of an already-settled task in one terminal frame', async () => {
    // A peer that reconnects after the fact still deserves the result; the
    // answer comes from the projection, not from a live slot.
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'ping'))
    const taskId = frames[0]?.result['taskId'] as string
    await new Promise(resolve => setTimeout(resolve, 200))

    const again = await readStream(app.rpcUrl, ALICE_TOKEN, {
      jsonrpc: '2.0', id: 9, method: 'tasks/resubscribe', params: { taskId },
    })
    expect(again.contentType).toContain('text/event-stream')
    expect(again.frames).toHaveLength(1)
    expect(again.frames[0]?.result['final']).toBe(true)
    expect(again.frames[0]?.result['status'].state).toBe('completed')
    expect(again.frames[0]?.result['taskId']).toBe(taskId)
  })

  it('still reports a task this peer does not own as not found', async () => {
    const response = await fetch(app.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ALICE_TOKEN}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tasks/resubscribe', params: { taskId: 'never-existed' },
      }),
    })
    const body = await response.json() as Record<string, any>
    expect(body.error.code).toBe(-32001)
  })

  it('refuses to resubscribe without a taskId', async () => {
    const response = await fetch(app.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ALICE_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tasks/resubscribe', params: {} }),
    })
    const body = await response.json() as Record<string, any>
    expect(body.error.code).toBe(-32602)
  })
})
