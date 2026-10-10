/**
 * `kimi provider` CLI unit tests. The handlers receive an injected `getHarness`
 * + capturing stdout/stderr. Registry imports use a real harness and temporary
 * config storage; upstream HTTP responses are stubbed.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import type { KimiConfig, KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resetModelsDevUpstreamForTest,
  setModelsDevUpstreamForTest,
} from '@moonshot-ai/agent-core-v2/app/kosongConfig/modelsDevUpstream';

import { BUILT_IN_PROVIDERS } from '#/utils/built-in-providers';

import {
  handleCatalogAdd,
  handleCatalogList,
  handleProviderAdd,
  handleProviderAddBuiltin,
  handleProviderAddManual,
  handleProviderEdit,
  handleProviderList,
  handleProviderRemove,
  handleProviderTest,
  MANUAL_PROVIDER_TYPES,
  registerProviderCommand,
  requestUrl,
  type ProviderDeps,
} from '#/cli/sub/provider';

// Spy on the SDK harness factory so the default-deps construction can be
// asserted without booting a real engine. The real implementations stay in
// place for everything else the handlers use.
const harnessRouting = vi.hoisted(() => ({
  kimiHarnessConstructor: vi.fn(),
  harness: undefined as unknown,
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    createKimiHarness: (...args: unknown[]) => {
      harnessRouting.kimiHarnessConstructor(...args);
      return harnessRouting.harness;
    },
  };
});

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
  }
}

interface FakeHarness {
  ensureConfigFile: () => Promise<void>;
  getConfig: () => Promise<KimiConfig>;
  setConfig: (patch: Partial<KimiConfig>) => Promise<KimiConfig>;
  removeProvider: (providerId: string) => Promise<KimiConfig>;
  close: () => Promise<void>;
}

function makeHarness(initial: KimiConfig): {
  harness: FakeHarness;
  current: () => KimiConfig;
  setConfigCalls: Array<Partial<KimiConfig>>;
  removeCalls: string[];
} {
  // `persisted` simulates the on-disk config; the real RPC's `removeProvider`
  // reads from / writes to disk on every call. Tests must
  // model this: anything the handler builds up in its in-memory `config`
  // object disappears unless it is flushed via `setConfig` BEFORE the next
  // `removeProvider`.
  let persisted: KimiConfig = structuredClone(initial);
  const setConfigCalls: Array<Partial<KimiConfig>> = [];
  const removeCalls: string[] = [];
  const harness: FakeHarness = {
    ensureConfigFile: async () => {},
    getConfig: async () => structuredClone(persisted),
    setConfig: async (patch) => {
      setConfigCalls.push(structuredClone(patch));
      // Mirror the real `setKimiConfig`: deep-merge with undefined keys
      // skipped. This is
      // load-bearing for tests that assert `setConfig({defaultModel:
      // undefined})` does NOT wipe a key from disk — only `removeProvider`
      // can.
      const next: Record<string, unknown> = { ...persisted };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        next[key] = value;
      }
      persisted = next as KimiConfig;
      return structuredClone(persisted);
    },
    removeProvider: async (providerId) => {
      removeCalls.push(providerId);
      const nextProviders = { ...persisted.providers };
      delete nextProviders[providerId];
      const nextModels = { ...persisted.models };
      let removedDefault = false;
      for (const [alias, model] of Object.entries(nextModels)) {
        if (model.provider === providerId) {
          delete nextModels[alias];
          if (persisted.defaultModel === alias) removedDefault = true;
        }
      }
      persisted = { ...persisted, providers: nextProviders, models: nextModels };
      if (removedDefault) persisted = { ...persisted, defaultModel: undefined };
      return structuredClone(persisted);
    },
    close: async () => {},
  };
  return {
    harness,
    current: () => persisted,
    setConfigCalls,
    removeCalls,
  };
}

function makeDeps(
  harness: FakeHarness,
  overrides: Partial<ProviderDeps> = {},
): {
  deps: ProviderDeps;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const deps: ProviderDeps = {
    getHarness: () => harness as unknown as ProviderDeps extends { getHarness: () => infer R }
      ? R
      : never,
    stdout: {
      write: (chunk: string) => {
        stdout.push(chunk);
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr.push(chunk);
        return true;
      },
    },
    env: {},
    exit: ((code: number) => {
      exitCodes.push(code);
      throw new ExitCalled(code);
    }) as ProviderDeps['exit'],
    ...overrides,
  };
  return { deps, stdout, stderr, exitCodes };
}

async function tryRun<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ExitCalled) return undefined;
    throw error;
  }
}

const REGISTRY_URL = 'https://registry.example.test/v1/models/api.json';
const REGISTRY_BODY = {
  kohub: {
    id: 'kohub',
    name: 'KoHub Anthropic',
    api: 'https://registry.example.test',
    type: 'anthropic',
    models: {
      'claude-opus-4-7': { id: 'claude-opus-4-7', name: 'Claude Opus 4-7', tool_call: true },
    },
  },
  'kohub-responses': {
    id: 'kohub-responses',
    name: 'KoHub Responses',
    api: 'https://registry.example.test/v1',
    type: 'openai_responses',
    models: {
      'gpt-5.5': { id: 'gpt-5.5', name: 'GPT 5.5', reasoning: true },
    },
  },
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

const registryHarnesses: KimiHarness[] = [];

async function makeRegistryHarness(initial: KimiConfig) {
  const { createKimiHarness } = await vi.importActual<typeof import('@moonshot-ai/kimi-code-sdk')>(
    '@moonshot-ai/kimi-code-sdk',
  );
  const homeDir = await mkdtemp(join(tmpdir(), 'registry-cli-'));
  const harness = createKimiHarness({
    homeDir,
    identity: { productName: 'registry-test', version: '0.0.0-test', platform: 'test' },
  });
  registryHarnesses.push(harness);
  await harness.setConfig(initial);
  return { harness, current: () => harness.getConfig({ reload: true }) };
}

afterEach(async () => {
  for (const harness of registryHarnesses.splice(0)) {
    await harness.close();
    await rm(harness.homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
  resetModelsDevUpstreamForTest();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockRegistryFetch(body: unknown = REGISTRY_BODY, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  setModelsDevUpstreamForTest({ fetchImpl: globalThis.fetch });
  return fetchMock;
}

const CATALOG_BODY = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    npm: '@ai-sdk/anthropic',
    api: 'https://api.anthropic.com',
    env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-opus-4-7': {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        limit: { context: 200_000, output: 64_000 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        limit: { context: 200_000, output: 16_000 },
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    npm: '@ai-sdk/openai',
    api: 'https://api.openai.com/v1',
    env: ['OPENAI_API_KEY'],
    models: {
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT 5.5',
        limit: { context: 1_048_576, output: 128_000 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    },
  },
};

describe('kimi provider add', () => {
  it('imports providers and models from a custom registry, persisting source on each provider', async () => {
    const fetchMock = mockRegistryFetch();
    const { harness, current } = await makeRegistryHarness({ providers: {} } as KimiConfig);
    const { deps, stdout, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderAdd(deps, REGISTRY_URL, { apiKey: 'sk-test-token' }),
    );

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    expect(fetchMock).toHaveBeenCalledWith(
      REGISTRY_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test-token' }),
      }),
    );

    const finalConfig = (await current());
    expect(Object.keys(finalConfig.providers).toSorted()).toEqual(['kohub', 'kohub-responses']);
    const kohub = finalConfig.providers['kohub']!;
    expect(kohub.type).toBe('anthropic');
    expect(kohub.baseUrl).toBe('https://registry.example.test');
    expect(kohub.apiKey).toBe('sk-test-token');
    expect(kohub.source).toEqual({
      kind: 'apiJson',
      url: REGISTRY_URL,
      apiKey: 'sk-test-token',
    });

    expect(finalConfig.models?.['kohub/claude-opus-4-7']).toMatchObject({
      provider: 'kohub',
      model: 'claude-opus-4-7',
    });
    expect(finalConfig.models?.['kohub-responses/gpt-5.5']).toMatchObject({
      provider: 'kohub-responses',
      model: 'gpt-5.5',
    });

    const output = stdout.join('');
    expect(output).toContain('Imported 2 providers (2 models)');
    expect(output).toContain('- kohub');
    expect(output).toContain('- kohub-responses');
  });

  it('persists registry removals and clears dangling defaults', async () => {
    mockRegistryFetch();
    const initial: KimiConfig = {
      providers: {
        kohub: {
          type: 'anthropic',
          baseUrl: 'https://registry.example.test',
          apiKey: 'old',
          source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'old' },
        },
        gone: {
          type: 'openai',
          baseUrl: 'https://registry.example.test/gone',
          apiKey: 'old',
          source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'old' },
        },
      },
      models: {
        'gone/m1': { provider: 'gone', model: 'm1', maxContextSize: 1024, capabilities: [] },
      },
      defaultModel: 'gone/m1',
      thinking: { enabled: false },
    } as unknown as KimiConfig;
    const { harness, current } = await makeRegistryHarness(initial);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderAdd(deps, REGISTRY_URL, {}));

    expect(exitCodes).toEqual([]);
    expect((await current()).providers['gone']).toBeUndefined();
    expect((await current()).models?.['gone/m1']).toBeUndefined();
    expect((await current()).defaultModel).toBeUndefined();
    expect((await current()).thinking?.enabled).toBeUndefined();
  });

  it('reads the api key from KIMI_REGISTRY_API_KEY when --api-key is omitted', async () => {
    const fetchMock = mockRegistryFetch();
    const { harness } = await makeRegistryHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness, {
      env: { KIMI_REGISTRY_API_KEY: 'sk-env-token' },
    });

    await tryRun(() => handleProviderAdd(deps, REGISTRY_URL, {}));

    expect(exitCodes).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      REGISTRY_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-env-token' }),
      }),
    );
  });

  it('does not change the config when the registry has no usable providers', async () => {
    mockRegistryFetch({});
    const initial: KimiConfig = {
      providers: {
        kohub: {
          type: 'openai',
          baseUrl: 'https://registry.example.test/v1',
          apiKey: 'sk-old',
          source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'sk-old' },
        },
      },
      models: {
        'kohub/m1': { provider: 'kohub', model: 'm1', maxContextSize: 1024 },
      },
      defaultModel: 'kohub/m1',
    } as unknown as KimiConfig;
    const { harness, current } = await makeRegistryHarness(initial);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderAdd(deps, REGISTRY_URL, {}));

    expect(exitCodes).toEqual([1]);
    expect((await current())).toMatchObject(initial);
  });

  it('exits 1 when the registry fetch fails with an HTTP error', async () => {
    mockRegistryFetch({ message: 'invalid token' }, 401);
    const { harness } = await makeRegistryHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderAdd(deps, REGISTRY_URL, { apiKey: 'sk-bad' }),
    );

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toMatch(/HTTP 401/);
  });

  it('reuses the stored registry key when a re-import passes no key', async () => {
    const fetchMock = mockRegistryFetch();
    const initial: KimiConfig = {
      providers: {
        kohub: {
          type: 'anthropic',
          baseUrl: 'https://registry.example.test',
          apiKey: 'sk-stored',
          source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'sk-stored' },
        },
      },
    } as unknown as KimiConfig;
    const { harness } = await makeRegistryHarness(initial);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderAdd(deps, REGISTRY_URL, {}));

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    expect(fetchMock).toHaveBeenCalledWith(
      REGISTRY_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-stored' }),
      }),
    );
  });
});

describe('kimi provider add-manual', () => {
  const GW_URL = 'https://gw.example.test/v1';

  function stubModels(data: unknown, status = 200): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        status === 200
          ? new Response(JSON.stringify({ data }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          : new Response(JSON.stringify({ error: { message: 'nope' } }), { status }),
      ),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the provider and discovers its models from the endpoint', async () => {
    stubModels([
      { id: 'gw-fast', context_length: 200000 },
      { id: 'gw-smart' },
    ]);
    const { harness, current } = makeHarness({ providers: {}, models: {} } as KimiConfig);
    const { deps, stdout, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderAddManual(deps, 'mygw', {
        type: 'openai',
        baseUrl: GW_URL,
        apiKey: 'sk-test',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    expect(current().providers['mygw']).toMatchObject({
      type: 'openai',
      baseUrl: GW_URL,
      apiKey: 'sk-test',
    });
    const aliases = Object.keys(current().models ?? {});
    expect(aliases.toSorted()).toEqual(['mygw/gw-fast', 'mygw/gw-smart']);
    expect(stdout.join('')).toContain('mygw/gw-fast');
  });

  it('stores an api_key_env reference instead of the secret', async () => {
    stubModels([{ id: 'gw-fast' }]);
    const { harness, current } = makeHarness({ providers: {}, models: {} } as KimiConfig);
    const { deps } = makeDeps(harness, { env: { MY_GW_KEY: 'sk-from-env' } });

    await tryRun(() =>
      handleProviderAddManual(deps, 'mygw', {
        type: 'openai',
        baseUrl: GW_URL,
        apiKeyEnv: 'MY_GW_KEY',
      }),
    );

    expect(current().providers['mygw']).toMatchObject({ apiKeyEnv: 'MY_GW_KEY' });
    // The secret must never reach config.toml when an env var was requested.
    expect(JSON.stringify(current().providers['mygw'])).not.toContain('sk-from-env');
  });

  it('rejects a wire type the config schema does not define', async () => {
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    // `cohere` is not a wire in the config schema at all, so it must be
    // refused before anything reaches disk.
    await tryRun(() =>
      handleProviderAddManual(deps, 'mygw', {
        type: 'cohere',
        baseUrl: GW_URL,
        apiKey: 'sk-test',
      }),
    );

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Unsupported --type "cohere"');
  });

  it('accepts the anthropic wire, whose /models route uses x-api-key', async () => {
    stubModels([{ id: 'claude-x' }]);
    const { harness, current } = makeHarness({ providers: {}, models: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderAddManual(deps, 'myanth', {
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-test',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().providers['myanth']).toMatchObject({ type: 'anthropic' });
    // The probe must hit /v1/models, not the bare host the chat path uses.
    const probed = vi.mocked(fetch).mock.calls.at(-1)?.[0];
    expect(typeof probed === 'string' ? probed : '').toBe(
      'https://api.anthropic.com/v1/models',
    );
  });

  it('rejects a non-http base url', async () => {
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderAddManual(deps, 'mygw', {
        type: 'openai',
        baseUrl: 'file:///etc/passwd',
        apiKey: 'sk-test',
      }),
    );

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('--base-url must be http(s)');
  });

  it('refuses both an inline key and an env var', async () => {
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness, { env: { MY_GW_KEY: 'sk-env' } });

    await tryRun(() =>
      handleProviderAddManual(deps, 'mygw', {
        type: 'openai',
        baseUrl: GW_URL,
        apiKey: 'sk-test',
        apiKeyEnv: 'MY_GW_KEY',
      }),
    );

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('not both');
  });

  it('refuses to overwrite an existing provider', async () => {
    const { harness } = makeHarness({
      providers: { mygw: { type: 'openai', baseUrl: GW_URL, apiKey: 'sk-old' } },
    } as unknown as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderAddManual(deps, 'mygw', {
        type: 'openai',
        baseUrl: GW_URL,
        apiKey: 'sk-new',
      }),
    );

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('already exists');
  });

  it('keeps the provider and explains the manual fallback when discovery fails', async () => {
    stubModels([], 401);
    const { harness, current } = makeHarness({ providers: {}, models: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderAddManual(deps, 'mygw', {
        type: 'openai',
        baseUrl: GW_URL,
        apiKey: 'sk-wrong',
      }),
    );

    expect(exitCodes).toEqual([1]);
    // A failed discovery must not silently discard the provider the user asked for.
    expect(current().providers['mygw']).toBeDefined();
    expect(stderr.join('')).toContain('Model discovery failed');
    expect(stderr.join('')).toContain('config.toml');
  });

  it('reports an endpoint that lists no models', async () => {
    stubModels([]);
    const { harness, current } = makeHarness({ providers: {}, models: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderAddManual(deps, 'mygw', {
        type: 'openai',
        baseUrl: GW_URL,
        apiKey: 'sk-test',
      }),
    );

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('listed no models');
    expect(current().providers['mygw']).toBeDefined();
  });
});

describe('kimi provider add-builtin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('configures the built-in Cline endpoint and discovers its models', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-x' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { harness, current } = makeHarness({ providers: {}, models: {} } as KimiConfig);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderAddBuiltin(deps, 'cline', { apiKey: 'sk-test' }));

    expect(exitCodes).toEqual([]);
    expect(current().providers['cline']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://api.cline.bot/api/v1',
    });
    expect(Object.keys(current().models ?? {})).toEqual(['cline/anthropic/claude-x']);
    expect(stdout.join('')).toContain('Cline is ready');
  });

  it('writes a built-in per-model wire override into config', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { harness, current } = makeHarness({ providers: {}, models: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderAddBuiltin(deps, 'opencode-zen', { apiKey: 'sk-test' }));

    expect(exitCodes).toEqual([]);
    expect(current().providers['opencode-zen']?.protocolOverrides).toEqual({
      'claude-*': 'anthropic',
    });
    // And the pin must reach the alias, not just the provider record.
    expect(current().models?.['opencode-zen/claude-sonnet-4']).toMatchObject({
      protocol: 'anthropic',
    });
  });

  it('writes no override map for a built-in that declares none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: 'm1' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { harness, current } = makeHarness({ providers: {}, models: {} } as KimiConfig);
    const { deps } = makeDeps(harness);

    await tryRun(() => handleProviderAddBuiltin(deps, 'cline', { apiKey: 'sk-test' }));

    expect(current().providers['cline']).not.toHaveProperty('protocolOverrides');
    expect(current().models?.['cline/m1']).not.toHaveProperty('protocol');
  });

  it('warns but does not fail when a key does not match the vendor prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: 'm1' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { harness } = makeHarness({ providers: {}, models: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    // NVIDIA keys look like `nvapi-`; an OpenAI key is a realistic paste error
    // that otherwise surfaces as an opaque 401 on the models route.
    await tryRun(() => handleProviderAddBuiltin(deps, 'nvidia', { apiKey: 'sk-proj-wrong' }));

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toContain('does not start with "nvapi-"');
  });

  it('says nothing when the key carries the vendor prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: 'm1' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { harness } = makeHarness({ providers: {}, models: {} } as KimiConfig);
    const { deps, stderr } = makeDeps(harness);

    await tryRun(() => handleProviderAddBuiltin(deps, 'nvidia', { apiKey: 'nvapi-good' }));

    expect(stderr.join('')).toBe('');
  });

  it('configures every built-in vendor from the shared table', async () => {
    // Each vendor gets its own throwaway home so one config does not leak
    // providers into the next case.
    for (const builtin of BUILT_IN_PROVIDERS) {
      // Typed as `(...args: unknown[])` so the assertion below can read the
      // request URL out of the recorded call.
      const fetchMock = vi.fn(async (..._args: unknown[]) =>
        new Response(JSON.stringify({ data: [{ id: 'vendor/model-a' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const { harness, current } = makeHarness({ providers: {}, models: {} } as KimiConfig);
      const { deps, exitCodes } = makeDeps(harness);

      await tryRun(() => handleProviderAddBuiltin(deps, builtin.id, { apiKey: 'sk-test' }));

      expect(exitCodes, `${builtin.id} exited non-zero`).toEqual([]);
      expect(current().providers[builtin.id], `${builtin.id} not written`).toMatchObject({
        type: builtin.wire,
        baseUrl: builtin.baseUrl,
      });
      expect(
        Object.keys(current().models ?? {}),
        `${builtin.id} discovered no models`,
      ).toEqual([`${builtin.id}/vendor/model-a`]);
      // The probe must go to this vendor's own endpoint, and must honour the
      // wire's version convention: the Anthropic wire's chat base is a bare
      // host, so its model list needs the `/v1` segment re-added.
      const expected =
        builtin.wire === 'anthropic' ? `${builtin.baseUrl}/v1/models` : `${builtin.baseUrl}/models`;
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(expected);
    }
  });

  it('documents every vendor in the README table', async () => {
    const readme = await readFile(new URL('../../../../README.md', import.meta.url), 'utf8');

    // The README carried a stale seven-vendor table for a while, so the table in
    // code is the source of truth and the docs are pinned to it.
    for (const builtin of BUILT_IN_PROVIDERS) {
      expect(readme, `${builtin.id} missing from README`).toContain(
        `| \`${builtin.id}\` | ${builtin.name} | \`${builtin.baseUrl}\` |`,
      );
    }
    const documented = readme.match(/^\| `[a-z0-9-]+` \| [^|]+ \| `[^`]+` \|/gm) ?? [];
    expect(documented, 'README lists a vendor the table does not define').toHaveLength(
      BUILT_IN_PROVIDERS.length,
    );
  });

  it('keeps one entry per vendor with no duplicate ids or endpoints', () => {
    const ids = BUILT_IN_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of BUILT_IN_PROVIDERS) {
      // A wrong base URL silently sends the user's key to another host.
      expect(p.baseUrl, `${p.id} baseUrl must be https`).toMatch(/^https:\/\//);
      // Never point the SDK at a doubled version segment: the Anthropic and
      // Google SDKs append their own (`/v1/messages`, `/v1beta/…`), and the
      // OpenAI ones append `/chat/completions` to a base that already ends in
      // `/v1`. A vendor that serves its routes at the bare host (DeepSeek) is
      // fine, so this only rejects the `/v1/v1` shape.
      expect(p.baseUrl, `${p.id} must not double the version segment`).not.toMatch(/\/v1\/v1/);
      expect(p.baseUrl, `${p.id} must not include a completions path`).not.toMatch(
        /\/chat\/completions$/,
      );
    }
  });

  it('declares only wires the manual path accepts', () => {
    // A built-in whose `wire` is outside MANUAL_PROVIDER_TYPES is a trap:
    // `add-builtin` delegates to `add-manual`, which rejects the wire before
    // writing anything, so the entry looks supported and can never be added.
    // `vertexai` sat in this union for exactly that reason.
    const accepted = new Set<string>(MANUAL_PROVIDER_TYPES);
    for (const p of BUILT_IN_PROVIDERS) {
      expect(accepted.has(p.wire), `${p.id} declares wire "${p.wire}", which add-manual rejects`).toBe(
        true,
      );
    }
  });

  it('declares per-model wire overrides that the CLI accepts', () => {
    // Deliberately MANUAL_PROVIDER_TYPES rather than the `BuiltInProviderPin`
    // type: `kimi` is a provider wire but not a Protocol member, and an
    // override naming it would be dropped at the config boundary.
    const accepted = new Set<string>(MANUAL_PROVIDER_TYPES.filter((w) => w !== 'kimi'));
    for (const p of BUILT_IN_PROVIDERS) {
      for (const [pattern, wire] of Object.entries(p.protocolOverrides ?? {})) {
        expect(
          accepted.has(wire),
          `${p.id} override ${pattern} pins wire "${wire}", which ProtocolSchema rejects`,
        ).toBe(true);
        expect(pattern.length, `${p.id} override pattern must be an id or a glob`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it('pins OpenCode Zen Claude models to the Anthropic wire', () => {
    // The case the override exists for: Zen lists Claude models over an
    // OpenAI-shaped /models, but serves them on the Anthropic Messages API.
    const zen = BUILT_IN_PROVIDERS.find((p) => p.id === 'opencode-zen');
    expect(zen?.wire).toBe('openai');
    expect(zen?.protocolOverrides).toEqual({ 'claude-*': 'anthropic' });
  });

  it('maps every non-bearer auth style to a provider that declares it', () => {
    // A vendor that needs x-api-key / x-goog-api-key but does not declare it
    // gets a 401 that reads exactly like a bad key.
    for (const p of BUILT_IN_PROVIDERS) {
      if (p.authStyle === undefined) continue;
      expect(p.authStyle, `${p.id} declares a non-bearer style`).not.toBe('bearer');
    }
    expect(BUILT_IN_PROVIDERS.find((p) => p.id === 'anthropic')?.authStyle).toBe('x-api-key');
    expect(BUILT_IN_PROVIDERS.find((p) => p.id === 'gemini')?.authStyle).toBe('x-goog-api-key');
  });

  it('rejects an unknown built-in id and points at the catalog', async () => {
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderAddBuiltin(deps, 'nope', { apiKey: 'sk-test' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Unknown built-in provider "nope"');
    expect(stderr.join('')).toContain('catalog list');
  });
});

describe('kimi provider edit', () => {
  const EXISTING = {
    providers: {
      mygw: { type: 'openai', baseUrl: 'https://old.example.test/v1', apiKey: 'sk-old' },
    },
    models: { 'mygw/m1': { provider: 'mygw', model: 'm1', maxContextSize: 1024 } },
    defaultModel: 'mygw/m1',
  } as unknown as KimiConfig;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubModels(ids: readonly string[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  }

  it('changes the base url and keeps the provider models and default model', async () => {
    stubModels(['m1', 'm2']);
    const { harness, current } = makeHarness(EXISTING);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderEdit(deps, 'mygw', {
        baseUrl: 'https://new.example.test/v1',
        refresh: true,
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().providers['mygw']).toMatchObject({
      baseUrl: 'https://new.example.test/v1',
      apiKey: 'sk-old',
    });
    // Editing must not drop the default model or resurrect the old endpoint.
    expect(current().defaultModel).toBe('mygw/m1');
    expect(Object.keys(current().models ?? {}).toSorted()).toEqual(['mygw/m1', 'mygw/m2']);
    expect(stdout.join('')).toContain('Updated "mygw": baseUrl');
  });

  it('swaps an inline key for an env reference and back', async () => {
    const { harness, current } = makeHarness(EXISTING);
    const { deps } = makeDeps(harness, { env: { NEW_KEY: 'sk-env' } });

    await tryRun(() =>
      handleProviderEdit(deps, 'mygw', { apiKeyEnv: 'NEW_KEY', refresh: false }),
    );
    expect(current().providers['mygw']).toMatchObject({ apiKeyEnv: 'NEW_KEY' });
    // The runtime rejects a record carrying both, so the old key must be gone.
    expect(current().providers['mygw']).not.toHaveProperty('apiKey');

    await tryRun(() => handleProviderEdit(deps, 'mygw', { apiKey: 'sk-new', refresh: false }));
    expect(current().providers['mygw']).toMatchObject({ apiKey: 'sk-new' });
    expect(current().providers['mygw']).not.toHaveProperty('apiKeyEnv');
  });

  it('changes the wire protocol', async () => {
    const { harness, current } = makeHarness(EXISTING);
    const { deps } = makeDeps(harness);

    await tryRun(() =>
      handleProviderEdit(deps, 'mygw', { type: 'openai_responses', refresh: false }),
    );

    expect(current().providers['mygw']).toMatchObject({ type: 'openai_responses' });
  });

  it('refuses to run with no fields to change', async () => {
    const { harness, current } = makeHarness(EXISTING);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderEdit(deps, 'mygw', { refresh: false }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Nothing to change');
    expect(current().providers['mygw']).toMatchObject({ baseUrl: 'https://old.example.test/v1' });
  });

  it('lists the configured providers when the id is unknown', async () => {
    const { harness } = makeHarness(EXISTING);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderEdit(deps, 'nope', { refresh: false }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('not found');
    expect(stderr.join('')).toContain('mygw');
  });

  it('rejects a non-http base url', async () => {
    const { harness, current } = makeHarness(EXISTING);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderEdit(deps, 'mygw', { baseUrl: 'file:///etc/passwd' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('--base-url must be http(s)');
    expect(current().providers['mygw']).toMatchObject({ baseUrl: 'https://old.example.test/v1' });
  });

  it('rejects a base url carrying a pasted credential', async () => {
    const { harness, current } = makeHarness(EXISTING);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderEdit(deps, 'mygw', { baseUrl: 'https://me:sk-secret@old.example.test/v1' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('--base-url must not embed a username or password.');
    expect(stderr.join('')).not.toContain('sk-secret');
    expect(current().providers['mygw']).toMatchObject({ baseUrl: 'https://old.example.test/v1' });
  });

  it('keeps the change but reports the failure when the new endpoint rejects the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })),
    );
    const { harness, current } = makeHarness(EXISTING);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderEdit(deps, 'mygw', { apiKey: 'sk-wrong', refresh: true }),
    );

    expect(exitCodes).toEqual([1]);
    // The edit is saved; only the refresh failed, and the old models remain.
    expect(current().providers['mygw']).toMatchObject({ apiKey: 'sk-wrong' });
    expect(current().models?.['mygw/m1']).toBeDefined();
    expect(stderr.join('')).toContain('Model refresh failed');
  });

  it('refreshes by default through the real commander wiring', async () => {
    // The handler is not enough to cover the flag plumbing: commander's
    // `--no-refresh` writes `refresh`, so a wrong default there would skip
    // discovery on every real invocation while the handler tests still passed.
    stubModels(['m1']);
    const { harness, current } = makeHarness(EXISTING);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    const root = new Command('provider');
    registerProviderCommand(root, deps);
    // registerProviderCommand attaches a `provider` subcommand, so the edit
    // command is reached through it rather than off the root.
    await tryRun(() =>
      root.parseAsync(
        ['provider', 'edit', 'mygw', '--base-url', 'https://new.example.test/v1'],
        { from: 'user' },
      ),
    );

    expect(exitCodes).toEqual([]);
    expect(current().providers['mygw']).toMatchObject({ baseUrl: 'https://new.example.test/v1' });
    expect(Object.keys(current().models ?? {})).toContain('mygw/m1');
    expect(stdout.join('')).not.toContain('Skipped model refresh');
  });

  it('skips the refresh with --no-refresh and does not touch the endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { harness, current } = makeHarness(EXISTING);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleProviderEdit(deps, 'mygw', { baseUrl: 'https://n2.test/v1', refresh: false }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdout.join('')).toContain('Skipped model refresh');
    expect(current().providers['mygw']).toMatchObject({ baseUrl: 'https://n2.test/v1' });
  });
});

describe('kimi provider remove', () => {
  it('removes a provider and reports success', async () => {
    const initial: KimiConfig = {
      providers: {
        kohub: { type: 'anthropic', baseUrl: 'https://x', apiKey: 'k' },
      },
      models: {
        'kohub/m': {
          provider: 'kohub',
          model: 'm',
          maxContextSize: 1024,
          capabilities: [],
        },
      },
    } as unknown as KimiConfig;
    const { harness, removeCalls, current } = makeHarness(initial);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderRemove(deps, 'kohub'));

    expect(exitCodes).toEqual([]);
    expect(removeCalls).toEqual(['kohub']);
    expect(current().providers['kohub']).toBeUndefined();
    expect(stdout.join('')).toContain('Removed provider "kohub"');
  });

  it('exits 1 when the provider id does not exist', async () => {
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderRemove(deps, 'nope'));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Provider "nope" not found');
  });
});

describe('kimi provider list', () => {
  const config: KimiConfig = {
    providers: {
      kohub: {
        type: 'anthropic',
        baseUrl: 'https://x',
        apiKey: 'k',
        source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'k' },
      },
      'managed:kimi-code': {
        type: 'kimi',
        baseUrl: 'https://api.kimi.com/coding/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      manual: { type: 'openai', baseUrl: 'https://y', apiKey: 'm' },
    },
    models: {
      'kohub/a': {
        provider: 'kohub',
        model: 'a',
        maxContextSize: 1024,
        capabilities: [],
      },
      'kohub/b': {
        provider: 'kohub',
        model: 'b',
        maxContextSize: 1024,
        capabilities: [],
      },
      'manual/x': {
        provider: 'manual',
        model: 'x',
        maxContextSize: 1024,
        capabilities: [],
      },
    },
    defaultModel: 'kohub/a',
  } as unknown as KimiConfig;

  it('renders one row per provider with counts and source labels', async () => {
    const { harness } = makeHarness(config);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleProviderList(deps, { json: false }));

    const out = stdout.join('');
    expect(out).toMatch(/kohub\s+type=anthropic\s+models=2\s+source=apiJson\(/);
    expect(out).toMatch(/managed:kimi-code\s+type=kimi\s+models=0\s+source=oauth/);
    expect(out).toMatch(/manual\s+type=openai\s+models=1\s+source=inline/);
    expect(out).toContain('Default model: kohub/a');
  });

  it('prints a friendly message when nothing is configured', async () => {
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleProviderList(deps, { json: false }));

    expect(stdout.join('')).toContain('No providers configured');
  });

  it('emits parseable JSON with --json', async () => {
    const { harness } = makeHarness(config);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleProviderList(deps, { json: true }));

    const parsed = JSON.parse(stdout.join('')) as {
      providers: Record<string, unknown>;
      models: Record<string, unknown>;
    };
    expect(Object.keys(parsed.providers).toSorted()).toEqual([
      'kohub',
      'managed:kimi-code',
      'manual',
    ]);
    expect(Object.keys(parsed.models)).toContain('kohub/a');
  });
});

describe('registerProviderCommand', () => {
  it('describes the user-facing subcommand and routes flags through commander', async () => {
    const fetchMock = mockRegistryFetch();
    const { harness, current } = await makeRegistryHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes, stdout } = makeDeps(harness);

    const program = new Command('kimi');
    registerProviderCommand(program, deps);

    const providerCmd = program.commands.find((c) => c.name() === 'provider');
    expect(providerCmd?.description()).toMatch(/Manage LLM providers/i);

    await tryRun(() =>
      program.parseAsync(
        ['node', 'kimi', 'provider', 'add', REGISTRY_URL, '--api-key', 'sk-cli'],
        { from: 'node' },
      ),
    );

    expect(exitCodes).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      REGISTRY_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-cli' }),
      }),
    );
    expect(Object.keys((await current()).providers).toSorted()).toEqual(['kohub', 'kohub-responses']);
    expect(stdout.join('')).toContain('Imported 2 providers');
  });

  it('reports write failures on stderr and exits 1 instead of crashing', async () => {
    const { harness } = makeHarness({
      providers: { kimi: { type: 'kimi' } },
    } as unknown as KimiConfig);
    // Simulate the strict write path rejecting because config.toml is invalid.
    harness.removeProvider = async () => {
      throw new Error(
        'Cannot change settings while config.toml is invalid — fix it first (run `kimi doctor` for details).',
      );
    };
    const { deps, stderr, exitCodes } = makeDeps(harness);

    const program = new Command('kimi');
    registerProviderCommand(program, deps);

    await tryRun(() =>
      program.parseAsync(['node', 'kimi', 'provider', 'remove', 'kimi'], { from: 'node' }),
    );

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Cannot change settings');
    expect(stderr.join('')).not.toContain('    at '); // no stack trace dump
  });
});

describe('kimi provider catalog list', () => {
  it('lists catalog providers with wire/model counts, sorted by id', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogList(deps, undefined, { json: false }));

    expect(exitCodes).toEqual([]);
    const out = stdout.join('');
    expect(out).toMatch(/^anthropic\s+wire=anthropic\s+models=2\s+Anthropic\n/);
    expect(out).toMatch(/openai\s+wire=openai\s+models=1\s+OpenAI/);
    // anthropic before openai (alphabetical).
    expect(out.indexOf('anthropic')).toBeLessThan(out.indexOf('openai'));
  });

  it('filters case-insensitively by id and name substring', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleCatalogList(deps, undefined, { json: false, filter: 'open' }));

    const out = stdout.join('');
    expect(out).toContain('openai');
    expect(out).not.toContain('anthropic');
  });

  it('drills into a specific providerId and lists its models with capabilities', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleCatalogList(deps, 'anthropic', { json: false }));

    const out = stdout.join('');
    expect(out).toMatch(/^Anthropic \(anthropic\)/);
    expect(out).toMatch(/claude-opus-4-7\s+ctx=200000.*tool_use.*thinking.*image_in/);
    expect(out).toMatch(/claude-haiku-4-5\s+ctx=200000.*tool_use/);
  });

  it('exits 1 when the requested providerId is missing from the catalog', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogList(deps, 'unknown', { json: false }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Provider "unknown" not found in catalog');
  });

  it('emits parseable JSON for the providerId view', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleCatalogList(deps, 'openai', { json: true }));

    const parsed = JSON.parse(stdout.join('')) as {
      providerId: string;
      models: Array<{ id: string }>;
    };
    expect(parsed.providerId).toBe('openai');
    expect(parsed.models.map((m) => m.id)).toEqual(['gpt-5.5']);
  });

  it('honors --url override when supplied', async () => {
    const fetchMock = mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogList(deps, undefined, { json: true, url: 'https://example.test/catalog.json' }),
    );

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/catalog.json', expect.any(Object));
  });
});

describe('kimi provider catalog add', () => {
  it('imports a provider from the catalog without changing the default model', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const initial: KimiConfig = {
      providers: {
        other: { type: 'kimi', baseUrl: 'https://x', apiKey: 'k' },
      },
      models: {
        'other/main': {
          provider: 'other',
          model: 'main',
          maxContextSize: 1024,
          capabilities: [],
        },
      },
      defaultModel: 'other/main',
      thinking: { enabled: true },
    } as unknown as KimiConfig;
    const { harness, current, setConfigCalls } = makeHarness(initial);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'anthropic', { apiKey: 'sk-ant-token' }),
    );

    expect(exitCodes).toEqual([]);
    const finalConfig = current();
    expect(finalConfig.providers['anthropic']).toMatchObject({
      type: 'anthropic',
      apiKey: 'sk-ant-token',
    });
    // Catalog import populates the model aliases.
    expect(finalConfig.models?.['anthropic/claude-opus-4-7']).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    });
    expect(finalConfig.models?.['anthropic/claude-haiku-4-5']).toBeDefined();
    // The unrelated provider's model survives, and remains the default.
    expect(finalConfig.models?.['other/main']).toBeDefined();
    expect(finalConfig.defaultModel).toBe('other/main');
    expect(finalConfig.thinking?.enabled).toBe(true);
    // The patch sent over `setConfig` must explicitly carry the preserved default.
    expect(setConfigCalls[0]?.defaultModel).toBe('other/main');
    expect(stdout.join('')).toContain('Imported Anthropic (anthropic)');
  });

  it('sets default_model when --default-model is supplied and the model exists', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness, current, setConfigCalls } = makeHarness({
      providers: {},
    } as KimiConfig);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'anthropic', {
        apiKey: 'sk-ant-token',
        defaultModel: 'claude-opus-4-7',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().defaultModel).toBe('anthropic/claude-opus-4-7');
    expect(setConfigCalls[0]?.defaultModel).toBe('anthropic/claude-opus-4-7');
    expect(stdout.join('')).toContain('Default model set to anthropic/claude-opus-4-7');
  });

  it('rejects an unknown --default-model with a helpful hint', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'anthropic', {
        apiKey: 'sk-ant-token',
        defaultModel: 'does-not-exist',
      }),
    );

    expect(exitCodes).toEqual([1]);
    const err = stderr.join('');
    expect(err).toContain('"does-not-exist" is not in provider "anthropic"');
    expect(err).toContain('kimi provider catalog list anthropic');
  });

  it('preserves an existing default_model when re-importing the same provider without --default-model', async () => {
    // Regression test for the codex P2: `removeProvider` clears
    // `defaultModel` if it pointed at one of the provider's aliases. The
    // handler must capture the previous default BEFORE calling
    // `removeProvider`, otherwise rotating the api key on an already-
    // configured provider would silently wipe the user's chosen default.
    mockRegistryFetch(CATALOG_BODY);
    const initial: KimiConfig = {
      providers: {
        anthropic: {
          type: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-old',
        },
      },
      models: {
        'anthropic/claude-opus-4-7': {
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          maxContextSize: 200_000,
          capabilities: ['tool_use', 'thinking', 'image_in'],
        },
      },
      defaultModel: 'anthropic/claude-opus-4-7',
      thinking: { enabled: true },
    } as unknown as KimiConfig;
    const { harness, current } = makeHarness(initial);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'anthropic', { apiKey: 'sk-rotated' }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().providers['anthropic']?.apiKey).toBe('sk-rotated');
    // Previous default and thinking flag must survive the re-import.
    expect(current().defaultModel).toBe('anthropic/claude-opus-4-7');
    expect(current().thinking?.enabled).toBe(true);
  });

  it('preserves thinking.enabled when --default-model is supplied to a thinking-capable model', async () => {
    // Regression test for the codex P2: `applyCatalogProvider` always
    // assigns `thinking.enabled` from `options.thinking`. Hardcoding `false`
    // silently disabled thinking even when the user previously had it on
    // and is just importing a known provider. The handler now threads the
    // previous value through.
    mockRegistryFetch(CATALOG_BODY);
    const initial: KimiConfig = {
      providers: {},
      thinking: { enabled: true },
    } as unknown as KimiConfig;
    const { harness, current, setConfigCalls } = makeHarness(initial);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'anthropic', {
        apiKey: 'sk-ant',
        defaultModel: 'claude-opus-4-7',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().defaultModel).toBe('anthropic/claude-opus-4-7');
    expect(current().thinking?.enabled).toBe(true);
    expect(setConfigCalls[0]?.thinking?.enabled).toBe(true);
  });

  it('does not persist thinking.enabled=false for first-time setup with --default-model', async () => {
    // Regression test for codex P2 follow-up: previously the handler fell
    // back to `false` when `thinking.enabled` was unset, but
    // `resolveThinkingEffort` treats `thinking.enabled === false` as an
    // explicit "off" request. A fresh `kimi provider catalog add
    // anthropic --default-model claude-opus-4-7` must NOT silently disable
    // thinking — it should leave `thinking.enabled` unset so the runtime
    // uses the per-model default.
    mockRegistryFetch(CATALOG_BODY);
    // Note: `thinking.enabled` is omitted on purpose to model a fresh user.
    const { harness, current, setConfigCalls } = makeHarness({
      providers: {},
    } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'anthropic', {
        apiKey: 'sk-ant',
        defaultModel: 'claude-opus-4-7',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().defaultModel).toBe('anthropic/claude-opus-4-7');
    // Must NOT be `false`. `undefined` lets the runtime resolver pick the
    // per-model default; `false` would force `'off'`.
    expect(current().thinking?.enabled).toBeUndefined();
    expect(setConfigCalls[0]?.thinking?.enabled).toBeUndefined();
  });

  it('drops a stale default_model when the catalog refresh no longer contains it', async () => {
    // Regression test for codex P2: when the user previously chose
    // `anthropic/legacy` as default and a refresh of the same provider no
    // longer ships that model, restoring the previous default would point
    // `default_model` at a non-existent alias and break the next session.
    // The handler now checks whether the alias still resolves and clears
    // it otherwise.
    mockRegistryFetch(CATALOG_BODY);
    const initial: KimiConfig = {
      providers: {
        anthropic: {
          type: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-old',
        },
      },
      models: {
        'anthropic/legacy-claude': {
          provider: 'anthropic',
          model: 'legacy-claude',
          maxContextSize: 200_000,
          capabilities: [],
        },
      },
      defaultModel: 'anthropic/legacy-claude',
    } as unknown as KimiConfig;
    const { harness, current } = makeHarness(initial);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'anthropic', { apiKey: 'sk-rotated' }),
    );

    expect(exitCodes).toEqual([]);
    // The legacy alias must have been replaced by the catalog's models.
    expect(current().models?.['anthropic/legacy-claude']).toBeUndefined();
    expect(current().models?.['anthropic/claude-opus-4-7']).toBeDefined();
    // The dangling default must NOT have been restored — it would point at
    // a non-existent alias. The handler clears it instead.
    expect(current().defaultModel).toBeUndefined();
  });

  it('falls back to KIMI_REGISTRY_API_KEY when --api-key is omitted', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness, {
      env: { KIMI_REGISTRY_API_KEY: 'sk-env' },
    });

    await tryRun(() => handleCatalogAdd(deps, 'openai', {}));

    expect(exitCodes).toEqual([]);
    expect(current().providers['openai']).toMatchObject({ apiKey: 'sk-env' });
  });

  it('lets --base-url override the catalog-declared endpoint', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'openai', {
        apiKey: 'sk-o',
        baseUrl: 'https://proxy.example.test/v1',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().providers['openai']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://proxy.example.test/v1',
    });
  });

  it('strips a trailing /v1 from --base-url for Anthropic-wire imports', async () => {
    mockRegistryFetch({
      'claude-gateway': {
        id: 'claude-gateway',
        name: 'Claude Gateway',
        npm: '@custom/claude-gateway',
        models: { 'claude-x': { id: 'claude-x', limit: { context: 1000 } } },
      },
    });
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'claude-gateway', {
        apiKey: 'sk-gw',
        baseUrl: 'https://claude-gateway.example.test/v1',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().providers['claude-gateway']).toMatchObject({
      type: 'anthropic',
      // The Anthropic SDK appends /v1/messages itself — persisting the /v1
      // would double it (/v1/v1/messages).
      baseUrl: 'https://claude-gateway.example.test',
    });
  });

  it('rejects an empty --base-url instead of persisting a blank endpoint', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'openai', { apiKey: 'sk-o', baseUrl: '   ' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('--base-url cannot be empty');
    await expect(harness.getConfig().then((c) => c.providers['openai'])).resolves.toBeUndefined();
  });

  it('requires --base-url for a non-official Anthropic-compatible vendor without one', async () => {
    mockRegistryFetch({
      'claude-gateway': {
        id: 'claude-gateway',
        name: 'Claude Gateway',
        npm: '@custom/claude-gateway',
        models: { 'claude-x': { id: 'claude-x', limit: { context: 1000 } } },
      },
    });
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'claude-gateway', { apiKey: 'sk-gw' }));
    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('--base-url');

    await tryRun(() =>
      handleCatalogAdd(deps, 'claude-gateway', {
        apiKey: 'sk-gw',
        baseUrl: 'https://claude-gateway.example.test',
      }),
    );
    expect(current().providers['claude-gateway']).toMatchObject({
      type: 'anthropic',
      baseUrl: 'https://claude-gateway.example.test',
    });
  });

  it('exits 1 when the api key is missing and skips the network', async () => {
    const fetchMock = mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'anthropic', {}));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toMatch(/missing api key/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exits 1 when the providerId is missing from the catalog', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'no-such-id', { apiKey: 'sk-x' }),
    );

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Provider "no-such-id" not found in catalog');
  });

  const GUESS_CATALOG_BODY = {
    xai: {
      id: 'xai',
      name: 'xAI',
      npm: '@ai-sdk/xai',
      env: ['XAI_API_KEY'],
      models: {
        'grok-4': {
          id: 'grok-4',
          limit: { context: 256_000 },
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }],
        },
      },
    },
    bedrock: {
      id: 'amazon-bedrock',
      name: 'Amazon Bedrock',
      npm: '@ai-sdk/amazon-bedrock',
      models: { 'claude-x': { id: 'claude-x', limit: { context: 1000 } } },
    },
    azure: {
      id: 'azure',
      name: 'Azure',
      npm: '@ai-sdk/azure',
      env: ['AZURE_API_KEY'],
      models: { 'gpt-x': { id: 'gpt-x', limit: { context: 1000 } } },
    },
  };

  it('guesses openai for a vendor-specific SDK and requires --base-url', async () => {
    mockRegistryFetch(GUESS_CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'xai', { apiKey: 'sk-xai' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('--base-url');
    await expect(harness.getConfig().then((c) => c.providers['xai'])).resolves.toBeUndefined();
  });

  it('imports a guessed vendor with --base-url, carrying off_effort and a guess note', async () => {
    mockRegistryFetch(GUESS_CATALOG_BODY);
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'xai', { apiKey: 'sk-xai', baseUrl: 'https://api.x.ai/v1' }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().providers['xai']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'sk-xai',
    });
    expect(current().models?.['xai/grok-4']).toMatchObject({
      supportEfforts: ['low', 'medium', 'high'],
      offEffort: 'none',
    });
    expect(stdout.join('')).toContain('guessed "openai"');
  });

  it('refuses a proprietary SDK (bedrock) instead of guessing', async () => {
    mockRegistryFetch(GUESS_CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'bedrock', { apiKey: 'sk-x' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('proprietary');
  });

  it('requires --base-url for a vendor with no catalog endpoint (azure shape)', async () => {
    mockRegistryFetch(GUESS_CATALOG_BODY);
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'azure', { apiKey: 'sk-az' }));
    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('--base-url');

    await tryRun(() =>
      handleCatalogAdd(deps, 'azure', { apiKey: 'sk-az', baseUrl: 'https://res.example.test/openai/v1' }),
    );
    expect(current().providers['azure']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://res.example.test/openai/v1',
    });
  });
});

describe('kimi provider engine routing', () => {
  beforeEach(() => {
    harnessRouting.kimiHarnessConstructor.mockClear();
    harnessRouting.harness = makeHarness({ providers: {} } as KimiConfig).harness;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function registerWithDefaultHarness(program: Command): void {
    registerProviderCommand(program, {
      stdout: { write: () => true },
      stderr: { write: () => true },
      env: {},
      exit: ((code: number) => {
        throw new ExitCalled(code);
      }) as ProviderDeps['exit'],
    });
  }

  it('builds the harness through the SDK factory', async () => {
    const program = new Command('kimi');
    registerWithDefaultHarness(program);

    await program.parseAsync(['node', 'kimi', 'provider', 'list'], { from: 'node' });

    expect(harnessRouting.kimiHarnessConstructor).toHaveBeenCalledTimes(1);
  });
});

describe('kimi provider test', () => {
  const GATEWAY = 'https://gw.example.test/v1';
  const SECRET = 'sk-super-secret';

  /**
   * Matches one `[n/5] <stage> <STATUS> <detail>` line regardless of column
   * padding, so the assertions pin what each stage *reported* instead of how
   * many spaces the formatter emitted.
   */
  function stageLine(index: number, stage: string, status: string, detail: string): RegExp {
    return new RegExp(`^\\[${String(index)}/5\\] ${stage}\\s+${status}\\s+${detail}$`, 'm');
  }

  function gatewayConfig(provider: Record<string, unknown>, models?: Record<string, unknown>): KimiConfig {
    return {
      providers: { mygw: { type: 'openai', baseUrl: GATEWAY, ...provider } },
      models: {
        'mygw/quick': { provider: 'mygw', model: 'gpt-4o-mini', maxContextSize: 128000 },
        ...models,
      },
    } as unknown as KimiConfig;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  /** Healthy gateway: reachable host, two listed models, a completable chat request. */
  function happyRoute(url: string): Response {
    if (url.endsWith('/models')) {
      return jsonResponse({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] });
    }
    if (url.endsWith('/chat/completions')) {
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'pong' } }] });
    }
    return jsonResponse({ ok: true });
  }

  function stubProbeFetch(
    route: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  ): { calls: Array<{ url: string; headers: Record<string, string> }> } {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        calls.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
        return route(url, init);
      }),
    );
    return { calls };
  }

  function gatewayDeps(overrides: Partial<ProviderDeps> = {}): ReturnType<typeof makeDeps> {
    const { harness } = makeHarness(gatewayConfig({ apiKey: SECRET }));
    return makeDeps(harness, overrides);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs all five stages and never prints the credential', async () => {
    const { calls } = stubProbeFetch(happyRoute);
    const { deps, stdout, stderr, exitCodes } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    const out = stdout.join('');
    expect(exitCodes).toEqual([]);
    expect(stderr).toEqual([]);
    expect(out).toContain('Provider test: mygw');
    expect(out).toMatch(stageLine(1, 'config', 'OK', `configured \\(type=openai, base_url=${GATEWAY}\\)`));
    expect(out).toMatch(stageLine(2, 'credential', 'OK', 'PRESENT \\(api_key from config.toml\\)'));
    expect(out).toMatch(stageLine(3, 'connectivity', 'OK', 'endpoint answered \\(HTTP 200\\)'));
    expect(out).toMatch(stageLine(4, 'models', 'OK', '2 models listed'));
    expect(out).toMatch(
      stageLine(
        5,
        'request',
        'OK',
        'minimal request succeeded via alias "mygw/quick" \\(model gpt-4o-mini, \\d+ ms\\)',
      ),
    );
    expect(out).toContain('All stages passed (5 passed, 0 failed, 0 skipped).');
    expect(`${out}${stderr.join('')}`).not.toContain(SECRET);

    const modelsCall = calls.find((call) => call.url.endsWith('/models'));
    const chatCall = calls.find((call) => call.url.endsWith('/chat/completions'));
    expect(modelsCall?.url).toBe(`${GATEWAY}/models`);
    expect(modelsCall?.headers['Authorization']).toBe(`Bearer ${SECRET}`);
    expect(chatCall?.url).toBe(`${GATEWAY}/chat/completions`);
    expect(chatCall?.headers['Authorization']).toBe(`Bearer ${SECRET}`);
  });

  it('renders the stage columns the way the summary reads back', async () => {
    stubProbeFetch(happyRoute);
    const { deps, stdout } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stdout.join('')).toContain('[1/5] config       OK     configured (type=openai');
    expect(stdout.join('')).toContain('[5/5] request      OK     minimal request succeeded');
  });

  it('reports api_key_env as missing when the variable is unset, and keeps testing', async () => {
    stubProbeFetch(happyRoute);
    const { harness } = makeHarness(gatewayConfig({ apiKeyEnv: 'MYGW_KEY' }));
    const { deps, stdout, stderr, exitCodes } = makeDeps(harness, { env: {} });

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stderr.join('')).toMatch(
      stageLine(2, 'credential', 'FAIL', 'MISSING \\(api_key_env "MYGW_KEY" is not set or is empty\\)'),
    );
    // Stages 3-5 still ran: an unset variable and a dead endpoint are different bugs.
    expect(stdout.join('')).toMatch(stageLine(4, 'models', 'OK', '2 models listed'));
    expect(stdout.join('')).toMatch(stageLine(5, 'request', 'OK', '.*'));
    expect(stderr.join('')).toContain('Provider test failed (4 passed, 1 failed, 0 skipped).');
    expect(exitCodes).toEqual([1]);
  });

  it('reports api_key_env as present once the variable is exported', async () => {
    stubProbeFetch(happyRoute);
    const { harness } = makeHarness(gatewayConfig({ apiKeyEnv: 'MYGW_KEY' }));
    const { deps, stdout, exitCodes } = makeDeps(harness, { env: { MYGW_KEY: ' sk-from-env ' } });

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stdout.join('')).toMatch(stageLine(2, 'credential', 'OK', 'PRESENT \\(api_key_env "MYGW_KEY"\\)'));
    expect(stdout.join('')).toContain('All stages passed (5 passed, 0 failed, 0 skipped).');
    expect(exitCodes).toEqual([]);
  });

  it('sends the env-resolved credential on the minimal request', async () => {
    const { calls } = stubProbeFetch(happyRoute);
    const { harness } = makeHarness(gatewayConfig({ apiKeyEnv: 'MYGW_KEY' }));
    const { deps, stdout } = makeDeps(harness, { env: { MYGW_KEY: 'sk-from-env' } });

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    const chatCall = calls.find((call) => call.url.endsWith('/chat/completions'));
    expect(chatCall?.headers['Authorization']).toBe('Bearer sk-from-env');
    expect(stdout.join('')).toMatch(stageLine(5, 'request', 'OK', '.*'));
  });

  it('names the conflicting credential sources instead of picking one', async () => {
    stubProbeFetch(happyRoute);
    const { harness } = makeHarness(gatewayConfig({ apiKey: SECRET, apiKeyEnv: 'MYGW_KEY' }));
    const { deps, stderr, exitCodes } = makeDeps(harness, { env: { MYGW_KEY: 'sk-from-env' } });

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stderr.join('')).toMatch(
      stageLine(2, 'credential', 'FAIL', 'MISSING \\(Provider "mygw" has both apiKey and apiKeyEnv set.*\\)'),
    );
    expect(exitCodes).toEqual([1]);
  });

  it('resolves an oauth credential through the harness without printing it', async () => {
    const { calls } = stubProbeFetch(happyRoute);
    const base = makeHarness({
      providers: { mygw: { type: 'openai', baseUrl: GATEWAY, oauth: { storage: 'file', key: 'mygw' } } },
      models: { 'mygw/quick': { provider: 'mygw', model: 'gpt-4o-mini' } },
    } as unknown as KimiConfig);
    const getAccessToken = vi.fn(async () => 'oauth-access-token');
    const harness = {
      ...base.harness,
      auth: { resolveOAuthTokenProvider: vi.fn(() => ({ getAccessToken })) },
    };
    const { deps, stdout, stderr, exitCodes } = makeDeps(harness as unknown as FakeHarness);

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(stdout.join('')).toMatch(stageLine(2, 'credential', 'OK', 'PRESENT \\(oauth token "mygw"\\)'));
    expect(calls.find((call) => call.url.endsWith('/chat/completions'))?.headers['Authorization']).toBe(
      'Bearer oauth-access-token',
    );
    expect(`${stdout.join('')}${stderr.join('')}`).not.toContain('oauth-access-token');
    expect(exitCodes).toEqual([]);
  });

  it('classifies a 401 from model discovery as unauthorized', async () => {
    stubProbeFetch((url) => (url.endsWith('/models') ? jsonResponse({ error: 'bad key' }, 401) : happyRoute(url)));
    const { deps, stdout, stderr, exitCodes } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stderr.join('')).toMatch(stageLine(4, 'models', 'FAIL', `unauthorized \\(HTTP 401 at ${GATEWAY}/models\\)`));
    expect(stdout.join('')).toMatch(stageLine(5, 'request', 'OK', '.*'));
    expect(exitCodes).toEqual([1]);
  });

  it('classifies a 429 from model discovery as rate limited', async () => {
    stubProbeFetch((url) => (url.endsWith('/models') ? jsonResponse({ error: 'slow down' }, 429) : happyRoute(url)));
    const { deps, stderr } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stderr.join('')).toMatch(stageLine(4, 'models', 'FAIL', 'rate limited \\(HTTP 429 at .*\\)'));
  });

  it('classifies a DNS failure by its syscall code', async () => {
    stubProbeFetch(() => {
      throw Object.assign(new Error('getaddrinfo EAI_AGAIN gw.example.test'), { code: 'EAI_AGAIN' });
    });
    const { deps, stderr, exitCodes } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stderr.join('')).toMatch(stageLine(3, 'connectivity', 'FAIL', 'unreachable: host lookup failed \\(EAI_AGAIN\\)'));
    expect(stderr.join('')).toMatch(stageLine(4, 'models', 'FAIL', 'unreachable: host lookup failed \\(EAI_AGAIN\\)'));
    expect(exitCodes).toEqual([1]);
  });

  it('digs the syscall code out of the cause fetch wraps it in', async () => {
    stubProbeFetch(() => {
      const socket = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
      throw new TypeError('fetch failed', { cause: socket });
    });
    const { deps, stderr, exitCodes } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stderr.join('')).toMatch(stageLine(3, 'connectivity', 'FAIL', 'unreachable: connection refused \\(ECONNREFUSED\\)'));
    expect(stderr.join('')).not.toContain('fetch failed');
    expect(exitCodes).toEqual([1]);
  });

  it('falls back to the cause message when the chain carries no code', async () => {
    stubProbeFetch(() => {
      throw new TypeError('fetch failed', { cause: new Error('other side closed') });
    });
    const { deps, stderr, exitCodes } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stderr.join('')).toMatch(stageLine(3, 'connectivity', 'FAIL', 'request failed: other side closed'));
    expect(stderr.join('')).not.toContain('fetch failed');
    expect(exitCodes).toEqual([1]);
  });

  it('reports a stalled request as a timeout, not a hang', async () => {
    stubProbeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const { deps, stderr, exitCodes } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'mygw', { timeoutMs: 5 }));

    expect(stderr.join('')).toMatch(stageLine(3, 'connectivity', 'FAIL', 'timeout: no response within 5 ms'));
    expect(exitCodes).toEqual([1]);
  });

  it('reports a discovery payload it cannot read as a malformed response', async () => {
    stubProbeFetch((url) => (url.endsWith('/models') ? jsonResponse({ oops: true }) : happyRoute(url)));
    const { deps, stderr } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stderr.join('')).toMatch(
      stageLine(4, 'models', 'FAIL', `malformed response at ${GATEWAY}/models: Unexpected models response at .*`),
    );
  });

  it('skips the network stages when no base_url is configured', async () => {
    const { calls } = stubProbeFetch(happyRoute);
    const { harness } = makeHarness({
      providers: { mygw: { type: 'openai', apiKey: SECRET } },
      models: { 'mygw/quick': { provider: 'mygw', model: 'gpt-4o-mini' } },
    } as unknown as KimiConfig);
    const { deps, stdout, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stdout.join('')).toMatch(stageLine(1, 'config', 'OK', 'configured \\(type=openai\\)'));
    for (const index of [3, 4, 5]) {
      expect(stdout.join('')).toMatch(stageLine(index, '\\w+', 'SKIP', 'no base_url configured'));
    }
    expect(stderr).toEqual([]);
    expect(stdout.join('')).toContain('No stage failed (2 passed, 0 failed, 3 skipped).');
    expect(calls).toEqual([]);
    expect(exitCodes).toEqual([]);
  });

  it('fails stage 1 with the configured provider list when the id is unknown', async () => {
    const { calls } = stubProbeFetch(happyRoute);
    const { deps, stdout, stderr, exitCodes } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'nope', {}));

    expect(stderr.join('')).toMatch(stageLine(1, 'config', 'FAIL', 'not configured — configured providers: mygw'));
    expect(stdout.join('')).toMatch(stageLine(2, 'credential', 'SKIP', 'no provider record to test'));
    expect(stdout.join('')).toMatch(stageLine(5, 'request', 'SKIP', 'no provider record to test'));
    expect(stderr.join('')).toContain('Provider test failed (0 passed, 1 failed, 4 skipped).');
    expect(calls).toEqual([]);
    expect(exitCodes).toEqual([1]);
  });

  it('skips the probe for a wire it cannot speak', async () => {
    const { calls } = stubProbeFetch(happyRoute);
    const { harness } = makeHarness({
      providers: { mygw: { type: 'vertexai', baseUrl: GATEWAY, apiKey: SECRET } },
      models: { 'mygw/quick': { provider: 'mygw', model: 'gemini-2.5-pro' } },
    } as unknown as KimiConfig);
    const { deps, stdout, stderr } = makeDeps(harness);

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stdout.join('')).toMatch(stageLine(5, 'request', 'SKIP', 'unsupported API — this client cannot send a probe over the "vertexai" wire'));
    expect(stderr).toEqual([]);
    expect(calls.some((call) => call.url.endsWith('/chat/completions'))).toBe(false);
  });

  it('probes the requested alias and refuses one belonging to another provider', async () => {
    stubProbeFetch(happyRoute);
    const { harness } = makeHarness(
      gatewayConfig({ apiKey: SECRET }, { 'other/big': { provider: 'other', model: 'gpt-4o' } }),
    );
    const { deps, stdout, stderr } = makeDeps(harness);

    await tryRun(() => handleProviderTest(deps, 'mygw', { model: 'other/big' }));
    expect(stdout.join('')).toMatch(
      stageLine(5, 'request', 'SKIP', 'model alias "other/big" belongs to provider "other"'),
    );

    await tryRun(() => handleProviderTest(deps, 'mygw', { model: 'mygw/quick' }));
    expect(stdout.join('')).toMatch(
      stageLine(5, 'request', 'OK', 'minimal request succeeded via alias "mygw/quick" \\(model gpt-4o-mini, \\d+ ms\\)'),
    );
    expect(stderr).toEqual([]);
  });

  it('rejects a non-positive --timeout before touching the network', async () => {
    const { calls } = stubProbeFetch(happyRoute);
    const { deps, stderr, exitCodes } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'mygw', { timeoutMs: 0 }));

    expect(stderr.join('')).toContain('--timeout must be a positive number of milliseconds.');
    expect(calls).toEqual([]);
    expect(exitCodes).toEqual([1]);
  });

  it('redacts the credential the server echoes back in its error body', async () => {
    stubProbeFetch((url) =>
      url.endsWith('/models')
        ? happyRoute(url)
        : jsonResponse({ error: { message: `invalid key ${SECRET}` } }, 401),
    );
    const { deps, stdout, stderr, exitCodes } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stderr.join('')).toMatch(
      stageLine(
        5,
        'request',
        'FAIL',
        `unauthorized \\(HTTP 401 at ${GATEWAY}/chat/completions\\): .*\\[redacted\\].*`,
      ),
    );
    expect(`${stdout.join('')}${stderr.join('')}`).not.toContain(SECRET);
    expect(exitCodes).toEqual([1]);
  });

  it('fails a 200 response whose body is not JSON', async () => {
    stubProbeFetch((url) =>
      url.endsWith('/models') ? happyRoute(url) : new Response('<html>gateway</html>', { status: 200 }),
    );
    const { deps, stderr } = gatewayDeps();

    await tryRun(() => handleProviderTest(deps, 'mygw', {}));

    expect(stderr.join('')).toMatch(
      stageLine(5, 'request', 'FAIL', `malformed response — ${GATEWAY}/chat/completions answered HTTP 200 with a body that is not JSON`),
    );
  });

  it('sends the anthropic wire its own auth header and version segment', async () => {
    const { calls } = stubProbeFetch(happyRoute);
    const { harness } = makeHarness({
      providers: { claude: { type: 'anthropic', baseUrl: 'https://api.example.test', apiKey: SECRET } },
      models: { 'claude/quick': { provider: 'claude', model: 'claude-sonnet-4-5' } },
    } as unknown as KimiConfig);
    const { deps, stdout, stderr } = makeDeps(harness);

    await tryRun(() => handleProviderTest(deps, 'claude', {}));

    const modelsCall = calls.find((call) => call.url.endsWith('/v1/models'));
    const messagesCall = calls.find((call) => call.url.endsWith('/v1/messages'));
    expect(modelsCall?.url).toBe('https://api.example.test/v1/models');
    expect(modelsCall?.headers['x-api-key']).toBe(SECRET);
    expect(modelsCall?.headers['anthropic-version']).toBe('2023-06-01');
    expect(messagesCall?.headers['x-api-key']).toBe(SECRET);
    expect(stdout.join('')).toMatch(stageLine(5, 'request', 'OK', '.*'));
    expect(stderr).toEqual([]);
  });

  it('wires `provider test` through commander, including --timeout', async () => {
    stubProbeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const { harness } = makeHarness(gatewayConfig({ apiKey: SECRET }));
    const { deps, stdout, stderr, exitCodes } = makeDeps(harness);
    const program = new Command('kimi');
    registerProviderCommand(program, deps);

    await tryRun(() => program.parseAsync(['node', 'kimi', 'provider', 'test', 'mygw', '--timeout', '5']));

    // A 5 ms budget never elapses against the 10 s default, so this proves the
    // parsed option reached the handler.
    expect(stderr.join('')).toMatch(stageLine(3, 'connectivity', 'FAIL', 'timeout: no response within 5 ms'));
    expect(stdout.join('')).toContain('Provider test: mygw');
    // The test double's `exit` throws (production calls `process.exit`, which
    // never returns), so the handler's exit lands in `runAction`'s catch and
    // exits again.
    expect(exitCodes).toEqual([1, 1]);
  });
});
