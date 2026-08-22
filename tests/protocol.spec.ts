import { describe, expect, it } from 'vitest'
import {
  buildAgentCard,
  buildExtendedAgentCard,
  errorDetails,
  FALLBACK_SKILL,
  isTerminal,
  legacyMethodReplacement,
  parseListTasksParams,
  parsePart,
  parseSendMessageRequest,
  parseTenant,
  partsToText,
  resolveMethod,
  sseFrame,
  streamStatusUpdate,
  streamTask,
} from '../src/protocol/index.ts'
import { A2AContextId, A2ATaskId } from '../src/protocol/brand.ts'
import type { A2ATask } from '../src/protocol/wire.ts'

describe('method resolution', () => {
  it('resolves the v1.0 spellings', () => {
    expect(resolveMethod('SendMessage')).toBe('send')
    expect(resolveMethod('SendStreamingMessage')).toBe('stream')
    expect(resolveMethod('GetTask')).toBe('get')
    expect(resolveMethod('ListTasks')).toBe('list')
    expect(resolveMethod('CancelTask')).toBe('cancel')
    expect(resolveMethod('SubscribeToTask')).toBe('subscribe')
    expect(resolveMethod('GetExtendedAgentCard')).toBe('extended_card')
  })

  it('resolves each push-config method to its own operation', () => {
    expect(resolveMethod('CreateTaskPushNotificationConfig')).toBe('push_create')
    expect(resolveMethod('GetTaskPushNotificationConfig')).toBe('push_get')
    expect(resolveMethod('ListTaskPushNotificationConfigs')).toBe('push_list')
    expect(resolveMethod('DeleteTaskPushNotificationConfig')).toBe('push_delete')
  })

  it('does not answer a retired v0.3 method', () => {
    expect(resolveMethod('message/send')).toBeUndefined()
    expect(resolveMethod('tasks/get')).toBeUndefined()
    expect(resolveMethod('tasks/resubscribe')).toBeUndefined()
  })

  it('names the v1.0 replacement for a retired method', () => {
    expect(legacyMethodReplacement('message/send')).toBe('SendMessage')
    expect(legacyMethodReplacement('tasks/resubscribe')).toBe('SubscribeToTask')
    expect(legacyMethodReplacement('agent/getAuthenticatedExtendedCard'))
      .toBe('GetExtendedAgentCard')
  })

  it('returns undefined for a method that was never ours', () => {
    expect(resolveMethod('Teleport')).toBeUndefined()
    expect(legacyMethodReplacement('Teleport')).toBeUndefined()
  })
})

describe('part parsing', () => {
  it('reads a text part by member presence', () => {
    expect(parsePart({ text: 'hello' })).toEqual({ text: 'hello' })
  })

  it('carries mediaType and metadata alongside any content member', () => {
    expect(parsePart({ text: 'hello', mediaType: 'text/plain', metadata: { a: 1 } }))
      .toEqual({ text: 'hello', mediaType: 'text/plain', metadata: { a: 1 } })
  })

  it('reads a file part by url', () => {
    expect(parsePart({ url: 'https://x/a.txt', filename: 'a.txt', mediaType: 'text/plain' }))
      .toEqual({ url: 'https://x/a.txt', filename: 'a.txt', mediaType: 'text/plain' })
  })

  it('reads a file part by inline raw bytes', () => {
    expect(parsePart({ raw: 'aGk=', filename: 'a.bin' }))
      .toEqual({ raw: 'aGk=', filename: 'a.bin' })
  })

  it('reads a data part', () => {
    expect(parsePart({ data: { n: 1 } })).toEqual({ data: { n: 1 } })
  })

  it('rejects the retired v0.3 nested file spelling', () => {
    expect(parsePart({ kind: 'file', file: { name: 'a.txt', uri: 'https://x/a.txt' } }))
      .toBeUndefined()
  })

  it('reads a v0.3 text part only because its member name survived the rename', () => {
    // `kind` is ignored, not honored: the part is usable purely because v1.0
    // spells the text member the same way.
    expect(parsePart({ kind: 'text', text: 'hello' })).toEqual({ text: 'hello' })
  })

  it('returns undefined for an unrecognizable part instead of throwing', () => {
    expect(parsePart({ kind: 'hologram' })).toBeUndefined()
    expect(parsePart(null)).toBeUndefined()
    expect(parsePart('text')).toBeUndefined()
  })
})

describe('parts to model-visible text', () => {
  it('joins text parts with newlines', () => {
    expect(partsToText([{ text: 'a' }, { text: 'b' }])).toBe('a\nb')
  })

  it('renders non-text parts as bracketed references rather than dropping them', () => {
    const text = partsToText([
      { text: 'see' },
      { url: 'https://x/a.txt', filename: 'a.txt', mediaType: 'text/plain' },
      { data: { n: 1 } },
    ])
    expect(text).toBe('see\n[file name=a.txt mediaType=text/plain]\n[data {"n":1}]')
  })

  it('skips empty text parts', () => {
    expect(partsToText([{ text: '' }])).toBe('')
  })
})

describe('SendMessageRequest parsing', () => {
  it('parses a v1.0 request', () => {
    const parsed = parseSendMessageRequest({
      message: {
        messageId: 'm1',
        role: 'ROLE_USER',
        parts: [{ text: 'hi' }],
        contextId: 'ctx-1',
      },
    })
    expect(parsed?.message.role).toBe('ROLE_USER')
    expect(parsed?.message.contextId).toBe('ctx-1')
    expect(partsToText(parsed!.message.parts)).toBe('hi')
  })

  it('reads the agent role in its v1.0 spelling only', () => {
    expect(parseSendMessageRequest({
      message: { messageId: 'm1', role: 'ROLE_AGENT', parts: [] },
    })?.message.role).toBe('ROLE_AGENT')
    // The v0.3 spelling is not a role this server recognizes.
    expect(parseSendMessageRequest({
      message: { messageId: 'm1', role: 'agent', parts: [] },
    })?.message.role).toBe('ROLE_USER')
  })

  it('ignores a top-level contextId, which v1.0 does not define', () => {
    const parsed = parseSendMessageRequest({
      contextId: 'legacy',
      message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }] },
    })
    expect(parsed?.message.contextId).toBeUndefined()
  })

  it('reads the task a message continues', () => {
    const parsed = parseSendMessageRequest({
      message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }], taskId: 't-1' },
    })
    expect(parsed?.message.taskId).toBe('t-1')
  })

  it('carries the configuration through untouched', () => {
    const parsed = parseSendMessageRequest({
      message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }] },
      configuration: { returnImmediately: true, historyLength: 3 },
    })
    expect(parsed?.configuration?.returnImmediately).toBe(true)
    expect(parsed?.configuration?.historyLength).toBe(3)
  })

  it('rejects params without a message object', () => {
    expect(parseSendMessageRequest({})).toBeUndefined()
    expect(parseSendMessageRequest(null)).toBeUndefined()
  })

  it('yields an empty parts list when every part is unrecognizable', () => {
    const parsed = parseSendMessageRequest({
      message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ kind: 'hologram' }] },
    })
    expect(parsed?.message.parts).toEqual([])
  })
})

describe('ListTasks parameter parsing', () => {
  it('accepts an absent params object as "no filters"', () => {
    expect(parseListTasksParams(undefined)).toEqual({})
  })

  it('reads every documented filter', () => {
    expect(parseListTasksParams({
      contextId: 'c1',
      status: 'TASK_STATE_WORKING',
      pageSize: 10,
      pageToken: 'tok',
      statusTimestampAfter: '2026-08-17T00:00:00.000Z',
      includeArtifacts: true,
    })).toEqual({
      contextId: 'c1',
      status: 'TASK_STATE_WORKING',
      pageSize: 10,
      pageToken: 'tok',
      statusTimestampAfter: '2026-08-17T00:00:00.000Z',
      includeArtifacts: true,
    })
  })

  it('clamps pageSize into the spec window rather than refusing the call', () => {
    expect(parseListTasksParams({ pageSize: 500 }).pageSize).toBe(100)
    expect(parseListTasksParams({ pageSize: 0 }).pageSize).toBe(1)
  })

  it('drops a status that is not a TaskState', () => {
    expect(parseListTasksParams({ status: 'working' }).status).toBeUndefined()
  })
})

describe('tenant routing', () => {
  it('reports a tenant a peer named', () => {
    expect(parseTenant({ tenant: 'blue' })).toBe('blue')
  })

  it('reports nothing when correctly omitted', () => {
    expect(parseTenant({})).toBeUndefined()
    expect(parseTenant({ tenant: '' })).toBeUndefined()
  })
})

describe('terminal states', () => {
  it('classifies each state', () => {
    expect(isTerminal('TASK_STATE_COMPLETED')).toBe(true)
    expect(isTerminal('TASK_STATE_CANCELED')).toBe(true)
    expect(isTerminal('TASK_STATE_FAILED')).toBe(true)
    expect(isTerminal('TASK_STATE_REJECTED')).toBe(true)
    expect(isTerminal('TASK_STATE_WORKING')).toBe(false)
    expect(isTerminal('TASK_STATE_SUBMITTED')).toBe(false)
    // Interrupted, not finished: the peer may still supply what is missing.
    expect(isTerminal('TASK_STATE_INPUT_REQUIRED')).toBe(false)
    expect(isTerminal('TASK_STATE_AUTH_REQUIRED')).toBe(false)
  })
})

const task: A2ATask = {
  id: A2ATaskId('t1'),
  contextId: A2AContextId('c1'),
  status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-08-17T00:00:00.000Z' },
  artifacts: [{ artifactId: 'a1', parts: [{ text: 'done' }] }],
}

describe('stream response wrapping', () => {
  it('carries no kind discriminator on the task itself', () => {
    expect(task).not.toHaveProperty('kind')
  })

  it('identifies an opening frame by its task member', () => {
    expect(streamTask(task)).toEqual({ task })
  })

  it('identifies a transition by its statusUpdate member, with no final flag', () => {
    const wrapped = streamStatusUpdate({
      taskId: A2ATaskId('t1'),
      contextId: A2AContextId('c1'),
      status: { state: 'TASK_STATE_WORKING', timestamp: '2026-08-17T00:00:00.000Z' },
    })
    expect(wrapped).toEqual({
      statusUpdate: {
        taskId: 't1',
        contextId: 'c1',
        status: { state: 'TASK_STATE_WORKING', timestamp: '2026-08-17T00:00:00.000Z' },
      },
    })
    expect((wrapped as unknown as { statusUpdate: Record<string, unknown> }).statusUpdate)
      .not.toHaveProperty('final')
  })
})

describe('error details', () => {
  it('names the reason and domain a client branches on', () => {
    expect(errorDetails('TASK_NOT_FOUND', { taskId: 't1' })).toEqual([{
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'TASK_NOT_FOUND',
      domain: 'a2a-protocol.org',
      metadata: { taskId: 't1' },
    }])
  })
})

describe('agent card', () => {
  const input = {
    name: 'dsh-harness',
    description: 'test agent',
    version: '0.1.0',
    url: 'https://agents.example.com/a2a',
    skills: [],
    streaming: true,
    pushNotifications: false,
    authRequired: true,
  }

  it('declares its endpoint through supportedInterfaces', () => {
    const card = buildAgentCard(input)
    expect(card.supportedInterfaces).toEqual([
      { url: input.url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ])
  })

  it('carries none of the members v1.0 removed', () => {
    const card = buildAgentCard(input) as unknown as Record<string, unknown>
    expect(card['protocolVersion']).toBeUndefined()
    expect(card['url']).toBeUndefined()
    expect(card['preferredTransport']).toBeUndefined()
    expect(card['additionalInterfaces']).toBeUndefined()
    expect(card['supportsAuthenticatedExtendedCard']).toBeUndefined()
    expect(card['security']).toBeUndefined()
  })

  it('falls back to one general skill rather than advertising none', () => {
    expect(buildAgentCard(input).skills).toEqual([FALLBACK_SKILL])
  })

  it('declares the bearer scheme in its v1.0 wrapper', () => {
    const card = buildAgentCard(input)
    expect(card.securitySchemes).toEqual({
      bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
    })
    expect(card.securityRequirements).toEqual([{ schemes: { bearer: { list: [] } } }])
  })

  it('omits the security block when no credential is required', () => {
    const card = buildAgentCard({ ...input, authRequired: false })
    expect(card.securitySchemes).toBeUndefined()
    expect(card.securityRequirements).toBeUndefined()
  })

  it('never advertises capabilities it does not serve', () => {
    const card = buildAgentCard(input)
    expect(card.capabilities.pushNotifications).toBe(false)
    expect(card.capabilities.extendedAgentCard).toBe(false)
  })
})

describe('extended agent card', () => {
  const input = {
    name: 'dsh-harness',
    description: 'test agent',
    version: '0.1.0',
    url: 'https://agents.example.com/a2a',
    skills: [{ id: 'public', name: 'public', description: '', tags: [] }],
    streaming: true,
    pushNotifications: false,
    authRequired: true,
  }

  it('does not exist when no extended skills are declared', () => {
    expect(buildExtendedAgentCard(input)).toBeUndefined()
    expect(buildAgentCard(input).capabilities.extendedAgentCard).toBe(false)
  })

  it('appends the withheld skills once declared', () => {
    const withExtended = {
      ...input,
      extendedSkills: [{ id: 'private', name: 'private', description: '', tags: [] }],
    }
    expect(buildAgentCard(withExtended).skills.map(s => s.id)).toEqual(['public'])
    expect(buildAgentCard(withExtended).capabilities.extendedAgentCard).toBe(true)
    expect(buildExtendedAgentCard(withExtended)?.skills.map(s => s.id))
      .toEqual(['public', 'private'])
  })
})

describe('sse framing', () => {
  it('wraps the payload in a JSON-RPC envelope and terminates the frame', () => {
    const frame = sseFrame(7, streamTask(task))
    expect(frame.startsWith('data: {"jsonrpc":"2.0","id":7,"result":{"task":')).toBe(true)
    expect(frame.endsWith('\n\n')).toBe(true)
  })

  it('emits no raw newline that would truncate the frame', () => {
    const frame = sseFrame(1, streamTask({
      ...task,
      artifacts: [{ artifactId: 'a1', parts: [{ text: 'a\nb' }] }],
    }))
    expect(frame.split('\n\n')).toHaveLength(2)
    expect(frame).toContain('a\\nb')
  })
})
