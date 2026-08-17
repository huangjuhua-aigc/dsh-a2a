/**
 * Plugin configuration schema.
 *
 * Every credential-shaped field carries a REFERENCE name resolved through
 * `ctx.credentials`, never a value — the doctrine `dsh-credentials` states as
 * "configuration carries references to secrets, never the secrets". A pasted
 * token fails the POSIX-identifier check at load rather than silently becoming
 * a reference nobody stored.
 *
 * @module dsh-a2a/config
 */

import Schema from '@deepseek-ai/schemastery'

/** A credential reference name: the shape `ctx.credentials` addresses. */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A peer name: also the workspace directory component, so no separators. */
const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** One authenticated peer and where its credential lives. */
export interface PeerConfig {
  /** Credential reference name, NOT the token itself. */
  tokenEnv: string
}

/** How peers are kept from reaching each other. */
export interface IsolationConfig {
  /**
   * `per-peer` gives each identity its own cwd, which also makes the existing
   * cwd-equality authority in cross-session tooling isolate them for free.
   * `shared` is the collaborative posture and must be chosen deliberately.
   */
  workspaceMode: 'per-peer' | 'shared'
  /** Parent directory in `per-peer` mode; the common cwd in `shared` mode. */
  workspaceRoot: string
  /** Per-peer cwd overrides, e.g. pointing one trusted peer at a real repo. */
  peerWorkspaces: Record<string, string>
  /** Model-facing tools an A2A agent may never call. Additive only. */
  deniedTools: string[]
  /** Single-peer escape hatch for the cross-session search denial. */
  unsafeAllowCrossSessionSearch: boolean
}

/** Agent Card content and exposure. */
export interface CardConfig {
  name: string
  description: string
  /** Serve the card without a credential, as discovery expects. */
  public: boolean
  skills: { id: string; name: string; description: string; tags: string[] }[]
  provider?: { organization: string; url: string }
}

/** Terminal-state webhook callbacks — the only egress this plugin makes. */
export interface PushConfig {
  enabled: boolean
  allowPrivateNetworkCallbacks: boolean
  allowInsecureCallbacks: boolean
  requestTimeoutMs: number
}

/** The whole plugin configuration. */
export interface A2AServerConfig {
  basePath: string
  publicUrl?: string
  protocolVersion: string
  /**
   * Provider route for every agent this server creates. Optional so another
   * `agent/request` listener may supply the target instead; a runnable
   * composition needs one of the two.
   */
  provider?: string
  /** Model for every agent this server creates. */
  model?: string
  card: CardConfig
  peers: Record<string, PeerConfig>
  trustedPeers?: string[]
  rateLimitPerMinute: number
  maxContextTurns: number
  sendMode: 'block' | 'immediate'
  blockTimeoutMs: number
  taskTimeoutMs: number
  contextIdleTtlMs: number
  maxResidentContexts: number
  streamGranularity: 'message' | 'chunk'
  isolation: IsolationConfig
  push: PushConfig
}

/** Tools that can read another session; denied for A2A agents by default. */
export const DEFAULT_DENIED_TOOLS: readonly string[] = [
  'session_search',
  'session_event_search',
  'session_trace',
  'session_event_trace',
  'session_event_read',
  'list_agents',
]

export const Config: Schema<A2AServerConfig> = Schema.object({
  basePath: Schema.string().default('/a2a'),
  publicUrl: Schema.string(),
  protocolVersion: Schema.string().default('0.3.0'),
  provider: Schema.string(),
  model: Schema.string(),

  card: Schema.object({
    name: Schema.string().default('dsh-harness'),
    description: Schema.string().default('A DeepSeek Harness agent reachable over A2A.'),
    public: Schema.boolean().default(true),
    skills: Schema.array(Schema.object({
      id: Schema.string().required(),
      name: Schema.string().required(),
      description: Schema.string().default(''),
      tags: Schema.array(Schema.string()).default([]),
    })).default([]),
    // Both members default rather than being required: schemastery instantiates
    // a nested object even when the deployment omits it, so a `required()` here
    // would make an absent `provider` a validation failure.
    provider: Schema.object({
      organization: Schema.string().default(''),
      url: Schema.string().default(''),
    }),
  }),

  peers: Schema.dict(Schema.object({
    tokenEnv: Schema.string().required(),
  })).default({}),
  trustedPeers: Schema.array(Schema.string()),
  rateLimitPerMinute: Schema.natural().default(60),
  maxContextTurns: Schema.natural().default(5),

  sendMode: Schema.union(['block', 'immediate'] as const).default('block'),
  blockTimeoutMs: Schema.natural().default(60_000),
  taskTimeoutMs: Schema.natural().default(900_000),
  contextIdleTtlMs: Schema.natural().default(1_800_000),
  maxResidentContexts: Schema.natural().default(64),
  streamGranularity: Schema.union(['message', 'chunk'] as const).default('message'),

  isolation: Schema.object({
    workspaceMode: Schema.union(['per-peer', 'shared'] as const).default('per-peer'),
    workspaceRoot: Schema.string().required(),
    peerWorkspaces: Schema.dict(Schema.string()).default({}),
    deniedTools: Schema.array(Schema.string()).default([...DEFAULT_DENIED_TOOLS]),
    unsafeAllowCrossSessionSearch: Schema.boolean().default(false),
  }).required(),

  push: Schema.object({
    enabled: Schema.boolean().default(false),
    allowPrivateNetworkCallbacks: Schema.boolean().default(false),
    allowInsecureCallbacks: Schema.boolean().default(false),
    requestTimeoutMs: Schema.natural().default(10_000),
  }),
})

/** A configuration mistake found before anything starts serving. */
export class A2AConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'A2AConfigError'
  }
}

/**
 * Check the config's cross-field rules that a schema cannot express.
 *
 * Every failure here is a misconfiguration that would otherwise surface as a
 * peer mysteriously receiving 401 forever, or as a workspace path escaping its
 * root — both far worse than refusing to load.
 * @param config - the validated configuration.
 * @throws {A2AConfigError} when a peer name, credential reference, or path is unusable.
 */
export function assertConfigCoherent(config: A2AServerConfig): void {
  for (const [peer, entry] of Object.entries(config.peers)) {
    if (!PEER_NAME.test(peer)) {
      throw new A2AConfigError(
        `peer name "${peer}" must match ${String(PEER_NAME)}: it becomes a workspace directory component`,
      )
    }
    if (!CREDENTIAL_REF.test(entry.tokenEnv)) {
      throw new A2AConfigError(
        `peers.${peer}.tokenEnv must be a credential REFERENCE name (${String(CREDENTIAL_REF)}), not a token value`,
      )
    }
  }
  for (const trusted of config.trustedPeers ?? []) {
    if (!(trusted in config.peers)) {
      throw new A2AConfigError(`trustedPeers names "${trusted}", which is not declared in peers`)
    }
  }
  for (const peer of Object.keys(config.isolation.peerWorkspaces)) {
    if (!(peer in config.peers)) {
      throw new A2AConfigError(
        `isolation.peerWorkspaces names "${peer}", which is not declared in peers`,
      )
    }
  }
  if (!config.basePath.startsWith('/')) {
    throw new A2AConfigError(`basePath must start with "/": ${config.basePath}`)
  }
}
