/**
 * HTTP + JSON-RPC dispatch.
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
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE,
  ERR_PUSH_NOT_SUPPORTED,
  ERR_TASK_NOT_CANCELABLE,
  ERR_UNSUPPORTED_OPERATION,
  A2ARpcError,
  jsonRpcError,
  jsonRpcResult,
  nowIso,
  parseSendParams,
  partsToText,
  renderStatusUpdate,
  renderTask,
  resolveMethod,
  sseFrame,
  taskNotFound,
  type A2AAgentCard,
  type A2AArtifact,
  type A2ADialect,
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
}

/** One live SSE subscription. */
interface StreamChannel {
  res: ServerResponse
  id: string | number | null
  dialect: A2ADialect
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
      if (size > MAX_BODY_BYTES) throw new A2ARpcError(ERR_PARSE, 'payload too large', 413)
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

    const version = req.headers['a2a-version']
    if (typeof version === 'string' && version.length > 0
      && !['0.3', '0.3.0', '1.0', '1.0.0'].includes(version)) {
      sendJson(res, 200, jsonRpcError(id, ERR_INVALID_PARAMS, `unsupported A2A-Version: ${version}`))
      return
    }

    const entry = resolveMethod(method)
    if (entry === undefined) {
      sendJson(res, 200, jsonRpcError(id, ERR_METHOD_NOT_FOUND, `method not found: ${method}`))
      return
    }

    try {
      await dispatch(entry.operation, entry.dialect, id, params, peer, res)
    } catch (error: unknown) {
      if (error instanceof A2ARpcError) {
        sendJson(res, error.httpStatus, jsonRpcError(id, error.code, error.message))
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

  /** Find a task slot this peer is allowed to see. */
  const requireSlot = (rawTaskId: unknown, peer: PeerIdentity): { activation: Activation; slot: TaskSlot } => {
    if (typeof rawTaskId !== 'string' || rawTaskId.length === 0) {
      throw new A2ARpcError(ERR_INVALID_PARAMS, 'taskId is required')
    }
    for (const activation of deps.contexts.values()) {
      if (activation.peer !== peer) continue
      const slot = activation.slots.get(rawTaskId as A2ATaskId)
      if (slot !== undefined) return { activation, slot }
    }
    throw taskNotFound(rawTaskId)
  }

  const dispatch = async (
    operation: string,
    dialect: A2ADialect,
    id: string | number | null,
    params: unknown,
    peer: PeerIdentity,
    res: ServerResponse,
  ): Promise<void> => {
    switch (operation) {
      case 'send':
      case 'stream': {
        const parsed = parseSendParams(params)
        if (parsed === undefined) throw new A2ARpcError(ERR_INVALID_PARAMS, 'message is required')

        const raw = partsToText(parsed.message.parts)
        if (raw.trim().length === 0) {
          throw new A2ARpcError(ERR_INVALID_PARAMS, 'message carries no readable content')
        }

        const activation = await resolveContext(parsed.message.contextId, peer)

        const turn = deps.turns.track(activation.contextId)
        if (turn > config.maxContextTurns) {
          const rejected = deps.taskSnapshot(
            activation,
            { taskId: 'rejected' as A2ATaskId } as TaskSlot,
            'rejected',
            [{
              artifactId: 'rejected',
              parts: [{
                kind: 'text',
                text: `context ${activation.contextId} exceeded ${config.maxContextTurns} turns; `
                  + 'start a new context or raise maxContextTurns',
              }],
            }],
          )
          sendJson(res, 200, jsonRpcResult(id, renderTask(rejected, dialect)))
          return
        }

        const slot = await deps.submit(activation, filterInbound(raw), peer)

        if (operation === 'stream') {
          openStream(res, id, dialect, slot, activation)
          return
        }

        const settlement = config.sendMode === 'immediate'
          ? undefined
          : await withTimeout(slot.settled, config.blockTimeoutMs)

        const task = settlement === undefined
          // Not an error: the peer polls tasks/get or resubscribes, and the task
          // keeps running. Erroring here would discard real work.
          ? deps.taskSnapshot(activation, slot, 'working', [])
          : deps.taskSnapshot(
            activation, slot, settlement.state,
            redactArtifacts(settlement.artifacts), settlement.stopReason,
          )
        sendJson(res, 200, jsonRpcResult(id, renderTask(task, dialect)))
        return
      }

      case 'get': {
        const { activation, slot } = requireSlot((params as Record<string, unknown>)?.['taskId'], peer)
        const state: A2ATaskState = slot.done ? 'completed' : slot.turn === undefined ? 'submitted' : 'working'
        const task = deps.taskSnapshot(activation, slot, state, redactArtifacts(
          slot.texts.length > 0 ? [{ artifactId: `${slot.taskId}-result`, parts: [{ kind: 'text', text: slot.texts.join('\n') }] }] : [],
        ))
        sendJson(res, 200, jsonRpcResult(id, renderTask(task, dialect)))
        return
      }

      case 'cancel': {
        const { activation, slot } = requireSlot((params as Record<string, unknown>)?.['taskId'], peer)
        if (slot.done) throw new A2ARpcError(ERR_TASK_NOT_CANCELABLE, 'task already reached a terminal state')
        deps.cancel(activation, slot)
        const task = deps.taskSnapshot(activation, slot, 'canceled', [])
        sendJson(res, 200, jsonRpcResult(id, renderTask(task, dialect)))
        return
      }

      case 'resubscribe': {
        const { activation, slot } = requireSlot((params as Record<string, unknown>)?.['taskId'], peer)
        openStream(res, id, dialect, slot, activation)
        return
      }

      case 'push_set':
      case 'push_get':
      case 'push_list':
      case 'push_delete': {
        // Advertised as unsupported on the card, so a compliant peer never
        // reaches this; answering with the spec's own code keeps one that does
        // from guessing.
        throw new A2ARpcError(
          config.push.enabled ? ERR_UNSUPPORTED_OPERATION : ERR_PUSH_NOT_SUPPORTED,
          'push notifications are not enabled on this deployment',
        )
      }

      default:
        throw new A2ARpcError(ERR_METHOD_NOT_FOUND, `unsupported operation: ${operation}`)
    }
  }

  /** Open an SSE stream and push this task's terminal transition when it settles. */
  const openStream = (
    res: ServerResponse,
    id: string | number | null,
    dialect: A2ADialect,
    slot: TaskSlot,
    activation: Activation,
  ): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const channel: StreamChannel = {
      res, id, dialect, taskId: slot.taskId, contextId: activation.contextId,
    }
    streams.add(channel)

    res.write(sseFrame(id, renderStatusUpdate({
      kind: 'status-update',
      taskId: slot.taskId,
      contextId: activation.contextId,
      status: { state: slot.turn === undefined ? 'submitted' : 'working', timestamp: nowIso() },
      final: false,
    }, dialect)))

    void slot.settled.then((settlement: TaskSettlement) => {
      if (!streams.has(channel)) return
      for (const artifact of redactArtifacts(settlement.artifacts)) {
        res.write(sseFrame(id, { kind: 'artifact-update', taskId: slot.taskId, contextId: activation.contextId, artifact, lastChunk: true }))
      }
      res.write(sseFrame(id, renderStatusUpdate({
        kind: 'status-update',
        taskId: slot.taskId,
        contextId: activation.contextId,
        status: { state: settlement.state, timestamp: nowIso() },
        final: true,
      }, dialect)))
      streams.delete(channel)
      res.end()
    })
  }

  const closeStreams = (): void => {
    for (const channel of streams) {
      try {
        channel.res.write(sseFrame(channel.id, renderStatusUpdate({
          kind: 'status-update',
          taskId: channel.taskId,
          contextId: A2AContextId(channel.contextId),
          status: { state: 'canceled', timestamp: nowIso() },
          final: true,
        }, channel.dialect)))
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
 * Scrub credential-shaped text from artifacts before they leave the process.
 * @param artifacts - the artifacts about to be sent.
 * @returns artifacts with text parts redacted.
 */
function redactArtifacts(artifacts: readonly A2AArtifact[]): A2AArtifact[] {
  return artifacts.map(artifact => ({
    ...artifact,
    parts: artifact.parts.map(part =>
      part.kind === 'text' ? { kind: 'text' as const, text: redactOutbound(part.text) } : part),
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
