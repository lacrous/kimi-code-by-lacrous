/**
 * Scenario: /provider post-add default-model selection.
 * Responsibilities: the picked effort is gated for persistence by the model's
 * effective default, and a session-only pick is still applied to the runtime
 * after the config refresh (which only reactivates from persisted values).
 * Wiring: real setDefaultModel with the harness/authFlow boundaries stubbed by
 * a small host rig.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/provider.test.ts
 */
import type { KimiConfig, ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import {
  formatContextSize,
  handleContextCommand,
  parseContextSize,
} from '#/tui/commands/context';
import { handleProviderCommand, setDefaultModel } from '#/tui/commands/provider';
import { ApiKeyInputDialogComponent } from '#/tui/components/dialogs/api-key-input-dialog';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { ProviderManagerComponent } from '#/tui/components/dialogs/provider-manager';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';
import { BUILT_IN_PROVIDERS } from '#/utils/built-in-providers';
import {
  buildCustomProviderRecord,
  deriveProviderId,
  parseProviderBaseUrl,
} from '#/utils/custom-provider';

// Model discovery is the only outbound call the add flow makes; stubbed so the
// test asserts what /provider writes, not what an endpoint happens to answer.
vi.mock('#/tui/utils/refresh-providers', () => ({
  refreshAllProviderModels: vi.fn(async (_host: unknown, options: { providerId?: string }) => {
    const providerId = options.providerId ?? '';
    return {
      changed: [{ providerId, providerName: providerId, added: 2, removed: 0 }],
      unchanged: [],
      failed: [],
    };
  }),
}));

const ESC = String.fromCodePoint(27);
const ENTER = '\r';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const TAB = '\t';

function makeHost(
  options: {
    refreshReachedLiveSession?: boolean;
    activateReachedLiveSession?: boolean;
  } = {},
) {
  const appState = {
    availableModels: {
      // Declares no efforts; the Anthropic profile inference supplies
      // [low, medium, high, xhigh, max] with the default resolved to 'high'.
      opus: {
        provider: 'compatible',
        model: 'claude-opus-4-7',
        maxContextSize: 200_000,
      } as unknown as ModelAlias,
    },
    availableProviders: {
      compatible: { type: 'anthropic' },
    },
  };
  const host = {
    state: { appState },
    waitForLazyCreation: vi.fn(async () => {}),
    harness: {
      setConfig: vi.fn(async () => ({})),
    },
    authFlow: {
      refreshConfigAfterLogin: vi.fn(async () => options.refreshReachedLiveSession === true),
      activateModelAfterLogin: vi.fn(async () => options.activateReachedLiveSession === true),
    },
    track: vi.fn(),
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: { setConfig: ReturnType<typeof vi.fn> };
    authFlow: {
      refreshConfigAfterLogin: ReturnType<typeof vi.fn>;
      activateModelAfterLogin: ReturnType<typeof vi.fn>;
    };
    waitForLazyCreation: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
  };
  return { host };
}

describe('setDefaultModel', () => {
  it('applies an above-default pick to the runtime when the gate keeps it session-only', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: 'opus',
      thinking: { enabled: true },
    });
    expect(host.authFlow.activateModelAfterLogin).toHaveBeenCalledWith('opus', 'xhigh');
    // The application must come after the refresh, or the persisted value
    // reactivated by refreshConfigAfterLogin would clobber the pick.
    expect(
      host.authFlow.activateModelAfterLogin.mock.invocationCallOrder[0]!,
    ).toBeGreaterThan(host.authFlow.refreshConfigAfterLogin.mock.invocationCallOrder[0]!);
    // Without a session the engine never sees the pick, so the TUI stays the
    // sole model_switch producer.
    expect(host.track).toHaveBeenCalledWith('model_switch', { model: 'opus' });
  });

  it('does not re-apply the effort when the pick persists', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'high');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: 'opus',
      thinking: { enabled: true, effort: 'high' },
    });
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
  });

  it('does not re-apply a boolean on pick', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'on');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: 'opus',
      thinking: { enabled: true },
    });
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
  });

  it('leaves model_switch to the engine when activation changed the bound alias', async () => {
    const { host } = makeHost({ refreshReachedLiveSession: true });

    await setDefaultModel(host, 'opus', 'high');

    // refreshConfigAfterLogin routed through session.setModel with a changed
    // alias, which the engine already tracks — a TUI-side event would
    // double-count the switch.
    expect(host.track).not.toHaveBeenCalled();
  });

  it('leaves model_switch to the engine when a lazy session came live mid-flow and rebounded', async () => {
    // Session-less at entry, but the first prompt's lazy creation completes
    // while setConfig / the refresh are pending, so the session-only re-apply
    // lands on the now-live session and actually switches its alias (engine
    // emits).
    const { host } = makeHost({ activateReachedLiveSession: true });

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.authFlow.activateModelAfterLogin).toHaveBeenCalledWith('opus', 'xhigh');
    expect(host.track).not.toHaveBeenCalled();
  });

  it('emits model_switch when a v1-created session only rebinds the same alias', async () => {
    // v1 session-less + session-only effort: the refresh creates the session
    // with the picked model (creation emits nothing), then the re-apply
    // reaches that live session but its setModel is an alias no-op (no engine
    // event either) — the TUI must stay the producer for the pick.
    const { host } = makeHost({
      refreshReachedLiveSession: false,
      activateReachedLiveSession: false,
    });

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.authFlow.activateModelAfterLogin).toHaveBeenCalledWith('opus', 'xhigh');
    expect(host.track).toHaveBeenCalledWith('model_switch', { model: 'opus' });
  });

  it('waits for an in-flight lazy creation before activating (v2)', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'high');

    expect(host.waitForLazyCreation).toHaveBeenCalled();
    expect(
      host.waitForLazyCreation.mock.invocationCallOrder[0]!,
    ).toBeLessThan(host.harness.setConfig.mock.invocationCallOrder[0]!);
  });
});

/**
 * Host with a mounted-panel log, so the /provider list can be driven with real
 * key input the way the TUI does. `other` holds the active model, which is where
 * the list opens its cursor; `empty` is configured but has no models at all.
 */
function makeProviderHost() {
  const appState = {
    model: 'other/thing',
    thinkingEffort: 'high',
    availableModels: {
      'acme/sonnet': { provider: 'acme', model: 'sonnet', maxContextSize: 200_000 },
      'acme/opus': { provider: 'acme', model: 'opus', maxContextSize: 200_000 },
      'other/thing': { provider: 'other', model: 'thing', maxContextSize: 200_000 },
    },
    // Annotated because tests add platforms to it at runtime; a literal type
    // would reject the extra keys the `/provider` rows are built from.
    availableProviders: {
      empty: { type: 'openai' },
      acme: { type: 'openai' },
      other: { type: 'openai' },
    } as Record<string, Record<string, unknown>>,
  };
  const mounted: (Component & Focusable)[] = [];
  // The add flow reads config before it writes, so getConfig/removeProvider have
  // to mutate one shared record the way the real harness does.
  const config: KimiConfig = {
    providers: {
      empty: { type: 'openai' },
      acme: { type: 'openai' },
      other: { type: 'openai' },
    },
    defaultModel: 'other/thing',
  };
  const spinnerStop = vi.fn();
  const host = {
    state: { appState },
    waitForLazyCreation: vi.fn(async () => {}),
    mountEditorReplacement: vi.fn((panel: Component & Focusable) => {
      mounted.push(panel);
    }),
    restoreEditor: vi.fn(),
    harness: {
      getConfig: vi.fn(async (): Promise<KimiConfig> => config),
      removeProvider: vi.fn(async (providerId: string): Promise<KimiConfig> => {
        delete config.providers[providerId];
        return config;
      }),
      setConfig: vi.fn(async (patch: Partial<KimiConfig>): Promise<KimiConfig> => {
        Object.assign(config, patch);
        return config;
      }),
    },
    authFlow: {
      refreshConfigAfterLogin: vi.fn(async () => false),
      activateModelAfterLogin: vi.fn(async () => false),
    },
    track: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showLoginProgressSpinner: vi.fn(() => ({ stop: spinnerStop })),
  } as unknown as SlashCommandHost & {
    harness: {
      getConfig: ReturnType<typeof vi.fn>;
      removeProvider: ReturnType<typeof vi.fn>;
      setConfig: ReturnType<typeof vi.fn>;
    };
    restoreEditor: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showLoginProgressSpinner: ReturnType<typeof vi.fn>;
  };
  return { host, mounted, appState, config, spinnerStop };
}

function press(panel: Component & Focusable, keys: readonly string[]): void {
  for (const key of keys) panel.handleInput?.(key);
}

describe('handleProviderCommand', () => {
  it('opens the model picker scoped to the platform picked with Enter', async () => {
    const { host, mounted } = makeProviderHost();
    await handleProviderCommand(host);

    // The list opens on the active platform's row; move up onto `acme`.
    press(mounted[0]!, [UP, ENTER]);

    expect(mounted).toHaveLength(2);
    expect(mounted[1]).toBeInstanceOf(TabbedModelSelectorComponent);
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('persists the model chosen for the selected platform', async () => {
    const { host, mounted } = makeProviderHost();
    await handleProviderCommand(host);
    press(mounted[0]!, [UP, ENTER]);

    // Filter to a single row so the pick does not depend on where the picker's
    // cursor happens to start.
    const picker = mounted[1]!;
    press(picker, ['s', 'o', 'n', 'n', 'e', 't', ENTER]);

    await vi.waitFor(() => {
      expect(host.harness.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({ defaultModel: 'acme/sonnet' }),
      );
    });
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('reports a platform with no models instead of opening the picker', async () => {
    const { host, mounted } = makeProviderHost();
    await handleProviderCommand(host);

    // Rows are [empty, acme, other(current), add]; two hops up lands on `empty`.
    press(mounted[0]!, [UP, UP, ENTER]);

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('empty'));
    expect(mounted).toHaveLength(2);
    expect(mounted[1]).not.toBeInstanceOf(TabbedModelSelectorComponent);
  });
});

/**
 * Opens the "Custom endpoint" dialog with real key input: the add row on the
 * provider manager, then the source picker. Each key must stay one whole string
 * — splitting `\x1b[B` into characters would deliver a bare Escape, which
 * cancels the picker.
 */
async function openCustomEndpointDialog(
  rig: ReturnType<typeof makeProviderHost>,
): Promise<void> {
  const { host, mounted } = rig;
  await handleProviderCommand(host);
  // Rows are [empty, acme, other(current), add]; one hop down lands on `add`.
  press(mounted[0]!, [DOWN, ENTER]);
  await vi.waitFor(() => {
    expect(mounted).toHaveLength(2);
  });

  // The source picker lists every built-in vendor first, so the endpoint row
  // sits exactly BUILT_IN_PROVIDERS.length hops below the top.
  const hops = Array.from({ length: BUILT_IN_PROVIDERS.length }, () => DOWN);
  press(mounted[1]!, [...hops, ENTER]);
  await vi.waitFor(() => {
    expect(mounted).toHaveLength(3);
  });
}

/**
 * Types literal text one keystroke at a time, the way a person would: an
 * escape sequence must stay a single key, but plain text is fine to split.
 */
function typed(text: string): string[] {
  return text.split('');
}

/**
 * Drives the whole "Custom endpoint" path. Resolves once the provider record has
 * been persisted; discovery and the model pick are awaited by the callers that
 * care about them.
 */
async function addCustomEndpoint(
  rig: ReturnType<typeof makeProviderHost>,
  baseUrl: string,
  apiKey: string | undefined,
): Promise<void> {
  const { host, mounted } = rig;
  await openCustomEndpointDialog(rig);

  // Enter on the URL field advances to the key field, Enter on it submits.
  press(mounted[2]!, [...typed(baseUrl), ENTER, ...typed(apiKey ?? ''), ENTER]);
  await vi.waitFor(() => {
    expect(host.harness.setConfig).toHaveBeenCalled();
  });
}

function seedModel(
  appState: ReturnType<typeof makeProviderHost>['appState'],
  alias: string,
): void {
  const [provider, model] = alias.split('/') as [string, string];
  const models = appState.availableModels as unknown as Record<string, ModelAlias>;
  models[alias] = { provider, model, maxContextSize: 200_000 };
}

describe('custom endpoint provider', () => {
  it('adds a provider from a pasted base URL and key, then offers the discovered models', async () => {
    const rig = makeProviderHost();
    seedModel(rig.appState, 'api-example/sonnet');

    await addCustomEndpoint(rig, 'https://api.example.com/v1', 'YOUR_API_KEY');

    const patch = rig.host.harness.setConfig.mock.calls.at(-1)![0] as KimiConfig;
    // The id comes from the hostname, never from the user, and the wire is
    // OpenAI-compatible so the key needs no protocol picker.
    expect(patch.providers['api-example']).toEqual({
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'YOUR_API_KEY',
    });
    expect(rig.spinnerStop).toHaveBeenCalledWith({
      ok: true,
      label: 'api-example added — 2 model(s) discovered.',
    });

    await vi.waitFor(() => {
      expect(rig.mounted.at(-1)).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    expect(rig.host.showError).not.toHaveBeenCalled();
  });

  it('records a keyless endpoint as sending no credential at all', async () => {
    const rig = makeProviderHost();
    seedModel(rig.appState, 'localhost-11434/llama3');

    await addCustomEndpoint(rig, 'http://localhost:11434/v1', undefined);

    const patch = rig.host.harness.setConfig.mock.calls.at(-1)![0] as KimiConfig;
    // Without `none`, the OpenAI-compatible client substitutes the literal
    // `unused` as the key and sends `Authorization: Bearer unused`.
    expect(patch.providers['localhost-11434']).toEqual({
      type: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      authScheme: { kind: 'none' },
    });

    // An empty key is a valid answer: the dialog skips the key field instead of
    // demanding one, and the rest of the add flow runs unchanged.
    await vi.waitFor(() => {
      expect(rig.mounted.at(-1)).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    expect(rig.host.showError).not.toHaveBeenCalled();
  });

  it('keeps the dialog open on a base URL that is not usable', async () => {
    const rig = makeProviderHost();
    await openCustomEndpointDialog(rig);

    press(rig.mounted[2]!, [...typed('ftp://api.example.com'), ENTER, ENTER]);

    // Invalid URL: the dialog reports it in place instead of writing anything.
    expect(rig.mounted[2]!.render(80).join('\n')).toContain('Base URL must be http(s)');
    expect(rig.host.harness.setConfig).not.toHaveBeenCalled();
  });
});

describe('provider key edit', () => {
  it('replaces the key of the highlighted provider and refreshes its models', async () => {
    const rig = makeProviderHost();
    await handleProviderCommand(rig.host);

    // Rows are [empty, acme, other(current), add]; one hop up lands on `acme`.
    press(rig.mounted[0]!, [UP, 'e']);

    await vi.waitFor(() => {
      expect(rig.mounted[1]).toBeInstanceOf(ApiKeyInputDialogComponent);
    });
    press(rig.mounted[1]!, [...typed('NEW_API_KEY'), ENTER]);

    await vi.waitFor(() => {
      expect(rig.host.harness.setConfig).toHaveBeenCalled();
    });
    // The stale key is replaced, not merged beside: `apiKeyEnv` would win over
    // `apiKey` and the edit would look like it silently did nothing.
    expect(rig.config.providers['acme']).toEqual({ type: 'openai', apiKey: 'NEW_API_KEY' });
    expect(rig.host.harness.setConfig.mock.calls.at(-1)![0]).toEqual(
      expect.objectContaining({
        providers: expect.objectContaining({
          acme: { type: 'openai', apiKey: 'NEW_API_KEY' },
        }),
      }),
    );

    // A key nobody verified would only surface on the next request, so the
    // models are re-read with it right away.
    await vi.waitFor(() => {
      expect(rig.spinnerStop).toHaveBeenCalledWith({ ok: true, label: 'acme key updated.' });
    });
    expect(rig.host.authFlow.refreshConfigAfterLogin).toHaveBeenCalled();
    expect(rig.host.showError).not.toHaveBeenCalled();
  });

  it('sends an account-backed provider to /login instead of typing a key', async () => {
    const rig = makeProviderHost();
    rig.config.providers['acme'] = {
      type: 'openai',
      oauth: { storage: 'file', key: 'kimi-code' },
    };
    await handleProviderCommand(rig.host);

    // Rows are [empty, acme, other(current), add]; one hop up lands on `acme`.
    press(rig.mounted[0]!, [UP, 'e']);

    await vi.waitFor(() => {
      expect(rig.host.showError).toHaveBeenCalledWith(expect.stringContaining('/login'));
    });
    // Its credential comes from the token store, so a hand-typed key would be
    // overwritten on the next token refresh — nothing is written.
    expect(rig.host.harness.setConfig).not.toHaveBeenCalled();
    expect(rig.mounted).toHaveLength(2);
    expect(rig.mounted[1]).toBeInstanceOf(ProviderManagerComponent);
  });

  it('lets a Kimi Platform row change its key like any other provider', async () => {
    const rig = makeProviderHost();
    rig.config.providers['moonshot-cn'] = { type: 'openai', apiKey: 'OLD' };
    rig.appState.availableProviders['moonshot-cn'] = { type: 'openai', apiKey: 'OLD' };
    await handleProviderCommand(rig.host);

    // Rows are [empty, acme, other(current), Kimi Platform, add]; one hop down
    // from the active row lands on the appended platform.
    press(rig.mounted[0]!, [DOWN, 'e']);

    // `/login` for a Kimi Platform is this same key prompt followed by a model
    // refresh, so refusing here would deny a change that works.
    await vi.waitFor(() => {
      expect(rig.mounted[1]).toBeInstanceOf(ApiKeyInputDialogComponent);
    });
    press(rig.mounted[1]!, [...typed('NEW_PLATFORM_KEY'), ENTER]);

    await vi.waitFor(() => {
      expect(rig.config.providers['moonshot-cn']).toEqual({
        type: 'openai',
        apiKey: 'NEW_PLATFORM_KEY',
      });
    });
    expect(rig.host.showError).not.toHaveBeenCalled();
  });

  it('ignores the key shortcut on the add row', async () => {
    const rig = makeProviderHost();
    await handleProviderCommand(rig.host);

    // One hop down from the active row lands on `[ Add New Platform ]`.
    press(rig.mounted[0]!, [DOWN, 'e']);

    expect(rig.mounted).toHaveLength(1);
    expect(rig.host.harness.setConfig).not.toHaveBeenCalled();
    expect(rig.host.showError).not.toHaveBeenCalled();
  });
});

describe('custom provider helpers', () => {
  it('derives the id from the hostname and avoids every taken id', () => {
    expect(deriveProviderId('https://api.example.com/v1', [])).toBe('api-example');
    expect(deriveProviderId('https://127.0.0.1:1234/v1', [])).toBe('127-0-0-1-1234');
    expect(deriveProviderId('https://api.example.com/v1', ['api-example'])).toBe(
      'api-example-2',
    );
    expect(deriveProviderId('https://api.example.com/v1', ['api-example', 'api-example-2'])).toBe(
      'api-example-3',
    );
    // A built-in id must never be shadowed by a custom row.
    expect(deriveProviderId('https://openrouter.ai/api/v1', ['openrouter'])).toBe(
      'openrouter-2',
    );
  });

  it('rejects a base URL that is unusable or carries the secret inline', () => {
    expect(parseProviderBaseUrl('   ')).toEqual({ ok: false, reason: 'cannot be empty.' });
    expect(parseProviderBaseUrl('not a url')).toEqual({
      ok: false,
      reason: '"not a url" is not a valid URL.',
    });
    expect(parseProviderBaseUrl('ftp://api.example.com')).toEqual({
      ok: false,
      reason: 'must be http(s), got "ftp:".',
    });
    expect(parseProviderBaseUrl('https://me:YOUR_API_KEY@api.example.com')).toEqual({
      ok: false,
      reason: 'must not embed a username or password.',
    });
    expect(parseProviderBaseUrl('  https://api.example.com/v1  ')).toEqual({
      ok: true,
      baseUrl: 'https://api.example.com/v1',
    });
  });

  it('sends no credential header only when no key was entered', () => {
    expect(buildCustomProviderRecord('https://api.example.com/v1', 'YOUR_API_KEY')).toEqual({
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'YOUR_API_KEY',
    });
    expect(buildCustomProviderRecord('http://localhost:11434/v1', undefined).authScheme).toEqual({
      kind: 'none',
    });
  });
});

/**
 * Host for `/context`. The write must land under `overrides`, never on the
 * declared record — the engine merges overrides over the record, so a top-level
 * write would be shadowed by the next provider refresh.
 */
function makeContextHost() {
  const appState = {
    model: 'other/thing',
    availableModels: {
      'acme/sonnet': { provider: 'acme', model: 'sonnet', maxContextSize: 200_000 },
      'other/thing': {
        provider: 'other',
        model: 'thing',
        maxContextSize: 200_000,
        overrides: { maxContextSize: 400_000 },
      },
    },
    availableProviders: { acme: { type: 'openai' }, other: { type: 'openai' } },
  };
  const mounted: (Component & Focusable)[] = [];
  const host = {
    state: { appState },
    mountEditorReplacement: vi.fn((panel: Component & Focusable) => {
      mounted.push(panel);
    }),
    restoreEditor: vi.fn(),
    harness: { setConfig: vi.fn(async () => ({})) },
    authFlow: { refreshConfigAfterLogin: vi.fn(async () => false) },
    track: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: { setConfig: ReturnType<typeof vi.fn> };
    track: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  return { host, mounted, appState };
}

describe('handleContextCommand', () => {
  it('writes the override for the active model when given only a size', async () => {
    const { host } = makeContextHost();

    await handleContextCommand(host, '200k');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      models: { 'other/thing': { overrides: { maxContextSize: 200_000 } } },
    });
    expect(host.authFlow.refreshConfigAfterLogin).toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('accepts k/M/underscore forms and a named model', async () => {
    const { host } = makeContextHost();

    await handleContextCommand(host, 'acme/sonnet 1.5m');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      models: { 'acme/sonnet': { overrides: { maxContextSize: 1_500_000 } } },
    });

    await handleContextCommand(host, 'acme/sonnet 128_000');
    expect(host.harness.setConfig).toHaveBeenLastCalledWith({
      models: { 'acme/sonnet': { overrides: { maxContextSize: 128_000 } } },
    });
  });

  it('restores the declared value on reset instead of deleting the override', async () => {
    const { host } = makeContextHost();

    await handleContextCommand(host, 'other/thing reset');

    // Config writes are deep merges, so an override can only be neutralised by
    // writing the declared number back through the same key.
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      models: { 'other/thing': { overrides: { maxContextSize: 200_000 } } },
    });
  });

  it('rejects an unknown alias and a non-numeric size without writing config', async () => {
    const { host } = makeContextHost();

    await handleContextCommand(host, 'nope/model 200k');
    await handleContextCommand(host, 'other/thing huge');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('nope/model'));
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('not a context window'));
    expect(host.harness.setConfig).not.toHaveBeenCalled();
  });

  it('no-ops when the size already matches the effective window', async () => {
    const { host } = makeContextHost();

    // `other/thing` already overrides to 400K.
    await handleContextCommand(host, 'other/thing 400k');

    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('400K'));
  });

  it('opens a picker and prompts for the model picked with Enter', async () => {
    const { host, mounted } = makeContextHost();

    await handleContextCommand(host, '');

    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toBeInstanceOf(ChoicePickerComponent);
    expect(mounted[0]!.render(80).join('\n')).toContain('thing (other)');

    // The list opens on the active model's row; one hop up lands on sonnet.
    press(mounted[0]!, [UP, ENTER]);

    expect(host.restoreEditor).toHaveBeenCalled();
    expect(mounted).toHaveLength(2);
    expect(mounted[1]).toBeInstanceOf(ApiKeyInputDialogComponent);
  });

  it('formats token counts with the K/M suffix', () => {
    expect(formatContextSize(200_000)).toBe('200K tokens');
    expect(formatContextSize(1_500_000)).toBe('1.5M tokens');
    expect(formatContextSize(137)).toBe('137 tokens');
  });

  it('parses the accepted size spellings and rejects the rest', () => {
    expect(parseContextSize('200000')).toBe(200_000);
    expect(parseContextSize('200k')).toBe(200_000);
    expect(parseContextSize(' 1M ')).toBe(1_000_000);
    expect(parseContextSize('1.5m')).toBe(1_500_000);
    expect(parseContextSize('128_000')).toBe(128_000);
    expect(parseContextSize('huge')).toBeUndefined();
    expect(parseContextSize('200kb')).toBeUndefined();
  });
});
