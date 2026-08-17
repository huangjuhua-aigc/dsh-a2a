import { describe, expect, it } from 'vitest'
import { ContextRegistry, type Activation } from '../src/contexts.ts'
import { A2AContextId, A2ATaskId } from '../src/protocol/brand.ts'
import { createSlot } from '../src/tasks.ts'

/**
 * Build a stand-in Activation. The registry never touches the agent or handle,
 * so a structural stub keeps these tests free of a booted composition.
 */
function activation(id: string, peer: string, touchedAt: number): Activation {
  return {
    contextId: A2AContextId(id),
    agent: {} as Activation['agent'],
    handle: {} as Activation['handle'],
    peer,
    cwd: `/srv/${peer}`,
    slots: new Map(),
    lastTouchedAt: touchedAt,
  }
}

describe('ownership', () => {
  it('returns the activation to its owner', () => {
    const registry = new ContextRegistry(10, 1000, () => 5000)
    registry.add(activation('c1', 'alice', 5000))
    const found = registry.lookup(A2AContextId('c1'), 'alice')
    expect(found).not.toBe('unknown')
    expect(found).not.toBe('forbidden')
  })

  it('refuses another peer, distinguishably from absent only INTERNALLY', () => {
    const registry = new ContextRegistry(10, 1000, () => 5000)
    registry.add(activation('c1', 'alice', 5000))
    // The registry reports the distinction so the caller can log it; the caller
    // must still answer the wire identically for both, or a peer could probe
    // which context ids exist.
    expect(registry.lookup(A2AContextId('c1'), 'bob')).toBe('forbidden')
    expect(registry.lookup(A2AContextId('c2'), 'bob')).toBe('unknown')
  })

  it('refreshes the touch timestamp on a successful lookup', () => {
    let clock = 5000
    const registry = new ContextRegistry(10, 1000, () => clock)
    registry.add(activation('c1', 'alice', 1000))
    clock = 9000
    const found = registry.lookup(A2AContextId('c1'), 'alice') as Activation
    expect(found.lastTouchedAt).toBe(9000)
  })

  it('does not refresh the timestamp for a refused lookup', () => {
    let clock = 5000
    const registry = new ContextRegistry(10, 1000, () => clock)
    const a = activation('c1', 'alice', 1000)
    registry.add(a)
    clock = 9000
    registry.lookup(A2AContextId('c1'), 'bob')
    expect(a.lastTouchedAt).toBe(1000)
  })
})

describe('eviction', () => {
  it('evicts a context idle past the ttl', () => {
    let clock = 10_000
    const registry = new ContextRegistry(10, 1000, () => clock)
    registry.add(activation('old', 'alice', 5000))
    registry.add(activation('fresh', 'alice', 9_900))
    expect(registry.evictable().map(a => a.contextId)).toEqual(['old'])
  })

  it('never evicts a context with an in-flight task', () => {
    let clock = 10_000
    const registry = new ContextRegistry(10, 1000, () => clock)
    const busy = activation('busy', 'alice', 1000)
    busy.slots.set(A2ATaskId('t1'), createSlot(A2ATaskId('t1'), 'm1'))
    registry.add(busy)
    expect(registry.evictable()).toEqual([])
  })

  it('evicts the least recently touched when over the resident ceiling', () => {
    let clock = 10_000
    const registry = new ContextRegistry(2, 1_000_000, () => clock)
    registry.add(activation('a', 'alice', 9_000))
    registry.add(activation('b', 'alice', 9_500))
    registry.add(activation('c', 'alice', 9_900))
    expect(registry.evictable().map(a => a.contextId)).toEqual(['a'])
  })

  it('exceeds the ceiling rather than dropping work a peer is waiting on', () => {
    let clock = 10_000
    const registry = new ContextRegistry(1, 1_000_000, () => clock)
    const busyA = activation('a', 'alice', 9_000)
    busyA.slots.set(A2ATaskId('t1'), createSlot(A2ATaskId('t1'), 'm1'))
    const busyB = activation('b', 'alice', 9_500)
    busyB.slots.set(A2ATaskId('t2'), createSlot(A2ATaskId('t2'), 'm2'))
    registry.add(busyA)
    registry.add(busyB)
    expect(registry.evictable()).toEqual([])
    expect(registry.size).toBe(2)
  })
})

describe('drain', () => {
  it('returns every activation and empties the registry', () => {
    const registry = new ContextRegistry(10, 1000, () => 5000)
    registry.add(activation('a', 'alice', 5000))
    registry.add(activation('b', 'bob', 5000))
    expect(registry.drain()).toHaveLength(2)
    expect(registry.size).toBe(0)
  })
})
