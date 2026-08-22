/**
 * The minimal composition that makes the A2A server runnable.
 *
 * Shared by `example/serve.ts` (a real listening server you can curl) and the
 * end-to-end test, so what the test proves is what you run.
 *
 * Prerequisite services come from `dsh-agent-loop-testkit`, the same helper the
 * harness's own loop tests use, so this file stays about A2A rather than about
 * re-deriving a service mount order.
 *
 * @module dsh-a2a/example/compose
 */

import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import WebServer from '@deepseek-ai/dsh-host-webserver'

import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as A2AServer from '../src/index.ts'
import { EchoAdapter, ECHO_MODEL, ECHO_PROVIDER } from './echo-adapter.ts'
import type { A2AServerConfig } from '../src/index.ts'

/** What a booted composition hands back. */
export interface Composition {
  ctx: Context
  /** The port the HTTP carrier actually bound (0 asks the OS to choose). */
  port: number
  /** Base URL of the JSON-RPC endpoint. */
  rpcUrl: string
  /** Base URL of the Agent Card. */
  cardUrl: string
  /** The stub adapter, so a test can hold a turn open. Absent on a real model. */
  adapter: EchoAdapter
  /** Which model route the agents actually run on. */
  model: { provider: string; id: string; real: boolean }
  /** Tear the whole tree down and settle. */
  stop: () => Promise<void>
}

/** Knobs the caller varies between the demo and the tests. */
export interface ComposeOptions {
  /** Bind port; 0 lets the OS pick, which is what tests want. */
  port?: number
  /** Workspace root for per-peer directories. */
  workspaceRoot: string
  /** Peer name to credential-reference name. */
  peers: Record<string, string>
  /** Only these identities may run tasks; omit to allow every authenticated peer. */
  trustedPeers?: string[]
  /** Cap on turns per context before rejection. */
  maxContextTurns?: number
  /** Whether `SendMessage` waits for the terminal state. */
  sendMode?: 'block' | 'immediate'
  /** How long a blocking send waits before handing back a non-terminal task. */
  blockTimeoutMs?: number
  /** Share one workspace across peers instead of isolating them. */
  workspaceMode?: 'per-peer' | 'shared'
  /**
   * Use the deterministic stub instead of a real model.
   *
   * Only the test suite sets this: a real model would make assertions about
   * exact reply text meaningless and would spend tokens on every run. Running
   * the demo never falls back to the stub — a missing key is an error.
   */
  forceStub?: boolean
}

/** The credential reference the DeepSeek adapter resolves per request. */
export const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** No usable model credential, reported before anything starts serving. */
export class MissingModelCredentialError extends Error {
  constructor(readonly ref: string) {
    super(`no credential configured for ${ref}`)
    this.name = 'MissingModelCredentialError'
  }
}

/** The DeepSeek provider route and the model this demo asks for. */
const DEEPSEEK_PROVIDER = 'deepseek-official'
const DEEPSEEK_MODEL = process.env['DEEPSEEK_MODEL'] ?? 'deepseek-v4-flash'

/**
 * Boot a harness composition with the A2A server mounted.
 * @param options - composition knobs.
 * @returns the live context, bound port, endpoint URLs, and a teardown function.
 */
export async function compose(options: ComposeOptions): Promise<Composition> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new EchoAdapter()
  ctx.llm.registerAdapter([ECHO_PROVIDER], adapter)

  // `CredentialProvider` is the abstract Service Definition; only the local
  // file-backed provider is mountable. It layers the process environment over
  // `$DSH_HOME/.credentials.yaml`, which is where the demo's peer tokens live.
  await ctx.plugin(LocalCredentialProvider, {})

  // Model routing is composition policy, not something the A2A transport
  // decides — the plugin just takes provider/model from its config.
  //
  // The credential check asks the seam rather than reading process.env: a key
  // may live in the managed document, either .env layer, or the environment,
  // and `describe()` answers "is this configured" without ever holding a value.
  const useReal = options.forceStub !== true
  if (useReal) {
    await ctx.plugin(LlmDeepSeek, {})
    const info = await ctx.credentials.describe(credentialRef(DEEPSEEK_API_KEY_REF))
    if (!info.configured) {
      await ctx.fiber.dispose()
      throw new MissingModelCredentialError(DEEPSEEK_API_KEY_REF)
    }
  }
  const model = useReal
    ? { provider: DEEPSEEK_PROVIDER, id: DEEPSEEK_MODEL, real: true }
    : { provider: ECHO_PROVIDER, id: ECHO_MODEL, real: false }
  // The durable task read model: without it, GetTask cannot answer once a
  // task settles, and a polling peer never learns its result.
  await ctx.plugin(SessionProjections)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: options.port ?? 0 })

  const config: A2AServerConfig = {
    basePath: '/a2a',
    provider: model.provider,
    model: model.id,
    card: {
      name: 'dsh-a2a-demo',
      description: 'A DeepSeek Harness agent reachable over A2A.',
      public: true,
      skills: [{
        id: 'general',
        name: 'general',
        description: 'Answers questions and runs tasks.',
        tags: ['general'],
      }],
      // Declared so the demo can exercise GetExtendedAgentCard: this skill is
      // absent from the anonymous card and appears only after authentication.
      extendedSkills: [{
        id: 'internal-diagnostics',
        name: 'internal diagnostics',
        description: 'Reports harness internals. Authenticated peers only.',
        tags: ['internal'],
      }],
    },
    peers: Object.fromEntries(
      Object.entries(options.peers).map(([peer, tokenEnv]) => [peer, { tokenEnv }]),
    ),
    ...options.trustedPeers === undefined ? {} : { trustedPeers: options.trustedPeers },
    rateLimitPerMinute: 600,
    maxContextTurns: options.maxContextTurns ?? 5,
    sendMode: options.sendMode ?? 'block',
    blockTimeoutMs: options.blockTimeoutMs ?? 15_000,
    contextIdleTtlMs: 1_800_000,
    maxResidentContexts: 64,
    isolation: {
      workspaceMode: options.workspaceMode ?? 'per-peer',
      workspaceRoot: options.workspaceRoot,
      peerWorkspaces: {},
    },
    push: { enabled: false },
  }
  await ctx.plugin(A2AServer, config)

  const port = ctx.webServer.port
  const origin = `http://127.0.0.1:${port}`
  return {
    ctx,
    adapter,
    model,
    port,
    rpcUrl: `${origin}/a2a`,
    cardUrl: `${origin}/.well-known/agent-card.json`,
    stop: async () => { await ctx.fiber.dispose() },
  }
}

export { ECHO_MODEL, ECHO_PROVIDER }
