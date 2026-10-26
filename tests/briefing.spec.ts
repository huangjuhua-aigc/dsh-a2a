import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomaticBriefing, BRIEFING_INTERVAL_MS, retireLegacyBriefing } from '../src/briefing.ts'
import { compose, type Composition } from '../example/compose.ts'
import { ipc } from './ipc.ts'

let root: string
let settingsFile: string
let now: number
let app: Composition | undefined
const loops: AutomaticBriefing[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'a2a-automatic-'))
  settingsFile = join(root, 'setting.json')
  now = 1_000_000
})
afterEach(async () => {
  for (const loop of loops.splice(0)) loop.stop()
  await app?.stop(); app = undefined
  vi.unstubAllEnvs()
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected fixture directory')
  await rm(root, { recursive: true, force: true })
})
const setEnabled = (enabled: boolean) => writeFile(settingsFile, JSON.stringify({ enabled }))
const create = (run = vi.fn(async () => {}), warn = vi.fn()) => {
  const loop = new AutomaticBriefing({ settingsFile, stateDirectory: join(root, 'private'), run, warn, now: () => now })
  loops.push(loop)
  return { loop, run, warn }
}

describe('automatic briefing', () => {
  it('defaults on and updates once per hour without duplicate runs', async () => {
    const { loop, run } = create()
    await loop.tick(); await loop.tick()
    expect(run).toHaveBeenCalledTimes(1)
    now += BRIEFING_INTERVAL_MS - 1
    await loop.tick(); expect(run).toHaveBeenCalledTimes(1)
    now++
    await loop.tick(); expect(run).toHaveBeenCalledTimes(2)
  })
  it('keeps the switch off across restart and preserves the last briefing', async () => {
    const published = join(root, 'handoff.md')
    await writeFile(published, 'KEEP_ME')
    await setEnabled(false)
    const first = create()
    await first.loop.tick(); first.loop.stop()
    now += BRIEFING_INTERVAL_MS * 3
    const second = create()
    await second.loop.tick()
    expect(first.run).not.toHaveBeenCalled()
    expect(second.run).not.toHaveBeenCalled()
    expect(await readFile(published, 'utf8')).toBe('KEEP_ME')
  })
  it('reenabling requests one immediate update and repeated on settings do not duplicate it', async () => {
    const { loop, run } = create()
    await loop.tick()
    await setEnabled(false); await loop.tick()
    await setEnabled(true); await loop.tick()
    await setEnabled(true); await loop.tick()
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('lets an active run finish after switching off and starts no later work', async () => {
    let finish!: () => void
    const run = vi.fn(() => new Promise<void>(done => { finish = done }))
    const { loop } = create(run)
    const active = loop.tick()
    await setEnabled(false)
    now += BRIEFING_INTERVAL_MS * 2
    await loop.tick()
    expect(run).toHaveBeenCalledTimes(1)
    finish(); await active; await loop.tick()
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('does not repeat recently started work after an agent restart', async () => {
    const first = create()
    await first.loop.tick(); first.loop.stop()
    const second = create()
    await second.loop.tick(); expect(second.run).not.toHaveBeenCalled()
    now += BRIEFING_INTERVAL_MS
    await second.loop.tick(); expect(second.run).toHaveBeenCalledTimes(1)
  })
  it('bounds failures to the hourly cadence and handles unreadable preferences without enabling work', async () => {
    await writeFile(settingsFile, 'broken-json')
    const { loop, run, warn } = create(vi.fn(async () => { throw new Error('model unavailable') }))
    await loop.tick(); expect(run).not.toHaveBeenCalled()
    await setEnabled(true)
    await loop.tick(); await loop.tick()
    expect(run).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(2)
    now += BRIEFING_INTERVAL_MS
    await loop.tick(); expect(run).toHaveBeenCalledTimes(2)
  })
  it('stops polling when disposed', async () => {
    const { loop, run } = create()
    loop.stop(); await loop.tick()
    expect(run).not.toHaveBeenCalled()
  })
  it('retires only old Portal briefing jobs for the exact workspace', async () => {
    const prompt = `【简报维护任务】受信任的项目范围只有一个：\n  ${root}\n4. 把简报写入当前工作目录的 handoff.draft.md（覆盖旧草稿）。`
    const scheduler = { catalog: vi.fn(async () => [
      { id: 'legacy', sessionId: 'owner-session', title: '简报维护', prompt },
      { id: 'other-root', sessionId: 'other', title: '简报维护', prompt: prompt.replace(root, `${root}-other`) },
      { id: 'unrelated', sessionId: 'owner-session', title: '用户任务', prompt },
    ]), delete: vi.fn(async () => ({})) }
    await retireLegacyBriefing(scheduler, root)
    expect(scheduler.delete).toHaveBeenCalledTimes(1)
    expect(scheduler.delete).toHaveBeenCalledWith({ id: 'legacy', sessionId: 'owner-session' })
  })
  it('starts the update through the bounded owner agent without a Portal request', async () => {
    vi.stubEnv('A2A_TEST_OWNER', 'fixture-owner-secret')
    app = await compose({ forceStub: true, workspaceRoot: root, peers: {}, adminTokenEnv: 'A2A_TEST_OWNER',
      overrides: { briefing: { settingsFile, prompt: 'AUTOMATIC_BRIEFING_TEST' } } })
    await vi.waitFor(async () => {
      const response = await ipc(app!.managementSocket, '/a2a/admin/contexts', 'fixture-owner-secret')
      expect(response.status).toBe(200)
      const tasks = response.body.contexts.flatMap((context: any) => context.peer === 'owner' ? context.tasks : [])
      expect(tasks).toHaveLength(1)
      expect(tasks[0].state).toBe('TASK_STATE_COMPLETED')
      expect(tasks[0].output).toContain('AUTOMATIC_BRIEFING_TEST')
    })
  })
})
