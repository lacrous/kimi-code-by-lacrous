/**
 * `kimi provider` sub-command — non-interactive provider management.
 *
 * Mirrors the TUI `/provider` flow (apps/kimi-code/src/tui/commands/provider.ts)
 * for the custom-registry path so users can import an api.json document, drop
 * a provider, or inspect what is configured without launching the TUI.
 *
 * `add` writes the same `source = { kind: 'apiJson', url, apiKey }` blob the
 * TUI does; the next launch's `refreshAllProviderModels`
 * (apps/kimi-code/src/tui/utils/refresh-providers.ts) groups by URL, retries
 * available API-key candidates, and re-fetches the model list, so periodic
 * refresh is automatic.
 */

import {
  declaredProviderCredential,
  DiscoveredModelsAuthError,
  fetchDiscoveredModels,
  normalizeDiscoveryBaseUrl,
  type DiscoveredModelInfo,
  type DiscoveryAuthStyle,
} from '@moonshot-ai/kimi-code-oauth';
import {
  applyCatalogProvider,
  catalogProviderModels,
  CatalogFetchError,
  RegistryImportError,
  type ImportCustomRegistryResult,
  createKimiHarness,
  DEFAULT_CATALOG_URL,
  removeProviderFromConfig,
  resolveCatalogImport,
  type Catalog,
  type CatalogProviderEntry,
  type KimiConfig,
  type KimiHarness,
  type OAuthRef,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { createKimiCodeHostIdentity, createKimiCodeUserAgent } from '#/cli/version';
import { fetchCatalogOrBuiltIn } from '#/utils/catalog-fetch';
import {
  BUILT_IN_PROVIDERS,
  getBuiltInProvider,
  type BuiltInProviderPin,
} from '#/utils/built-in-providers';
import { parseProviderBaseUrl } from '#/utils/custom-provider';
import {
  refreshAllProviderModels,
  type RefreshProviderHost,
} from '#/tui/utils/refresh-providers';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ProviderDeps {
  readonly getHarness: () => KimiHarness;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly env: NodeJS.ProcessEnv;
  readonly exit: (code: number) => never;
}

interface AddOptions {
  readonly apiKey?: string;
}

/**
 * Wire types `kimi provider add-manual` may declare.
 *
 * `anthropic` and `google-genai` are accepted because both vendors do expose a
 * model-list route (`GET /v1/models` with `x-api-key` + `anthropic-version`;
 * `GET /v1beta/models` with `x-goog-api-key`), and the discovery branch handles
 * each one's auth style and response shape. A hand-written provider pointing at
 * any other host on these wires can still declare models by hand.
 *
 * Exported so the vendor table's `wire` union can be checked against it: a
 * built-in declaring a wire `add-manual` rejects writes a config entry the
 * engine can never discover models for.
 */
export const MANUAL_PROVIDER_TYPES = [
  'openai',
  'openai_responses',
  'kimi',
  'anthropic',
  'google-genai',
] as const;

type ManualProviderType = (typeof MANUAL_PROVIDER_TYPES)[number];

function isManualProviderType(value: string): value is ManualProviderType {
  return (MANUAL_PROVIDER_TYPES as readonly string[]).includes(value);
}

interface AddManualOptions {
  readonly type: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  /**
   * Per-model wire pins from the vendor table, written into config as
   * `providers.<id>.protocolOverrides`. Only a built-in sets these: a manual
   * provider's author is the user, who can write the same map themselves.
   */
  readonly protocolOverrides?: Readonly<Record<string, BuiltInProviderPin>>;
  /**
   * Vendor's expected key prefix, used only to warn. Vendors change prefixes
   * without notice, so a mismatch is never fatal — it usually means the key
   * belongs to a different provider, which otherwise surfaces as an opaque 401.
   */
  readonly keyHint?: string;
  /** Display name for messages that mention the vendor. */
  readonly displayName?: string;
}

/** The flags `edit` honours, in the order they are listed back to the user. */
const EDIT_FLAG_NAMES = ['--type', '--base-url', '--api-key', '--api-key-env'] as const;

/** `auth` is `edit` narrowed to the credential pair. */
const AUTH_FLAG_NAMES = ['--api-key', '--api-key-env'] as const;

export interface EditOptions {
  readonly type?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  /** Re-read the model list after applying the change. Defaults to true. */
  readonly refresh?: boolean;
  /**
   * Narrows the hint printed when the patch comes out empty. `auth` reuses this
   * handler but accepts only the credential pair, and must not point at
   * `--type` / `--base-url`: commander rejects those on its command line, so
   * the hint would send the user to an error instead of a fix.
   */
  readonly acceptedFlags?: readonly string[];
}

/**
 * Changes an already-configured provider's protocol, endpoint or credential.
 *
 * Editing in place (rather than remove-then-add) keeps the provider's existing
 * model aliases and, crucially, the user's `default_model`: removing the
 * provider would drop both and silently repoint the next session. Only the
 * fields named on the command line are touched.
 */
export async function handleProviderEdit(
  deps: ProviderDeps,
  providerId: string,
  opts: EditOptions,
): Promise<void> {
  const id = providerId.trim();
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  const existing = requireProvider(deps, config, id);

  const patch: Record<string, unknown> = {};
  if (opts.type !== undefined) {
    const wire = opts.type.trim();
    if (!isManualProviderType(wire)) {
      deps.stderr.write(
        `Unsupported --type "${wire}" (expected one of: ${MANUAL_PROVIDER_TYPES.join(', ')}).\n`,
      );
      deps.exit(1);
    }
    patch['type'] = wire;
  }
  if (opts.baseUrl !== undefined) {
    const check = parseProviderBaseUrl(opts.baseUrl);
    if (!check.ok) {
      deps.stderr.write(`--base-url ${check.reason}\n`);
      deps.exit(1);
    }
    patch['baseUrl'] = check.baseUrl;
  }

  // Credential handling mirrors the config schema's mutual exclusion: an
  // inline key replaces an env reference and vice versa, because the runtime
  // rejects a record carrying both.
  const inline = resolveApiKey(opts.apiKey, deps.env);
  const envName = opts.apiKeyEnv?.trim();
  if (inline !== undefined && envName !== undefined) {
    deps.stderr.write('Pass either --api-key or --api-key-env, not both.\n');
    deps.exit(1);
  }
  if (inline !== undefined) {
    patch['apiKey'] = inline;
    delete patch['apiKeyEnv'];
  } else if (envName !== undefined) {
    if (envName.length === 0) {
      deps.stderr.write('--api-key-env cannot be empty.\n');
      deps.exit(1);
    }
    patch['apiKeyEnv'] = envName;
    delete patch['apiKey'];
  }

  if (Object.keys(patch).length === 0) {
    const flags = opts.acceptedFlags ?? EDIT_FLAG_NAMES;
    const accepted =
      flags.length > 1 ? `${flags.slice(0, -1).join(', ')} or ${flags.at(-1)}` : (flags[0] ?? '');
    deps.stderr.write(`Nothing to change. Pass ${accepted}.\n`);
    deps.exit(1);
  }

  // A spread cannot delete: `{ ...existing, apiKeyEnv }` would leave the old
  // inline `apiKey` in place, and the runtime rejects a record carrying both.
  // So the credential is rebuilt explicitly from whichever side won.
  const merged: Record<string, unknown> = { ...existing, ...patch };
  if (inline !== undefined) delete merged['apiKeyEnv'];
  if (envName !== undefined) delete merged['apiKey'];
  config.providers[id] = merged as KimiConfig['providers'][string];
  await harness.setConfig({ providers: config.providers });
  deps.stdout.write(`Updated "${id}": ${Object.keys(patch).join(', ')}.\n`);

  if (opts.refresh === false) {
    deps.stdout.write('Skipped model refresh (--no-refresh).\n');
    return;
  }

  deps.stdout.write('Refreshing models from the endpoint…\n');
  const result = await refreshAllProviderModels(providerRefreshHost(harness, id), { providerId: id });

  const failure = result.failed.find((f) => f.provider === id);
  if (failure !== undefined) {
    deps.stderr.write(`Model refresh failed: ${failure.reason}\n`);
    deps.stderr.write('The change was saved; existing models are left untouched.\n');
    deps.exit(1);
  }
  const change = result.changed.find((c) => c.providerId === id);
  deps.stdout.write(
    change === undefined
      ? 'Model list unchanged.\n'
      : `Models refreshed: +${String(change.added)} added, ${String(change.removed)} removed.\n`,
  );
}

interface ListOptions {
  readonly json: boolean;
}

interface CatalogListOptions {
  readonly json: boolean;
  readonly filter?: string;
  readonly url?: string;
}

interface CatalogAddOptions {
  readonly apiKey?: string;
  readonly defaultModel?: string;
  readonly url?: string;
  readonly baseUrl?: string;
}

export async function handleProviderAdd(
  deps: ProviderDeps,
  url: string,
  opts: AddOptions,
): Promise<void> {
  const apiKey = resolveApiKey(opts.apiKey, deps.env);

  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    deps.stderr.write('Registry URL is required.\n');
    deps.exit(1);
  }

  const harness = deps.getHarness();
  await harness.ensureConfigFile();

  let result: ImportCustomRegistryResult;
  try {
    result = await harness.importCustomRegistry({
      url: trimmedUrl,
      apiKey,
      setDefaultWhenUnset: false,
    });
  } catch (error) {
    if (!(error instanceof RegistryImportError) || error.phase === 'apply') throw error;
    if (error.phase === 'empty') {
      deps.stderr.write(`Registry at ${trimmedUrl} contained no usable providers.\n`);
      deps.exit(1);
    }
    const suffix = error.status === undefined ? '' : ` (HTTP ${String(error.status)})`;
    deps.stderr.write(`Failed to fetch registry${suffix}: ${errorMessage(error)}\n`);
    if (apiKey === undefined && (error.status === 401 || error.status === 403)) {
      deps.stderr.write(
        'This registry requires authentication — pass --api-key <key> or set KIMI_REGISTRY_API_KEY.\n',
      );
    }
    deps.exit(1);
  }

  const count = result.providers.length;
  deps.stdout.write(
    `Imported ${String(count)} provider${count === 1 ? '' : 's'} ` +
      `(${String(result.modelsImported)} model${result.modelsImported === 1 ? '' : 's'}) from ${trimmedUrl}:\n`,
  );
  for (const provider of result.providers) {
    deps.stdout.write(`  - ${provider.id}\n`);
  }
  for (const [id, envName] of Object.entries(result.credentialEnv)) {
    deps.stdout.write(
      `provider "${id}" declares credential env var "${envName}" — set api_key_env in config.toml to use it\n`,
    );
  }
}

/**
 * Built-in provider shortcuts live in `#/utils/built-in-providers` so this CLI
 * and the TUI `/provider` menu read one table — the endpoint a key is sent to
 * must never be able to differ between the two surfaces.
 */
export interface AddBuiltinOptions {
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
}

/**
 * Configures one of the {@link BUILT_IN_PROVIDERS} and discovers its models,
 * sharing the discovery path with `add-manual` (both delegate to the engine's
 * refresh orchestrator rather than reimplementing `/models`).
 */
export async function handleProviderAddBuiltin(
  deps: ProviderDeps,
  providerId: string,
  opts: AddBuiltinOptions,
): Promise<void> {
  const id = providerId.trim().toLowerCase();
  const builtin = getBuiltInProvider(id);
  if (builtin === undefined) {
    deps.stderr.write(
      `Unknown built-in provider "${providerId}" (known: ${BUILT_IN_PROVIDERS.map((p) => p.id).join(', ')}).\n` +
        'Run `kimi provider catalog list` to browse all catalog providers.\n',
    );
    deps.exit(1);
  }
  await handleProviderAddManual(deps, id, {
    type: builtin.wire,
    baseUrl: builtin.baseUrl,
    apiKey: opts.apiKey,
    apiKeyEnv: opts.apiKeyEnv,
    protocolOverrides: builtin.protocolOverrides,
    keyHint: builtin.keyHint,
    displayName: builtin.name,
  });
  // `deps.exit` never returns (it throws), and `handleProviderAddManual` calls
  // it on every discovery failure, so reaching this line already means at least
  // one model was listed. Kept explicit because the alternative — printing it
  // from a `finally` or ignoring the exit code — would report a working
  // provider on the paths where the user is told to hand-edit config.toml.
  deps.stdout.write(`${builtin.name} is ready — run /provider in the TUI to pick a default model.\n`);
}

/**
 * Adds a provider the user typed in by hand — no registry, no catalog — and
 * then lets the engine's own refresh read its model list from the endpoint.
 *
 * Discovery is delegated rather than reimplemented: the provider record is
 * written first, and the refresh orchestrator fills `models` from
 * `{base_url}/models`. That keeps one implementation of the discovery rules
 * (shared with the TUI's background refresh) instead of a second copy in the
 * CLI, and means a provider added here refreshes like any other on next start.
 */
/**
 * Warns when a key does not carry the vendor's expected prefix.
 *
 * Never fatal: vendors change prefixes without notice and several hand out
 * keys with no recognizable prefix at all, so rejecting would break working
 * setups. The warning exists because the alternative failure mode is opaque —
 * an OpenAI key pasted into NaraRouter returns a 401 that reads exactly like a
 * revoked key, and the user has no signal that the wrong credential was used.
 */
function warnOnKeyPrefixMismatch(
  deps: ProviderDeps,
  providerId: string,
  apiKey: string | undefined,
  opts: AddManualOptions,
): void {
  const hint = opts.keyHint;
  if (hint === undefined || hint.length === 0 || apiKey === undefined) return;
  if (apiKey.startsWith(hint)) return;
  const who = opts.displayName ?? `provider "${providerId}"`;
  deps.stderr.write(
    `warning: this key does not start with "${hint}", which ${who} keys usually do.\n` +
      'If model discovery fails with an auth error, check that the key is for this provider.\n',
  );
}

export async function handleProviderAddManual(
  deps: ProviderDeps,
  providerId: string,
  opts: AddManualOptions,
): Promise<void> {
  const id = providerId.trim();
  if (id.length === 0) {
    deps.stderr.write('Provider id is required.\n');
    deps.exit(1);
  }
  const wire = opts.type.trim();
  if (!isManualProviderType(wire)) {
    deps.stderr.write(
      `Unsupported --type "${wire}" (expected one of: ${MANUAL_PROVIDER_TYPES.join(', ')}).\n`,
    );
    deps.exit(1);
  }
  const baseUrl = opts.baseUrl.trim();
  if (baseUrl.length === 0) {
    deps.stderr.write('--base-url is required for a manual provider.\n');
    deps.exit(1);
  }
  const baseUrlCheck = parseProviderBaseUrl(baseUrl);
  if (!baseUrlCheck.ok) {
    deps.stderr.write(`--base-url ${baseUrlCheck.reason}\n`);
    deps.exit(1);
  }
  const apiKey = resolveApiKey(opts.apiKey, deps.env);
  const apiKeyEnv = opts.apiKeyEnv?.trim();
  if (apiKey !== undefined && apiKeyEnv !== undefined) {
    deps.stderr.write('Pass either --api-key or --api-key-env, not both.\n');
    deps.exit(1);
  }
  if (apiKey === undefined && apiKeyEnv === undefined) {
    deps.stderr.write(
      'A manual provider needs a credential: pass --api-key <key> or --api-key-env <VAR>.\n',
    );
    deps.exit(1);
  }

  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const existing = await harness.getConfig();
  if (existing.providers[id] !== undefined) {
    deps.stderr.write(
      `Provider "${id}" already exists. Remove it first with \`kimi provider remove ${id}\`.\n`,
    );
    deps.exit(1);
  }

  // Replace semantics: setConfig deep-merges and cannot delete a key, so a
  // re-add over a removed provider's aliases would resurrect stale models.
  const next = removeProviderFromConfig(existing, id);
  next.providers = {
    ...next.providers,
    [id]: {
      type: wire,
      baseUrl,
      ...(apiKey !== undefined ? { apiKey } : { apiKeyEnv }),
      ...(opts.protocolOverrides !== undefined
        ? { protocolOverrides: opts.protocolOverrides }
        : undefined),
    },
  };
  await harness.setConfig({
    providers: next.providers,
    models: next.models,
    defaultModel: next.defaultModel,
    thinking: next.thinking,
  });

  warnOnKeyPrefixMismatch(deps, id, apiKey, opts);

  deps.stdout.write(`Added provider "${id}" (type=${wire}, base_url=${baseUrl}).\n`);
  deps.stdout.write('Discovering models from the endpoint…\n');

  const result = await refreshAllProviderModels(
    {
      getConfig: () => harness.getConfig({ reload: true }),
      removeProvider: (providerIdToRemove) => harness.removeProvider(providerIdToRemove),
      setConfig: (patch) => harness.setConfig(patch),
      resolveOAuthToken: async (_providerName: string, oauthRef?: OAuthRef) => {
        const tokenProvider = harness.auth.resolveOAuthTokenProvider(id, oauthRef);
        return tokenProvider.getAccessToken();
      },
      userAgent: createKimiCodeUserAgent(),
    },
    { providerId: id },
  );

  for (const failure of result.failed) {
    if (failure.provider === id) {
      deps.stderr.write(`Model discovery failed: ${failure.reason}\n`);
      deps.stderr.write(
        `The provider is saved; add model entries under [models."${id}/…"] in config.toml to use it.\n`,
      );
      deps.exit(1);
    }
  }

  const models = Object.keys((await harness.getConfig({ reload: true })).models ?? {}).filter((alias) =>
    alias.startsWith(`${id}/`),
  );
  if (models.length === 0) {
    deps.stderr.write(
      `The endpoint at ${baseUrl} listed no models. Add model entries under [models."${id}/…"] in config.toml.\n`,
    );
    deps.exit(1);
  }
  for (const alias of models) {
    deps.stdout.write(`  - ${alias}\n`);
  }
  deps.stdout.write(
    `\nSet a default with: kimi --model ${models[0]}\n` +
      `Add more under [models."${id}/…"] in config.toml, or re-run to refresh this list.\n`,
  );
}

export async function handleProviderRemove(
  deps: ProviderDeps,
  providerId: string,
): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  if (config.providers[providerId] === undefined) {
    deps.stderr.write(`Provider "${providerId}" not found.\n`);
    deps.exit(1);
  }
  await harness.removeProvider(providerId);
  deps.stdout.write(`Removed provider "${providerId}".\n`);
}

export async function handleProviderList(
  deps: ProviderDeps,
  opts: ListOptions,
): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();

  if (opts.json) {
    deps.stdout.write(
      `${JSON.stringify({ providers: config.providers, models: config.models ?? {} }, null, 2)}\n`,
    );
    return;
  }

  const modelsByProvider = new Map<string, string[]>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    const list = modelsByProvider.get(model.provider) ?? [];
    list.push(alias);
    modelsByProvider.set(model.provider, list);
  }

  const providerIds = Object.keys(config.providers).toSorted();
  if (providerIds.length === 0) {
    deps.stdout.write('No providers configured.\n');
    return;
  }

  for (const id of providerIds) {
    const provider = config.providers[id]!;
    const aliases = modelsByProvider.get(id) ?? [];
    const sourceLabel = providerSourceLabel(provider);
    deps.stdout.write(
      `${id}  type=${provider.type}  models=${String(aliases.length)}  source=${sourceLabel}\n`,
    );
  }
  if (config.defaultModel !== undefined) {
    deps.stdout.write(`\nDefault model: ${config.defaultModel}\n`);
  }
}

/** Ordered stage names for {@link handleProviderTest}. */
const PROVIDER_TEST_STAGES = [
  'config',
  'credential',
  'connectivity',
  'models',
  'request',
] as const;

const DEFAULT_PROVIDER_TEST_TIMEOUT_MS = 10_000;

/** The API-version pin every Anthropic request carries, `/models` included. */
const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Per-wire endpoint conventions, keyed by the provider's `type` (the wire) and
 * never by its config id — a hand-written provider can be named anything, so
 * only the wire decides how its endpoints authenticate and where its version
 * segment sits. Mirrors the table the model-refresh orchestrator uses; kept
 * local because that package does not export the lookup.
 */
const PROVIDER_TEST_WIRE_PROFILE: Readonly<
  Record<string, { readonly authStyle: DiscoveryAuthStyle; readonly versionSegment?: string }>
> = {
  anthropic: { authStyle: 'x-api-key', versionSegment: 'v1' },
  'google-genai': { authStyle: 'x-goog-api-key' },
};

/** Syscall codes worth naming: each one is a different thing to go fix. */
const UNREACHABLE_REASONS: Readonly<Record<string, string>> = {
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'host lookup failed',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ETIMEDOUT: 'connection timed out',
  EPROTO: 'TLS handshake failed',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate not trusted',
  CERT_HAS_EXPIRED: 'TLS certificate expired',
};

type ProviderTestStageStatus = 'OK' | 'FAIL' | 'SKIP';

interface ProviderTestStageResult {
  readonly status: ProviderTestStageStatus;
  readonly detail: string;
}

/**
 * A stage failure carrying the short reason the CLI prints instead of a stack
 * trace. The vocabulary is deliberately closed — `unauthorized`, `forbidden`,
 * `not found`, `timeout`, `rate limited`, `malformed response`, `unreachable`,
 * `server error`, `unexpected status`, `request failed` — so two runs of the
 * same command stay comparable.
 */
class ProviderTestFailure extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderTestFailure';
  }
}

export interface ProviderTestOptions {
  /** Alias to probe with. Defaults to the provider's first configured alias. */
  readonly model?: string;
  /** Per-request network budget in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * `kimi provider test` — a read-only, five-stage diagnostic for one configured
 * provider: the record resolves, the credential resolves, the endpoint answers,
 * the model list can be discovered, and a minimal completion goes through.
 *
 * Ordered deliberately: each stage can only fail for reasons the earlier ones
 * have already ruled out, so a failure names the layer that broke instead of
 * the first thing that happened to go wrong. Every stage runs even after an
 * earlier failure — "unauthorized" and "unreachable" need different fixes, and
 * stopping at the first failure hides the second one — while a stage that
 * cannot run at all reports `SKIP` with the reason, so the summary always
 * accounts for all five.
 *
 * Nothing here writes. This is the counterpart of `add` / `edit` / the model
 * refresh, so it is safe to point at a working config while debugging it.
 * The resolved credential is only ever attached to a request header: it is
 * never printed, logged or echoed, and every string that reaches the terminal
 * passes through {@link redactCredential} first, because a server that rejects
 * a bad key is allowed to quote it back inside the error body.
 */
export async function handleProviderTest(
  deps: ProviderDeps,
  providerId: string,
  opts: ProviderTestOptions,
): Promise<void> {
  const id = providerId.trim();
  if (id.length === 0) {
    deps.stderr.write('Provider id is required.\n');
    deps.exit(1);
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROVIDER_TEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    deps.stderr.write(`--timeout must be a positive number of milliseconds.\n`);
    deps.exit(1);
  }

  const results: ProviderTestStageResult[] = [];
  const report = (index: number, result: ProviderTestStageResult): void => {
    results[index] = result;
    const line = formatProviderTestStage(index, result);
    if (result.status === 'FAIL') deps.stderr.write(line);
    else deps.stdout.write(line);
  };

  deps.stdout.write(`Provider test: ${id}\n`);

  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  const provider = config.providers[id];

  if (provider === undefined) {
    const known = Object.keys(config.providers).toSorted();
    report(0, {
      status: 'FAIL',
      detail:
        known.length > 0
          ? `not configured — configured providers: ${known.join(', ')}`
          : 'not configured — no providers are configured',
    });
    for (let index = 1; index < PROVIDER_TEST_STAGES.length; index++) {
      report(index, { status: 'SKIP', detail: 'no provider record to test' });
    }
    finishProviderTest(deps, results);
    return;
  }

  const baseUrl = provider.baseUrl?.trim();
  report(0, {
    status: 'OK',
    detail:
      `configured (type=${provider.type}` +
      `${baseUrl === undefined || baseUrl.length === 0 ? '' : `, base_url=${baseUrl}`})`,
  });

  const credential = await resolveTestCredential(deps, harness, id, provider);
  report(1, {
    status: credential.present ? 'OK' : 'FAIL',
    detail: credential.detail,
  });
  const secret = credential.present ? credential.secret : undefined;

  // Stages 3-5 all need somewhere to send a request. A record without a
  // `base_url` uses the vendor default resolved at request time, which the CLI
  // cannot probe honestly, so it is reported rather than guessed at.
  const base =
    baseUrl === undefined || baseUrl.length === 0
      ? undefined
      : parseProviderBaseUrl(baseUrl).ok
        ? normalizeDiscoveryBaseUrl(baseUrl)
        : undefined;
  const noBase: ProviderTestStageResult = {
    status: 'SKIP',
    detail:
      baseUrl === undefined || baseUrl.length === 0
        ? 'no base_url configured'
        : `base_url "${baseUrl}" is not a usable http(s) URL`,
  };

  if (base === undefined) {
    report(2, noBase);
    report(3, noBase);
    report(4, noBase);
    finishProviderTest(deps, results);
    return;
  }

  report(2, await testEndpointReachability(base, timeoutMs));
  const discovery = await testModelDiscovery(base, provider.type, secret, timeoutMs);
  report(3, discovery.result);
  report(4, await testMinimalRequest(base, provider, secret, pickProbeModel(config, id, opts.model), timeoutMs));

  finishProviderTest(deps, results);
}

function formatProviderTestStage(index: number, result: ProviderTestStageResult): string {
  const stage = PROVIDER_TEST_STAGES[index] ?? '';
  const total = PROVIDER_TEST_STAGES.length;
  return `[${String(index + 1)}/${String(total)}] ${stage.padEnd(13)}${result.status.padEnd(5)}  ${result.detail}\n`;
}

function finishProviderTest(deps: ProviderDeps, results: ProviderTestStageResult[]): void {
  const failed = results.filter((result) => result.status === 'FAIL').length;
  const skipped = results.filter((result) => result.status === 'SKIP').length;
  const passed = results.length - failed - skipped;
  const summary = `${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped`;
  if (failed === 0) {
    deps.stdout.write(`${skipped === 0 ? 'All stages passed' : 'No stage failed'} (${summary}).\n`);
    return;
  }
  deps.stderr.write(`Provider test failed (${summary}).\n`);
  deps.exit(1);
}

type TestCredential =
  | { readonly present: true; readonly detail: string; readonly secret: string | undefined }
  | { readonly present: false; readonly detail: string };

/**
 * Resolves what the provider would actually send, without ever putting it on a
 * terminal. The declared-vs-resolved distinction is the whole point of the
 * stage: an `api_key_env` naming a variable nobody exported looks configured
 * and fails only at the first real request.
 */
async function resolveTestCredential(
  deps: ProviderDeps,
  harness: KimiHarness,
  providerId: string,
  provider: KimiConfig['providers'][string],
): Promise<TestCredential> {
  const declared = declaredProviderCredential(provider, providerId);
  switch (declared.kind) {
    case 'conflict':
      return { present: false, detail: `MISSING (${declared.message})` };
    case 'inline':
      return { present: true, detail: 'PRESENT (api_key from config.toml)', secret: declared.apiKey };
    case 'env': {
      const fromEnv = deps.env[declared.apiKeyEnv];
      const value = typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
      return value === undefined
        ? {
            present: false,
            detail: `MISSING (api_key_env "${declared.apiKeyEnv}" is not set or is empty)`,
          }
        : { present: true, detail: `PRESENT (api_key_env "${declared.apiKeyEnv}")`, secret: value };
    }
    case 'none':
      break;
  }

  if (provider.oauth !== undefined) {
    try {
      const token = await harness.auth
        .resolveOAuthTokenProvider(providerId, provider.oauth)
        .getAccessToken();
      return typeof token === 'string' && token.length > 0
        ? { present: true, detail: `PRESENT (oauth token "${provider.oauth.key}")`, secret: token }
        : {
            present: false,
            detail: `MISSING (oauth token "${provider.oauth.key}" is empty — run \`kimi login\`)`,
          };
    } catch (error) {
      return {
        present: false,
        detail: `MISSING (oauth token "${provider.oauth.key}" unavailable: ${errorMessage(error)})`,
      };
    }
  }

  // `auth_scheme = "none"` is how a local gateway says it wants no credential
  // at all, so a record without one is not broken.
  if (provider.authScheme?.kind === 'none') {
    return { present: true, detail: 'PRESENT (auth_scheme = "none", no credential sent)', secret: undefined };
  }

  return {
    present: false,
    detail: 'MISSING (no api_key, api_key_env or oauth in config.toml)',
  };
}

/**
 * Stage 3. Any HTTP answer at all proves the host resolved, connected and
 * completed TLS, which is the question this stage asks; the status is reported
 * as-is because a `404` on an OpenAI-style `/v1` base is the healthy answer and
 * calling it a failure would train users to ignore the stage.
 */
async function testEndpointReachability(base: string, timeoutMs: number): Promise<ProviderTestStageResult> {
  try {
    const response = await fetchWithTimeout(base, { method: 'GET', headers: { Accept: '*/*' } }, timeoutMs);
    return { status: 'OK', detail: `endpoint answered (HTTP ${String(response.status)})` };
  } catch (error) {
    return { status: 'FAIL', detail: describeTestFailure(error) };
  }
}

/**
 * Stage 4. Delegates to the same `fetchDiscoveredModels` the refresh path uses
 * so the probe cannot drift from the code that actually populates `models`.
 * The `fetchImpl` shim exists to keep the raw `Response` — the thrown error is
 * only a message, and classifying a `429` from message text would be a guess.
 */
async function testModelDiscovery(
  base: string,
  wire: string,
  secret: string | undefined,
  timeoutMs: number,
): Promise<{ readonly result: ProviderTestStageResult }> {
  const profile = PROVIDER_TEST_WIRE_PROFILE[wire];
  let probed: { readonly url: string; readonly response: Response } | undefined;
  try {
    const models = await fetchDiscoveredModels({
      baseUrl: base,
      apiKey: secret,
      userAgent: createKimiCodeUserAgent(),
      authStyle: profile?.authStyle ?? 'bearer',
      versionSegment: profile?.versionSegment,
      fetchImpl: async (url, init) => {
        const response = await fetchWithTimeout(url, init, timeoutMs);
        probed = { url: requestUrl(url), response };
        return response;
      },
    });
    return {
      result: {
        status: 'OK',
        detail: `${String(models.length)} model${models.length === 1 ? '' : 's'} listed${
          models.length === 0 ? ' — the endpoint advertises nothing to request' : ''
        }`,
      },
    };
  } catch (error) {
    return { result: { status: 'FAIL', detail: describeTestFailure(error, probed, secret) } };
  }
}

/**
 * Stage 5. The smallest request each wire accepts, against the first alias the
 * user configured for this provider — a diagnostic must not invent a model id,
 * because a request for a model the account cannot reach fails identically to
 * a broken endpoint and sends the user hunting in the wrong place.
 */
async function testMinimalRequest(
  base: string,
  provider: KimiConfig['providers'][string],
  secret: string | undefined,
  model: ProbeModel,
  timeoutMs: number,
): Promise<ProviderTestStageResult> {
  if (!model.ok) {
    return {
      status: 'SKIP',
      detail: model.reason,
    };
  }
  const request = buildProbeRequest(base, provider, secret, model.modelId);
  if (!request.ok) {
    return { status: 'SKIP', detail: request.reason };
  }

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchWithTimeout(
      request.url,
      { method: 'POST', headers: request.headers, body: request.body },
      timeoutMs,
    );
  } catch (error) {
    return { status: 'FAIL', detail: describeTestFailure(error) };
  }
  const elapsed = Date.now() - startedAt;

  if (!response.ok) {
    const detail = await describeHttpFailure(response, request.url, secret);
    return { status: 'FAIL', detail };
  }

  // A gateway that answers 200 with an HTML error page or an empty body has not
  // served the request, and reporting that as success would be the one lie this
  // command must never tell.
  if (!(await hasJsonBody(response))) {
    return {
      status: 'FAIL',
      detail: `malformed response — ${request.url} answered HTTP ${String(response.status)} with a body that is not JSON`,
    };
  }
  return {
    status: 'OK',
    detail: `minimal request succeeded via alias "${model.alias}" (model ${model.modelId}, ${String(elapsed)} ms)`,
  };
}

type ProbeModel = { readonly ok: true; readonly alias: string; readonly modelId: string } | { readonly ok: false; readonly reason: string };

function pickProbeModel(config: KimiConfig, providerId: string, requested: string | undefined): ProbeModel {
  const models = config.models ?? {};
  if (requested !== undefined) {
    const alias = models[requested];
    if (alias === undefined) return { ok: false, reason: `unknown model alias "${requested}"` };
    if (alias.provider !== providerId) {
      return {
        ok: false,
        reason: `model alias "${requested}" belongs to provider "${alias.provider}"`,
      };
    }
    return { ok: true, alias: requested, modelId: alias.model };
  }
  const first = Object.entries(models).find(([, model]) => model.provider === providerId);
  if (first === undefined) {
    return {
      ok: false,
      reason: `no model alias configured for provider "${providerId}" — add one or pass --model`,
    };
  }
  return { ok: true, alias: first[0], modelId: first[1].model };
}

function buildProbeRequest(
  base: string,
  provider: KimiConfig['providers'][string],
  secret: string | undefined,
  modelId: string,
): { readonly ok: true; readonly url: string; readonly headers: Record<string, string>; readonly body: string } | { readonly ok: false; readonly reason: string } {
  const headers = buildProbeHeaders(provider, secret);
  switch (provider.type) {
    case 'openai':
    case 'kimi':
      return {
        ok: true,
        url: `${base}/chat/completions`,
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
      };
    case 'openai_responses':
      return {
        ok: true,
        url: `${base}/responses`,
        headers,
        body: JSON.stringify({ model: modelId, input: 'ping', max_output_tokens: 16, stream: false }),
      };
    case 'anthropic':
      return {
        ok: true,
        url: `${withVersionSegment(base, 'v1')}/messages`,
        headers,
        body: JSON.stringify({
          model: modelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
        }),
      };
    case 'google-genai':
      return {
        ok: true,
        url: `${base}/models/${encodeURIComponent(modelId)}:generateContent`,
        headers,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      };
    default:
    case 'vertexai':
      return {
        ok: false,
        reason: `unsupported API — this client cannot send a probe over the "${provider.type}" wire`,
      };
  }
}

function buildProbeHeaders(
  provider: KimiConfig['providers'][string],
  secret: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': createKimiCodeUserAgent(),
    ...provider.customHeaders,
  };
  if (secret === undefined || secret.length === 0) return headers;
  const scheme = provider.authScheme;
  if (scheme?.kind === 'none') return headers;
  if (scheme?.kind === 'custom-header' && scheme.header !== undefined) {
    headers[scheme.header] = secret;
    return headers;
  }
  const profile = PROVIDER_TEST_WIRE_PROFILE[provider.type];
  switch (profile?.authStyle) {
    case 'x-api-key':
      headers['x-api-key'] = secret;
      headers['anthropic-version'] = ANTHROPIC_API_VERSION;
      break;
    case 'x-goog-api-key':
      headers['x-goog-api-key'] = secret;
      break;
    default:
      headers['Authorization'] = `Bearer ${secret}`;
      break;
  }
  return headers;
}

/** Inserts a vendor version segment unless the configured base already carries it. */
function withVersionSegment(base: string, segment: string): string {
  return base.endsWith(`/${segment}`) ? base : `${base}/${segment}`;
}

/** Resolves the provider record or ends the command naming what is configured. */
function requireProvider(
  deps: ProviderDeps,
  config: KimiConfig,
  id: string,
): KimiConfig['providers'][string] {
  const provider = config.providers[id];
  if (provider !== undefined) return provider;
  const known = Object.keys(config.providers).toSorted();
  deps.stderr.write(
    `Provider "${id}" not found.` +
      (known.length > 0 ? `\nConfigured providers:\n${known.map((p) => `  - ${p}\n`).join('')}` : ''),
  );
  deps.exit(1);
}

/**
 * The refresh host, assembled once so the CLI's two writing paths — an edit
 * that re-reads the model list and an explicit `provider models --refresh` —
 * cannot drift apart in how they resolve credentials or user agent.
 */
function providerRefreshHost(harness: KimiHarness, providerId: string): RefreshProviderHost {
  return {
    getConfig: () => harness.getConfig({ reload: true }),
    removeProvider: (target: string) => harness.removeProvider(target),
    setConfig: (next) => harness.setConfig(next),
    resolveOAuthToken: async (_providerName: string, oauthRef?: OAuthRef) =>
      harness.auth.resolveOAuthTokenProvider(providerId, oauthRef).getAccessToken(),
    userAgent: createKimiCodeUserAgent(),
  };
}

export interface ProviderModelsOptions {
  readonly json: boolean;
  /** Re-read the model list from the endpoint and persist it before listing. */
  readonly refresh: boolean;
  /** Report what the endpoint advertises, without writing anything. */
  readonly available: boolean;
}

interface ProviderModelRow {
  readonly alias: string;
  readonly model: string;
  readonly maxContextSize: number;
  readonly protocol?: string;
  readonly displayName?: string;
}

/**
 * `kimi provider models` — which models one installed provider can serve, from
 * three angles: the aliases config holds right now (the default), what the
 * endpoint advertises (`--available`), and bringing the two back into sync
 * (`--refresh`).
 *
 * `--available` stays read-only on purpose: someone checking why a model is
 * missing should not have to mutate their config to find out, and a probe that
 * writes would race the periodic refresh the daemon already runs. It reuses
 * `provider test`'s credential resolution and failure vocabulary, so one broken
 * key is reported the same way by both commands.
 *
 * `--refresh` is the only writing mode, and it delegates to the same
 * orchestrator the TUI and the daemon's scheduled refresh use.
 */
export async function handleProviderModels(
  deps: ProviderDeps,
  providerId: string,
  opts: ProviderModelsOptions,
): Promise<void> {
  const id = providerId.trim();
  if (id.length === 0) {
    deps.stderr.write('Provider id is required.\n');
    deps.exit(1);
  }

  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  let config = await harness.getConfig();
  requireProvider(deps, config, id);

  if (opts.refresh) {
    const result = await refreshAllProviderModels(providerRefreshHost(harness, id), { providerId: id });
    const failure = result.failed.find((entry) => entry.provider === id);
    if (failure !== undefined) {
      deps.stderr.write(`Model refresh failed: ${failure.reason}\n`);
      deps.stderr.write('Existing models are left untouched.\n');
      deps.exit(1);
    }
    const change = result.changed.find((entry) => entry.providerId === id);
    deps.stdout.write(
      change === undefined
        ? 'Model list unchanged.\n'
        : `Models refreshed: +${String(change.added)} added, ${String(change.removed)} removed.\n`,
    );
    config = await harness.getConfig({ reload: true });
  }

  const provider = requireProvider(deps, config, id);
  const rows = Object.entries(config.models ?? {})
    .filter(([, entry]) => entry.provider === id)
    .map(([alias, entry]): ProviderModelRow => ({
      alias,
      model: entry.model,
      maxContextSize: entry.maxContextSize,
      protocol: entry.protocol,
      displayName: entry.displayName,
    }))
    .toSorted((a, b) => a.alias.localeCompare(b.alias));

  const advertised = opts.available
    ? await fetchAdvertisedModels(deps, harness, id, provider)
    : undefined;

  if (opts.json) {
    deps.stdout.write(
      `${JSON.stringify(
        {
          provider: id,
          type: provider.type,
          baseUrl: provider.baseUrl,
          defaultModel: config.defaultModel,
          models: rows,
          available: advertised,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const baseUrl = provider.baseUrl?.trim();
  deps.stdout.write(
    `${id}  type=${provider.type}${baseUrl === undefined || baseUrl.length === 0 ? '' : `  base_url=${baseUrl}`}\n`,
  );
  if (rows.length === 0) {
    deps.stdout.write(
      `  No models configured. Run \`kimi provider models ${id} --refresh\` to read them from the endpoint.\n`,
    );
  }
  for (const row of rows) {
    deps.stdout.write(
      `  ${row.alias}  model=${row.model}  ctx=${String(row.maxContextSize)}` +
        (row.protocol === undefined ? '' : `  protocol=${row.protocol}`) +
        (row.displayName === undefined ? '' : `  name=${row.displayName}`) +
        (config.defaultModel === row.alias ? '  (default)' : '') +
        '\n',
    );
  }
  if (config.defaultModel !== undefined && !rows.some((row) => row.alias === config.defaultModel)) {
    deps.stdout.write(`\nDefault model: ${config.defaultModel} (belongs to another provider)\n`);
  }

  if (advertised !== undefined) {
    deps.stdout.write(
      advertised.length === 0
        ? `\nEndpoint advertises no models.\n`
        : `\nEndpoint advertises ${String(advertised.length)} model${advertised.length === 1 ? '' : 's'}:\n`,
    );
    for (const model of advertised) {
      deps.stdout.write(
        `  ${model.id}` +
          (model.maxContextSize === undefined ? '' : `  ctx=${String(model.maxContextSize)}`) +
          (model.protocol === undefined ? '' : `  protocol=${model.protocol}`) +
          (model.capabilities === undefined || model.capabilities.length === 0
            ? ''
            : `  [${model.capabilities.join(',')}]`) +
          '\n',
      );
    }
  }
}

/**
 * Reads the endpoint's own model list without persisting it. Every failure ends
 * the command through the same classification `provider test` prints, because
 * a user comparing the two commands should never have to learn two vocabularies.
 */
async function fetchAdvertisedModels(
  deps: ProviderDeps,
  harness: KimiHarness,
  providerId: string,
  provider: KimiConfig['providers'][string],
): Promise<DiscoveredModelInfo[]> {
  const baseUrl = provider.baseUrl?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    deps.stderr.write('No base_url configured — set one with `kimi provider edit --base-url`.\n');
    deps.exit(1);
  }
  const check = parseProviderBaseUrl(baseUrl);
  if (!check.ok) {
    deps.stderr.write(`base_url ${check.reason}\n`);
    deps.exit(1);
  }
  const credential = await resolveTestCredential(deps, harness, providerId, provider);
  if (!credential.present) {
    deps.stderr.write(`Cannot read models from the endpoint: ${credential.detail}\n`);
    deps.exit(1);
  }

  const profile = PROVIDER_TEST_WIRE_PROFILE[provider.type];
  let probed: { readonly url: string; readonly response: Response } | undefined;
  try {
    return await fetchDiscoveredModels({
      baseUrl: normalizeDiscoveryBaseUrl(baseUrl),
      apiKey: credential.secret,
      userAgent: createKimiCodeUserAgent(),
      authStyle: profile?.authStyle ?? 'bearer',
      versionSegment: profile?.versionSegment,
      fetchImpl: async (url, init) => {
        const response = await fetchWithTimeout(url, init, DEFAULT_PROVIDER_TEST_TIMEOUT_MS);
        probed = { url: requestUrl(url), response };
        return response;
      },
    });
  } catch (error) {
    deps.stderr.write(`Could not read models: ${describeTestFailure(error, probed, credential.secret)}\n`);
    deps.exit(1);
  }
}

/** `fetch` accepts three input shapes; every diagnostic in this file wants the URL as text. */
export function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

async function fetchWithTimeout(
  url: string | URL | Request,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw classifyTestError(error, controller.signal, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

function classifyTestError(error: unknown, signal: AbortSignal, timeoutMs: number): ProviderTestFailure {
  if (signal.aborted) {
    return new ProviderTestFailure('timeout', `no response within ${String(timeoutMs)} ms`);
  }
  const coded = errorChain(error).find((entry) => errorCode(entry) !== undefined);
  if (coded !== undefined) {
    const code = errorCode(coded) ?? '';
    return new ProviderTestFailure('unreachable', `${UNREACHABLE_REASONS[code] ?? 'host unreachable'} (${code})`);
  }
  if (error instanceof ProviderTestFailure) return error;
  return new ProviderTestFailure('request failed', describeChain(error));
}

/**
 * Unwraps a throwable outward-first. `fetch` rejects with a bare `TypeError:
 * fetch failed` and hides the socket error one `cause` deeper, so the code and
 * the useful message only exist further down the chain.
 */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (typeof current === 'object' && current !== null && chain.length < 5) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Picks the first message in the chain that says something `fetch failed` does
 * not, so a dropped connection does not reach the terminal as `fetch failed`.
 */
function describeChain(error: unknown): string {
  const message = errorChain(error)
    .map(errorMessage)
    .find((candidate) => candidate.length > 0 && candidate !== 'fetch failed');
  return message ?? errorMessage(error);
}

function describeTestFailure(
  error: unknown,
  probed?: { readonly url: string; readonly response: Response },
  secret?: string,
): string {
  if (probed !== undefined && !probed.response.ok) {
    return `${httpReason(probed.response.status)} (HTTP ${String(probed.response.status)} at ${probed.url})`;
  }
  const failure =
    error instanceof ProviderTestFailure
      ? error
      : error instanceof DiscoveredModelsAuthError
        ? new ProviderTestFailure(httpReason(error.status), error.message)
        : new ProviderTestFailure(reasonFromMessage(errorMessage(error)), describeChain(error));
  const at = probed === undefined ? '' : ` at ${probed.url}`;
  return `${failure.reason}${at}: ${redactCredential(truncate(failure.message, 200), secret)}`;
}

/**
 * Turns a non-2xx answer into one short word. `fetchDiscoveredModels` only
 * exposes the status for auth failures, so the other codes arrive as prose and
 * are matched by the one phrase the package guarantees.
 */
function httpReason(status: number): string {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not found';
    case 408:
      return 'timeout';
    case 429:
      return 'rate limited';
    default:
      return status >= 500 ? 'server error' : 'unexpected status';
  }
}

function reasonFromMessage(message: string): string {
  if (message.includes('Unexpected models response')) return 'malformed response';
  for (const [status, reason] of [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not found'],
    [429, 'rate limited'],
  ] as const) {
    if (message.includes(`HTTP ${String(status)}`)) return reason;
  }
  return 'request failed';
}

async function describeHttpFailure(response: Response, url: string, secret: string | undefined): Promise<string> {
  const reason = `${httpReason(response.status)} (HTTP ${String(response.status)} at ${url})`;
  const body = redactCredential(truncate(singleLine(await readBodyText(response)), 200), secret);
  return body.length === 0 ? reason : `${reason}: ${body}`;
}

async function hasJsonBody(response: Response): Promise<boolean> {
  try {
    JSON.parse(await readBodyText(response)) as unknown;
    return true;
  } catch {
    return false;
  }
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Removes the credential from anything bound for the terminal. A server that
 * rejects a key is free to quote it back in its error body, and a CLI that
 * pastes that into a terminal emulator or a scrollback buffer has leaked it
 * into exactly the place the user pasted it from.
 */
function redactCredential(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text;
  return text.split(secret).join('[redacted]');
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Fetches the models.dev-style public catalog and lists providers, or — when
 * `providerId` is given — drills into one provider and lists its models. This
 * mirrors the discovery half of the TUI "Known third-party provider" flow.
 */
export async function handleCatalogList(
  deps: ProviderDeps,
  providerId: string | undefined,
  opts: CatalogListOptions,
): Promise<void> {
  const url = opts.url ?? DEFAULT_CATALOG_URL;
  const catalog = await loadCatalogOrExit(deps, url);

  if (providerId !== undefined) {
    const entry = catalog[providerId];
    if (entry === undefined) {
      deps.stderr.write(`Provider "${providerId}" not found in catalog at ${url}.\n`);
      deps.exit(1);
    }
    const models = catalogProviderModels(entry);
    if (opts.json) {
      deps.stdout.write(
        `${JSON.stringify({ providerId, name: entry.name ?? providerId, models }, null, 2)}\n`,
      );
      return;
    }
    if (models.length === 0) {
      deps.stdout.write(`Provider "${providerId}" lists no usable models in this catalog.\n`);
      return;
    }
    deps.stdout.write(`${entry.name ?? providerId} (${providerId})\n`);
    for (const model of models) {
      const cap: string[] = [];
      if (model.capability.tool_use) cap.push('tool_use');
      if (model.capability.thinking) cap.push('thinking');
      if (model.capability.image_in) cap.push('image_in');
      const ctx =
        typeof model.capability.max_context_tokens === 'number'
          ? String(model.capability.max_context_tokens)
          : '?';
      const capLabel = cap.length > 0 ? ` [${cap.join(',')}]` : '';
      deps.stdout.write(`  ${model.id}  ctx=${ctx}${capLabel}\n`);
    }
    return;
  }

  const filter = opts.filter?.toLowerCase();
  const entries = Object.entries(catalog)
    .filter(([id, entry]) => {
      if (filter === undefined) return true;
      const haystack = `${id} ${entry.name ?? ''}`.toLowerCase();
      return haystack.includes(filter);
    })
    .toSorted(([a], [b]) => a.localeCompare(b));

  if (opts.json) {
    const out: Record<string, CatalogProviderEntry> = {};
    for (const [id, entry] of entries) out[id] = entry;
    deps.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  if (entries.length === 0) {
    if (filter !== undefined) {
      deps.stdout.write(`No providers in catalog match "${filter}".\n`);
    } else {
      deps.stdout.write('Catalog is empty.\n');
    }
    return;
  }

  for (const [id, entry] of entries) {
    const modelCount = entry.models === undefined ? 0 : Object.keys(entry.models).length;
    const resolution = resolveCatalogImport(entry);
    const wireLabel =
      resolution.kind === 'invalid'
        ? '?'
        : resolution.guessed
          ? `${resolution.wire} (guessed)`
          : resolution.wire;
    deps.stdout.write(
      `${id}  wire=${wireLabel}  models=${String(modelCount)}  ${entry.name ?? ''}\n`,
    );
  }
}

/**
 * Imports a known provider from the models.dev catalog by id. Unlike
 * `provider add` (which expects a custom api.json), this command relies on
 * the catalog's normalized metadata to fill in context limits and capabilities.
 */
export async function handleCatalogAdd(
  deps: ProviderDeps,
  providerId: string,
  opts: CatalogAddOptions,
): Promise<void> {
  const apiKey = resolveApiKey(opts.apiKey, deps.env);
  if (apiKey === undefined) {
    deps.stderr.write(
      'Missing API key. Pass --api-key <key> or set KIMI_REGISTRY_API_KEY.\n',
    );
    deps.exit(1);
  }

  const url = opts.url ?? DEFAULT_CATALOG_URL;
  const catalog = await loadCatalogOrExit(deps, url);

  const entry = catalog[providerId];
  if (entry === undefined) {
    deps.stderr.write(`Provider "${providerId}" not found in catalog at ${url}.\n`);
    deps.exit(1);
  }

  const resolution = resolveCatalogImport(entry, opts.baseUrl);
  if (resolution.kind === 'invalid') {
    switch (resolution.reason) {
      case 'unknown-explicit-type':
        deps.stderr.write(
          `Provider "${providerId}" declares protocol "${entry.type}" in the catalog, which this client version does not support.\n`,
        );
        break;
      case 'proprietary-sdk':
        deps.stderr.write(
          `Provider "${providerId}" uses a proprietary SDK this client cannot speak (e.g. Amazon Bedrock or Cohere); it cannot be imported from the catalog.\n`,
        );
        break;
      case 'empty-base-url':
        deps.stderr.write('--base-url cannot be empty.\n');
        break;
      case 'placeholder-base-url':
        deps.stderr.write(
          `Base URL "${opts.baseUrl}" contains an env placeholder. Pass --base-url with the resolved value.\n`,
        );
        break;
    }
    deps.exit(1);
  }
  if (resolution.kind === 'needs-base-url') {
    deps.stderr.write(
      `The catalog does not declare an endpoint for "${providerId}". Pass --base-url <url> (e.g. the vendor's OpenAI-compatible base URL).\n`,
    );
    deps.exit(1);
  }
  const { wire, baseUrl } = resolution;

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    deps.stderr.write(`Provider "${providerId}" lists no usable models in this catalog.\n`);
    deps.exit(1);
  }

  if (opts.defaultModel !== undefined && !models.some((m) => m.id === opts.defaultModel)) {
    deps.stderr.write(
      `Model "${opts.defaultModel}" is not in provider "${providerId}". Run "kimi provider catalog list ${providerId}" to see available ids.\n`,
    );
    deps.exit(1);
  }

  const harness = deps.getHarness();
  await harness.ensureConfigFile();

  let config = await harness.getConfig();

  // Capture defaults BEFORE `removeProvider`, because that call clears
  // `defaultModel` when it points at one of this provider's aliases (see
  // `core-impl.ts removeKimiProvider`). Without this, re-importing an
  // already-configured provider would lose the user's previously-set default
  // even when `--default-model` is not supplied.
  const previousDefaultModel = config.defaultModel;
  const previousThinking = config.thinking;

  if (config.providers[providerId] !== undefined) {
    config = await harness.removeProvider(providerId);
  }

  // `applyCatalogProvider` always overwrites both `defaultModel` and
  // `[thinking]`. The values we pass here are temporary; we restore
  // a consistent state in the post-apply block below.
  applyCatalogProvider(config, {
    providerId,
    wire,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    apiKey,
    models,
    selectedModelId: opts.defaultModel ?? '',
    thinking: false,
  });

  // Resolve the final `defaultModel`:
  //   - If the caller asked for one, `applyCatalogProvider` already set it.
  //   - Else, restore the previous default ONLY when its alias still resolves
  //     after the catalog refresh; the catalog may have dropped the old
  //     model, in which case restoring would point default_model at a
  //     non-existent alias and break the next session.
  if (opts.defaultModel === undefined) {
    const stillResolves =
      previousDefaultModel !== undefined &&
      config.models?.[previousDefaultModel] !== undefined;
    config.defaultModel = stillResolves ? previousDefaultModel : undefined;
  }

  // Always restore `[thinking]` from what was there before — including
  // `undefined`. Persisting `enabled: false` when the user never set it would
  // make `resolveThinkingEffort` (agent-core-v2/src/kosong/model/thinking.ts) treat
  // it as an explicit "off" request and silently disable thinking, even for
  // thinking-capable models.
  config.thinking = previousThinking;

  await harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    thinking: config.thinking,
  });

  const displayName = entry.name ?? providerId;
  deps.stdout.write(
    `Imported ${displayName} (${providerId}) with ${String(models.length)} model${models.length === 1 ? '' : 's'} from ${url}.\n`,
  );
  if (resolution.guessed) {
    deps.stdout.write(
      `Note: the catalog does not declare a protocol for "${providerId}"; guessed "openai". Edit "type" in config.toml if requests fail.\n`,
    );
  }
  if (opts.defaultModel !== undefined) {
    deps.stdout.write(`Default model set to ${providerId}/${opts.defaultModel}.\n`);
  }
}

async function loadCatalogOrExit(deps: ProviderDeps, url: string): Promise<Catalog> {
  try {
    const loaded = await fetchCatalogOrBuiltIn(url, { userAgent: createKimiCodeUserAgent() });
    if (loaded.fromBuiltIn) {
      deps.stderr.write(
        `Warning: failed to reach ${url}; using the built-in models.dev catalog snapshot.\n`,
      );
    }
    return loaded.catalog;
  } catch (error) {
    const suffix = error instanceof CatalogFetchError ? ` (HTTP ${String(error.status)})` : '';
    deps.stderr.write(`Failed to fetch catalog from ${url}${suffix}: ${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export function registerProviderCommand(parent: Command, deps?: Partial<ProviderDeps>): void {
  const provider = parent
    .command('provider')
    .description('Manage LLM providers non-interactively.');

  // Last-resort boundary: handlers report expected failures themselves, but
  // anything that escapes (e.g. a config write rejected because config.toml
  // is invalid) must end as a one-line error + exit 1, not an unhandled
  // rejection dumping a stack trace.
  const runAction = async (
    resolved: ResolvedProviderDeps,
    run: () => Promise<void>,
  ): Promise<void> => {
    try {
      await run();
    } catch (error) {
      resolved.stderr.write(`${errorMessage(error)}\n`);
      resolved.exit(1);
    } finally {
      await resolved.close();
    }
  };

  provider
    .command('add <url>')
    .description('Import every provider listed in a custom registry (api.json).')
    .option(
      '--api-key <key>',
      'Registry API key. Falls back to KIMI_REGISTRY_API_KEY; omit both for public registries.',
    )
    .action(async (url: string, options: { apiKey?: string }) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleProviderAdd(resolved, url, { apiKey: options.apiKey }));
    });

  provider
    .command('add-manual <providerId>')
    .description(
      'Add a provider by hand (protocol + endpoint + key) and discover its models from the endpoint.',
    )
    .requiredOption('--type <type>', `Wire protocol: ${MANUAL_PROVIDER_TYPES.join(', ')}.`)
    .requiredOption('--base-url <url>', 'OpenAI-compatible base URL, e.g. https://host/v1.')
    .option('--api-key <key>', 'API key. Falls back to KIMI_REGISTRY_API_KEY; omit when using --api-key-env.')
    .option('--api-key-env <VAR>', 'Read the API key from this environment variable instead of storing it.')
    .action(
      async (
        providerId: string,
        options: { type: string; baseUrl: string; apiKey?: string; apiKeyEnv?: string },
      ) => {
        const resolved = resolveDeps(deps);
        await runAction(resolved, () =>
          handleProviderAddManual(resolved, providerId, {
            type: options.type,
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            apiKeyEnv: options.apiKeyEnv,
          }),
        );
      },
    );

  provider
    .command('add-builtin <providerId>')
    .description(
      `Configure a built-in provider (${BUILT_IN_PROVIDERS.map((p) => p.id).join(', ')}).`,
    )
    .option('--api-key <key>', 'API key. Falls back to KIMI_REGISTRY_API_KEY; omit when using --api-key-env.')
    .option('--api-key-env <VAR>', 'Read the API key from this environment variable instead of storing it.')
    .action(async (providerId: string, options: { apiKey?: string; apiKeyEnv?: string }) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () =>
        handleProviderAddBuiltin(resolved, providerId, {
          apiKey: options.apiKey,
          apiKeyEnv: options.apiKeyEnv,
        }),
      );
    });

  provider
    .command('edit <providerId>')
    .description(
      'Change an existing provider\'s protocol, endpoint or key, then refresh its models.',
    )
    .option('--type <type>', `New wire protocol: ${MANUAL_PROVIDER_TYPES.join(', ')}.`)
    .option('--base-url <url>', 'New OpenAI-compatible base URL.')
    .option('--api-key <key>', 'New API key. Falls back to KIMI_REGISTRY_API_KEY.')
    .option('--api-key-env <VAR>', 'Read the key from this environment variable instead of storing it.')
    // No explicit default: commander's `--no-x` sets `x` to false only when the
    // flag is given, so the value must be left undefined or it would read
    // `false` on every invocation and silently skip the refresh.
    .option('--no-refresh', 'Apply the change without re-reading the model list.')
    .action(
      async (
        providerId: string,
        options: {
          type?: string;
          baseUrl?: string;
          apiKey?: string;
          apiKeyEnv?: string;
          refresh?: boolean;
        },
      ) => {
        const resolved = resolveDeps(deps);
        await runAction(resolved, () =>
          handleProviderEdit(resolved, providerId, {
            type: options.type,
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            apiKeyEnv: options.apiKeyEnv,
            refresh: options.refresh !== false,
          }),
        );
      },
    );

  provider
    .command('auth <providerId>')
    .description(
      'Replace a provider\'s credential, leaving its protocol and endpoint untouched.',
    )
    .option('--api-key <key>', 'New API key. Falls back to KIMI_REGISTRY_API_KEY.')
    .option('--api-key-env <VAR>', 'Read the key from this environment variable instead of storing it.')
    // Same reason as `edit`: `--no-refresh` only writes `refresh` when the
    // flag is present, so a default here would silently skip discovery.
    .option('--no-refresh', 'Store the key without re-reading the model list.')
    .action(
      async (
        providerId: string,
        options: {
          apiKey?: string;
          apiKeyEnv?: string;
          refresh?: boolean;
        },
      ) => {
        const resolved = resolveDeps(deps);
        await runAction(resolved, () =>
          handleProviderEdit(resolved, providerId, {
            apiKey: options.apiKey,
            apiKeyEnv: options.apiKeyEnv,
            refresh: options.refresh !== false,
            acceptedFlags: AUTH_FLAG_NAMES,
          }),
        );
      },
    );

  provider
    .command('remove <providerId>')
    .description('Remove a provider and every model alias that referenced it.')
    .action(async (providerId: string) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleProviderRemove(resolved, providerId));
    });

  provider
    .command('list')
    .description('Show configured providers and their model counts.')
    .option('--json', 'Emit the raw providers/models config as JSON.', false)
    .action(async (options: { json?: boolean }) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleProviderList(resolved, { json: options.json === true }));
    });

  provider
    .command('models <providerId>')
    .description(
      'Show the models a configured provider serves. Reads only, unless --refresh is passed.',
    )
    .option('--available', 'Also list what the endpoint advertises, without writing anything.', false)
    .option('--refresh', 'Re-read the model list from the endpoint and save it before listing.', false)
    .option('--json', 'Emit the provider, its models and the advertised list as JSON.', false)
    .action(
      async (
        providerId: string,
        options: { available?: boolean; refresh?: boolean; json?: boolean },
      ) => {
        const resolved = resolveDeps(deps);
        await runAction(resolved, () =>
          handleProviderModels(resolved, providerId, {
            json: options.json === true,
            refresh: options.refresh === true,
            available: options.available === true,
          }),
        );
      },
    );

  provider
    .command('test <providerId>')
    .description(
      'Run staged config, credential, connectivity, model-discovery and minimal-request checks against a configured provider. Never prints the credential.',
    )
    .option('--model <alias>', 'Model alias for the minimal request. Defaults to the provider\'s first configured alias.')
    .option('--timeout <ms>', 'Per-request network timeout in milliseconds.', String(DEFAULT_PROVIDER_TEST_TIMEOUT_MS))
    .action(async (providerId: string, options: { model?: string; timeout: string }) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () =>
        handleProviderTest(resolved, providerId, {
          model: options.model,
          timeoutMs: Number.parseInt(options.timeout, 10),
        }),
      );
    });

  const catalog = provider
    .command('catalog')
    .description('Discover and import providers from the public models.dev catalog.');

  catalog
    .command('list [providerId]')
    .description('List providers in the catalog, or models when a providerId is given.')
    .option('--filter <substring>', 'Case-insensitive id/name substring filter.')
    .option('--url <url>', `Override catalog URL. Defaults to ${DEFAULT_CATALOG_URL}.`)
    .option('--json', 'Emit the matching catalog slice as JSON.', false)
    .action(
      async (
        providerId: string | undefined,
        options: { filter?: string; url?: string; json?: boolean },
      ) => {
        const resolved = resolveDeps(deps);
        await runAction(resolved, () =>
          handleCatalogList(resolved, providerId, {
            json: options.json === true,
            ...(options.filter === undefined ? {} : { filter: options.filter }),
            ...(options.url === undefined ? {} : { url: options.url }),
          }),
        );
      },
    );

  catalog
    .command('add <providerId>')
    .description('Import a known provider from the catalog by id.')
    .option('--api-key <key>', 'API key for the provider. Falls back to KIMI_REGISTRY_API_KEY.')
    .option('--default-model <modelId>', 'Mark the imported model as default_model after import.')
    .option(
      '--base-url <url>',
      'Override the catalog endpoint. Required when the catalog declares none (or an env placeholder).',
    )
    .option('--url <url>', `Override catalog URL. Defaults to ${DEFAULT_CATALOG_URL}.`)
    .action(
      async (
        providerId: string,
        options: { apiKey?: string; defaultModel?: string; url?: string; baseUrl?: string },
      ) => {
        const resolved = resolveDeps(deps);
        await runAction(resolved, () =>
          handleCatalogAdd(resolved, providerId, {
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
            ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
            ...(options.url === undefined ? {} : { url: options.url }),
            ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          }),
        );
      },
    );
}

type ResolvedProviderDeps = ProviderDeps & { readonly close: () => Promise<void> };

function resolveDeps(overrides: Partial<ProviderDeps> = {}): ResolvedProviderDeps {
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
    // The v2 harness boots an engine whose watchers hold the event loop open;
    // close it so a one-shot command can exit. No-op for injected harnesses.
    close: async () => {
      await harness?.close();
    },
  };
}

function resolveApiKey(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof flag === 'string' && flag.length > 0) return flag;
  const fromEnv = env['KIMI_REGISTRY_API_KEY'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return undefined;
}

function providerSourceLabel(provider: KimiConfig['providers'][string]): string {
  const source = provider.source;
  if (source !== undefined) {
    if (source['kind'] === 'apiJson' && typeof source['url'] === 'string') {
      return `apiJson(${source['url']})`;
    }
  }
  if (provider.oauth !== undefined) return 'oauth';
  return 'inline';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
