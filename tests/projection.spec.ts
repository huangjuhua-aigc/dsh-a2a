/**
 * The `a2aTask` fold, tested as pure mathematics.
 *
 * No Cordis, no session, no HTTP: a projection unit is three synchronous pure
 * functions, and the contract it must satisfy (same-reference for uninteresting
 * events, plain-JSON state, schema-valid view) is checkable directly.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { a2aTaskProjection, A2A_TASK_VIEW_SCHEMA } from '../src/projection.ts'
import type { A2ATaskState } from '../src/protocol/index.ts'

/** Build an `a2a/task` edge the way the server appends one. */
function edge(
  taskId: string,
  state: A2ATaskState,
  extra: { peer?: string; stopReason?: string; output?: string } = {},
): SessionEvent {
  return {
    type: 'a2a/task',
    data: {
      taskId,
      peer: extra.peer ?? 'alice',
      state,
      ...extra.stopReason === undefined ? {} : { stopReason: extra.stopReason },
      ...extra.output === undefined ? {} : { output: extra.output },
    },
  } as unknown as SessionEvent
}

/** Build an unrelated session event. */
function unrelated(): SessionEvent {
  return { type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent
}

describe('the same-reference discipline', () => {
  it('returns the identical state object for an unrelated event', () => {
    const state = a2aTaskProjection.init()
    // The drive gates its change feed on Object.is: a fresh object here would
    // wake every downstream consumer on every unrelated event in the session.
    expect(a2aTaskProjection.apply(state, unrelated())).toBe(state)
  })

  it('returns the identical state object for a malformed edge', () => {
    const state = a2aTaskProjection.init()
    const malformed = { type: 'a2a/task', data: { peer: 'alice' } } as unknown as SessionEvent
    expect(a2aTaskProjection.apply(state, malformed)).toBe(state)
  })

  it('returns a NEW state object for an edge it folds', () => {
    const state = a2aTaskProjection.init()
    expect(a2aTaskProjection.apply(state, edge('t1', 'submitted'))).not.toBe(state)
  })
})

describe('folding task lifecycle', () => {
  it('records a submitted task', () => {
    const state = a2aTaskProjection.apply(a2aTaskProjection.init(), edge('t1', 'submitted'))
    expect(state.tasks['t1']?.state).toBe('submitted')
    expect(state.tasks['t1']?.peer).toBe('alice')
  })

  it('advances a task through its transitions', () => {
    let state = a2aTaskProjection.init()
    state = a2aTaskProjection.apply(state, edge('t1', 'submitted'))
    state = a2aTaskProjection.apply(state, edge('t1', 'working'))
    state = a2aTaskProjection.apply(state, edge('t1', 'completed', { stopReason: 'stop' }))
    expect(state.tasks['t1']?.state).toBe('completed')
    expect(state.tasks['t1']?.stopReason).toBe('stop')
  })

  it('carries the committed output on the terminal edge', () => {
    // The projection contract's whole-value rule: a state-carrying event must
    // hold the complete post-change state, so the fold can serve the answer
    // without reaching back into the message log.
    let state = a2aTaskProjection.init()
    state = a2aTaskProjection.apply(state, edge('t1', 'working'))
    state = a2aTaskProjection.apply(state, edge('t1', 'completed', { output: 'the answer is 42' }))
    expect(state.tasks['t1']?.output).toBe('the answer is 42')
  })

  it('keeps tasks independent within one session', () => {
    let state = a2aTaskProjection.init()
    state = a2aTaskProjection.apply(state, edge('t1', 'completed'))
    state = a2aTaskProjection.apply(state, edge('t2', 'working'))
    expect(state.tasks['t1']?.state).toBe('completed')
    expect(state.tasks['t2']?.state).toBe('working')
  })

  it('treats a terminal state as final', () => {
    // A late or duplicated edge must not reopen a settled task: the peer has
    // already been told the outcome.
    let state = a2aTaskProjection.apply(a2aTaskProjection.init(), edge('t1', 'completed'))
    const settled = state
    state = a2aTaskProjection.apply(state, edge('t1', 'working'))
    expect(state).toBe(settled)
    expect(state.tasks['t1']?.state).toBe('completed')
  })

  it('records who submitted each task, for the ownership check', () => {
    let state = a2aTaskProjection.init()
    state = a2aTaskProjection.apply(state, edge('t1', 'completed', { peer: 'alice' }))
    state = a2aTaskProjection.apply(state, edge('t2', 'completed', { peer: 'bob' }))
    expect(state.tasks['t1']?.peer).toBe('alice')
    expect(state.tasks['t2']?.peer).toBe('bob')
  })
})

describe('the view', () => {
  it('produces a schema-valid wire payload', () => {
    let state = a2aTaskProjection.init()
    state = a2aTaskProjection.apply(state, edge('t1', 'completed', { stopReason: 'stop' }))
    state = a2aTaskProjection.apply(state, edge('t2', 'working'))
    expect(() => A2A_TASK_VIEW_SCHEMA.parse(a2aTaskProjection.view(state))).not.toThrow()
  })

  it('produces a schema-valid payload for an empty log', () => {
    expect(() => A2A_TASK_VIEW_SCHEMA.parse(a2aTaskProjection.view(a2aTaskProjection.init())))
      .not.toThrow()
  })

  it('keeps the state plain JSON, as the persisted cache requires', () => {
    let state = a2aTaskProjection.init()
    state = a2aTaskProjection.apply(state, edge('t1', 'completed'))
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })
})

describe('declarations', () => {
  it('owns its projection key and a non-negative state version', () => {
    expect(a2aTaskProjection.key).toBe('a2aTask')
    expect(Number.isInteger(a2aTaskProjection.stateVersion)).toBe(true)
    expect(a2aTaskProjection.stateVersion).toBeGreaterThanOrEqual(0)
  })
})
