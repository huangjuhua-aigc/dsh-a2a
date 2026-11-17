import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { providerFixture, startProviderFixture } from './support/calendar-provider.mjs'
import { connectionInfo, saveConnection, disconnect, executeTool, importGoogleClient, readGoogleClient, forgetGoogleClient } from '../calendar/index.mjs'
import { parseGoogleClient } from '../calendar/google-client.mjs'
import { withStore } from '../calendar/store.mjs'
import { Providers } from '../calendar/providers.mjs'
import { createAuthorization } from '../calendar/auth.mjs'

const start = new Date(Date.now() + 3 * 86400000).toISOString(), end = new Date(Date.parse(start) + 30 * 60000).toISOString()
const proposal = { start, end, title: 'Discuss collaboration', timezone: 'Asia/Shanghai' }
const range = { start, end: new Date(Date.parse(start) + 2 * 3600000).toISOString(), durationMinutes: 30 }
const desktopClient = { installed: { client_id: '1234-user.apps.googleusercontent.com', client_secret: 'IMPORTED_CLIENT_SECRET', token_uri: 'https://untrusted.example/token' } }

test('Google client import accepts Desktop JSON and never accepts caller-defined endpoints', () => {
  assert.deepEqual(parseGoogleClient(desktopClient), { clientId: desktopClient.installed.client_id, clientSecret: 'IMPORTED_CLIENT_SECRET' })
  for (const document of [null, [], {}, { web: desktopClient.installed }, { type: 'service_account' },
    { installed: { client_id: 'invalid' } }, { installed: { ...desktopClient.installed, client_secret: 123 } },
    { ...desktopClient, extra: '字'.repeat(22000) }]) assert.throws(() => parseGoogleClient(document))
})
test('imported Google config is encrypted, per Agent, durable across processes and retained after disconnect', async t => {
  const f = await setup(t)
  await assert.rejects(importGoogleClient(f.file, desktopClient), /解除/)
  await disconnect(f.file)
  assert.deepEqual(await importGoogleClient(f.file, desktopClient), { saved: true })
  await assert.rejects(importGoogleClient(f.file, { web: desktopClient.installed }), /Desktop/)
  assert.deepEqual(await readGoogleClient(f.file), parseGoogleClient(desktopClient))
  const other = join(f.root, 'other.connection.json')
  assert.equal(await readGoogleClient(other), undefined)
  const second = { installed: { client_id: '5678-second.apps.googleusercontent.com' } }
  await importGoogleClient(other, second)
  const raw = (await readFile(join(f.root, 'calendar.sqlite'))).toString()
  assert.doesNotMatch(raw, /IMPORTED_CLIENT_SECRET|1234-user|5678-second/)
  await saveConnection(f.file, f.connection); await disconnect(f.file)
  const code = `import assert from 'node:assert/strict'; import { readGoogleClient } from ${JSON.stringify(new URL('../calendar/index.mjs', import.meta.url).href)}; assert.equal((await readGoogleClient(process.argv[1])).clientSecret, 'IMPORTED_CLIENT_SECRET')`
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.file], { windowsHide: true, stdio: 'ignore' })
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Saved config not readable in a fresh process')))
  })
  await forgetGoogleClient(f.file)
  assert.equal(await readGoogleClient(f.file), undefined)
  assert.deepEqual(await readGoogleClient(other), parseGoogleClient(second))
})
async function setup(t, provider = 'google') {
  const root = await mkdtemp(join(tmpdir(), 'calendar-local-')), file = join(root, 'agent.connection.json'), remote = providerFixture()
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }) })
  const providers = new Providers({ fetch: remote.fetch })
  const c = { provider, clientId: 'test-app', clientSecret: 'CLIENT_SECRET' }
  const connection = await providers.complete(c, await providers.token(c, { grant_type: 'authorization_code' }))
  const info = await saveConnection(file, connection)
  const tool = (name, args, visitor = 'alice', io = {}) => executeTool(file, info.connectionId, visitor, name, args, { fetch: remote.fetch, ...io })
  return { file, root, remote, connection, info, tool }
}
for (const provider of ['google', 'feishu']) {
  test(`${provider}: visitors see only availability and their own booking, never private event contents`, async t => {
    const f = await setup(t, provider)
    const privateEvent = { provider, id: 'private-event-id', event_id: 'private-event-id',
      summary: 'OWNER_PRIVATE_MEETING_TITLE', description: 'OWNER_PRIVATE_MEETING_NOTES',
      location: 'OWNER_PRIVATE_LOCATION', attendees: [{ email: 'owner-private-mail@example.test' }] }
    f.remote.events.push(privateEvent)
    f.remote.busy.push({ start: new Date(Date.parse(start) + 3600000).toISOString(),
      end: new Date(Date.parse(start) + 5400000).toISOString(), summary: privateEvent.summary })
    const slots = await f.tool('calendar_find_slots', range)
    assert.ok(slots.slots.length > 0)
    const p = await f.tool('calendar_prepare_booking', proposal)
    const created = await f.tool('calendar_confirm_booking', { bookingId: p.bookingId, confirmed: true })
    // Provider event contents can differ from the visitor's original proposal.
    // They must still never become model-visible tool output during reconciliation.
    const ownEvent = f.remote.events.find(e => e.description?.includes(`A2A booking: ${p.bookingId}`))
    ownEvent.summary = 'OWNER_PRIVATE_UPDATED_TITLE'
    ownEvent.description += '\nOWNER_PRIVATE_ADDED_NOTES'
    const status = await f.tool('calendar_booking_status', { bookingId: p.bookingId,
      visitor: 'bob', eventId: privateEvent.id, method: 'DELETE', url: 'https://untrusted.example/events' })
    assert.equal(status.status, 'confirmed')
    assert.equal(status.title, proposal.title)
    assert.equal(status.eventId, created.eventId)
    assert.doesNotMatch(JSON.stringify({ slots, p, created, status }), /OWNER_PRIVATE|owner-private-mail|private-event-id/)
    const requestCount = f.remote.requests.length, before = structuredClone(f.remote.events)
    for (const name of ['calendar_list_events', 'calendar_get_event', 'calendar_delete_event', 'calendar_update_event', 'gmail_list_messages', 'http_request']) {
      await assert.rejects(f.tool(name, { bookingId: p.bookingId, method: 'DELETE', eventId: created.eventId }), /Unknown calendar tool/)
    }
    for (const name of ['calendar_booking_status', 'calendar_confirm_booking']) {
      await assert.rejects(f.tool(name, { bookingId: p.bookingId, visitor: 'alice', confirmed: true }, 'bob'), /Booking not found/)
    }
    assert.equal(f.remote.requests.length, requestCount, 'denied operations must not reach provider APIs')
    assert.deepEqual(f.remote.events, before, 'private and booked events remain untouched')
    assert.ok(!f.remote.requests.some(r => ['DELETE', 'PATCH', 'PUT'].includes(r.method)))
  })

  test(`${provider}: encrypted local credentials, booking, visitor isolation, no duplicate and immediate disconnect`, async t => {
    const f = await setup(t, provider)
    assert.equal((await connectionInfo(f.file)).provider, provider)
    assert.doesNotMatch(await readFile(f.file, 'utf8'), /TOKEN_SECRET|CLIENT_SECRET|owner@example/)
    assert.ok((await f.tool('calendar_find_slots', range)).slots.length)
    const p = await f.tool('calendar_prepare_booking', proposal)
    assert.equal(f.remote.events.length, 0)
    await assert.rejects(f.tool('calendar_confirm_booking', { bookingId: p.bookingId, confirmed: false }), /confirmation/)
    await assert.rejects(f.tool('calendar_confirm_booking', { bookingId: p.bookingId, confirmed: true }, 'bob'), /not found/)
    assert.equal((await f.tool('calendar_confirm_booking', { bookingId: p.bookingId, confirmed: true })).status, 'confirmed')
    assert.equal((await f.tool('calendar_confirm_booking', { bookingId: p.bookingId, confirmed: true })).status, 'confirmed')
    await assert.rejects(f.tool('calendar_prepare_booking', { ...proposal, title: 'Other' }, 'bob'), /占用/)
    await assert.rejects(f.tool('calendar_booking_status', { bookingId: p.bookingId }, 'bob'), /not found/)
    assert.equal(f.remote.events.length, 1)
    await disconnect(f.file)
    await assert.rejects(f.tool('calendar_find_slots', range), /已解除/)
  })
  test(`${provider}: lost write response is reconciled, external deletion never recreates`, async t => {
    const f = await setup(t, provider), p = await f.tool('calendar_prepare_booking', proposal)
    f.remote.timeoutNextWrite()
    assert.equal((await f.tool('calendar_confirm_booking', { bookingId: p.bookingId, confirmed: true })).status, 'uncertain')
    assert.equal((await f.tool('calendar_confirm_booking', { bookingId: p.bookingId, confirmed: true })).status, 'uncertain')
    assert.equal((await f.tool('calendar_booking_status', { bookingId: p.bookingId })).status, 'confirmed')
    assert.equal(f.remote.events.length, 1); f.remote.events.length = 0
    assert.equal((await f.tool('calendar_booking_status', { bookingId: p.bookingId })).status, 'missing')
    assert.equal((await f.tool('calendar_confirm_booking', { bookingId: p.bookingId, confirmed: true })).status, 'missing')
    assert.equal(f.remote.events.length, 0)
  })
}
test('invalid ranges, incomplete busy results and expired proposals fail closed', async t => {
  const f = await setup(t)
  await assert.rejects(f.tool('calendar_find_slots', { ...range, start: '2030-01-01' }), /timezone/)
  await assert.rejects(f.tool('execute_command', {}))
  const p = await f.tool('calendar_prepare_booking', proposal)
  await assert.rejects(f.tool('calendar_confirm_booking', { bookingId: p.bookingId, confirmed: true }, 'alice', { now: () => Date.now() + 16 * 60000 }), /过期/)
  f.remote.failBusy(); await assert.rejects(f.tool('calendar_find_slots', range))
  assert.equal(f.remote.events.length, 0)
})

test('Feishu accepts an omitted optional busy list, but excludes occupied slots', async t => {
  const f = await setup(t, 'feishu')
  const empty = await f.tool('calendar_find_slots', range)
  assert.ok(empty.slots.length > 0)
  f.remote.busy.push(empty.slots[0])
  const occupied = await f.tool('calendar_find_slots', range)
  assert.ok(occupied.slots.length > 0)
  assert.ok(occupied.slots.every(slot => Date.parse(slot.start) >= Date.parse(empty.slots[0].end)))
  assert.equal(f.remote.events.length, 0)
})

test('Feishu malformed or failed availability responses never permit booking', async t => {
  const f = await setup(t, 'feishu')
  for (const [body, status = 200] of [
    [{ code: 0 }], [{ code: 0, data: null }], [{ code: 0, data: [] }], [{ data: {} }],
    [{ code: 0, data: { freebusy_list: null } }], [{ code: 0, data: { freebusy_list: {} } }],
    [{ code: 190003, data: {} }], [{ code: 0, data: {} }, 500],
    [{ code: 0, data: { freebusy_list: [{ start_time: 'invalid', end_time: 'invalid' }] } }],
  ]) {
    const io = { fetch: async () => new Response(JSON.stringify(body), { status }) }
    await assert.rejects(f.tool('calendar_find_slots', range, 'alice', io))
    await assert.rejects(f.tool('calendar_prepare_booking', proposal, 'alice', io))
  }
  assert.equal(f.remote.events.length, 0)
})
test('refresh is durable even when the subsequent API fails; invalid refresh never writes', async t => {
  const f = await setup(t, 'feishu')
  await withStore(f.file, async s => { const c = await s.connection(); c.expiresAt = 0; c.refreshToken = 'OLD'; await s.save(c) })
  f.remote.failBusy(); await assert.rejects(f.tool('calendar_find_slots', range))
  await withStore(f.file, async s => { const c = await s.connection(); assert.equal(c.refreshToken, 'ROTATED_REFRESH_TOKEN_SECRET'); c.expiresAt = 0; await s.save(c) })
  f.remote.invalidRefresh(); await assert.rejects(f.tool('calendar_prepare_booking', proposal))
  assert.equal(f.remote.events.length, 0)
})
test('Google loopback PKCE/state, cancellation during exchange and scope rejection', async t => {
  const f = await setup(t); await disconnect(f.file)
  let release, entered
  const gate = new Promise(r => { release = r }), began = new Promise(r => { entered = r })
  const auth = createAuthorization(f.file, 'google', { googleClientId: 'desktop' }, { fetch: async (url, init) => {
    if (String(url).endsWith('/token')) { entered(); await gate }
    return f.remote.fetch(url, init)
  } }); t.after(auth.cancel)
  const url = new URL((await auth.ready).authorizationUrl), callback = new URL(url.searchParams.get('redirect_uri'))
  assert.equal(callback.hostname, '127.0.0.1'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  callback.search = new URLSearchParams({ state: 'wrong', code: 'test' }).toString()
  assert.equal((await fetch(callback)).status, 400)
  callback.searchParams.set('state', url.searchParams.get('state'))
  const request = fetch(callback).catch(() => undefined); await began; await auth.cancel(); await disconnect(f.file); release(); await request
  await new Promise(r => setTimeout(r, 100))
  assert.equal(await connectionInfo(f.file), undefined)
  const exchange = f.remote.requests.find(r => r.data.code_verifier)
  assert.equal(createHash('sha256').update(exchange.data.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'))
  f.remote.partialScopes()
  const p = new Providers({ fetch: f.remote.fetch })
  await assert.rejects(p.complete({ provider: 'google' }, await p.token({ provider: 'google', clientId: 'x' }, {})), /权限/)
})
test('separate processes share the calendar conflict lock and cannot double book', async t => {
  const f = await setup(t), remote = await startProviderFixture(); t.after(remote.close)
  const other = join(f.root, 'other.connection.json'), second = await saveConnection(other, f.connection)
  const a = await f.tool('calendar_prepare_booking', proposal)
  const b = await executeTool(other, second.connectionId, 'bob', 'calendar_prepare_booking', proposal, { fetch: f.remote.fetch })
  const child = (file, id, visitor, bookingId) => new Promise((resolve, reject) => {
    const code = `import { executeTool } from ${JSON.stringify(new URL('../calendar/index.mjs', import.meta.url).href)}; const [file,id,visitor,bookingId]=process.argv.slice(1); try { await executeTool(file,id,visitor,'calendar_confirm_booking',{bookingId,confirmed:true}); } catch {process.exitCode=2}`
    const proc = spawn(process.execPath, ['--import', new URL('./support/calendar-preload.mjs', import.meta.url).href, '--input-type=module', '-e', code, file, id, visitor, bookingId], { env: { ...process.env, CALENDAR_FIXTURE_ORIGIN: remote.origin }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let errors = ''; proc.stderr.on('data', b => { errors += b }); proc.on('error', reject); proc.on('close', code => code === 0 || code === 2 ? resolve(code) : reject(new Error(errors)))
  })
  const results = await Promise.all([child(f.file, f.info.connectionId, 'alice', a.bookingId), child(other, second.connectionId, 'bob', b.bookingId)])
  assert.deepEqual(results.sort(), [0, 2]); assert.equal(remote.events.length, 1)
})

test('cancel while authorization waits for the vault lock cannot restore a disconnected connection', async t => {
  const f = await setup(t); await disconnect(f.file)
  let release, entered
  const gate = new Promise(r => { release = r }), began = new Promise(r => { entered = r })
  const held = withStore(f.file, async () => { entered(); await gate }); await began
  const auth = createAuthorization(f.file, 'google', { googleClientId: 'desktop' }, { fetch: f.remote.fetch }); t.after(auth.cancel)
  const url = new URL((await auth.ready).authorizationUrl), callback = new URL(url.searchParams.get('redirect_uri'))
  callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'test' }).toString()
  const response = fetch(callback).catch(() => undefined)
  while (!f.remote.requests.some(r => r.data.code === 'test')) await new Promise(r => setTimeout(r, 10))
  await auth.cancel(); release(); await held; await disconnect(f.file); await response
  await new Promise(r => setTimeout(r, 100))
  assert.equal(await connectionInfo(f.file), undefined)
})

test('a canceled tool does not create an event after its availability request completes', async t => {
  const f = await setup(t), p = await f.tool('calendar_prepare_booking', proposal), controller = new AbortController()
  await assert.rejects(f.tool('calendar_confirm_booking', { bookingId: p.bookingId, confirmed: true }, 'alice', {
    signal: controller.signal, fetch: async (url, init) => { const result = await f.remote.fetch(url, init); controller.abort(); return result },
  }))
  assert.equal(f.remote.events.length, 0)
})
