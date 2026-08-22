/**
 * End-to-end: `SendStreamingMessage` and `SubscribeToTask` over real SSE.
 *
 * The stub adapter can hold a turn open, so these tests observe a task that is
 * genuinely still working rather than one that settled before the stream was
 * read — which is the only way in-flight behavior (subscribe, cancel mid-run,
 * terminal frame on teardown) gets covered at all.
 *
 * v1.0 shapes every frame as a StreamResponse: the member name says what the
 * frame is, and the stream's CLOSURE — not a `final` flag — says the task
 * reached a terminal state.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compose, type Composition } from '../example/compose.ts'

const ALICE_TOKEN = 'tok-alice-sse'
const RUNNING = ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']

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

/** Build a `SendStreamingMessage` request. */
function streamRequest(id: number, text: string, contextId?: string): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'SendStreamingMessage',
    params: {
      message: {
        messageId: `m-${id}`,
        role: 'ROLE_USER',
        parts: [{ text, mediaType: 'text/plain' }],
        ...contextId === undefined ? {} : { contextId },
      },
    },
  }
}

/** The task, status, or artifact a frame carries, whichever member is set. */
function payload(frame: Frame | undefined): Record<string, any> | undefined {
  const result = frame?.result
  if (result === undefined) return undefined
  return (result['task'] ?? result['statusUpdate'] ?? result['artifactUpdate']) as
    Record<string, any> | undefined
}

/** The task id a frame refers to, whichever member carries it. */
function frameTaskId(frame: Frame | undefined): string | undefined {
  const result = frame?.result
  if (result === undefined) return undefined
  return (result['task']?.id ?? result['statusUpdate']?.taskId
    ?? result['artifactUpdate']?.taskId) as string | undefined
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-a2a-sse-'))
  process.env['A2A_PEER_ALICE'] = ALICE_TOKEN
  app = await compose({ forceStub: true, workspaceRoot, peers: { alice: 'A2A_PEER_ALICE' } })
})

afterEach(async () => {
  await app.stop()
  delete process.env['A2A_PEER_ALICE']
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('SendStreamingMessage', () => {
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

  it('opens with the task object, as v1.0 requires', async () => {
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'ping'))
    const opening = frames[0]?.result['task'] as Record<string, any> | undefined
    expect(opening).toBeDefined()
    expect(RUNNING).toContain(opening!['status'].state)
    expect(opening!['id']).toBeTruthy()
  })

  it('identifies each frame by member name, never by a kind tag', async () => {
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'ping'))
    for (const frame of frames) {
      expect(Object.keys(frame.result)).toHaveLength(1)
      expect(['task', 'message', 'statusUpdate', 'artifactUpdate'])
        .toContain(Object.keys(frame.result)[0])
      expect(payload(frame)).not.toHaveProperty('kind')
    }
  })

  it('delivers the agent output as a wrapped artifact update', async () => {
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'ping'))
    const artifact = frames.find(frame => frame.result['artifactUpdate'] !== undefined)
    expect(artifact).toBeDefined()
    expect(artifact?.result['artifactUpdate'].artifact.parts[0].text).toContain('echo: ping')
    expect(artifact?.result['artifactUpdate'].lastChunk).toBe(true)
    expect(artifact?.result['artifactUpdate'].index).toBe(0)
  })

  it('closes on a terminal status update, with no final flag anywhere', async () => {
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'ping'))
    const last = frames.at(-1)
    expect(last?.result['statusUpdate']).toBeDefined()
    expect(last?.result['statusUpdate'].status.state).toBe('TASK_STATE_COMPLETED')
    // v1.0 removed `final`: closing the stream IS the signal.
    for (const frame of frames) expect(payload(frame)).not.toHaveProperty('final')
  })

  it('keeps taskId and contextId stable across every frame', async () => {
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'ping'))
    const taskIds = new Set(frames.map(frameTaskId))
    const contextIds = new Set(frames.map(frame => payload(frame)?.['contextId']))
    expect(taskIds.size).toBe(1)
    expect(contextIds.size).toBe(1)
    expect([...taskIds][0]).toBeTruthy()
  })

  it('continues an existing context', async () => {
    const first = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'first'))
    const contextId = payload(first.frames[0])?.['contextId'] as string

    const second = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(2, 'second', contextId))
    expect(payload(second.frames[0])?.['contextId']).toBe(contextId)
    expect(second.frames.at(-1)?.result['statusUpdate'].status.state).toBe('TASK_STATE_COMPLETED')
  })
})

describe('a task held open', () => {
  it('reports a running task while the turn is still going, then completes', async () => {
    const release = app.adapter.hold()
    const framesSeen: Frame[] = []
    const streaming = readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'slow'), (frame) => {
      framesSeen.push(frame)
    })
    // The opening frame must arrive before the turn produces anything.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(framesSeen.length).toBeGreaterThan(0)
    expect(RUNNING).toContain(framesSeen[0]?.result['task'].status.state)

    release()
    const { frames } = await streaming
    expect(frames.at(-1)?.result['statusUpdate'].status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('sends a terminal frame on teardown instead of dropping the socket', async () => {
    // A raw socket destroy is indistinguishable from a network fault, and the
    // peer would retry a task that no longer exists.
    const app2 = await compose({ forceStub: true, workspaceRoot, peers: { alice: 'A2A_PEER_ALICE' } })
    const release = app2.adapter.hold()
    const streaming = readStream(app2.rpcUrl, ALICE_TOKEN, streamRequest(1, 'slow'))
    await new Promise(resolve => setTimeout(resolve, 200))

    await app2.stop()
    release()

    const { frames } = await streaming
    const last = frames.at(-1)
    expect(last?.result['statusUpdate'].status.state).toBe('TASK_STATE_CANCELED')
  })

  it('cancels a running task and settles the stream as canceled', async () => {
    const release = app.adapter.hold()
    const opened: Frame[] = []
    const streaming = readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'slow'), (frame) => {
      opened.push(frame)
    })
    await new Promise(resolve => setTimeout(resolve, 200))
    const taskId = frameTaskId(opened[0])
    expect(taskId).toBeTruthy()

    const cancelled = await fetch(app.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ALICE_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'CancelTask', params: { id: taskId } }),
    })
    const body = await cancelled.json() as Record<string, any>
    expect(body.result.status.state).toBe('TASK_STATE_CANCELED')

    release()
    const { frames } = await streaming
    expect(frames.at(-1)?.result['statusUpdate'].status.state).toBe('TASK_STATE_CANCELED')
  })
})

describe('SubscribeToTask', () => {
  it('reattaches to a task that is still running', async () => {
    const release = app.adapter.hold()
    const opened: Frame[] = []
    const original = readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'slow'), (frame) => {
      opened.push(frame)
    })
    await new Promise(resolve => setTimeout(resolve, 200))
    const taskId = frameTaskId(opened[0])

    const resubscribed = readStream(app.rpcUrl, ALICE_TOKEN, {
      jsonrpc: '2.0', id: 9, method: 'SubscribeToTask', params: { id: taskId },
    })
    await new Promise(resolve => setTimeout(resolve, 100))

    release()
    const [first, second] = await Promise.all([original, resubscribed])
    // Both streams observe the same task reaching the same terminal state.
    expect(first.frames.at(-1)?.result['statusUpdate'].status.state).toBe('TASK_STATE_COMPLETED')
    expect(second.frames.at(-1)?.result['statusUpdate'].status.state).toBe('TASK_STATE_COMPLETED')
    // A new subscriber's first frame is the task's state at the time it joined.
    expect(second.frames[0]?.result['task']).toBeDefined()
    expect(frameTaskId(second.frames[0])).toBe(taskId)
  })

  it('refuses a task that already reached a terminal state', async () => {
    // v1.0 states this is an UnsupportedOperation; the outcome is still one
    // GetTask away, so nothing is lost by not streaming it.
    const { frames } = await readStream(app.rpcUrl, ALICE_TOKEN, streamRequest(1, 'ping'))
    const taskId = frameTaskId(frames[0])
    await new Promise(resolve => setTimeout(resolve, 200))

    const response = await fetch(app.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ALICE_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'SubscribeToTask', params: { id: taskId } }),
    })
    const body = await response.json() as Record<string, any>
    expect(body.error.code).toBe(-32004)
    expect(body.error.data[0].reason).toBe('UNSUPPORTED_OPERATION')
  })

  it('still reports a task this peer does not own as not found', async () => {
    const response = await fetch(app.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ALICE_TOKEN}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: 'never-existed' },
      }),
    })
    const body = await response.json() as Record<string, any>
    expect(body.error.code).toBe(-32001)
  })

  it('refuses to subscribe without an id', async () => {
    const response = await fetch(app.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ALICE_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: {} }),
    })
    const body = await response.json() as Record<string, any>
    expect(body.error.code).toBe(-32602)
  })
})
