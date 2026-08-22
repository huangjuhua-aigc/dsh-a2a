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
 * v1.0 additionally requires that A2A-specific failures carry a machine-
 * readable reason in `error.data`, as a `google.rpc.ErrorInfo` object. That is
 * what {@link A2ARpcError.reason} feeds.
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
export const ERR_INVALID_AGENT_RESPONSE = -32006
export const ERR_EXTENDED_CARD_NOT_CONFIGURED = -32007
export const ERR_EXTENSION_SUPPORT_REQUIRED = -32008
export const ERR_VERSION_NOT_SUPPORTED = -32009

/** The domain every A2A `ErrorInfo` detail is scoped to. */
export const A2A_ERROR_DOMAIN = 'a2a-protocol.org'

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
 * @param data - optional structured detail, already in the details-array shape.
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

/**
 * Build the `error.data` details array for an A2A-specific failure.
 *
 * v1.0 models error details on `google.rpc.Status`: an array of typed objects,
 * each naming its type through `@type`. The reason is the UPPER_SNAKE_CASE form
 * of the A2A error name, which is what lets a client branch on the failure
 * without string-matching the human-readable message.
 * @param reason - the A2A error reason, e.g. `TASK_NOT_FOUND`.
 * @param metadata - additional string context, e.g. the offending id.
 * @returns the details array.
 */
export function errorDetails(
  reason: string,
  metadata?: Record<string, string>,
): unknown[] {
  return [{
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason,
    domain: A2A_ERROR_DOMAIN,
    ...metadata === undefined ? {} : { metadata },
  }]
}

/** An error carrying the JSON-RPC code and A2A reason a handler wants reported. */
export class A2ARpcError extends Error {
  /**
   * @param code - the JSON-RPC or A2A error code.
   * @param message - the human-readable explanation.
   * @param options - the A2A reason and metadata for `error.data`, plus the
   * HTTP status to answer with; the status defaults to 200 because an ordinary
   * JSON-RPC error is a successful HTTP exchange.
   */
  constructor(
    readonly code: number,
    message: string,
    readonly options: {
      reason?: string
      metadata?: Record<string, string>
      httpStatus?: number
    } = {},
  ) {
    super(message)
    this.name = 'A2ARpcError'
  }

  /** The HTTP status this failure should be answered with. */
  get httpStatus(): number {
    return this.options.httpStatus ?? 200
  }

  /** The `error.data` details array, or undefined when no reason is carried. */
  get data(): unknown[] | undefined {
    if (this.options.reason === undefined) return undefined
    return errorDetails(this.options.reason, this.options.metadata)
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
  return new A2ARpcError(ERR_TASK_NOT_FOUND, `task not found: ${taskId}`, {
    reason: 'TASK_NOT_FOUND',
    metadata: { taskId },
  })
}

/**
 * Report an A2A-Version this interface does not implement.
 * @param requested - the version the peer asked for.
 * @param supported - the version this interface serves.
 * @returns the error to throw.
 */
export function versionNotSupported(requested: string, supported: string): A2ARpcError {
  return new A2ARpcError(
    ERR_VERSION_NOT_SUPPORTED,
    `unsupported A2A-Version: ${requested}; this interface serves ${supported}`,
    { reason: 'VERSION_NOT_SUPPORTED', metadata: { requested, supported } },
  )
}

/**
 * Report an operation this deployment does not perform.
 * @param detail - what was refused, and why.
 * @returns the error to throw.
 */
export function unsupportedOperation(detail: string): A2ARpcError {
  return new A2ARpcError(ERR_UNSUPPORTED_OPERATION, detail, {
    reason: 'UNSUPPORTED_OPERATION',
  })
}
