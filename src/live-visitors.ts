/** Additive, owner-only admissions. Portal persists the configuration before calling IPC. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { constantTimeEqual } from './security.ts'

const inputSchema = z.object({
  // Portal-issued IDs cannot collide with owner/public identities or filesystem names.
  name: z.string().regex(/^visitor-[a-f0-9]{24}$/),
  token: z.string().min(16).max(512).regex(/^[A-Za-z0-9._~+\/-]+=*$/),
  trusted: z.boolean(),
}).strict()
export class VisitorAdmissionError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export interface LiveVisitor { name: string; trusted: boolean }
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** Only hashes are retained; additions never replace an existing visitor or change its rights. */
export class LiveVisitors {
  private readonly entries = new Map<string, LiveVisitor & { hash: string }>()
  constructor(private readonly configured: ReadonlySet<string>, private readonly trusted?: readonly string[]) {}

  identify(token: string | undefined): LiveVisitor | undefined {
    if (!token) return undefined
    const tokenHash = hash(token)
    const entry = [...this.entries.values()].find(row => row.hash === tokenHash)
    return entry ? { name: entry.name, trusted: entry.trusted } : undefined
  }

  add(input: unknown, secrets: ReadonlyMap<string, string>, owner?: string, publicIdentity = false): { name: string; applied: true } {
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) throw new VisitorAdmissionError(400, 'Invalid visitor admission')
    const { name, token, trusted } = parsed.data
    const tokenHash = hash(token)
    if (publicIdentity || owner && constantTimeEqual(owner, token)
      || [...secrets].some(([peer, secret]) => peer !== name && constantTimeEqual(secret, token))
      || [...this.entries.values()].some(row => row.name !== name && row.hash === tokenHash)) {
      throw new VisitorAdmissionError(409, 'Visitor credential is already assigned')
    }
    const existing = this.entries.get(name)
    if (existing) {
      if (existing.hash !== tokenHash || existing.trusted !== trusted) throw new VisitorAdmissionError(409, 'Visitor identity is already assigned')
    } else if (this.configured.has(name)) {
      if (!secrets.has(name) || !constantTimeEqual(secrets.get(name)!, token) || (this.trusted === undefined || this.trusted.includes(name)) !== trusted) {
        throw new VisitorAdmissionError(409, 'Visitor identity is already configured')
      }
    } else {
      if ([...this.configured].some(peer => peer.toLowerCase() === name)) throw new VisitorAdmissionError(409, 'Visitor identity is already configured')
      if (this.entries.size >= 1000) throw new VisitorAdmissionError(429, 'Live visitor capacity reached')
      this.entries.set(name, { name, trusted, hash: tokenHash })
    }
    return { name, applied: true }
  }
}
