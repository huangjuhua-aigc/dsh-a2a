/** Public admission still issues a private, durable identity for every client. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { A2ARpcError, ERR_INVALID_REQUEST } from './protocol/jsonrpc.ts'

export const REGISTER_PUBLIC_VISITOR = 'talk2myagent/RegisterPublicVisitor'
export const PUBLIC_VISITOR_STATUS = 'talk2myagent/GetPublicVisitorStatus'
export const PUBLIC_VISITOR_TURNS = 5
export const PUBLIC_VISITOR_DOMAIN = 'talk2myagent'
/** Optional extension errors use our domain, not the A2A standard's namespace. */
export class PublicVisitorError extends A2ARpcError {
  override get data(): unknown[] {
    return [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', domain: PUBLIC_VISITOR_DOMAIN,
      reason: this.options.reason, metadata: { version: '1', requestAccepted: 'false', ...this.options.metadata } }]
  }
}
export const publicVisitorError = (reason: string, message: string, status: number, metadata: Record<string, string> = {}): PublicVisitorError =>
  new PublicVisitorError(ERR_INVALID_REQUEST, message, { reason, httpStatus: status, metadata })
const MAX_VISITORS = 1000, REGISTRATIONS_PER_HOUR = 20
const row = z.object({ id: z.string().regex(/^public-[a-f0-9]{32}$/), hash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(), used: z.number().int().min(0).max(PUBLIC_VISITOR_TURNS) }).strict()
type Visitor = z.infer<typeof row>
const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Uses the enclosing StateStore process lock; never share its directory between processes. */
export class PublicVisitors {
  private rows: Visitor[] = []
  private readonly file: string
  constructor(directory: string, private readonly options?: { enabled: boolean; settingsFile?: string }) {
    this.file = join(directory, 'public-visitors.json')
    try {
      if (statSync(this.file).size > 400_000) throw new Error('Public visitor registry exceeds capacity')
      this.rows = z.array(row).max(MAX_VISITORS).parse(JSON.parse(readFileSync(this.file, 'utf8')))
      if (new Set(this.rows.map(v => v.id)).size !== this.rows.length || new Set(this.rows.map(v => v.hash)).size !== this.rows.length) throw new Error('Duplicate public visitor identity')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  enabled(): boolean {
    if (!this.options?.settingsFile) return this.options?.enabled === true
    try {
      if (statSync(this.options.settingsFile).size > 1024) return false
      return JSON.parse(readFileSync(this.options.settingsFile, 'utf8')).enabled === true
    } catch { return false } // Missing or malformed settings always close public admission.
  }
  private save(next: Visitor[]): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try { writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 }); renameSync(temporary, this.file) }
    finally { rmSync(temporary, { force: true }) }
    this.rows = next
  }
  register(): { visitorId: string; token: string; turnLimit: number; remainingTurns: number } {
    if (!this.enabled()) throw publicVisitorError('INVITATION_REQUIRED', 'Public visitors are disabled; contact the agent owner for access', 403, { nextAction: 'contact_owner' })
    if (this.rows.length >= MAX_VISITORS) throw publicVisitorError('PUBLIC_VISITOR_CAPACITY_REACHED', 'Public visitor capacity reached', 429, { nextAction: 'contact_owner' })
    const now = Date.now()
    if (this.rows.filter(v => v.createdAt > now - 3_600_000).length >= REGISTRATIONS_PER_HOUR) throw publicVisitorError('PUBLIC_VISITOR_REGISTRATION_RATE_LIMITED', 'Public visitor registration rate exceeded', 429)
    const token = randomBytes(32).toString('hex'), id = `public-${randomBytes(16).toString('hex')}`
    this.save([...this.rows, { id, hash: hash(token), createdAt: now, used: 0 }])
    return { visitorId: id, token, turnLimit: PUBLIC_VISITOR_TURNS, remainingTurns: PUBLIC_VISITOR_TURNS }
  }
  identify(token: string | undefined): string | undefined {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined
    const digest = hash(token)
    return this.rows.find(v => v.hash === digest)?.id
  }
  owns(peer: string): boolean { return this.rows.some(v => v.id === peer) }
  status(peer: string): { visitorId: string; turnLimit: number; remainingTurns: number } {
    const visitor = this.rows.find(v => v.id === peer)
    if (!visitor) throw publicVisitorError('INVALID_TOKEN', 'Unknown public visitor', 401)
    return { visitorId: peer, turnLimit: PUBLIC_VISITOR_TURNS, remainingTurns: PUBLIC_VISITOR_TURNS - visitor.used }
  }
  assertQuota(peer: string): void {
    if (!this.owns(peer)) return
    if (!this.enabled()) throw publicVisitorError('INVITATION_REQUIRED', 'Public visitors are disabled; contact the agent owner for access', 403, { nextAction: 'contact_owner' })
    if (this.status(peer).remainingTurns === 0) throw publicVisitorError('PUBLIC_VISITOR_QUOTA_EXHAUSTED',
      'Public visitor quota exhausted (5/5); contact the agent owner for access', 429,
      { turnLimit: String(PUBLIC_VISITOR_TURNS), usedTurns: String(PUBLIC_VISITOR_TURNS), remainingTurns: '0', nextAction: 'contact_owner', retryable: 'false' })
  }
  charge(peer: string): void {
    if (!this.owns(peer)) return
    this.assertQuota(peer)
    // Commit synchronously before model work; concurrent contexts cannot spend a sixth turn.
    this.save(this.rows.map(v => v.id === peer ? { ...v, used: v.used + 1 } : v))
  }
}
