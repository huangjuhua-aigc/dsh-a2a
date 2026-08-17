/**
 * A2A wire vocabulary, normalized to the v0.3.0 spelling.
 *
 * The server speaks one internal shape. Requests in either dialect are parsed
 * into these types on the way in ({@link ./normalize.ts}), and responses are
 * rendered back into the caller's dialect on the way out. No plugin module
 * outside `protocol/` sees a v1.0 spelling.
 *
 * @module dsh-a2a/protocol/wire
 */

import type { A2AContextId, A2ATaskId } from './brand.ts'

/** Task lifecycle state, in the v0.3 JSON spelling. */
export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'

/** States after which a task accepts no further transition. */
export const TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set<A2ATaskState>([
  'completed',
  'canceled',
  'failed',
  'rejected',
])

/**
 * Whether a state is terminal.
 * @param state - the state to test.
 * @returns true when no further transition is accepted.
 */
export function isTerminal(state: A2ATaskState): boolean {
  return TERMINAL_STATES.has(state)
}

/** Message author, in the v0.3 JSON spelling. */
export type A2ARole = 'user' | 'agent'

/** Which spelling a peer used; every response echoes the request's dialect. */
export type A2ADialect = 'v0.3' | 'v1.0'

/** A text segment of a message or artifact. */
export interface A2ATextPart {
  kind: 'text'
  text: string
}

/** A file reference or inline payload. */
export interface A2AFilePart {
  kind: 'file'
  file: { name?: string; mimeType?: string; uri?: string; bytes?: string }
}

/** Structured JSON carried beside the text. */
export interface A2ADataPart {
  kind: 'data'
  data: unknown
}

/** Any message or artifact segment. */
export type A2APart = A2ATextPart | A2AFilePart | A2ADataPart

/** One message in a task's history. */
export interface A2AMessage {
  kind: 'message'
  messageId: string
  role: A2ARole
  parts: A2APart[]
  taskId?: A2ATaskId
  contextId?: A2AContextId
  metadata?: Record<string, unknown>
}

/** A named output the agent produced for a task. */
export interface A2AArtifact {
  artifactId: string
  name?: string
  description?: string
  parts: A2APart[]
  metadata?: Record<string, unknown>
}

/** Current state plus the message that explains it. */
export interface A2ATaskStatus {
  state: A2ATaskState
  message?: A2AMessage
  timestamp: string
}

/** The unit of work a peer submits and polls. */
export interface A2ATask {
  kind: 'task'
  id: A2ATaskId
  contextId: A2AContextId
  status: A2ATaskStatus
  history?: A2AMessage[]
  artifacts?: A2AArtifact[]
  metadata?: Record<string, unknown>
}

/** A streamed state transition. `final` closes the stream. */
export interface A2ATaskStatusUpdateEvent {
  kind: 'status-update'
  taskId: A2ATaskId
  contextId: A2AContextId
  status: A2ATaskStatus
  final: boolean
  metadata?: Record<string, unknown>
}

/** A streamed artifact, optionally appended to an earlier chunk. */
export interface A2ATaskArtifactUpdateEvent {
  kind: 'artifact-update'
  taskId: A2ATaskId
  contextId: A2AContextId
  artifact: A2AArtifact
  append?: boolean
  lastChunk?: boolean
  metadata?: Record<string, unknown>
}

/** Anything the server may push over an SSE stream. */
export type A2AStreamEvent =
  | A2ATask
  | A2AMessage
  | A2ATaskStatusUpdateEvent
  | A2ATaskArtifactUpdateEvent

/** Webhook registration a peer supplies for terminal-state callbacks. */
export interface A2APushNotificationConfig {
  id?: string
  url: string
  token?: string
  authentication?: { schemes: string[]; credentials?: string }
}

/** Per-request knobs carried beside the message on `message/send`. */
export interface A2AMessageSendConfiguration {
  acceptedOutputModes?: string[]
  historyLength?: number
  pushNotificationConfig?: A2APushNotificationConfig
  blocking?: boolean
}

/** Parameters of `message/send` and `message/stream`. */
export interface A2AMessageSendParams {
  message: A2AMessage
  configuration?: A2AMessageSendConfiguration
  metadata?: Record<string, unknown>
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

/** The public description a peer fetches before talking to us. */
export interface A2AAgentCard {
  protocolVersion: string
  name: string
  description: string
  version: string
  url: string
  preferredTransport: string
  supportedInterfaces?: { url: string; protocolBinding: string; protocolVersion: string }[]
  provider?: { organization: string; url: string }
  capabilities: {
    streaming: boolean
    pushNotifications: boolean
    stateTransitionHistory: boolean
  }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: A2AAgentSkill[]
  securitySchemes?: Record<string, unknown>
  security?: Record<string, string[]>[]
}
