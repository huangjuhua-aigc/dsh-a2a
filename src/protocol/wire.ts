/**
 * The A2A v1.0 wire vocabulary.
 *
 * There is exactly ONE shape in this server. v1.0 removed the `kind`
 * discriminator, renamed every enum to its ProtoJSON spelling, and flattened
 * `Part` into a single unified message — so the JSON these types describe is
 * the JSON that goes on the wire, with no translation layer between them.
 * That is the whole reason the v0.3 dialect machinery is gone: it existed only
 * to bridge two spellings, and this server now speaks one.
 *
 * @module dsh-a2a/protocol/wire
 */

import type { A2AContextId, A2ATaskId } from './brand.ts'

/**
 * The single A2A protocol version this server implements.
 *
 * Major.Minor only: the spec states patch numbers do not affect compatibility
 * and SHOULD NOT appear in requests, responses, or Agent Cards.
 */
export const A2A_PROTOCOL_VERSION = '1.0'

/** Task lifecycle state, in the ProtoJSON enum spelling v1.0 requires. */
export type A2ATaskState =
  | 'TASK_STATE_UNSPECIFIED'
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_REJECTED'

/** Every state a peer may name, e.g. as the `ListTasks` status filter. */
export const TASK_STATES: readonly A2ATaskState[] = [
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_FAILED',
  'TASK_STATE_REJECTED',
]

/** States after which a task accepts no further transition. */
export const TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set<A2ATaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_FAILED',
  'TASK_STATE_REJECTED',
])

/**
 * Whether a state is terminal.
 * @param state - the state to test.
 * @returns true when no further transition is accepted.
 */
export function isTerminal(state: A2ATaskState): boolean {
  return TERMINAL_STATES.has(state)
}

/** Message author, in the ProtoJSON enum spelling. */
export type A2ARole = 'ROLE_USER' | 'ROLE_AGENT'

/**
 * A text segment of a message or artifact.
 *
 * v1.0 unified the three part types into one message whose content member IS
 * the discriminator, so these three interfaces narrow on member presence
 * (`'text' in part`) rather than on a `kind` tag that no longer exists.
 */
export interface A2ATextPart {
  text: string
  mediaType?: string
  metadata?: Record<string, unknown>
}

/** A file reference (`url`) or inline base64 payload (`raw`). */
export interface A2AFilePart {
  url?: string
  raw?: string
  filename?: string
  mediaType?: string
  metadata?: Record<string, unknown>
}

/** Structured JSON carried beside the text. */
export interface A2ADataPart {
  data: unknown
  mediaType?: string
  metadata?: Record<string, unknown>
}

/** Any message or artifact segment. Exactly one content member is set. */
export type A2APart = A2ATextPart | A2AFilePart | A2ADataPart

/** One message in a task's history. */
export interface A2AMessage {
  messageId: string
  role: A2ARole
  parts: A2APart[]
  taskId?: A2ATaskId
  contextId?: A2AContextId
  metadata?: Record<string, unknown>
  extensions?: string[]
  referenceTaskIds?: string[]
}

/** A named output the agent produced for a task. */
export interface A2AArtifact {
  artifactId: string
  name?: string
  description?: string
  parts: A2APart[]
  metadata?: Record<string, unknown>
  extensions?: string[]
}

/** Current state plus the message that explains it. */
export interface A2ATaskStatus {
  state: A2ATaskState
  message?: A2AMessage
  timestamp: string
}

/** The unit of work a peer submits and polls. */
export interface A2ATask {
  id: A2ATaskId
  contextId: A2AContextId
  status: A2ATaskStatus
  history?: A2AMessage[]
  artifacts?: A2AArtifact[]
  metadata?: Record<string, unknown>
}

/**
 * A streamed state transition.
 *
 * v1.0 removed the `final` flag: the stream's own closure is what tells a peer
 * the task reached a terminal state, so a server that keeps a stream open after
 * a terminal status is the bug, not a missing boolean.
 */
export interface A2ATaskStatusUpdateEvent {
  taskId: A2ATaskId
  contextId: A2AContextId
  status: A2ATaskStatus
  metadata?: Record<string, unknown>
}

/** A streamed artifact, optionally appended to an earlier chunk. */
export interface A2ATaskArtifactUpdateEvent {
  taskId: A2ATaskId
  contextId: A2AContextId
  artifact: A2AArtifact
  /** Position of this artifact in the task's `artifacts` array. */
  index?: number
  append?: boolean
  lastChunk?: boolean
  metadata?: Record<string, unknown>
}

/**
 * One frame of a stream, wrapped so the member name identifies the event type.
 *
 * Exactly one member is set. This replaces v0.3's `kind` tag, and it is why
 * the router never writes a bare event onto a stream.
 */
export type A2AStreamResponse =
  | { task: A2ATask }
  | { message: A2AMessage }
  | { statusUpdate: A2ATaskStatusUpdateEvent }
  | { artifactUpdate: A2ATaskArtifactUpdateEvent }

/**
 * Wrap a task as the opening frame of a stream.
 * @param task - the task the stream follows.
 * @returns the StreamResponse to serialize.
 */
export function streamTask(task: A2ATask): A2AStreamResponse {
  return { task }
}

/**
 * Wrap a status transition as a stream frame.
 * @param event - the transition.
 * @returns the StreamResponse to serialize.
 */
export function streamStatusUpdate(event: A2ATaskStatusUpdateEvent): A2AStreamResponse {
  return { statusUpdate: event }
}

/**
 * Wrap an artifact as a stream frame.
 * @param event - the artifact event.
 * @returns the StreamResponse to serialize.
 */
export function streamArtifactUpdate(event: A2ATaskArtifactUpdateEvent): A2AStreamResponse {
  return { artifactUpdate: event }
}

/** The result of `SendMessage`: a task to track, or a direct reply. */
export type A2ASendMessageResponse = { task: A2ATask } | { message: A2AMessage }

/** Webhook registration a peer supplies for terminal-state callbacks. */
export interface A2APushNotificationConfig {
  id?: string
  url: string
  token?: string
  authentication?: { schemes: string[]; credentials?: string }
}

/** A push configuration bound to a task. Flattened in v1.0. */
export interface A2ATaskPushNotificationConfig {
  taskId?: string
  id?: string
  pushNotificationConfig?: A2APushNotificationConfig
}

/** Per-request knobs carried beside the message on `SendMessage`. */
export interface A2ASendMessageConfiguration {
  acceptedOutputModes?: string[]
  historyLength?: number
  taskPushNotificationConfig?: A2ATaskPushNotificationConfig
  /**
   * Whether to answer before the task settles.
   *
   * v1.0 inverted v0.3's `blocking`: operations are BLOCKING by default, and a
   * client opts out. Unset therefore means "wait", not "return now".
   */
  returnImmediately?: boolean
}

/** Parameters of `SendMessage` and `SendStreamingMessage`. */
export interface A2ASendMessageRequest {
  message: A2AMessage
  configuration?: A2ASendMessageConfiguration
  metadata?: Record<string, unknown>
}

/** Parameters of `ListTasks`. */
export interface A2AListTasksParams {
  contextId?: string
  status?: A2ATaskState
  pageSize?: number
  pageToken?: string
  historyLength?: number
  statusTimestampAfter?: string
  includeArtifacts?: boolean
}

/** The result of `ListTasks`. Cursor-paginated, newest first. */
export interface A2AListTasksResult {
  tasks: A2ATask[]
  /** Empty string, never absent, when this is the last page. */
  nextPageToken: string
  pageSize: number
  totalSize: number
}

/** One capability this agent advertises on its card. */
export interface A2AAgentSkill {
  id: string
  name: string
  description: string
  tags: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
}

/**
 * One transport this agent answers on.
 *
 * v1.0 folded `url`, `preferredTransport`, `additionalInterfaces`, and the
 * card-level `protocolVersion` into this one repeated field: a version is a
 * property of an interface, not of an agent.
 */
export interface A2AAgentInterface {
  url: string
  protocolBinding: string
  protocolVersion: string
  tenant?: string
}

/** Which schemes a caller must satisfy, and with which scopes. */
export interface A2ASecurityRequirement {
  schemes: Record<string, { list: string[] }>
}

/** Optional features a peer may rely on. */
export interface A2AAgentCapabilities {
  streaming?: boolean
  pushNotifications?: boolean
  extensions?: { uri: string; description?: string; required?: boolean }[]
  /** v1.0 home of what v0.3 spelled `supportsAuthenticatedExtendedCard`. */
  extendedAgentCard?: boolean
}

/** The public description a peer fetches before talking to us. */
export interface A2AAgentCard {
  name: string
  description: string
  /** Ordered; the first entry is the preferred interface. Required in v1.0. */
  supportedInterfaces: A2AAgentInterface[]
  provider?: { organization: string; url: string }
  version: string
  documentationUrl?: string
  capabilities: A2AAgentCapabilities
  securitySchemes?: Record<string, unknown>
  securityRequirements?: A2ASecurityRequirement[]
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: A2AAgentSkill[]
  iconUrl?: string
}
