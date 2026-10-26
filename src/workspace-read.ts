/** A single read capability rooted in the owner's configured data directory. */
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

export const WORKSPACE_READ_TOOL = 'read_file'
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TEXT_CHARS = 32_000
const MAX_DIRECTORY_SCAN = 1000
const argsSchema = z.object({
  path: z.string().min(1).max(4096),
  offset: z.number().int().min(1).max(10_000_000).default(1),
  limit: z.number().int().min(1).max(500).default(200),
}).strict()

function within(root: string, target: string): boolean {
  const suffix = relative(root, target)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

/**
 * Pin a canonical root for this activation. Never mount the host's general read
 * tool: its path policy is different. State directories remain private even
 * when an operator puts them inside the shared data root.
 */
export async function workspaceReadTool(directory: string, privateDirectories: readonly string[]): Promise<ToolDefinition> {
  const configuredRoot = resolve(directory)
  const root = await realpath(directory)
  const privatePaths = await Promise.all(privateDirectories.map(async path => {
    const absolute = resolve(path)
    return { absolute, canonical: await realpath(absolute).catch(() => absolute) }
  }))
  const isPrivate = (path: string): boolean => privatePaths.some(p => within(p.absolute, path) || within(p.canonical, path))

  const validatePath = async (input: string): Promise<string> => {
    if (input.includes('\0')) throw new Error('Invalid file path')
    // Reject NT device namespaces and alternate data streams before normalization.
    if (process.platform === 'win32' && (/^[/\\]{2}[?.][/\\]/.test(input) || input.replace(/^[a-z]:/i, '').includes(':'))) {
      throw new Error('Device paths and alternate data streams are not available')
    }
    const absolute = resolve(root, input)
    // Windows may return an expanded path for a configured 8.3 directory alias.
    const candidate = isAbsolute(input) && within(configuredRoot, absolute)
      ? resolve(root, relative(configuredRoot, absolute)) : absolute
    if (!within(root, candidate) || isPrivate(candidate)) throw new Error('Path is outside the authorized data directory')
    const canonical = await realpath(candidate)
    if (!within(root, canonical) || isPrivate(canonical)) throw new Error('Path is outside the authorized data directory')
    // Refuse links/junctions along the entire relative path, even when a link
    // currently targets this root. An authorized directory is not a link portal.
    let current = root
    for (const component of ['', ...relative(root, candidate).split(sep).filter(Boolean)]) {
      if (component) current = join(current, component)
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links and junctions are not available')
    }
    return candidate
  }

  return {
    name: WORKSPACE_READ_TOOL,
    description: 'Read a UTF-8 text file from the owner-authorized data directory. Paths are relative to that directory (not the agent cwd); absolute paths must remain inside it. Use path "." to list its entries, or a subdirectory path to list that directory. offset is a 1-based line/entry offset; limit is at most 500. Other tools and writes are unavailable.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096 },
        offset: { type: 'integer', minimum: 1, maximum: 10_000_000 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
    },
    output: {
      schema: { type: 'object', required: ['kind', 'path', 'content', 'truncated'], properties: {
        kind: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, truncated: { type: 'boolean' },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (raw, { signal }) => {
      const args = argsSchema.parse(raw)
      signal.throwIfAborted()
      const path = await validatePath(args.path)
      const before = await lstat(path)
      if (before.isDirectory()) {
        const entries: string[] = []
        let scanned = 0
        let truncated = false
        // Read at most a bounded prefix; do not build an unbounded directory tree.
        const dir = await opendir(path)
        for await (const entry of dir) {
          signal.throwIfAborted()
          if (++scanned > MAX_DIRECTORY_SCAN) { truncated = true; break }
          if (entry.isSymbolicLink() || isPrivate(join(path, entry.name))) continue
          if (!entry.isFile() && !entry.isDirectory()) continue
          entries.push(`${entry.name}${entry.isDirectory() ? '/' : ''}`)
        }
        const after = await lstat(await validatePath(args.path))
        if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Directory changed during read; retry')
        entries.sort()
        const selected = entries.slice(args.offset - 1, args.offset - 1 + args.limit).join('\n')
        return { kind: 'directory', path: relative(root, path) || '.', content: selected.slice(0, MAX_TEXT_CHARS),
          truncated: truncated || entries.length > args.offset - 1 + args.limit || selected.length > MAX_TEXT_CHARS }
      }
      if (!before.isFile()) throw new Error('Only regular text files and directories can be read')
      if (before.nlink > 1) throw new Error('Hard-linked files are not available')
      if (before.size > MAX_FILE_BYTES) throw new Error('File exceeds the 2 MiB read limit')
      // O_NOFOLLOW is supported on Unix. Windows is covered by the component
      // checks and comparing the opened file's identity before reading any bytes.
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.nlink > 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('File changed during open; retry')
        if (opened.size > MAX_FILE_BYTES) throw new Error('File exceeds the 2 MiB read limit')
        await validatePath(args.path)
        // Explicit byte limit also bounds reads if a local writer grows the file.
        const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
        let used = 0
        while (used < bytes.length) {
          signal.throwIfAborted()
          const part = await handle.read(bytes, used, bytes.length - used, used)
          if (!part.bytesRead) break
          used += part.bytesRead
        }
        if (used > MAX_FILE_BYTES) throw new Error('File exceeds the 2 MiB read limit')
        const after = await lstat(await validatePath(args.path))
        if (opened.dev !== after.dev || opened.ino !== after.ino || after.nlink > 1) throw new Error('File changed during read; retry')
        signal.throwIfAborted()
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))
        if (content.includes('\0')) throw new Error('Binary files are not supported by read_file')
        const lines = content.split(/\r?\n/)
        const selected = lines.slice(args.offset - 1, args.offset - 1 + args.limit).join('\n')
        return { kind: 'file', path: relative(root, path), content: selected.slice(0, MAX_TEXT_CHARS),
          truncated: lines.length > args.offset - 1 + args.limit || selected.length > MAX_TEXT_CHARS }
      } finally { await handle.close() }
    },
  }
}
