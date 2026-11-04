import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rename } from 'node:fs/promises'
import { dirname, join, resolve, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { waitForLease, removeOwned } from './sandbox-files.ts'

export const MICROSANDBOX_VERSION = '0.7.11'
// Multi-architecture OCI index, reviewed on 2026-10-30 (amd64 and arm64).
export const MICROSANDBOX_IMAGE = 'docker.io/library/python@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159'
export interface PreparationProgress { phase: 'checking' | 'installing' | 'image' | 'ready'; message: string }
export interface RuntimeOptions { directory?: string; onProgress?: (progress: PreparationProgress) => void }
export type MicrosandboxModule = typeof import('microsandbox')
export interface PreparedRuntime { directory: string; home: string; sdkFile: string; cli: string }
const preparing = new Map<string, Promise<PreparedRuntime>>()

export function runtimeDirectory(): string {
  return resolve(process.env['A2A_SANDBOX_HOME'] || join(process.env['A2A_HOST_HOME'] || join(homedir(), '.a2a'), 'sandbox-runtime'))
}
export function assertMicrosandboxPlatform(platform = process.platform, architecture = process.arch): void {
  if (platform === 'darwin' && architecture !== 'arm64') throw new Error('本地沙箱需要 Apple Silicon 和 ARM64 版 Node.js；Intel Mac 暂不支持')
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(architecture)) throw new Error('当前系统或处理器暂不支持本地沙箱')
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('本地沙箱需要 Node.js 22 或更高版本')
}

export async function runRuntimeCommand(command: string, args: string[], options: { home?: string; timeoutMs?: number } = {}): Promise<string> {
  const env = { ...process.env, MSB_BACKEND: 'local', ...options.home ? { MSB_HOME: options.home } : {} }
  // Managed local runtime must not inherit an unrelated binary, cloud, or profile selection.
  for (const key of ['MSB_API_KEY', 'MSB_PROFILE', 'MSB_PATH', 'MSB_LIBKRUNFW_PATH']) delete (env as NodeJS.ProcessEnv)[key]
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errorOutput = '', timedOut = false
    let forceTimer: NodeJS.Timeout | undefined
    const timeoutError = () => new Error('沙箱准备超时，请检查网络后重试；已经下载的内容会保留')
    const timer = setTimeout(() => {
      timedOut = true
      // npm and the SDK CLI spawn native children. Killing only the wrapper
      // leaves downloads running and pipe handles open after a timeout.
      if (child.pid && process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.once('error', () => { child.kill() })
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
      forceTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); reject(timeoutError()) }, 5000)
    }, options.timeoutMs ?? 600_000)
    child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-12_000) })
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + String(chunk)).slice(-12_000) })
    child.on('error', error => { clearTimeout(timer); clearTimeout(forceTimer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(forceTimer)
      if (timedOut) reject(timeoutError())
      else if (code !== 0) reject(new Error((errorOutput || output || `Runtime exited (${code})`).slice(-4000)))
      else resolveResult(output)
    })
  })
}
async function npmCli(): Promise<string> {
  const dirs = [dirname(process.execPath), ...(process.env['PATH'] || '').split(delimiter)]
  for (const dir of dirs) for (const suffix of ['node_modules/npm/bin/npm-cli.js', '../lib/node_modules/npm/bin/npm-cli.js']) {
    const candidate = resolve(dir, suffix)
    try { await access(candidate); return candidate } catch { /* next installation */ }
  }
  throw new Error('未找到随 Node.js 安装的 npm，请修复 Node.js 安装后重试')
}

/** First-start preparation is automatic, cached, versioned and never falls back to host execution. */
export function prepareMicrosandbox(options: RuntimeOptions = {}): Promise<PreparedRuntime> {
  assertMicrosandboxPlatform()
  const directory = resolve(options.directory || runtimeDirectory())
  const existing = preparing.get(directory)
  if (existing) return existing
  const promise = prepare(directory, options.onProgress).finally(() => preparing.delete(directory))
  preparing.set(directory, promise)
  return promise
}
async function prepare(directory: string, progress?: RuntimeOptions['onProgress']): Promise<PreparedRuntime> {
  const report = (phase: PreparationProgress['phase'], message: string) => progress?.({ phase, message })
  report('checking', '正在检查本地沙箱环境…')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const release = await waitForLease(join(directory, 'prepare.lock'))
  try {
    const install = join(directory, `sdk-${MICROSANDBOX_VERSION}-${process.platform}-${process.arch}`)
    const manifest = join(install, 'node_modules', 'microsandbox', 'package.json')
    let installed = false
    try { installed = JSON.parse(await readFile(manifest, 'utf8')).version === MICROSANDBOX_VERSION } catch { /* first run */ }
    if (!installed) {
      report('installing', '首次使用，正在自动下载沙箱组件…')
      const staging = join(directory, `install-${randomUUID()}`)
      await mkdir(staging, { mode: 0o700 })
      try {
        await runRuntimeCommand(process.execPath, [await npmCli(), 'install', '--prefix', staging, '--save-exact', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `microsandbox@${MICROSANDBOX_VERSION}`, '--registry=https://registry.npmjs.org'])
        try { await access(install); await rename(install, `${install}.incomplete-${randomUUID()}`) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await rename(staging, install)
      } finally { await removeOwned(directory, staging) }
    }
    const cli = join(install, 'node_modules/microsandbox/bin/microsandbox.cjs')
    const home = join(directory, 'state')
    await mkdir(home, { recursive: true, mode: 0o700 })
    try { await runRuntimeCommand(process.execPath, [cli, 'doctor'], { home, timeoutMs: 30_000 }) }
    catch (error) {
      const hint = process.platform === 'win32' ? '请在 Windows 功能中启用“Windows 虚拟机监控程序平台 (WHP)”并重启。'
        : process.platform === 'linux' ? '请确认 /dev/kvm 可用且当前用户具有访问权限。' : '请确认使用 Apple Silicon 和 ARM64 版 Node.js。'
      throw new Error(`系统虚拟化尚未就绪。${hint}\n${String(error)}`)
    }
    report('image', '正在准备工具运行环境，首次下载可能需要几分钟…')
    await runRuntimeCommand(process.execPath, [cli, 'pull', MICROSANDBOX_IMAGE, '--quiet'], { home })
    report('ready', '沙箱环境已就绪')
    return { directory, home, sdkFile: join(install, 'node_modules/microsandbox/dist/index.js'), cli }
  } finally { await release() }
}

let loadedHome: string | undefined
/** The native SDK has process-global storage/backend settings. Pin them once. */
export async function loadMicrosandbox(runtime: PreparedRuntime): Promise<MicrosandboxModule> {
  if (loadedHome && loadedHome !== runtime.home) throw new Error('One process cannot manage different Microsandbox homes')
  loadedHome = runtime.home
  process.env['MSB_HOME'] = runtime.home
  delete process.env['MSB_PATH']; delete process.env['MSB_LIBKRUNFW_PATH']
  const sdk = await import(pathToFileURL(runtime.sdkFile).href) as MicrosandboxModule
  sdk.setDefaultBackend('local')
  return sdk
}
