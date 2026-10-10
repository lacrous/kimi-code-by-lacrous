import {
  applyCatalogProvider,
  catalogProviderModels,
  CatalogFetchError,
  RegistryImportError,
  type ImportCustomRegistryResult,
  DEFAULT_CATALOG_URL,
  resolveCatalogImport,
  SECONDARY_DERIVED_MODEL_ALIAS,
  type Catalog,
  type KimiConfigPatch,
  type OAuthRef,
  type ProviderConfig,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';
import { readCustomRegistrySource } from '@moonshot-ai/kimi-code-oauth';

import { createKimiCodeUserAgent } from '#/cli/version';
import { fetchCatalogOrBuiltIn } from '#/utils/catalog-fetch';
import {
  BUILT_IN_PROVIDERS,
  getBuiltInProvider,
} from '#/utils/built-in-providers';
import {
  buildCustomProviderRecord,
  deriveProviderId,
  parseProviderBaseUrl,
} from '#/utils/custom-provider';
import { refreshAllProviderModels } from '../utils/refresh-providers';
import type { RefreshProviderHost, RefreshResult } from '../utils/refresh-providers';
import { refreshKimiRegion } from '#/utils/region';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import {
  CustomRegistryImportDialogComponent,
  type CustomRegistryImportResult,
  type CustomRegistryImportValue,
} from '../components/dialogs/custom-registry-import';
import {
  CustomProviderDialogComponent,
  type CustomProviderResult,
  type CustomProviderValue,
} from '../components/dialogs/custom-provider';
import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '../components/dialogs/provider-manager';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import { effectiveModelForHost } from './config';
import {
  promptApiKey,
  promptBaseUrl,
  promptCatalogProviderSelection,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// /provider command
// ---------------------------------------------------------------------------

/** Marks a picker row as a built-in vendor; the rest of the value is the vendor id. */
const BUILTIN_PREFIX = 'builtin:';

export async function handleProviderCommand(host: SlashCommandHost): Promise<void> {
  const options = buildProviderManagerOptions(host);
  const component = new ProviderManagerComponent(options);
  host.mountEditorReplacement(component);
}

function buildProviderManagerOptions(host: SlashCommandHost): ProviderManagerOptions {
  const activeProviderId =
    host.state.appState.availableModels[host.state.appState.model]?.provider;
  return {
    providers: host.state.appState.availableProviders,
    activeProviderId,
    onAdd: () => {
      void handleProviderAdd(host).catch((error: unknown) => {
        host.showError(`Add provider failed: ${formatErrorMessage(error)}`);
      });
    },
    onSelectSource: (providerIds, label) => {
      handleProviderSelectSource(host, providerIds, label);
    },
    onDeleteSource: (providerIds) => {
      void handleProviderManagerDeleteSource(host, providerIds).catch((error: unknown) => {
        host.showError(`Remove provider failed: ${formatErrorMessage(error)}`);
      });
    },
    onEditKey: (providerIds, label) => {
      void handleProviderEditKey(host, providerIds, label).catch((error: unknown) => {
        host.showError(`Change API key failed: ${formatErrorMessage(error)}`);
      });
    },
    onClose: () => {
      host.restoreEditor();
    },
  };
}

/**
 * Activates a configured platform from the provider list.
 *
 * A platform is only "active" through the model bound to it, so this opens the
 * shared model picker scoped to that platform's tab instead of flipping a
 * separate switch — picking a model is what persists the switch.
 */
function handleProviderSelectSource(
  host: SlashCommandHost,
  providerIds: readonly string[],
  label: string,
): void {
  const ids = new Set(providerIds);
  // Group on `model.provider`, not the alias prefix: a custom-registry row can
  // hold several providers, and the v1 `__secondary__` derived entry carries a
  // provider id of its own, so it drops out here for free.
  const aliases = Object.entries(host.state.appState.availableModels)
    .filter(([, model]) => ids.has(model.provider))
    .map(([alias]) => alias);

  if (aliases.length === 0) {
    host.showError(
      `${label} has no models yet. Re-add it to fetch its model list, or declare one under [models."${providerIds[0] ?? label}/…"] in config.toml.`,
    );
    reopenProviderManager(host);
    return;
  }

  const initialTabId = providerIds.find((id) =>
    aliases.some((alias) => host.state.appState.availableModels[alias]?.provider === id),
  );

  // Every provider's models stay in the dict so `Tab` can still reach the
  // others — the scope is which tab opens, not what is reachable.
  const models = { ...host.state.appState.availableModels };
  delete models[SECONDARY_DERIVED_MODEL_ALIAS];

  const selector = new TabbedModelSelectorComponent({
    models,
    currentValue: host.state.appState.model,
    selectedValue: aliases[0],
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(`Set default model failed: ${formatErrorMessage(error)}`);
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
}

async function handleProviderManagerDeleteSource(
  host: SlashCommandHost,
  providerIds: readonly string[],
): Promise<void> {
  for (const providerId of providerIds) {
    try {
      await handleProviderDelete(host, providerId);
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(`Failed to delete provider ${providerId}: ${msg}`);
    }
  }
  reopenProviderManager(host);
}

/**
 * Replaces the API key behind a `/provider` row.
 *
 * Rows group several providers when they came from one custom-registry
 * (api.json) fetch, and that fetch is authenticated with a single key stored
 * on every record of the row — so the new key is written to all of them.
 *
 * A key swap cannot fail on its own, so the models are re-read afterwards: a
 * rejected key surfaces here instead of on the next request. The refresh is
 * scoped to one provider because that is what the orchestrator accepts; for a
 * registry row the fetch itself is authenticated by the new key, which is what
 * validates the whole row.
 */
async function handleProviderEditKey(
  host: SlashCommandHost,
  providerIds: readonly string[],
  label: string,
): Promise<void> {
  const config = await host.harness.getConfig();
  const entries = providerIds.flatMap((id) => {
    const record = config.providers[id];
    return record === undefined ? [] : [{ id, record }];
  });

  // An OAuth record has no hand-editable key: its credential comes from the
  // token store and the next token refresh would overwrite anything written
  // here, so it is changed through `/login`. Open Platform rows are deliberately
  // *not* excluded — those hold a real API key and `/login` for them is this
  // same prompt, so refusing here would deny a key change that works.
  if (entries.length === 0 || entries.some((e) => e.record.oauth !== undefined)) {
    host.showError(`${label} signs in with an account, not an API key — use /login to change it.`);
    reopenProviderManager(host);
    return;
  }

  const viaRegistry = readCustomRegistrySource(entries[0]!.record) !== undefined;
  const apiKey = await promptApiKey(host, label, [
    `Replaces the key currently saved for "${label}".`,
    viaRegistry
      ? 'The registry that declares its models is fetched with the new key.'
      : 'Your key will be saved to ~/.kimi-code/config.toml',
  ]);
  if (apiKey === undefined) {
    reopenProviderManager(host);
    return;
  }

  const providers = { ...config.providers };
  for (const { id, record } of entries) {
    if (readCustomRegistrySource(record) !== undefined) {
      providers[id] = { ...record, source: { ...record.source, apiKey } };
      continue;
    }
    // A spread cannot delete: leaving a stale `apiKeyEnv` beside the inline key
    // would leave the record carrying both, which the runtime rejects.
    const next: Record<string, unknown> = { ...record, apiKey };
    delete next['apiKeyEnv'];
    providers[id] = next as ProviderConfig;
  }
  await host.harness.setConfig({
    providers,
    models: config.models,
    defaultModel: config.defaultModel,
    thinking: config.thinking,
  });

  const target = entries[0]!.id;
  const spinner = host.showLoginProgressSpinner(`Refreshing models for ${label}`);
  let refreshed: RefreshResult;
  try {
    refreshed = await refreshAllProviderModels(buildDiscoveryHost(host), {
      providerId: target,
    });
  } catch (error) {
    spinner.stop({ ok: false, label: 'Key saved; model refresh failed.' });
    host.showError(`Key saved for ${label}, refreshing models failed: ${formatErrorMessage(error)}`);
    return;
  }

  const failure = refreshed.failed.find((f) => f.provider === target);
  if (failure !== undefined) {
    spinner.stop({ ok: false, label: 'Key saved; model refresh failed.' });
    host.showError(`Key saved for ${label}, refreshing models failed: ${failure.reason}`);
    return;
  }
  spinner.stop({ ok: true, label: `${label} key updated.` });

  await host.authFlow.refreshConfigAfterLogin();
  reopenProviderManager(host);
}

async function handleProviderDelete(host: SlashCommandHost, providerId: string): Promise<void> {
  if (providerId === DEFAULT_OAUTH_PROVIDER_NAME) {
    await host.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);
    // Drop the process-wide region cache with the credential: derived
    // endpoints (updates, marketplace, site links, telemetry) must fall back
    // to the marker/default profile, not the logged-out region.
    refreshKimiRegion();
    await host.authFlow.refreshConfigAfterLogout();
    return;
  }

  const activeProvider =
    host.state.appState.availableModels[host.state.appState.model]?.provider;
  const config = await host.harness.removeProvider(providerId);
  if (activeProvider === providerId) {
    await host.authFlow.refreshConfigAfterLogout();
  } else {
    host.setAppState({
      availableProviders: config.providers ?? {},
      availableModels: config.models ?? {},
    });
  }
}

async function handleProviderAdd(host: SlashCommandHost): Promise<void> {
  const source = await promptProviderAddSource(host);
  if (source === undefined) {
    reopenProviderManager(host);
    return;
  }

  if (source === 'known') {
    await handleCatalogProviderAdd(host);
    return;
  }
  if (source === 'endpoint') {
    await handleCustomEndpointAdd(host);
    return;
  }
  if (source !== 'custom') {
    await handleBuiltinProviderAdd(host, source);
    return;
  }
  const handled = await handleCustomRegistryAddViaDialog(host);
  if (!handled) {
    reopenProviderManager(host);
  }
}

/**
 * Configures a provider from the pasted base URL and optional key.
 *
 * This is the path for a server that is not in the built-in table and not in
 * the models.dev catalog — a gateway, a proxy, or a model running on the user's
 * own machine. Only the base URL is asked for; the wire defaults to
 * OpenAI-compatible and the models are read from the endpoint's own `/models`
 * route, so nothing has to be looked up anywhere.
 */
async function handleCustomEndpointAdd(host: SlashCommandHost): Promise<void> {
  const value = await promptCustomProvider(host);
  if (value === undefined) {
    reopenProviderManager(host);
    return;
  }

  // Re-check: the dialog validated before closing, but the record is written
  // to config.toml and every later log line quotes it back.
  const check = parseProviderBaseUrl(value.baseUrl);
  if (!check.ok) {
    host.showError(`Base URL ${check.reason}`);
    reopenProviderManager(host);
    return;
  }

  // The id is derived, never asked for: it must not collide with a configured
  // provider or a built-in vendor, or the two records would overwrite each
  // other in config.toml.
  const providerId = deriveProviderId(check.baseUrl, [
    ...Object.keys(host.state.appState.availableProviders),
    ...BUILT_IN_PROVIDERS.map((provider) => provider.id),
  ]);

  await addProviderAndSelectModel(host, { providerId, name: providerId, baseUrl: check.baseUrl }, () =>
    saveProviderRecord(host, providerId, buildCustomProviderRecord(check.baseUrl, value.apiKey)),
  );
}

function promptCustomProvider(host: SlashCommandHost): Promise<CustomProviderValue | undefined> {
  return new Promise((resolve) => {
    const dialog = new CustomProviderDialogComponent((result: CustomProviderResult) => {
      host.restoreEditor();
      resolve(result.kind === 'ok' ? result.value : undefined);
    });
    host.mountEditorReplacement(dialog);
  });
}

/**
 * Configures a built-in provider (Cline): ask for the API key, save it, then
 * read the model list from the vendor endpoint.
 *
 * This path deliberately does not go through the models.dev catalog: it works
 * with no network dependency on models.dev, which is what makes it usable in a
 * dev build (where the release-time catalog snapshot is absent). Discovery
 * itself is delegated to the same refresh orchestrator the CLI uses, so the
 * two surfaces cannot drift.
 */
async function handleBuiltinProviderAdd(
  host: SlashCommandHost,
  providerId: string,
): Promise<void> {
  const builtin = getBuiltInProvider(providerId);
  if (builtin === undefined) {
    host.showError(`Unknown built-in provider "${providerId}".`);
    reopenProviderManager(host);
    return;
  }

  const alreadyConfigured = host.state.appState.availableProviders[builtin.id] !== undefined;
  const apiKey = await promptApiKey(
    host,
    builtin.name,
    [
      `Get a key at ${builtin.consoleUrl}`,
      ...(builtin.keyHint === undefined ? [] : [`Keys look like ${builtin.keyHint}…`]),
      alreadyConfigured
        ? `Replaces the key currently saved for "${builtin.id}".`
        : 'Your key will be saved to ~/.kimi-code/config.toml',
    ],
  );
  if (apiKey === undefined) return;

  await addProviderAndSelectModel(
    host,
    { providerId: builtin.id, name: builtin.name, baseUrl: builtin.baseUrl },
    () =>
      saveProviderRecord(host, builtin.id, {
        type: builtin.wire,
        baseUrl: builtin.baseUrl,
        apiKey,
        // Same record the CLI writes: without this a TUI-added Zen loses the
        // per-model wire pins and its Claude models go back to failing.
        protocolOverrides: builtin.protocolOverrides,
      }),
  );
}

/**
 * Shared tail of every add-a-provider flow: persist, discover models from the
 * endpoint, reload config, then offer a default model.
 *
 * The provider record must exist before discovery: the orchestrator reads
 * config to decide candidacy and to resolve the credential. A rejected key is
 * still persisted deliberately — the user can correct it by re-running the
 * flow, and a bad key is recoverable while a silently missing provider is
 * indistinguishable from a broken install.
 */
async function addProviderAndSelectModel(
  host: SlashCommandHost,
  target: { readonly providerId: string; readonly name: string; readonly baseUrl: string },
  save: () => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancel;

  await save();

  const spinner = host.showLoginProgressSpinner(`Fetching models from ${target.baseUrl}`);
  let discovered: RefreshResult;
  try {
    discovered = await refreshAllProviderModels(buildDiscoveryHost(host), {
      providerId: target.providerId,
    });
  } catch (error) {
    spinner.stop({ ok: false, label: 'Failed to fetch models.' });
    host.showError(`Fetching models failed: ${formatErrorMessage(error)}`);
    return;
  } finally {
    if (host.cancelInFlight === cancel) host.cancelInFlight = undefined;
  }

  const failure = discovered.failed.find((f) => f.provider === target.providerId);
  if (failure !== undefined) {
    spinner.stop({ ok: false, label: 'Failed to fetch models.' });
    host.showError(`Fetching models for ${target.name} failed: ${failure.reason}`);
    return;
  }
  spinner.stop({
    ok: true,
    label:
      discovered.changed.length > 0
        ? `${target.name} added — ${discovered.changed[0]!.added} model(s) discovered.`
        : `${target.name} is up to date.`,
  });

  await host.authFlow.refreshConfigAfterLogin();

  // Nothing was discovered (endpoint down, empty list): the provider may still
  // have been saved, so tell the user what to do rather than silently leaving a
  // provider that cannot resolve a model.
  const aliases = Object.keys(host.state.appState.availableModels).filter((alias) =>
    alias.startsWith(`${target.providerId}/`),
  );
  if (aliases.length === 0) {
    host.showError(
      `${target.name} returned no models. Add them manually under [models."${target.providerId}/…"] in config.toml.`,
    );
    return;
  }

  promptProviderModelSelection(host, target.providerId, aliases);
}

/**
 * Persistence host for the refresh orchestrator.
 *
 * Written for one provider: the orchestrator reads config to decide which
 * providers are candidates and to resolve credentials, and is scoped to
 * `providerId` by the caller, so this host stays provider-agnostic.
 */
function buildDiscoveryHost(host: SlashCommandHost): RefreshProviderHost {
  return {
    getConfig: () => host.harness.getConfig({ reload: true }),
    removeProvider: (id: string) => host.harness.removeProvider(id),
    setConfig: (patch: KimiConfigPatch) => host.harness.setConfig(patch),
    resolveOAuthToken: async (providerName: string, oauthRef?: OAuthRef) => {
      const tokenProvider = host.harness.auth.resolveOAuthTokenProvider(providerName, oauthRef);
      return tokenProvider.getAccessToken();
    },
    userAgent: createKimiCodeUserAgent(),
  };
}

/** Persists a provider record, replacing any prior record with the same id. */
async function saveProviderRecord(
  host: SlashCommandHost,
  providerId: string,
  record: ProviderConfig,
): Promise<void> {
  const config = await host.harness.getConfig();
  // Remove first: a spread cannot delete a key that is no longer part of the
  // record (a stale `protocolOverrides` on a re-add would survive it).
  if (config.providers[providerId] !== undefined) {
    await host.harness.removeProvider(providerId);
  }
  const next = await host.harness.getConfig();
  next.providers = {
    ...next.providers,
    [providerId]: record,
  };
  await host.harness.setConfig({
    providers: next.providers,
    models: next.models,
    defaultModel: next.defaultModel,
    thinking: next.thinking,
  });
}

/**
 * Picker for choosing the default model out of the freshly discovered list.
 * Cancelling leaves the provider and its models saved — only the default
 * selection is skipped.
 */
function promptProviderModelSelection(
  host: SlashCommandHost,
  providerId: string,
  aliases: readonly string[],
): void {
  const selector = new TabbedModelSelectorComponent({
    models: Object.fromEntries(
      aliases.map((alias) => [
        alias,
        host.state.appState.availableModels[alias] ?? {
          provider: providerId,
          model: alias.slice(providerId.length + 1),
          maxContextSize: 0,
        },
      ]),
    ),
    currentValue: host.state.appState.model,
    selectedValue: aliases[0],
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId: providerId,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(`Set default model failed: ${formatErrorMessage(error)}`);
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
}

function reopenProviderManager(host: SlashCommandHost): void {
  const options = buildProviderManagerOptions(host);
  const component = new ProviderManagerComponent(options);
  host.mountEditorReplacement(component);
}

/**
 * Asks what kind of provider to add.
 *
 * Returns `'known'` / `'custom'` for the two registry-based paths, `'endpoint'`
 * for a pasted base URL, or a bare vendor id (`'cline'`) when a built-in row was
 * chosen — callers dispatch on that by looking the id up in
 * {@link BUILT_IN_PROVIDERS}. The literals are documentation only: a bare
 * `string` return keeps those cases type-safe without a redundant-union lint.
 */
function promptProviderAddSource(host: SlashCommandHost): Promise<string | undefined> {
  return new Promise((resolve) => {
    // Built-in vendors come first: they need no registry and no catalog, so
    // they work even when models.dev is unreachable (the case a dev build
    // cannot fall back from — it has no release-time catalog snapshot).
    //
    // The row value carries the vendor id directly (`builtin:cline`), so the
    // selection survives without a second lookup and adding a vendor needs no
    // change here.
    const options: ChoiceOption[] = [
      ...BUILT_IN_PROVIDERS.map((p) => ({
        value: `builtin:${p.id}`,
        label: p.name,
        description: p.description,
      })),
      // Needs neither the catalog nor a registry — only the endpoint itself.
      {
        value: 'endpoint',
        label: 'Custom endpoint',
        description: 'Paste a base URL and an API key',
      },
      { value: 'known', label: 'Known third-party provider' },
      { value: 'custom', label: 'Custom registry (api.json)' },
    ];
    const picker = new ChoicePickerComponent({
      title: 'Add provider',
      options,
      onSelect: (value) => {
        host.restoreEditor();
        if (value === 'known' || value === 'custom' || value === 'endpoint') {
          resolve(value);
          return;
        }
        if (value.startsWith(BUILTIN_PREFIX)) {
          resolve(value.slice(BUILTIN_PREFIX.length));
          return;
        }
        resolve(undefined);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

async function handleCatalogProviderAdd(host: SlashCommandHost): Promise<void> {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancel;

  const spinner = host.showLoginProgressSpinner(`Fetching catalog from ${DEFAULT_CATALOG_URL}`);
  let catalog: Catalog | undefined;
  try {
    const loaded = await fetchCatalogOrBuiltIn(DEFAULT_CATALOG_URL, {
      signal: controller.signal,
      userAgent: createKimiCodeUserAgent(),
    });
    catalog = loaded.catalog;
    spinner.stop({
      ok: true,
      label: loaded.fromBuiltIn
        ? 'Catalog loaded from built-in snapshot (models.dev unreachable).'
        : 'Catalog loaded.',
    });
  } catch (error) {
    if (controller.signal.aborted) {
      spinner.stop({ ok: false, label: 'Aborted.' });
    } else {
      const hint = error instanceof CatalogFetchError ? ` (HTTP ${error.status})` : '';
      spinner.stop({ ok: false, label: 'Failed to load catalog.' });
      host.showError(`Failed to fetch catalog${hint}: ${formatErrorMessage(error)}`);
    }
  } finally {
    if (host.cancelInFlight === cancel) host.cancelInFlight = undefined;
  }

  if (catalog === undefined) return;

  const providerId = await promptCatalogProviderSelection(host, catalog);
  if (providerId === undefined) return;
  const entry = catalog[providerId];
  if (entry === undefined) return;

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    host.showError(`Provider "${providerId}" has no usable models in this catalog.`);
    return;
  }

  let resolution = resolveCatalogImport(entry);
  if (resolution.kind === 'needs-base-url') {
    const entered = await promptBaseUrl(host, entry.name ?? providerId);
    if (entered === undefined) return;
    resolution = resolveCatalogImport(entry, entered);
  }
  if (resolution.kind !== 'ok') {
    if (resolution.kind === 'invalid') {
      if (resolution.reason === 'unknown-explicit-type') {
        host.showError(
          `Provider "${providerId}" declares protocol "${entry.type}" in the catalog, which this client version does not support.`,
        );
      } else if (resolution.reason === 'proprietary-sdk') {
        host.showError(
          `Provider "${providerId}" uses a proprietary SDK this client cannot speak (e.g. Amazon Bedrock or Cohere); it cannot be imported from the catalog.`,
        );
      } else {
        host.showError(
          `Base URL contains an env placeholder or is empty. Enter the resolved URL instead.`,
        );
      }
    }
    return;
  }
  const { wire, baseUrl } = resolution;

  // Read the existing record before prompting: the catalog path replaces the
  // provider wholesale, so a key already saved here would otherwise be dropped
  // without the user being told.
  const existingConfig = await host.harness.getConfig();
  const alreadyConfigured = existingConfig.providers[providerId] !== undefined;

  const apiKey = await promptApiKey(
    host,
    entry.name ?? providerId,
    alreadyConfigured
      ? [`Replaces the key currently saved for "${providerId}".`]
      : undefined,
  );
  if (apiKey === undefined) return;

  // Persist the provider and all its models immediately after the api key is
  // entered. The model selector that follows is just a convenience to pick the
  // default model; ESC leaves the provider in place without a default selection.
  if (existingConfig.providers[providerId] !== undefined) {
    await host.harness.removeProvider(providerId);
  }

  const config = await host.harness.getConfig();
  applyCatalogProvider(config, {
    providerId,
    wire,
    baseUrl,
    apiKey,
    models,
    selectedModelId: '', // no default yet; user picks in the model selector
    thinking: false,    // will be resolved by the model selector
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('connect', { provider: providerId, method: 'catalog' });
  host.showStatus(`Provider added: ${entry.name ?? providerId}`);
  if (resolution.guessed) {
    host.showStatus(
      `Protocol guessed as "openai" for ${providerId} — edit "type" in config.toml if requests fail.`,
    );
  }

  // Build a merged model dictionary that includes existing models plus the
  // newly-persisted provider's models, so the tabbed selector shows every
  // provider's tab (the new provider's tab starts active via initialTabId).
  // The v1 runtime may carry the synthesized `__secondary__` derived entry —
  // never selectable in a picker.
  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const mergedModels = { ...stateModels };
  delete mergedModels[SECONDARY_DERIVED_MODEL_ALIAS];

  const selector = new TabbedModelSelectorComponent({
    models: mergedModels,
    currentValue: host.state.appState.model,
    selectedValue: Object.keys(mergedModels).find((a) => a.startsWith(`${providerId}/`)),
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId: providerId,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(`Set default model failed: ${formatErrorMessage(error)}`);
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
}

export async function setDefaultModel(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
): Promise<void> {
  // Resolve efforts the same way the /model path does (effectiveModelForHost
  // applies overrides and the protocol-profile inference): catalog entries for
  // e.g. Anthropic models declare no support_efforts on the alias, and without
  // the inference an above-default pick would slip through as a persisted effort.
  const model = host.state.appState.availableModels[alias];
  const thinking = thinkingEffortToConfig(
    effort,
    model === undefined ? undefined : effectiveModelForHost(host, model),
  );
  if (host.session === undefined) {
    // A first prompt may still be inside lazy creation: wait it out so the
    // pick lands on the new session instead of racing its assembly (same
    // coordination as the /model path).
    await host.waitForLazyCreation();
  }
  await host.harness.setConfig({
    defaultModel: alias,
    thinking,
  });
  // Whether activation made the engine emit model_switch (it reached a live
  // session AND changed the bound alias — both engines track only an actual
  // change). Recorded at activation time rather than snapshotted at entry: a
  // lazy session can come live while the config writes above are pending; a
  // session created BY activation (v1) or a same-alias rebind does not count
  // — both bind the model without an engine event.
  let engineTrackedSwitch = await host.authFlow.refreshConfigAfterLogin();
  // refreshConfigAfterLogin reactivates from the persisted config, so a pick
  // the gate keeps session-only never reaches the runtime — apply it after
  // the refresh, or the persisted value would clobber it.
  if (thinking.effort === undefined && effort !== 'off' && effort !== 'on') {
    engineTrackedSwitch =
      (await host.authFlow.activateModelAfterLogin(alias, effort)) || engineTrackedSwitch;
  }
  // When the engine never emitted (no live session, or the alias was already
  // bound), the TUI stays the sole producer for the pick.
  if (!engineTrackedSwitch) {
    host.track('model_switch', { model: alias });
  }
  host.showStatus(`Default model set to ${alias} with thinking ${effort}.`);
}

async function handleCustomRegistryAddViaDialog(host: SlashCommandHost): Promise<boolean> {
  const value = await promptCustomRegistryImport(host);
  if (value === undefined) return false;

  let result: ImportCustomRegistryResult;
  try {
    result = await host.harness.importCustomRegistry({
      url: value.url,
      apiKey: value.apiKey,
      setDefaultWhenUnset: false,
    });
  } catch (error) {
    if (error instanceof RegistryImportError && error.phase === 'empty') {
      host.showStatus('Registry contained no providers.');
      return false;
    }
    const phase =
      error instanceof RegistryImportError && error.phase === 'fetch' ? 'import' : 'apply';
    host.showError(`Failed to ${phase} registry: ${formatErrorMessage(error)}`);
    if (
      value.apiKey === undefined &&
      error instanceof RegistryImportError &&
      (error.status === 401 || error.status === 403)
    ) {
      host.showStatus('This registry requires authentication — paste its Bearer token.', 'warning');
    }
    return false;
  }
  try {
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(`Failed to apply registry: ${formatErrorMessage(error)}`);
    return false;
  }
  const addedProviderIds = result.providers.map((provider) => provider.id);
  const count = addedProviderIds.length;
  host.showStatus(
    count === 1
      ? 'Imported 1 provider from registry.'
      : `Imported ${String(count)} providers from registry.`,
    'success',
  );
  for (const [id, envName] of Object.entries(result.credentialEnv)) {
    host.showStatus(
      `provider "${id}" declares credential env var "${envName}" — set api_key_env in config.toml to use it`,
    );
  }

  // Offer the model selector so the user can pick a default, just like the
  // catalog (known-provider) flow. Copy without the v1-synthesized
  // `__secondary__` derived entry — never selectable in a picker.
  const stateModels = { ...(await host.harness.getConfig().then((c) => c.models ?? {})) };
  delete stateModels[SECONDARY_DERIVED_MODEL_ALIAS];
  const firstNewAlias = Object.keys(stateModels).find((a) =>
    addedProviderIds.some((pid) => a.startsWith(`${pid}/`)),
  );
  const firstNewProvider = firstNewAlias
    ? stateModels[firstNewAlias]?.provider
    : addedProviderIds[0];
  const selector = new TabbedModelSelectorComponent({
    models: stateModels,
    currentValue: host.state.appState.model,
    selectedValue: firstNewAlias,
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId: firstNewProvider,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(`Set default model failed: ${formatErrorMessage(error)}`);
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
  return true;
}

function promptCustomRegistryImport(
  host: SlashCommandHost,
): Promise<CustomRegistryImportValue | undefined> {
  return new Promise((resolve) => {
    const dialog = new CustomRegistryImportDialogComponent(
      (result: CustomRegistryImportResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
    );
    host.mountEditorReplacement(dialog);
  });
}
