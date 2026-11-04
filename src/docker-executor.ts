import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { contains } from './isolation.ts'

export const VISITOR_IMAGE = 'talk2myagent/visitor-runtime:0.1.0'
export const MAX_VISITOR_CONTAINERS = 4
let activeContainers = 0

/** Per backend process, shared by all its visitor contexts. No unbounded queue. */
export function reserveContainer(): () => void {
  if (activeContainers >= MAX_VISITOR_CONTAINERS) throw new Error('Visitor tools are busy; try again later')
  activeContainers++
  let released = false
  return () => { if (!released) { released = true; activeContainers-- } }
}

export async function docker(args: string[], input = '', signal?: AbortSignal, timeoutMs = 30_000): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', errors = '', failed = false
    const fail = (error: Error): void => { if (!failed) { failed = true; child.kill(); reject(error) } }
    const abort = (): void => fail(new Error('Container operation canceled'))
    const timer = setTimeout(() => fail(new Error('Container operation timed out')), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.on('error', error => fail(new Error(`Docker unavailable: ${error.message}`)))
    child.stdin.on('error', () => {})
    child.stdout.on('data', bytes => { output += String(bytes); if (output.length > 256_000) fail(new Error('Container output exceeded limit')) })
    child.stderr.on('data', bytes => { errors = (errors + String(bytes)).slice(-4000) })
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (failed) return
      if (code === 0) resolve(output)
      else reject(new Error(`Container failed (${code}): ${errors || output.slice(0, 4000)}`))
    })
    child.stdin.end(input)
  })
}

export async function requireDocker(): Promise<void> {
  if (process.platform === 'linux' && process.getuid?.() === 0) throw new Error('Run the A2A backend as a non-root user so private workspace permissions match the container user')
  // Bind sources must refer to this computer, never an unrelated remote daemon.
  if (process.env['DOCKER_HOST'] && !/^(npipe:|unix:)/.test(process.env['DOCKER_HOST'])) throw new Error('A local Docker engine is required')
  const context = JSON.parse(await docker(['context', 'inspect'])) as Array<{ Endpoints?: { docker?: { Host?: string } } }>
  if (!/^(npipe:|unix:)/.test(context[0]?.Endpoints?.docker?.Host ?? '')) throw new Error('A local Docker context is required')
  const info = JSON.parse(await docker(['info', '--format', '{{json .}}'])) as { OSType: string }
  if (info.OSType !== 'linux') throw new Error('Linux containers are required')
  try { await docker(['image', 'inspect', VISITOR_IMAGE]) }
  catch { throw new Error(`Missing ${VISITOR_IMAGE}. Build the runtime with: docker build -t ${VISITOR_IMAGE} <dsh-a2a>/docker`) }
}

export async function containerArgs(name: string, dataRoot: string, workRoot: string, worker: string): Promise<string[]> {
  const [data, work, script] = await Promise.all([realpath(dataRoot), realpath(workRoot), realpath(worker)])
  if (contains(data, work) || contains(work, data)) throw new Error('Public data and private workspace must be disjoint')
  if ([data, work, script].some(path => /[,\r\n]/.test(path))) throw new Error('Docker mount paths cannot contain commas or newlines')
  return ['run', '--rm', '--pull=never', '--name', name, '--label', 'talk2myagent.role=visitor-tool',
    '--network=none', '--read-only', `--user=${process.platform === 'linux' ? `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}` : '1000:1000'}`, '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=64', '--memory=256m', '--cpus=1', '--workdir=/work',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777',
    '--mount', `type=bind,src=${data},dst=/source,readonly,bind-recursive=disabled`,
    '--mount', `type=bind,src=${work},dst=/work,bind-recursive=disabled`,
    '--mount', `type=bind,src=${script},dst=/opt/visitor-worker.mjs,readonly`,
    '-i', VISITOR_IMAGE]
}

/** The model supplies only read arguments; never Docker flags, mounts or commands. */
export function dockerReadTool(definition: ToolDefinition, dataRoot: string, workRoot: string, verify: () => Promise<void>): ToolDefinition {
  return { ...definition, execute: async (raw, { signal }) => {
    signal.throwIfAborted()
    const release = reserveContainer()
    const name = `a2a-read-${randomUUID()}`
    let started = false
    try {
      await verify()
      signal.throwIfAborted()
      const compiled = fileURLToPath(new URL('./visitor-worker.mjs', import.meta.url))
      const worker = existsSync(compiled) ? compiled : fileURLToPath(new URL('../lib/visitor-worker.mjs', import.meta.url))
      const args = await containerArgs(name, dataRoot, workRoot, worker)
      started = true
      const output = await docker([...args, 'node', '/opt/visitor-worker.mjs'], JSON.stringify(raw), signal)
      const response = JSON.parse(output) as { result?: unknown; error?: string }
      if (response.error || response.result === undefined) throw new Error(response.error ?? 'Invalid worker response')
      return response.result
    } finally {
      // Killing the Docker CLI alone does not terminate its container.
      if (started) await docker(['rm', '-f', name], '', undefined, 10_000).catch(() => {})
      release()
    }
  } }
}
