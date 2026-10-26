/** Bounded, private checkpoints for task retention and idle context recovery. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { A2ATask } from './protocol/index.ts'
import type { A2AServerConfig } from './config.ts'

export function deploymentKey(config: Pick<A2AServerConfig, 'basePath' | 'isolation' | 'admin'>): string {
  return createHash('sha256').update(`${config.isolation.workspaceRoot}\n${config.basePath}\n${config.admin?.tokenEnv ?? ''}`).digest('hex').slice(0, 24)
}

export interface ContextCheckpoint {
  id: string
  peer: string
  cwd: string
  updatedAt: number
  turns: number
  /** Last fully idle event prefix; accepted-but-unfinished work is never replayed. */
  events: SessionEvent[]
  tasks: A2ATask[]
  inputs: Record<string, string>
  exhausted?: boolean
}

const checkpointSchema = z.object({
  id: z.string().uuid(), peer: z.string(), cwd: z.string(), updatedAt: z.number(),
  turns: z.number().int().nonnegative(), events: z.array(z.unknown()),
  inputs: z.record(z.string(), z.string()).default({}), exhausted: z.boolean().optional(),
  tasks: z.array(z.object({ id: z.string(), contextId: z.string(), status: z.object({
    state: z.string(), timestamp: z.string(),
  }).passthrough() }).passthrough()),
})
const terminal = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'])

/** Checkpoints are written before acceptance and after idle; directories must not be shared by processes. */
export class StateStore {
  readonly directory: string
  private records = new Map<string, ContextCheckpoint>()
  private readonly lock: string
  private budgets: Record<string, { day: string; count: number }> = {}

  constructor(private readonly config: A2AServerConfig) {
    this.directory = config.storage.directory ?? join(homedir(), '.dsh-a2a', deploymentKey(config))
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.lock = join(this.directory, 'process.lock')
    try {
      const pid = Number(readFileSync(this.lock, 'utf8'))
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('A2A state lock is incomplete or invalid')
      let live = true
      try { process.kill(pid, 0) } catch (error) { live = (error as NodeJS.ErrnoException).code !== 'ESRCH' }
      if (live) throw new Error('A2A state directory is already in use')
      rmSync(this.lock)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const fd = openSync(this.lock, 'wx', 0o600)
    writeFileSync(fd, String(process.pid)); closeSync(fd)
    try {
      for (const file of readdirSync(this.directory)) {
        if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue
        if (statSync(join(this.directory, file)).size > config.storage.maxContextBytes) throw new Error('stored A2A checkpoint exceeds configured size')
        if (this.records.size >= config.storage.maxContexts) throw new Error('stored A2A contexts exceed configured capacity')
        const parsed = checkpointSchema.parse(JSON.parse(readFileSync(join(this.directory, file), 'utf8')))
        if (`${parsed.id}.json` !== file) throw new Error('A2A checkpoint id mismatch')
        // The harness validates the event vocabulary and sequence again at restore.
        const record = parsed as unknown as ContextCheckpoint
        for (const task of record.tasks) {
          if (task.contextId !== record.id) throw new Error('A2A checkpoint task ownership mismatch')
          if (!terminal.has(task.status.state)) {
            task.status = { state: 'TASK_STATE_FAILED', timestamp: new Date().toISOString() }
            task.metadata = { dsh: { stopReason: 'process_restart' } }
          }
        }
        this.records.set(record.id, record)
      }
      try {
        this.budgets = z.record(z.string(), z.object({ day: z.string(), count: z.number().int().nonnegative() }))
          .parse(JSON.parse(readFileSync(join(this.directory, 'budgets.json'), 'utf8')))
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      this.prune()
    } catch (error) { this.close(); throw error }
  }

  private write(name: string, value: unknown): void {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > this.config.storage.maxContextBytes) throw new Error('A2A checkpoint size limit exceeded')
    const target = join(this.directory, name)
    const temporary = `${target}.${randomUUID()}.tmp`
    try { writeFileSync(temporary, text, { mode: 0o600 }); renameSync(temporary, target) }
    finally { rmSync(temporary, { force: true }) }
  }

  save(record: ContextCheckpoint): void {
    this.write(`${record.id}.json`, record)
    this.records.set(record.id, record)
  }

  /** Fail-closed live outcome when disk I/O itself is unavailable. */
  rememberFailure(record: ContextCheckpoint): void { this.records.set(record.id, record) }

  get(id: string, peer: string): ContextCheckpoint | undefined {
    const record = this.records.get(id)
    return record?.peer === peer ? record : undefined
  }

  values(): ContextCheckpoint[] { return [...this.records.values()] }

  ensureRoom(protectedIds: ReadonlySet<string> = new Set()): void {
    this.prune(protectedIds)
    if (this.records.size >= this.config.storage.maxContexts) throw new Error('A2A retained context capacity reached')
  }

  prune(protectedIds: ReadonlySet<string> = new Set()): void {
    for (const [id, record] of this.records) {
      if (!protectedIds.has(id) && record.updatedAt < Date.now() - this.config.storage.retentionMs) {
        rmSync(join(this.directory, `${id}.json`), { force: true })
        this.records.delete(id)
      }
    }
  }

  assertQuota(peer: string): void {
    const current = this.budgets[peer]
    if (current?.day === new Date().toISOString().slice(0, 10) && current.count >= this.config.maxTasksPerPeerPerDay) {
      throw new Error('daily task quota exceeded')
    }
  }

  charge(peer: string): void {
    const day = new Date().toISOString().slice(0, 10)
    const previous = this.budgets[peer]
    const count = previous?.day === day ? previous.count : 0
    this.assertQuota(peer)
    const next = { ...this.budgets, [peer]: { day, count: count + 1 } }
    this.write('budgets.json', next)
    this.budgets = next
  }

  close(): void { rmSync(this.lock, { force: true }) }
}
