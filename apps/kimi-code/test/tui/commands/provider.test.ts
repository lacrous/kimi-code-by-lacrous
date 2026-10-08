/**
 * Scenario: /provider post-add default-model selection.
 * Responsibilities: the picked effort is gated for persistence by the model's
 * effective default, and a session-only pick is still applied to the runtime
 * after the config refresh (which only reactivates from persisted values).
 * Wiring: real setDefaultModel with the harness/authFlow boundaries stubbed by
 * a small host rig.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/provider.test.ts
 */
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
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
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';

const ESC = String.fromCodePoint(27);
const ENTER = '\r';
const UP = `${ESC}[A`;

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
    availableProviders: {
      empty: { type: 'openai' },
      acme: { type: 'openai' },
      other: { type: 'openai' },
    },
  };
  const mounted: (Component & Focusable)[] = [];
  const host = {
    state: { appState },
    waitForLazyCreation: vi.fn(async () => {}),
    mountEditorReplacement: vi.fn((panel: Component & Focusable) => {
      mounted.push(panel);
    }),
    restoreEditor: vi.fn(),
    harness: { setConfig: vi.fn(async () => ({})) },
    authFlow: {
      refreshConfigAfterLogin: vi.fn(async () => false),
      activateModelAfterLogin: vi.fn(async () => false),
    },
    track: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: { setConfig: ReturnType<typeof vi.fn> };
    restoreEditor: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  return { host, mounted };
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
    expect(mounted[0]!.render().join('\n')).toContain('thing (other)');

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
