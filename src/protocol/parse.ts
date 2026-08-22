/**
 * Inbound parsing: peer JSON to the internal v1.0 shape.
 *
 * There is no outbound counterpart. v0.3 needed one because two spellings had
 * to be reconciled; this server speaks v1.0 only, so what {@link ./wire.ts}
 * describes is what gets serialized, and the only work left is validating what
 * arrives.
 *
 * Parsing is permissive about what it IGNORES (unknown members are skipped, as
 * the spec's forward-compatibility rule requires) and strict about what it
 * ACCEPTS: a v0.3 spelling is not quietly translated, because a peer that
 * believes it is talking v0.3 to a v1.0-only agent needs to be told.
 *
 * @module dsh-a2a/protocol/parse
 */

import { A2AContextId, A2ATaskId } from './brand.ts'
import { TASK_STATES } from './wire.ts'
import type {
  A2AListTasksParams,
  A2AMessage,
  A2APart,
  A2ASendMessageConfiguration,
  A2ASendMessageRequest,
  A2ATaskState,
} from './wire.ts'

/** The internal operation a peer's method name resolves to. */
export type A2AOperation =
  | 'send'
  | 'stream'
  | 'get'
  | 'list'
  | 'cancel'
  | 'subscribe'
  | 'push_create'
  | 'push_get'
  | 'push_list'
  | 'push_delete'
  | 'extended_card'

/**
 * Every method this server answers, in the v1.0 PascalCase spelling.
 *
 * The names match the gRPC service methods exactly, which is the point of the
 * v1.0 renaming: one operation has one name across all three bindings.
 */
const METHODS: ReadonlyMap<string, A2AOperation> = new Map<string, A2AOperation>([
  ['SendMessage', 'send'],
  ['SendStreamingMessage', 'stream'],
  ['GetTask', 'get'],
  ['ListTasks', 'list'],
  ['CancelTask', 'cancel'],
  ['SubscribeToTask', 'subscribe'],
  ['CreateTaskPushNotificationConfig', 'push_create'],
  ['GetTaskPushNotificationConfig', 'push_get'],
  ['ListTaskPushNotificationConfigs', 'push_list'],
  ['DeleteTaskPushNotificationConfig', 'push_delete'],
  ['GetExtendedAgentCard', 'extended_card'],
])

/**
 * The v0.3 names, kept only to explain their absence.
 *
 * A peer that sends `message/send` gets a method-not-found naming its v1.0
 * replacement. Answering the call would be worse: the reply would be v1.0
 * JSON that a v0.3 client cannot read, and the failure would surface much
 * further from its cause.
 */
const LEGACY_METHODS: ReadonlyMap<string, string> = new Map([
  ['message/send', 'SendMessage'],
  ['message/stream', 'SendStreamingMessage'],
  ['tasks/get', 'GetTask'],
  ['tasks/cancel', 'CancelTask'],
  ['tasks/resubscribe', 'SubscribeToTask'],
  ['tasks/pushNotificationConfig/set', 'CreateTaskPushNotificationConfig'],
  ['tasks/pushNotificationConfig/get', 'GetTaskPushNotificationConfig'],
  ['tasks/pushNotificationConfig/list', 'ListTaskPushNotificationConfigs'],
  ['tasks/pushNotificationConfig/delete', 'DeleteTaskPushNotificationConfig'],
  ['tasks/pushNotification/set', 'CreateTaskPushNotificationConfig'],
  ['agent/getAuthenticatedExtendedCard', 'GetExtendedAgentCard'],
])

/**
 * Resolve a method name to its operation.
 * @param method - the raw `method` string from the request.
 * @returns the operation, or undefined for an unknown method.
 */
export function resolveMethod(method: string): A2AOperation | undefined {
  return METHODS.get(method)
}

/**
 * The v1.0 name that replaced a retired v0.3 method.
 * @param method - the raw `method` string from the request.
 * @returns the replacement name, or undefined when the method was never ours.
 */
export function legacyMethodReplacement(method: string): string | undefined {
  return LEGACY_METHODS.get(method)
}

/**
 * Read one `Part`.
 *
 * v1.0 discriminates on which content member is present, so the probes below
 * must each be specific enough not to claim another variant's shape. An
 * unrecognizable part yields undefined rather than throwing: one odd part must
 * not fail a request whose other parts are usable.
 * @param raw - one element of a `parts` array.
 * @returns the normalized part, or undefined when no content member is present.
 */
export function parsePart(raw: unknown): A2APart | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const part = raw as Record<string, unknown>
  const common = {
    ...typeof part['mediaType'] === 'string' ? { mediaType: part['mediaType'] } : {},
    ...isObject(part['metadata']) ? { metadata: part['metadata'] } : {},
  }

  if (typeof part['text'] === 'string') return { text: part['text'], ...common }
  if (typeof part['url'] === 'string' || typeof part['raw'] === 'string') {
    return {
      ...typeof part['url'] === 'string' ? { url: part['url'] } : {},
      ...typeof part['raw'] === 'string' ? { raw: part['raw'] } : {},
      ...typeof part['filename'] === 'string' ? { filename: part['filename'] } : {},
      ...common,
    }
  }
  if ('data' in part) return { data: part['data'], ...common }
  return undefined
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
    if ('text' in part) {
      if (part.text.length > 0) chunks.push(part.text)
    } else if ('data' in part) {
      chunks.push(`[data ${JSON.stringify(part.data)}]`)
    } else {
      const name = part.filename ?? part.url ?? 'unnamed'
      const type = part.mediaType === undefined ? '' : ` mediaType=${part.mediaType}`
      chunks.push(`[file name=${name}${type}]`)
    }
  }
  return chunks.join('\n')
}

/**
 * Parse the `SendMessage` / `SendStreamingMessage` request object.
 * @param raw - the request's `params` value.
 * @returns the normalized request, or undefined when the shape is unusable.
 */
export function parseSendMessageRequest(raw: unknown): A2ASendMessageRequest | undefined {
  if (!isObject(raw)) return undefined
  const params = raw
  const rawMessage = params['message']
  if (!isObject(rawMessage)) return undefined
  const message = rawMessage

  const parts: A2APart[] = []
  if (Array.isArray(message['parts'])) {
    for (const item of message['parts']) {
      const part = parsePart(item)
      if (part !== undefined) parts.push(part)
    }
  }

  const contextId = firstString(message['contextId'])
  const taskId = firstString(message['taskId'])

  const normalized: A2AMessage = {
    messageId: firstString(message['messageId']) ?? '',
    // v1.0 spells roles ROLE_USER / ROLE_AGENT. Anything else is a peer that
    // has not migrated; treating it as a user message keeps the request usable
    // and the agent still sees a peer-authored turn.
    role: message['role'] === 'ROLE_AGENT' ? 'ROLE_AGENT' : 'ROLE_USER',
    parts,
    ...contextId === undefined ? {} : { contextId: A2AContextId(contextId) },
    ...taskId === undefined ? {} : { taskId: A2ATaskId(taskId) },
  }

  const configuration = params['configuration']
  return {
    message: normalized,
    ...isObject(configuration)
      ? { configuration: configuration as unknown as A2ASendMessageConfiguration }
      : {},
    ...isObject(params['metadata']) ? { metadata: params['metadata'] } : {},
  }
}

/**
 * Parse `ListTasks` parameters.
 *
 * Every filter is optional; an absent `params` lists everything the caller may
 * see. `pageSize` is clamped to the spec's 1..100 window rather than rejected,
 * because a client asking for 500 wants "as many as you'll give me".
 * @param raw - the request's `params` value.
 * @returns the normalized filters.
 */
export function parseListTasksParams(raw: unknown): A2AListTasksParams {
  if (!isObject(raw)) return {}
  const params = raw
  const status = typeof params['status'] === 'string' ? params['status'] : undefined
  const pageSize = typeof params['pageSize'] === 'number' && Number.isFinite(params['pageSize'])
    ? Math.min(100, Math.max(1, Math.floor(params['pageSize'])))
    : undefined
  return {
    ...firstString(params['contextId']) === undefined
      ? {}
      : { contextId: firstString(params['contextId'])! },
    ...status !== undefined && (TASK_STATES as readonly string[]).includes(status)
      ? { status: status as A2ATaskState }
      : {},
    ...pageSize === undefined ? {} : { pageSize },
    ...firstString(params['pageToken']) === undefined
      ? {}
      : { pageToken: firstString(params['pageToken'])! },
    ...typeof params['historyLength'] === 'number'
      ? { historyLength: params['historyLength'] }
      : {},
    ...firstString(params['statusTimestampAfter']) === undefined
      ? {}
      : { statusTimestampAfter: firstString(params['statusTimestampAfter'])! },
    ...typeof params['includeArtifacts'] === 'boolean'
      ? { includeArtifacts: params['includeArtifacts'] }
      : {},
  }
}

/**
 * Read the `tenant` routing member.
 *
 * This card declares no tenant on its interface, so the spec's rule ("clients
 * MUST include this value ... omit the field if tenant is not set") makes any
 * non-empty tenant a misrouted request. Reporting it beats silently serving a
 * peer that believes it reached a different agent.
 * @param raw - the request's `params` value.
 * @returns the tenant a peer asked for, or undefined when correctly omitted.
 */
export function parseTenant(raw: unknown): string | undefined {
  if (!isObject(raw)) return undefined
  return firstString(raw['tenant'])
}

/**
 * Whether a value is a plain object usable as a JSON map.
 * @param value - the candidate.
 * @returns true for non-null, non-array objects.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
