import { describe, expect, it } from 'vitest';

import { REDACTED, redactSecretString, redactSecrets } from '#/credentials/redaction';
import {
  applyCredential,
  credentialsRecovery,
  createOAuthCredentialProvider,
  createStaticCredentialProvider,
} from '#/credentials/credentials';
import type { LlmModel } from '#/llm/model';
import type { LlmRecoveryContext, LlmRecoveryRecord } from '#/llm/requester/recovery';
import type { LlmCredentialProvider } from '#/llm/requester/requester';

const MODEL: LlmModel = {
  provider: 'fake',
  model: 'fake-model',
  apiKey: 'base-key',
  defaultHeaders: { 'x-base': '1' },
};

describe('createStaticCredentialProvider', () => {
  it('resolves the static api key and never recovers', async () => {
    const provider = createStaticCredentialProvider('sk-1');
    expect(await provider.resolve()).toEqual({ apiKey: 'sk-1' });
    expect(provider.canRecover).toBeUndefined();
    expect(provider.invalidate).toBeUndefined();
  });

  it('resolves undefined for missing or blank keys', async () => {
    expect(await createStaticCredentialProvider(undefined).resolve()).toBeUndefined();
    expect(await createStaticCredentialProvider('   ').resolve()).toBeUndefined();
  });
});

describe('createOAuthCredentialProvider', () => {
  it('refreshes with force on invalidate and consumes the refresh on the next resolve', async () => {
    const calls: (boolean | undefined)[] = [];
    const provider = createOAuthCredentialProvider((options) => {
      calls.push(options?.force);
      return Promise.resolve('tok');
    });

    await provider.resolve();
    await provider.resolve();
    provider.invalidate?.();
    await provider.resolve();
    await provider.resolve();

    expect(calls).toEqual([undefined, undefined, true, undefined]);
  });

  it('starts the forced refresh eagerly on invalidate, before the next resolve', async () => {
    const calls: (boolean | undefined)[] = [];
    const provider = createOAuthCredentialProvider((options) => {
      calls.push(options?.force);
      return Promise.resolve('tok');
    });

    provider.invalidate?.();

    expect(calls).toEqual([true]);

    await provider.resolve();

    expect(calls).toEqual([true]);
  });

  it('coalesces repeated invalidates into a single refresh', async () => {
    const calls: (boolean | undefined)[] = [];
    const provider = createOAuthCredentialProvider((options) => {
      calls.push(options?.force);
      return Promise.resolve('tok');
    });

    provider.invalidate?.();
    provider.invalidate?.();
    await provider.resolve();

    expect(calls).toEqual([true]);
  });

  it('propagates a failed refresh to the consuming resolve and recovers afterwards', async () => {
    let calls = 0;
    const provider = createOAuthCredentialProvider(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('login required')) : Promise.resolve('tok');
    });

    provider.invalidate?.();

    await expect(provider.resolve()).rejects.toThrow('login required');
    await expect(provider.resolve()).resolves.toEqual({ apiKey: 'tok' });
  });

  it('recovers only from 401 errors', () => {
    const provider = createOAuthCredentialProvider(() => Promise.resolve('tok'));
    expect(provider.canRecover?.(Object.assign(new Error('x'), { status: 401 }))).toBe(true);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { statusCode: 401 }))).toBe(true);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { statusCode: 403 }))).toBe(false);
    expect(provider.canRecover?.(new Error('boom'))).toBe(false);
  });

  it('resolves undefined when the token source has no token', async () => {
    const provider = createOAuthCredentialProvider(() => Promise.resolve(undefined));
    await expect(provider.resolve()).resolves.toBeUndefined();
  });
});

describe('applyCredential', () => {
  it('returns the model unchanged when the credential is undefined', () => {
    expect(applyCredential(MODEL, undefined)).toBe(MODEL);
  });

  it('overrides the api key and merges headers', () => {
    const applied = applyCredential(MODEL, { apiKey: 'fresh', headers: { 'x-auth': 't' } });
    expect(applied.apiKey).toBe('fresh');
    expect(applied.defaultHeaders).toEqual({ 'x-base': '1', 'x-auth': 't' });
  });

  it('keeps the model api key when the credential carries none', () => {
    const applied = applyCredential(MODEL, { headers: { 'x-auth': 't' } });
    expect(applied.apiKey).toBe('base-key');
  });
});

function recoveryContext(
  error: unknown,
  appliedRecoveries: readonly LlmRecoveryRecord[] = [],
  credentialProvider?: LlmCredentialProvider,
): LlmRecoveryContext {
  return { error: error as LlmRecoveryContext['error'], messages: [], appliedRecoveries, credentialProvider };
}

const unauthorized = Object.assign(new Error('unauthorized'), { status: 401 });
const forbidden = Object.assign(new Error('forbidden'), { status: 403 });

describe('credentialsRecovery', () => {
  it('proposes a credentials refresh on a recoverable error', () => {
    const provider = createOAuthCredentialProvider(() => Promise.resolve('tok'));
    expect(credentialsRecovery.propose(recoveryContext(unauthorized, [], provider))).toEqual({
      strategy: 'credentials',
      action: 'refresh',
      beforeNextAttempt: expect.any(Function),
    });
  });

  it('invalidates the credentials before the next attempt', () => {
    let invalidations = 0;
    const provider: LlmCredentialProvider = {
      resolve: () => ({ apiKey: 'tok' }),
      canRecover: () => true,
      invalidate: () => {
        invalidations += 1;
      },
    };
    const proposal = credentialsRecovery.propose(recoveryContext(unauthorized, [], provider));
    proposal?.beforeNextAttempt?.();
    expect(invalidations).toBe(1);
  });

  it('does not propose when the strategy was already applied', () => {
    const provider = createOAuthCredentialProvider(() => Promise.resolve('tok'));
    const applied: LlmRecoveryRecord[] = [{ strategy: 'credentials', action: 'refresh' }];
    expect(
      credentialsRecovery.propose(recoveryContext(unauthorized, applied, provider)),
    ).toBeUndefined();
  });

  it('does not propose without recoverable credentials', () => {
    expect(credentialsRecovery.propose(recoveryContext(unauthorized))).toBeUndefined();
    expect(
      credentialsRecovery.propose(
        recoveryContext(unauthorized, [], createStaticCredentialProvider('sk-1')),
      ),
    ).toBeUndefined();
    expect(
      credentialsRecovery.propose(
        recoveryContext(
          forbidden,
          [],
          createOAuthCredentialProvider(() => Promise.resolve('tok')),
        ),
      ),
    ).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  it('redacts values by secret key name regardless of casing or separators', () => {
    const out = redactSecrets({
      api_key: 'a',
      apiKey: 'b',
      access_token: 'c',
      refresh_token: 'd',
      authorization: 'e',
      cookie: 'f',
      'x-api-key': 'g',
      secret: 'h',
      password: 'i',
    }) as Record<string, unknown>;
    for (const key of Object.keys(out)) {
      expect(out[key]).toBe(REDACTED);
    }
  });

  it('redacts compound key names that end with a secret suffix', () => {
    const out = redactSecrets({
      dbPassword: 'a',
      clientSecret: 'b',
      awsSecretKey: 'c',
      proxyAuthorization: 'd',
      sessionCookie: 'e',
      maxTokens: 10,
      tokens: ['x'],
      user: 'x',
    }) as Record<string, unknown>;
    expect(out['dbPassword']).toBe(REDACTED);
    expect(out['clientSecret']).toBe(REDACTED);
    expect(out['awsSecretKey']).toBe(REDACTED);
    expect(out['proxyAuthorization']).toBe(REDACTED);
    expect(out['sessionCookie']).toBe(REDACTED);
    expect(out['maxTokens']).toBe(10);
    expect(out['tokens']).toEqual(['x']);
    expect(out['user']).toBe('x');
  });

  it('masks secret-looking values stored under unknown keys', () => {
    const out = redactSecrets({ note: 'sk-abcdefghijklabcd' }) as Record<string, unknown>;
    expect(out['note']).toBe('sk-************abcd');
    expect(String(out['note'])).not.toContain('efghij');
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactSecrets({
      headers: { Authorization: 'Bearer abc123', 'X-Trace': 'sk-abcdefghijklabcd' },
      items: [{ apiKey: 'sk-abcdefghijklabcd' }, 7],
    }) as { headers: Record<string, unknown>; items: Array<Record<string, unknown> | number> };
    expect(out.headers['Authorization']).toBe(REDACTED);
    expect(out.headers['X-Trace']).toBe('sk-************abcd');
    expect(out.items[0]?.['apiKey']).toBe(REDACTED);
    expect(out.items[1]).toBe(7);
  });

  it('keeps non-string leaves untouched', () => {
    const out = redactSecrets({ n: 1, b: true, nil: null, u: undefined }) as Record<string, unknown>;
    expect(out['n']).toBe(1);
    expect(out['b']).toBe(true);
    expect(out['nil']).toBeNull();
    expect(out['u']).toBeUndefined();
  });

  it('collapses cycles and collapses nesting past the depth limit', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic['self'] = cyclic;
    const withCycle = redactSecrets({ cyclic }) as Record<string, Record<string, unknown>>;
    expect(withCycle['cyclic']?.['self']).toBe('[REDACTED:cycle]');

    let deep: Record<string, unknown> = { n: 'leaf' };
    for (let i = 0; i < 20; i++) deep = { down: deep };
    expect(JSON.stringify(redactSecrets({ deep }))).toContain('[REDACTED:depth]');
  });
});

describe('redactSecretString', () => {
  it('fully redacts assignments of known secret keys', () => {
    expect(redactSecretString('failed access_token=abc123')).toBe(`failed access_token=${REDACTED}`);
    expect(redactSecretString('api_key=def456')).toBe(`api_key=${REDACTED}`);
    expect(redactSecretString('cookie: sid=secret-cookie')).toBe(`cookie: ${REDACTED}`);
    expect(redactSecretString('Authorization: Bearer secret-token')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it('masks provider key shapes, keeping only the last four characters', () => {
    expect(redactSecretString('sk-abcdefghijklabcd')).toBe('sk-************abcd');
    expect(redactSecretString('pk-abcdefghijklmnopqrst')).toMatch(/^pk-\*+qrst$/);
    expect(redactSecretString('ghp_abcdefghijklmnopqrstuvwx')).toMatch(/^ghp_\*+uvwx$/);
    expect(redactSecretString('xoxb-1234567890-abcdefghij')).toMatch(/^xoxb-\*+ghij$/);
    expect(redactSecretString('Bearer abcdefghijkl')).toBe('Bearer ********ijkl');
    expect(
      redactSecretString('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP'),
    ).toMatch(/^eyJ\*+4CVP$/);
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecretString('bash exited with code 2')).toBe('bash exited with code 2');
    expect(redactSecretString('/Users/foo/bar/file.ts')).toBe('/Users/foo/bar/file.ts');
    expect(redactSecretString('Bearer of good news')).toBe('Bearer of good news');
  });
});
