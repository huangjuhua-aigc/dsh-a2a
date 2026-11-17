import { randomUUID, createHmac } from 'node:crypto'
import { withStore, digest, secret } from './store.mjs'
import { Providers } from './providers.mjs'
export { importGoogleClient, readGoogleClient, forgetGoogleClient } from './google-client.mjs'
const text = (value, max = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : undefined
const overlap = (a, b) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end)
function interval(args, now, maxDays = 14) {
  const values = [args.start, args.end]
  if (values.some(v => typeof v !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(v) || !Number.isFinite(Date.parse(v)))) throw new Error('Use ISO dates with an explicit timezone offset')
  const [start, end] = values.map(Date.parse)
  if (start < now - 60_000 || end <= start || end - start > maxDays * 86400_000 || end > now + 366 * 86400_000) throw new Error('Invalid booking time range')
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() }
}

export async function connectionInfo(file) {
  return withStore(file, async store => {
    const c = await store.connection()
    return c ? { connectionId: c.connectionId, provider: c.provider, label: c.label, coverage: c.provider === 'feishu' ? 'user_freebusy' : 'primary_calendar' } : undefined
  })
}
export async function saveConnection(file, connection, check = () => {}) {
  return withStore(file, async store => {
    if (await store.connection()) throw new Error('请先解除当前日历连接')
    check()
    const c = { ...connection, connectionId: randomUUID(), visitorSalt: secret() }
    await store.save(c); return { connectionId: c.connectionId, provider: c.provider, label: c.label }
  })
}
export const disconnect = file => withStore(file, store => store.remove())
export async function executeTool(file, expectedId, visitor, name, args, io = {}) {
  if (!visitor || typeof visitor !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid calendar request')
  return withStore(file, async store => {
    const connection = await store.connection()
    if (!connection || connection.connectionId !== expectedId) throw new Error('日历连接已解除或变更，请主人重新启动 Agent')
    const peer = createHmac('sha256', connection.visitorSalt).update(visitor).digest('hex')
    const providers = new Providers({ ...io, persist: c => store.save(c) }), now = io.now ?? Date.now
    const bookingView = b => ({ bookingId: b.id, provider: b.provider, status: b.status, start: b.start, end: b.end, timezone: b.timezone, title: b.title,
      ...(b.eventId ? { eventId: b.eventId } : {}), ...(b.status === 'uncertain' || b.status === 'creating' ? { notice: '结果待核实，请查询此预约编号；不要重新创建预约。' } : {}) })
    async function tool(connectionId, connection, peer, name, args) {
      const kind = `booking:${digest(`${connection.provider}:${connection.calendarId}`)}`
      const booked = () => store.list(kind).filter(b => ['confirmed', 'creating', 'uncertain'].includes(b.status))
      const busy = async range => {
        const result = await providers.busy(connection, range.start, range.end)
        for (const item of result) if (!Number.isFinite(Date.parse(item.start)) || !Number.isFinite(Date.parse(item.end)) || Date.parse(item.end) <= Date.parse(item.start)) throw new Error('Invalid busy response; cannot safely book')
        return [...result, ...booked()]
      }
      if (name === 'calendar_find_slots') {
        const range = interval(args, now()), duration = args.durationMinutes
        if (!Number.isInteger(duration) || duration < 15 || duration > 180) throw new Error('Duration must be 15–180 minutes')
        const unavailable = await busy(range), slots = []
        const step = 15 * 60_000
        for (let start = Math.ceil(Date.parse(range.start) / step) * step; start + duration * 60_000 <= Date.parse(range.end) && slots.length < 20; start += step) {
          const slot = { start: new Date(start).toISOString(), end: new Date(start + duration * 60_000).toISOString() }
          if (!unavailable.some(b => overlap(slot, b))) slots.push(slot)
        }
        return { slots, provider: connection.provider, coverage: connection.provider === 'feishu' ? 'user_freebusy' : 'primary_calendar' }
      }
      if (name === 'calendar_prepare_booking') {
        const range = interval(args, now(), 1), title = text(args.title, 128), timezone = text(args.timezone, 100)
        if (!title || !timezone || Date.parse(range.end) - Date.parse(range.start) > 180 * 60_000) throw new Error('Provide a title, timezone and duration up to 180 minutes')
        new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
        if (args.description !== undefined && (typeof args.description !== 'string' || args.description.length > 700)) throw new Error('Description exceeds 700 characters')
        const existing = store.list(kind).find(b => b.connectionId === connectionId && b.peer === peer && b.start === range.start && b.end === range.end && b.title === title && (b.status !== 'proposed' || b.expiresAt > now()))
        if (existing) return bookingView(existing)
        if ((await busy(range)).some(b => overlap(range, b))) throw new Error('该时间已被占用，请选择其他时段')
        const booking = { id: randomUUID(), connectionId, provider: connection.provider, peer, ...range, title, timezone, description: args.description || '', status: 'proposed', expiresAt: now() + 15 * 60_000 }
        store.put(kind, booking.id, booking)
        return { ...bookingView(booking), requiresVisitorConfirmation: true, expiresAt: booking.expiresAt }
      }
      const booking = store.get(kind, text(args.bookingId, 64) || '')
      if (!booking || booking.connectionId !== connectionId || booking.peer !== peer) throw new Error('Booking not found')
      if (name === 'calendar_booking_status') {
        if (['creating', 'uncertain', 'confirmed'].includes(booking.status)) {
          const found = await providers.lookup(connection, booking)
          if (found) { Object.assign(booking, found, { status: 'confirmed' }); store.put(kind, booking.id, booking) }
          else if (booking.status === 'confirmed') { booking.status = 'missing'; store.put(kind, booking.id, booking) }
        }
        return bookingView(booking)
      }
      if (name !== 'calendar_confirm_booking') throw new Error('Unknown calendar tool')
      if (args.confirmed !== true) throw new Error('Visitor confirmation is required')
      if (booking.status !== 'proposed') return bookingView(booking)
      if (booking.expiresAt <= now()) throw new Error('预约提案已过期，请重新查询时间')
      if ((await busy(booking)).some(b => overlap(booking, b))) throw new Error('该时间刚刚被占用，请重新协商')
      io.signal?.throwIfAborted()
      // Persist intent before the external write. A crash/timeout never causes an automatic second create.
      booking.status = 'creating'; store.put(kind, booking.id, booking)
      try { Object.assign(booking, await providers.create(connection, booking), { status: 'confirmed' }) }
      catch { booking.status = 'uncertain' }
      store.put(kind, booking.id, booking)
      return bookingView(booking)
    }

    io.signal?.throwIfAborted()
    return tool(connection.connectionId, connection, peer, name, args)
  }, io.signal)
}
