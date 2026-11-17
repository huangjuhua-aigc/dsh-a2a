import { createServer } from 'node:http'
import { SCOPES } from '../../calendar/providers.mjs'

/** External OAuth/calendar wire double. Production code has no endpoint override. */
export function providerFixture() {
  const events = [], requests = [], busy = []
  let timeout = false, busyFailure = false, refreshFailure = false, appApproved = false, consent = false, partial = false
  const fetch = async (input, init = {}) => {
    const url = new URL(input), headers = Object.fromEntries(new Headers(init.headers))
    const data = init.body ? (headers['content-type']?.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body)) : {}
    requests.push({ url: url.href, method: init.method || 'GET', data })
    const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (url.pathname.endsWith('/app/registration')) {
      if (data.action === 'begin') return response({ device_code: 'app-device', verification_uri_complete: 'https://open.feishu.cn/page/launcher?fixture=app', interval: 0.05, expires_in: 600 })
      return response(appApproved ? { client_id: 'test-feishu-app', client_secret: 'FEISHU_CLIENT_SECRET', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' } } : { error: 'authorization_pending' })
    }
    if (url.pathname.endsWith('/device_authorization')) return response({ device_code: 'user-device', verification_uri_complete: 'https://accounts.feishu.cn/oauth/authorize?fixture=user', expires_in: 240, interval: 1 })
    if (url.pathname.endsWith('/token')) {
      if (data.grant_type?.includes('device_code') && !consent) return response({ error: 'authorization_pending' }, 400)
      if (data.grant_type === 'refresh_token' && refreshFailure) return response({ error: 'invalid_grant' }, 400)
      return response({ access_token: 'ACCESS_TOKEN_SECRET', refresh_token: 'ROTATED_REFRESH_TOKEN_SECRET', expires_in: 7200, token_type: 'Bearer', scope: partial ? 'offline_access' : SCOPES[url.hostname === 'oauth2.googleapis.com' ? 'google' : 'feishu'].join(' ') })
    }
    if (url.pathname.endsWith('/calendarList/primary')) return response({ id: 'owner@example.test', summary: 'Owner test calendar', accessRole: 'owner' })
    if (url.pathname.endsWith('/calendars/primary')) return response({ code: 0, data: { calendars: [{ calendar: { calendar_id: 'feishu-calendar', summary: 'Owner test calendar', role: 'owner' }, user_id: 'ou_owner' }] } })
    if (url.pathname.endsWith('/freeBusy')) return response({ calendars: { 'owner@example.test': busyFailure ? { errors: [{ reason: 'forbidden' }] } : { busy } } })
    if (url.pathname.endsWith('/freebusy/list')) return response(busyFailure ? { code: 190003 } : { code: 0, data: busy.length ? { freebusy_list: busy.map(b => ({ start_time: b.start, end_time: b.end })) } : {} })
    if (url.pathname.endsWith('/events') && init.method !== 'POST') return response(url.hostname === 'www.googleapis.com' ? { items: events.filter(e => e.provider === 'google') } : { code: 0, data: { items: events.filter(e => e.provider === 'feishu'), has_more: false } })
    if (url.pathname.endsWith('/events')) {
      const provider = url.hostname === 'www.googleapis.com' ? 'google' : 'feishu'
      if (provider === 'feishu' && !url.searchParams.get('idempotency_key')) throw new Error('No idempotency key')
      const event = { ...data, provider, id: data.id, event_id: `feishu-${events.length}` }
      events.push(event)
      if (timeout) { timeout = false; throw new Error('Connection lost after write') }
      return response(provider === 'google' ? event : { code: 0, data: { event } })
    }
    throw new Error(`Unexpected calendar test request: ${url.origin}${url.pathname}`)
  }
  return { fetch, events, requests, busy, approveApp: () => { appApproved = true }, approveUser: () => { consent = true }, partialScopes: () => { partial = true }, timeoutNextWrite: () => { timeout = true }, failBusy: () => { busyFailure = true }, invalidRefresh: () => { refreshFailure = true } }
}
export async function startProviderFixture() {
  const remote = providerFixture()
  const server = createServer((req, res) => { void (async () => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const { url, init } = JSON.parse(raw)
    const response = await remote.fetch(url, init)
    res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(await response.text())
  })().catch(() => { req.socket.destroy() }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { ...remote, origin: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
