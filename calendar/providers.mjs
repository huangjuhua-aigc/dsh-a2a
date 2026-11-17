import { createHash } from 'node:crypto'

export const PROVIDERS = ['google', 'feishu']
export const SCOPES = {
  google: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'],
  feishu: ['offline_access', 'calendar:calendar:readonly', 'calendar:calendar.event:create'],
}
const GOOGLE = 'https://www.googleapis.com/calendar/v3', FEISHU = 'https://open.feishu.cn/open-apis', encode = encodeURIComponent
export class Providers {
  constructor(io = {}) { this.fetch = io.fetch ?? globalThis.fetch; this.now = io.now ?? Date.now; this.persist = io.persist ?? (async () => {}) }
  async request(url, init = {}, oauth = false) {
    let response
    try { response = await this.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }) }
    catch { throw new Error('日历平台暂未响应；写入结果需查询，不能直接重试') }
    const body = await response.json().catch(() => ({}))
    if (oauth && ['authorization_pending', 'slow_down'].includes(body.error)) return body
    if (!response.ok || body.error || body.code) throw new Error(`日历平台拒绝请求（HTTP ${response.status}），请检查授权及应用权限`)
    return body
  }
  post(url, body, token) { return this.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }) }
  authorize(clientId, state, verifier, redirectUri) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'consent', scope: SCOPES.google.join(' '), access_type: 'offline' }).toString()
    return url.href
  }
  token(c, fields, polling = false) {
    return this.request(c.provider === 'google' ? 'https://oauth2.googleapis.com/token' : 'https://accounts.feishu.cn/oauth/v3/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.clientId, ...(c.clientSecret ? { client_secret: c.clientSecret } : {}), ...fields }).toString(),
    }, polling)
  }
  async complete(c, result) {
    const scope = new Set(String(result.scope || '').split(/\s+/))
    if (!result.refresh_token || !result.access_token || !SCOPES[c.provider].every(s => scope.has(s))) throw new Error('请授权全部所需日历权限及离线访问后重试')
    if (result.token_type && result.token_type.toLowerCase() !== 'bearer') throw new Error('Unsupported calendar token type')
    Object.assign(c, { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: this.now() + Number(result.expires_in) * 1000 })
    if (c.provider === 'google') {
      const calendar = await this.request(`${GOOGLE}/users/me/calendarList/primary`, { headers: { authorization: `Bearer ${c.accessToken}` } })
      if (!['owner', 'writer'].includes(calendar.accessRole) || !calendar.id) throw new Error('主日历没有写入权限')
      return { ...c, calendarId: calendar.id, label: calendar.summary || calendar.id }
    }
    const primary = await this.post(`${FEISHU}/calendar/v4/calendars/primary?user_id_type=open_id`, {}, c.accessToken)
    const item = primary.data?.calendars?.[0], calendar = item?.calendar
    if (!calendar?.calendar_id || !item.user_id || !['owner', 'writer'].includes(calendar.role)) throw new Error('无法获取有写入权限的用户主日历')
    return { ...c, calendarId: calendar.calendar_id, ownerId: item.user_id, label: calendar.summary || '飞书日历' }
  }
  async access(c) {
    if (c.accessToken && c.expiresAt > this.now() + 60000) return c.accessToken
    const result = await this.token(c, { grant_type: 'refresh_token', refresh_token: c.refreshToken })
    if (!result.access_token || c.provider === 'feishu' && !result.refresh_token) throw new Error('日历授权已失效，请在 Portal 重新连接')
    Object.assign(c, { accessToken: result.access_token, expiresAt: this.now() + Number(result.expires_in) * 1000, ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}) })
    // Feishu refresh tokens rotate. Persist before any later API request can fail.
    await this.persist(c)
    return c.accessToken
  }
  async events(c, start, end) {
    const token = await this.access(c), events = []; let page = ''
    for (let n = 0; n < 100; n++) {
      if (c.provider === 'feishu') {
        const query = new URLSearchParams({ start_time: String(Math.floor(Date.parse(start) / 1000)), end_time: String(Math.floor(Date.parse(end) / 1000)), page_size: '500', ...(page ? { page_token: page } : {}) })
        const result = await this.request(`${FEISHU}/calendar/v4/calendars/${encode(c.calendarId)}/events?${query}`, { headers: { authorization: `Bearer ${token}` } })
        if (!Array.isArray(result.data?.items)) throw new Error('Incomplete calendar response')
        events.push(...result.data.items.filter(e => e.status !== 'cancelled'))
        if (!result.data.has_more) return events
        page = result.data.page_token; if (!page) throw new Error('Incomplete calendar pagination')
      } else {
        const query = new URLSearchParams({ timeMin: start, timeMax: end, singleEvents: 'true', maxResults: '2500', ...(page ? { pageToken: page } : {}) })
        const result = await this.request(`${GOOGLE}/calendars/${encode(c.calendarId)}/events?${query}`, { headers: { authorization: `Bearer ${token}` } })
        if (!Array.isArray(result.items)) throw new Error('Incomplete calendar response')
        events.push(...result.items.filter(e => e.status !== 'cancelled'))
        if (!result.nextPageToken) return events
        page = result.nextPageToken
      }
    }
    throw new Error('Calendar is too large to check safely')
  }
  async busy(c, start, end) {
    const token = await this.access(c)
    if (c.provider === 'google') {
      const result = await this.post(`${GOOGLE}/freeBusy`, { timeMin: start, timeMax: end, items: [{ id: c.calendarId }] }, token)
      const calendar = result.calendars?.[c.calendarId]
      if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy)) throw new Error('Cannot verify calendar availability')
      return calendar.busy
    }
    const result = await this.post(`${FEISHU}/calendar/v4/freebusy/list?user_id_type=open_id`, { time_min: start, time_max: end, user_id: c.ownerId, include_external_calendar: true, only_busy: true }, token)
    const data = result.data
    if (result.code !== 0 || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Cannot verify calendar availability')
    // Feishu omits its optional freebusy_list when no events occupy the range.
    // Only a successful response with a data object may imply an empty list.
    const busy = Object.hasOwn(data, 'freebusy_list') ? data.freebusy_list : []
    if (!Array.isArray(busy)) throw new Error('Cannot verify calendar availability')
    return busy.map(b => ({ start: b.start_time, end: b.end_time }))
  }
  async create(c, b) {
    const token = await this.access(c), description = `${b.description || ''}\nA2A booking: ${b.id}`
    if (c.provider === 'google') {
      const event = await this.post(`${GOOGLE}/calendars/${encode(c.calendarId)}/events`, { id: `a2a${b.id.replaceAll('-', '')}`, summary: b.title, description,
        start: { dateTime: b.start, timeZone: b.timezone }, end: { dateTime: b.end, timeZone: b.timezone }, visibility: 'private', guestsCanModify: false }, token)
      if (!event.id) throw new Error('Missing event ID')
      return { eventId: event.id }
    }
    const event = await this.post(`${FEISHU}/calendar/v4/calendars/${encode(c.calendarId)}/events?idempotency_key=${b.id}`, {
      summary: b.title, description, visibility: 'private', attendee_ability: 'none', free_busy_status: 'busy',
      start_time: { timestamp: String(Date.parse(b.start) / 1000), timezone: b.timezone }, end_time: { timestamp: String(Date.parse(b.end) / 1000), timezone: b.timezone },
    }, token)
    if (!event.data?.event?.event_id) throw new Error('Missing event ID')
    return { eventId: event.data.event.event_id }
  }
  async lookup(c, b) {
    const events = await this.events(c, b.start, b.end)
    const event = events.find(e => e.id === `a2a${b.id.replaceAll('-', '')}` || e.description?.includes(`A2A booking: ${b.id}`))
    return event ? { eventId: event.id || event.event_id } : undefined
  }
}
