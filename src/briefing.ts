/** One automatic briefing loop owned by the online agent, independent of Portal. */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const BRIEFING_INTERVAL_MS = 60 * 60 * 1000
const CHECK_INTERVAL_MS = 5000

interface LegacyBriefingScheduler {
  catalog(): Promise<Array<{ id: string; sessionId: string; title: string; prompt: string }>>
  delete(request: { id: string; sessionId: string }): Promise<unknown>
}

/** Retire only the old Portal-generated job for this exact project. */
export async function retireLegacyBriefing(scheduler: LegacyBriefingScheduler | undefined, root: string): Promise<void> {
  if (!scheduler?.catalog || !scheduler.delete) return
  const prefix = `【简报维护任务】受信任的项目范围只有一个：\n  ${root}\n`
  for (const task of await scheduler.catalog()) {
    if (task.title === '简报维护' && task.prompt.startsWith(prefix)
      && (task.prompt.includes('4. 把简报写入当前工作目录的 handoff.draft.md')
        || task.prompt.includes('4. 完整生成并检查上述内容后，直接覆盖写入当前工作目录的 handoff.md。'))) {
      await scheduler.delete({ id: task.id, sessionId: task.sessionId })
    }
  }
}

export class AutomaticBriefing {
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false
  private running = false
  private enabled = true
  private nextRunAt = 0
  private readonly stateFile: string

  constructor(private readonly options: {
    settingsFile: string
    stateDirectory: string
    run: () => Promise<void>
    warn: (message: string) => void
    now?: () => number
  }) {
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 })
    this.stateFile = join(options.stateDirectory, 'briefing-state.json')
    try {
      const state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { enabled: boolean; nextRunAt: number }
      if (typeof state.enabled !== 'boolean' || !Number.isSafeInteger(state.nextRunAt) || state.nextRunAt < 0) throw new Error('invalid briefing state')
      this.enabled = state.enabled
      this.nextRunAt = state.nextRunAt
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }

  private save(): void {
    const temporary = `${this.stateFile}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ enabled: this.enabled, nextRunAt: this.nextRunAt }), { mode: 0o600 })
      renameSync(temporary, this.stateFile)
    } finally { rmSync(temporary, { force: true }) }
  }

  private readEnabled(): boolean {
    try {
      const value = JSON.parse(readFileSync(this.options.settingsFile, 'utf8')) as { enabled: unknown }
      if (typeof value.enabled !== 'boolean') throw new Error('invalid automatic briefing setting')
      return value.enabled
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  }

  /** Polling also observes an off/on switch without restarting the agent. */
  async tick(): Promise<void> {
    if (this.closed) return
    try {
      const enabled = this.readEnabled()
      const now = this.options.now?.() ?? Date.now()
      if (enabled !== this.enabled) {
        this.enabled = enabled
        if (enabled) this.nextRunAt = now
        this.save()
      }
      if (!enabled || this.running || now < this.nextRunAt) return
      // Persist before paid work: restarting must not immediately repeat a run.
      this.nextRunAt = now + BRIEFING_INTERVAL_MS
      this.save()
      this.running = true
      try { await this.options.run() } finally { this.running = false }
    } catch (error) { this.options.warn(`a2a: automatic briefing failed: ${String(error)}`) }
  }

  start(): void {
    if (this.closed || this.timer) return
    this.timer = setInterval(() => { void this.tick() }, CHECK_INTERVAL_MS)
    this.timer.unref()
    void this.tick()
  }

  stop(): void {
    this.closed = true
    clearInterval(this.timer)
  }
}
