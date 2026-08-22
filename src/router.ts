/**
 * HTTP + JSON-RPC dispatch for the A2A v1.0 binding.
 *
 * Deliberately free of Cordis: everything it needs arrives through
 * {@link RouterDeps}, so the RPC semantics can be unit-tested without booting a
 * composition or opening a socket. This is the same separation Hermes reached
 * for when it made its request handler reachable through `server.adapter`.
 *
 * @module dsh-a2a/router
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  A2AContextId,
  A2A_PROTOCOL_VERSION,
  ERR_EXTENDED_CARD_NOT_CONFIGURED,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE,
  ERR_PUSH_NOT_SUPPORTED,
  ERR_TASK_NOT_CANCELABLE,
  A2ARpcError,
  jsonRpcError,
  jsonRpcResult,
  legacyMethodReplacement,
  nowIso,
  parseListTasksParams,
  parseSendMessageRequest,
  parseTenant,
  partsToText,
  resolveMethod,
  sseFrame,
  streamArtifactUpdate,
  streamStatusUpdate,
  streamTask,
  taskNotFound,
  unsupportedOperation,
  versionNotSupported,
  type A2AAgentCard,
  type A2AArtifact,
  type A2AListTasksParams,
  type A2AOperation,
  type A2ATask,
  type A2ATaskId,
  type A2ATaskState,
} from './protocol/index.ts'
import type { A2AServerConfig } from './config.ts'
import type { Activation, ContextRegistry } from './contexts.ts'
import { filterInbound, redactOutbound, type PeerIdentity, type RateLimiter, type TurnTracker } from './security.ts'
import type { TaskSlot, TaskSettlement } from './tasks.ts'

/** Largest request body accepted, before parsing. */
const MAX_BODY_BYTES = 1_000_000

/** `ListTasks` page size when a peer names none, per the spec's default. */
const DEFAULT_PAGE_SIZE = 50

/** Everything the router needs from the plugin body. */
export interface RouterDeps {
  config: A2AServerConfig
  contexts: ContextRegistry
  turns: TurnTracker
  rateLimiter: RateLimiter
  logger: { warn: (message: string) => void; error: (message: string) => void }
  assertOpen: () => void
  resolvePeerSecrets: () => Promise<Map<PeerIdentity, string>>
  identify: (token: string | undefined, secrets: ReadonlyMap<PeerIdentity, string>) => PeerIdentity | undefined
  cardFor: (hostHeader: string | undefined) => A2AAgentCard
  /** The authenticated extended card, or undefined when none is configured. */
  extendedCardFor: (hostHeader: string | undefined) => A2AAgentCard | undefined
  createActivation: (peer: PeerIdentity) => Promise<Activation>
  submit: (activation: Activation, text: string, peer: PeerIdentity) => Promise<TaskSlot>
  cancel: (activation: Activation, slot: TaskSlot) => void
  taskSnapshot: (
    activation: Activation,
    slot: TaskSlot,
    state: A2ATaskState,
    artifacts: A2AArtifact[],
    stopReason?: string,
  ) => A2ATask
  /**
   * Read a settled task back from the durable projection.
   *
   * Absent when the composition mounts no projection registry, in which case a
   * settled task is simply unreadable — the pre-projection behavior.
   */
  readProjectedTask?: (activation: Activation, taskId: A2ATaskId) => A2ATask | undefined
  /**
   * Every settled task the projection holds for one context.
   *
   * Only `ListTasks` needs this; `GetTask` addresses a single id and uses
   * {@link readProjectedTask}.
   */
  readProjectedTasks?: (activation: Activation) => A2ATask[]
}

/** One live SSE subscription. */
interface StreamChannel {
  res: ServerResponse
  id: string | number | null
  taskId: A2ATaskId
  contextId: string
}

/** The router surface the plugin body wires into routes and teardown. */
export interface Router {
  serveCard: (req: IncomingMessage, res: ServerResponse) => void
  serveRpc: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** Send every open stream its terminal frame, then end it. */
  closeStreams: () => void
}

/**
 * Build the router.
 * @param deps - the injected plugin capabilities.
 * @returns the route handlers plus stream teardown.
 */
export function createRouter(deps: RouterDeps): Router {
  const { config } = deps
  const streams = new Set<StreamChannel>()

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  /** Answer a JSON-RPC failure, carrying its A2A reason when it has one. */
  const sendRpcError = (
    res: ServerResponse,
    id: string | number | null,
    error: A2ARpcError,
  ): void => {
    sendJson(res, error.httpStatus, jsonRpcError(id, error.code, error.message, error.data))
  }

  /**
   * Answer an authentication-class failure.
   *
   * The status carries the real meaning — A2A puts transport security at the
   * HTTP layer — while the body stays a valid JSON-RPC error envelope so a
   * client that only parses bodies is not left with nothing.
   */
  const sendAuthFailure = (res: ServerResponse, status: number, message: string): void => {
    if (status === 401) res.setHeader('www-authenticate', 'Bearer')
    sendJson(res, status, jsonRpcError(null, ERR_INVALID_REQUEST, message))
  }

  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        throw new A2ARpcError(ERR_PARSE, 'payload too large', { httpStatus: 413 })
      }
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  const serveCard = (req: IncomingMessage, res: ServerResponse): void => {
    // The card is public by design: discovery requires an anonymous read. A
    // deployment that serves only known internal peers may still close it.
    if (!config.card.public) {
      sendAuthFailure(res, 401, 'unauthorized')
      return
    }
    sendJson(res, 200, deps.cardFor(req.headers.host))
  }

  const serveRpc = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      sendJson(res, 405, jsonRpcError(null, ERR_INVALID_REQUEST, 'method not allowed'))
      return
    }

    let peer: PeerIdentity | undefined
    try {
      deps.assertOpen()
      const secrets = await deps.resolvePeerSecrets()
      const header = req.headers.authorization
      peer = deps.identify(
        typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined,
        secrets,
      )
    } catch (error: unknown) {
      sendJson(res, 503, jsonRpcError(null, ERR_INVALID_REQUEST, String(error)))
      return
    }

    if (peer === undefined) {
      sendAuthFailure(res, 401, 'unauthorized')
      return
    }
    if (!deps.rateLimiter.allow(peer)) {
      sendAuthFailure(res, 429, 'rate limit exceeded')
      return
    }
    // An EMPTY allow list means "no allow list", matching the documented
    // "omit to allow every authenticated peer". Schemastery materializes an
    // omitted array as `[]`, so testing only for `undefined` would silently
    // lock out every peer on a config that never mentioned trustedPeers.
    if (config.trustedPeers !== undefined && config.trustedPeers.length > 0
      && !config.trustedPeers.includes(peer)) {
      sendAuthFailure(res, 403, `peer "${peer}" is not trusted`)
      return
    }

    let body: string
    try {
      body = await readBody(req)
    } catch (error: unknown) {
      const rpc = error as A2ARpcError
      sendJson(res, rpc.httpStatus ?? 400, jsonRpcError(null, rpc.code ?? ERR_PARSE, rpc.message))
      return
    }

    let request: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(body.length === 0 ? '{}' : body)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, jsonRpcError(null, ERR_INVALID_REQUEST, 'request must be a JSON object'))
        return
      }
      request = parsed as Record<string, unknown>
    } catch {
      sendJson(res, 400, jsonRpcError(null, ERR_PARSE, 'parse error'))
      return
    }

    const id = (request['id'] ?? null) as string | number | null
    const method = typeof request['method'] === 'string' ? request['method'] : ''
    const params = request['params']
    if (params !== undefined && (params === null || typeof params !== 'object')) {
      sendJson(res, 200, jsonRpcError(id, ERR_INVALID_PARAMS, 'params must be an object'))
      return
    }

    // Version negotiation. The spec says an EMPTY header means 0.3 — but this
    // interface declares only 1.0 on its card, and a v0.3 peer could not read
    // the reply anyway. So an absent header is taken as 1.0 (the interface a
    // client just discovered), and an explicit version this interface does not
    // serve gets the spec's own VersionNotSupportedError rather than a reply in
    // a spelling the caller cannot parse.
    const version = req.headers['a2a-version']
    if (typeof version === 'string' && version.trim().length > 0
      && !['1.0', '1.0.0'].includes(version.trim())) {
      sendRpcError(res, id, versionNotSupported(version.trim(), A2A_PROTOCOL_VERSION))
      return
    }

    const operation = resolveMethod(method)
    if (operation === undefined) {
      const replacement = legacyMethodReplacement(method)
      sendJson(res, 200, jsonRpcError(
        id,
        ERR_METHOD_NOT_FOUND,
        replacement === undefined
          ? `method not found: ${method}`
          : `method not found: ${method}; this agent speaks A2A `
            + `${A2A_PROTOCOL_VERSION}, which renamed it to ${replacement}`,
      ))
      return
    }

    // This card's interface declares no tenant, so a peer that names one has
    // been routed somewhere it did not intend.
    const tenant = parseTenant(params)
    if (tenant !== undefined) {
      sendJson(res, 200, jsonRpcError(
        id, ERR_INVALID_PARAMS,
        `this interface declares no tenant; remove tenant: ${tenant}`,
      ))
      return
    }

    try {
      await dispatch(operation, id, params, peer, req, res)
    } catch (error: unknown) {
      if (error instanceof A2ARpcError) {
        sendRpcError(res, id, error)
        return
      }
      deps.logger.warn(`a2a: ${method} failed: ${String(error)}`)
      // Internal detail never reaches a peer: it can carry filesystem paths.
      sendJson(res, 200, jsonRpcError(id, ERR_INVALID_REQUEST, 'internal error'))
    }
  }

  /**
   * Resolve the context a request addresses, creating one when none was named.
   *
   * A context owned by another peer is reported exactly as an absent one, so a
   * peer cannot enumerate context ids by comparing responses.
   */
  const resolveContext = async (
    rawContextId: string | undefined,
    peer: PeerIdentity,
  ): Promise<Activation> => {
    if (rawContextId === undefined) return deps.createActivation(peer)
    const found = deps.contexts.lookup(A2AContextId(rawContextId), peer)
    if (found === 'unknown' || found === 'forbidden') {
      throw new A2ARpcError(ERR_INVALID_PARAMS, `unknown contextId: ${rawContextId}`)
    }
    return found
  }

  /**
   * Find an IN-FLIGHT task slot this peer owns.
   *
   * A settled task has no slot — `settleSlot` removes it — so this is only the
   * first half of a lookup. Operations that merely READ a task fall through to
   * the projection ({@link readTask}); operations that act on a running task
   * (cancel, subscribe) need the live slot and stop here.
   */
  const requireSlot = (rawTaskId: unknown, peer: PeerIdentity): { activation: Activation; slot: TaskSlot } => {
    const found = findSlot(rawTaskId, peer)
    if (found === undefined) throw taskNotFound(requireTaskId(rawTaskId))
    return found
  }

  /** Locate an in-flight slot this peer owns, without throwing when absent. */
  const findSlot = (
    rawTaskId: unknown,
    peer: PeerIdentity,
  ): { activation: Activation; slot: TaskSlot } | undefined => {
    const taskId = requireTaskId(rawTaskId)
    for (const activation of deps.contexts.values()) {
      if (activation.peer !== peer) continue
      const slot = activation.slots.get(taskId)
      if (slot !== undefined) return { activation, slot }
    }
    return undefined
  }

  /**
   * Validate the `id` parameter shape.
   *
   * v1.0 spells every task reference `id`. The v0.3 `taskId` is NOT accepted:
   * a peer still sending it would also be sending a v0.3 message body and
   * expecting a v0.3 reply, and a half-understood request is worse than a
   * refused one.
   */
  const requireTaskId = (rawTaskId: unknown): A2ATaskId => {
    if (typeof rawTaskId !== 'string' || rawTaskId.length === 0) {
      throw new A2ARpcError(ERR_INVALID_PARAMS, 'id is required')
    }
    return rawTaskId as A2ATaskId
  }

  /** The current wire shape of an in-flight task. */
  const liveTask = (activation: Activation, slot: TaskSlot): A2ATask => {
    const state: A2ATaskState = slot.turn === undefined
      ? 'TASK_STATE_SUBMITTED'
      : 'TASK_STATE_WORKING'
    return deps.taskSnapshot(activation, slot, state, redactArtifacts(
      slot.texts.length > 0
        ? [{
          artifactId: `${slot.taskId}-result`,
          parts: [{ text: slot.texts.join('\n'), mediaType: 'text/plain' }],
        }]
        : [],
    ))
  }

  /**
   * Read a task's current state, live slot or not.
   *
   * Falls back to the durable projection, which is what makes `GetTask`
   * answerable after settlement — and, once persistence is composed, after a
   * restart. A task belonging to another peer reports exactly like an absent
   * one, so ownership cannot be probed by comparing responses.
   */
  const readTask = (rawTaskId: unknown, peer: PeerIdentity): A2ATask => {
    const taskId = requireTaskId(rawTaskId)

    for (const activation of deps.contexts.values()) {
      if (activation.peer !== peer) continue
      const slot = activation.slots.get(taskId)
      if (slot !== undefined) return liveTask(activation, slot)
      const projected = deps.readProjectedTask?.(activation, taskId)
      // Text read back from the log leaves the process just like live text
      // does, so it goes through the same scrub.
      if (projected !== undefined) {
        return { ...projected, artifacts: redactArtifacts(projected.artifacts ?? []) }
      }
    }
    throw taskNotFound(taskId)
  }

  const dispatch = async (
    operation: A2AOperation,
    id: string | number | null,
    params: unknown,
    peer: PeerIdentity,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    switch (operation) {
      case 'send':
      case 'stream': {
        const parsed = parseSendMessageRequest(params)
        if (parsed === undefined) throw new A2ARpcError(ERR_INVALID_PARAMS, 'message is required')

        const raw = partsToText(parsed.message.parts)
        if (raw.trim().length === 0) {
          throw new A2ARpcError(ERR_INVALID_PARAMS, 'message carries no readable content')
        }

        // A message may address a context directly, or name a task and let the
        // server infer the context from it. A task that already settled cannot
        // take further messages, which the spec spells UnsupportedOperation.
        const activation = parsed.message.taskId === undefined
          ? await resolveContext(parsed.message.contextId, peer)
          : continueTask(parsed.message.taskId, peer)

        const turn = deps.turns.track(activation.contextId)
        if (turn > config.maxContextTurns) {
          const rejected = deps.taskSnapshot(
            activation,
            { taskId: 'rejected' as A2ATaskId } as TaskSlot,
            'TASK_STATE_REJECTED',
            [{
              artifactId: 'rejected',
              parts: [{
                text: `context ${activation.contextId} exceeded ${config.maxContextTurns} turns; `
                  + 'start a new context or raise maxContextTurns',
                mediaType: 'text/plain',
              }],
            }],
          )
          sendJson(res, 200, jsonRpcResult(id, { task: rejected }))
          return
        }

        const slot = await deps.submit(activation, filterInbound(raw), peer)

        if (operation === 'stream') {
          openStream(res, id, slot, activation)
          return
        }

        // v1.0 inverted the send-mode knob: operations BLOCK by default and a
        // client opts out with `returnImmediately`. The deployment's `sendMode`
        // is only the default for a client that expresses no preference.
        //
        // The spec still lets a server answer a blocking request with a
        // non-terminal task, which is exactly what the timeout below does: the
        // task keeps running and the peer polls.
        const requested = parsed.configuration?.returnImmediately
        const shouldBlock = requested === undefined ? config.sendMode === 'block' : !requested

        const settlement = shouldBlock
          ? await withTimeout(slot.settled, config.blockTimeoutMs)
          : undefined

        const task = settlement === undefined
          // Not an error: the peer polls GetTask or subscribes, and the task
          // keeps running. Erroring here would discard real work.
          ? deps.taskSnapshot(activation, slot, 'TASK_STATE_WORKING', [])
          : deps.taskSnapshot(
            activation, slot, settlement.state,
            redactArtifacts(settlement.artifacts), settlement.stopReason,
          )
        // v1.0 wraps the result: SendMessage answers with a task OR a message,
        // and the member name is what tells them apart.
        sendJson(res, 200, jsonRpcResult(id, { task }))
        return
      }

      case 'get': {
        const task = readTask((params as Record<string, unknown>)?.['id'], peer)
        sendJson(res, 200, jsonRpcResult(id, task))
        return
      }

      case 'list': {
        sendJson(res, 200, jsonRpcResult(id, listTasks(parseListTasksParams(params), peer)))
        return
      }

      case 'cancel': {
        const { activation, slot } = requireSlot((params as Record<string, unknown>)?.['id'], peer)
        if (slot.done) {
          throw new A2ARpcError(
            ERR_TASK_NOT_CANCELABLE,
            'task already reached a terminal state',
            { reason: 'TASK_NOT_CANCELABLE', metadata: { taskId: slot.taskId } },
          )
        }
        deps.cancel(activation, slot)
        const task = deps.taskSnapshot(activation, slot, 'TASK_STATE_CANCELED', [])
        sendJson(res, 200, jsonRpcResult(id, task))
        return
      }

      case 'subscribe': {
        const rawTaskId = (params as Record<string, unknown>)?.['id']
        const live = findSlot(rawTaskId, peer)
        if (live !== undefined) {
          openStream(res, id, live.slot, live.activation)
          return
        }
        // Settled, or never existed. readTask separates the two, and a settled
        // task is refused rather than streamed: v1.0 states a subscription to a
        // terminal task is an UnsupportedOperation, and the outcome is still
        // one GetTask away.
        const task = readTask(rawTaskId, peer)
        throw unsupportedOperation(
          `task ${task.id} is in terminal state ${task.status.state}; read it with GetTask`,
        )
      }

      case 'push_create':
      case 'push_get':
      case 'push_list':
      case 'push_delete': {
        // Advertised as unsupported on the card, so a compliant peer never
        // reaches this; answering with the spec's own code keeps one that does
        // from guessing.
        if (config.push.enabled) {
          throw unsupportedOperation('push notifications are not enabled on this deployment')
        }
        throw new A2ARpcError(
          ERR_PUSH_NOT_SUPPORTED,
          'push notifications are not enabled on this deployment',
          { reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED' },
        )
      }

      case 'extended_card': {
        const extended = deps.extendedCardFor(req.headers.host)
        if (extended === undefined) {
          throw new A2ARpcError(
            ERR_EXTENDED_CARD_NOT_CONFIGURED,
            'this deployment declares no extended agent card',
            { reason: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED' },
          )
        }
        sendJson(res, 200, jsonRpcResult(id, extended))
        return
      }

      default:
        throw new A2ARpcError(ERR_METHOD_NOT_FOUND, `unsupported operation: ${String(operation)}`)
    }
  }

  /**
   * Resolve the context that owns a task a message continues.
   *
   * A task here spans one submitted message, so "continuing" one means adding a
   * message to the SAME context, not reopening the same task id. A settled task
   * is refused outright, which is the rule v1.0 states for messages addressed to
   * a terminal task.
   * @param rawTaskId - the `taskId` the message carried.
   * @param peer - the authenticated identity.
   * @returns the owning context.
   */
  const continueTask = (rawTaskId: string, peer: PeerIdentity): Activation => {
    const live = findSlot(rawTaskId, peer)
    if (live !== undefined) return live.activation
    const settled = readTask(rawTaskId, peer)
    throw unsupportedOperation(
      `task ${settled.id} is in terminal state ${settled.status.state} `
      + 'and cannot accept further messages; send to its contextId instead',
    )
  }

  /**
   * List the tasks this peer may see, newest first.
   *
   * Scope is the RESIDENT contexts: a context evicted for idleness takes its
   * task list with it, because nothing in this plugin indexes sessions outside
   * the registry. `GetTask` has the same horizon, so the two agree.
   * @param filters - the parsed `ListTasks` parameters.
   * @param peer - the authenticated identity.
   * @returns one page of results plus its cursor.
   */
  const listTasks = (
    filters: A2AListTasksParams,
    peer: PeerIdentity,
  ): { tasks: A2ATask[]; nextPageToken: string; pageSize: number; totalSize: number } => {
    const collected: A2ATask[] = []
    for (const activation of deps.contexts.values()) {
      if (activation.peer !== peer) continue
      if (filters.contextId !== undefined && activation.contextId !== filters.contextId) continue
      for (const slot of activation.slots.values()) collected.push(liveTask(activation, slot))
      for (const projected of deps.readProjectedTasks?.(activation) ?? []) {
        // A live slot is authoritative over its own projected row.
        if (activation.slots.has(projected.id)) continue
        collected.push({ ...projected, artifacts: redactArtifacts(projected.artifacts ?? []) })
      }
    }

    const matching = collected
      .filter(task => filters.status === undefined || task.status.state === filters.status)
      .filter(task => filters.statusTimestampAfter === undefined
        || task.status.timestamp >= filters.statusTimestampAfter)
      // Newest first, with the id as a tiebreak so the cursor below is total.
      .sort((a, b) => a.status.timestamp === b.status.timestamp
        ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
        : (a.status.timestamp < b.status.timestamp ? 1 : -1))

    const after = decodeCursor(filters.pageToken)
    const remaining = after === undefined
      ? matching
      : matching.filter(task => task.status.timestamp < after.timestamp
        || (task.status.timestamp === after.timestamp && task.id < after.taskId))

    const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE
    const page = remaining.slice(0, pageSize)
    const last = page[page.length - 1]
    const more = remaining.length > page.length

    return {
      // `includeArtifacts` defaults to false, and the spec is explicit that the
      // member must then be ABSENT rather than an empty array.
      tasks: page.map((task) => {
        if (filters.includeArtifacts === true) return task
        const { artifacts: _artifacts, ...rest } = task
        return rest
      }),
      // Always present; empty string is how "no more pages" is spelled.
      nextPageToken: more && last !== undefined ? encodeCursor(last) : '',
      pageSize,
      totalSize: matching.length,
    }
  }

  /** Open an SSE stream and push this task's transitions until it settles. */
  const openStream = (
    res: ServerResponse,
    id: string | number | null,
    slot: TaskSlot,
    activation: Activation,
  ): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const channel: StreamChannel = {
      res, id, taskId: slot.taskId, contextId: activation.contextId,
    }
    streams.add(channel)

    // v1.0 requires the Task object itself as the first frame, so a subscriber
    // never has to call GetTask to learn where the task stood when it joined.
    res.write(sseFrame(id, streamTask(liveTask(activation, slot))))

    void slot.settled.then((settlement: TaskSettlement) => {
      if (!streams.has(channel)) return
      redactArtifacts(settlement.artifacts).forEach((artifact, index) => {
        res.write(sseFrame(id, streamArtifactUpdate({
          taskId: slot.taskId,
          contextId: activation.contextId,
          artifact,
          index,
          lastChunk: true,
        })))
      })
      res.write(sseFrame(id, streamStatusUpdate({
        taskId: slot.taskId,
        contextId: activation.contextId,
        status: { state: settlement.state, timestamp: nowIso() },
      })))
      streams.delete(channel)
      // v1.0 dropped the `final` flag: closing the stream IS the terminal
      // signal, so the close must follow the terminal status immediately.
      res.end()
    })
  }

  const closeStreams = (): void => {
    for (const channel of streams) {
      try {
        channel.res.write(sseFrame(channel.id, streamStatusUpdate({
          taskId: channel.taskId,
          contextId: A2AContextId(channel.contextId),
          status: { state: 'TASK_STATE_CANCELED', timestamp: nowIso() },
        })))
        channel.res.end()
      } catch {
        // A socket already gone needs no farewell.
      }
    }
    streams.clear()
  }

  return { serveCard, serveRpc, closeStreams }
}

/**
 * Encode a page cursor.
 *
 * The token is opaque by contract, so it is base64url of the sort key that
 * produced it — a real cursor rather than an offset, which is what keeps a page
 * boundary stable while tasks are being added ahead of it.
 * @param task - the last task on the page just returned.
 * @returns the token a peer sends back as `pageToken`.
 */
function encodeCursor(task: A2ATask): string {
  return Buffer.from(`${task.status.timestamp}|${task.id}`, 'utf8').toString('base64url')
}

/**
 * Decode a page cursor.
 * @param token - the `pageToken` a peer sent, if any.
 * @returns the sort key to resume after, or undefined for the first page.
 * @throws {A2ARpcError} when the token is not one this server issued.
 */
function decodeCursor(token: string | undefined): { timestamp: string; taskId: string } | undefined {
  if (token === undefined) return undefined
  const decoded = Buffer.from(token, 'base64url').toString('utf8')
  const split = decoded.lastIndexOf('|')
  if (split <= 0) throw new A2ARpcError(ERR_INVALID_PARAMS, 'pageToken is not a cursor this server issued')
  return { timestamp: decoded.slice(0, split), taskId: decoded.slice(split + 1) }
}

/**
 * Scrub credential-shaped text from artifacts before they leave the process.
 * @param artifacts - the artifacts about to be sent.
 * @returns artifacts with text parts redacted.
 */
function redactArtifacts(artifacts: readonly A2AArtifact[]): A2AArtifact[] {
  return artifacts.map(artifact => ({
    ...artifact,
    parts: artifact.parts.map(part =>
      'text' in part ? { ...part, text: redactOutbound(part.text) } : part),
  }))
}

/**
 * Await a promise, resolving to undefined if it takes too long.
 *
 * A timeout is NOT an error here: the task keeps running and the peer polls.
 * @param promise - the settlement to await.
 * @param ms - the budget.
 * @returns the settlement, or undefined on timeout.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => { resolve(undefined) }, ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
