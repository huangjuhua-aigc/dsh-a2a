import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { requireDocker, docker, containerArgs, dockerReadTool } from '../src/docker-executor.ts'
import { visitorReadTool } from '../src/visitor-read.ts'
import { Config, type A2AServerConfig } from '../src/config.ts'
import { prepareIsolation } from '../src/isolation.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

// Opt in: a missing daemon/image is a failure, never silently skipped when opted in.
describe.skipIf(process.env['A2A_DOCKER_TEST'] !== '1')('real Docker visitor boundary', () => {
  let base: string, publicRoot: string, alice: string, bob: string
  const worker = fileURLToPath(new URL('../lib/visitor-worker.mjs', import.meta.url))
  beforeAll(async () => {
    await requireDocker()
    base = await mkdtemp(join(tmpdir(), 'a2a-docker-'))
    publicRoot = join(base, 'public'); alice = join(base, 'private', 'alice'); bob = join(base, 'private', 'bob')
    for (const path of [publicRoot, alice, bob, join(base, 'logs')]) await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(join(publicRoot, 'info.txt'), '公共资料')
    await writeFile(join(alice, 'secret.txt'), 'ALICE_ONLY')
    await writeFile(join(bob, 'secret.txt'), 'BOB_ONLY')
    await writeFile(join(base, 'logs', 'chat.txt'), 'CHAT_NOT_MOUNTED')
  }, 60_000)
  afterAll(async () => {
    if (!base) return
    if (!resolve(base).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe fixture cleanup')
    await rm(base, { recursive: true, force: true })
  })

  it('Python can read public data and write its own workspace, but cannot change public files or see other peers/logs/network', async () => {
    for (const [work, own, other] of [[alice, 'ALICE_ONLY', 'BOB_ONLY'], [bob, 'BOB_ONLY', 'ALICE_ONLY']]) {
      const name = `a2a-isolation-test-${randomUUID()}`
      try {
        const args = await containerArgs(name, publicRoot, work!, worker)
        const result = await docker([...args, 'python3', '-c', `
import os, pathlib, socket, json
p = pathlib.Path('/source/info.txt')
assert p.read_text() == '公共资料'
assert pathlib.Path('/work/secret.txt').read_text() == '${own}'
denied = 0
for operation in [lambda: p.write_text('tampered'), lambda: p.open('a'), lambda: p.unlink(), lambda: p.rename('/source/moved.txt'), lambda: pathlib.Path('/source/new.txt').write_text('bad'), lambda: pathlib.Path('/root/host.txt').write_text('bad')]:
    try: operation()
    except OSError: denied += 1
assert denied == 6, denied
pathlib.Path('/work/result.txt').write_text('saved by ${own}')
assert not pathlib.Path('/work/../${other === 'BOB_ONLY' ? 'bob' : 'alice'}/secret.txt').exists()
assert not pathlib.Path('/logs/chat.txt').exists()
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not any(k in os.environ for k in ['DEEPSEEK_API_KEY', 'A2A_PEER_ALICE', 'A2A_ADMIN_TOKEN'])
assert os.getuid() != 0
s = socket.socket(); s.settimeout(1)
try: s.connect(('1.1.1.1', 443)); raise AssertionError('Network allowed')
except OSError: pass
finally: s.close()
print(json.dumps({'publicRead': True, 'deniedMutations': denied, 'privateWrite': True, 'networkBlocked': True}))
`], '', undefined, 60_000)
        expect(JSON.parse(result)).toMatchObject({ deniedMutations: 6, privateWrite: true, networkBlocked: true })
        expect(await readFile(join(work!, 'result.txt'), 'utf8')).toBe(`saved by ${own}`)
      } finally { await docker(['rm', '-f', name]).catch(() => {}) }
    }
    expect(await readFile(join(publicRoot, 'info.txt'), 'utf8')).toBe('公共资料')
  }, 120_000)

  it('executes the bundled reader in Docker and refuses traversal into another visitor', async () => {
    const config = Config({ peers: { alice: { tokenEnv: 'ALICE' }, bob: { tokenEnv: 'BOB' } }, isolation: {
      workspaceMode: 'per-peer', peerWorkspaces: {}, workspaceRoot: publicRoot, privateRoot: join(base, 'private'), execution: 'docker' } } as unknown as A2AServerConfig)
    const isolation = await prepareIsolation(config, join(base, 'logs'))
    const definition = await visitorReadTool(publicRoot, bob, isolation.privateDirectoriesFor('bob'))
    const reader = dockerReadTool(definition, publicRoot, bob, () => isolation.verifyContainer('bob'))
    const context = { signal: new AbortController().signal } as ToolRunContext
    expect(await reader.execute({ path: 'info.txt' }, context)).toMatchObject({ content: '公共资料' })
    expect(await reader.execute({ root: 'workspace', path: 'secret.txt' }, context)).toMatchObject({ content: 'BOB_ONLY' })
    for (const path of ['../alice/secret.txt', '/source/../work/../alice/secret.txt', join(alice, 'secret.txt')]) {
      await expect(reader.execute({ root: 'workspace', path }, context)).rejects.toThrow()
    }
  }, 120_000)
})
