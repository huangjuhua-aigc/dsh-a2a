import { mkdir, mkdtemp, writeFile, readFile, rm, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Config, type A2AServerConfig } from '../src/config.ts'
import { prepareIsolation, verifyMountTree } from '../src/isolation.ts'
import { visitorReadTool } from '../src/visitor-read.ts'
import { reserveContainer, MAX_VISITOR_CONTAINERS, dockerReadTool } from '../src/docker-executor.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

let base: string, config: A2AServerConfig
const context = { signal: new AbortController().signal } as ToolRunContext
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'a2a-isolation-'))
  await mkdir(join(base, 'public'))
  config = Config({ peers: { alice: { tokenEnv: 'ALICE' }, bob: { tokenEnv: 'BOB' } }, isolation: {
    workspaceMode: 'per-peer', peerWorkspaces: {}, workspaceRoot: join(base, 'public'), privateRoot: join(base, 'private') } } as unknown as A2AServerConfig)
})
afterEach(async () => {
  if (!resolve(base).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe fixture cleanup')
  await rm(base, { recursive: true, force: true })
})

it('gives B shared public data and its own workspace, never A files or backend logs', async () => {
  const isolation = await prepareIsolation(config, join(base, 'logs'))
  for (const peer of ['alice', 'bob']) {
    await mkdir(isolation.workspaceFor(peer)); await writeFile(join(isolation.workspaceFor(peer), 'private.txt'), peer)
  }
  await mkdir(join(base, 'logs')); await writeFile(join(base, 'logs', 'chat.txt'), 'backend')
  await writeFile(join(base, 'public', 'info.txt'), 'public')
  await isolation.verifyContainer('bob')
  const reader = await visitorReadTool(isolation.dataRootFor('bob'), isolation.workspaceFor('bob'), isolation.privateDirectoriesFor('bob'))
  expect(await reader.execute({ path: 'info.txt' }, context)).toMatchObject({ content: 'public' })
  expect(await reader.execute({ root: 'workspace', path: 'private.txt' }, context)).toMatchObject({ content: 'bob' })
  for (const root of ['public', 'workspace']) for (const path of [join(base, 'private/alice/private.txt'), '../alice/private.txt', join(base, 'logs/chat.txt')]) {
    await expect(reader.execute({ root, path }, context)).rejects.toThrow()
  }
})

it('hides old visitor directories (including retained removed peers) and refuses raw mounting before migration', async () => {
  await mkdir(join(base, 'public', 'retired')); await writeFile(join(base, 'public', 'retired', 'secret.txt'), 'old')
  const isolation = await prepareIsolation(config, join(base, 'logs'), ['retired'])
  await mkdir(isolation.workspaceFor('bob'))
  const reader = await visitorReadTool(isolation.dataRootFor('bob'), isolation.workspaceFor('bob'), isolation.privateDirectoriesFor('bob'))
  expect(await reader.execute({ path: '.' }, context)).toMatchObject({ content: '' })
  await expect(reader.execute({ path: 'retired/secret.txt' }, context)).rejects.toThrow()
  await expect(isolation.verifyContainer('bob')).rejects.toThrow('migrate')
})

it('rejects nested private storage and a workspace redirected into another visitor', async () => {
  config.isolation.privateRoot = join(base, 'public', 'private')
  await expect(prepareIsolation(config, join(base, 'logs'))).rejects.toThrow('outside')
  config.isolation.privateRoot = join(base, 'private')
  const isolation = await prepareIsolation(config, join(base, 'logs'))
  await mkdir(isolation.workspaceFor('alice'))
  await symlink(isolation.workspaceFor('alice'), isolation.workspaceFor('bob'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(isolation.verifyWorkspace('bob')).rejects.toThrow()
})

it('refuses symlinks/junctions and hard links before bind mounting', async () => {
  const publicRoot = config.isolation.workspaceRoot
  await mkdir(join(base, 'outside'))
  await symlink(join(base, 'outside'), join(publicRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(verifyMountTree(publicRoot)).rejects.toThrow('Links')
  await rm(join(publicRoot, 'linked'))
  await writeFile(join(base, 'secret.txt'), 'private')
  await link(join(base, 'secret.txt'), join(publicRoot, 'alias.txt'))
  await expect(verifyMountTree(publicRoot)).rejects.toThrow('Links')
})

it('skips public dependency links only for Microsandbox projections, never for Docker mounts or private workspaces', async () => {
  config.isolation.execution = 'microsandbox'
  const isolation = await prepareIsolation(config, join(base, 'logs'))
  await mkdir(isolation.workspaceFor('bob'))
  const outside = join(base, 'outside'), publicLink = join(base, 'public/node_modules')
  await mkdir(outside)
  await writeFile(join(outside, 'library.js'), 'private runtime')
  await symlink(outside, publicLink, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(isolation.verifyContainer('bob')).resolves.toBeUndefined()
  config.isolation.execution = 'docker'
  await expect(isolation.verifyContainer('bob')).rejects.toThrow('Links')
  config.isolation.execution = 'microsandbox'
  const privateLink = join(isolation.workspaceFor('bob'), 'node_modules')
  await symlink(outside, privateLink, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(isolation.verifyContainer('bob')).rejects.toThrow('Links')
  await rm(privateLink)
  await symlink(outside, join(base, 'public/other-link'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(isolation.verifyContainer('bob')).rejects.toThrow('Links')
  expect(await readFile(join(outside, 'library.js'), 'utf8')).toBe('private runtime')
})

it('caps concurrent containers and never falls back to the host reader after verification fails', async () => {
  const reservations = Array.from({ length: MAX_VISITOR_CONTAINERS }, reserveContainer)
  expect(() => reserveContainer()).toThrow('busy')
  reservations.forEach(release => { release(); release() })
  reserveContainer()()
  const native = await visitorReadTool(config.isolation.workspaceRoot, config.isolation.workspaceRoot, [])
  const tool = dockerReadTool(native, config.isolation.workspaceRoot, join(base, 'private'), async () => { throw new Error('isolator unavailable') })
  await writeFile(join(base, 'public', 'probe.txt'), 'host data')
  await expect(tool.execute({ path: 'probe.txt' }, context)).rejects.toThrow('isolator unavailable')
  expect(await readFile(join(base, 'public', 'probe.txt'), 'utf8')).toBe('host data')
  reserveContainer()()
})
