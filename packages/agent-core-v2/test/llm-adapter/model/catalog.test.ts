import { createServer } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import { isErrorCode } from '#/_base/errors/codes';
import { isError2 } from '#/_base/errors/errors';
import { IConfigService } from '#/app/config/config';
import { ConfigErrors } from '#/app/config/errors';
import { UNKNOWN_CAPABILITY } from '#/llm-adapter/contract/capability';
import type { LlmAuthScheme, LlmModel } from '#human/llm/model';
import { resolveAuthSchemeHeaders } from '#human/llm/requester/auth-scheme-headers';
import { emptyUsage } from '#human/llm/usage';
import type { LlmRequester } from '#human/llm/requester/requester';
import { IProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocol';
import '#/llm-adapter/protocol/protocolAdapterRegistry';
import {
  IProviderService,
  type ProviderConfig,
  type ProvidersSection,
} from '#/llm-adapter/provider/provider';
import '#/llm-adapter/provider/provider-service';
import {
  globalDefaultForProvider,
  IModelCatalog,
  type Model,
  modelIdsForProvider,
  toProtocolModel,
  toProtocolModelFallback,
  toProtocolProvider,
} from '#/llm-adapter/model/catalog';
import { ModelCatalog } from '#/llm-adapter/model/catalog-service';
import { ProviderCatalogRuntimeService } from '#/llm-adapter/model/catalog-runtime';
import '#/llm-adapter/model/errors';
import { IHostRequestHeaders } from '#/llm-adapter/model/host-request-headers';
import { IModelService, type ModelRecord, type ModelsSection } from '#/llm-adapter/model/model';
import '#/llm-adapter/model/model-service';
import { IModelOAuthTokens } from '#/llm-adapter/model/model-oauth';

import { HostRequestHeadersAdapter } from '#/app/kosongConfig/hostRequestHeadersAdapter';

import { StubConfigService, stubModelOAuthTokens, stubTokenProvider } from '../../stubs';
import { stubAgentIdentity } from '../../app/agentIdentity/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';

const HOST_HEADERS = { 'User-Agent': 'kimi-test/1.0', 'X-Msh-Device-Id': 'device-1' };

function hostHeadersPort(spec: {
  headers: Record<string, string>;
  identitySlug?: string;
}): IHostRequestHeaders {
  return new HostRequestHeadersAdapter(
    stubBootstrap('/home', {}, { requestHeaders: spec.headers }),
    stubAgentIdentity({ slug: spec.identitySlug, hostRequestHeaders: spec.headers }),
  );
}

function createHost(
  sections: Record<string, unknown> = {},
  oauthTokens: IModelOAuthTokens = stubModelOAuthTokens(),
  hostHeaders: { headers: Record<string, string>; identitySlug?: string } = {
    headers: HOST_HEADERS,
  },
): {
  host: ReturnType<typeof createScopedTestHost>;
  config: StubConfigService;
  catalog: ModelCatalog;
  models: IModelService;
  providers: IProviderService;
} {
  const config = new StubConfigService(sections);
  const host = createScopedTestHost([
    [IConfigService, config],
    [IModelOAuthTokens, oauthTokens],
    [IHostRequestHeaders, hostHeadersPort(hostHeaders)],
  ]);
  const providers = host.app.accessor.get(IProviderService);
  providers.loadAll(
    (sections['providers'] ?? {}) as ProvidersSection,
    sections['defaultProvider'] as string | undefined,
  );
  const models = host.app.accessor.get(IModelService);
  models.loadAll(
    (sections['models'] ?? {}) as ModelsSection,
    sections['defaultModel'] as string | undefined,
  );
  return {
    host,
    config,
    catalog: host.app.accessor.get(IModelCatalog) as ModelCatalog,
    models,
    providers,
  };
}

const kimiSections: Record<string, unknown> = {
  providers: {
    kimi: { type: 'kimi', apiKey: 'sk-test', baseUrl: 'https://api.moonshot.ai/v1' },
  },
  models: {
    k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 262144 },
  },
};

function silentModelWrite(models: IModelService, records: Record<string, ModelRecord>): void {
  (models as unknown as { models: Record<string, ModelRecord> }).models = records;
}

let savedCustomHeaders: string | undefined;

beforeEach(() => {
  savedCustomHeaders = process.env['KIMI_CODE_CUSTOM_HEADERS'];
  delete process.env['KIMI_CODE_CUSTOM_HEADERS'];
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (savedCustomHeaders === undefined) delete process.env['KIMI_CODE_CUSTOM_HEADERS'];
  else process.env['KIMI_CODE_CUSTOM_HEADERS'] = savedCustomHeaders;
});

describe('Model assembly (pure data)', () => {
  it('assembles a kimi model: protocol resolves to the vendor base, never a vendor', () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      const model = catalog.get('k1');
      expect(model.id).toBe('k1');
      expect(model.name).toBe('kimi-k2');
      expect(model.protocol).toBe('openai');
      expect(model.providerType).toBe('kimi');
      expect(model.providerName).toBe('kimi');
      expect(model.baseUrl).toBe('https://api.moonshot.ai/v1');
      expect(model.maxContextSize).toBe(262144);
      expect(model.capabilities.max_context_tokens).toBe(262144);
      expect(model.headers).toMatchObject({
        'User-Agent': 'kimi-test/1.0',
        'X-Msh-Device-Id': 'device-1',
      });
    } finally {
      host.dispose();
    }
  });

  it('the Model carries no morphs and no request driver — pure data only', () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      const model: Record<string, unknown> = { ...catalog.get('k1') };
      for (const [key, value] of Object.entries(model)) {
        expect(key.startsWith('with'), `unexpected morph ${key}`).toBe(false);
        expect(typeof value, `field ${key} must be data`).not.toBe('function');
      }
      expect(model['request']).toBeUndefined();
      expect(model['thinkingEffort']).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('forwards only the User-Agent to vendors without a full hostHeaders declaration', () => {
    const { host, catalog } = createHost({
      providers: {
        openai: { type: 'openai', apiKey: 'sk-o', baseUrl: 'https://api.openai.com/v1' },
      },
      models: { gpt: { provider: 'openai', model: 'gpt-5', maxContextSize: 128000 } },
    });
    try {
      const model = catalog.get('gpt');
      expect(model.protocol).toBe('openai');
      expect(model.providerType).toBe('openai');
      expect(model.headers).toEqual({ 'User-Agent': 'kimi-test/1.0' });
    } finally {
      host.dispose();
    }
  });

  describe('custom identity', () => {
    const THIRD_PARTY = {
      providers: {
        openai: { type: 'openai', apiKey: 'sk-o', baseUrl: 'https://api.openai.com/v1' },
      },
      models: { gpt: { provider: 'openai', model: 'gpt-5', maxContextSize: 128000 } },
    };
    const OFFICIAL = {
      providers: { kimi: { type: 'kimi', apiKey: 'sk', baseUrl: 'https://api.example.test/v1' } },
      models: { k2: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 200000 } },
    };

    it('rewrites the User-Agent product token for third-party vendors', () => {
      const { host, catalog } = createHost(THIRD_PARTY, stubModelOAuthTokens(), {
        headers: HOST_HEADERS,
        identitySlug: 'acme-dev',
      });
      try {
        expect(catalog.get('gpt').headers).toEqual({ 'User-Agent': 'acme-dev/1.0' });
      } finally {
        host.dispose();
      }
    });

    it('preserves a parenthesized User-Agent suffix while rewriting', () => {
      const { host, catalog } = createHost(THIRD_PARTY, stubModelOAuthTokens(), {
        headers: { 'User-Agent': 'kimi-test/1.0 (web)' },
        identitySlug: 'acme-dev',
      });
      try {
        expect(catalog.get('gpt').headers).toEqual({ 'User-Agent': 'acme-dev/1.0 (web)' });
      } finally {
        host.dispose();
      }
    });

    it('leaves full-header vendor requests byte-for-byte unchanged', () => {
      const { host, catalog } = createHost(OFFICIAL, stubModelOAuthTokens(), {
        headers: HOST_HEADERS,
        identitySlug: 'acme-dev',
      });
      try {
        expect(catalog.get('k2').headers).toEqual(HOST_HEADERS);
      } finally {
        host.dispose();
      }
    });

    it('changes nothing when no identity is configured', () => {
      const { host, catalog } = createHost(THIRD_PARTY);
      try {
        expect(catalog.get('gpt').headers).toEqual({ 'User-Agent': 'kimi-test/1.0' });
      } finally {
        host.dispose();
      }
    });

    it('never synthesizes a User-Agent the host did not provide', () => {
      const { host, catalog } = createHost(THIRD_PARTY, stubModelOAuthTokens(), {
        headers: {},
        identitySlug: 'acme-dev',
      });
      try {
        expect(catalog.get('gpt').headers).toEqual({});
      } finally {
        host.dispose();
      }
    });

    it('rewrites the User-Agent for a lowercase host spelling', () => {
      const { host, catalog } = createHost(THIRD_PARTY, stubModelOAuthTokens(), {
        headers: { 'user-agent': 'kimi-test/1.0' },
        identitySlug: 'acme-dev',
      });
      try {
        expect(catalog.get('gpt').headers).toEqual({ 'User-Agent': 'acme-dev/1.0' });
      } finally {
        host.dispose();
      }
    });
  });

  it('keeps an explicit foreign protocol for a kimi model (the trait path)', () => {
    const { host, catalog } = createHost({
      providers: { kimi: { type: 'kimi', apiKey: 'sk', baseUrl: 'https://api.example.test/v1' } },
      models: {
        k2: { provider: 'kimi', protocol: 'anthropic', model: 'kimi-k2', maxContextSize: 200000 },
      },
    });
    try {
      const model = catalog.get('k2');
      expect(model.protocol).toBe('anthropic');
      expect(model.providerType).toBe('kimi');
      expect(model.baseUrl).toBe('https://api.example.test');
      expect(model.supportEfforts).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('infers the Anthropic effort profile for non-trait-driven anthropic vendors', () => {
    const { host, catalog } = createHost({
      providers: { claude: { type: 'anthropic', apiKey: 'sk-a' } },
      models: {
        sonnet: { provider: 'claude', model: 'claude-sonnet-4-5', maxContextSize: 200000 },
      },
    });
    try {
      const model = catalog.get('sonnet');
      expect(model.protocol).toBe('anthropic');
      expect(model.supportEfforts).toEqual(['low', 'medium', 'high']);
      expect(model.defaultEffort).toBe('high');
      expect(model.capabilities.thinking).toBe(true);
    } finally {
      host.dispose();
    }
  });

  it('surfaces a declared adaptive_thinking flag on the assembled model', () => {
    const { host, catalog } = createHost({
      providers: { claude: { type: 'anthropic', apiKey: 'sk-a' } },
      models: {
        custom: {
          provider: 'claude',
          model: 'my-custom-model',
          maxContextSize: 200000,
          adaptiveThinking: true,
        },
      },
    });
    try {
      expect(catalog.get('custom').adaptiveThinking).toBe(true);
    } finally {
      host.dispose();
    }
  });

  it('resolves provider env-bag credentials and endpoints through the registry', async () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: { type: 'kimi', env: { KIMI_API_KEY: 'env-token', KIMI_BASE_URL: 'https://kimi-env.example.test/v1' } },
        openai: { type: 'openai', env: { OPENAI_API_KEY: 'sk-openai' } },
      },
      models: {
        k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1000 },
        gpt: { provider: 'openai', protocol: 'openai', model: 'gpt-5', maxContextSize: 1000 },
      },
    });
    try {
      const kimi = catalog.get('k1');
      expect(kimi.baseUrl).toBe('https://kimi-env.example.test/v1');
      return expect(await kimi.credentialProvider?.resolve()).toEqual({ apiKey: 'env-token' });
    } finally {
      host.dispose();
    }
  });

  it('passes a declared offEffort through providerOptions for the OpenAI wires', () => {
    const { host, catalog } = createHost({
      providers: {
        gateway: { type: 'openai', apiKey: 'sk-gw', baseUrl: 'https://gateway.example.test/v1' },
        responses: { type: 'openai_responses', apiKey: 'sk-r' },
      },
      models: {
        grok: {
          provider: 'gateway',
          model: 'grok-4',
          maxContextSize: 256000,
          supportEfforts: ['low', 'medium', 'high'],
          offEffort: 'none',
        },
        grokResponses: {
          provider: 'responses',
          model: 'grok-4',
          maxContextSize: 256000,
          offEffort: 'none',
        },
        plain: { provider: 'gateway', model: 'gpt-4.1', maxContextSize: 1000 },
      },
    });
    try {
      expect(catalog.get('grok').providerOptions).toEqual({ offEffort: 'none' });
      expect(catalog.get('grokResponses').providerOptions).toEqual({ offEffort: 'none' });
      expect(catalog.get('plain').providerOptions).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('enables google-genai vertex mode through providerOptions when project and location resolve', () => {
    const { host, catalog } = createHost({
      providers: {
        vertex: {
          type: 'google-genai',
          env: { GOOGLE_CLOUD_PROJECT: 'my-project', GOOGLE_CLOUD_LOCATION: 'us-central1' },
        },
        vertexUrl: {
          type: 'google-genai',
          baseUrl: 'https://us-east4-aiplatform.googleapis.com',
          env: { GOOGLE_CLOUD_PROJECT: 'my-project' },
        },
        plain: { type: 'google-genai', apiKey: 'sk-g' },
      },
      models: {
        v: { provider: 'vertex', model: 'gemini-2.5-flash', maxContextSize: 1000 },
        v2: { provider: 'vertexUrl', model: 'gemini-2.5-flash', maxContextSize: 1000 },
        g: { provider: 'plain', model: 'gemini-2.5-flash', maxContextSize: 1000 },
      },
    });
    try {
      const vertexModel = catalog.get('v');
      expect(vertexModel.protocol).toBe('google-genai');
      expect(vertexModel.providerOptions).toEqual({
        vertexai: true,
        project: 'my-project',
        location: 'us-central1',
      });
      expect(catalog.get('v2').providerOptions).toEqual({
        vertexai: true,
        project: 'my-project',
        location: 'us-east4',
      });
      expect(catalog.get('g').providerOptions).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('supports flat models with an inline baseUrl (provider synthesized from the origin)', () => {
    const { host, catalog } = createHost({
      models: {
        flat: {
          protocol: 'openai',
          name: 'my-model',
          baseUrl: 'https://flat.example.test/v1',
          apiKey: 'sk-flat',
          maxContextSize: 4096,
        },
      },
    });
    try {
      const model = catalog.get('flat');
      expect(model.providerName).toBe('flat.example.test');
      expect(model.providerType).toBe('openai');
      expect(model.baseUrl).toBe('https://flat.example.test/v1');
    } finally {
      host.dispose();
    }
  });

  it('falls back to defaultProvider when a model names no provider', () => {
    const { host, catalog } = createHost({
      ...kimiSections,
      defaultProvider: 'kimi',
      models: { inherited: { model: 'kimi-k2', maxContextSize: 1000 } },
    });
    try {
      expect(catalog.get('inherited').providerName).toBe('kimi');
    } finally {
      host.dispose();
    }
  });

  it('supports unregistered vendors when the model declares the protocol explicitly', () => {
    const { host, catalog } = createHost({
      providers: {
        mine: { type: 'my-vendor', apiKey: 'sk-m', baseUrl: 'https://vendor.example.test/v1' },
      },
      models: {
        m: { provider: 'mine', protocol: 'openai', model: 'vendor-model', maxContextSize: 1000 },
      },
    });
    try {
      const model = catalog.get('m');
      expect(model.providerType).toBe('my-vendor');
      expect(model.protocol).toBe('openai');
      expect(model.headers).toEqual({ 'User-Agent': 'kimi-test/1.0' });
    } finally {
      host.dispose();
    }
  });

  it('throws config.invalid for unknown models, missing providers, and incomplete records', () => {
    const expectInvalid = (sections: Record<string, unknown>, id: string): void => {
      const { host, catalog } = createHost(sections);
      try {
        expect(() => catalog.get(id)).toThrowError(
          expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }),
        );
      } finally {
        host.dispose();
      }
    };
    expectInvalid(kimiSections, 'nope');
    expectInvalid({ models: { ghost: { provider: 'missing', model: 'm', maxContextSize: 1 } } }, 'ghost');
    expectInvalid(
      { models: { noname: { protocol: 'openai', baseUrl: 'https://x.test', maxContextSize: 1 } } },
      'noname',
    );
    expectInvalid(
      { ...kimiSections, models: { noctx: { provider: 'kimi', model: 'm' } } },
      'noctx',
    );
  });

  it('findByName matches name, model, and aliases', () => {
    const { host, catalog } = createHost({
      ...kimiSections,
      models: {
        k1: { provider: 'kimi', model: 'kimi-k2', aliases: ['k2-latest'], maxContextSize: 1 },
        k2: { provider: 'kimi', name: 'shared-name', maxContextSize: 1 },
        k3: { provider: 'kimi', model: 'shared-name', maxContextSize: 1 },
      },
    });
    try {
      expect(catalog.findByName('kimi-k2')).toEqual(['k1']);
      expect(catalog.findByName('k2-latest')).toEqual(['k1']);
      expect(catalog.findByName('shared-name')).toEqual(['k2', 'k3']);
      expect(catalog.findByName('unknown')).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('builds recoverable OAuth credentials for oauth-backed models', async () => {
    const tokenProvider = stubTokenProvider(['tok-1']);
    const { host, catalog } = createHost(
      {
        providers: {
          kimi: { type: 'kimi', oauth: { storage: 'file', key: 'kimi' }, baseUrl: 'https://api.moonshot.ai/v1' },
        },
        models: { k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1 } },
      },
      stubModelOAuthTokens(tokenProvider),
    );
    try {
      const model = catalog.get('k1');
      expect(model.credentialProvider?.canRecover?.(Object.assign(new Error('x'), { status: 401 }))).toBe(
        true,
      );
      await expect(model.credentialProvider?.resolve()).resolves.toEqual({ apiKey: 'tok-1' });
    } finally {
      host.dispose();
    }
  });

  it('resolves api_key_env credentials from process.env on every request', async () => {
    vi.stubEnv('KIMI_TEST_ACME_ENV_KEY', 'sk-first');
    const { host, catalog } = createHost({
      providers: {
        acme: { type: 'openai', apiKeyEnv: 'KIMI_TEST_ACME_ENV_KEY', baseUrl: 'https://acme.example.test/v1' },
      },
      models: { m: { provider: 'acme', protocol: 'openai', model: 'acme-1', maxContextSize: 1000 } },
    });
    try {
      const model = catalog.get('m');
      expect(await model.credentialProvider?.resolve()).toEqual({ apiKey: 'sk-first' });
      vi.stubEnv('KIMI_TEST_ACME_ENV_KEY', 'sk-rotated');
      expect(await model.credentialProvider?.resolve()).toEqual({ apiKey: 'sk-rotated' });
    } finally {
      host.dispose();
    }
  });

  it('fails credential resolution with config.invalid when the declared api_key_env variable is unset or empty', () => {
    const { host, catalog } = createHost({
      providers: {
        acme: { type: 'openai', apiKeyEnv: 'KIMI_TEST_ACME_ENV_KEY', baseUrl: 'https://acme.example.test/v1' },
      },
      models: { m: { provider: 'acme', protocol: 'openai', model: 'acme-1', maxContextSize: 1000 } },
    });
    try {
      const model = catalog.get('m');
      expect(() => model.credentialProvider?.resolve()).toThrowError(
        expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }),
      );
      expect(() => model.credentialProvider?.resolve()).toThrowError(/acme[\s\S]*KIMI_TEST_ACME_ENV_KEY/);
      vi.stubEnv('KIMI_TEST_ACME_ENV_KEY', '   ');
      expect(() => model.credentialProvider?.resolve()).toThrowError(
        expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }),
      );
    } finally {
      host.dispose();
    }
  });
});

describe('base_url validation', () => {
  it('rejects a plain-http non-local provider base_url as config.invalid', () => {
    const { host, catalog } = createHost({
      providers: { acme: { type: 'openai', apiKey: 'sk-a', baseUrl: 'http://acme.example.test/v1' } },
      models: { m: { provider: 'acme', model: 'acme-1', maxContextSize: 1000 } },
    });
    try {
      expect(() => catalog.get('m')).toThrowError(
        expect.objectContaining({
          code: ConfigErrors.codes.CONFIG_INVALID,
          message:
            'providers.acme.base_url must use https for a non-local host; plain http is only allowed for loopback and private-network hosts such as localhost, 127.0.0.1 or 192.168.x.x.',
        }),
      );
    } finally {
      host.dispose();
    }
  });

  it('rejects credentials embedded in a providerless model base_url as config.invalid', () => {
    const { host, catalog } = createHost({
      models: {
        m: {
          baseUrl: 'https://user:sk-secret@acme.example.test/v1',
          model: 'acme-1',
          maxContextSize: 1000,
        },
      },
    });
    try {
      expect(() => catalog.get('m')).toThrowError(
        expect.objectContaining({
          code: ConfigErrors.codes.CONFIG_INVALID,
          message:
            'models.m.base_url must not embed a username or password; put the key in api_key instead.',
        }),
      );
    } finally {
      host.dispose();
    }
  });

  it('keeps a local model server on plain http reachable', () => {
    const { host, catalog } = createHost({
      providers: { ollama: { type: 'openai', apiKey: 'sk-a', baseUrl: 'http://localhost:11434/v1' } },
      models: { m: { provider: 'ollama', model: 'llama3', maxContextSize: 8192 } },
    });
    try {
      expect(catalog.get('m').baseUrl).toBe('http://localhost:11434/v1');
    } finally {
      host.dispose();
    }
  });
});

describe('ModelCatalog caching and config-event invalidation', () => {
  it('caches per id; getRequester returns the cached pair', () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      const model = catalog.get('k1');
      expect(catalog.get('k1')).toBe(model);
      const requester = catalog.getRequester('k1');
      expect(catalog.getRequester('k1')).toBe(requester);
      expect(requester.model).toBe(model);
    } finally {
      host.dispose();
    }
  });

  it('drops only the changed entries when a watched config section changes', async () => {
    const { host, catalog, models, providers } = createHost({
      providers: {
        kimi: { type: 'kimi', apiKey: 'sk-test', baseUrl: 'https://api.moonshot.ai/v1' },
        openai: { type: 'openai', apiKey: 'sk-o', baseUrl: 'https://api.openai.com/v1' },
      },
      models: {
        k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 262144 },
        gpt: { provider: 'openai', model: 'gpt-5', maxContextSize: 128000 },
      },
    });
    try {
      const k1Before = catalog.get('k1');
      const gptBefore = catalog.get('gpt');
      await models.set('k1', { provider: 'kimi', model: 'kimi-k2', maxContextSize: 262144, displayName: 'K2' });
      expect(catalog.get('k1')).not.toBe(k1Before);
      expect(catalog.get('k1').displayName).toBe('K2');
      expect(catalog.get('gpt')).toBe(gptBefore);

      await providers.set('kimi', { type: 'kimi', apiKey: 'sk-2', baseUrl: 'https://other.example.test/v1' });
      expect(catalog.get('k1').baseUrl).toBe('https://other.example.test/v1');
      expect(catalog.get('gpt')).toBe(gptBefore);
    } finally {
      host.dispose();
    }
  });

  it('keeps serving the stale Model on a silent registry write until notifyConfigChanged()', async () => {
    const { host, catalog, models } = createHost(kimiSections);
    try {
      const before = catalog.get('k1');

      silentModelWrite(models, {
        k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 262144, displayName: 'silent' },
      });
      expect(catalog.get('k1')).toBe(before);

      catalog.notifyConfigChanged();
      const after = catalog.get('k1');
      expect(after).not.toBe(before);
      expect(after.displayName).toBe('silent');
    } finally {
      host.dispose();
    }
  });
});

describe('headers merge order', () => {
  it('lets provider customHeaders win over the host layer', () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: {
          type: 'kimi',
          apiKey: 'sk',
          baseUrl: 'https://api.moonshot.ai/v1',
          customHeaders: { 'User-Agent': 'custom-ua', 'X-Custom': 'c' },
        },
      },
      models: { k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1 } },
    });
    try {
      const model: Model = catalog.get('k1');
      expect(model.headers).toEqual({
        'User-Agent': 'custom-ua',
        'X-Msh-Device-Id': 'device-1',
        'X-Custom': 'c',
      });
    } finally {
      host.dispose();
    }
  });
});

describe('provider auth_scheme', () => {
  it('routes auth_scheme into providerOptions for every wire that can carry it', () => {
    const { host, catalog } = createHost({
      providers: {
        gateway: {
          type: 'openai',
          apiKey: 'sk-gw',
          baseUrl: 'https://gateway.example.test/v1',
          authScheme: { kind: 'custom-header', header: 'x-api-key' },
        },
        responses: { type: 'openai_responses', apiKey: 'sk-r', authScheme: { kind: 'none' } },
        claude: { type: 'anthropic', apiKey: 'sk-c', authScheme: { kind: 'bearer' } },
        plain: { type: 'openai', apiKey: 'sk-p', baseUrl: 'https://plain.example.test/v1' },
      },
      models: {
        gw: { provider: 'gateway', model: 'gw-1', maxContextSize: 1000 },
        rs: { provider: 'responses', model: 'gw-1', maxContextSize: 1000 },
        cl: { provider: 'claude', model: 'cl-1', maxContextSize: 1000 },
        pl: { provider: 'plain', model: 'gw-1', maxContextSize: 1000 },
      },
    });
    try {
      expect(catalog.get('gw').providerOptions).toEqual({
        authScheme: { kind: 'custom-header', header: 'x-api-key' },
      });
      expect(catalog.get('rs').providerOptions).toEqual({ authScheme: { kind: 'none' } });
      expect(catalog.get('cl').providerOptions).toEqual({ authScheme: { kind: 'bearer' } });
      expect(catalog.get('pl').providerOptions).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('rejects auth_scheme on protocols that cannot carry it instead of ignoring it', () => {
    const expectInvalid = (type: string): void => {
      const { host, catalog } = createHost({
        providers: {
          p: { type, apiKey: 'sk', authScheme: { kind: 'custom-header', header: 'x-api-key' } },
        },
        models: { m: { provider: 'p', model: 'm-1', maxContextSize: 1000 } },
      });
      try {
        expect(() => catalog.get('m')).toThrowError(
          expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }),
        );
      } finally {
        host.dispose();
      }
    };
    expectInvalid('google-genai');
  });
});

describe('resolveAuthSchemeHeaders', () => {
  function schemeModel(authScheme: LlmAuthScheme, apiKey?: string): LlmModel {
    return { provider: 'p', model: 'm', capability: UNKNOWN_CAPABILITY, apiKey, authScheme };
  }

  const HOST = { 'User-Agent': 'kimi-test/1.0', Authorization: 'Bearer unused' };

  it('leaves the headers untouched when the provider declares no scheme', () => {
    const model: LlmModel = { provider: 'p', model: 'm', capability: UNKNOWN_CAPABILITY, apiKey: 'sk' };
    expect(resolveAuthSchemeHeaders(model, HOST)).toBe(HOST);
    expect(resolveAuthSchemeHeaders(model, undefined)).toBeUndefined();
  });

  it('drops Authorization for an anonymous provider and keeps every other header', () => {
    expect(resolveAuthSchemeHeaders(schemeModel({ kind: 'none' }, 'sk'), HOST)).toEqual({
      'User-Agent': 'kimi-test/1.0',
      Authorization: null,
    });
  });

  it('emits the Authorization delete even when the caller supplied no Authorization header', () => {
    expect(resolveAuthSchemeHeaders(schemeModel({ kind: 'none' }, 'sk'), {})).toEqual({
      Authorization: null,
    });
    expect(
      resolveAuthSchemeHeaders(schemeModel({ kind: 'custom-header', header: 'x-api-key' }, 'sk-1'), {}),
    ).toEqual({ Authorization: null, 'x-api-key': 'sk-1' });
  });

  it('moves the key into the named header and drops Authorization for a custom-header provider', () => {
    expect(
      resolveAuthSchemeHeaders(schemeModel({ kind: 'custom-header', header: 'x-api-key' }, 'sk-1'), HOST),
    ).toEqual({ 'User-Agent': 'kimi-test/1.0', Authorization: null, 'x-api-key': 'sk-1' });
  });

  it('sends the raw key when the custom header is Authorization itself', () => {
    expect(
      resolveAuthSchemeHeaders(
        schemeModel({ kind: 'custom-header', header: 'Authorization' }, 'sk-raw'),
        HOST,
      ),
    ).toEqual({ 'User-Agent': 'kimi-test/1.0', Authorization: 'sk-raw' });
  });

  it('never falls back to the SDK bearer token when no key resolved', () => {
    expect(
      resolveAuthSchemeHeaders(schemeModel({ kind: 'custom-header', header: 'x-api-key' }), HOST),
    ).toEqual({ 'User-Agent': 'kimi-test/1.0', Authorization: null });
  });

  it('restates the default bearer token for an explicit bearer scheme', () => {
    expect(resolveAuthSchemeHeaders(schemeModel({ kind: 'bearer' }, 'sk-1'), HOST)).toEqual({
      'User-Agent': 'kimi-test/1.0',
      Authorization: 'Bearer sk-1',
    });
  });

  it('honours a custom header name for an explicit bearer scheme', () => {
    expect(
      resolveAuthSchemeHeaders(schemeModel({ kind: 'bearer', header: 'x-token' }, 'sk-1'), HOST),
    ).toEqual({ 'User-Agent': 'kimi-test/1.0', Authorization: null, 'x-token': 'Bearer sk-1' });
  });

  it('sends no bearer token when a bearer scheme has no key to send', () => {
    expect(resolveAuthSchemeHeaders(schemeModel({ kind: 'bearer' }), HOST)).toEqual({
      'User-Agent': 'kimi-test/1.0',
      Authorization: null,
    });
  });

  it('fails loudly when a kind reaches the requester without a registered strategy', () => {
    const unregistered = { kind: 'oauth2' } as unknown as LlmAuthScheme;
    expect(() => resolveAuthSchemeHeaders(schemeModel(unregistered, 'sk-1'), HOST)).toThrow(
      'No auth strategy is registered for kind "oauth2"',
    );
  });
});

describe('auth_scheme on the wire', () => {
  function sse(lines: string[]): string {
    return `${lines.join('\n')}\n\n`;
  }

  interface WireStub {
    readonly type: string;
    readonly chunks: string;
    readonly defaultAuth: readonly [header: string, value: string];
  }

  const WIRES: WireStub[] = [
    {
      type: 'openai',
      defaultAuth: ['authorization', 'Bearer sk-wire'],
      chunks: [
        sse([
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"m-1","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}',
        ]),
        sse([
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"m-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        ]),
        sse(['data: [DONE]']),
      ].join(''),
    },
    {
      type: 'openai_responses',
      defaultAuth: ['authorization', 'Bearer sk-wire'],
      chunks: [
        sse([
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"pong"}',
        ]),
        sse([
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp-1","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}',
        ]),
        sse(['event: done', 'data: [DONE]']),
      ].join(''),
    },
    {
      type: 'anthropic',
      defaultAuth: ['x-api-key', 'sk-wire'],
      chunks: [
        sse([
          'event: message_start',
          'data: {"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","model":"m-1","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
        ]),
        sse([
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        ]),
        sse([
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}',
        ]),
        sse(['event: content_block_stop', 'data: {"type":"content_block_stop","index":0}']),
        sse([
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
        ]),
        sse(['event: message_stop', 'data: {"type":"message_stop"}']),
      ].join(''),
    },
  ];

  async function pingAndCapture(
    authScheme: LlmAuthScheme | undefined,
    wire: WireStub,
  ): Promise<Record<string, string | string[] | undefined>> {
    let captured: Record<string, string | string[] | undefined> = {};
    const server = createServer((req, res) => {
      captured = req.headers;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(wire.chunks);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('stub server has no port');
    const { host, catalog } = createHost({
      providers: {
        stub: {
          type: wire.type,
          apiKey: 'sk-wire',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          authScheme,
        },
      },
      models: { m1: { provider: 'stub', model: 'm-1', maxContextSize: 1000 } },
    });
    try {
      expect(await catalog.ping('m1')).toMatchObject({ ok: true, text: 'pong' });
      return captured;
    } finally {
      host.dispose();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }

  it.each(WIRES)('$type sends no credential at all for an anonymous provider', async (wire) => {
    const headers = await pingAndCapture({ kind: 'none' }, wire);
    expect(headers['authorization']).toBeUndefined();
    expect(headers[wire.defaultAuth[0]]).toBeUndefined();
  });

  it.each(WIRES)(
    '$type sends the key in the named header and no default credential for a custom-header provider',
    async (wire) => {
      const headers = await pingAndCapture({ kind: 'custom-header', header: 'x-gateway-key' }, wire);
      expect(headers['authorization']).toBeUndefined();
      expect(headers[wire.defaultAuth[0]]).toBeUndefined();
      expect(headers['x-gateway-key']).toBe('sk-wire');
    },
  );

  it.each(WIRES)(
    '$type still sends the default credential when the provider declares no scheme',
    async (wire) => {
      expect((await pingAndCapture(undefined, wire))[wire.defaultAuth[0]]).toBe(wire.defaultAuth[1]);
    },
  );

  it.each(WIRES)(
    '$type sends an explicit bearer scheme even when the wire defaults elsewhere',
    async (wire) => {
      const headers = await pingAndCapture({ kind: 'bearer' }, wire);
      expect(headers['authorization']).toBe('Bearer sk-wire');
      if (wire.defaultAuth[0] !== 'authorization') {
        expect(headers[wire.defaultAuth[0]]).toBeUndefined();
      }
    },
  );
});

describe('ModelCatalog ping', () => {
  it('returns the streamed text and usage on a live success', async () => {
    const { host, models, providers } = createHost(kimiSections, stubModelOAuthTokens());
    try {
      const fakeRequester: LlmRequester = {
        generate: (_config, _content, control) => {
          control.onEvent?.({ type: 'llm.sent' });
          control.onEvent?.({ type: 'llm.streaming.headers', headers: {} });
          control.onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'pong' } });
          control.onEvent?.({ type: 'llm.streaming.usage', usage: emptyUsage() });
          control.onEvent?.({
            type: 'llm.streaming.finish',
            finish: { finishReason: 'completed', rawFinishReason: 'stop' },
          });
          control.onEvent?.({ type: 'llm.streaming.message_id', messageId: 'msg-1' });
          control.onEvent?.({ type: 'llm.done' });
          return Promise.resolve();
        },
      };
      const registry = {
        _serviceBrand: undefined,
        supportedProtocols: () => [],
        resolveAdapterIdentity: () => {
          throw new Error('not exercised');
        },
        resolveProviderBaseId: () => {
          throw new Error('not exercised');
        },
        resolveCapability: () => UNKNOWN_CAPABILITY,
        resolve: (model: Model) => ({
          requester: fakeRequester,
          protocol: 'openai',
          model: {
            provider: 'fake',
            model: model.name,
            capability: {
              image_in: false,
              video_in: false,
              audio_in: false,
              thinking: false,
              tool_use: true,
            },
          },
        }),
      } as unknown as IProtocolAdapterRegistry;
      const catalog = new ModelCatalog(
        new ProviderCatalogRuntimeService(models, providers),
        providers,
        models,
        stubModelOAuthTokens(),
        registry,
        { headers: {}, thirdPartyHeaders: {} },
      );
      const result = await catalog.ping('k1');
      expect(result).toMatchObject({ ok: true, text: 'pong', finishReason: 'completed' });
      expect(result.usage).toEqual(emptyUsage());
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      host.dispose();
    }
  });

  it('returns ok:false with the translated error when the wire fails', async () => {
    const { host, catalog } = createHost({
      models: {
        flat: {
          protocol: 'openai',
          name: 'my-model',
          baseUrl: 'http://127.0.0.1:1/',
          apiKey: 'sk-x',
          maxContextSize: 4096,
        },
      },
    });
    try {
      const result = await catalog.ping('flat');
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      host.dispose();
    }
  });

  it('rejects with config.invalid for unknown models', async () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      await expect(catalog.ping('nope')).rejects.toThrowError(
        expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }),
      );
    } finally {
      host.dispose();
    }
  });
});

const catalogSections: Record<string, unknown> = {
  providers: {
    kimi: { type: 'kimi', apiKey: 'sk-test', baseUrl: 'https://api.example.test/v1' },
    openai: { type: 'openai' },
  },
  models: {
    k2: {
      provider: 'kimi',
      model: 'kimi-k2',
      maxContextSize: 131072,
      displayName: 'Kimi K2',
      capabilities: ['thinking'],
    },
    turbo: { provider: 'kimi', model: 'kimi-turbo', maxContextSize: 32768, displayName: 'Kimi Turbo' },
    gpt4o: { provider: 'openai', model: 'gpt-4o', maxContextSize: 128000 },
  },
  defaultModel: 'k2',
};

describe('wire projection (pure)', () => {
  it('toProtocolModel projects the materialized Model into the snake_case wire shape', () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      const record = (catalogSections['models'] as Record<string, ModelRecord>)['k2']!;
      expect(toProtocolModel(catalog.get('k2'), record, 'kimi')).toEqual({
        provider: 'kimi',
        model: 'k2',
        display_name: 'Kimi K2',
        max_context_size: 131072,
        capabilities: ['thinking'],
        support_efforts: undefined,
        default_effort: undefined,
      });
    } finally {
      host.dispose();
    }
  });

  it('toProtocolModelFallback projects the raw record', () => {
    const record: ModelRecord = {
      provider: 'kimi',
      model: 'kimi-k2',
      maxContextSize: 131072,
      displayName: 'Kimi K2',
      capabilities: ['thinking'],
    };
    expect(toProtocolModelFallback('k2', record, 'kimi')).toEqual({
      provider: 'kimi',
      model: 'k2',
      display_name: 'Kimi K2',
      max_context_size: 131072,
      capabilities: ['thinking'],
      support_efforts: undefined,
      default_effort: undefined,
    });
  });

  it('modelIdsForProvider and globalDefaultForProvider group models by provider', () => {
    const models: Record<string, ModelRecord> = {
      a: { provider: 'p1', model: 'm-a' },
      b: { provider: 'p2', model: 'm-b' },
      c: { providerId: 'p1', model: 'm-c' },
    };
    expect(modelIdsForProvider(models, 'p1')).toEqual(['a']);
    expect(globalDefaultForProvider(models, 'a', 'p1')).toBe('a');
    expect(globalDefaultForProvider(models, 'a', 'p2')).toBeUndefined();
    expect(globalDefaultForProvider(models, undefined, 'p1')).toBeUndefined();
  });

  it('toProtocolProvider prefers the provider default, then the global default', () => {
    const models: Record<string, ModelRecord> = { a: { provider: 'p1', model: 'm-a' } };
    const provider: ProviderConfig = { type: 'openai', baseUrl: 'https://x.test/v1' };
    expect(
      toProtocolProvider('p1', provider, models, 'a', {
        hasApiKey: true,
        hasOAuthToken: false,
        hasCredentialConflict: false,
      }),
    ).toEqual({
      id: 'p1',
      type: 'openai',
      base_url: 'https://x.test/v1',
      default_model: 'a',
      has_api_key: true,
      status: 'connected',
      models: ['a'],
    });
    expect(
      toProtocolProvider(
        'p1',
        {
          ...provider,
          apiKeyEnv: 'ACME_KEY',
          oauth: { storage: 'file', key: 'oauth/p1' },
        },
        models,
        'a',
        { hasApiKey: true, hasOAuthToken: true, hasCredentialConflict: true },
      ),
    ).toMatchObject({ status: 'error', has_api_key: true });
    expect(
      toProtocolProvider('p1', { ...provider, defaultModel: 'own' }, models, 'a', {
        hasApiKey: false,
        hasOAuthToken: false,
        hasCredentialConflict: false,
      }).default_model,
    ).toBe('own');
    expect(
      toProtocolProvider('p1', { ...provider, type: undefined }, models, undefined, {
        hasApiKey: false,
        hasOAuthToken: false,
        hasCredentialConflict: false,
      }),
    ).toMatchObject({ type: 'openai', status: 'unconfigured', default_model: undefined });
  });
});

describe('ModelCatalog enumeration', () => {
  it('lists configured models as selectable aliases', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.listModels()).resolves.toEqual([
        {
          provider: 'kimi',
          model: 'k2',
          display_name: 'Kimi K2',
          max_context_size: 131072,
          capabilities: ['thinking'],
        },
        { provider: 'kimi', model: 'turbo', display_name: 'Kimi Turbo', max_context_size: 32768 },
        { provider: 'openai', model: 'gpt4o', display_name: 'gpt-4o', max_context_size: 128000 },
      ]);
    } finally {
      host.dispose();
    }
  });

  it('projects support_efforts and default_effort from the model config', async () => {
    const sections = structuredClone(catalogSections);
    (sections['models'] as Record<string, ModelRecord>)['k2'] = {
      ...(catalogSections['models'] as Record<string, ModelRecord>)['k2'],
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    };
    const { host, catalog } = createHost(sections);
    try {
      const [k2] = await catalog.listModels();
      expect(k2).toMatchObject({
        model: 'k2',
        support_efforts: ['low', 'high', 'max'],
        default_effort: 'max',
      });
    } finally {
      host.dispose();
    }
  });

  it('projects official Anthropic effort metadata inferred from the model name', async () => {
    const sections = structuredClone(catalogSections);
    (sections['providers'] as Record<string, ProviderConfig>)['anthropic'] = { type: 'anthropic' };
    (sections['models'] as Record<string, ModelRecord>)['opus'] = {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      maxContextSize: 200000,
    };
    const { host, catalog } = createHost(sections);
    try {
      const opus = (await catalog.listModels()).find((model) => model.model === 'opus');
      expect(opus).toMatchObject({
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high', 'max'],
        default_effort: 'high',
      });
    } finally {
      host.dispose();
    }
  });

  it('projects latest Opus efforts for unknown Claude-marked Anthropic-compatible models', async () => {
    const sections = structuredClone(catalogSections);
    (sections['providers'] as Record<string, ProviderConfig>)['custom'] = { type: 'anthropic' };
    (sections['models'] as Record<string, ModelRecord>)['compatible'] = {
      provider: 'custom',
      model: 'custom-claude-model',
      maxContextSize: 128000,
    };
    const { host, catalog } = createHost(sections);
    try {
      const compatible = (await catalog.listModels()).find((model) => model.model === 'compatible');
      expect(compatible).toMatchObject({
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        default_effort: 'high',
      });
    } finally {
      host.dispose();
    }
  });

  it('does not project fallback efforts for clearly non-Claude Anthropic-compatible models', async () => {
    const sections = structuredClone(catalogSections);
    (sections['providers'] as Record<string, ProviderConfig>)['custom'] = { type: 'anthropic' };
    (sections['models'] as Record<string, ModelRecord>)['compatible'] = {
      provider: 'custom',
      model: 'compatible-model',
      maxContextSize: 128000,
    };
    const { host, catalog } = createHost(sections);
    try {
      const compatible = (await catalog.listModels()).find((model) => model.model === 'compatible');
      expect(compatible?.capabilities).toBeUndefined();
      expect(compatible?.support_efforts).toBeUndefined();
      expect(compatible?.default_effort).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('projects latest Opus efforts for a flat providerless Claude-marked Anthropic model', async () => {
    const { host, catalog } = createHost({
      providers: {},
      models: {
        compatible: {
          model: 'custom-claude-model',
          baseUrl: 'https://anthropic.example.test',
          protocol: 'anthropic',
          maxContextSize: 128000,
        },
      },
    });
    try {
      const compatible = (await catalog.listModels()).find((model) => model.model === 'compatible');
      expect(compatible).toMatchObject({
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        default_effort: 'high',
      });
    } finally {
      host.dispose();
    }
  });

  it('does not project fallback efforts for a flat providerless non-Claude Anthropic model', async () => {
    const { host, catalog } = createHost({
      providers: {},
      models: {
        compatible: {
          model: 'compatible-model',
          baseUrl: 'https://anthropic.example.test',
          protocol: 'anthropic',
          maxContextSize: 128000,
        },
      },
    });
    try {
      const compatible = (await catalog.listModels()).find((model) => model.model === 'compatible');
      expect(compatible?.capabilities).toBeUndefined();
      expect(compatible?.support_efforts).toBeUndefined();
      expect(compatible?.default_effort).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('does not project fallback efforts for unknown Kimi-managed Anthropic models', async () => {
    const sections = structuredClone(catalogSections);
    (sections['models'] as Record<string, ModelRecord>)['compatible'] = {
      provider: 'kimi',
      protocol: 'anthropic',
      model: 'compatible-model',
      maxContextSize: 128000,
    };
    const { host, catalog } = createHost(sections);
    try {
      const compatible = (await catalog.listModels()).find((model) => model.model === 'compatible');
      expect(compatible).toMatchObject({ provider: 'kimi', model: 'compatible' });
      expect(compatible?.capabilities).toBeUndefined();
      expect(compatible?.support_efforts).toBeUndefined();
      expect(compatible?.default_effort).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('projects effort fields from overrides when present', async () => {
    const sections = structuredClone(catalogSections);
    (sections['models'] as Record<string, ModelRecord>)['k2'] = {
      ...(catalogSections['models'] as Record<string, ModelRecord>)['k2'],
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      overrides: { supportEfforts: ['low', 'high', 'max'], defaultEffort: 'max' },
    };
    const { host, catalog } = createHost(sections);
    try {
      const [k2] = await catalog.listModels();
      expect(k2).toMatchObject({
        support_efforts: ['low', 'high', 'max'],
        default_effort: 'max',
      });
    } finally {
      host.dispose();
    }
  });

  it('falls back to the config projection for models that fail materialization', async () => {
    const { host, catalog } = createHost({
      providers: {},
      models: {
        bad: {
          model: 'bad-model',
          baseUrl: 'https://x.test/v1',
          apiKey: 'sk',
          oauth: { storage: 'file', key: 'oauth/bad' },
          maxContextSize: 1000,
          displayName: 'Bad',
        },
      },
    });
    try {
      await expect(catalog.listModels()).resolves.toEqual([
        { provider: '', model: 'bad', display_name: 'Bad', max_context_size: 1000 },
      ]);
    } finally {
      host.dispose();
    }
  });

  it('lists providers with per-provider models, default model, and credential state', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.listProviders()).resolves.toEqual([
        {
          id: 'kimi',
          type: 'kimi',
          base_url: 'https://api.example.test/v1',
          default_model: 'k2',
          has_api_key: true,
          status: 'connected',
          models: ['k2', 'turbo'],
        },
        {
          id: 'openai',
          type: 'openai',
          has_api_key: false,
          status: 'unconfigured',
          models: ['gpt4o'],
        },
      ]);
    } finally {
      host.dispose();
    }
  });

  it('detects env-bag credentials through the vendor endpoint declarations', async () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: { type: 'kimi', env: { KIMI_API_KEY: 'kimi-env-key' } },
        claude: { type: 'anthropic', env: { ANTHROPIC_API_KEY: 'anthropic-env-key' } },
        empty: { type: 'openai' },
      },
      models: {},
    });
    try {
      const providers = await catalog.listProviders();
      const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
      expect(byId['kimi']).toMatchObject({ has_api_key: true, status: 'connected' });
      expect(byId['claude']).toMatchObject({ has_api_key: true, status: 'connected' });
      expect(byId['empty']).toMatchObject({ has_api_key: false, status: 'unconfigured' });
    } finally {
      host.dispose();
    }
  });

  it('marks an OAuth provider connected when a cached token exists', async () => {
    const { host, catalog } = createHost(
      {
        providers: { acme: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/acme' } } },
        models: {},
      },
      stubModelOAuthTokens(undefined, 'cached-token'),
    );
    try {
      const [provider] = await catalog.listProviders();
      expect(provider).toMatchObject({ id: 'acme', has_api_key: false, status: 'connected' });
    } finally {
      host.dispose();
    }
  });

  it('gets a single provider by id and reports provider.not_found for an unknown one', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.getProvider('kimi')).resolves.toMatchObject({
        id: 'kimi',
        default_model: 'k2',
        models: ['k2', 'turbo'],
      });
      await expect(catalog.getProvider('missing')).rejects.toSatisfy(
        (error) => isError2(error) && error.code === 'provider.not_found',
      );
      expect(isErrorCode('provider.not_found')).toBe(true);
      expect(isErrorCode('model.not_found')).toBe(true);
    } finally {
      host.dispose();
    }
  });
});

describe('ModelCatalog setDefaultModel', () => {
  it('moves the registry default pointer and returns the wire model', async () => {
    const { host, models, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.setDefaultModel('turbo')).resolves.toEqual({
        default_model: 'turbo',
        model: {
          provider: 'kimi',
          model: 'turbo',
          display_name: 'Kimi Turbo',
          max_context_size: 32768,
        },
      });
      expect(models.getDefaultModel()).toBe('turbo');
    } finally {
      host.dispose();
    }
  });

  it('throws model.not_found for an unknown model', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.setDefaultModel('missing')).rejects.toSatisfy(
        (error) => isError2(error) && error.code === 'model.not_found',
      );
    } finally {
      host.dispose();
    }
  });

  it('rejects a model that fails materialization', async () => {
    const { host, models, catalog } = createHost({
      providers: {},
      models: {
        bad: {
          model: 'bad-model',
          baseUrl: 'https://x.test/v1',
          apiKey: 'sk',
          oauth: { storage: 'file', key: 'oauth/bad' },
        },
      },
    });
    try {
      await expect(catalog.setDefaultModel('bad')).rejects.toThrow();
      expect(models.getDefaultModel()).toBeUndefined();
    } finally {
      host.dispose();
    }
  });
});
