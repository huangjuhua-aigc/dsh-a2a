// Test process only: intercept platform HTTP while exercising the actual SDK and auth code.
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
const originalFetch = globalThis.fetch
const origin = process.env.CALENDAR_FIXTURE_ORIGIN
if (!origin || new URL(origin).hostname !== '127.0.0.1') throw new Error('Missing local calendar fixture')
const hosts = new Set(['accounts.feishu.cn', 'open.feishu.cn', 'accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com'])
globalThis.fetch = async (url, init = {}) => {
  if (!hosts.has(new URL(url).hostname)) return originalFetch(url, init)
  return originalFetch(origin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: String(url), init: { method: init.method, body: init.body, headers: Object.fromEntries(new Headers(init.headers)) } }) })
}
defaultHttpInstance.post = async (url, data, options) => {
  if (!String(url).endsWith('/app/registration')) throw new Error('Unexpected SDK request')
  const response = await globalThis.fetch(url, { method: 'POST', body: data, headers: options.headers })
  return response.json()
}
