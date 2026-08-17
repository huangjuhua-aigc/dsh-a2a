/**
 * Dialect normalization between A2A v0.3.0 and v1.0.
 *
 * Inbound is permissive, outbound is strict: a request in either spelling is
 * parsed into the internal v0.3 shape, and the response is rendered back in the
 * dialect that request declared. Nothing mixes the two spellings in one reply.
 *
 * @module dsh-a2a/protocol/normalize
 */

import { A2AContextId, A2ATaskId } from './brand.ts'
import type {
  A2ADialect,
  A2AFilePart,
  A2AMessage,
  A2AMessageSendParams,
  A2APart,
  A2ARole,
  A2ATask,
  A2ATaskState,
  A2ATaskStatusUpdateEvent,
  A2ATaskArtifactUpdateEvent,
} from './wire.ts'

/** The internal operation a peer's method name resolves to. */
export type A2AOperation =
  | 'send'
  | 'stream'
  | 'get'
  | 'cancel'
  | 'resubscribe'
  | 'push_set'
  | 'push_get'
  | 'push_list'
  | 'push_delete'

/** One row of the method table: which operation, and which dialect it implies. */
interface MethodEntry {
  operation: A2AOperation
  dialect: A2ADialect
}

/**
 * Every method spelling this server answers.
 *
 * v0.3 is the mainline; the v1.0 PascalCase names are accepted so a peer built
 * against the newer spec interoperates without a shim on its side.
 */
const METHODS: ReadonlyMap<string, MethodEntry> = new Map([
  // — v0.3.0 mainline —
  ['message/send', { operation: 'send', dialect: 'v0.3' }],
  ['message/stream', { operation: 'stream', dialect: 'v0.3' }],
  ['tasks/get', { operation: 'get', dialect: 'v0.3' }],
  ['tasks/cancel', { operation: 'cancel', dialect: 'v0.3' }],
  ['tasks/resubscribe', { operation: 'resubscribe', dialect: 'v0.3' }],
  ['tasks/pushNotificationConfig/set', { operation: 'push_set', dialect: 'v0.3' }],
  ['tasks/pushNotificationConfig/get', { operation: 'push_get', dialect: 'v0.3' }],
  ['tasks/pushNotificationConfig/list', { operation: 'push_list', dialect: 'v0.3' }],
  ['tasks/pushNotificationConfig/delete', { operation: 'push_delete', dialect: 'v0.3' }],
  // — v1.0 —
  ['SendMessage', { operation: 'send', dialect: 'v1.0' }],
  ['SendStreamingMessage', { operation: 'stream', dialect: 'v1.0' }],
  ['GetTask', { operation: 'get', dialect: 'v1.0' }],
  ['CancelTask', { operation: 'cancel', dialect: 'v1.0' }],
  ['SubscribeToTask', { operation: 'resubscribe', dialect: 'v1.0' }],
  ['CreateTaskPushNotificationConfig', { operation: 'push_set', dialect: 'v1.0' }],
  ['GetTaskPushNotificationConfig', { operation: 'push_get', dialect: 'v1.0' }],
  ['ListTaskPushNotificationConfigs', { operation: 'push_list', dialect: 'v1.0' }],
  ['DeleteTaskPushNotificationConfig', { operation: 'push_delete', dialect: 'v1.0' }],
  // — pre-0.3 aliases seen in the wild —
  ['tasks/pushNotification/set', { operation: 'push_set', dialect: 'v0.3' }],
])

/**
 * Resolve a method name to its operation and implied dialect.
 * @param method - the raw `method` string from the request.
 * @returns the entry, or undefined for an unknown method.
 */
export function resolveMethod(method: string): MethodEntry | undefined {
  return METHODS.get(method)
}

/** v1.0 spells task states in SCREAMING_SNAKE_CASE. */
const STATE_TO_V1: Readonly<Record<A2ATaskState, string>> = {
  'submitted': 'TASK_STATE_SUBMITTED',
  'working': 'TASK_STATE_WORKING',
  'input-required': 'TASK_STATE_INPUT_REQUIRED',
  'auth-required': 'TASK_STATE_AUTH_REQUIRED',
  'completed': 'TASK_STATE_COMPLETED',
  'canceled': 'TASK_STATE_CANCELED',
  'failed': 'TASK_STATE_FAILED',
  'rejected': 'TASK_STATE_REJECTED',
}

const ROLE_TO_V1: Readonly<Record<A2ARole, string>> = {
  user: 'ROLE_USER',
  agent: 'ROLE_AGENT',
}

/**
 * Read a `Part` written in any of the three known spellings.
 *
 * v0.3 discriminates on `kind`, v1.0 on member presence, and pre-0.3 peers used
 * `type`. Unknown shapes yield undefined rather than throwing, so one odd part
 * cannot fail a request whose other parts are usable.
 * @param raw - one element of a `parts` array.
 * @returns the normalized part, or undefined when unrecognizable.
 */
export function parsePart(raw: unknown): A2APart | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const part = raw as Record<string, unknown>
  const tag = typeof part['kind'] === 'string'
    ? part['kind']
    : typeof part['type'] === 'string' ? part['type'] : undefined

  if (tag === 'text') {
    return typeof part['text'] === 'string' ? { kind: 'text', text: part['text'] } : undefined
  }
  if (tag === 'data') return { kind: 'data', data: part['data'] }
  if (tag === 'file') return parseFilePart(part)
  if (tag !== undefined) return undefined

  // Untagged: v1.0 discriminates a part by which member is present. Order
  // matters only in that each probe must be specific enough not to claim
  // another variant's shape.
  if (typeof part['text'] === 'string') return { kind: 'text', text: part['text'] }
  const file = parseFilePart(part)
  if (file !== undefined) return file
  if ('data' in part) return { kind: 'data', data: part['data'] }
  return undefined
}

/**
 * Read a file part in either the v0.3 nested or the v1.0 flattened spelling.
 * @param part - the raw part object.
 * @returns the normalized file part, or undefined when no file member is present.
 */
function parseFilePart(part: Record<string, unknown>): A2AFilePart | undefined {
  const nested = part['file']
  if (nested !== null && typeof nested === 'object') {
    return { kind: 'file', file: nested as A2AFileShape }
  }
  const uri = part['url'] ?? part['uri']
  const bytes = part['raw'] ?? part['bytes']
  if (typeof uri !== 'string' && typeof bytes !== 'string') return undefined
  return {
    kind: 'file',
    file: {
      ...typeof uri === 'string' ? { uri } : {},
      ...typeof bytes === 'string' ? { bytes } : {},
      ...typeof part['filename'] === 'string' ? { name: part['filename'] } : {},
      ...typeof part['name'] === 'string' ? { name: part['name'] } : {},
      ...typeof part['mediaType'] === 'string' ? { mimeType: part['mediaType'] } : {},
      ...typeof part['mimeType'] === 'string' ? { mimeType: part['mimeType'] } : {},
    },
  }
}

interface A2AFileShape {
  name?: string
  mimeType?: string
  uri?: string
  bytes?: string
}

/**
 * Render every part as text the model can read.
 *
 * File and data parts become bracketed references rather than being dropped, so
 * the agent knows something was attached and can ask about it. This is the same
 * flattening `dsh-acp` applies to baseline resource links.
 * @param parts - normalized parts, in order.
 * @returns the joined text, empty when nothing rendered.
 */
export function partsToText(parts: readonly A2APart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.kind === 'text') {
      if (part.text.length > 0) chunks.push(part.text)
    } else if (part.kind === 'file') {
      const name = part.file.name ?? part.file.uri ?? 'unnamed'
      const type = part.file.mimeType === undefined ? '' : ` type=${part.file.mimeType}`
      chunks.push(`[file name=${name}${type}]`)
    } else {
      chunks.push(`[data ${JSON.stringify(part.data)}]`)
    }
  }
  return chunks.join('\n')
}

/**
 * Parse `message/send` and `message/stream` parameters from either dialect.
 * @param raw - the request's `params` value.
 * @returns the normalized parameters, or undefined when the shape is unusable.
 */
export function parseSendParams(raw: unknown): A2AMessageSendParams | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const params = raw as Record<string, unknown>
  const rawMessage = params['message']
  if (rawMessage === null || typeof rawMessage !== 'object') return undefined
  const message = rawMessage as Record<string, unknown>

  const rawParts = message['parts']
  const parts: A2APart[] = []
  if (Array.isArray(rawParts)) {
    for (const item of rawParts) {
      const part = parsePart(item)
      if (part !== undefined) parts.push(part)
    }
  }

  // v0.3 allows contextId at the top level too; the message wins when both appear.
  const contextId = firstString(message['contextId'], params['contextId'])
  const taskId = firstString(message['taskId'], params['taskId'])

  const normalized: A2AMessage = {
    kind: 'message',
    messageId: firstString(message['messageId']) ?? '',
    role: message['role'] === 'ROLE_AGENT' || message['role'] === 'agent' ? 'agent' : 'user',
    parts,
    ...contextId === undefined ? {} : { contextId: A2AContextId(contextId) },
    ...taskId === undefined ? {} : { taskId: A2ATaskId(taskId) },
  }

  const configuration = params['configuration']
  if (configuration !== null && typeof configuration === 'object') {
    return {
      message: normalized,
      configuration: configuration as NonNullable<A2AMessageSendParams['configuration']>,
    }
  }
  return { message: normalized }
}

/**
 * Return the first defined non-empty string among the candidates.
 * @param values - candidate values in precedence order.
 * @returns the winning string, or undefined.
 */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Render a task in the requested dialect.
 * @param task - the internal v0.3-shaped task.
 * @param dialect - the dialect the peer spoke.
 * @returns the wire object to serialize.
 */
export function renderTask(task: A2ATask, dialect: A2ADialect): unknown {
  if (dialect === 'v0.3') return task
  return {
    ...task,
    status: renderStatusV1(task.status),
    ...task.history === undefined ? {} : { history: task.history.map(renderMessageV1) },
  }
}

/**
 * Render a status-update stream event in the requested dialect.
 * @param event - the internal event.
 * @param dialect - the dialect the peer spoke.
 * @returns the wire object to serialize.
 */
export function renderStatusUpdate(event: A2ATaskStatusUpdateEvent, dialect: A2ADialect): unknown {
  if (dialect === 'v0.3') return event
  return { statusUpdate: { ...event, status: renderStatusV1(event.status) } }
}

/**
 * Render an artifact-update stream event in the requested dialect.
 * @param event - the internal event.
 * @param dialect - the dialect the peer spoke.
 * @returns the wire object to serialize.
 */
export function renderArtifactUpdate(
  event: A2ATaskArtifactUpdateEvent,
  dialect: A2ADialect,
): unknown {
  return dialect === 'v0.3' ? event : { artifactUpdate: event }
}

/**
 * Render a task status with v1.0 enum spellings.
 * @param status - the internal status.
 * @returns the v1.0-shaped status.
 */
function renderStatusV1(status: A2ATask['status']): unknown {
  return {
    ...status,
    state: STATE_TO_V1[status.state],
    ...status.message === undefined ? {} : { message: renderMessageV1(status.message) },
  }
}

/**
 * Render a message with v1.0 enum spellings and member-presence parts.
 * @param message - the internal message.
 * @returns the v1.0-shaped message.
 */
function renderMessageV1(message: A2AMessage): unknown {
  return {
    ...message,
    role: ROLE_TO_V1[message.role],
    parts: message.parts.map((part) => {
      if (part.kind === 'text') return { text: part.text }
      if (part.kind === 'data') return { data: part.data }
      return {
        ...part.file.uri === undefined ? {} : { url: part.file.uri },
        ...part.file.bytes === undefined ? {} : { raw: part.file.bytes },
        ...part.file.name === undefined ? {} : { filename: part.file.name },
        ...part.file.mimeType === undefined ? {} : { mediaType: part.file.mimeType },
      }
    }),
  }
}
