import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, rm, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, relative } from 'node:path'
import { contains } from './isolation.ts'

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  try { await rename(temporary, file) } finally { await rm(temporary, { force: true }) }
}

/** Never recursively remove a path outside an explicitly owned parent. */
export async function removeOwned(parent: string, target: string): Promise<void> {
  const base = await realpath(parent), absolute = resolve(target)
  if (absolute === base || !contains(base, absolute)) throw new Error('Unsafe sandbox cleanup path')
  const stat = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (!stat) return
  if (stat.isSymbolicLink() || !contains(base, await realpath(absolute))) throw new Error('Sandbox cleanup path was redirected')
  await rm(absolute, { recursive: true, force: true })
}

/** Inter-process ownership; stale locks are reclaimed only after their owner exits. */
export class LeaseBusyError extends Error {}
export async function acquireLease(file: string): Promise<() => Promise<void>> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })) } finally { await handle.close() }
      return async () => {
        const value = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as { token?: string }
        if (value.token === token) await rm(file, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner: { pid: number }
      try { owner = JSON.parse(await readFile(file, 'utf8')) as { pid: number } }
      catch { throw new LeaseBusyError('Sandbox preparation is already in progress; retry shortly') }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid sandbox ownership lock')
      try { process.kill(owner.pid, 0); throw new LeaseBusyError('Sandbox is already managed by another process; stop it before restarting') }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe }
      await rm(file, { force: true })
    }
  }
  throw new Error('Could not acquire sandbox ownership')
}

/** Different agents may prepare the shared runtime concurrently on first launch. */
export async function waitForLease(file: string, timeoutMs = 1_200_000): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { return await acquireLease(file) }
    catch (error) {
      if (!(error instanceof LeaseBusyError) || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now()))))
    }
  }
}

/** Copy bytes, never host links. A private projection is the only public bind. */
export async function copySafeTree(source: string, destination: string, options: { maxBytes?: number; maxEntries?: number; excludeNames?: readonly string[] } = {}): Promise<string> {
  const excluded = new Set(options.excludeNames?.map(name => name.toLowerCase()))
  const root = await realpath(source)
  if ((await lstat(source)).isSymbolicLink()) throw new Error('Data root must not be a link')
  const device = (await lstat(root)).dev
  let bytes = 0, entries = 0
  const digest = createHash('sha256')
  async function verify(path: string) {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || stat.dev !== device || stat.isFile() && stat.nlink !== 1 || !contains(root, await realpath(path))) throw new Error('Links and nested mounts are not allowed in sandbox data')
    return stat
  }
  async function visit(from: string, to: string): Promise<void> {
    if (++entries > (options.maxEntries ?? 100_000)) throw new Error('Sandbox data exceeds 100000 entries')
    const before = await verify(from)
    digest.update(JSON.stringify([relative(root, from), before.isDirectory() ? 'dir' : before.size]))
    if (before.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 })
      const names: string[] = []
      for await (const entry of await opendir(from)) { names.push(entry.name); if (names.length > (options.maxEntries ?? 100_000)) throw new Error('Too many sandbox data entries') }
      for (const name of names.sort()) {
        if (!excluded.has(name.toLowerCase())) await visit(join(from, name), join(to, name))
      }
    } else if (before.isFile()) {
      bytes += before.size
      if (bytes > (options.maxBytes ?? 512 * 1024 * 1024)) throw new Error('Sandbox shared data exceeds 512 MiB; choose a smaller directory')
      const input = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const opened = await input.stat()
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || !opened.isFile()) throw new Error('Data changed during open')
        await verify(from)
        const output = await open(to, 'wx', 0o600)
        try {
          const buffer = Buffer.alloc(64 * 1024)
          let offset = 0
          while (offset < before.size) {
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
            if (!bytesRead) throw new Error('Data changed during copy')
            digest.update(buffer.subarray(0, bytesRead))
            await output.writeFile(buffer.subarray(0, bytesRead)); offset += bytesRead
          }
        } finally { await output.close() }
        const after = await verify(from), final = await input.stat()
        if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || final.nlink !== 1) throw new Error('Data changed during copy; retry')
      } finally { await input.close() }
    } else throw new Error('Special files are not allowed in sandbox data')
    const after = await verify(from)
    if (after.ino !== before.ino || after.dev !== before.dev) throw new Error('Data directory changed during copy')
  }
  await visit(root, destination)
  if (await realpath(source) !== root) throw new Error('Data root changed during copy')
  return digest.digest('hex')
}
