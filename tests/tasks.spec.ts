import { describe, expect, it } from 'vitest'
import { artifactsFromTexts, createSlot, stateFromEnding } from '../src/tasks.ts'
import { A2ATaskId } from '../src/protocol/brand.ts'

describe('task slots', () => {
  it('settles exactly once', async () => {
    const slot = createSlot(A2ATaskId('t1'), 'm1')
    slot.settle({ state: 'TASK_STATE_COMPLETED', artifacts: [] })
    slot.settle({ state: 'TASK_STATE_FAILED', artifacts: [] })
    await expect(slot.settled).resolves.toEqual({ state: 'TASK_STATE_COMPLETED', artifacts: [] })
    expect(slot.done).toBe(true)
  })

  it('starts unsettled and uncorrelated', () => {
    const slot = createSlot(A2ATaskId('t1'), 'm1')
    expect(slot.done).toBe(false)
    expect(slot.turn).toBeUndefined()
    expect(slot.endReason).toBeUndefined()
  })
})

describe('turn ending to task state', () => {
  it('treats a turnless slot as cancelled', () => {
    // Admission discarded the message (agent/pre-step rejected it): no turn ran,
    // so nothing was worked and the peer must not be told it completed.
    expect(stateFromEnding(undefined)).toBe('TASK_STATE_CANCELED')
  })

  it('fails only on a model error', () => {
    expect(stateFromEnding('error')).toBe('TASK_STATE_FAILED')
  })

  it('reports cancellation', () => {
    expect(stateFromEnding('cancelled')).toBe('TASK_STATE_CANCELED')
    expect(stateFromEnding('canceled')).toBe('TASK_STATE_CANCELED')
  })

  it('completes on an ordinary ending', () => {
    expect(stateFromEnding('end-turn')).toBe('TASK_STATE_COMPLETED')
    expect(stateFromEnding('stop')).toBe('TASK_STATE_COMPLETED')
  })

  it('completes on a token ceiling rather than failing', () => {
    // The agent produced real work and stopped for its own reasons; `failed`
    // would tell the peer to discard it. The true ending rides in metadata.
    expect(stateFromEnding('max-tokens')).toBe('TASK_STATE_COMPLETED')
  })
})

describe('artifacts', () => {
  it('produces one text artifact from committed output', () => {
    expect(artifactsFromTexts(A2ATaskId('t1'), ['hello', 'world'])).toEqual([{
      artifactId: 't1-result',
      name: 'result',
      parts: [{ text: 'hello\nworld', mediaType: 'text/plain' }],
    }])
  })

  it('produces none when the agent committed nothing', () => {
    expect(artifactsFromTexts(A2ATaskId('t1'), [])).toEqual([])
    expect(artifactsFromTexts(A2ATaskId('t1'), ['', ''])).toEqual([])
  })
})
