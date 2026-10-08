/**
 * `/context` — the context window a model is allowed to fill.
 *
 * The value lands in `models.<alias>.overrides.maxContextSize` (written to
 * config.toml as `overrides.max_context_size`), not the record's own
 * `maxContextSize`: the engine merges `overrides` over the declared record, so
 * a top-level write would be permanently shadowed by the next provider
 * refresh. Everything downstream of the config — compaction thresholds, the
 * footer usage meter, the completion-token cap — reads the merged record, so
 * one write is enough.
 *
 * "reset" cannot delete the override, because config writes are deep merges;
 * it writes the declared `maxContextSize` back, which is behaviourally
 * identical to having no override at all.
 */
import { SECONDARY_DERIVED_MODEL_ALIAS } from '@moonshot-ai/kimi-code-sdk';

import {
  ApiKeyInputDialogComponent,
  type ApiKeyInputResult,
} from '../components/dialogs/api-key-input-dialog';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { modelDisplayName, providerDisplayName } from '../components/dialogs/model-selector';
import { formatErrorMessage } from '../utils/event-payload';
import { effectiveModelForHost } from './config';
import type { SlashCommandHost } from './dispatch';

const CONTEXT_SIZE_PATTERN = /^(\d[\d_]*(?:\.\d+)?)([kmg]?)$/i;

const SIZE_MULTIPLIERS: Record<string, number> = {
  '': 1,
  k: 1_000,
  m: 1_000_000,
  g: 1_000_000_000,
};

export function parseContextSize(raw: string): number | undefined {
  const match = CONTEXT_SIZE_PATTERN.exec(raw.trim());
  if (match === null) return undefined;
  const suffix = (match[2] ?? '').toLowerCase();
  const multiplier = SIZE_MULTIPLIERS[suffix];
  if (multiplier === undefined) return undefined;
  const value = Number((match[1] ?? '').replaceAll('_', '')) * multiplier;
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

export function formatContextSize(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${String(tokens / 1_000_000)}M tokens`;
  if (tokens >= 1_000) return `${String(tokens / 1_000)}K tokens`;
  return `${String(tokens)} tokens`;
}

export async function handleContextCommand(host: SlashCommandHost, args: string): Promise<void> {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    showContextPicker(host);
    return;
  }

  const parts = trimmed.split(/\s+/);
  const head = parts[0] ?? '';
  const isValue = parseContextSize(head) !== undefined || head.toLowerCase() === 'reset';
  // A lone token is read as a value for the current model; naming a model
  // needs a second token (`/context kimi/k2 200k`) so `200k` never has to be
  // guessed between the two readings.
  if (parts.length === 1 || isValue) {
    await applyContextSize(host, host.state.appState.model, trimmed);
    return;
  }
  await applyContextSize(host, head, parts.slice(1).join(' '));
}

function showContextPicker(host: SlashCommandHost): void {
  const models = host.state.appState.availableModels;
  const options = Object.entries(models)
    .filter(([alias]) => alias !== SECONDARY_DERIVED_MODEL_ALIAS)
    .map(([alias, model]): ChoiceOption => {
      const effective = effectiveModelForHost(host, model);
      const overridden = model.overrides?.maxContextSize !== undefined;
      const window = effective.maxContextSize;
      return {
        value: alias,
        label: `${modelDisplayName(alias, effective)} (${providerDisplayName(effective.provider)})`,
        description:
          window === undefined
            ? 'No context window declared'
            : `${formatContextSize(window)}${overridden ? ' · overridden' : ''}`,
        descriptionTone: overridden ? 'warning' : undefined,
      };
    })
    .toSorted((a, b) => a.label.localeCompare(b.label));

  if (options.length === 0) {
    host.showNotice(
      'No models configured',
      'Run /login to sign in to Kimi, or /provider to add another provider from a model catalog.',
    );
    return;
  }

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Set a context window',
      searchable: true,
      options,
      currentValue: host.state.appState.model,
      onSelect: (alias) => {
        host.restoreEditor();
        promptContextSize(host, alias);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function promptContextSize(host: SlashCommandHost, alias: string): void {
  const declared = host.state.appState.availableModels[alias]?.maxContextSize;
  const dialog = new ApiKeyInputDialogComponent(
    alias,
    [
      declared === undefined
        ? 'Tokens this model may fill before compaction kicks in.'
        : `Declared as ${formatContextSize(declared)} in config.toml.`,
      'Enter a token count: 200000, 200k or 1M. Leave it blank to reset.',
    ],
    (result: ApiKeyInputResult) => {
      host.restoreEditor();
      if (result.kind !== 'ok') return;
      void applyContextSize(host, alias, result.value);
    },
    {
      title: `Context window for ${alias}`,
      mask: false,
      allowEmpty: true,
      emptyHint: 'Enter a token count, or leave it blank to reset.',
    },
  );
  host.mountEditorReplacement(dialog);
}

async function applyContextSize(
  host: SlashCommandHost,
  alias: string,
  raw: string,
): Promise<void> {
  const base = host.state.appState.availableModels[alias];
  if (base === undefined) {
    host.showError(
      alias.length === 0
        ? 'No model selected. Run /model to select one first.'
        : `Unknown model alias: ${alias}`,
    );
    return;
  }

  const text = raw.trim();
  const isReset = text.length === 0 || text.toLowerCase() === 'reset';
  let target: number | undefined;
  if (!isReset) {
    target = parseContextSize(text);
    if (target === undefined) {
      host.showError(
        `"${text}" is not a context window — use a token count like 200000, 200k or 1M, or "reset".`,
      );
      return;
    }
  } else if (base.maxContextSize === undefined) {
    host.showError(`Model ${alias} declares no context window to reset to.`);
    return;
  }

  const next = target ?? base.maxContextSize;
  if (!isReset && effectiveModelForHost(host, base).maxContextSize === next) {
    host.showStatus(`${alias} already uses ${formatContextSize(next)}.`);
    return;
  }

  try {
    await host.harness.setConfig({
      models: { [alias]: { overrides: { maxContextSize: next } } },
    });
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(`Failed to set the context window: ${formatErrorMessage(error)}`);
    return;
  }

  host.track('context_window_set', { model: alias, max_context_size: next, reset: isReset });
  host.showStatus(
    isReset
      ? `Context window for ${alias} reset to ${formatContextSize(next)}.`
      : `Context window for ${alias} set to ${formatContextSize(next)}. Compaction and the usage meter follow it.`,
    'success',
  );
}