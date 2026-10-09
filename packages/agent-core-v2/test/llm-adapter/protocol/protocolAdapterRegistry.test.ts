import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { isUnknownCapability } from '#/llm-adapter/contract/capability';
import { createUserMessage } from '#human/llm/message';
import type { LlmRequestEvent } from '#human/llm/requester/requester';
import { thinkingMetadataOf } from '#human/llm/thinking';
import type { Model } from '#/llm-adapter/model/catalog';
import { ProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocolAdapterRegistry';
import {
  getProviderDefinition,
  getProviderDefinitions,
  hasProviderDefinition,
  registerProviderDefinition,
  resolveProviderEndpoint,
} from '#/llm-adapter/provider/provider-definition';

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'KIMI_API_KEY',
  'KIMI_BASE_URL',
  'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_VERTEX_BASE_URL',
  'VERTEXAI_API_KEY',
] as const;

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

registerProviderDefinition({
  id: 'cap-vendor',
  baseProtocol: 'openai',
  capability: (modelName: string) =>
    modelName === 'special-model'
      ? {
          image_in: true,
          video_in: false,
          audio_in: false,
          thinking: false,
          tool_use: true,
        }
      : undefined,
});

const registry = new ProtocolAdapterRegistry();

function modelWith(spec: {
  readonly protocol: Model['protocol'];
  readonly providerType?: string;
  readonly providerOptions?: Model['providerOptions'];
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly baseUrl?: string;
}): Model {
  return {
    id: 'm1',
    name: 'wire-model',
    aliases: [],
    protocol: spec.protocol,
    headers: {},
    baseUrl: spec.baseUrl,
    capabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128000,
    },
    maxContextSize: 128000,
    alwaysThinking: false,
    providerType: spec.providerType,
    providerName: spec.providerType ?? spec.protocol,
    reasoningKey: spec.reasoningKey,
    supportEfforts: spec.supportEfforts,
    providerOptions: spec.providerOptions,
  };
}

function sse(events: readonly (readonly [string | undefined, unknown])[]): string {
  return events
    .map(([name, data]) => {
      const label = name === undefined ? '' : `event: ${name}\n`;
      return `${label}data: ${JSON.stringify(data)}\n\n`;
    })
    .join('');
}

const ANTHROPIC_STREAM = sse([
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'wire-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ],
  ['message_stop', { type: 'message_stop' }],
]);

const GOOGLE_STREAM = sse([
  [
    undefined,
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
    },
  ],
]);

async function withStubGateway(
  run: (gateway: { readonly baseUrl: string; readonly paths: readonly string[] }) => Promise<void>,
): Promise<void> {
  const paths: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    paths.push(req.url ?? '');
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      });
      const isGemini = req.url?.includes('streamGenerateContent') === true;
      res.end(isGemini ? GOOGLE_STREAM : ANTHROPIC_STREAM);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ baseUrl: `http://127.0.0.1:${port}`, paths });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

interface DispatchResult {
  readonly paths: readonly string[];
  readonly events: readonly LlmRequestEvent[];
}

async function dispatch(model: Model): Promise<DispatchResult> {
  const resolved = registry.resolve(model);
  const events: LlmRequestEvent[] = [];
  let paths: readonly string[] = [];
  await withStubGateway(async (gateway) => {
    paths = gateway.paths;
    await resolved.requester.generate(
      { model: { ...resolved.model, baseUrl: gateway.baseUrl } },
      { messages: [createUserMessage('hi')] },
      { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
    );
  });
  return { paths, events };
}

describe('supportedProtocols', () => {
  it('lists the four wire protocols and contains neither kimi nor vertexai', () => {
    const protocols = registry.supportedProtocols();
    expect(protocols).toHaveLength(4);
    expect([...protocols].toSorted()).toEqual(
      ['anthropic', 'google-genai', 'openai', 'openai_responses'].toSorted(),
    );
    expect(protocols).not.toContain('kimi');
    expect(protocols).not.toContain('vertexai');
  });
});

describe('resolveAdapterIdentity', () => {
  it('resolves the kimi pair registrations to their vendor traits', () => {
    expect(registry.resolveAdapterIdentity('openai', 'kimi').baseId).toBe('openai');
    expect(registry.resolveAdapterIdentity('openai', 'kimi').trait).toBeDefined();
    expect(registry.resolveAdapterIdentity('anthropic', 'kimi').baseId).toBe('anthropic');
    expect(registry.resolveAdapterIdentity('anthropic', 'kimi').trait).toBeDefined();
    expect(registry.resolveAdapterIdentity('openai_responses', 'kimi').baseId).toBe(
      'openai_responses',
    );
    expect(registry.resolveAdapterIdentity('openai_responses', 'kimi').trait).toBeDefined();
  });

  it('resolves unregistered pairs to the protocol itself with no vendor trait', () => {
    const google = registry.resolveAdapterIdentity('google-genai', 'kimi');
    expect(google.baseId).toBe('google-genai');
    expect(google.trait).toBeUndefined();
    const unknown = registry.resolveAdapterIdentity('openai', 'no-such-vendor');
    expect(unknown.baseId).toBe('openai');
    expect(unknown.trait).toBeUndefined();
  });

  it('resolves the no-providerType branch identically', () => {
    const identity = registry.resolveAdapterIdentity('openai');
    expect(identity.baseId).toBe('openai');
    expect(identity.trait).toBeUndefined();
  });
});

describe('resolveProviderBaseId', () => {
  it('returns the pair registration’s baseProtocol — the protocol itself by construction', () => {
    expect(registry.resolveProviderBaseId('openai', 'kimi')).toBe('openai');
    expect(registry.resolveProviderBaseId('anthropic', 'kimi')).toBe('anthropic');
  });

  it('returns the protocol itself otherwise', () => {
    expect(registry.resolveProviderBaseId('google-genai', 'kimi')).toBe('google-genai');
    expect(registry.resolveProviderBaseId('openai', 'no-such-vendor')).toBe('openai');
    expect(registry.resolveProviderBaseId('openai')).toBe('openai');
  });
});

describe('resolveCapability', () => {
  it('falls back to trait capability hooks before the base catalog', () => {
    const fromTrait = registry.resolveCapability('openai', 'special-model', 'cap-vendor');
    expect(fromTrait.image_in).toBe(true);
    const fromBase = registry.resolveCapability('openai', 'gpt-4o', 'cap-vendor');
    expect(fromBase.image_in).toBe(true);
  });

  it('falls back to the base catalog and then to UNKNOWN', () => {
    expect(registry.resolveCapability('openai', 'gpt-4o').image_in).toBe(true);
    expect(isUnknownCapability(registry.resolveCapability('openai', 'mystery-model'))).toBe(true);
    expect(registry.resolveCapability('anthropic', 'claude-opus-4-1').thinking).toBe(true);
  });

  it('kimi declares no vendor-level capability — the base catalog answers instead', () => {
    expect(isUnknownCapability(registry.resolveCapability('openai', 'kimi-for-coding', 'kimi'))).toBe(
      true,
    );
    expect(registry.resolveCapability('openai', 'gpt-4o', 'kimi').image_in).toBe(true);
  });
});

describe('resolve gateway routes', () => {
  it('routes kimi+openai to the kimi trait with the video upload media', () => {
    const resolved = registry.resolve(modelWith({ protocol: 'openai', providerType: 'kimi' }));
    expect(resolved.protocol).toBe('openai');
    expect(resolved.model.provider).toBe('openai');
    expect(resolved.model.model).toBe('wire-model');
    expect(typeof resolved.media?.uploadVideo).toBe('function');
    expect(typeof resolved.media?.uploadImage).toBe('function');
  });

  it('routes plain openai without the upload media', () => {
    const resolved = registry.resolve(modelWith({ protocol: 'openai' }));
    expect(resolved.protocol).toBe('openai');
    expect(resolved.media?.uploadVideo).toBeUndefined();
    expect(resolved.media?.uploadImage).toBeUndefined();
  });

  it('reports the wire protocol regardless of beta or vertex provider options', () => {
    const beta = registry.resolve(
      modelWith({ protocol: 'anthropic', providerOptions: { betaApi: true } }),
    );
    expect(beta.protocol).toBe('anthropic');
    const vertex = registry.resolve(
      modelWith({
        protocol: 'google-genai',
        providerOptions: { vertexai: true, project: 'p', location: 'l' },
      }),
    );
    expect(vertex.protocol).toBe('google-genai');
  });

  it('routes betaApi to the beta endpoint and its absence to the stable one', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
    const beta = await dispatch(
      modelWith({ protocol: 'anthropic', providerOptions: { betaApi: true } }),
    );
    const stable = await dispatch(modelWith({ protocol: 'anthropic' }));

    expect(beta.paths).toEqual(['/v1/messages?beta=true']);
    expect(stable.paths).toEqual(['/v1/messages']);
    for (const { events } of [beta, stable]) {
      expect(events.map((event) => event.type)).toContain('llm.sent');
      expect(events.at(-1)).toEqual({ type: 'llm.done' });
    }
  });

  it('routes vertexai to the vertex endpoint and its absence to the gemini one', async () => {
    process.env['GOOGLE_API_KEY'] = 'gemini-key';
    process.env['VERTEXAI_API_KEY'] = 'vertex-key';
    const gemini = await dispatch(modelWith({ protocol: 'google-genai' }));
    const vertex = await dispatch(
      modelWith({ protocol: 'google-genai', providerOptions: { vertexai: true } }),
    );

    expect(gemini.paths).toEqual([
      '/v1beta/models/wire-model:streamGenerateContent?alt=sse',
    ]);
    expect(vertex.paths).toEqual([
      '/v1beta1/publishers/google/models/wire-model:streamGenerateContent?alt=sse',
    ]);
    for (const { events } of [gemini, vertex]) {
      expect(events.map((event) => event.type)).toContain('llm.sent');
      expect(events.at(-1)).toEqual({ type: 'llm.done' });
    }
  });

  it('sends a kimi definition on its own protocol, never the beta endpoint', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
    process.env['KIMI_API_KEY'] = 'sk-test-key';

    const kimi = await dispatch(modelWith({ protocol: 'anthropic', providerType: 'kimi' }));
    const plain = await dispatch(modelWith({ protocol: 'anthropic' }));

    expect(kimi.paths).toEqual(plain.paths);
  });

  it('routes kimi+anthropic through the kimi anthropic trait with media', () => {
    const resolved = registry.resolve(modelWith({ protocol: 'anthropic', providerType: 'kimi' }));
    expect(resolved.protocol).toBe('anthropic');
    expect(typeof resolved.media?.uploadVideo).toBe('function');
    expect(typeof resolved.media?.uploadImage).toBe('function');
  });

  it('carries thinking metadata and model limits onto the resolved LlmModel', () => {
    const resolved = registry.resolve(
      modelWith({
        protocol: 'anthropic',
        supportEfforts: ['low', 'high'],
        providerOptions: { supportEfforts: ['low', 'high'], adaptiveThinking: true },
      }),
    );
    expect(resolved.model.maxContextSize).toBe(128000);
    expect(thinkingMetadataOf(resolved.model)).toMatchObject({
      supportEfforts: ['low', 'high'],
      adaptiveThinking: true,
    });
  });
});

describe('resolveProviderEndpoint', () => {
  it('resolves the kimi endpoint chain from process.env', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-env';
    expect(resolveProviderEndpoint('kimi')).toEqual({
      apiKey: 'sk-kimi-env',
      baseUrl: 'https://api.moonshot.ai/v1',
    });
  });

  it('reads a caller-supplied env bag instead of process.env', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-env';
    expect(resolveProviderEndpoint('kimi', { KIMI_BASE_URL: 'https://example.com/v1' })).toEqual({
      baseUrl: 'https://example.com/v1',
    });
  });

  it('aggregates the google-genai chain with the legacy vertex precedence', () => {
    expect(
      resolveProviderEndpoint('google-genai', {
        VERTEXAI_API_KEY: 'vertex-env-key',
        GOOGLE_API_KEY: 'google-env-key',
      }),
    ).toEqual({ apiKey: 'vertex-env-key' });
    expect(resolveProviderEndpoint('google-genai', { GOOGLE_API_KEY: 'google-env-key' })).toEqual({
      apiKey: 'google-env-key',
    });
    expect(
      resolveProviderEndpoint('google-genai', {
        GOOGLE_VERTEX_BASE_URL: 'https://vertex.example.test',
        GOOGLE_GEMINI_BASE_URL: 'https://gemini.example.test',
      }),
    ).toEqual({ baseUrl: 'https://vertex.example.test' });
    expect(
      resolveProviderEndpoint('google-genai', {
        GOOGLE_GEMINI_BASE_URL: 'https://gemini.example.test',
      }),
    ).toEqual({ baseUrl: 'https://gemini.example.test' });
  });

  it('returns {} for unregistered vendors', () => {
    expect(resolveProviderEndpoint('no-such-vendor')).toEqual({});
  });
});

describe('kimi provider definitions', () => {
  it('registers one definition per transport, with shared vendor-level facts', () => {
    const native = getProviderDefinition('kimi', 'openai');
    const anthropic = getProviderDefinition('kimi', 'anthropic');
    const responses = getProviderDefinition('kimi', 'openai_responses');
    expect(native?.baseProtocol).toBe('openai');
    expect(native?.trait).toBeDefined();
    expect(anthropic?.baseProtocol).toBe('anthropic');
    expect(anthropic?.trait).toBeDefined();
    expect(responses?.baseProtocol).toBe('openai_responses');
    expect(responses?.trait).toBeDefined();
    for (const definition of [native, anthropic, responses]) {
      expect(definition?.endpoint).toEqual({
        apiKeyEnv: 'KIMI_API_KEY',
        baseUrlEnv: 'KIMI_BASE_URL',
        defaultBaseUrl: 'https://api.moonshot.ai/v1',
      });
      expect(definition?.hostHeaders).toBe('full');
      expect(definition?.modelSource).toBe('oauth-catalog');
    }
  });

  it('answers id-level queries and reports unregistered pairs', () => {
    expect(getProviderDefinition('kimi')?.baseProtocol).toBe('openai');
    expect(getProviderDefinitions('kimi')).toHaveLength(3);
    expect(hasProviderDefinition('kimi')).toBe(true);
    expect(hasProviderDefinition('no-such-vendor')).toBe(false);
    expect(getProviderDefinition('kimi', 'google-genai')).toBeUndefined();
  });

  it('allows the same id on several protocols but rejects a duplicate (id, baseProtocol) pair', () => {
    registerProviderDefinition({
      id: 'pair-vendor',
      baseProtocol: 'openai',
    });
    registerProviderDefinition({
      id: 'pair-vendor',
      baseProtocol: 'anthropic',
    });
    expect(getProviderDefinition('pair-vendor', 'openai')).toBeDefined();
    expect(getProviderDefinition('pair-vendor', 'anthropic')).toBeDefined();
    expect(() =>
      registerProviderDefinition({
        id: 'pair-vendor',
        baseProtocol: 'openai',
      }),
    ).toThrow(/already registered/);
    expect(() =>
      registerProviderDefinition({
        id: 'kimi',
        baseProtocol: 'openai',
      }),
    ).toThrow(/already registered/);
  });
});
