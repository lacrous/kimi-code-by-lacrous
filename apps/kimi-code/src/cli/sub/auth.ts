/**
 * `kimi auth` sub-command — credential lifecycle for a configured provider.
 *
 * Split from `kimi provider` because the two answer different questions.
 * `kimi provider auth <id>` changes an endpoint's key and takes it on argv,
 * which is what a script wants; this command is the human path, where the key
 * is read masked from the terminal so it never reaches shell history, the
 * process table, or a screenshot of the scrollback.
 *
 * `list` and `status` are strictly offline. They exist to answer "is this
 * logged in?", and an inspection that silently rotates a token or blocks on a
 * network call is worse than one that reports a stale truth — so every read
 * path here goes through the cached-only credential resolution.
 */

import { createKimiHarness, type KimiConfig, type KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import type { OAuthTokenInspection } from '@moonshot-ai/kimi-code-oauth';
import type { Command } from 'commander';

import { createKimiCodeHostIdentity } from '#/cli/version';
import { writeProviderRecords } from '#/utils/provider-records';
import { readSecretFromTerminal } from '#/utils/process/secret-input';

import { resolveTestCredential, type ProviderDeps, type TestCredential } from './provider';

export interface AuthDeps extends ProviderDeps {
  /** Reads one masked secret; `undefined` means the user aborted. */
  readonly readSecret: (prompt: string) => Promise<string | undefined>;
}

/**
 * Credential state as reported to the user. `expired` and `revoked` are
 * distinct from `missing` on purpose: both mean a credential *exists* and the
 * fix is to sign in again, whereas `missing` may be a provider that never had
 * one configured.
 */
type AuthState = 'authenticated' | 'expired' | 'revoked' | 'missing' | 'none';

interface AuthRow {
  readonly providerId: string;
  readonly state: AuthState;
  readonly detail: string;
  /** ISO-8601, only when the underlying record carries a usable expiry. */
  readonly expiresAt?: string;
}

interface JsonOutputOptions {
  readonly json: boolean;
}

const EXIT_FAILURE = 1;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reports whether a provider that is *not* OAuth-based currently has something
 * a request could send. No expiry is involved, so the answer is just present or
 * not: a static key stays valid until someone rotates it.
 */
function stateFromCredential(credential: TestCredential): AuthState {
  // `auth_scheme = "none"` resolves *successfully* — that is why it reports
  // `present` — but nothing is actually sent, so it must not read as signed in.
  if (credential.detail.includes('auth_scheme = "none"')) return 'none';
  return credential.present ? 'authenticated' : 'missing';
}

function oauthRow(providerId: string, inspection: OAuthTokenInspection, now: number): AuthRow {
  if (inspection.state === 'missing') {
    return {
      providerId,
      state: 'missing',
      detail: `MISSING (no cached OAuth token — run \`kimi auth login ${providerId}\`)`,
    };
  }
  if (inspection.state === 'revoked') {
    return {
      providerId,
      state: 'revoked',
      detail: `REVOKED (the stored token was revoked) — run \`kimi auth login ${providerId}\``,
    };
  }
  const expired = inspection.expiresAt <= now;
  return {
    providerId,
    state: expired ? 'expired' : 'authenticated',
    detail: expired
      ? 'EXPIRED (cached token lapsed; the runtime refreshes it on the next request)'
      : `PRESENT (oauth token cached${inspection.hasRefreshToken ? ', refreshable' : ', no refresh token'})`,
    ...(expired ? undefined : { expiresAt: new Date(inspection.expiresAt).toISOString() }),
  };
}

async function collectRows(deps: AuthDeps, harness: KimiHarness): Promise<AuthRow[]> {
  const config = await harness.getConfig();
  const ids = Object.keys(config.providers).toSorted();
  const now = Date.now();
  const rows: AuthRow[] = [];
  for (const id of ids) {
    const provider = config.providers[id];
    if (provider === undefined) continue;
    if (provider.oauth === undefined) {
      const credential = await resolveTestCredential(deps, harness, id, provider, 'cached');
      rows.push({ providerId: id, state: stateFromCredential(credential), detail: credential.detail });
      continue;
    }
    try {
      rows.push(oauthRow(id, await harness.auth.inspectToken(id, provider.oauth), now));
    } catch (error) {
      rows.push({ providerId: id, state: 'missing', detail: `MISSING (token inspection failed: ${errorMessage(error)})` });
    }
  }
  return rows;
}

function printTable(deps: AuthDeps, rows: readonly AuthRow[]): void {
  if (rows.length === 0) {
    deps.stdout.write('No providers are configured. Add one with `kimi provider add-builtin` or `kimi provider add-manual`.\n');
    return;
  }
  const labelWidth = Math.max(...rows.map((row) => row.providerId.length));
  for (const row of rows) {
    const status = row.state.toUpperCase().padEnd(12);
    const expiry = row.expiresAt === undefined ? '' : `  expires ${row.expiresAt}`;
    deps.stdout.write(`${status} ${row.providerId.padEnd(labelWidth)}  ${row.detail}${expiry}\n`);
  }
}

export async function handleAuthList(deps: AuthDeps, opts: JsonOutputOptions): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const rows = await collectRows(deps, harness);
  if (opts.json) {
    deps.stdout.write(`${JSON.stringify(rows, undefined, 2)}\n`);
    return;
  }
  printTable(deps, rows);
}

export async function handleAuthStatus(
  deps: AuthDeps,
  providerId: string,
  opts: JsonOutputOptions,
): Promise<void> {
  const id = providerId.trim();
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  const provider = config.providers[id];
  if (provider === undefined) {
    const known = Object.keys(config.providers).toSorted();
    deps.stderr.write(
      known.length > 0
        ? `Unknown provider "${id}". Configured providers: ${known.join(', ')}.\n`
        : `Unknown provider "${id}". No providers are configured.\n`,
    );
    deps.exit(EXIT_FAILURE);
    return;
  }
  const rows = await collectRows(deps, harness);
  const row = rows.find((candidate) => candidate.providerId === id);
  if (row === undefined) {
    deps.stderr.write(`Unknown provider "${id}".\n`);
    deps.exit(EXIT_FAILURE);
    return;
  }
  if (opts.json) {
    deps.stdout.write(`${JSON.stringify(row, undefined, 2)}\n`);
    return;
  }
  deps.stdout.write(`${row.providerId}\nStatus: ${row.state}\nDetail: ${row.detail}\n`);
  if (row.expiresAt !== undefined) deps.stdout.write(`Expires: ${row.expiresAt}\n`);
}

/**
 * Stores an API key for a provider that does not use OAuth.
 *
 * OAuth providers are refused rather than half-handled: `auth.login` provisions
 * the managed Kimi Code record, so sending it a third-party provider's host
 * would authenticate against one identity provider and write another's config.
 * Pointing the user at `kimi login` is the honest answer.
 */
export async function handleAuthLogin(deps: AuthDeps, providerId: string): Promise<void> {
  const id = providerId.trim();
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  const provider = config.providers[id];
  if (provider === undefined) {
    deps.stderr.write(`Unknown provider "${id}".\n`);
    deps.exit(EXIT_FAILURE);
    return;
  }
  if (provider.oauth !== undefined) {
    deps.stderr.write(
      `"${id}" authenticates with OAuth, which \`kimi auth login\` does not drive. Use \`kimi login\` instead.\n`,
    );
    deps.exit(EXIT_FAILURE);
    return;
  }

  deps.stdout.write(`Enter the API key for "${id}" (input is hidden, and never stored in shell history):\n`);
  const key = await deps.readSecret(`API key for ${id}: `);
  if (key === undefined) {
    deps.stderr.write('Cancelled. No credential was stored.\n');
    deps.exit(EXIT_FAILURE);
    return;
  }
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    deps.stderr.write('Cancelled. No credential was stored.\n');
    deps.exit(EXIT_FAILURE);
    return;
  }

  // Mutually exclusive with the env reference, exactly as `provider edit` does
  // it: the record is rebuilt without `apiKeyEnv` (a spread cannot delete), and
  // written with replace semantics — a deep-merge write would leave the env
  // reference standing next to the new key and the runtime would reject the
  // record as a conflict.
  const next: Record<string, unknown> = { ...provider, apiKey: trimmed };
  delete next['apiKeyEnv'];
  config.providers[id] = next as KimiConfig['providers'][string];
  await writeProviderRecords(harness, config.providers);
  deps.stdout.write(`Stored a credential for "${id}". The value is not shown again.\n`);
}

/**
 * Clears a provider's credential while leaving the provider itself in place.
 *
 * Deleting the provider would also drop its model aliases and possibly the
 * user's `default_model`, so signing out and deleting are deliberately different
 * operations here.
 */
export async function handleAuthLogout(deps: AuthDeps, providerId: string): Promise<void> {
  const id = providerId.trim();
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  const provider = config.providers[id];
  if (provider === undefined) {
    deps.stderr.write(`Unknown provider "${id}".\n`);
    deps.exit(EXIT_FAILURE);
    return;
  }

  const cleared: string[] = [];
  const next: Record<string, unknown> = { ...provider };
  if (next['apiKey'] !== undefined) {
    delete next['apiKey'];
    cleared.push('api_key');
  }
  if (next['apiKeyEnv'] !== undefined) {
    delete next['apiKeyEnv'];
    cleared.push('api_key_env');
  }
  if (next['oauth'] !== undefined) {
    await harness.auth.logout(id);
    cleared.push('oauth token');
  }

  if (cleared.length === 0) {
    deps.stdout.write(`"${id}" had no stored credential; nothing to clear.\n`);
    return;
  }
  config.providers[id] = next as KimiConfig['providers'][string];
  // Clearing a credential is a removal, and `setConfig` deep-merges — the
  // fields deleted above would survive it and the command would report success
  // with the secret still sitting in config.toml.
  await writeProviderRecords(harness, config.providers);
  deps.stdout.write(`Cleared ${cleared.join(', ')} for "${id}". The provider itself is still configured.\n`);
}

export async function handleAuthRefresh(deps: AuthDeps, providerId: string): Promise<void> {
  const id = providerId.trim();
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  const provider = config.providers[id];
  if (provider === undefined) {
    deps.stderr.write(`Unknown provider "${id}".\n`);
    deps.exit(EXIT_FAILURE);
    return;
  }
  if (provider.oauth === undefined) {
    deps.stderr.write(
      `"${id}" uses a static API key, which does not expire. Replace it with \`kimi auth login ${id}\`.\n`,
    );
    deps.exit(EXIT_FAILURE);
    return;
  }

  const result = await harness.auth.refresh(id, provider.oauth);
  if (result.token.state !== 'valid') {
    deps.stderr.write(`Could not refresh the credential for "${id}" (state: ${result.token.state}). Run \`kimi auth login\`.\n`);
    deps.exit(EXIT_FAILURE);
    return;
  }
  deps.stdout.write(
    `Refreshed the credential for "${id}". Expires: ${new Date(result.token.expiresAt).toISOString()}.\n`,
  );
}

export function registerAuthCommand(parent: Command, deps?: Partial<AuthDeps>): void {
  const auth = parent
    .command('auth')
    .description('Inspect and manage provider credentials.');

  const resolved = (overrides: Partial<AuthDeps> = {}): ResolvedAuthDeps =>
    resolveDeps({ ...deps, ...overrides });

  auth
    .command('list')
    .description('List every configured provider and whether it has a usable credential.')
    .option('--json', 'Emit machine-readable JSON.', false)
    .action(async (options: { json?: boolean }) => {
      await runAction(resolved(), (runDeps) => handleAuthList(runDeps, { json: options.json === true }));
    });

  auth
    .command('status <providerId>')
    .description('Report one provider\'s credential state.')
    .option('--json', 'Emit machine-readable JSON.', false)
    .action(async (providerId: string, options: { json?: boolean }) => {
      await runAction(resolved(), (runDeps) => handleAuthStatus(runDeps, providerId, { json: options.json === true }));
    });

  auth
    .command('login <providerId>')
    .description('Prompt for an API key with the input hidden and store it for a provider.')
    .action(async (providerId: string) => {
      await runAction(resolved(), (runDeps) => handleAuthLogin(runDeps, providerId));
    });

  auth
    .command('logout <providerId>')
    .description('Clear a provider\'s stored credential, leaving the provider configured.')
    .action(async (providerId: string) => {
      await runAction(resolved(), (runDeps) => handleAuthLogout(runDeps, providerId));
    });

  auth
    .command('refresh <providerId>')
    .description('Force an OAuth token rotation now instead of at the next request.')
    .action(async (providerId: string) => {
      await runAction(resolved(), (runDeps) => handleAuthRefresh(runDeps, providerId));
    });
}

type ResolvedAuthDeps = AuthDeps & { readonly close: () => Promise<void> };

/**
 * Mirrors `provider`'s boundary: handlers report their own expected failures,
 * but anything that escapes must still end as a one-line error and exit 1
 * rather than an unhandled rejection with a stack trace. `close()` is needed
 * because the v2 harness boots watchers that keep the event loop alive.
 */
async function runAction(
  deps: ResolvedAuthDeps,
  run: (deps: AuthDeps) => Promise<void>,
): Promise<void> {
  try {
    await run(deps);
  } catch (error) {
    deps.stderr.write(`${errorMessage(error)}\n`);
    deps.exit(EXIT_FAILURE);
  } finally {
    await deps.close();
  }
}

function resolveDeps(overrides: Partial<AuthDeps> = {}): ResolvedAuthDeps {
  let harness: KimiHarness | undefined;
  const identity = createKimiCodeHostIdentity();
  return {
    getHarness:
      overrides.getHarness ??
      (() => {
        harness ??= createKimiHarness({ identity });
        return harness;
      }),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    env: overrides.env ?? process.env,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
    readSecret:
      overrides.readSecret ??
      ((prompt: string) => readSecretFromTerminal({ prompt, input: process.stdin, output: process.stdout })),
    close: async () => {
      await harness?.close();
    },
  };
}