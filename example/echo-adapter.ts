/**
 * A keyless stub model adapter for local runs and end-to-end tests.
 *
 * It answers every request by echoing the last user message back, so the whole
 * A2A path — HTTP, authentication, context materialization, turn correlation,
 * settlement, artifact rendering — can be exercised without an API key or a
 * recorded fixture.
 *
 * This is example/test scaffolding, not part of the published plugin.
 *
 * @module dsh-a2a/example/echo-adapter
 */


import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** The provider route this stub registers. */
export const ECHO_PROVIDER = 'echo'
/** The model id this stub answers to. */
export const ECHO_MODEL = 'echo-1'

/** Streams back a canned reply derived from the request's last user text. */
export class EchoAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    if (provider !== ECHO_PROVIDER) throw new Error(`EchoAdapter: unknown provider ${provider}`)
    return { id: ECHO_PROVIDER, name: 'Echo' }
  }

  override listModels(provider: string) {
    return Promise.resolve(
      provider === ECHO_PROVIDER
        ? [{ provider: ECHO_PROVIDER, id: ECHO_MODEL, name: 'Echo' }]
        : [],
    )
  }

  /**
   * Answer one request with a single text block.
   * @param options - the assembled request.
   * @returns the chunk stream.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const lastUser = [...options.messages].reverse().find(message => message.role === 'user')
    const echoed = lastUser?.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n') ?? ''
    const reply = `echo: ${echoed}`

    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: reply.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
