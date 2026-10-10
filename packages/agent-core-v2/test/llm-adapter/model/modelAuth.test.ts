import { describe, expect, it } from 'vitest';

import { ConfigErrors } from '#/app/config/errors';
import {
  assertProviderBaseUrl,
  checkProviderBaseUrl,
} from '#/llm-adapter/provider/base-url';
import type { ProviderConfig } from '#/llm-adapter/provider/provider';
import type { ModelRecord } from '#/llm-adapter/model/model';
import {
  deriveProviderId,
  effectiveModelConfig,
  resolveEndpointBaseUrl,
  resolveModelAuthMaterial,
  resolveModelForReady,
} from '#/llm-adapter/model/model-auth';

function authMaterial(args: {
  model: ModelRecord;
  provider?: ProviderConfig;
}): ReturnType<typeof resolveModelAuthMaterial> {
  return resolveModelAuthMaterial({
    modelId: 'm1',
    model: args.model,
    provider: args.provider,
    providerName: 'p1',
  });
}

describe('resolveModelAuthMaterial', () => {
  it('prefers the model inline credentials over everything else', () => {
    expect(
      authMaterial({
        model: { model: 'm', apiKey: 'model-key' },
        provider: { type: 'openai', apiKey: 'provider-key' },
      }),
    ).toEqual({ apiKey: 'model-key' });
    expect(
      authMaterial({
        model: { model: 'm', oauth: { storage: 'file', key: 'k' }, providerId: 'p1' },
        provider: { type: 'openai', apiKey: 'provider-key' },
      }),
    ).toEqual({ oauth: { storage: 'file', key: 'k' }, oauthProviderKey: 'p1' });
  });

  it('rejects apiKey+oauth on the same level as config.invalid', () => {
    expect(() =>
      authMaterial({ model: { model: 'm', apiKey: 'k', oauth: { storage: 'file', key: 'k' } } }),
    ).toThrowError(expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }));
    expect(() =>
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'openai', apiKey: 'k', oauth: { storage: 'file', key: 'k' } },
      }),
    ).toThrowError(expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }));
  });

  it('returns the declared variable name for provider api_key_env without reading the value', () => {
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'openai', apiKeyEnv: 'ACME_API_KEY' },
      }),
    ).toEqual({ apiKeyEnv: 'ACME_API_KEY' });
  });

  it('prefers provider api_key_env over the env sub-table conventional names', () => {
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'kimi', apiKeyEnv: 'ACME_API_KEY', env: { KIMI_API_KEY: 'sub-table-key' } },
      }),
    ).toEqual({ apiKeyEnv: 'ACME_API_KEY' });
  });

  it('rejects apiKey+apiKeyEnv and apiKeyEnv+oauth on a provider as config.invalid', () => {
    expect(() =>
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'openai', apiKey: 'k', apiKeyEnv: 'ACME_API_KEY' },
      }),
    ).toThrowError(expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }));
    expect(() =>
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'openai', apiKeyEnv: 'ACME_API_KEY', oauth: { storage: 'file', key: 'k' } },
      }),
    ).toThrowError(expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }));
  });

  it('reads env-bag credentials through the vendor endpoint declarations', () => {
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'kimi', env: { KIMI_API_KEY: 'kimi-env-key' } },
      }),
    ).toEqual({ apiKey: 'kimi-env-key' });
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'anthropic', env: { ANTHROPIC_API_KEY: 'anthropic-env-key' } },
      }),
    ).toEqual({ apiKey: 'anthropic-env-key' });
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'openai', env: { OPENAI_API_KEY: 'openai-env-key' } },
      }),
    ).toEqual({ apiKey: 'openai-env-key' });
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: { type: 'google-genai', env: { GOOGLE_API_KEY: 'google-env-key' } },
      }),
    ).toEqual({ apiKey: 'google-env-key' });
    expect(
      authMaterial({
        model: { model: 'm' },
        provider: {
          type: 'google-genai',
          env: { VERTEXAI_API_KEY: 'vertex-env-key', GOOGLE_API_KEY: 'google-env-key' },
        },
      }),
    ).toEqual({ apiKey: 'vertex-env-key' });
  });

  it('returns empty material when nothing is configured', () => {
    expect(authMaterial({ model: { model: 'm' }, provider: { type: 'openai' } })).toEqual({});
    expect(authMaterial({ model: { model: 'm' } })).toEqual({});
  });
});

describe('effectiveModelConfig', () => {
  it('applies overrides over the base record', () => {
    const effective = effectiveModelConfig({
      model: 'm',
      maxOutputSize: 8192,
      overrides: { maxOutputSize: 4096, displayName: 'M' },
    });
    expect(effective.maxOutputSize).toBe(4096);
    expect(effective.displayName).toBe('M');
  });

  it('drops a defaultEffort the override effort list does not contain', () => {
    const effective = effectiveModelConfig({
      model: 'm',
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      overrides: { supportEfforts: ['low'] },
    });
    expect(effective.supportEfforts).toEqual(['low']);
    expect(effective.defaultEffort).toBeUndefined();
  });

  it('infers the Anthropic profile for non-trait-driven vendors only', () => {
    const record: ModelRecord = { model: 'claude-sonnet-4-5', protocol: 'anthropic' };
    const inferred = effectiveModelConfig(record, 'anthropic');
    expect(inferred.supportEfforts).toEqual(['low', 'medium', 'high']);
    expect(inferred.defaultEffort).toBe('high');
    expect(inferred.capabilities).toContain('thinking');

    const kimiRouted = effectiveModelConfig({ model: 'kimi-k2', protocol: 'anthropic' }, 'kimi');
    expect(kimiRouted.supportEfforts).toBeUndefined();
    expect(kimiRouted.capabilities).toBeUndefined();
  });
});

describe('deriveProviderId', () => {
  it('keys flat providers by the baseUrl origin', () => {
    expect(deriveProviderId('https://api.example.test/v1')).toBe('api.example.test');
    expect(deriveProviderId('not-a-url')).toBe('not-a-url');
  });
});

const BUILT_IN_PROVIDER_BASE_URLS: readonly string[] = [
  'https://api.cline.bot/api/v1',
  'https://openrouter.ai/api/v1',
  'https://opencode.ai/zen/v1',
  'https://opencode.ai/zen/go/v1',
  'https://integrate.api.nvidia.com/v1',
  'https://router.bynara.id/v1',
  'https://tokenharbor.ai/v1',
  'https://api.openai.com/v1',
  'https://api.anthropic.com',
  'https://generativelanguage.googleapis.com/v1beta',
  'https://api.x.ai/v1',
  'https://api.groq.com/openai/v1',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  'https://api.minimax.io/v1',
  'https://api.deepseek.com',
  'https://api.mistral.ai/v1',
  'https://router.huggingface.co/v1',
  'https://api.moonshot.ai/v1',
];

describe('checkProviderBaseUrl', () => {
  it('accepts every built-in provider base URL', () => {
    for (const baseUrl of BUILT_IN_PROVIDER_BASE_URLS) {
      expect(checkProviderBaseUrl(baseUrl)).toEqual({ ok: true, baseUrl });
    }
  });

  it('accepts a valid URL and trims surrounding whitespace', () => {
    expect(checkProviderBaseUrl('  https://api.example.test/v1  ')).toEqual({
      ok: true,
      baseUrl: 'https://api.example.test/v1',
    });
  });

  it('rejects an empty value', () => {
    expect(checkProviderBaseUrl('   ')).toEqual({ ok: false, reason: 'cannot be empty.' });
  });

  it('rejects embedded credentials so a pasted key cannot ride along in the URL', () => {
    expect(checkProviderBaseUrl('https://user:pass@api.example.test/v1')).toEqual({
      ok: false,
      reason:
        'must not embed a username or password; put the key in api_key instead.',
    });
    expect(checkProviderBaseUrl('https://sk-secret@api.example.test/v1')).toEqual({
      ok: false,
      reason:
        'must not embed a username or password; put the key in api_key instead.',
    });
  });

  it('rejects a malformed URL', () => {
    expect(checkProviderBaseUrl('api.example.test/v1')).toEqual({
      ok: false,
      reason: '"api.example.test/v1" is not a valid URL.',
    });
  });

  it('rejects a non-http(s) scheme', () => {
    expect(checkProviderBaseUrl('ftp://api.example.test/v1')).toEqual({
      ok: false,
      reason: 'must be http(s), got "ftp:".',
    });
    expect(checkProviderBaseUrl('file:///etc/passwd')).toEqual({
      ok: false,
      reason: 'must be http(s), got "file:".',
    });
  });

  it('rejects plain http for a non-local host', () => {
    expect(checkProviderBaseUrl('http://api.example.test/v1')).toEqual({
      ok: false,
      reason:
        'must use https for a non-local host; plain http is only allowed for loopback and private-network hosts such as localhost, 127.0.0.1 or 192.168.x.x.',
    });
  });

  it('accepts plain http for a local model server', () => {
    for (const baseUrl of [
      'http://localhost:11434/v1',
      'http://localhost/v1',
      'http://127.0.0.1:8000/v1',
      'http://[::1]:1234/v1',
      'http://models.localhost/v1',
    ]) {
      expect(checkProviderBaseUrl(baseUrl)).toEqual({ ok: true, baseUrl });
    }
  });

  it('accepts plain http for a self-hosted gateway on a private address', () => {
    for (const baseUrl of [
      'http://192.168.1.50:8000/v1',
      'http://10.0.0.7:1234/v1',
      'http://172.16.4.2:8080/v1',
      'http://169.254.10.10:11434/v1',
      'http://0.0.0.0:8000/v1',
      'http://[fd00::1]:8000/v1',
      'http://[fe80::1]:8000/v1',
    ]) {
      expect(checkProviderBaseUrl(baseUrl)).toEqual({ ok: true, baseUrl });
    }
  });

  it('still rejects plain http for an address just outside the private range', () => {
    for (const baseUrl of ['http://172.32.4.2:8080/v1', 'http://11.0.0.1:8080/v1', 'http://192.169.1.1:8080/v1']) {
      expect(checkProviderBaseUrl(baseUrl)).toEqual({
        ok: false,
        reason:
          'must use https for a non-local host; plain http is only allowed for loopback and private-network hosts such as localhost, 127.0.0.1 or 192.168.x.x.',
      });
    }
  });
});

describe('assertProviderBaseUrl', () => {
  it('throws config.invalid naming the offending field and the reason', () => {
    expect(() => assertProviderBaseUrl('http://api.example.test/v1', 'providers.acme.base_url')).toThrowError(
      expect.objectContaining({
        code: ConfigErrors.codes.CONFIG_INVALID,
        message:
          'providers.acme.base_url must use https for a non-local host; plain http is only allowed for loopback and private-network hosts such as localhost, 127.0.0.1 or 192.168.x.x.',
      }),
    );
  });
});

describe('resolveEndpointBaseUrl', () => {
  function baseUrlOf(model: ModelRecord, provider: ProviderConfig): string | undefined {
    return resolveEndpointBaseUrl({ model, provider, modelId: 'm1', providerId: 'prov-a' });
  }

  it('prefers the model base URL over the provider one', () => {
    expect(
      baseUrlOf(
        { model: 'm', baseUrl: 'https://model.example.test/v1' },
        { type: 'openai', baseUrl: 'https://provider.example.test/v1' },
      ),
    ).toBe('https://model.example.test/v1');
  });

  it('falls back to the provider base URL and then to the vendor endpoint env bag', () => {
    expect(
      baseUrlOf({ model: 'm' }, { type: 'openai', baseUrl: 'https://provider.example.test/v1' }),
    ).toBe('https://provider.example.test/v1');
    expect(baseUrlOf({ model: 'm' }, { type: 'openai', env: { OPENAI_BASE_URL: 'https://env.example.test/v1' } })).toBe(
      'https://env.example.test/v1',
    );
    expect(baseUrlOf({ model: 'm' }, { type: 'kimi' })).toBe('https://api.moonshot.ai/v1');
    expect(baseUrlOf({ model: 'm' }, { type: 'openai' })).toBeUndefined();
  });

  it('keeps a local http endpoint reachable', () => {
    expect(
      baseUrlOf({ model: 'm' }, { type: 'openai', baseUrl: 'http://localhost:11434/v1' }),
    ).toBe('http://localhost:11434/v1');
    expect(
      baseUrlOf({ model: 'm' }, { type: 'openai', env: { OPENAI_BASE_URL: 'http://127.0.0.1:8000/v1' } }),
    ).toBe('http://127.0.0.1:8000/v1');
  });

  it('rejects a model base URL naming models.<id>.base_url', () => {
    expect(() =>
      baseUrlOf({ model: 'm', baseUrl: 'https://user:pass@model.example.test/v1' }, { type: 'openai' }),
    ).toThrowError(
      expect.objectContaining({
        code: ConfigErrors.codes.CONFIG_INVALID,
        message:
          'models.m1.base_url must not embed a username or password; put the key in api_key instead.',
      }),
    );
  });

  it('rejects a provider base URL naming providers.<id>.base_url', () => {
    expect(() =>
      baseUrlOf({ model: 'm' }, { type: 'openai', baseUrl: 'http://gateway.example.test/v1' }),
    ).toThrowError(
      expect.objectContaining({
        code: ConfigErrors.codes.CONFIG_INVALID,
        message:
          'providers.prov-a.base_url must use https for a non-local host; plain http is only allowed for loopback and private-network hosts such as localhost, 127.0.0.1 or 192.168.x.x.',
      }),
    );
  });

  it('rejects a base URL coming from the provider env bag, naming the env key', () => {
    expect(() =>
      baseUrlOf({ model: 'm' }, { type: 'openai', env: { OPENAI_BASE_URL: 'ftp://gateway.example.test' } }),
    ).toThrowError(
      expect.objectContaining({
        code: ConfigErrors.codes.CONFIG_INVALID,
        message: 'providers.prov-a.env.OPENAI_BASE_URL must be http(s), got "ftp:".',
      }),
    );
  });
});

describe('resolveModelForReady', () => {
  const providers: Readonly<Record<string, ProviderConfig>> = {
    'prov-a': { type: 'openai', apiKey: 'sk-a' },
    '__kimi_env__': { type: 'kimi', baseUrl: 'https://api.example.test/coding/v1' },
  };

  it('reports no-default when the model id is missing or empty', () => {
    expect(resolveModelForReady(undefined, {}, providers)).toEqual({
      resolved: false,
      reason: 'no-default',
    });
    expect(resolveModelForReady('', {}, providers)).toEqual({
      resolved: false,
      reason: 'no-default',
    });
    expect(resolveModelForReady('   ', {}, providers)).toEqual({
      resolved: false,
      reason: 'no-default',
    });
  });

  it('reports dangling-alias when the alias is absent from the models table', () => {
    expect(resolveModelForReady('ghost', {}, providers)).toEqual({
      resolved: false,
      reason: 'dangling-alias',
    });
  });

  it('looks up the configured id as an exact key, trimming only to reject blanks', () => {
    const models = { m: { providerId: 'prov-a', model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady(' m ', models, providers)).toEqual({
      resolved: false,
      reason: 'dangling-alias',
    });
    const padded = { ' m ': { providerId: 'prov-a', model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady(' m ', padded, providers)).toEqual({ resolved: true });
  });

  it('resolves a providerId pointing at an existing provider', () => {
    const models = { m: { providerId: 'prov-a', model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady('m', models, providers)).toEqual({ resolved: true });
  });

  it('resolves a provider field pointing at an existing provider', () => {
    const models = { m: { provider: 'prov-a', model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady('m', models, providers)).toEqual({ resolved: true });
  });

  it('reports provider-missing when a named provider is absent from the providers table', () => {
    expect(
      resolveModelForReady('m', { m: { providerId: 'gone', model: 'gpt' } }, providers),
    ).toEqual({ resolved: false, reason: 'provider-missing' });
    expect(
      resolveModelForReady('m', { m: { provider: 'gone', model: 'gpt' } }, providers),
    ).toEqual({ resolved: false, reason: 'provider-missing' });
  });

  it('resolves a providerless flat model through its baseUrl', () => {
    const models = {
      m: {
        baseUrl: 'https://api.example.test/v1',
        model: 'gpt',
        protocol: 'openai' as const,
        maxContextSize: 4096,
        apiKey: 'sk-x',
      },
    };
    expect(resolveModelForReady('m', models, {})).toEqual({ resolved: true });
  });

  it('resolves a model omitting provider fields through the configured defaultProvider', () => {
    const models = { m: { model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady('m', models, providers, 'prov-a')).toEqual({ resolved: true });
  });

  it('reports provider-missing when the configured defaultProvider is absent from the providers table', () => {
    const models = { m: { model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady('m', models, providers, 'gone')).toEqual({
      resolved: false,
      reason: 'provider-missing',
    });
  });

  it('looks up the default provider as an exact key, trimming only to reject blanks', () => {
    const models = { m: { model: 'gpt', maxContextSize: 4096 } };
    expect(resolveModelForReady('m', models, providers, ' prov-a ')).toEqual({
      resolved: false,
      reason: 'provider-missing',
    });
    const paddedProviders = { ' prov-a ': { type: 'openai', apiKey: 'sk-a' } };
    expect(resolveModelForReady('m', models, paddedProviders, ' prov-a ')).toEqual({
      resolved: true,
    });
    expect(resolveModelForReady('m', models, providers, '   ')).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });

  it('reports unresolvable when provider id, provider field, and baseUrl are all absent', () => {
    expect(resolveModelForReady('m', { m: { model: 'gpt' } }, providers)).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });

  it('resolves the env-overlay injected model against the env provider', () => {
    const models = {
      '__kimi_env_model__': {
        provider: '__kimi_env__',
        model: 'kimi-for-coding',
        maxContextSize: 262144,
      },
    };
    expect(resolveModelForReady('__kimi_env_model__', models, providers)).toEqual({
      resolved: true,
    });
  });

  it('reports unresolvable when the provider exists but the wire name is missing', () => {
    const models = { m: { provider: 'prov-a' } };
    expect(resolveModelForReady('m', models, providers)).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });

  it('resolves through the effective config with overrides merged', () => {
    const models = {
      m: {
        provider: 'prov-a',
        model: 'gpt',
        overrides: { maxContextSize: 4096, displayName: 'G' },
      },
    };
    expect(resolveModelForReady('m', models, providers)).toEqual({ resolved: true });
  });

  it('reports unresolvable when the provider-backed model lacks maxContextSize', () => {
    const models = { m: { provider: 'prov-a', model: 'gpt' } };
    expect(resolveModelForReady('m', models, providers)).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });

  it('reports unresolvable when maxContextSize is not positive', () => {
    const models = { m: { provider: 'prov-a', model: 'gpt', maxContextSize: 0 } };
    expect(resolveModelForReady('m', models, providers)).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });

  it('reports unresolvable when a providerless flat model lacks a protocol', () => {
    const models = {
      m: { baseUrl: 'https://api.example.test/v1', model: 'gpt', maxContextSize: 4096 },
    };
    expect(resolveModelForReady('m', models, {})).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });

  it('reports unresolvable when neither endpoint nor protocol is derivable from the provider', () => {
    const models = { m: { provider: 'prov-x', model: 'gpt', maxContextSize: 4096 } };
    const unknownVendors: Readonly<Record<string, ProviderConfig>> = {
      'prov-x': { type: 'my-vendor', apiKey: 'sk-x' },
    };
    expect(resolveModelForReady('m', models, unknownVendors)).toEqual({
      resolved: false,
      reason: 'unresolvable',
    });
  });
});
