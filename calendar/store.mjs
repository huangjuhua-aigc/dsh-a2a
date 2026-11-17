import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

export const digest = value => createHash('sha256').update(value).digest('hex')
export const secret = () => randomBytes(32).toString('base64url')
export async function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`
  try { await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temp, file) }
  finally { await rm(temp, { force: true }) }
}
export async function read(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return; throw e }
}
// DPAPI receives the key on stdin, never in process arguments or logs.
function dpapi(value, protect) {
  return new Promise((resolve, reject) => {
    const command = `Add-Type -AssemblyName System.Security; $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${protect ? 'Protect' : 'Unprotect'}($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''; const timer = setTimeout(() => child.kill(), 15000)
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.resume()
    child.on('error', () => { clearTimeout(timer); reject(new Error('Cannot access local calendar encryption key')) })
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.from(output.trim(), 'base64')) : reject(new Error('Cannot access local calendar encryption key')) })
    child.stdin.on('error', () => {}); child.stdin.end(value.toString('base64'))
  })
}
const keys = new Map()
async function localKey(root) {
  const file = join(root, '.key.json'), saved = await read(file)
  if (saved) {
    if (keys.has(saved.data)) return keys.get(saved.data)
    if (!['dpapi', 'owner-file'].includes(saved.protection)) throw new Error('Invalid calendar key')
    const bytes = Buffer.from(saved.data, 'base64')
    const key = saved.protection === 'dpapi' ? await dpapi(bytes, false) : bytes
    if (key.length !== 32) throw new Error('Invalid calendar key')
    keys.set(saved.data, key); return key
  }
  const key = randomBytes(32), protection = process.platform === 'win32' ? 'dpapi' : 'owner-file'
  const data = (protection === 'dpapi' ? await dpapi(key, true) : key).toString('base64')
  await atomic(file, { protection, data }); keys.set(data, key); return key
}
function seal(key, value, aad) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}
function unseal(key, envelope, aad) {
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString())
}
/** Cross-process lock survives Portal closure. Dead owners are removed with compare-and-swap.
 * Each record commits immediately; creating intent is durable before calling the provider.
 * A live process's lock is never stolen while its external request is in progress. */
export async function withStore(file, run, signal) {
  const root = dirname(file); await mkdir(root, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(root, 'calendar.sqlite'))
  db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS mutex (id INTEGER PRIMARY KEY, owner TEXT, pid INTEGER); CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, value TEXT, PRIMARY KEY(kind,id))')
  const owner = randomUUID(), deadline = Date.now() + 90000
  let acquired = false
  try {
    while (!acquired) {
      signal?.throwIfAborted()
      acquired = db.prepare('INSERT OR IGNORE INTO mutex VALUES (1,?,?)').run(owner, process.pid).changes === 1
      if (acquired) break
      const held = db.prepare('SELECT owner,pid FROM mutex WHERE id=1').get()
      if (held) { try { process.kill(held.pid, 0) } catch (e) { if (e.code === 'ESRCH') db.prepare('DELETE FROM mutex WHERE id=1 AND owner=?').run(held.owner) } }
      if (Date.now() > deadline) throw new Error('日历正在处理其他请求，请稍后查询')
      await delay(25, undefined, { signal })
    }
    const key = await localKey(root)
    const store = {
      get: (kind, id) => { const row = db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id); return row ? unseal(key, JSON.parse(row.value), `${kind}:${id}`) : undefined },
      list: kind => db.prepare('SELECT id,value FROM records WHERE kind=?').all(kind).map(row => unseal(key, JSON.parse(row.value), `${kind}:${row.id}`)),
      put: (kind, id, value) => db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?)').run(kind, id, JSON.stringify(seal(key, value, `${kind}:${id}`))),
      removeRecord: (kind, id) => db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id),
      connection: async () => {
        const envelope = await read(file)
        if (!envelope) return
        if (envelope.version !== 2) throw new Error('旧版日历连接需要重新授权，请先解除连接')
        const c = unseal(key, envelope, 'calendar-connection-v2')
        if (!['google', 'feishu'].includes(c.provider) || !c.connectionId || !c.clientId || !c.refreshToken) throw new Error('Invalid private calendar connection')
        return c
      },
      save: value => atomic(file, { version: 2, ...seal(key, value, 'calendar-connection-v2') }),
      remove: () => rm(file, { force: true }),
    }
    return await run(store)
  } finally { if (acquired) db.prepare('DELETE FROM mutex WHERE id=1 AND owner=?').run(owner); db.close() }
}
