/**
 * Branded identifiers for the A2A wire vocabulary.
 *
 * Branding keeps a raw string from being used where a checked id is required —
 * the same discipline `dsh-session` applies to `SessionId`.
 *
 * @module dsh-a2a/protocol/brand
 */

declare const contextIdBrand: unique symbol
declare const taskIdBrand: unique symbol

/** An A2A `contextId`. This server mints it verbatim from a `SessionId`. */
export type A2AContextId = string & { readonly [contextIdBrand]: true }

/** An A2A `Task.id`, minted per accepted message. */
export type A2ATaskId = string & { readonly [taskIdBrand]: true }

/**
 * Brand a raw string as a context id.
 * @param value - the raw identifier.
 * @returns the same string, branded.
 */
export function A2AContextId(value: string): A2AContextId {
  return value as A2AContextId
}

/**
 * Brand a raw string as a task id.
 * @param value - the raw identifier.
 * @returns the same string, branded.
 */
export function A2ATaskId(value: string): A2ATaskId {
  return value as A2ATaskId
}
