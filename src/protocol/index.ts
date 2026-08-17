/**
 * The A2A wire protocol as a dependency-free library.
 *
 * Nothing here touches Cordis, HTTP, or the harness: it is types, framing,
 * dialect normalization, and document construction, so the spec's own JSON
 * examples can be used as golden tests without booting anything.
 *
 * @module dsh-a2a/protocol
 */

export { A2AContextId, A2ATaskId } from './brand.ts'
export type { A2AContextId as A2AContextIdType, A2ATaskId as A2ATaskIdType } from './brand.ts'

export {
  TERMINAL_STATES,
  isTerminal,
} from './wire.ts'
export type {
  A2AAgentCard,
  A2AAgentSkill,
  A2AArtifact,
  A2ADataPart,
  A2ADialect,
  A2AFilePart,
  A2AMessage,
  A2AMessageSendConfiguration,
  A2AMessageSendParams,
  A2APart,
  A2APushNotificationConfig,
  A2ARole,
  A2AStreamEvent,
  A2ATask,
  A2ATaskArtifactUpdateEvent,
  A2ATaskState,
  A2ATaskStatus,
  A2ATaskStatusUpdateEvent,
  A2ATextPart,
} from './wire.ts'

export {
  A2ARpcError,
  ERR_CONTENT_TYPE_NOT_SUPPORTED,
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE,
  ERR_PUSH_NOT_SUPPORTED,
  ERR_TASK_NOT_CANCELABLE,
  ERR_TASK_NOT_FOUND,
  ERR_UNSUPPORTED_OPERATION,
  invalidParams,
  jsonRpcError,
  jsonRpcResult,
  taskNotFound,
} from './jsonrpc.ts'
export type { JsonRpcFailure, JsonRpcRequest, JsonRpcResponse, JsonRpcSuccess } from './jsonrpc.ts'

export {
  parsePart,
  parseSendParams,
  partsToText,
  renderArtifactUpdate,
  renderStatusUpdate,
  renderTask,
  resolveMethod,
} from './normalize.ts'
export type { A2AOperation } from './normalize.ts'

export { buildAgentCard, FALLBACK_SKILL } from './card.ts'
export type { CardInput } from './card.ts'

export { sseFrame } from './sse.ts'

/** ISO 8601 UTC with millisecond precision, the timestamp shape A2A uses. */
export function nowIso(): string {
  return new Date().toISOString()
}
