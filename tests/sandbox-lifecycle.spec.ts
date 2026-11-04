import { describe, expect, it } from 'vitest'
import { VisitorSandboxes, type SandboxDriver, type SandboxVM, SANDBOX_PAUSE_MS, SANDBOX_STOP_MS } from '../src/sandbox-lifecycle.ts'

class VM implements SandboxVM {
  paused = false; stopped = false; pauses = 0; resumes = 0
  constructor(readonly peer: string) {}
  async pause() { this.paused = true; this.pauses++ }
  async resume() { this.paused = false; this.resumes++ }
  async stop() { this.stopped = true }
}
function fixture(maxResident = 4) {
  let time = 0
  const starts: VM[] = []
  const driver: SandboxDriver<VM> = { stage: async () => undefined, start: async peer => { const vm = new VM(peer); starts.push(vm); return vm } }
  const manager = new VisitorSandboxes(driver, { autoTick: false, now: () => time, maxResident })
  return { manager, driver, starts, advance: (ms: number) => { time += ms } }
}
const signal = () => new AbortController().signal
describe('visitor sandbox lifecycle', () => {
  it('starts only for tools; reuses by peer; pauses at 30 seconds and stops at 10 minutes without destroying disks', async () => {
    const f = fixture()
    expect(f.manager.snapshot()).toEqual([])
    await f.manager.run('alice', async () => {}, signal())
    await f.manager.run('alice', async () => {}, signal())
    expect(f.starts).toHaveLength(1)
    f.advance(SANDBOX_PAUSE_MS - 1); await f.manager.tick(); expect(f.starts[0]!.paused).toBe(false)
    f.advance(1); await f.manager.tick(); expect(f.starts[0]!.paused).toBe(true)
    f.advance(SANDBOX_STOP_MS - SANDBOX_PAUSE_MS - 1); await f.manager.tick(); expect(f.starts[0]!.stopped).toBe(false)
    f.advance(1); await f.manager.tick(); expect(f.starts[0]!.stopped).toBe(true)
    expect(f.manager.snapshot()[0]!.state).toBe('stopped')
    await f.manager.run('alice', async () => {}, signal()); expect(f.starts).toHaveLength(2)
    await f.manager.close()
  })
  it('resumes the same visitor and resets idle time after its last tool ends', async () => {
    const f = fixture()
    await f.manager.run('alice', async () => {}, signal())
    f.advance(30_000); await f.manager.tick()
    await f.manager.run('alice', async vm => { expect(vm.paused).toBe(false) }, signal())
    expect(f.starts[0]!.resumes).toBe(1)
    f.advance(29_999); await f.manager.tick(); expect(f.starts[0]!.paused).toBe(false)
    await f.manager.close()
  })
  it('never pauses active or queued tools and serializes calls for the same visitor', async () => {
    const f = fixture(); let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    let entered!: () => void; const began = new Promise<void>(done => { entered = done })
    const first = f.manager.run('alice', async () => { entered(); await gate }, signal())
    await began
    let secondRan = false
    const second = f.manager.run('alice', async () => { secondRan = true }, signal())
    f.advance(700_000); await f.manager.tick()
    expect(f.starts[0]!.pauses).toBe(0); expect(f.starts[0]!.stopped).toBe(false); expect(secondRan).toBe(false)
    release(); await Promise.all([first, second]); expect(secondRan).toBe(true)
    f.advance(30_000); await f.manager.tick(); expect(f.starts[0]!.paused).toBe(true)
    await f.manager.close()
  })
  it('never shares VMs between visitors, evicts idle instances at capacity and refuses when all are busy', async () => {
    const f = fixture(1)
    await f.manager.run('alice', async vm => { expect(vm.peer).toBe('alice') }, signal())
    await f.manager.run('bob', async vm => { expect(vm.peer).toBe('bob') }, signal())
    expect(f.starts[0]!.stopped).toBe(true)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(r => { release = r }), began = new Promise<void>(r => { entered = r })
    const active = f.manager.run('bob', async () => { entered(); await gate }, signal()); await began
    await expect(f.manager.run('alice', async () => {}, signal())).rejects.toThrow('busy')
    release(); await active; await f.manager.close()
  })
  it('fails closed on setup errors, observes cancellation and stops instances on shutdown', async () => {
    const f = fixture()
    const canceled = new AbortController(); canceled.abort()
    await expect(f.manager.run('alice', async () => { throw new Error('should not run') }, canceled.signal)).rejects.toThrow()
    expect(f.starts).toHaveLength(0)
    f.driver.stage = async () => { throw new Error('unsafe shared directory') }
    await expect(f.manager.run('alice', async () => {}, signal())).rejects.toThrow('unsafe')
    f.driver.stage = async () => undefined
    await f.manager.run('alice', async () => {}, signal())
    await f.manager.close(); expect(f.starts[0]!.stopped).toBe(true)
    await expect(f.manager.run('alice', async () => {}, signal())).rejects.toThrow('closed')
  })
  it('stops before replacing a public projection and never discards visitor persistence', async () => {
    const f = fixture(); await f.manager.run('alice', async () => {}, signal())
    let committed = false, discarded = false
    f.driver.stage = async () => ({ commit: async () => { expect(f.starts[0]!.stopped).toBe(true); committed = true }, discard: async () => { discarded = true } })
    await f.manager.run('alice', async () => {}, signal())
    expect(committed && discarded).toBe(true); expect(f.starts).toHaveLength(2)
    await f.manager.close()
  })
})
