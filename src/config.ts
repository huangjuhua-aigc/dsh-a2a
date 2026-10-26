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
import { isAbsolute } from 'node:path'

/** A credential reference name: the shape `ctx.credentials` addresses. */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A peer name: also the workspace directory component, so no separators. */
const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** One authenticated peer and where its credential lives. */
export interface PeerConfig {
  /** Credential reference name, NOT the token itself. */
  tokenEnv: string
}

/** Working directories and the data roots exposed through the scoped reader. */
export interface IsolationConfig {
  /**
   * `per-peer` gives each identity its own cwd. Neither mode is a filesystem
   * security boundary. read_file enforces its own canonical data-root boundary.
   */
  workspaceMode: 'per-peer' | 'shared'
  /** Shared read-only data root; also the cwd parent in `per-peer` mode. */
  workspaceRoot: string
  /** Overrides both a peer's cwd and its authorized read root. */
  peerWorkspaces: Record<string, string>
}

/** One declared skill, as it appears on the Agent Card. */
export interface SkillConfig {
  id: string
  name: string
  description: string
  tags: string[]
}

/** Agent Card content and exposure. */
export interface CardConfig {
  name: string
  description: string
  /** Serve the card without a credential, as discovery expects. */
  public: boolean
  skills: SkillConfig[]
  /**
   * Skills revealed only through `GetExtendedAgentCard`, after a peer has
   * authenticated. Declaring any turns on `capabilities.extendedAgentCard`;
   * leaving this empty means the deployment has no extended card, and the
   * method answers with the spec's own ExtendedAgentCardNotConfiguredError.
   */
  extendedSkills: SkillConfig[]
  provider?: { organization: string; url: string }
}

/**
 * Terminal-state webhook callbacks.
 *
 * Only `enabled` exists so far, and only to answer the push methods with the
 * spec's own `PushNotificationNotSupported` and to keep the Agent Card honest.
 *
 * DEFERRED — the sender itself, plus its SSRF fence
 * (`allowPrivateNetworkCallbacks`, `allowInsecureCallbacks`) and
 * `requestTimeoutMs`. Those knobs arrive with the code that honors them; a
 * deployment must not be able to set `allowPrivateNetworkCallbacks: false` and
 * believe something is enforcing it.
 */
export interface PushConfig {
  /**
   * Reserved. Turning this on today only changes which error the push methods
   * return, so it stays documented as unimplemented.
   */
  enabled: boolean
}

/**
 * The host's background briefing, injected when a visitor's context opens.
 *
 * The files are read once per Activation (best effort: an absent file is the
 * normal "nothing to hand over" case) and merged into the context's FIRST
 * visitor message rather than sent as their own turn — one model call is
 * spared, and the turn counters stay about the visitor's messages only.
 */
export interface PreambleConfig {
  /** Publication-safe paths relative to the workspace root; absolute paths pass through. */
  files: string[]
}

/** Local-only monitoring surface credentials. */
export interface AdminConfig {
  /**
   * Credential REFERENCE name holding the admin token, NOT the token itself.
   * Empty or absent means the monitoring surface stays unmounted.
   */
  tokenEnv: string
  /** Local named pipe / Unix socket. Never served on the public HTTP carrier. */
  socketPath?: string
}

/** The whole plugin configuration. */
export interface A2AServerConfig {
  basePath: string
  publicUrl?: string
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
  contextIdleTtlMs: number
  maxResidentContexts: number
  maxConcurrentTasks: number
  maxConcurrentTasksPerPeer: number
  maxTasksPerPeerPerDay: number
  taskTimeoutMs: number
  maxModelCallsPerTask: number
  maxOutputTokens: number
  maxInputChars: number
  maxOutputChars: number
  streamHeartbeatMs: number
  maxStreamsPerTask: number
  maxStreamBufferBytes: number
  storage: { directory?: string; retentionMs: number; maxContexts: number; maxContextBytes: number }
  isolation: IsolationConfig
  preamble: PreambleConfig
  /** Optional Portal-managed automatic updates; omission leaves the transport inert. */
  briefing?: { settingsFile: string; prompt: string }
  /**
   * Enables owner RPC and monitoring on private local IPC, never public HTTP.
   */
  admin?: AdminConfig
  push: PushConfig
}

/*
 * DEFERRED configuration, removed rather than left inert:
 *
 * - `streamGranularity: 'message' | 'chunk'` — streaming currently emits only
 *   committed assistant messages. The `chunk` mode needs an `assistant/chunk`
 *   subscription and a decision about retried text reaching a peer.
 * This option returns with its implementation.
 */

export const Config: Schema<A2AServerConfig> = Schema.object({
  basePath: Schema.string().default('/a2a'),
  publicUrl: Schema.string(),
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
    extendedSkills: Schema.array(Schema.object({
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
  // An array schema implicitly defaults to []; the wrapper preserves omission.
  trustedPeers: Schema.union([Schema.array(Schema.string())]),
  rateLimitPerMinute: Schema.natural().default(60),
  maxContextTurns: Schema.natural().default(5),

  sendMode: Schema.union(['block', 'immediate'] as const).default('block'),
  blockTimeoutMs: Schema.natural().default(60_000),
  contextIdleTtlMs: Schema.natural().default(1_800_000),
  maxResidentContexts: Schema.natural().default(64),
  maxConcurrentTasks: Schema.natural().default(8),
  maxConcurrentTasksPerPeer: Schema.natural().default(2),
  maxTasksPerPeerPerDay: Schema.natural().default(200),
  taskTimeoutMs: Schema.natural().default(120_000),
  maxModelCallsPerTask: Schema.natural().default(8),
  maxOutputTokens: Schema.natural().default(4096),
  maxInputChars: Schema.natural().default(32_000),
  maxOutputChars: Schema.natural().default(64_000),
  streamHeartbeatMs: Schema.natural().default(15_000),
  maxStreamsPerTask: Schema.natural().default(4),
  maxStreamBufferBytes: Schema.natural().default(262_144),
  storage: Schema.object({
    directory: Schema.string(),
    retentionMs: Schema.natural().default(86_400_000),
    maxContexts: Schema.natural().default(256),
    maxContextBytes: Schema.natural().default(4_000_000),
  }),

  isolation: Schema.object({
    workspaceMode: Schema.union(['per-peer', 'shared'] as const).default('per-peer'),
    workspaceRoot: Schema.string().required(),
    peerWorkspaces: Schema.dict(Schema.string()).default({}),
  }).required(),

  preamble: Schema.object({
    files: Schema.array(Schema.string()).default(['.hop/handoff.md']),
  }),

  briefing: Schema.object({
    settingsFile: Schema.string().default(''),
    prompt: Schema.string().default(''),
  }),

  // Schemastery instantiates a nested object even when the deployment omits
  // it, so `required()` here would make every admin-less config fail at load.
  // An empty tokenEnv instead reads as "not configured", and the coherence
  // check below is what keeps a non-empty one a valid REFERENCE name.
  admin: Schema.object({
    tokenEnv: Schema.string().default(''),
    socketPath: Schema.string(),
  }),

  push: Schema.object({
    enabled: Schema.boolean().default(false),
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
  if (config.briefing?.prompt || config.briefing?.settingsFile) {
    if (!config.admin?.tokenEnv || !config.briefing.prompt.trim() || !isAbsolute(config.briefing.settingsFile)) {
      throw new A2AConfigError('automatic briefing requires owner administration, a prompt, and an absolute settingsFile')
    }
  }
  for (const key of ['maxResidentContexts', 'maxConcurrentTasks', 'maxConcurrentTasksPerPeer',
    'maxTasksPerPeerPerDay', 'taskTimeoutMs', 'maxModelCallsPerTask', 'maxOutputTokens',
    'maxInputChars', 'maxOutputChars', 'streamHeartbeatMs', 'maxStreamsPerTask',
    'maxStreamBufferBytes'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new A2AConfigError(`${key} must be positive`)
  }
  for (const [key, value] of Object.entries(config.storage)) {
    if (key !== 'directory' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
      throw new A2AConfigError(`storage.${key} must be positive`)
    }
  }
  if (config.publicUrl !== undefined) {
    const url = new URL(config.publicUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new A2AConfigError('publicUrl must be an HTTP(S) RPC URL without credentials, query, or fragment')
    }
  }
  for (const [peer, entry] of Object.entries(config.peers)) {
    if (peer === 'owner') {
      throw new A2AConfigError('peer name "owner" is reserved for the deployment owner (the local console)')
    }
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
  const adminTokenEnv = config.admin === undefined
    || typeof config.admin.tokenEnv !== 'string'
    || config.admin.tokenEnv.length === 0
    ? undefined
    : config.admin.tokenEnv
  if (adminTokenEnv !== undefined && !CREDENTIAL_REF.test(adminTokenEnv)) {
    throw new A2AConfigError(
      `admin.tokenEnv must be a credential REFERENCE name (${String(CREDENTIAL_REF)}), not a token value`,
    )
  }
  if (!config.basePath.startsWith('/')) {
    throw new A2AConfigError(`basePath must start with "/": ${config.basePath}`)
  }
}
