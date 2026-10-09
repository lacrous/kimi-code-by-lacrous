import { describe, expect, it, vi } from 'vitest';

import { NO_FINISH } from '#human/llm/finish-reason';
import type { LlmModel } from '#human/llm/model';
import type { StreamedMessagePart } from '#human/llm/message';
import type { TraitContext } from '#human/llm/protocol/base';
import type { ProviderConnection } from '#human/llm/protocol/connection';
import type { StreamParseSink, StreamParser } from '#human/llm/protocol/format';
import { consumeStream, resolveTransportHeaders } from '#human/llm/protocol/stream';
import type { LlmRequestEvent } from '#human/llm/requester/requester';

interface Chunk {
  readonly id?: string;
  readonly text?: string;
  readonly fail?: string;
}

function textPart(text: string): StreamedMessagePart {
  return { type: 'text', text };
}

async function* streamOf(chunks: Chunk[]): AsyncGenerator<Chunk> {
  for (const chunk of chunks) yield chunk;
}

describe('consumeStream', () => {
  it('parses every chunk and closes the stream with llm.done', async () => {
    const events: LlmRequestEvent[] = [];
    const parsed: Chunk[] = [];

    await consumeStream(
      streamOf([{ text: 'a' }, { text: 'b' }]),
      (chunk, sink) => {
        parsed.push(chunk);
        sink.onDelta(textPart(chunk.text ?? ''));
      },
      (event) => events.push(event),
    );

    expect(parsed.map((chunk) => chunk.text)).toEqual(['a', 'b']);
    expect(events).toEqual([
      { type: 'llm.streaming.part', part: textPart('a') },
      { type: 'llm.streaming.part', part: textPart('b') },
      { type: 'llm.done' },
    ]);
  });

  it('dedups the message id and forwards usage and finish on every chunk', async () => {
    const events: LlmRequestEvent[] = [];
    const usage = { inputOther: 3, output: 5, inputCacheRead: 0, inputCacheCreation: 0 };

    await consumeStream(
      streamOf([{ id: 'msg-1' }, { id: 'msg-1' }, { id: 'msg-1' }]),
      (chunk, sink: StreamParseSink) => {
        if (chunk.id !== undefined) sink.onMessageId?.(chunk.id);
        sink.onUsage?.(usage);
        sink.onFinish(NO_FINISH);
      },
      (event) => events.push(event),
    );

    const of = (type: LlmRequestEvent['type']) => events.filter((event) => event.type === type);
    expect(of('llm.streaming.message_id')).toEqual([
      { type: 'llm.streaming.message_id', messageId: 'msg-1' },
    ]);
    expect(of('llm.streaming.usage')).toHaveLength(3);
    expect(of('llm.streaming.finish')).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: 'llm.done' });
  });

  it('stops on the first parse error and never emits llm.done', async () => {
    const events: LlmRequestEvent[] = [];
    const parsed: Chunk[] = [];

    await consumeStream(
      streamOf([{ text: 'a' }, { fail: 'rate limited' }, { text: 'c' }]),
      (chunk, sink) => {
        parsed.push(chunk);
        if (chunk.fail !== undefined) {
          sink.onError?.({ kind: 'provider', message: chunk.fail });
        }
      },
      (event) => events.push(event),
    );

    expect(parsed).toHaveLength(2);
    expect(events).toEqual([
      { type: 'llm.failed.remote', error: { kind: 'provider', message: 'rate limited' } },
    ]);
  });

  it('observes a chunk before parsing it and tolerates a missing emitter', async () => {
    const order: string[] = [];

    await consumeStream(
      streamOf([{ text: 'a' }]),
      (chunk) => {
        order.push(`parse:${chunk.text}`);
      },
      undefined,
      (chunk) => order.push(`observe:${chunk.text}`),
    );

    expect(order).toEqual(['observe:a', 'parse:a']);
  });

  it('lets a throwing observer abort before the chunk is parsed', async () => {
    const parse = vi.fn();

    await expect(
      consumeStream(
        streamOf([{ text: 'a' }]),
        parse,
        undefined,
        () => {
          throw new Error('aborted');
        },
      ),
    ).rejects.toThrow('aborted');
    expect(parse).not.toHaveBeenCalled();
  });
});

describe('resolveTransportHeaders', () => {
  const ctx = { model: { defaultHeaders: { 'x-model': 'm' } } } as unknown as TraitContext;

  it('layers connection defaults under model headers under request headers', () => {
    const connection: ProviderConnection = { defaultHeaders: () => ({ 'x-conn': 'c' }) };

    expect(resolveTransportHeaders(connection, ctx, { 'x-request': 'r' })).toEqual({
      'x-conn': 'c',
      'x-model': 'm',
      'x-request': 'r',
    });
  });

  it('lets the later layer win', () => {
    const connection: ProviderConnection = { defaultHeaders: () => ({ 'x-shared': 'from-conn' }) };

    expect(resolveTransportHeaders(connection, ctx, { 'x-shared': 'from-request' })).toEqual({
      'x-shared': 'from-request',
      'x-model': 'm',
    });
  });

  it('returns undefined when no layer contributes a header', () => {
    const bare = { model: {} } as unknown as TraitContext;

    expect(resolveTransportHeaders(undefined, bare, undefined)).toBeUndefined();
    expect(resolveTransportHeaders({ defaultHeaders: () => ({}) }, bare, undefined)).toBe(
      undefined,
    );
  });

  it('hands the connection hook the model it is resolving for', () => {
    const seen: (LlmModel | undefined)[] = [];
    const connection: ProviderConnection = {
      defaultHeaders: ({ model }) => {
        seen.push(model);
        return { 'x-model': model.model };
      },
    };
    const model = { model: 'wire-model', defaultHeaders: undefined } as LlmModel;

    expect(resolveTransportHeaders(connection, { model }, undefined)).toEqual({
      'x-model': 'wire-model',
    });
    expect(seen).toEqual([model]);
  });
});
