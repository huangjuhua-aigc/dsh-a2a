export const SANDBOX_PAUSE_MS = 30_000
export const SANDBOX_STOP_MS = 600_000
export const MAX_RESIDENT_SANDBOXES = 4
export interface SandboxVM { pause(): Promise<void>; resume(): Promise<void>; stop(): Promise<void> }
export interface SandboxDriver<VM extends SandboxVM> {
  /** A validated new public projection, committed only after the old VM stops. */
  stage(peer: string): Promise<undefined | { commit(): Promise<void>; discard(): Promise<void> }>
  start(peer: string): Promise<VM>
  close?(): Promise<void>
}
interface Entry<VM> { peer: string; vm?: VM; paused: boolean; active: number; lastUsed: number; chain: Promise<unknown> }

/** One lifecycle per authenticated peer, shared by all of its conversations. */
export class VisitorSandboxes<VM extends SandboxVM> {
  private readonly entries = new Map<string, Entry<VM>>()
  private capacity: Promise<unknown> = Promise.resolve()
  private closed = false
  private closing?: Promise<void>
  private timer: NodeJS.Timeout | undefined
  constructor(private readonly driver: SandboxDriver<VM>, private readonly options: {
    now?: () => number; pauseMs?: number; stopMs?: number; maxResident?: number; autoTick?: boolean; warn?: (message: string) => void
  } = {}) {
    if ((options.pauseMs ?? SANDBOX_PAUSE_MS) <= 0 || (options.stopMs ?? SANDBOX_STOP_MS) <= (options.pauseMs ?? SANDBOX_PAUSE_MS)) throw new Error('Invalid sandbox idle policy')
    if (options.autoTick !== false) {
      this.timer = setInterval(() => { void this.tick().catch(error => options.warn?.(`Sandbox idle transition failed: ${String(error)}`)) }, 1000)
      this.timer.unref()
    }
  }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.capacity.then(fn, fn)
    this.capacity = pending.catch(() => {})
    return pending
  }
  private async stop(entry: Entry<VM>): Promise<void> {
    if (!entry.vm) return
    // driver.stop resumes a paused VM before graceful shutdown and keeps all disks.
    await entry.vm.stop()
    delete entry.vm; entry.paused = false
  }
  run<T>(peer: string, operation: (vm: VM) => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Visitor sandbox manager is closed'))
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(peer) || peer === 'owner') return Promise.reject(new Error('Invalid visitor identity'))
    let entry = this.entries.get(peer)
    if (!entry) { entry = { peer, paused: false, active: 0, lastUsed: this.now(), chain: Promise.resolve() }; this.entries.set(peer, entry) }
    const target = entry
    target.active++ // queued operations also prevent idle transitions and eviction
    const execute = async (): Promise<T> => {
      signal.throwIfAborted()
      if (this.closed) throw new Error('Visitor sandbox manager is closed')
      const projection = await this.driver.stage(peer)
      try {
        await this.locked(async () => {
          signal.throwIfAborted()
          if (this.closed) throw new Error('Visitor sandbox manager is closed')
          if (projection) { await this.stop(target); await projection.commit() }
          if (!target.vm) {
            const resident = [...this.entries.values()].filter(e => e.vm)
            if (resident.length >= (this.options.maxResident ?? MAX_RESIDENT_SANDBOXES)) {
              const oldest = resident.filter(e => !e.active).sort((a,b) => a.lastUsed - b.lastUsed)[0]
              if (!oldest) throw new Error('Visitor tools are busy; try again later')
              await this.stop(oldest)
            }
            target.vm = await this.driver.start(peer)
          }
          if (target.paused) { await target.vm.resume(); target.paused = false }
        })
      } finally { await projection?.discard() }
      signal.throwIfAborted()
      return await operation(target.vm!)
    }
    const result = target.chain.then(execute, execute).finally(() => { target.active--; target.lastUsed = this.now() })
    target.chain = result.catch(() => {})
    return result
  }
  async tick(): Promise<void> {
    await this.locked(async () => {
      if (this.closed) return
      for (const entry of this.entries.values()) {
        if (!entry.vm || entry.active) continue
        const idle = this.now() - entry.lastUsed
        if (idle >= (this.options.stopMs ?? SANDBOX_STOP_MS)) await this.stop(entry)
        else if (!entry.paused && idle >= (this.options.pauseMs ?? SANDBOX_PAUSE_MS)) { await entry.vm.pause(); entry.paused = true }
      }
    })
  }
  snapshot(): Array<{ peer: string; state: 'running' | 'paused' | 'stopped'; active: number; lastUsed: number }> {
    return [...this.entries.values()].map(e => ({ peer: e.peer, state: !e.vm ? 'stopped' : e.paused ? 'paused' : 'running', active: e.active, lastUsed: e.lastUsed }))
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true; clearInterval(this.timer)
    this.closing = (async () => {
      await Promise.allSettled([...this.entries.values()].map(e => e.chain))
      const results = await this.locked(() => Promise.allSettled([...this.entries.values()].map(e => this.stop(e))))
      await this.driver.close?.()
      const failed = results.filter(r => r.status === 'rejected')
      if (failed.length) throw new AggregateError(failed.map(r => r.reason), 'Could not stop visitor sandboxes')
    })()
    return this.closing
  }
}
