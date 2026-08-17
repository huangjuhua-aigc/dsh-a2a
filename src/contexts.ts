/**
 * The contextId → Activation registry and its residency policy.
 *
 * This is the biggest structural difference from `dsh-acp`. ACP has a stdio
 * connection whose lifetime owns its sessions; HTTP has no connection lifetime
 * at all, so residency must be an explicit policy. An **Activation** is one
 * residency epoch for a contextId — the same word `ctx.subagents` uses for a
 * continuable child's residency, and the same shape: evicting an Activation
 * releases the AgentHandle while the durable Session stays, so the next message
 * cold-resumes rather than starting over.
 *
 * @module dsh-a2a/contexts
 */

import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { A2AContextId, A2ATaskId } from './protocol/index.ts'
import type { TaskSlot } from './tasks.ts'

/** One resident contextId. */
export interface Activation {
  readonly contextId: A2AContextId
  readonly agent: Agent
  readonly handle: AgentHandle
  /** The authenticated peer that created this context. Ownership is by identity. */
  readonly peer: string
  /** The resolved working directory this context's agent runs in. */
  readonly cwd: string
  /** In-flight tasks, keyed by task id. FIFO order comes from the agent inbox. */
  readonly slots: Map<A2ATaskId, TaskSlot>
  /** Last time a request touched this context, for idle eviction. */
  lastTouchedAt: number
}

/** Why a context lookup did not produce an Activation. */
export type LookupFailure = 'unknown' | 'forbidden'

/** Registry of resident contexts with LRU + idle eviction. */
export class ContextRegistry {
  private readonly activations = new Map<A2AContextId, Activation>()

  /**
   * @param maxResident - hard ceiling on resident contexts.
   * @param idleTtlMs - how long an untouched, quiet context stays resident.
   * @param now - clock injection point for tests.
   */
  constructor(
    private readonly maxResident: number,
    private readonly idleTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every resident Activation, in insertion order. */
  values(): Activation[] {
    return [...this.activations.values()]
  }

  /** How many contexts are currently resident. */
  get size(): number {
    return this.activations.size
  }

  /**
   * Look up a context on behalf of an authenticated peer.
   *
   * A context owned by ANOTHER peer reports `forbidden`, and the caller must
   * answer exactly as it answers `unknown` — otherwise a peer could enumerate
   * which context ids exist by comparing the two responses.
   * @param contextId - the id the peer presented.
   * @param peer - the authenticated identity making the request.
   * @returns the Activation, or why it is unavailable.
   */
  lookup(contextId: A2AContextId, peer: string): Activation | LookupFailure {
    const activation = this.activations.get(contextId)
    if (activation === undefined) return 'unknown'
    if (activation.peer !== peer) return 'forbidden'
    activation.lastTouchedAt = this.now()
    return activation
  }

  /**
   * Register a freshly created or resumed Activation.
   * @param activation - the Activation to hold.
   */
  add(activation: Activation): void {
    this.activations.set(activation.contextId, activation)
  }

  /**
   * Remove an Activation from the registry without disposing it.
   * @param contextId - the context to forget.
   * @returns the removed Activation, if it was resident.
   */
  remove(contextId: A2AContextId): Activation | undefined {
    const activation = this.activations.get(contextId)
    this.activations.delete(contextId)
    return activation
  }

  /** Forget every Activation and return them for the caller to dispose. */
  drain(): Activation[] {
    const all = this.values()
    this.activations.clear()
    return all
  }

  /**
   * Select Activations that may be evicted right now.
   *
   * An Activation is evictable only when nothing is owed: no in-flight task and
   * no recent touch. A context over the resident ceiling is evicted by least
   * recent touch — but a busy context is NEVER evicted to make room, because
   * dropping work a peer is waiting on is worse than exceeding a soft ceiling.
   * @returns Activations the caller should dispose and remove.
   */
  evictable(): Activation[] {
    const cutoff = this.now() - this.idleTtlMs
    const quiet = this.values().filter(a => a.slots.size === 0)
    const expired = quiet.filter(a => a.lastTouchedAt <= cutoff)
    if (this.activations.size <= this.maxResident) return expired

    const overflow = this.activations.size - this.maxResident
    const byOldest = quiet
      .filter(a => !expired.includes(a))
      .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt)
      .slice(0, Math.max(0, overflow - expired.length))
    return [...expired, ...byOldest]
  }
}
