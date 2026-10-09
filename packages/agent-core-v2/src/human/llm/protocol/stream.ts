import { mergeRequestHeaders, type LlmRequestEvent } from '#/llm/requester/requester';

import type { TraitContext } from './base';
import type { ProviderConnection } from './connection';
import type { StreamParseSink, StreamParser } from './format';

export type LlmEventEmitter = ((event: LlmRequestEvent) => void) | undefined;

export function resolveTransportHeaders(
  connection: ProviderConnection | undefined,
  ctx: TraitContext,
  requestHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return mergeRequestHeaders(
    mergeRequestHeaders(connection?.defaultHeaders?.(ctx), ctx.model.defaultHeaders),
    requestHeaders,
  );
}

export async function consumeStream<TChunk>(
  stream: AsyncIterable<TChunk>,
  parse: StreamParser<TChunk>,
  onEvent: LlmEventEmitter,
  observe?: (chunk: TChunk) => void,
): Promise<void> {
  const state: { messageId?: string; failed: boolean } = { failed: false };
  const sink: StreamParseSink = {
    onDelta: (part) => onEvent?.({ type: 'llm.streaming.part', part }),
    onFinish: (finish) => onEvent?.({ type: 'llm.streaming.finish', finish }),
    onMessageId: (id) => {
      if (id === state.messageId) return;
      state.messageId = id;
      onEvent?.({ type: 'llm.streaming.message_id', messageId: id });
    },
    onUsage: (usage) => onEvent?.({ type: 'llm.streaming.usage', usage }),
    onError: (message) => {
      state.failed = true;
      onEvent?.({ type: 'llm.failed.remote', error: message });
    },
  };
  for await (const chunk of stream) {
    observe?.(chunk);
    parse(chunk, sink);
    if (state.failed) {
      return;
    }
  }
  onEvent?.({ type: 'llm.done' });
}