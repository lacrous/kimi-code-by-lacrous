/**
 * `kimi auth` CLI unit tests.
 *
 * Two things are load-bearing here beyond the obvious output assertions:
 *
 * 1. No assertion may ever see a credential. `list` and `status` report state,
 *    so the tests pin that the rendered output does not contain the key that
 *    the fake harness holds — a regression that echoed `api_key` would be a
 *    silent secret leak that no other test would catch.
 * 2. `list`/`status` are offline. They must not call `getAccessToken()` (which
 *    refreshes over the network) and must not call `refresh()`. The spies make
 *    either one a test failure rather than a silent behavior change.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import type { KimiConfig, KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import type { OAuthTokenInspection } from '@moonshot-ai/kimi-code-oauth';

import {
  handleAuthList,
  handleAuthLogin,
  handleAuthLogout,
  handleAuthRefresh,
  handleAuthStatus,
  registerAuthCommand,
  type AuthDeps,
} from '#/cli/sub/auth';

import { makeConfigStoreHarness, type ConfigStoreHarness } from '../helpers/config-store';

const SECRET = 'sk-test-not-a-real-key-0000';

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
  }
}

interface FakeAuth {
  inspectToken: (providerName: string, oauthRef: unknown) => Promise<OAuthTokenInspection>;
  logout: (providerName: string) => Promise<unknown>;
  refresh: (providerName: string, oauthRef: unknown) => Promise<unknown>;
  getCachedAccessToken: (providerName: string, oauthRef: unknown) => Promise<string | undefined>;
  getAccessToken: () => Promise<string>;
  calls: string[];
}

interface FakeHarness extends ConfigStoreHarness {
  auth: FakeAuth;
}

function makeHarness(
  initial: KimiConfig,
  inspections: Record<string, OAuthTokenInspection> = {},
): { harness: FakeHarness; current: () => KimiConfig; auth: FakeAuth } {
  const store = makeConfigStoreHarness(initial);
  const calls: string[] = [];
  const auth: FakeAuth = {
    inspectToken: async (providerName) => {
      calls.push(`inspectToken:${providerName}`);
      return inspections[providerName] ?? { state: 'missing' };
    },
    logout: async (providerName) => {
      calls.push(`logout:${providerName}`);
      return {};
    },
    refresh: async (providerName) => {
      calls.push(`refresh:${providerName}`);
      return { providerName, ok: true, token: { state: 'missing' } };
    },
    getCachedAccessToken: async (providerName) => {
      calls.push(`getCachedAccessToken:${providerName}`);
      return SECRET;
    },
    getAccessToken: async () => {
      calls.push('getAccessToken');
      return SECRET;
    },
    calls,
  };
  const harness: FakeHarness = { ...store.harness, auth };
  return { harness, current: store.current, auth };
}

function makeDeps(
  harness: FakeHarness,
  overrides: Partial<AuthDeps> = {},
): {
  deps: AuthDeps;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const deps: AuthDeps = {
    getHarness: () => harness as unknown as ReturnType<AuthDeps['getHarness']>,
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
    }) as AuthDeps['exit'],
    readSecret: async () => undefined,
    ...overrides,
  };
  return { deps, stdout, stderr, exitCodes };
}

/**
 * A handler that reports its own failure calls `deps.exit(1)`, which the test
 * double turns into a throw. Swallow that specific throw and let anything else
 * through, so a real bug is not hidden as "the command failed".
 */
async function tryRun<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ExitCalled) return undefined;
    throw error;
  }
}

function baseConfig(): KimiConfig {
  return {
    providers: {
      acme: { type: 'openai', apiKey: SECRET },
      envkey: { type: 'openai', apiKeyEnv: 'ACME_KEY' },
      local: { type: 'openai', authScheme: { kind: 'none' } },
      wireonly: { type: 'openai' },
      sso: { type: 'openai', oauth: { storage: 'file', key: 'default' } },
    },
  } as KimiConfig;
}

const TEXT = { json: false };
const JSON_OUT = { json: true };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('kimi auth list', () => {
  it('reports one row per configured provider without touching the network', async () => {
    const { harness, auth } = makeHarness(baseConfig(), {
      sso: { state: 'valid', expiresAt: Date.now() + 3_600_000, hasRefreshToken: true, tokenType: 'Bearer', scope: 'x' },
    });
    // `wireonly` declares no credential, so the row is only worth calling
    // `MISSING` honestly when the vendor fallback it would actually use is set.
    const { deps, stdout } = makeDeps(harness, { env: { OPENAI_API_KEY: 'vendor-fallback-value' } });

    await handleAuthList(deps, TEXT);

    const out = stdout.join('');
    expect(out).toContain('AUTHENTICATED acme');
    expect(out).toContain('PRESENT (api_key from config.toml)');
    expect(out).toContain('MISSING (api_key_env "ACME_KEY" is not set or is empty)');
    expect(out).toContain('PRESENT (auth_scheme = "none", no credential sent)');
    expect(out).toContain('falls back to $OPENAI_API_KEY');
    expect(out).toContain('PRESENT (oauth token cached, refreshable)');
    expect(out).not.toContain('vendor-fallback-value');
    expect(auth.calls).toEqual(['inspectToken:sso']);
    expect(auth.calls).not.toContain('getAccessToken');
    expect(auth.calls).not.toContain('refresh:sso');
  });

  it('marks a lapsed oauth token expired instead of authenticated', async () => {
    const { harness } = makeHarness(baseConfig(), {
      sso: {
        state: 'valid',
        expiresAt: Date.now() - 1_000,
        hasRefreshToken: true,
        tokenType: 'Bearer',
        scope: 'x',
      },
    });
    const { deps, stdout } = makeDeps(harness);

    await handleAuthList(deps, TEXT);

    expect(stdout.join('')).toContain('EXPIRED      sso');
  });

  it('distinguishes a revoked token from one that was never configured', async () => {
    const { harness } = makeHarness(baseConfig(), {
      sso: { state: 'revoked', scope: 'x', tokenType: 'Bearer' },
    });
    const { deps, stdout } = makeDeps(harness);

    await handleAuthList(deps, TEXT);

    const out = stdout.join('');
    expect(out).toContain('REVOKED');
    expect(out).not.toContain('no cached OAuth token');
  });

  it('never prints a credential, in text or json', async () => {
    const { harness } = makeHarness(baseConfig(), {
      sso: { state: 'valid', expiresAt: Date.now() + 60_000, hasRefreshToken: true, tokenType: 'Bearer', scope: 'x' },
    });
    const text = makeDeps(harness);
    await handleAuthList(text.deps, TEXT);
    expect(text.stdout.join('')).not.toContain(SECRET);

    const json = makeDeps(harness);
    await handleAuthList(json.deps, JSON_OUT);
    expect(json.stdout.join('')).not.toContain(SECRET);
    const parsed = JSON.parse(json.stdout.join('')) as Array<Record<string, unknown>>;
    expect(parsed.map((row) => row['providerId'])).toEqual(['acme', 'envkey', 'local', 'sso', 'wireonly']);
    expect(parsed.map((row) => row['state'])).toEqual([
      'authenticated',
      'missing',
      'none',
      'authenticated',
      'missing',
    ]);
  });

  it('tells an empty config how to add a provider', async () => {
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout } = makeDeps(harness);

    await handleAuthList(deps, TEXT);

    expect(stdout.join('')).toContain('kimi provider add-builtin');
  });
});

describe('kimi auth status', () => {
  it('prints one provider state', async () => {
    const { harness } = makeHarness(baseConfig());
    const { deps, stdout } = makeDeps(harness);

    await handleAuthStatus(deps, 'acme', TEXT);

    expect(stdout.join('')).toBe('acme\nStatus: authenticated\nDetail: PRESENT (api_key from config.toml)\n');
  });

  it('shows an expiry for a live oauth token', async () => {
    const expiresAt = Date.now() + 3_600_000;
    const { harness } = makeHarness(baseConfig(), {
      sso: { state: 'valid', expiresAt, hasRefreshToken: false, tokenType: 'Bearer', scope: 'x' },
    });
    const { deps, stdout } = makeDeps(harness);

    await handleAuthStatus(deps, 'sso', TEXT);

    expect(stdout.join('')).toContain(`Expires: ${new Date(expiresAt).toISOString()}`);
  });

  it('lists the configured ids when the provider is unknown', async () => {
    const { harness } = makeHarness(baseConfig());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleAuthStatus(deps, 'nope', TEXT));

    expect(stderr.join('')).toContain('Configured providers: acme, envkey, local, sso, wireonly.');
    expect(exitCodes).toEqual([1]);
  });

  it('says nothing is configured when the config has no providers', async () => {
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleAuthStatus(deps, 'nope', TEXT));

    expect(stderr.join('')).toContain('No providers are configured.');
    expect(exitCodes).toEqual([1]);
  });
});

describe('kimi auth login', () => {
  it('stores the key read from the terminal and drops an env reference', async () => {
    const { harness, current } = makeHarness(baseConfig());
    const { deps, stdout } = makeDeps(harness, {
      readSecret: async () => `${SECRET}-rotated`,
    });

    await handleAuthLogin(deps, 'envkey');

    const saved = current().providers['envkey'];
    expect(saved?.['apiKey']).toBe(`${SECRET}-rotated`);
    expect(saved?.['apiKeyEnv']).toBeUndefined();
    expect(stdout.join('')).toContain('not shown again');
  });

  it('stores nothing when the user aborts at the prompt', async () => {
    const { harness, current } = makeHarness(baseConfig());
    const { deps, stderr, exitCodes } = makeDeps(harness, {
      readSecret: async () => undefined,
    });

    await tryRun(() => handleAuthLogin(deps, 'acme'));

    expect(current().providers['acme']?.['apiKey']).toBe(SECRET);
    expect(stderr.join('')).toContain('Cancelled.');
    expect(exitCodes).toEqual([1]);
  });

  it('stores nothing when the prompt returns only whitespace', async () => {
    const { harness, current } = makeHarness(baseConfig());
    const { deps, exitCodes } = makeDeps(harness, { readSecret: async () => '   ' });

    await tryRun(() => handleAuthLogin(deps, 'acme'));

    expect(current().providers['acme']?.['apiKey']).toBe(SECRET);
    expect(exitCodes).toEqual([1]);
  });

  it('refuses an oauth provider and points at kimi login', async () => {
    const { harness, auth } = makeHarness(baseConfig());
    const { deps, stderr, exitCodes } = makeDeps(harness, { readSecret: async () => SECRET });

    await tryRun(() => handleAuthLogin(deps, 'sso'));

    expect(stderr.join('')).toContain('Use `kimi login` instead.');
    expect(exitCodes).toEqual([1]);
    expect(auth.calls).toEqual([]);
  });

  it('never echoes the key back', async () => {
    const { harness } = makeHarness(baseConfig());
    const { deps, stdout, stderr } = makeDeps(harness, { readSecret: async () => `${SECRET}-rotated` });

    await handleAuthLogin(deps, 'acme');

    expect(stdout.join('')).not.toContain(SECRET);
    expect(stderr.join('')).not.toContain(SECRET);
  });
});

describe('kimi auth logout', () => {
  it('clears an inline key and leaves the provider configured', async () => {
    const { harness, current } = makeHarness(baseConfig());
    const { deps, stdout } = makeDeps(harness);

    await handleAuthLogout(deps, 'acme');

    expect(current().providers['acme']).toBeDefined();
    expect(current().providers['acme']?.['apiKey']).toBeUndefined();
    expect(stdout.join('')).toContain('The provider itself is still configured.');
  });

  it('clears an env reference too', async () => {
    const { harness, current } = makeHarness(baseConfig());
    const { deps, stdout } = makeDeps(harness);

    await handleAuthLogout(deps, 'envkey');

    expect(current().providers['envkey']?.['apiKeyEnv']).toBeUndefined();
    expect(stdout.join('')).toContain('api_key_env');
  });

  it('clears the cached oauth token for an oauth provider', async () => {
    const { harness, current, auth } = makeHarness(baseConfig());
    const { deps } = makeDeps(harness);

    await handleAuthLogout(deps, 'sso');

    expect(auth.calls).toEqual(['logout:sso']);
    expect(current().providers['sso']).toBeDefined();
  });

  it('is a no-op for a provider with no credential', async () => {
    const { harness, current } = makeHarness(baseConfig());
    const { deps, stdout } = makeDeps(harness);

    await handleAuthLogout(deps, 'wireonly');

    expect(stdout.join('')).toContain('had no stored credential');
    expect(current().providers['wireonly']).toBeDefined();
  });
});

describe('kimi auth refresh', () => {
  it('forces a rotation for an oauth provider', async () => {
    const expiresAt = Date.now() + 7_200_000;
    const { harness, auth } = makeHarness(baseConfig());
    auth.refresh = async (providerName) => {
      auth.calls.push(`refresh:${providerName}`);
      return {
        providerName,
        ok: true,
        token: {
          state: 'valid',
          expiresAt,
          hasRefreshToken: true,
          tokenType: 'Bearer',
          scope: 'x',
        },
      };
    };
    const { deps, stdout } = makeDeps(harness);

    await handleAuthRefresh(deps, 'sso');

    expect(stdout.join('')).toContain(new Date(expiresAt).toISOString());
    expect(auth.calls).toEqual(['refresh:sso']);
  });

  it('reports a failed rotation and exits 1', async () => {
    const { harness } = makeHarness(baseConfig());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleAuthRefresh(deps, 'sso'));

    expect(stderr.join('')).toContain('state: missing');
    expect(exitCodes).toEqual([1]);
  });

  it('explains that an api key does not expire', async () => {
    const { harness, auth } = makeHarness(baseConfig());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleAuthRefresh(deps, 'acme'));

    expect(stderr.join('')).toContain('does not expire');
    expect(auth.calls).toEqual([]);
    expect(exitCodes).toEqual([1]);
  });
});

describe('kimi auth registration', () => {
  it('exposes exactly the five credential sub-commands', () => {
    const { harness } = makeHarness(baseConfig());
    const program = new Command();
    registerAuthCommand(program, makeDeps(harness).deps);

    const auth = program.commands.find((command) => command.name() === 'auth');
    expect(auth?.commands.map((command) => command.name())).toEqual([
      'list',
      'status',
      'login',
      'logout',
      'refresh',
    ]);
  });

  it('routes --json only where the output is machine-readable', () => {
    const { harness } = makeHarness(baseConfig());
    const program = new Command();
    registerAuthCommand(program, makeDeps(harness).deps);

    const jsonFlags = (program.commands
      .find((command) => command.name() === 'auth')
      ?.commands.filter((command) => command.options.some((option) => option.long === '--json'))
      .map((command) => command.name())) ?? [];
    expect(jsonFlags).toEqual(['list', 'status']);
  });
});