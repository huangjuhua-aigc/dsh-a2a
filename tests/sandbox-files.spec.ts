import { mkdtemp, mkdir, writeFile, readFile, link, realpath, rm, symlink, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireLease, waitForLease, copySafeTree, removeOwned } from '../src/sandbox-files.ts'
import { assertMicrosandboxPlatform, runRuntimeCommand } from '../src/microsandbox-runtime.ts'
import { PUBLIC_PROJECTION_EXCLUDED_NAMES, PUBLIC_PROJECTION_SOURCE_OPTIONS, verifyMountTree } from '../src/isolation.ts'

describe('managed sandbox files and preparation', () => {
  it('waits for concurrent preparation, retains lock ownership, and times out rather than bypassing it', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'a2a-msb-lock-')))
    try {
      const file = join(base, 'prepare.lock'), release = await acquireLease(file)
      await expect(waitForLease(file, 10)).rejects.toThrow('already managed')
      let entered = false
      const next = waitForLease(file).then(release => { entered = true; return release })
      await new Promise(r => setTimeout(r, 20)); expect(entered).toBe(false)
      await release(); const secondRelease = await next
      await release() // an old release must not delete the new holder's lock
      expect(JSON.parse(await readFile(file, 'utf8')).pid).toBe(process.pid)
      await secondRelease()
    } finally { await removeOwned(await realpath(tmpdir()), base) }
  })
  it('makes independent public snapshots and rejects aliases and oversized data', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'a2a-msb-copy-')))
    try {
      await mkdir(join(base, 'source'))
      await writeFile(join(base, 'source/info.txt'), 'public')
      const digest = await copySafeTree(join(base, 'source'), join(base, 'copy'))
      expect(digest).toHaveLength(64)
      await writeFile(join(base, 'copy/info.txt'), 'local copy changed')
      expect(await readFile(join(base, 'source/info.txt'), 'utf8')).toBe('public')
      await expect(copySafeTree(join(base, 'source'), join(base, 'small'), { maxBytes: 1 })).rejects.toThrow('exceeds')
      await link(join(base, 'source/info.txt'), join(base, 'source/link.txt'))
      await expect(copySafeTree(join(base, 'source'), join(base, 'unsafe'))).rejects.toThrow('Links')
      await rm(join(base, 'source/link.txt'))
      await expect(removeOwned(base, tmpdir())).rejects.toThrow('Unsafe')
    } finally { await removeOwned(await realpath(tmpdir()), base) }
  })
  it('excludes nested dependencies from public projections without following links or changing source data', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'a2a-msb-exclude-')))
    const source = join(base, 'source'), outside = join(base, 'outside')
    const options = { excludeNames: PUBLIC_PROJECTION_EXCLUDED_NAMES }
    try {
      await mkdir(join(source, 'nested/Node_Modules'), { recursive: true })
      await mkdir(outside)
      await writeFile(join(source, 'info.txt'), 'public')
      await writeFile(join(source, 'nested/Node_Modules/library.js'), 'dependency')
      await writeFile(join(outside, 'secret.txt'), 'outside data')
      await symlink(outside, join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
      const digest = await copySafeTree(source, join(base, 'copy'), options)
      expect(await readdir(join(base, 'copy'))).toEqual(['info.txt', 'nested'])
      expect(await readdir(join(base, 'copy/nested'))).toEqual([])
      expect(await readFile(join(base, 'copy/info.txt'), 'utf8')).toBe('public')
      expect(await realpath(join(source, 'node_modules'))).toBe(outside)
      await writeFile(join(outside, 'secret.txt'), 'changed outside data')
      expect(await copySafeTree(source, join(base, 'again'), options)).toBe(digest)
      // Private imports have no exclusions; all links there remain forbidden.
      await expect(copySafeTree(source, join(base, 'strict'))).rejects.toThrow('Links')
      await symlink(outside, join(source, 'other-link'), process.platform === 'win32' ? 'junction' : 'dir')
      await expect(copySafeTree(source, join(base, 'unsafe'), options)).rejects.toThrow('Links')
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('changed outside data')
    } finally { await removeOwned(await realpath(tmpdir()), base) }
  })
  it('copies public hardlinks into separate files; writes and deletion never affect their source or sibling copy', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'a2a-msb-hardlinks-')))
    try {
      const source = join(base, 'source'), copy = join(base, 'copy'), original = join(base, 'original.txt')
      await mkdir(source); await writeFile(original, 'OWNER_PUBLIC_CONTENT')
      await link(original, join(source, 'first.txt')); await link(original, join(source, 'second.txt'))
      expect((await lstat(original)).nlink).toBe(3)
      const digest = await copySafeTree(source, copy, PUBLIC_PROJECTION_SOURCE_OPTIONS)
      const first = await lstat(join(copy, 'first.txt')), second = await lstat(join(copy, 'second.txt'))
      expect(first.nlink).toBe(1); expect(second.nlink).toBe(1)
      expect(first.ino).not.toBe(second.ino); expect(first.ino).not.toBe((await lstat(original)).ino)
      await verifyMountTree(copy)
      await writeFile(join(copy, 'first.txt'), 'CHANGED_COPY')
      expect(await readFile(join(copy, 'second.txt'), 'utf8')).toBe('OWNER_PUBLIC_CONTENT')
      await rm(join(copy, 'second.txt'))
      expect(await readFile(original, 'utf8')).toBe('OWNER_PUBLIC_CONTENT')
      expect(await readFile(join(source, 'second.txt'), 'utf8')).toBe('OWNER_PUBLIC_CONTENT')
      await writeFile(original, 'OWNER_UPDATED_CONTENT')
      expect(await readFile(join(copy, 'first.txt'), 'utf8')).toBe('CHANGED_COPY')
      expect(await copySafeTree(source, join(base, 'updated'), PUBLIC_PROJECTION_SOURCE_OPTIONS)).not.toBe(digest)
      // Private imports and raw mounts must never inherit the public source exception.
      await expect(copySafeTree(source, join(base, 'private-import'))).rejects.toThrow('Links')
      await expect(verifyMountTree(source)).rejects.toThrow('Links')
      await expect(copySafeTree(source, join(base, 'too-small'), { ...PUBLIC_PROJECTION_SOURCE_OPTIONS, maxBytes: 1 })).rejects.toThrow('exceeds')
      await mkdir(join(base, 'outside'))
      await symlink(join(base, 'outside'), join(source, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
      await expect(copySafeTree(source, join(base, 'unsafe'), PUBLIC_PROJECTION_SOURCE_OPTIONS)).rejects.toThrow('Links')
    } finally { await removeOwned(await realpath(tmpdir()), base) }
  })
  it('rejects unsupported machines before downloading or executing anything', () => {
    expect(() => assertMicrosandboxPlatform('darwin','arm64')).not.toThrow()
    expect(() => assertMicrosandboxPlatform('darwin','x64')).toThrow('Intel Mac')
    expect(() => assertMicrosandboxPlatform('freebsd','x64')).toThrow('不支持')
  })
  it('bounds preparation commands and terminates timed-out helpers without executing a fallback', async () => {
    expect(await runRuntimeCommand(process.execPath, ['-e', 'process.stdout.write("ready")'])).toBe('ready')
    await expect(runRuntimeCommand(process.execPath, ['-e', 'process.stderr.write("fixture failure");process.exit(1)'])).rejects.toThrow('fixture failure')
    await expect(runRuntimeCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 })).rejects.toThrow('准备超时')
  })
})
