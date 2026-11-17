import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Providers, SCOPES } from './providers.mjs'
import { secret } from './store.mjs'
import { saveConnection } from './index.mjs'

/** Only OAuth progress is in memory. Completed authorization lives in the local encrypted vault. */
export function createAuthorization(file, provider, config = {}, io = {}) {
  if (!['google', 'feishu'].includes(provider)) throw new Error('请选择 Google 或飞书日历')
  if (provider === 'google' && !config.googleClientId) throw new Error('请先在 Portal 导入你自己的 Google 桌面应用客户端 JSON')
  const controller = new AbortController(), providers = new Providers(io)
  let server, expiresAt = Date.now() + 10 * 60000, status = 'pending', phase = provider === 'google' ? 'authorizing' : 'creating_app', authorizationUrl = '', error = ''
  const timer = setTimeout(() => { if (status === 'pending') { status = 'expired'; controller.abort(); server?.close() } }, 10 * 60000)
  timer.unref()
  const check = () => { controller.signal.throwIfAborted(); if (Date.now() >= expiresAt) throw new Error('Expired') }
  const done = async c => { check(); await saveConnection(file, c, check); check(); status = 'connected'; clearTimeout(timer); server?.close() }
  const failed = () => { if (status !== 'pending') return; status = 'failed'; error = '授权未完成，请检查是否同意日历权限及企业应用权限后重试。'; clearTimeout(timer); controller.abort(); server?.close() }
  const view = () => ({ status, phase, authorizationUrl, expiresAt, ...(error ? { error } : {}) })
  const ready = (async () => {
    if (provider === 'google') {
      const state = secret(), verifier = secret(), c = { provider, clientId: config.googleClientId, ...(config.googleClientSecret ? { clientSecret: config.googleClientSecret } : {}) }
      let used = false, redirectUri
      server = createServer((req, res) => {
        res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
        void (async () => {
          const url = new URL(req.url, redirectUri)
          if (req.method !== 'GET' || req.headers.host !== new URL(redirectUri).host || url.pathname !== '/oauth/callback' || url.searchParams.get('state') !== state || used || status !== 'pending') { res.writeHead(400); res.end('Invalid or expired authorization'); return }
          used = true; check()
          if (url.searchParams.has('error') || !url.searchParams.get('code')) throw new Error('Denied')
          const token = await providers.token(c, { grant_type: 'authorization_code', code: url.searchParams.get('code'), code_verifier: verifier, redirect_uri: redirectUri })
          const connection = await providers.complete(c, token); check(); await done(connection)
          res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><h1>日历已连接</h1><p>授权已保存在本机，请回到 Portal。可以关闭此页面。</p>')
        })().catch(() => { failed(); if (!res.headersSent) res.writeHead(400); res.end('Authorization failed. Return to Portal and retry.') })
      })
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`
      authorizationUrl = providers.authorize(c.clientId, state, verifier, redirectUri)
      return view()
    }
    // Official SDK creates an owner-specific app; no shared confidential AppSecret is shipped.
    let readyResolve, readyReject
    const firstUrl = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    void (async () => {
      const register = io.registerApp ?? (await import('@larksuiteoapi/node-sdk')).registerApp
      const app = await register({ signal: controller.signal, source: 'Talk2MyAgent', createOnly: true,
        appPreset: { name: 'Talk2MyAgent 日历预约', desc: '在本机授权日历，允许 Agent 自动预约会议' },
        addons: { preset: false, scopes: { tenant: [], user: SCOPES.feishu } },
        onQRCodeReady: ({ url, expireIn }) => {
          check()
          const parsed = new URL(url)
          if (parsed.protocol !== 'https:' || parsed.hostname !== 'open.feishu.cn') throw new Error('Unsupported application registration domain')
          authorizationUrl = parsed.href; expiresAt = Date.now() + Math.min(expireIn, 600) * 1000; readyResolve(view())
        },
      })
      check()
      if (!app.client_id || !app.client_secret || app.user_info?.tenant_brand === 'lark') throw new Error('请选择飞书中国版应用')
      const c = { provider, clientId: app.client_id, clientSecret: app.client_secret }
      const device = await providers.request('https://accounts.feishu.cn/oauth/v1/device_authorization', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}` },
        body: new URLSearchParams({ client_id: c.clientId, scope: SCOPES.feishu.join(' ') }).toString(),
      })
      const link = new URL(device.verification_uri_complete || device.verification_uri)
      if (!device.device_code || link.protocol !== 'https:' || link.hostname !== 'accounts.feishu.cn') throw new Error('Invalid device authorization')
      check(); phase = 'authorizing'; authorizationUrl = link.href; expiresAt = Math.min(expiresAt, Date.now() + Number(device.expires_in || 240) * 1000)
      let interval = Math.max(1, Number(device.interval) || 5)
      while (true) {
        await delay(interval * 1000, undefined, { signal: controller.signal }); check()
        const result = await providers.token(c, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code }, true)
        if (result.error === 'authorization_pending') continue
        if (result.error === 'slow_down') { interval = Math.min(60, interval + 5); continue }
        const connection = await providers.complete(c, result); check(); await done(connection); return
      }
    })().catch(() => { failed(); readyReject(new Error('飞书授权未能启动，请检查网络后重试')) })
    return firstUrl
  })().catch(e => { failed(); throw e })
  let readySettled = false
  const readyBounded = new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('授权已取消或超时，请重新连接'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
    const initialTimeout = setTimeout(() => { failed(); reject(new Error('连接日历平台超时，请检查网络后重试')) }, 20000)
    ready.then(resolve, reject).finally(() => {
      readySettled = true; clearTimeout(initialTimeout); controller.signal.removeEventListener('abort', onAbort)
    }).catch(() => {})
  })
  return { id: randomUUID(), ready: readyBounded, view, cancel: async () => {
    if (status === 'pending') status = 'canceled'
    controller.abort(); clearTimeout(timer); server?.close(); server?.closeAllConnections()
    // Writes are checked again inside the cross-process store lock. A queued or canceled
    // authorization cannot resurrect a connection after disconnect acquires that lock.
    if (readySettled) await ready.catch(() => {})
  } }
}
