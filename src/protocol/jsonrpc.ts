/**
 * JSON-RPC 2.0 framing and the A2A error-code vocabulary.
 *
 * Authentication, rate limiting, and the trust gate deliberately do NOT get
 * JSON-RPC codes: A2A puts transport security at the HTTP layer, and the
 * `-32050…` range some implementations invent is not reserved, so no peer SDK
 * recognizes it. Those failures answer with an HTTP status whose body is still
 * a valid JSON-RPC error envelope, so a client that blindly parses the body
 * and one that reads the status are both served.
 *
 * @module dsh-a2a/protocol/jsonrpc
 */

/** Standard JSON-RPC 2.0 codes. */
export const ERR_PARSE = -32700
export const ERR_INVALID_REQUEST = -32600
export const ERR_METHOD_NOT_FOUND = -32601
export const ERR_INVALID_PARAMS = -32602
export const ERR_INTERNAL = -32603

/** A2A-reserved codes, used only with their spec semantics. */
export const ERR_TASK_NOT_FOUND = -32001
export const ERR_TASK_NOT_CANCELABLE = -32002
export const ERR_PUSH_NOT_SUPPORTED = -32003
export const ERR_UNSUPPORTED_OPERATION = -32004
export const ERR_CONTENT_TYPE_NOT_SUPPORTED = -32005

/** A JSON-RPC request as received from a peer. */
export interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

/** A successful JSON-RPC response. */
export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: string | number | null
  result: unknown
}

/** A failed JSON-RPC response. */
export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: string | number | null
  error: { code: number; message: string; data?: unknown }
}

/** Either shape of JSON-RPC response. */
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

/**
 * Build a success envelope.
 * @param id - the request id being answered.
 * @param result - the method's result value.
 * @returns the response envelope.
 */
export function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

/**
 * Build an error envelope.
 * @param id - the request id being answered, or null when unknown.
 * @param code - the JSON-RPC or A2A error code.
 * @param message - a human-readable explanation carrying no internal paths.
 * @param data - optional structured detail.
 * @returns the response envelope.
 */
export function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message, ...data === undefined ? {} : { data } } }
}

/** An error carrying the JSON-RPC code a handler wants reported. */
export class A2ARpcError extends Error {
  /**
   * @param code - the JSON-RPC or A2A error code.
   * @param message - the human-readable explanation.
   * @param httpStatus - the HTTP status to answer with; defaults to 200 because
   * an ordinary JSON-RPC error is a successful HTTP exchange.
   */
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus: number = 200,
  ) {
    super(message)
    this.name = 'A2ARpcError'
  }
}

/**
 * Reject a malformed or unsupported parameter.
 * @param detail - what was wrong.
 * @returns the error to throw.
 */
export function invalidParams(detail: string): A2ARpcError {
  return new A2ARpcError(ERR_INVALID_PARAMS, detail)
}

/**
 * Report a task that does not exist, or that this identity may not see.
 *
 * A task owned by another peer answers with this same error rather than a 403,
 * so a peer cannot probe which task ids exist by comparing responses.
 * @param taskId - the id the peer asked about.
 * @returns the error to throw.
 */
export function taskNotFound(taskId: string): A2ARpcError {
  return new A2ARpcError(ERR_TASK_NOT_FOUND, `task not found: ${taskId}`)
}
