/**
 * Agent Card construction.
 *
 * The card is the whole public product surface of an inbound-only A2A server:
 * it is fetched anonymously, before any credential is presented. Skills are
 * therefore whatever the deployment DECLARES, never a projection of the live
 * tool registry — broadcasting the installed tool inventory to anyone who scans
 * the port is information disclosure, not discovery.
 *
 * v1.0 reshaped the card substantially: the endpoint, its binding, and the
 * protocol version now live together in `supportedInterfaces[]`, the extended
 * card moved into `capabilities`, and `security` became `securityRequirements`.
 * The card this module builds carries no v0.3 members at all — a stale reader
 * finding `url` next to `supportedInterfaces` would have no way to tell which
 * one this server actually honors.
 *
 * @module dsh-a2a/protocol/card
 */

import { A2A_PROTOCOL_VERSION } from './wire.ts'
import type { A2AAgentCard, A2AAgentSkill } from './wire.ts'

/** Everything the card renderer needs from the deployment. */
export interface CardInput {
  name: string
  description: string
  version: string
  /** The routable URL peers should post to; already resolved past any proxy. */
  url: string
  provider?: { organization: string; url: string }
  skills: A2AAgentSkill[]
  streaming: boolean
  pushNotifications: boolean
  /**
   * Skills revealed only to an authenticated peer through
   * `GetExtendedAgentCard`. An empty list means no extended card exists, and
   * `capabilities.extendedAgentCard` stays false.
   */
  extendedSkills?: A2AAgentSkill[]
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
 * Build the public Agent Card.
 * @param input - the deployment-resolved card facts.
 * @returns the card document to serve at the well-known URI.
 */
export function buildAgentCard(input: CardInput): A2AAgentCard {
  const skills = input.skills.length > 0 ? input.skills : [FALLBACK_SKILL]
  const card: A2AAgentCard = {
    name: input.name,
    description: input.description,
    supportedInterfaces: [{
      url: input.url,
      protocolBinding: 'JSONRPC',
      protocolVersion: A2A_PROTOCOL_VERSION,
    }],
    version: input.version,
    capabilities: {
      streaming: input.streaming,
      pushNotifications: input.pushNotifications,
      extendedAgentCard: (input.extendedSkills ?? []).length > 0,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
    ...input.provider === undefined ? {} : { provider: input.provider },
  }
  if (input.authRequired) {
    // v1.0 wraps each scheme in the member naming its type, and replaces the
    // bare `security` array with `securityRequirements`.
    card.securitySchemes = {
      bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
    }
    card.securityRequirements = [{ schemes: { bearer: { list: [] } } }]
  }
  return card
}

/**
 * Build the authenticated extended Agent Card.
 *
 * Same document, plus the skills a deployment chose not to publish anonymously.
 * A peer that has proven its identity has already passed the gate those skills
 * were withheld behind.
 * @param input - the deployment-resolved card facts.
 * @returns the extended card, or undefined when no extended skills are declared.
 */
export function buildExtendedAgentCard(input: CardInput): A2AAgentCard | undefined {
  const extended = input.extendedSkills ?? []
  if (extended.length === 0) return undefined
  const base = buildAgentCard(input)
  return { ...base, skills: [...base.skills, ...extended] }
}
