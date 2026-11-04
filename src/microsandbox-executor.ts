import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Sandbox, SandboxConfig } from 'microsandbox'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { contains, type prepareIsolation, verifyMountTree, PUBLIC_PROJECTION_EXCLUDED_NAMES } from './isolation.ts'
import { acquireLease, atomicJson, copySafeTree, removeOwned } from './sandbox-files.ts'
import { VisitorSandboxes, type SandboxDriver, type SandboxVM } from './sandbox-lifecycle.ts'
import { loadMicrosandbox, MICROSANDBOX_IMAGE, prepareMicrosandbox, type MicrosandboxModule, type PreparedRuntime, type RuntimeOptions } from './microsandbox-runtime.ts'

type Isolation = Awaited<ReturnType<typeof prepareIsolation>>
type PeerRecord = { schema: 1; name: string; configHash?: string; publicHash?: string; imported?: boolean }
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
function configHash(config: SandboxConfig): string {
  // Resolved manifest is populated on first boot, not part of the requested bindings.
  if (!Array.isArray(config.env)) throw new Error('Unexpected sandbox environment configuration')
  const value = { ...config, env: [...config.env].sort((a,b)=>String(a.key).localeCompare(String(b.key))), manifestDigest: null }
  const stable = (input: unknown): unknown => Array.isArray(input) ? input.map(stable)
    : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).filter(([,v])=>v!==null).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])) : input
  return hash(JSON.stringify(stable(value)))
}

export class MicrosandboxVM implements SandboxVM {
  constructor(readonly sandbox: Sandbox) {}
  async pause(): Promise<void> { await this.sandbox.pause() }
  async resume(): Promise<void> { await this.sandbox.resume() }
  async stop(): Promise<void> {
    await this.sandbox.resume() // idempotent; a paused VM must resume before stop
    try { await this.sandbox.stopWithTimeout(10_000) }
    catch { await this.sandbox.killWithTimeout(10_000) }
  }
  /** Trusted host dispatch only. No model-controlled runtime flags or host paths. */
  async python(code: string, args: string[], signal: AbortSignal, root = false): Promise<string> {
    signal.throwIfAborted()
    const exec = await this.sandbox.execStreamWith('python3', b => b.args(['-I', '-c', code, ...args]).user(root ? '0:0' : '1000:1000').timeout(30_000))
    const abort = () => { void exec.kill().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const output: Uint8Array[] = [], errors: Uint8Array[] = []
    let size = 0, exitCode: number | undefined
    try {
      for await (const event of exec) {
        signal.throwIfAborted()
        if (event.kind === 'exited') exitCode = event.code
        if (event.kind === 'stdout' || event.kind === 'stderr') {
          size += event.data.length
          if (size > 256_000) throw new Error('Sandbox output exceeded limit')
          ;(event.kind === 'stdout' ? output : errors).push(event.data)
        }
      }
      signal.throwIfAborted()
      const stdout = Buffer.concat(output).toString('utf8'), stderr = Buffer.concat(errors).toString('utf8')
      if (exitCode !== 0) {
        try { const response = JSON.parse(stdout) as { error?: string }; if (response.error) throw new Error(response.error) }
        catch (error) { if (error instanceof Error && !(error instanceof SyntaxError)) throw error }
        throw new Error(`Sandbox command failed (${exitCode}): ${stderr.slice(0, 2000)}`)
      }
      return stdout
    } catch (error) {
      await exec.kill().catch(() => {})
      await exec.wait().catch(() => {})
      throw error
    } finally { signal.removeEventListener('abort', abort) }
  }
}

export class MicrosandboxDriver implements SandboxDriver<MicrosandboxVM> {
  private constructor(private readonly isolation: Isolation, private readonly sdk: MicrosandboxModule,
    private readonly control: string, private readonly namespace: string, private readonly release: () => Promise<void>) {}
  static async create(isolation: Isolation, options: RuntimeOptions & { prepared?: PreparedRuntime } = {}): Promise<MicrosandboxDriver> {
    const runtime = options.prepared ?? await prepareMicrosandbox(options)
    // Managed images and all guest disks must also stay outside visitor-readable roots.
    const runtimeRoot = await realpath(runtime.directory)
    for (const data of new Set([isolation.dataRootFor('owner'), ...isolation.dataRoots])) {
      const root = await realpath(data)
      if (contains(root, runtimeRoot) || contains(runtimeRoot, root)) throw new Error('Public data must be outside the managed sandbox runtime')
    }
    const configuredControl = join(isolation.privateRoot, '.microsandbox')
    await mkdir(configuredControl, { recursive: true, mode: 0o700 })
    if ((await lstat(configuredControl)).isSymbolicLink()) throw new Error('Sandbox control directory must not be redirected')
    const control = await realpath(configuredControl)
    const release = await acquireLease(join(control, 'manager.lock'))
    try {
      const namespace = hash(await realpath(isolation.privateRoot)).slice(0, 24)
      const driver = new MicrosandboxDriver(isolation, await loadMicrosandbox(runtime), control, namespace, release)
      await driver.recover()
      return driver
    } catch (error) { await release(); throw error }
  }
  /** A crashed host may leave native VMs running. Reclaim only our recorded VMs. */
  private async recover(): Promise<void> {
    for (const entry of await readdir(this.control, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name)) continue
      const record = await this.record(entry.name)
      if (!record.configHash) continue
      let handle
      try { handle = await this.sdk.Sandbox.get(record.name) }
      catch (error) { if (/not found|does not exist|not exist|unknown sandbox/i.test(String(error))) continue; throw error }
      if (configHash(handle.config()) !== record.configHash) throw new Error('Existing sandbox configuration differs; refusing recovery')
      if (handle.status === 'paused') await handle.resume()
      if (handle.status === 'running' || handle.status === 'paused') await new MicrosandboxVM(await handle.connect()).stop()
    }
  }
  private paths(peer: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(peer)) throw new Error('Invalid visitor identity')
    const base = join(this.control, peer)
    return { base, public: join(base, 'public'), record: join(base, 'record.json'), name: `a2a-${this.namespace}-${hash(peer).slice(0,24)}` }
  }
  private async record(peer: string): Promise<PeerRecord> {
    const p = this.paths(peer)
    try {
      const value = JSON.parse(await readFile(p.record, 'utf8')) as PeerRecord
      if (value.schema !== 1 || value.name !== p.name) throw new Error('Sandbox ownership metadata changed')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { schema: 1, name: p.name }
    }
  }
  async stage(peer: string): Promise<undefined | { commit(): Promise<void>; discard(): Promise<void> }> {
    await this.isolation.verifyContainer(peer)
    const p = this.paths(peer)
    await mkdir(p.base, { recursive: true, mode: 0o700 })
    if (await realpath(p.base) !== p.base) throw new Error('Sandbox data directory changed')
    const temporary = join(p.base, `public-next-${randomUUID()}`)
    try {
      const digest = await copySafeTree(this.isolation.dataRootFor(peer), temporary, { excludeNames: PUBLIC_PROJECTION_EXCLUDED_NAMES })
      const current = await this.record(peer)
      if (current.publicHash === digest) {
        await verifyMountTree(p.public)
        await removeOwned(p.base, temporary)
        return undefined
      }
      return {
        commit: async () => {
          const backup = join(p.base, `public-old-${randomUUID()}`)
          let moved = false
          try { await rename(p.public, backup); moved = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          try { await rename(temporary, p.public) }
          catch (error) { if (moved) await rename(backup, p.public); throw error }
          await atomicJson(p.record, { ...await this.record(peer), publicHash: digest })
          if (moved) await removeOwned(p.base, backup)
        },
        discard: () => removeOwned(p.base, temporary),
      }
    } catch (error) { await removeOwned(p.base, temporary); throw error }
  }
  async start(peer: string): Promise<MicrosandboxVM> {
    const p = this.paths(peer), record = await this.record(peer)
    const image = await this.sdk.Image.inspect(MICROSANDBOX_IMAGE)
    if (!image.config) throw new Error('Missing pinned sandbox image configuration')
    const imageEnv = Object.fromEntries(image.config.env.map(entry => { const split=entry.indexOf('='); return [entry.slice(0,split),entry.slice(split+1)] }))
    const builder = () => this.sdk.Sandbox.builder(p.name).image(MICROSANDBOX_IMAGE).pullPolicy('never')
      .cpus(1).memory(512).rootDisk(256).security('restricted').disableNetwork().user('1000:1000').workdir('/work')
      .cmd([...image.config!.cmd ?? []]).envs(imageEnv)
      .volume('/source', m => m.bind(p.public).readonly().noexec().nosuid().nodev().owner(1000,1000))
      .volume('/work', m => m.owned({ kind: 'disk', sizeMib: 512 }).nosuid().nodev())
      .label('a2a.namespace', this.namespace).label('a2a.peer', peer)
    const expected = configHash(await builder().build())
    if (record.configHash && record.configHash !== expected) throw new Error('Saved visitor sandbox configuration differs; preserve its disk and migrate before starting')
    // Persist intent before native creation so a crash does not orphan or lose the disk.
    await atomicJson(p.record, { ...record, configHash: expected })
    let handle
    try { handle = await this.sdk.Sandbox.get(p.name) }
    catch (error) { if (!/not found|does not exist|not exist|unknown sandbox/i.test(String(error))) throw error }
    let sandbox: Sandbox
    if (handle) {
      if (configHash(handle.config()) !== expected) throw new Error('Existing sandbox has unexpected mounts or security settings')
      if (handle.status === 'paused') { await handle.resume(); sandbox = await handle.connect() }
      else if (handle.status === 'running') sandbox = await handle.connect()
      else if (['stopped','crashed','created'].includes(handle.status)) sandbox = await handle.start()
      else throw new Error('Visitor sandbox is still transitioning; retry shortly')
    } else sandbox = await builder().create()
    const vm = new MicrosandboxVM(sandbox)
    try {
      if (sandbox.backendKind !== 'local' || configHash(await sandbox.config()) !== expected) throw new Error('Unexpected sandbox backend or configuration')
      if (!record.imported) {
        const seed = join(p.base, `seed-${randomUUID()}`)
        try {
          await copySafeTree(this.isolation.workspaceFor(peer), seed)
          const upload = async (dir: string, guest: string): Promise<void> => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
              const source = join(dir, entry.name), target = `${guest}/${entry.name}`
              if (entry.isDirectory()) {
                if (!await sandbox.fs().exists(target)) await sandbox.fs().mkdir(target)
                await upload(source, target)
              }
              else {
                const bytes = await readFile(source)
                if (await sandbox.fs().exists(target)) {
                  if (hash(await sandbox.fs().read(target)) !== hash(bytes)) throw new Error('Private file import conflict; original files have been retained')
                } else await sandbox.fs().write(target, bytes)
              }
            }
          }
          await upload(seed, '/work')
          await vm.python('import os\nfor root,dirs,files in os.walk("/work"):\n os.chown(root,1000,1000)\n for name in files: os.chown(os.path.join(root,name),1000,1000)', [], new AbortController().signal, true)
          await atomicJson(p.record, { ...await this.record(peer), imported: true })
        } finally { await removeOwned(p.base, seed) }
      }
      return vm
    } catch (error) { await vm.stop().catch(() => {}); throw error }
  }
  async close(): Promise<void> { await this.release() }
}

export function microsandboxReadTool(definition: ToolDefinition, peer: string, manager: VisitorSandboxes<MicrosandboxVM>): ToolDefinition {
  let script: Promise<string> | undefined
  return { ...definition, execute: async (raw, { signal }) => {
    const args = JSON.stringify(raw)
    if (!args || Buffer.byteLength(args) > 8192) throw new Error('Read request too large')
    script ??= readFile(fileURLToPath(new URL('./visitor-worker.py', import.meta.url)), 'utf8')
    const worker = await script
    return await manager.run(peer, async vm => {
      const output = JSON.parse(await vm.python(worker, [args], signal)) as { result?: unknown; error?: string }
      if (output.error || output.result === undefined) throw new Error(output.error || 'Invalid sandbox output')
      return output.result
    }, signal)
  } }
}
