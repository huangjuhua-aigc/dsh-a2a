import { describe, expect, it } from 'vitest'
import {
  buildAgentCard,
  FALLBACK_SKILL,
  isTerminal,
  parsePart,
  parseSendParams,
  partsToText,
  renderStatusUpdate,
  renderTask,
  resolveMethod,
  sseFrame,
} from '../src/protocol/index.ts'
import { A2AContextId, A2ATaskId } from '../src/protocol/brand.ts'
import type { A2ATask, A2ATaskStatusUpdateEvent } from '../src/protocol/wire.ts'

describe('method resolution', () => {
  it('resolves the v0.3 mainline spellings', () => {
    expect(resolveMethod('message/send')).toEqual({ operation: 'send', dialect: 'v0.3' })
    expect(resolveMethod('tasks/get')).toEqual({ operation: 'get', dialect: 'v0.3' })
    expect(resolveMethod('tasks/cancel')).toEqual({ operation: 'cancel', dialect: 'v0.3' })
  })

  it('accepts the v1.0 spellings and reports their dialect', () => {
    expect(resolveMethod('SendMessage')).toEqual({ operation: 'send', dialect: 'v1.0' })
    expect(resolveMethod('GetTask')).toEqual({ operation: 'get', dialect: 'v1.0' })
    expect(resolveMethod('CancelTask')).toEqual({ operation: 'cancel', dialect: 'v1.0' })
  })

  it('maps both push spellings onto one operation', () => {
    expect(resolveMethod('tasks/pushNotificationConfig/set')?.operation).toBe('push_set')
    expect(resolveMethod('CreateTaskPushNotificationConfig')?.operation).toBe('push_set')
    // The pre-0.3 alias some peers still emit.
    expect(resolveMethod('tasks/pushNotification/set')?.operation).toBe('push_set')
  })

  it('returns undefined for an unknown method', () => {
    expect(resolveMethod('tasks/teleport')).toBeUndefined()
  })
})

describe('part parsing across dialects', () => {
  it('reads a v0.3 kind-discriminated text part', () => {
    expect(parsePart({ kind: 'text', text: 'hello' })).toEqual({ kind: 'text', text: 'hello' })
  })

  it('reads a v1.0 member-presence text part', () => {
    expect(parsePart({ text: 'hello' })).toEqual({ kind: 'text', text: 'hello' })
  })

  it('reads a pre-0.3 type-discriminated part', () => {
    expect(parsePart({ type: 'text', text: 'hello' })).toEqual({ kind: 'text', text: 'hello' })
  })

  it('reads a v0.3 nested file part', () => {
    expect(parsePart({ kind: 'file', file: { name: 'a.txt', uri: 'https://x/a.txt' } }))
      .toEqual({ kind: 'file', file: { name: 'a.txt', uri: 'https://x/a.txt' } })
  })

  it('reads a v1.0 flattened file part', () => {
    expect(parsePart({ url: 'https://x/a.txt', filename: 'a.txt', mediaType: 'text/plain' }))
      .toEqual({ kind: 'file', file: { uri: 'https://x/a.txt', name: 'a.txt', mimeType: 'text/plain' } })
  })

  it('reads a data part', () => {
    expect(parsePart({ kind: 'data', data: { n: 1 } })).toEqual({ kind: 'data', data: { n: 1 } })
  })

  it('returns undefined for an unrecognizable part instead of throwing', () => {
    expect(parsePart({ kind: 'hologram' })).toBeUndefined()
    expect(parsePart(null)).toBeUndefined()
    expect(parsePart('text')).toBeUndefined()
  })
})

describe('parts to model-visible text', () => {
  it('joins text parts with newlines', () => {
    expect(partsToText([{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }])).toBe('a\nb')
  })

  it('renders non-text parts as bracketed references rather than dropping them', () => {
    const text = partsToText([
      { kind: 'text', text: 'see' },
      { kind: 'file', file: { name: 'a.txt', mimeType: 'text/plain' } },
      { kind: 'data', data: { n: 1 } },
    ])
    expect(text).toBe('see\n[file name=a.txt type=text/plain]\n[data {"n":1}]')
  })

  it('skips empty text parts', () => {
    expect(partsToText([{ kind: 'text', text: '' }])).toBe('')
  })
})

describe('send-params parsing', () => {
  it('parses a v0.3 request', () => {
    const parsed = parseSendParams({
      message: {
        kind: 'message',
        messageId: 'm1',
        role: 'user',
        parts: [{ kind: 'text', text: 'hi' }],
        contextId: 'ctx-1',
      },
    })
    expect(parsed?.message.role).toBe('user')
    expect(parsed?.message.contextId).toBe('ctx-1')
    expect(partsToText(parsed!.message.parts)).toBe('hi')
  })

  it('parses a v1.0 request with SCREAMING role and flattened parts', () => {
    const parsed = parseSendParams({
      message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }], contextId: 'ctx-1' },
    })
    expect(parsed?.message.role).toBe('user')
    expect(partsToText(parsed!.message.parts)).toBe('hi')
  })

  it('prefers the message contextId over a legacy top-level one', () => {
    const parsed = parseSendParams({
      contextId: 'legacy',
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }], contextId: 'inner' },
    })
    expect(parsed?.message.contextId).toBe('inner')
  })

  it('still accepts a legacy top-level contextId when the message omits one', () => {
    const parsed = parseSendParams({
      contextId: 'legacy',
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    })
    expect(parsed?.message.contextId).toBe('legacy')
  })

  it('rejects params without a message object', () => {
    expect(parseSendParams({})).toBeUndefined()
    expect(parseSendParams(null)).toBeUndefined()
  })

  it('yields an empty parts list when every part is unrecognizable', () => {
    const parsed = parseSendParams({
      message: { messageId: 'm1', role: 'user', parts: [{ kind: 'hologram' }] },
    })
    expect(parsed?.message.parts).toEqual([])
  })
})

describe('terminal states', () => {
  it('classifies each state', () => {
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('canceled')).toBe(true)
    expect(isTerminal('failed')).toBe(true)
    expect(isTerminal('rejected')).toBe(true)
    expect(isTerminal('working')).toBe(false)
    expect(isTerminal('submitted')).toBe(false)
    // Interrupted, not finished: the peer may still supply what is missing.
    expect(isTerminal('input-required')).toBe(false)
    expect(isTerminal('auth-required')).toBe(false)
  })
})

const task: A2ATask = {
  kind: 'task',
  id: A2ATaskId('t1'),
  contextId: A2AContextId('c1'),
  status: { state: 'completed', timestamp: '2026-08-17T00:00:00.000Z' },
  artifacts: [{ artifactId: 'a1', parts: [{ kind: 'text', text: 'done' }] }],
}

describe('dialect rendering', () => {
  it('passes a v0.3 task through unchanged', () => {
    expect(renderTask(task, 'v0.3')).toBe(task)
  })

  it('rewrites task state into the v1.0 enum spelling', () => {
    const rendered = renderTask(task, 'v1.0') as { status: { state: string } }
    expect(rendered.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('wraps a v1.0 status update in a StreamResponse member', () => {
    const event: A2ATaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: A2ATaskId('t1'),
      contextId: A2AContextId('c1'),
      status: { state: 'working', timestamp: '2026-08-17T00:00:00.000Z' },
      final: false,
    }
    expect(renderStatusUpdate(event, 'v0.3')).toBe(event)
    const v1 = renderStatusUpdate(event, 'v1.0') as { statusUpdate: { status: { state: string } } }
    expect(v1.statusUpdate.status.state).toBe('TASK_STATE_WORKING')
  })
})

describe('agent card', () => {
  const input = {
    name: 'dsh-harness',
    description: 'test agent',
    version: '0.1.0',
    url: 'https://agents.example.com/a2a',
    protocolVersion: '0.3.0',
    skills: [],
    streaming: true,
    pushNotifications: false,
    authRequired: true,
  }

  it('emits both interface spellings so either dialect can find the endpoint', () => {
    const card = buildAgentCard(input)
    expect(card.url).toBe(input.url)
    expect(card.preferredTransport).toBe('JSONRPC')
    expect(card.supportedInterfaces).toEqual([
      { url: input.url, protocolBinding: 'JSONRPC', protocolVersion: '0.3.0' },
    ])
  })

  it('falls back to one general skill rather than advertising none', () => {
    expect(buildAgentCard(input).skills).toEqual([FALLBACK_SKILL])
  })

  it('declares the bearer scheme when the endpoint requires a credential', () => {
    const card = buildAgentCard(input)
    expect(card.securitySchemes).toEqual({ bearer: { type: 'http', scheme: 'bearer' } })
    expect(card.security).toEqual([{ bearer: [] }])
  })

  it('omits the security block when no credential is required', () => {
    const card = buildAgentCard({ ...input, authRequired: false })
    expect(card.securitySchemes).toBeUndefined()
    expect(card.security).toBeUndefined()
  })

  it('never advertises capabilities it does not serve', () => {
    const card = buildAgentCard(input)
    expect(card.capabilities.stateTransitionHistory).toBe(false)
    expect(card.capabilities.pushNotifications).toBe(false)
  })
})

describe('sse framing', () => {
  it('wraps the payload in a JSON-RPC envelope and terminates the frame', () => {
    const frame = sseFrame(7, { kind: 'task' })
    expect(frame).toBe('data: {"jsonrpc":"2.0","id":7,"result":{"kind":"task"}}\n\n')
  })

  it('emits no raw newline that would truncate the frame', () => {
    const frame = sseFrame(1, { text: 'a\nb' })
    expect(frame.split('\n\n')).toHaveLength(2)
    expect(frame).toContain('a\\nb')
  })
})
