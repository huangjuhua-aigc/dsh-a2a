/**
 * The version this server publishes on its Agent Card.
 *
 * `AgentCard.version` is the AGENT's version, not the protocol's — that one
 * lives in `supportedInterfaces[].protocolVersion`. Here the agent IS the
 * plugin, so the card version and the npm version are one fact, and a card
 * claiming a version npm never shipped points a peer at source that cannot
 * explain the behaviour it is seeing.
 *
 * It stays a literal rather than an import of `package.json` because
 * `rootDir` is `src`: the manifest sits outside the compiled tree, so
 * importing it would move the emitted entry point. `tests/version.spec.ts` is
 * what keeps the two in step instead — drift becomes a failing test rather
 * than a card nobody rereads.
 *
 * @module dsh-a2a/version
 */

/** Must equal `version` in package.json. */
export const SERVER_VERSION = '0.2.0'
