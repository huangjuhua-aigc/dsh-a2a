import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { withStore } from './store.mjs'

/** Accept Google's downloaded Desktop client document, never caller-supplied API URLs. */
export function parseGoogleClient(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document) || Buffer.byteLength(JSON.stringify(document)) > 65536) throw new Error('请选择有效的 Google 客户端 JSON 文件（不超过 64 KiB）')
  const c = document.installed
  if (!c || typeof c !== 'object' || Array.isArray(c) || document.web || document.type === 'service_account') throw new Error('需要 Desktop app（桌面应用）客户端 JSON，请勿使用 Web 或服务账号配置')
  if (typeof c.client_id !== 'string' || c.client_id.length > 256 || !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(c.client_id)) throw new Error('JSON 中缺少有效的 Google Client ID，请重新下载桌面应用配置')
  if (c.client_secret !== undefined && (typeof c.client_secret !== 'string' || !c.client_secret.trim() || c.client_secret.length > 4096)) throw new Error('Google 客户端配置格式无效，请重新下载 JSON')
  return { clientId: c.client_id, ...(c.client_secret ? { clientSecret: c.client_secret } : {}) }
}
const key = file => basename(file)
export async function readGoogleClient(file) {
  if (!existsSync(join(dirname(file), 'calendar.sqlite'))) return
  return withStore(file, store => store.get('google-client', key(file)))
}
export async function importGoogleClient(file, document) {
  const client = parseGoogleClient(document)
  return withStore(file, async store => {
    if (await store.connection()) throw new Error('请先解除当前日历连接，再更换 Google 配置')
    store.put('google-client', key(file), client)
    return { saved: true }
  })
}
export const forgetGoogleClient = file => withStore(file, store => store.removeRecord('google-client', key(file)))
