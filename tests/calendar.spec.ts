import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { saveConnection } from '../calendar/index.mjs'
const { providerFixture } = await import(new URL('./support/calendar-provider.mjs', import.meta.url).href)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { compose, type Composition } from '../example/compose.ts'
import { calendarConnection, calendarTools } from '../src/calendar.ts'

const roots: string[] = [], apps: Composition[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected fixture path'); await rm(root, { recursive: true, force: true }) }
  delete process.env['CALENDAR_TEST_ALICE']
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'a2a-calendar-')); roots.push(root)
  const publicRoot = join(root, 'public'), privateRoot = join(root, 'private'), connectionDir = join(root, 'calendar')
  await Promise.all([mkdir(publicRoot), mkdir(privateRoot), mkdir(connectionDir)])
  const remote = providerFixture(), original = globalThis.fetch
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => String(url).startsWith('https://') ? remote.fetch(url, init) : original(url, init))
  const file = join(connectionDir, 'connection.json')
  const info = await saveConnection(file, { provider: 'google', clientId: 'fixture', refreshToken: 'REFRESH_TOKEN_SECRET', accessToken: 'ACCESS_TOKEN_SECRET', expiresAt: Date.now() + 7200000, calendarId: 'owner@example.test', visitorSalt: 'salt', label: 'Test' })
  const start = new Date(Date.now() + 86400000); start.setUTCHours(6,0,0,0)
  const args = { start: start.toISOString(), end: new Date(start.getTime()+7200000).toISOString(), durationMinutes: 30 }
  return { root, file, publicRoot, privateRoot, remote, info, args }

}
describe('calendar tools inside the real Agent/A2A runtime', () => {
  it('loads skill and tools at startup, invokes over A2A, and excludes owner credentials from model input', async () => {
    const f = await setup()
    process.env['CALENDAR_TEST_ALICE'] = 'visitor-token'
    const app = await compose({ forceStub: true, workspaceRoot: f.publicRoot, peers: { alice: 'CALENDAR_TEST_ALICE' }, overrides: {
      calendar: { connectionFile: f.file, instructions: 'Only schedule after 14:00 Asia/Shanghai.', mode: 'auto' },
      isolation: { workspaceMode: 'per-peer', workspaceRoot: f.publicRoot, privateRoot: f.privateRoot, peerWorkspaces: {}, execution: 'read-only' },
    } }); apps.push(app)
    let forbiddenExecutions = 0
    const forbiddenTools = ['calendar_list_events', 'calendar_delete_event', 'calendar_update_event', 'gmail_list_messages', 'http_request', 'execute_command']
    for (const name of forbiddenTools) app.ctx.tools.register({ name, description: 'Owner-only integration', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async () => { forbiddenExecutions++; return 'OWNER_PRIVATE_TOOL_OUTPUT' } })
    f.remote.busy.push({ start: new Date(Date.parse(f.args.start) + 3600000).toISOString(),
      end: new Date(Date.parse(f.args.start) + 5400000).toISOString(), summary: 'OWNER_PRIVATE_MEETING_TITLE' })
    let calls = 0, prompt = ''
    app.adapter.stream = async function* (options): AsyncIterable<StreamChunk> {
      prompt += JSON.stringify(options)
      if (++calls === 1) {
        const id = ToolCallId('calendar-tool'), args = JSON.stringify(f.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'calendar_find_slots', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'calendar_find_slots', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        expect(JSON.stringify(options.messages)).toContain('slots')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '可预约北京时间 14:00–14:30，请确认。' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '可预约北京时间 14:00–14:30，请确认。' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const response = await fetch(app.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer visitor-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: 'booking-1', parts: [{ text: '请查询会议时间' }] } } }) })
    const result = await response.json() as any
    expect(result.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(f.remote.requests).toHaveLength(1)
    expect(prompt).toContain('meeting-booking')
    expect(prompt).toContain('Only schedule after 14:00')
    expect(prompt).not.toContain('TOKEN_SECRET')
    expect(prompt).not.toContain(f.file)
    expect(prompt).not.toContain('OWNER_PRIVATE')
    const agent = app.ctx.agents.list().find(a => a.session.id === result.result.task.contextId)!
    expect(app.ctx.tools.schemas(agent).map(t => t.name).sort()).toEqual(['calendar_booking_status', 'calendar_confirm_booking', 'calendar_find_slots', 'calendar_prepare_booking', 'read_file'])
    for (const name of forbiddenTools) {
      const denied = await app.ctx.tools.execute({ agent, callId: ToolCallId(`denied-${name}`), name, arguments: {}, signal: new AbortController().signal })
      expect(denied.isError).toBe(true)
    }
    expect(forbiddenExecutions).toBe(0)
    expect(f.remote.requests).toHaveLength(1)
    const card = await (await fetch(app.cardUrl)).json() as any
    expect(card.skills.some((s: any) => s.id === 'meeting-booking')).toBe(true)
  })
  it('binds identity on the server and disconnect immediately removes existing tools access', async () => {
    const f = await setup()
    const a = calendarTools(f.file, 'alice', f.info.connectionId)[1]!
    const b = calendarTools(f.file, 'bob', f.info.connectionId)[3]!
    const context = { signal: new AbortController().signal } as any
    const p = await a.execute({ start: f.args.start, end: new Date(Date.parse(f.args.start)+1800000).toISOString(), timezone: 'Asia/Shanghai', title: 'Test', visitor: 'bob' }, context) as any
    await expect(b.execute({ bookingId: p.bookingId }, context)).rejects.toThrow('not found')
    await rm(f.file)
    await expect(a.execute({}, context)).rejects.toThrow('已解除')
  })
  it('rejects credential files inside public data and legacy cloud connections', async () => {
    const f = await setup()
    await writeFile(join(f.publicRoot, 'connection.json'), '{}')
    await expect(compose({ forceStub: true, workspaceRoot: f.publicRoot, peers: {}, overrides: {
      calendar: { connectionFile: join(f.publicRoot, 'connection.json'), mode: 'auto', instructions: '' },
    } })).rejects.toThrow('outside visitor-readable')
    await writeFile(f.file, JSON.stringify({ version: 1, serviceUrl: 'http://evil.example', connectionId: 'connection-123456789', token: 'k'.repeat(43), provider: 'google' }))
    await expect(calendarConnection(f.file)).rejects.toThrow('重新授权')
  })
})
