/**
 * The A2A v1.0 wire protocol as a dependency-free library.
 *
 * Nothing here touches Cordis, HTTP, or the harness: it is types, framing,
 * inbound parsing, and document construction, so the spec's own JSON examples
 * can be used as golden tests without booting anything.
 *
 * @module dsh-a2a/protocol
 */

export { A2AContextId, A2ATaskId } from './brand.ts'
export type { A2AContextId as A2AContextIdType, A2ATaskId as A2ATaskIdType } from './brand.ts'

export {
  A2A_PROTOCOL_VERSION,
  TASK_STATES,
  TERMINAL_STATES,
  isTerminal,
  streamArtifactUpdate,
  streamStatusUpdate,
  streamTask,
} from './wire.ts'
export type {
  A2AAgentCapabilities,
  A2AAgentCard,
  A2AAgentInterface,
  A2AAgentSkill,
  A2AArtifact,
  A2ADataPart,
  A2AFilePart,
  A2AListTasksParams,
  A2AListTasksResult,
  A2AMessage,
  A2APart,
  A2APushNotificationConfig,
  A2ARole,
  A2ASecurityRequirement,
  A2ASendMessageConfiguration,
  A2ASendMessageRequest,
  A2ASendMessageResponse,
  A2AStreamResponse,
  A2ATask,
  A2ATaskArtifactUpdateEvent,
  A2ATaskPushNotificationConfig,
  A2ATaskState,
  A2ATaskStatus,
  A2ATaskStatusUpdateEvent,
  A2ATextPart,
} from './wire.ts'

export {
  A2A_ERROR_DOMAIN,
  A2ARpcError,
  ERR_CONTENT_TYPE_NOT_SUPPORTED,
  ERR_EXTENDED_CARD_NOT_CONFIGURED,
  ERR_EXTENSION_SUPPORT_REQUIRED,
  ERR_INTERNAL,
  ERR_INVALID_AGENT_RESPONSE,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE,
  ERR_PUSH_NOT_SUPPORTED,
  ERR_TASK_NOT_CANCELABLE,
  ERR_TASK_NOT_FOUND,
  ERR_UNSUPPORTED_OPERATION,
  ERR_VERSION_NOT_SUPPORTED,
  errorDetails,
  invalidParams,
  jsonRpcError,
  jsonRpcResult,
  taskNotFound,
  unsupportedOperation,
  versionNotSupported,
} from './jsonrpc.ts'
export type { JsonRpcFailure, JsonRpcRequest, JsonRpcResponse, JsonRpcSuccess } from './jsonrpc.ts'

export {
  legacyMethodReplacement,
  parseListTasksParams,
  parsePart,
  parseSendMessageRequest,
  parseTenant,
  partsToText,
  resolveMethod,
} from './parse.ts'
export type { A2AOperation } from './parse.ts'

export { buildAgentCard, buildExtendedAgentCard, FALLBACK_SKILL } from './card.ts'
export type { CardInput } from './card.ts'

export { sseFrame } from './sse.ts'

/** ISO 8601 UTC with millisecond precision, the timestamp shape A2A v1.0 requires. */
export function nowIso(): string {
  return new Date().toISOString()
}
