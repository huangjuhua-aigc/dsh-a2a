import { request } from 'node:http'

export function ipc(socketPath: string, path: string, token?: string, method = 'GET', body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method,
      headers: { 'content-type': 'application/json', ...token ? { authorization: `Bearer ${token}` } : {} },
    }, res => {
      let text = ''
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk })
      res.on('end', () => { try { resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : {} }) } catch (error) { reject(error) } })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('IPC request timeout')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
