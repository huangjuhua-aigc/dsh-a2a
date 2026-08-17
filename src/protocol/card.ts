/**
 * Agent Card construction.
 *
 * The card is the whole public product surface of an inbound-only A2A server:
 * it is fetched anonymously, before any credential is presented. Skills are
 * therefore whatever the deployment DECLARES, never a projection of the live
 * tool registry — broadcasting the installed tool inventory to anyone who scans
 * the port is information disclosure, not discovery.
 *
 * @module dsh-a2a/protocol/card
 */

import type { A2AAgentCard, A2AAgentSkill } from './wire.ts'

/** Everything the card renderer needs from the deployment. */
export interface CardInput {
  name: string
  description: string
  version: string
  /** The routable URL peers should post to; already resolved past any proxy. */
  url: string
  protocolVersion: string
  provider?: { organization: string; url: string }
  skills: A2AAgentSkill[]
  streaming: boolean
  pushNotifications: boolean
  /** Whether the RPC endpoint requires a bearer credential (it always does). */
  authRequired: boolean
}

/** The single skill advertised when a deployment declares none. */
export const FALLBACK_SKILL: A2AAgentSkill = {
  id: 'general',
  name: 'general',
  description: 'General-purpose agent task execution.',
  tags: ['general'],
}

/**
 * Build the Agent Card.
 *
 * Both interface spellings are emitted: `url` + `preferredTransport` for v0.3
 * readers and `supportedInterfaces[]` for v1.0 readers. That costs a few bytes
 * and removes an entire class of "peer could not find our endpoint" failure.
 * @param input - the deployment-resolved card facts.
 * @returns the card document to serve.
 */
export function buildAgentCard(input: CardInput): A2AAgentCard {
  const skills = input.skills.length > 0 ? input.skills : [FALLBACK_SKILL]
  const card: A2AAgentCard = {
    protocolVersion: input.protocolVersion,
    name: input.name,
    description: input.description,
    version: input.version,
    url: input.url,
    preferredTransport: 'JSONRPC',
    supportedInterfaces: [{
      url: input.url,
      protocolBinding: 'JSONRPC',
      protocolVersion: input.protocolVersion,
    }],
    capabilities: {
      streaming: input.streaming,
      pushNotifications: input.pushNotifications,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
    ...input.provider === undefined ? {} : { provider: input.provider },
  }
  if (input.authRequired) {
    card.securitySchemes = { bearer: { type: 'http', scheme: 'bearer' } }
    card.security = [{ bearer: [] }]
  }
  return card
}
