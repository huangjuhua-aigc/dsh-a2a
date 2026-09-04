/**
 * End-to-end: a real HTTP server, a real harness agent, real JSON-RPC.
 *
 * These tests exercise the path a peer actually takes — card discovery,
 * bearer authentication, context materialization, turn correlation, settlement,
 * artifact rendering — with a stub model adapter so no API key is involved.
 *
 * Every request is A2A v1.0. The v0.3 spellings appear only where a test proves
 * they are refused.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compose, type Composition } from '../example/compose.ts'
import { SERVER_VERSION } from '../src/version.ts'

const ALICE_TOKEN = 'tok-alice-e2e'
const BOB_TOKEN = 'tok-bob-e2e'

let workspaceRoot: string
let app: Composition | undefined

/** Post one JSON-RPC request and return the parsed envelope plus status. */
async function rpc(
  url: string,
  token: string | undefined,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...token === undefined ? {} : { authorization: `Bearer ${token}` },
      ...headers,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : {} }
}

/** Build a `SendMessage` request. */
function sendRequest(id: number, text: string, contextId?: string): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'SendMessage',
    params: {
      message: {
        messageId: `m-${id}`,
        role: 'ROLE_USER',
        parts: [{ text, mediaType: 'text/plain' }],
        ...contextId === undefined ? {} : { contextId },
      },
    },
  }
}

/** The task carried in a `SendMessage` result, which v1.0 wraps in a member. */
function sentTask(body: Record<string, unknown>): Record<string, any> {
  return (body['result'] as Record<string, any>)?.task as Record<string, any>
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-a2a-'))
  // The credential seam reads the process environment as its top layer, so the
  // test supplies peer secrets exactly the way a container deployment does.
  process.env['A2A_PEER_ALICE'] = ALICE_TOKEN
  process.env['A2A_PEER_BOB'] = BOB_TOKEN
  app = await compose({
    forceStub: true,
    workspaceRoot,
    peers: { alice: 'A2A_PEER_ALICE', bob: 'A2A_PEER_BOB' },
  })
})

afterEach(async () => {
  await app?.stop()
  app = undefined
  delete process.env['A2A_PEER_ALICE']
  delete process.env['A2A_PEER_BOB']
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe('agent card discovery', () => {
  it('serves a valid card anonymously', async () => {
    const response = await fetch(app!.cardUrl)
    expect(response.status).toBe(200)
    const card = await response.json() as Record<string, any>
    expect(card.skills[0].id).toBe('general')
  })

  it('declares its endpoint and version through supportedInterfaces', async () => {
    const card = await (await fetch(app!.cardUrl)).json() as Record<string, any>
    expect(card.supportedInterfaces).toHaveLength(1)
    expect(card.supportedInterfaces[0].protocolBinding).toBe('JSONRPC')
    expect(card.supportedInterfaces[0].protocolVersion).toBe('1.0')
    expect(card.supportedInterfaces[0].url).toContain('/a2a')
    expect(card.version).toBe(SERVER_VERSION)
  })

  it('carries none of the card members v1.0 removed', async () => {
    const card = await (await fetch(app!.cardUrl)).json() as Record<string, any>
    expect(card.protocolVersion).toBeUndefined()
    expect(card.url).toBeUndefined()
    expect(card.preferredTransport).toBeUndefined()
    expect(card.supportsAuthenticatedExtendedCard).toBeUndefined()
  })

  it('declares the bearer scheme it actually enforces', async () => {
    const card = await (await fetch(app!.cardUrl)).json() as Record<string, any>
    expect(card.securitySchemes.bearer).toEqual({ httpAuthSecurityScheme: { scheme: 'Bearer' } })
    expect(card.securityRequirements).toEqual([{ schemes: { bearer: { list: [] } } }])
  })

  it('also answers the legacy well-known path', async () => {
    const legacy = app!.cardUrl.replace('agent-card.json', 'agent.json')
    expect((await fetch(legacy)).status).toBe(200)
  })
})

describe('authentication', () => {
  it('rejects a request with no credential', async () => {
    const { status } = await rpc(app!.rpcUrl, undefined, sendRequest(1, 'hi'))
    expect(status).toBe(401)
  })

  it('rejects an unknown token', async () => {
    const { status } = await rpc(app!.rpcUrl, 'tok-mallory', sendRequest(1, 'hi'))
    expect(status).toBe(401)
  })

  it('answers 401 with a body that is still a valid JSON-RPC envelope', async () => {
    const { body } = await rpc(app!.rpcUrl, undefined, sendRequest(1, 'hi'))
    expect(body['jsonrpc']).toBe('2.0')
    expect(body['error']).toBeDefined()
  })

  it('accepts a declared peer', async () => {
    const { status, body } = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'hi'))
    expect(status).toBe(200)
    expect(body['error']).toBeUndefined()
  })
})

describe('SendMessage round trip', () => {
  it('runs a real agent turn and returns a completed task', async () => {
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'ping'))
    const task = sentTask(body)
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.id).toBeTruthy()
    expect(task.contextId).toBeTruthy()
  })

  it('wraps the result in a task member rather than returning it bare', async () => {
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'ping'))
    const result = body['result'] as Record<string, any>
    expect(Object.keys(result)).toEqual(['task'])
  })

  it('carries no kind discriminator, which v1.0 removed', async () => {
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'ping'))
    expect(sentTask(body).kind).toBeUndefined()
  })

  it('returns the agent output as an artifact', async () => {
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'ping'))
    const task = sentTask(body)
    // The stub adapter echoes the user text back, so a round trip through the
    // whole path is visible in the artifact.
    expect(task.artifacts[0].parts[0].text).toContain('echo:')
    expect(task.artifacts[0].parts[0].text).toContain('ping')
  })

  it('mints a contextId the peer can continue', async () => {
    const first = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'first'))
    const contextId = sentTask(first.body).contextId as string

    const second = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(2, 'second', contextId))
    const task = sentTask(second.body)
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.contextId).toBe(contextId)
  })

  it('refuses a message addressed to a task that already settled', async () => {
    const first = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'first'))
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, {
      jsonrpc: '2.0',
      id: 2,
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'm-2',
          role: 'ROLE_USER',
          parts: [{ text: 'more' }],
          taskId: sentTask(first.body).id,
        },
      },
    })
    const error = body['error'] as Record<string, any>
    expect(error.code).toBe(-32004)
    expect(error.data[0].reason).toBe('UNSUPPORTED_OPERATION')
  })

  it('rejects an empty message', async () => {
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, '   '))
    expect((body['error'] as Record<string, unknown>)['code']).toBe(-32602)
  })

  it('rejects an unknown method with the standard code', async () => {
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, {
      jsonrpc: '2.0', id: 1, method: 'Teleport', params: {},
    })
    expect((body['error'] as Record<string, unknown>)['code']).toBe(-32601)
  })
})

describe('the retired v0.3 surface', () => {
  it('refuses a v0.3 method and names its v1.0 replacement', async () => {
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: 'm1',
          role: 'user',
          parts: [{ kind: 'text', text: 'hi' }],
        },
      },
    })
    const error = body['error'] as Record<string, any>
    expect(error.code).toBe(-32601)
    expect(error.message).toContain('SendMessage')
  })

  it('refuses the v0.3 taskId parameter, which v1.0 spells id', async () => {
    const first = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'hi'))
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, {
      jsonrpc: '2.0', id: 2, method: 'GetTask', params: { taskId: sentTask(first.body).id },
    })
    expect((body['error'] as Record<string, unknown>)['code']).toBe(-32602)
  })
})

describe('version negotiation', () => {
  it('serves a request that names this interface version', async () => {
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'hi'), {
      'a2a-version': '1.0',
    })
    expect(body['error']).toBeUndefined()
  })

  it('serves a request with no version header at all', async () => {
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'hi'))
    expect(body['error']).toBeUndefined()
  })

  it('refuses v0.3 with VersionNotSupported rather than a reply it cannot read', async () => {
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'hi'), {
      'a2a-version': '0.3',
    })
    const error = body['error'] as Record<string, any>
    expect(error.code).toBe(-32009)
    expect(error.data[0].reason).toBe('VERSION_NOT_SUPPORTED')
    expect(error.data[0].domain).toBe('a2a-protocol.org')
  })

  it('refuses a version that does not exist', async () => {
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'hi'), {
      'a2a-version': '9.9',
    })
    expect((body['error'] as Record<string, unknown>)['code']).toBe(-32009)
  })
})

describe('tenant routing', () => {
  it('refuses a tenant this interface never declared', async () => {
    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        tenant: 'other',
        message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }] },
      },
    })
    expect((body['error'] as Record<string, unknown>)['code']).toBe(-32602)
  })
})

describe('GetExtendedAgentCard', () => {
  it('reveals the withheld skills to an authenticated peer', async () => {
    const publicCard = await (await fetch(app!.cardUrl)).json() as Record<string, any>
    expect(publicCard.capabilities.extendedAgentCard).toBe(true)
    expect(publicCard.skills.map((skill: any) => skill.id)).toEqual(['general'])

    const { body } = await rpc(app!.rpcUrl, ALICE_TOKEN, {
      jsonrpc: '2.0', id: 1, method: 'GetExtendedAgentCard',
    })
    const card = body['result'] as Record<string, any>
    expect(card.skills.map((skill: any) => skill.id))
      .toEqual(['general', 'internal-diagnostics'])
  })

  it('needs a credential like every other method', async () => {
    const { status } = await rpc(app!.rpcUrl, undefined, {
      jsonrpc: '2.0', id: 1, method: 'GetExtendedAgentCard',
    })
    expect(status).toBe(401)
  })
})

describe('peer isolation', () => {
  it('refuses another peer the use of a contextId, indistinguishably from absent', async () => {
    const first = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'alice work'))
    const aliceContext = sentTask(first.body).contextId as string

    const stolen = await rpc(app!.rpcUrl, BOB_TOKEN, sendRequest(2, 'peek', aliceContext))
    const invented = await rpc(app!.rpcUrl, BOB_TOKEN, sendRequest(3, 'peek', 'made-up-context'))

    // Both must answer identically, or Bob could enumerate which contexts exist.
    expect((stolen.body['error'] as Record<string, unknown>)['code'])
      .toBe((invented.body['error'] as Record<string, unknown>)['code'])
    expect((stolen.body['error'] as Record<string, unknown>)['code']).toBe(-32602)
  })

  it('gives each peer its own workspace directory', async () => {
    await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'hi'))
    await rpc(app!.rpcUrl, BOB_TOKEN, sendRequest(2, 'hi'))
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(workspaceRoot)
    expect(entries.sort()).toEqual(['alice', 'bob'])
  })

  it("reports another peer's task as not found", async () => {
    const first = await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'alice work'))
    const taskId = sentTask(first.body).id as string
    const { body } = await rpc(app!.rpcUrl, BOB_TOKEN, {
      jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: taskId },
    })
    expect((body['error'] as Record<string, unknown>)['code']).toBe(-32001)
  })

  it("never lists another peer's tasks", async () => {
    await rpc(app!.rpcUrl, ALICE_TOKEN, sendRequest(1, 'alice work'))
    const { body } = await rpc(app!.rpcUrl, BOB_TOKEN, {
      jsonrpc: '2.0', id: 2, method: 'ListTasks', params: {},
    })
    expect((body['result'] as Record<string, any>).tasks).toEqual([])
    expect((body['result'] as Record<string, any>).totalSize).toBe(0)
  })
})

describe('anti-loop cap', () => {
  it('rejects a context that exceeds the turn cap', async () => {
    const app2 = await compose({
      forceStub: true,
      workspaceRoot,
      peers: { alice: 'A2A_PEER_ALICE' },
      maxContextTurns: 2,
    })
    try {
      const first = await rpc(app2.rpcUrl, ALICE_TOKEN, sendRequest(1, 'one'))
      const contextId = sentTask(first.body).contextId as string
      await rpc(app2.rpcUrl, ALICE_TOKEN, sendRequest(2, 'two', contextId))
      const third = await rpc(app2.rpcUrl, ALICE_TOKEN, sendRequest(3, 'three', contextId))
      expect(sentTask(third.body).status.state).toBe('TASK_STATE_REJECTED')
    } finally {
      await app2.stop()
    }
  })
})

describe('trust gate', () => {
  it('refuses an authenticated peer that is not on the allow list', async () => {
    const app2 = await compose({
      forceStub: true,
      workspaceRoot,
      peers: { alice: 'A2A_PEER_ALICE', bob: 'A2A_PEER_BOB' },
      trustedPeers: ['alice'],
    })
    try {
      expect((await rpc(app2.rpcUrl, ALICE_TOKEN, sendRequest(1, 'hi'))).status).toBe(200)
      expect((await rpc(app2.rpcUrl, BOB_TOKEN, sendRequest(2, 'hi'))).status).toBe(403)
    } finally {
      await app2.stop()
    }
  })
})

describe('teardown', () => {
  it('leaves no orphan agent after the plugin tree is disposed', async () => {
    const app2 = await compose({ forceStub: true, workspaceRoot, peers: { alice: 'A2A_PEER_ALICE' } })
    await rpc(app2.rpcUrl, ALICE_TOKEN, sendRequest(1, 'hi'))
    await app2.stop()
    // The port must be released, proving the route registration and the HTTP
    // carrier both unwound rather than leaking.
    await expect(fetch(app2.cardUrl)).rejects.toThrow()
  })
})
