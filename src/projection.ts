/**
 * The `a2aTask` projection unit: task state read back from the session log.
 *
 * Without this, task state lives only in the process-local slot table, and
 * `settleSlot` removes a slot the moment it settles — so a peer that polls
 * `GetTask` is told the task never existed, moments after it completed. That
 * breaks the polling path A2A treats as the baseline update mechanism
 * (`SendStreamingMessage` and push notifications are both optional
 * capabilities; `GetTask` is not).
 *
 * The unit is a pure left fold over the `a2a/task` edges the server already
 * appends. It holds no subscriptions: the registry drives every committed event
 * through `apply` once, and the persisted projection cache turns a cold read
 * into a cache row plus a tail replay rather than a full log load.
 *
 * @module dsh-a2a/projection
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { A2ATaskId, A2ATaskState } from './protocol/index.ts'

/** One task's durable read model. */
export interface A2ATaskView {
  taskId: string
  /** The authenticated peer that submitted it. Ownership is checked against this. */
  peer: string
  state: A2ATaskState
  /**
   * The committed assistant text, when the terminal edge recorded any.
   *
   * This is what lets a polling peer receive the ANSWER rather than only the
   * fact that the task finished — an empty artifact list on a `completed` task
   * reads as "it worked and produced nothing".
   */
  output?: string | undefined
  /**
   * The harness turn ending, when the terminal edge recorded one.
   *
   * Explicitly `| undefined` because the value round-trips through a zod schema
   * whose inferred optional includes it, and this project compiles with
   * `exactOptionalPropertyTypes`.
   */
  stopReason?: string | undefined
  /** Wall-clock of the last recorded edge, for `Task.status.timestamp`. */
  updatedAt: string
}

/** The whole projected value: every task this session has seen. */
export interface A2ATaskProjection {
  tasks: Record<string, A2ATaskView>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Per-session A2A task states, folded from `a2a/task` edges. */
    a2aTask: A2ATaskProjection
  }
}

const STATES = [
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED',
  'TASK_STATE_FAILED', 'TASK_STATE_REJECTED',
] as const

/** Validates the wire payload before it leaves the host. */
export const A2A_TASK_VIEW_SCHEMA = z.object({
  tasks: z.record(z.string(), z.object({
    taskId: z.string(),
    peer: z.string(),
    state: z.enum(STATES),
    output: z.string().optional(),
    stopReason: z.string().optional(),
    updatedAt: z.string(),
  })),
})

/** The projection unit's internal state. Plain JSON, per the cache precondition. */
export interface A2ATaskState_ {
  tasks: Record<string, A2ATaskView>
}

/** The shape of an `a2a/task` event's data, as this plugin appends it. */
interface TaskEdge {
  taskId: A2ATaskId
  peer: string
  state: A2ATaskState
  turn?: number
  stopReason?: string
  output?: string
}

/**
 * The projection definition, in the shape `ctx.sessionProjections.register()` wants.
 *
 * Declared as a plain object rather than built inside `apply()` so the fold can
 * be unit-tested without a Cordis context or a session.
 */
export const a2aTaskProjection = {
  key: 'a2aTask' as const,
  schema: A2A_TASK_VIEW_SCHEMA,
  // Bumped for A2A v1.0: task states are persisted in their new ProtoJSON
  // spelling, so a cache written under the v0.3 spelling must be discarded
  // rather than folded onto.
  stateVersion: 2,

  /**
   * State for the empty log.
   * @returns the initial state.
   */
  init(): A2ATaskState_ {
    return { tasks: {} }
  },

  /**
   * Fold one committed event.
   *
   * Returns the SAME reference for every event that is not an `a2a/task` edge:
   * the drive gates its change feed on `Object.is`, so a fresh object here would
   * wake every downstream consumer on every unrelated event in the session.
   * @param state - the state covering all prior events.
   * @param event - the next committed session event.
   * @returns the next state, or `state` unchanged.
   */
  apply(state: A2ATaskState_, event: SessionEvent): A2ATaskState_ {
    if (event.type !== 'a2a/task') return state
    const data = event.data as unknown as TaskEdge
    if (typeof data?.taskId !== 'string' || typeof data.state !== 'string') return state

    const previous = state.tasks[data.taskId]
    // Terminal states are final: a late edge must not reopen a settled task.
    if (previous !== undefined && TERMINAL.has(previous.state)) return state

    return {
      tasks: {
        ...state.tasks,
        [data.taskId]: {
          taskId: data.taskId,
          peer: data.peer,
          state: data.state,
          ...data.output === undefined ? {} : { output: data.output },
          ...data.stopReason === undefined ? {} : { stopReason: data.stopReason },
          // The log has no wall-clock of its own, so the fold stamps when it
          // observed the edge. A replay therefore restamps; consumers use this
          // for `Task.status.timestamp`, which A2A treats as advisory.
          updatedAt: new Date().toISOString(),
        },
      },
    }
  },

  /**
   * State → wire payload.
   * @param state - the current state.
   * @returns the whole current value.
   */
  view(state: A2ATaskState_): A2ATaskProjection {
    return { tasks: state.tasks }
  },
}

const TERMINAL = new Set<A2ATaskState>([
  'TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED',
])
