import { APIError } from 'openai';
import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage, type Message } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createAnthropicRequester } from '#/llm/requester/bases/anthropic/requester';
import { createOpenAIRequester } from '#/llm/requester/bases/openai/requester';
import type { LlmClientContext } from '#/llm/requester/requester';

const model: LlmModel = {
  provider: 'test',
  model: 'test-model',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://example.test/v1',
};
const messages: readonly Message[] = [createUserMessage('hi')];

const chatCompletionChunks: readonly Record<string, unknown>[] = [
  {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  },
];

const anthropicStreamEvents: readonly Record<string, unknown>[] = [
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];

function createAsyncStream<T>(chunks: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function stubOpenAIClient(chunks: readonly Record<string, unknown>[]): {
  clientFactory: (request: LlmClientContext) => never;
  body: () => Record<string, unknown>;
} {
  const captured: Record<string, unknown>[] = [];
  return {
    clientFactory: () =>
      ({
        chat: {
          completions: {
            create: (params: Record<string, unknown>) => {
              captured.push(params);
              return {
                withResponse: async () => ({
                  data: createAsyncStream(chunks),
                  response: new Response(null),
                }),
              };
            },
          },
        },
      }) as never,
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last;
    },
  };
}

function rejectingOpenAIClient(
  rejection: { readonly status: number; readonly message: string },
  chunks: readonly Record<string, unknown>[],
): {
  clientFactory: (request: LlmClientContext) => never;
  calls: () => Record<string, unknown>[];
} {
  const captured: Record<string, unknown>[] = [];
  return {
    clientFactory: () =>
      ({
        chat: {
          completions: {
            create: (params: Record<string, unknown>) => {
              captured.push(params);
              if (captured.length === 1 && 'prompt_cache_key' in params) {
                return {
                  withResponse: async () => {
                    throw new APIError(
                      rejection.status,
                      { message: rejection.message },
                      rejection.message,
                      undefined,
                    );
                  },
                };
              }
              return {
                withResponse: async () => ({
                  data: createAsyncStream(chunks),
                  response: new Response(null),
                }),
              };
            },
          },
        },
      }) as never,
    calls: () => captured,
  };
}

function stubAnthropicClient(events: readonly Record<string, unknown>[]): {
  clientFactory: (request: LlmClientContext) => never;
  body: () => Record<string, unknown>;
} {
  const captured: Record<string, unknown>[] = [];
  return {
    clientFactory: () =>
      ({
        messages: {
          create: (params: Record<string, unknown>) => {
            captured.push(params);
            return {
              withResponse: async () => ({
                data: createAsyncStream(events),
                response: new Response(null),
              }),
            };
          },
        },
      }) as never,
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last;
    },
  };
}

describe('openai requester cacheKey', () => {
  it('encodes the cache key as prompt_cache_key by default', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      {
        model,
        cacheKey: 'session-1',
        extraParams: { openai: { stop: ['END'], presence_penalty: 0.5, extra_body: { trace_id: 't1' } } },
      },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['prompt_cache_key']).toBe('session-1');
    expect(client.body()['stop']).toEqual(['END']);
    expect(client.body()['presence_penalty']).toBe(0.5);
    expect(client.body()['extra_body']).toEqual({ trace_id: 't1' });
  });

  it('lets a trait override the cache key params', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester({
      trait: { encodeCacheKey: (key) => ({ custom_cache: key }) },
      clientFactory: client.clientFactory,
    });
    await requester.generate(
      { model, cacheKey: 'session-1' },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['custom_cache']).toBe('session-1');
    expect(client.body()['prompt_cache_key']).toBeUndefined();
  });

  it('omits prompt_cache_key when the model opts out', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      { model: { ...model, promptCacheKey: false }, cacheKey: 'session-1' },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['prompt_cache_key']).toBeUndefined();
  });

  it('omits prompt_cache_key when no cache key is given', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      { model },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['prompt_cache_key']).toBeUndefined();
  });
});

describe('anthropic requester cacheKey', () => {
  it('encodes the cache key as metadata.user_id', async () => {
    const client = stubAnthropicClient(anthropicStreamEvents);
    const requester = createAnthropicRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      { model, cacheKey: 'session-1', extraParams: { anthropic: { top_k: 5 } } },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['metadata']).toEqual({ user_id: 'session-1' });
    expect(client.body()['top_k']).toBe(5);
  });
});

describe('openai requester prompt_cache_key fallback', () => {
  const rejected = 'Unsupported parameter(s): `prompt_cache_key`';

  it('retries once without prompt_cache_key when the gateway rejects it', async () => {
    const client = rejectingOpenAIClient({ status: 400, message: rejected }, chatCompletionChunks);
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    const events: string[] = [];
    await requester.generate(
      { model, cacheKey: 'session-1' },
      { messages },
      { signal: new AbortController().signal, onEvent: (e) => events.push(e.type) },
    );
    const calls = client.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.['prompt_cache_key']).toBe('session-1');
    expect(calls[1]?.['prompt_cache_key']).toBeUndefined();
    expect(events).toContain('llm.done');
    expect(events).not.toContain('llm.failed.remote');
  });

  it('remembers the rejection so later requests for the model skip the key', async () => {
    const client = rejectingOpenAIClient({ status: 400, message: rejected }, chatCompletionChunks);
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    const signal = new AbortController().signal;
    await requester.generate({ model, cacheKey: 'session-1' }, { messages }, { signal });
    await requester.generate({ model, cacheKey: 'session-2' }, { messages }, { signal });
    const calls = client.calls();
    expect(calls).toHaveLength(3);
    expect(calls[2]?.['prompt_cache_key']).toBeUndefined();
  });

  it('passes through a 400 that does not name prompt_cache_key', async () => {
    const client = rejectingOpenAIClient(
      { status: 400, message: 'Unsupported parameter(s): `temperature`' },
      chatCompletionChunks,
    );
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    const events: string[] = [];
    await requester.generate(
      { model, cacheKey: 'session-1' },
      { messages },
      { signal: new AbortController().signal, onEvent: (e) => events.push(e.type) },
    );
    expect(client.calls()).toHaveLength(1);
    expect(events).toContain('llm.failed.remote');
  });

  it('does not retry a non-400 error that mentions prompt_cache_key', async () => {
    const client = rejectingOpenAIClient(
      { status: 500, message: 'internal error near prompt_cache_key' },
      chatCompletionChunks,
    );
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    const events: string[] = [];
    await requester.generate(
      { model, cacheKey: 'session-1' },
      { messages },
      { signal: new AbortController().signal, onEvent: (e) => events.push(e.type) },
    );
    expect(client.calls()).toHaveLength(1);
    expect(events).toContain('llm.failed.remote');
  });
});
