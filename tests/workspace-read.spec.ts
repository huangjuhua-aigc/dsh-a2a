import { mkdtemp, mkdir, writeFile, rm, symlink, link, truncate, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { workspaceReadTool } from '../src/workspace-read.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

let base: string
let root: string
let privateDir: string
const call = async (path: string, options = {}) => {
  const tool = await workspaceReadTool(root, [privateDir])
  return await tool.execute({ path, ...options }, { signal: new AbortController().signal } as ToolRunContext) as {
    kind: string; path: string; content: string; truncated: boolean
  }
}
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'a2a-read-'))
  root = join(base, 'data'); privateDir = join(root, 'state')
  await mkdir(privateDir, { recursive: true })
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', 'notes.txt'), '项目状态：进行中\n第二行\n第三行', 'utf8')
  await writeFile(join(base, 'outside.txt'), 'OUTSIDE_SECRET', 'utf8')
  await writeFile(join(privateDir, 'context.json'), 'PRIVATE_CONVERSATION', 'utf8')
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

describe('bounded workspace reads', () => {
  it('reads relative and absolute paths under the authorized root, with pagination', async () => {
    expect((await call('docs/notes.txt')).content).toContain('项目状态')
    const page = await call(join(root, 'docs', 'notes.txt'), { offset: 2, limit: 1 })
    expect(page).toEqual({ kind: 'file', path: join('docs', 'notes.txt'), content: '第二行', truncated: true })
  })
  it('lists directories while keeping transport checkpoints private', async () => {
    const listing = await call('.')
    expect(listing.content).toBe('docs/')
    expect((await call('docs')).content).toBe('notes.txt')
    await expect(call('state/context.json')).rejects.toThrow('outside the authorized')
  })
  it('rejects parent traversal, absolute escapes, and sibling directories sharing the root prefix', async () => {
    await mkdir(join(base, 'data-extra'))
    await writeFile(join(base, 'data-extra', 'secret.txt'), 'SECRET')
    for (const path of ['../outside.txt', join(base, 'outside.txt'), resolve(root, '../data-extra/secret.txt')]) {
      await expect(call(path)).rejects.toThrow('outside the authorized')
    }
  })
  it('refuses junctions/symlinks leading outside and inside the root', async () => {
    await symlink(base, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(join(root, 'docs'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(call('escape/outside.txt')).rejects.toThrow('outside the authorized')
    await expect(call('alias/notes.txt')).rejects.toThrow('Symbolic links')
    expect((await call('.')).content).toBe('docs/')
  })
  it('refuses a root replaced by a junction after activation', async () => {
    const root2 = join(base, 'root2')
    await mkdir(root2)
    const tool = await workspaceReadTool(root2, [])
    await rm(root2, { recursive: true })
    await symlink(base, root2, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(tool.execute({ path: 'outside.txt' }, { signal: new AbortController().signal } as ToolRunContext)).rejects.toThrow('outside the authorized')
  })
  it('refuses hard links even when the link name is inside the root', async () => {
    await link(join(base, 'outside.txt'), join(root, 'linked.txt'))
    await expect(call('linked.txt')).rejects.toThrow('Hard-linked')
  })
  it('bounds file sizes and returned text; rejects binaries and invalid parameters', async () => {
    await writeFile(join(root, 'large.txt'), '')
    await truncate(join(root, 'large.txt'), 2 * 1024 * 1024 + 1)
    await expect(call('large.txt')).rejects.toThrow('2 MiB')
    await writeFile(join(root, 'long.txt'), 'a'.repeat(40_000))
    expect((await call('long.txt')).content).toHaveLength(32_000)
    expect((await call('long.txt')).truncated).toBe(true)
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
    await expect(call('binary.dat')).rejects.toThrow('Binary')
    await expect(call('docs/notes.txt', { offset: -1 })).rejects.toThrow()
    await expect(call('docs/notes.txt', { limit: 501 })).rejects.toThrow()
  })
  it('observes cancellation before touching data', async () => {
    const controller = new AbortController(); controller.abort()
    const tool = await workspaceReadTool(root, [])
    await expect(tool.execute({ path: 'docs/notes.txt' }, { signal: controller.signal } as ToolRunContext)).rejects.toThrow()
  })
  it('rejects invalid UTF-8 rather than silently corrupting the document', async () => {
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]))
    await expect(call('invalid.txt')).rejects.toThrow()
    expect((await call('docs/notes.txt')).content).toContain('项目状态')
  })
  it('marks oversized directory listings as truncated and paginates entries', async () => {
    const files = join(root, 'many')
    await mkdir(files)
    await Promise.all(Array.from({ length: 1002 }, (_, index) => writeFile(join(files, `${String(index).padStart(4, '0')}.txt`), 'data')))
    const first = await call('many', { limit: 2 })
    expect(first.content.split('\n')).toHaveLength(2)
    expect(first.truncated).toBe(true)
    const next = await call('many', { offset: 3, limit: 2 })
    expect(next.content.split('\n')).toHaveLength(2)
    expect(next.content).not.toBe(first.content)
    expect(next.truncated).toBe(true)
  })
  it.skipIf(process.platform !== 'win32')('refuses alternate data streams and NT device paths on Windows', async () => {
    await expect(call('docs/notes.txt:hidden')).rejects.toThrow('alternate data streams')
    await expect(call(`\\\\?\\${join(root, 'docs', 'notes.txt')}`)).rejects.toThrow('Device paths')
    // Verify normal handles still close cleanly after a successful read.
    await call('docs/notes.txt')
    const handle = await open(join(root, 'docs', 'notes.txt'), 'r+')
    await handle.close()
  })
})
