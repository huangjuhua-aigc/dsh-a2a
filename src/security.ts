/**
 * Authentication, rate limiting, inbound defanging, and outbound redaction.
 *
 * The real security boundary is not in this file: it is the sandbox scope and
 * the deterministically-rejected approval an A2A agent runs under. Injection
 * defanging here is noise reduction, and must never be cited as a reason to
 * widen what a peer-driven agent is allowed to do.
 *
 * @module dsh-a2a/security
 */

import { timingSafeEqual } from 'node:crypto'

/** Who a request is from. The value comes only from the presented credential. */
export type PeerIdentity = string

/**
 * Compare two secrets without leaking their relationship through timing.
 * @param a - the presented value.
 * @param b - the stored value.
 * @returns whether they are byte-identical.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // timingSafeEqual requires equal lengths; comparing a digest of each keeps the
  // length difference from short-circuiting before the comparison happens.
  if (left.length !== right.length) {
    // Still burn a comparison so a length mismatch is not measurably faster.
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

/**
 * Extract the bearer token from an Authorization header.
 * @param header - the raw header value, if any.
 * @returns the token, or undefined when absent or not a bearer scheme.
 */
export function parseBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]
}

/**
 * Resolve the presented token to a declared peer identity.
 *
 * Every candidate is compared even after a match, so response time does not
 * reveal which peer matched or how many peers are declared.
 * @param token - the presented bearer token, if any.
 * @param credentials - declared peer name to its resolved secret.
 * @returns the matched identity, or undefined.
 */
export function identifyPeer(
  token: string | undefined,
  credentials: ReadonlyMap<PeerIdentity, string>,
): PeerIdentity | undefined {
  if (token === undefined || token.length === 0) return undefined
  let matched: PeerIdentity | undefined
  for (const [peer, secret] of credentials) {
    if (constantTimeEqual(token, secret) && matched === undefined) matched = peer
  }
  return matched
}

/** Sliding-window request counter, keyed by authenticated identity. */
export class RateLimiter {
  private readonly hits = new Map<PeerIdentity, number[]>()

  /**
   * @param perMinute - allowed requests per identity per rolling minute.
   * @param now - clock injection point for tests.
   */
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record a request and report whether it is within budget.
   * @param identity - the authenticated peer.
   * @returns true when the request may proceed.
   */
  allow(identity: PeerIdentity): boolean {
    const cutoff = this.now() - 60_000
    const window = (this.hits.get(identity) ?? []).filter(at => at > cutoff)
    if (window.length >= this.perMinute) {
      this.hits.set(identity, window)
      return false
    }
    window.push(this.now())
    this.hits.set(identity, window)
    return true
  }

  /** Drop all counters; used on teardown. */
  clear(): void {
    this.hits.clear()
  }
}

/** Per-context turn counter that stops one peer from looping a context forever. */
export class TurnTracker {
  private readonly turns = new Map<string, number>()

  /**
   * Count one inbound message on a context.
   * @param contextId - the context being extended.
   * @returns the turn number this message occupies, starting at 1.
   */
  track(contextId: string): number {
    const next = (this.turns.get(contextId) ?? 0) + 1
    this.turns.set(contextId, next)
    return next
  }

  /**
   * Reset a context's counter, as an explicit cancellation should.
   * @param contextId - the context to reset.
   */
  reset(contextId: string): void {
    this.turns.delete(contextId)
  }

  /** Drop all counters; used on teardown. */
  clear(): void {
    this.turns.clear()
  }
}

/**
 * Markers an adversarial peer might embed to hijack the agent's turn.
 *
 * These are neutralized rather than rejected: a legitimate task that merely
 * MENTIONS one still gets through, with the marker defanged.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /<\|im_(start|end)\|>/gi,
  /<\|(system|user|assistant|end|endoftext)\|>/gi,
  /\[\/?(?:INST|SYS|SYSTEM)\]/gi,
  /^\s*(system|assistant|developer)\s*:\s*/gim,
  /ignore (?:all|any|the) (?:previous|prior|above) instructions/gi,
  /disregard (?:all|any|the) (?:previous|prior|above)/gi,
  /<\/?(?:system|assistant|tool)[^>]*>/gi,
]

/** What a defanged marker is replaced with. */
export const FILTERED = '[filtered]'

/**
 * Defang prompt-injection markers in inbound task text.
 * @param text - the peer's raw text.
 * @returns the text with markers replaced.
 */
export function filterInbound(text: string): string {
  let out = text
  for (const pattern of INJECTION_PATTERNS) out = out.replace(pattern, FILTERED)
  return out
}

/** Credential-shaped strings that must never reach a peer. */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, 'sk-ant-[redacted]'],
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]'],
  [/ghp_[A-Za-z0-9]{20,}/g, 'ghp_[redacted]'],
  [/xox[bapr]-[A-Za-z0-9-]{10,}/g, 'xox-[redacted]'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA[redacted]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-jwt]'],
  [/(?<=\b)[Bb]earer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer [redacted]'],
]

/**
 * A UTF-16 code unit that is half of a surrogate pair with no other half.
 *
 * Either a high surrogate not followed by a low one, or a low surrogate not
 * preceded by a high one. Such a string is not valid Unicode and cannot be
 * encoded to UTF-8.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * Replace lone surrogates so the text can be encoded as UTF-8.
 *
 * DEFENSIVE, against a defect upstream of this plugin: the model streaming path
 * can hand us text whose multi-byte characters were decoded across a chunk
 * boundary, leaving orphan bytes as lone surrogates (a split `议`, U+8BAE =
 * `E8 AE AE`, leaves `\uDCAE`). Non-ASCII replies — Chinese, Japanese, emoji —
 * are where this shows, and it is invisible in a terminal.
 *
 * A transport must not put that on the wire. `JSON.stringify` will happily emit
 * `"\udcae"`, which is legal JSON *syntax* but decodes to a string a peer
 * cannot then encode: Python's `json.loads` accepts it and the result raises on
 * `.encode('utf-8')`, and Go and Rust decoders reject or mangle it. Replacing
 * with U+FFFD is what the byte serializer would do anyway, so nothing on the
 * wire changes — the difference is that the JSON now carries a valid string
 * instead of an escape that detonates in the peer's decoder.
 *
 * Equivalent to ES2024's `String.prototype.toWellFormed()`, spelled out because
 * this package compiles against `lib: ES2023`.
 *
 * Remove this once the upstream streaming decoder is chunk-safe; until then the
 * marker is deliberate, because a lone surrogate means a character WAS lost and
 * silently deleting the evidence is worse than showing it.
 * @param text - the text about to be sent.
 * @returns the same text, valid Unicode.
 */
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '�')
}

/**
 * Make model-authored text safe to send to a peer.
 *
 * Two guarantees, both at the LAST point before text leaves the process:
 * no credential-shaped substring, and no code unit that cannot be encoded.
 * They live in one function because there is one outbound text path, and a
 * future second path must not be able to pick up only half of this.
 *
 * This applies to REPLIES, not just to a hypothetical outbound client: an
 * inbound-only server still ships model-authored text to a peer.
 * @param text - the text about to be sent.
 * @returns the scrubbed text.
 */
export function redactOutbound(text: string): string {
  let out = wellFormed(text)
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}
