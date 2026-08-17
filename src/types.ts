/**
 * Vocabulary this plugin merges into the harness's own type surfaces.
 *
 * Two declaration merges carry the whole durable contract:
 *
 * - `a2a/task` extends `SessionEventMap` so a task's state lives in the
 *   append-only log. `tasks/get` after a restart therefore has an answer,
 *   which a process-local task table could never give.
 * - `a2aPeer` extends `MessageSourceMap` so an inbound message carries
 *   structured provenance instead of a warning string glued onto its text.
 *   The prose banner approach costs tokens on every message AND varies the
 *   reusable request prefix by peer name; a source field does neither.
 *
 * @module dsh-a2a/types
 */

import type { A2ATaskId, A2ATaskState } from './protocol/index.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One A2A task lifecycle edge. Log-only: no surface operation, absent from
     * model history, retained by the append-only log across compaction.
     *
     * `contextId` is deliberately absent — it IS the SessionId this event is
     * logged under, and recording it twice would create two truths that can
     * disagree.
     */
    'a2a/task': {
      /** The task this edge belongs to. */
      taskId: A2ATaskId
      /** The authenticated peer that submitted it. Never body-asserted. */
      peer: string
      /** The state this edge transitions to. */
      state: A2ATaskState
      /** The turn this task correlates with, once one has claimed its message. */
      turn?: number
      /** Terminal edges only: the real harness turn ending, for Task.metadata. */
      stopReason?: string
      /**
       * Terminal edges only: the committed assistant text this task produced.
       *
       * Carried on the edge rather than derived later because of the
       * projection contract's whole-value rule — a state-carrying event must
       * hold the complete post-change state. Without it a peer polling
       * `tasks/get` gets `completed` and an empty artifact list, which reads as
       * "it worked and produced nothing" rather than "ask again".
       */
      output?: string
    }
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * A message a remote A2A peer addressed to this agent.
     *
     * `form: 'relay'` is the harness's own vocabulary for exactly this — its
     * documented meaning is "a message another agent addressed to this one" —
     * so no new context form is invented here.
     */
    a2aPeer: {
      kind: 'a2a-peer'
      /** Authenticated identity, resolved from the presented credential only. */
      peer: string
      /** The task whose submission carried this message. */
      taskId: A2ATaskId
      form: 'relay'
    }
  }
}

export {}
