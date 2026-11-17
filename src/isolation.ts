import { mkdir, realpath, lstat, opendir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { A2AServerConfig } from './config.ts'
import { deploymentKey } from './state.ts'

export const contains = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
export async function canonical(path: string): Promise<string> {
  try { return await realpath(path) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    const parent = dirname(resolve(path))
    if (parent === resolve(path)) throw e
    return join(await canonical(parent), relative(parent, resolve(path)))
  }
}

/** Applied only to a copied public projection, never to raw mounts or private imports. */
export const PUBLIC_PROJECTION_EXCLUDED_NAMES: readonly string[] = ['node_modules']
/** Source-only policy: every accepted file will be copied to a new inode before mounting. */
export const PUBLIC_PROJECTION_SOURCE_OPTIONS = { excludeNames: PUBLIC_PROJECTION_EXCLUDED_NAMES, allowFileHardLinks: true } as const

/** Raw mounts use no exclusions. Filtered validation must match the subsequent copy. */
export async function verifyMountTree(root: string, options: { excludeNames?: readonly string[]; allowFileHardLinks?: boolean } = {}): Promise<void> {
  const excluded = new Set(options.excludeNames?.map(name => name.toLowerCase()))
  const device = (await lstat(root)).dev
  let count = 0
  async function visit(path: string): Promise<void> {
    if (++count > 100_000) throw new Error('Public data is too large to validate (100000 entries); select a smaller directory')
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1 && !options.allowFileHardLinks || stat.dev !== device) throw new Error(`Links and nested mounts are not allowed in container data: ${path}`)
    if (stat.isDirectory()) {
      for await (const entry of await opendir(path)) {
        // Skip by name before stat/realpath: even dependency junctions must never be followed.
        if (!excluded.has(entry.name.toLowerCase())) await visit(join(path, entry.name))
      }
    } else if (!stat.isFile()) throw new Error(`Special files are not allowed in container data: ${path}`)
  }
  await visit(root)
}

/** Runtime workspaces never live inside a visitor-readable data root. */
export async function prepareIsolation(config: A2AServerConfig, stateDirectory: string, previousPeers: string[] = []) {
  const roots = [config.isolation.workspaceRoot, ...Object.values(config.isolation.peerWorkspaces)]
  const canonicalData = new Map<string, string>()
  const privateRoot = resolve(config.isolation.privateRoot || join(homedir(), '.dsh-a2a-workspaces', deploymentKey(config)))
  for (const root of roots) {
    if (!isAbsolute(root)) throw new Error('Authorized data directories must be absolute')
    const data = await canonical(root), privatePath = await canonical(privateRoot)
    canonicalData.set(root, data)
    if (contains(data, privatePath) || contains(privatePath, data)) throw new Error('Private workspaces must be outside all public data directories')
  }
  const protectedDirectories = [stateDirectory, process.env['DSH_HOME'] || join(homedir(), '.dsh'),
    process.env['A2A_HOST_HOME'] || join(homedir(), '.a2a'), join(homedir(), '.dsh-a2a')]
  if (config.calendar?.connectionFile) {
    if (!isAbsolute(config.calendar.connectionFile)) throw new Error('Calendar connection must use an absolute private path')
    const directory = await canonical(dirname(config.calendar.connectionFile))
    for (const root of [...roots, privateRoot]) {
      const data = await canonical(root)
      if (contains(data, directory) || contains(directory, data)) throw new Error('Calendar credentials must be outside visitor-readable directories')
    }
    protectedDirectories.push(directory)
  }
  // Legacy visitor directories remain private until explicitly migrated, including
  // when a host has not yet upgraded its Portal. Never expose their old contents.
  const peerNames = [...new Set([...Object.keys(config.peers), ...previousPeers])].filter(peer => peer !== 'owner' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(peer))
  const legacyDirectories = peerNames.map(peer => join(config.isolation.workspaceRoot, peer))
  await mkdir(privateRoot, { recursive: true, mode: 0o700 })
  const workspaceFor = (peer: string): string => join(privateRoot, peer)
  const dataRootFor = (peer: string): string => config.isolation.peerWorkspaces[peer] ?? config.isolation.workspaceRoot
  // Pin the owner-selected root, including a legacy directory alias. Links below it remain forbidden.
  const publicSourceFor = (peer: string): string => canonicalData.get(dataRootFor(peer))!
  const privateDirectories = [privateRoot, ...protectedDirectories, ...legacyDirectories]
  const privateDirectoriesFor = (peer: string): string[] => [...privateDirectories,
    ...Object.entries(config.isolation.peerWorkspaces).filter(([name]) => name !== peer).map(([, path]) => path)]
  const privateCanonical = await realpath(privateRoot)
  const verifyWorkspace = async (peer: string): Promise<void> => {
    if (await realpath(privateRoot) !== privateCanonical) throw new Error('Private workspace parent changed')
    const work = await canonical(workspaceFor(peer))
    if (!contains(privateCanonical, work) || work === privateCanonical || (await lstat(workspaceFor(peer))).isSymbolicLink()) throw new Error('Private workspace escaped its parent')
    for (const other of ['owner', ...Object.keys(config.peers)].filter(p => p !== peer)) {
      const otherWork = await canonical(workspaceFor(other))
      if (contains(work, otherWork) || contains(otherWork, work)) throw new Error('Visitor workspaces must not overlap')
    }
  }
  const verifyContainer = async (peer: string, checkedPublic?: Set<string>): Promise<void> => {
    await verifyWorkspace(peer)
    const data = await canonical(dataRootFor(peer))
    if (data !== publicSourceFor(peer)) throw new Error('Public data root changed; restart the Agent to apply the new directory')
    for (const path of privateDirectoriesFor(peer)) {
      const target = await canonical(path)
      if (contains(target, data)) throw new Error('Public data overlaps private credentials or conversation storage')
      if (contains(data, target)) {
        try { await lstat(path) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e }
        throw new Error(`Private or legacy visitor directory is inside public data; migrate it before sandbox publication: ${path}`)
      }
    }
    if (!checkedPublic?.has(data)) {
      await verifyMountTree(data, config.isolation.execution === 'microsandbox' ? PUBLIC_PROJECTION_SOURCE_OPTIONS : {})
      checkedPublic?.add(data)
    }
    await verifyMountTree(workspaceFor(peer))
  }
  return { privateRoot, dataRoots: roots, workspaceFor, dataRootFor, publicSourceFor, privateDirectories, privateDirectoriesFor, verifyWorkspace,
    verifyContainer: (peer: string): Promise<void> => verifyContainer(peer),
    // Cache only inside this startup pass. Every tool call performs a fresh validation.
    verifyContainers: async (peers: string[]): Promise<void> => {
      const checkedPublic = new Set<string>()
      for (const peer of peers) await verifyContainer(peer, checkedPublic)
    },
  }
}
