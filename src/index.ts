/**
 * Inbound A2A protocol server for DeepSeek Harness.
 *
 * Publishes an Agent Card at a well-known URI and serves the A2A v1.0 JSON-RPC
 * binding, so any compliant peer that knows this deployment's URL can discover
 * it and submit tasks to a harness agent. There is no outbound client: this
 * plugin never connects to another agent.
 *
 * v1.0 is the ONLY protocol version served. The v0.3 method names, `kind`
 * discriminators, and lowercase enums are gone rather than aliased: a reply
 * this server produces is v1.0 JSON, and a v0.3 client could not read it, so
 * answering a v0.3 request would fail further from its cause than refusing it.
 *
 * It is a TRANSPORT ADAPTER, not a capability seam — the same self-limitation
 * `dsh-acp` states. It exposes no editor navigation, transcript replay,
 * commands, modes, or tool presentation.
 *
 * @module dsh-a2a-server
 */

import { randomUUID } from 'node:crypto'
import { mkdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  A2AContextId,
  A2ATaskId,
  buildAgentCard,
  buildExtendedAgentCard,
  nowIso,
  type A2AAgentCard,
  type A2ATask,
  type A2ATaskState,
  type CardInput,
} from './protocol/index.ts'
import { assertConfigCoherent, Config, type A2AServerConfig } from './config.ts'
import { SERVER_VERSION } from './version.ts'
import { ContextRegistry, type Activation } from './contexts.ts'
import { identifyPeer, RateLimiter, TurnTracker, type PeerIdentity } from './security.ts'
import { artifactsFromTexts, createSlot, stateFromEnding, type TaskSlot } from './tasks.ts'
import { createRouter, type RouterDeps } from './router.ts'
import { a2aTaskProjection } from './projection.ts'
// Side-effect type imports: these declaration-merge `ctx.webServer` and
// `ctx.credentials` onto Context, and our own `a2a/task` / `a2a-peer` vocabulary
// onto the session and message maps. None of them add a runtime dependency.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from './types.ts'

export { Config }
export type { A2AServerConfig }

export const name = 'a2a-server'

/**
 * The server creates and owns agents, needs an HTTP carrier for its routes, and
 * cannot authenticate a single request without the credential seam. Everything
 * else it uses is probed with `ctx.get()` so a composition missing an optional
 * capability still boots with A2A serving.
 */
export const inject = ['agents', 'webServer', 'credentials']

/**
 * The one continuable-subagent teardown method this plugin needs, declared
 * structurally so it does not depend on the subagent seam for a shutdown hook.
 * An absent service means nothing continuable was ever materialized.
 */
interface ContinuableDrain {
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

/**
 * Mount the inbound A2A server.
 * @param ctx - the Cordis context carrying the agent factory, HTTP carrier, and credentials.
 * @param config - the validated plugin configuration.
 */
export function apply(ctx: Context, config: A2AServerConfig): void {
  assertConfigCoherent(config)

  // Handlers run on node's IO callbacks, outside this fiber's injection scope.
  // Snapshot the injected services here; validate individual object liveness
  // lazily at each use, because an agent-loop-only reload disposes agents while
  // our records survive.
  const agents = ctx.agents
  const webServer = ctx.webServer
  const credentials = ctx.credentials
  const logger = ctx.logger

  const contexts = new ContextRegistry(config.maxResidentContexts, config.contextIdleTtlMs)
  const rateLimiter = new RateLimiter(config.rateLimitPerMinute)
  const turns = new TurnTracker()
  let closed = false

  /** Reject a request that arrives while teardown is in progress. */
  const assertOpen = (): void => {
    if (closed) throw new Error('the A2A server has been disposed')
  }

  /**
   * Return the Activation owning this agent, rejecting same-id impostors.
   *
   * Identity is compared by object reference, not session id: a reload can
   * rebuild an agent under the same id, and routing events to the replacement
   * would silently cross wires.
   */
  const ownedActivation = (agent: Agent): Activation | undefined => {
    const activation = contexts.lookup(A2AContextId(agent.session.id), '')
    if (typeof activation === 'string') {
      // Ownership check is peer-scoped; for event routing we only need identity.
      const direct = contexts.values().find(a => a.agent === agent)
      return direct
    }
    return activation.agent === agent ? activation : undefined
  }

  // ── Resolve declared peer credentials ──────────────────────────────────
  /**
   * Resolve every declared peer's secret.
   *
   * The seam's rule is to resolve per operation and never cache across them —
   * that read is what makes a rotated credential reach the very next request.
   */
  const resolvePeerSecrets = async (): Promise<Map<PeerIdentity, string>> => {
    const resolved = new Map<PeerIdentity, string>()
    for (const [peer, entry] of Object.entries(config.peers)) {
      const hit = await credentials.resolve(entry.tokenEnv as never)
      if (hit !== undefined && hit.value.length > 0) resolved.set(peer, hit.value)
    }
    return resolved
  }

  // Activation-time completeness check. `describe()` never holds a value; it
  // only answers whether a reference is configured. A peer declared here but
  // unconfigured would otherwise receive 401 forever with no diagnostic.
  ctx.effect(() => {
    void (async () => {
      const missing: string[] = []
      for (const [peer, entry] of Object.entries(config.peers)) {
        try {
          const info = await credentials.describe(entry.tokenEnv as never)
          if (info === undefined || !info.configured) missing.push(`${peer} (${entry.tokenEnv})`)
        } catch {
          missing.push(`${peer} (${entry.tokenEnv})`)
        }
      }
      if (missing.length > 0) {
        logger.error(
          `a2a: declared peers have no configured credential and can never authenticate: ${missing.join(', ')}`,
        )
      }
      if (Object.keys(config.peers).length === 0) {
        logger.warn('a2a: no peers declared; every request will be rejected as unauthorized')
      }
    })()
    return () => {}
  }, 'a2a.credentialCheck')

  // ── Workspace resolution ───────────────────────────────────────────────
  const workspaceFor = (peer: PeerIdentity): string => {
    const override = config.isolation.peerWorkspaces[peer]
    if (override !== undefined) return override
    return config.isolation.workspaceMode === 'shared'
      ? config.isolation.workspaceRoot
      : join(config.isolation.workspaceRoot, peer)
  }

  /**
   * Create the workspace directory and prove it is enterable.
   *
   * A failure here refuses the request rather than falling back to a shared
   * directory: silently downgrading isolation is the one outcome worse than an
   * error, since nothing downstream would ever report it.
   */
  const ensureWorkspace = async (cwd: string): Promise<void> => {
    if (!isAbsolute(cwd)) throw new Error(`workspace must be an absolute path: ${cwd}`)
    await mkdir(cwd, { recursive: true })
    await access(cwd, constants.X_OK)
  }

  // ── Public URL ─────────────────────────────────────────────────────────
  /**
   * The URL peers should post to.
   *
   * Never the webserver's bind address: that is typically 127.0.0.1, and
   * publishing it on a card served through a reverse proxy is always wrong.
   */
  const publicUrl = (hostHeader: string | undefined): string => {
    if (config.publicUrl !== undefined) return config.publicUrl
    const host = hostHeader ?? `127.0.0.1:${webServer.port}`
    return `http://${host}${config.basePath}`
  }

  const cardInput = (hostHeader: string | undefined): CardInput => ({
    name: config.card.name,
    description: config.card.description,
    version: SERVER_VERSION,
    url: publicUrl(hostHeader),
    skills: config.card.skills,
    extendedSkills: config.card.extendedSkills,
    streaming: true,
    pushNotifications: config.push.enabled,
    authRequired: true,
    // An organization-less provider block is the schema's shape for "omitted",
    // and A2A readers expect the member to be absent rather than blank.
    ...config.card.provider === undefined || config.card.provider.organization.length === 0
      ? {}
      : { provider: config.card.provider },
  })

  const cardFor = (hostHeader: string | undefined): A2AAgentCard =>
    buildAgentCard(cardInput(hostHeader))

  const extendedCardFor = (hostHeader: string | undefined): A2AAgentCard | undefined =>
    buildExtendedAgentCard(cardInput(hostHeader))

  // ── Durable task edges ─────────────────────────────────────────────────
  /**
   * Append one `a2a/task` lifecycle edge to the context's own session log.
   *
   * This is what makes `GetTask` answerable after a restart: the state lives
   * in the append-only log, not in this process's memory.
   */
  const appendTaskEdge = (
    activation: Activation,
    taskId: A2ATaskId,
    state: A2ATaskState,
    extra: { turn?: number; stopReason?: string; output?: string } = {},
  ): void => {
    try {
      activation.agent.session.append('a2a/task', {
        taskId,
        peer: activation.peer,
        state,
        ...extra.turn === undefined ? {} : { turn: extra.turn },
        ...extra.stopReason === undefined ? {} : { stopReason: extra.stopReason },
        ...extra.output === undefined ? {} : { output: extra.output },
      })
    } catch (error: unknown) {
      // A log append failure must not take down the request: the peer still
      // gets a correct answer for THIS exchange; only durability is lost.
      logger.warn(`a2a: could not append a2a/task edge: ${String(error)}`)
    }
  }

  // ── Event wiring: the three-stage correlation ──────────────────────────
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const activation = ownedActivation(agent)
    if (activation === undefined) return
    for (const slot of activation.slots.values()) {
      if (slot.messageId === message.id && slot.turn === undefined) {
        slot.turn = turn
        appendTaskEdge(activation, slot.taskId, 'TASK_STATE_WORKING', { turn })
        return
      }
    }
  })

  ctx.on('session/event', (session, event) => {
    const activation = contexts.values().find(a => a.agent.session === session)
    if (activation === undefined) return

    if (event.type === 'assistant/message') {
      // Committed messages only. Raw chunks and retry attempts are presentation
      // and trace data; letting them onto the wire would leak text the agent
      // later discarded.
      for (const block of event.data.message.content) {
        if (block.type === 'text' && block.text.length > 0) {
          for (const slot of activation.slots.values()) slot.texts.push(block.text)
        }
      }
      return
    }

    if (event.type === 'turn/end') {
      const reason = String((event.data.reason as { kind?: string }).kind ?? 'unknown')
      for (const slot of activation.slots.values()) {
        if (slot.turn !== event.data.turn) continue
        if (reason === 'error') {
          // A model error on the correlated turn fails the task immediately
          // rather than waiting out whole-agent quiescence.
          settleSlot(activation, slot, 'TASK_STATE_FAILED', reason)
        } else {
          slot.endReason = reason
        }
      }
    }
  })

  ctx.on('agent/error', ({ agent, turn }) => {
    const activation = ownedActivation(agent)
    if (activation === undefined) return
    for (const slot of activation.slots.values()) {
      if (slot.turn === turn) settleSlot(activation, slot, 'TASK_STATE_FAILED', 'error')
    }
  })

  /**
   * Settle one task slot and record the terminal edge.
   * @param activation - the owning context.
   * @param slot - the slot to settle.
   * @param state - the terminal state.
   * @param stopReason - the harness turn ending, for `Task.metadata`.
   */
  function settleSlot(
    activation: Activation,
    slot: TaskSlot,
    state: A2ATaskState,
    stopReason?: string,
  ): void {
    if (slot.done) return
    activation.slots.delete(slot.taskId)
    const artifacts = artifactsFromTexts(slot.taskId, slot.texts)
    // The terminal edge carries the output, so the projection can serve the
    // ANSWER to a polling peer and not merely the fact that work finished.
    const output = slot.texts.filter(text => text.length > 0).join('\n')
    appendTaskEdge(activation, slot.taskId, state, {
      ...stopReason === undefined ? {} : { stopReason },
      ...output.length === 0 ? {} : { output },
    })
    slot.settle({
      state,
      artifacts,
      ...stopReason === undefined ? {} : { stopReason },
    })
  }

  // ── Context materialization ────────────────────────────────────────────
  /**
   * Create a fresh context and its owning agent.
   *
   * The policy events written onto the child's own log are what make an
   * A2A-driven agent safe to run unattended: approvals are deterministically
   * rejected rather than waiting on a prompt nobody is watching, and the policy
   * stays reconstructable from that log alone.
   */
  const createActivation = async (peer: PeerIdentity): Promise<Activation> => {
    const cwd = workspaceFor(peer)
    await ensureWorkspace(cwd)
    const sessionId = SessionId(randomUUID())
    const handle = await agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: {
        ...config.provider === undefined ? {} : { provider: config.provider },
        ...config.model === undefined ? {} : { model: config.model },
      },
    })
    if (closed) {
      // Teardown can begin while create() is awaited. Such an agent is not in
      // the registry and quiesce() would never release it — the classic orphan.
      await handle.dispose()
      throw new Error('server closed during context creation')
    }
    const activation: Activation = {
      contextId: A2AContextId(sessionId),
      agent: handle.agent,
      handle,
      peer,
      cwd,
      slots: new Map(),
      lastTouchedAt: Date.now(),
    }
    // Pin the approval policy on the agent's OWN log so its effective policy
    // stays reconstructable from that log alone — the same discipline
    // `captureDelegatedPolicyOverrides` applies to a delegated child. Nobody
    // watches an A2A-driven agent, so an ask must be deterministically rejected
    // rather than waiting out a prompt no human will ever answer.
    //
    // The event key is written through an untyped view because the approval
    // vocabulary belongs to a package a composition may not mount at all; when
    // it is absent this append is simply a log row nothing folds.
    try {
      const session = handle.agent.session as unknown as {
        append: (type: string, data: unknown) => void
      }
      session.append('approval/policy', { policy: 'never', source: 'a2a' })
    } catch (error: unknown) {
      logger.warn(`a2a: could not pin approval policy: ${String(error)}`)
    }
    contexts.add(activation)
    return activation
  }

  // ── Durable task read model ────────────────────────────────────────────
  // Optional capability: a composition without the registry keeps working, it
  // just cannot answer for a task after that task settles.
  const projections = ctx.get('sessionProjections')
  if (projections !== undefined) {
    ctx.effect(
      // The projection definition targets the CURRENT registry shape
      // (stateSchema + nested wire block); the rc.6 typings this package
      // compiles against still describe the old flat shape, so bridge with a
      // cast. Runtime DSH versions matching the old shape are unsupported.
      () => projections.register(a2aTaskProjection as never),
      'a2a.projection',
    )
  } else {
    logger.warn(
      'a2a: no sessionProjections registry composed; GetTask cannot answer '
      + 'once a task settles, so a polling peer will never learn its result',
    )
  }

  /**
   * Read a settled task back from the projection.
   *
   * The fold is authoritative for anything not in the live slot table, so this
   * is what makes the polling path work at all.
   */
  const readProjectedTask = (activation: Activation, taskId: A2ATaskId): A2ATask | undefined => {
    if (projections === undefined) return undefined
    const snapshot = projections.snapshot(activation.agent.session)
    const view = snapshot.values.a2aTask?.tasks[taskId]
    // Ownership is re-checked against the RECORDED peer rather than the
    // activation's, so a context that somehow served two identities could not
    // leak one's task to the other.
    if (view === undefined || view.peer !== activation.peer) return undefined
    return projectedTask(activation, taskId, view)
  }

  /**
   * Every task the projection holds for one context, for `ListTasks`.
   *
   * Ownership is re-checked per row for the same reason the single-task read
   * checks it: the RECORDED peer is authoritative, not the activation's.
   */
  const readProjectedTasks = (activation: Activation): A2ATask[] => {
    if (projections === undefined) return []
    const snapshot = projections.snapshot(activation.agent.session)
    const tasks = snapshot.values.a2aTask?.tasks ?? {}
    return Object.values(tasks)
      .filter(view => view.peer === activation.peer)
      .map(view => projectedTask(activation, A2ATaskId(view.taskId), view))
  }

  /**
   * Render one projected row as an A2A task.
   * @param activation - the owning context.
   * @param taskId - the task's id.
   * @param view - the folded row.
   * @returns the wire task.
   */
  function projectedTask(
    activation: Activation,
    taskId: A2ATaskId,
    view: { state: A2ATaskState; output?: string | undefined; stopReason?: string | undefined; updatedAt: string },
  ): A2ATask {
    return {
      id: taskId,
      contextId: activation.contextId,
      status: { state: view.state, timestamp: view.updatedAt },
      artifacts: view.output === undefined || view.output.length === 0
        ? []
        : [{
          artifactId: `${taskId}-result`,
          name: 'result',
          parts: [{ text: view.output, mediaType: 'text/plain' }],
        }],
      ...view.stopReason === undefined ? {} : { metadata: { dsh: { stopReason: view.stopReason } } },
    }
  }

  // ── Router ─────────────────────────────────────────────────────────────
  const deps: RouterDeps = {
    readProjectedTask,
    readProjectedTasks,
    config,
    contexts,
    turns,
    rateLimiter,
    logger,
    assertOpen,
    resolvePeerSecrets,
    identify: identifyPeer,
    cardFor,
    extendedCardFor,
    createActivation,
    submit: async (activation, text, peer) => {
      const liveAgent = ctx.agents.get(activation.agent.id)
      if (liveAgent !== activation.agent) {
        throw new Error('the agent was disposed outside the A2A server')
      }
      const taskId = A2ATaskId(randomUUID())
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'a2a-peer', peer, taskId, form: 'relay' } as never,
      })
      const slot = createSlot(taskId, message.id)
      // Arm the slot before followup(): a listener-driven synchronous turn would
      // otherwise slip past correlation and leave the task turnless forever.
      activation.slots.set(taskId, slot)
      appendTaskEdge(activation, taskId, 'TASK_STATE_SUBMITTED')
      try {
        activation.agent.followup(message)
      } catch (error: unknown) {
        activation.slots.delete(taskId)
        throw error
      }
      void activation.agent.whenIdle().then(() => {
        if (activation.slots.get(taskId) !== slot) return
        settleSlot(activation, slot, stateFromEnding(slot.endReason), slot.endReason)
      })
      return slot
    },
    cancel: (activation, slot) => {
      activation.agent.cancel({ kind: 'user' }, { keepInbox: true })
      settleSlot(activation, slot, 'TASK_STATE_CANCELED', 'cancelled')
      turns.reset(activation.contextId)
    },
    taskSnapshot: (activation, slot, state, artifacts, stopReason): A2ATask => ({
      id: slot.taskId,
      contextId: activation.contextId,
      status: { state, timestamp: nowIso() },
      artifacts,
      ...stopReason === undefined ? {} : { metadata: { dsh: { stopReason } } },
    }),
  }

  const router = createRouter(deps)

  // ── HTTP routes ────────────────────────────────────────────────────────
  ctx.effect(function* () {
    yield webServer.register({
      kind: 'exact',
      path: '/.well-known/agent-card.json',
      handler: (req, res) => { router.serveCard(req, res) },
    })
    yield webServer.register({
      kind: 'exact',
      path: '/.well-known/agent.json',
      handler: (req, res) => { router.serveCard(req, res) },
    })
    yield webServer.register({
      kind: 'exact',
      path: config.basePath,
      handler: (req, res) => { void router.serveRpc(req, res) },
    })
  }, 'a2a.routes')

  // ── Idle eviction ──────────────────────────────────────────────────────
  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const activation of contexts.evictable()) {
        contexts.remove(activation.contextId)
        void activation.handle.dispose().catch((error: unknown) => {
          logger.warn(`a2a: evicting ${activation.contextId} failed: ${String(error)}`)
        })
      }
    }, Math.max(1000, Math.floor(config.contextIdleTtlMs / 4)))
    timer.unref?.()
    return () => { clearInterval(timer) }
  }, 'a2a.reaper')

  // ── Teardown ───────────────────────────────────────────────────────────
  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const activations = contexts.drain()

    // Send every stream its terminal frame BEFORE the carrier destroys sockets:
    // a raw socket destroy is indistinguishable from a network fault, and the
    // peer would retry a task that no longer exists.
    router.closeStreams()

    // Stop this server's own work before any await. A descendant drain can block
    // on persistence, and top-level agents must not keep running model and tool
    // calls for its whole duration.
    for (const activation of activations) {
      activation.agent.cancel({ kind: 'user' })
      for (const slot of [...activation.slots.values()]) {
        settleSlot(activation, slot, 'TASK_STATE_CANCELED', 'cancelled')
      }
    }
    rateLimiter.clear()
    turns.clear()

    quiescing = (async () => {
      // Continuable subagents outlive the turn that started them. Drain only the
      // forests below OUR agents, child-first, before releasing them — another
      // frontend sharing this Context keeps its own forest and admission.
      const subagents = ctx.get('subagents') as ContinuableDrain | undefined
      if (subagents !== undefined) {
        try {
          await subagents.drainContinuableDescendants(activations.map(a => a.agent))
        } catch (error: unknown) {
          logger.warn(`a2a: continuable subagent teardown failed: ${String(error)}`)
        }
      }
      const results = await Promise.allSettled(activations.map(a => a.handle.dispose()))
      const failures = results.flatMap(r => r.status === 'rejected' ? [r.reason as unknown] : [])
      if (failures.length > 0) {
        // The production consumer logs this through String(), which renders only
        // the message — so every per-context diagnostic must live in it.
        throw new AggregateError(
          failures,
          `A2A agent teardown failed for ${failures.length} context(s): ` +
          failures.map(f => f instanceof Error ? f.message : String(f)).join('; '),
        )
      }
    })()
    return quiescing
  }

  ctx.effect(() => quiesce, 'a2a.server')
}
