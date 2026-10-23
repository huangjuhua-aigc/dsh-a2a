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

/**
 * How peers are kept from reaching each other.
 *
 * DEFERRED — a tool deny-list (`session_search`, `session_event_search`,
 * `session_trace`, `session_event_trace`, `session_event_read`, `list_agents`)
 * plus a named `unsafeAllowCrossSessionSearch` escape hatch for single-peer
 * deployments. Both were designed as defense in depth behind `workspaceMode`,
 * and neither is declared here until it is enforced: a security knob that
 * silently does nothing is worse than no knob at all.
 */
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
  /** Paths relative to the peer workspace (absolute paths pass through). */
  files: string[]
}

/** Local-only monitoring surface credentials. */
export interface AdminConfig {
  /**
   * Credential REFERENCE name holding the admin token, NOT the token itself.
   * Empty or absent means the monitoring surface stays unmounted.
   */
  tokenEnv: string
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
  isolation: IsolationConfig
  preamble: PreambleConfig
  /**
   * When set, a loopback-only read-only monitoring endpoint is served under
   * `{basePath}/admin/`. Absent means no admin surface at all.
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
 * - `taskTimeoutMs` — the orphan-task watchdog that would fail a task stuck
 *   non-terminal. Nothing sweeps for those yet.
 *
 * Both were in the design; neither is wired. They return with their code.
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
  trustedPeers: Schema.array(Schema.string()),
  rateLimitPerMinute: Schema.natural().default(60),
  maxContextTurns: Schema.natural().default(5),

  sendMode: Schema.union(['block', 'immediate'] as const).default('block'),
  blockTimeoutMs: Schema.natural().default(60_000),
  contextIdleTtlMs: Schema.natural().default(1_800_000),
  maxResidentContexts: Schema.natural().default(64),

  isolation: Schema.object({
    workspaceMode: Schema.union(['per-peer', 'shared'] as const).default('per-peer'),
    workspaceRoot: Schema.string().required(),
    peerWorkspaces: Schema.dict(Schema.string()).default({}),
  }).required(),

  preamble: Schema.object({
    files: Schema.array(Schema.string()).default(['.hop/handoff.md']),
  }),

  // Schemastery instantiates a nested object even when the deployment omits
  // it, so `required()` here would make every admin-less config fail at load.
  // An empty tokenEnv instead reads as "not configured", and the coherence
  // check below is what keeps a non-empty one a valid REFERENCE name.
  admin: Schema.object({
    tokenEnv: Schema.string().default(''),
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
