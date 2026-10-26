/** The owner API is carried only by local IPC, never by the public web server. */
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, rm, lstat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import type { A2AServerConfig } from './config.ts'
import { deploymentKey } from './state.ts'
import type { Router } from './router.ts'

export function managementPath(config: A2AServerConfig): string {
  return config.admin?.socketPath ?? (process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-a2a-${deploymentKey(config)}`
    : join(homedir(), '.dsh-a2a', 'run', `${deploymentKey(config)}.sock`))
}

export async function startManagement(config: A2AServerConfig, router: Router): Promise<() => Promise<void>> {
  const path = managementPath(config)
  if (process.platform === 'win32' ? !/^\\\\\.\\pipe\\[^\\]+$/.test(path) : !isAbsolute(path)) {
    throw new Error('admin.socketPath must be a local named pipe or an absolute Unix socket path')
  }
  if (process.platform !== 'win32') {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try {
      const stat = await lstat(path)
      if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('unsafe management socket path')
      await new Promise<void>((resolve, reject) => {
        const probe = createConnection(path)
        probe.once('connect', () => { probe.destroy(); reject(new Error('management socket is in use')) })
        probe.once('error', error => (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? resolve() : reject(error))
      })
      await rm(path)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const server: Server = createServer((req, res) => {
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://localhost') } catch { res.writeHead(400); res.end(); return }
    if (url.pathname === config.basePath) void router.serveOwnerRpc(req, res)
    else if (url.pathname === `${config.basePath}/admin/contexts`
      || url.pathname.startsWith(`${config.basePath}/admin/contexts/`)) void router.serveAdmin(req, res)
    else { res.writeHead(404); res.end() }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })
  try { if (process.platform !== 'win32') await chmod(path, 0o600) }
  catch (error) { server.closeAllConnections(); server.close(); throw error }
  return async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}
