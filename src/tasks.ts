/**
 * Task slots and the three-stage turn correlation.
 *
 * The hard part of bridging A2A onto the harness is that ONE SUBMITTED MESSAGE
 * IS NOT ONE TURN. A task spans from the message being accepted until the whole
 * agent falls idle, which may be several turns if tools queue more work. Three
 * hooks cooperate:
 *
 *   agent/inbox/claimed  →  bind this task's messageId to the turn that took it
 *   turn/end             →  record that turn's ending (a model error fails now)
 *   agent.whenIdle()     →  settle, using the recorded ending
 *
 * This mirrors what `dsh-acp` does for its prompts, and for the same reason:
 * steering and injected work may contribute before quiescence, so the bridge
 * does not claim a task-specific turn outcome.
 *
 * @module dsh-a2a/tasks
 */

import type { A2AArtifact, A2ATaskId, A2ATaskState } from './protocol/index.ts'

/** How a task's final state was reached, for `Task.metadata.dsh.stopReason`. */
export interface TaskSettlement {
  state: A2ATaskState
  /** The harness's real turn ending, which A2A's state enum cannot express. */
  stopReason?: string
  /** Text the agent committed during this task's span. */
  artifacts: A2AArtifact[]
}

/** One in-flight task awaiting settlement. */
export interface TaskSlot {
  readonly taskId: A2ATaskId
  /** The user message id, used to correlate with the turn that claims it. */
  readonly messageId: string
  /** Set by `agent/inbox/claimed` once a turn takes the message. */
  turn: number | undefined
  /** Set at `turn/end` for the correlated turn; undefined means turnless. */
  endReason: string | undefined
  /** Committed assistant text collected during this task's span. */
  readonly texts: string[]
  /** Resolves when the task reaches a terminal state. */
  readonly settled: Promise<TaskSettlement>
  /** Fulfils `settled` exactly once. */
  settle: (settlement: TaskSettlement) => void
  /** Whether `settle` has already run. */
  done: boolean
}

/**
 * Create an unsettled task slot.
 * @param taskId - the minted task id.
 * @param messageId - the id of the user message this task submitted.
 * @returns the slot, with its settlement promise already armed.
 */
export function createSlot(taskId: A2ATaskId, messageId: string): TaskSlot {
  let fulfil: ((settlement: TaskSettlement) => void) | undefined
  const settled = new Promise<TaskSettlement>((resolve) => { fulfil = resolve })
  const slot: TaskSlot = {
    taskId,
    messageId,
    turn: undefined,
    endReason: undefined,
    texts: [],
    settled,
    done: false,
    settle: (settlement) => {
      if (slot.done) return
      slot.done = true
      fulfil?.(settlement)
    },
  }
  return slot
}

/**
 * Build the artifact list from the text a task's agent committed.
 *
 * A2A has artifacts; the harness has assistant messages. One text artifact per
 * task keeps the mapping honest without inventing structure the agent never
 * produced. Tool calls and results stay out — A2A's opaque-execution principle
 * says a peer sees results, not how they were reached.
 * @param taskId - used to derive a stable artifact id.
 * @param texts - committed assistant texts, in order.
 * @returns zero or one artifact.
 */
export function artifactsFromTexts(taskId: A2ATaskId, texts: readonly string[]): A2AArtifact[] {
  const joined = texts.filter(text => text.length > 0).join('\n')
  if (joined.length === 0) return []
  return [{
    artifactId: `${taskId}-result`,
    name: 'result',
    parts: [{ kind: 'text', text: joined }],
  }]
}

/**
 * Map a harness turn ending onto an A2A terminal state.
 *
 * A token ceiling is NOT a task-level failure: the agent stopped for its own
 * reasons having produced real work, and A2A's `failed` would tell the peer to
 * discard it. The true ending still travels in `Task.metadata.dsh.stopReason`.
 * @param endReason - the harness turn ending kind, or undefined for a turnless slot.
 * @returns the A2A state to settle with.
 */
export function stateFromEnding(endReason: string | undefined): A2ATaskState {
  if (endReason === undefined) return 'canceled'
  if (endReason === 'error') return 'failed'
  if (endReason === 'cancelled' || endReason === 'canceled') return 'canceled'
  return 'completed'
}
