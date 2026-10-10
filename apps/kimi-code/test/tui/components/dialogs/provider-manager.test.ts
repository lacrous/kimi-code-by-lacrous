import type { ProviderConfig } from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '#/tui/components/dialogs/provider-manager';
import { darkColors } from '#/tui/theme/colors';

// Truecolor SGR fragments for the darkColors tokens we assert on
// (see theme/colors.ts). Forcing chalk.level below guarantees they appear.
const PRIMARY = '38;2;79;168;255'; // colors.primary  #4FA8FF
const MUTED = '38;2;107;107;107'; // colors.textMuted #6B6B6B
const BOLD = '[1m';
const ESC = String.fromCodePoint(27);

const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const ENTER = '\r';
const DOWN = `${ESC}[B`;

function rendered(component: ProviderManagerComponent, width = 120): string {
  return component.render(width).join('\n').replaceAll(SGR, '');
}

function makeComponent(overrides: Partial<ProviderManagerOptions> = {}): ProviderManagerComponent {
  return new ProviderManagerComponent({
    providers: {} as Record<string, ProviderConfig>,
    onAdd: vi.fn(),
    onSelectSource: vi.fn(),
    onDeleteSource: vi.fn(),
    onEditKey: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  });
}

function addRowLine(component: ProviderManagerComponent, width = 120): string | undefined {
  return component.render(width).find((line) => line.includes('Add New Platform'));
}

describe('ProviderManagerComponent', () => {
  let previousLevel: typeof chalk.level;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });

  it('renders [ Add New Platform ] in the brand color, never muted, when not selected', () => {
    // A configured provider occupies row 0 (selected); the add row sits below
    // it and is therefore not the highlighted row.
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
    });
    const line = addRowLine(component);
    expect(line).toBeDefined();
    expect(line).toContain(PRIMARY);
    expect(line).not.toContain(MUTED);
  });

  it('bolds [ Add New Platform ] when it is the selected row', () => {
    // With no configured providers the synthetic add row is the only row, so it
    // starts as the highlighted selection.
    const component = makeComponent();
    const line = addRowLine(component);
    expect(line).toBeDefined();
    expect(line).toContain(BOLD);
    expect(line).toContain(PRIMARY);
  });

  it('marks the active provider with the shared "← current" marker, not a bullet', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
    });
    const plain = component
      .render(120)
      .join('\n')
      .replaceAll(/\[[0-9;]*m/g, '');
    expect(plain).toContain('← current');
    expect(plain).not.toContain('●');
  });

  it('uses the same header shape as the model dialog (one top border, title, hint, no inner border)', () => {
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
    });
    const lines = component.render(120).map((l) => l.replaceAll(SGR, ''));
    const isBorder = (l: string | undefined): boolean => /^─+$/.test((l ?? '').trim());

    const titleIdx = lines.findIndex((l) => l.includes('Providers'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    // The line directly under the title is the hint, never an inner border (the
    // old `border · title · border` sandwich is gone).
    expect(isBorder(lines[titleIdx + 1])).toBe(false);
    expect(lines[titleIdx + 1]).toContain('navigate');
    expect(lines[titleIdx + 1]).toContain('Esc cancel');
    // Every verb the dialog binds must be advertised, or the key is a secret.
    expect(lines[titleIdx + 1]).toContain('Enter select');
    expect(lines[titleIdx + 1]).toContain('E edit key');
    expect(lines[titleIdx + 1]).toContain('D delete');
    // Blank line separates the hint from the body, exactly like the model dialog.
    expect(lines[titleIdx + 2]).toBe('');
    // Only the top and bottom full-width borders remain — two, not three.
    expect(lines.filter(isBorder).length).toBe(2);
  });

  it('deletes the highlighted provider via the D key with a y/N confirm', () => {
    const onDeleteSource = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
      onDeleteSource,
    });
    component.handleInput('D');
    expect(rendered(component)).toContain('[y/N]');
    component.handleInput('y');
    expect(onDeleteSource).toHaveBeenCalledWith(['acme']);
  });

  it('changes the API key of the highlighted provider via the E key, with no confirm step', () => {
    const onEditKey = vi.fn();
    const onDeleteSource = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
      onEditKey,
      onDeleteSource,
    });
    component.handleInput('E');
    expect(onEditKey).toHaveBeenCalledWith(['acme'], 'acme');
    // The masked key dialog is itself the confirmation — a [y/N] prompt would
    // only add ceremony.
    expect(rendered(component)).not.toContain('[y/N]');
    expect(onDeleteSource).not.toHaveBeenCalled();
  });

  it('passes every provider of a grouped custom-registry row to onEditKey', () => {
    // One registry fetch contributed several providers that all authenticate
    // with the same source key, so the new key must be written to all of them.
    const source = { kind: 'apiJson', url: 'https://reg.test/api.json', apiKey: 'k' };
    const onEditKey = vi.fn();
    const component = makeComponent({
      providers: {
        'reg-one': { baseUrl: 'https://reg.test/v1', source },
        'reg-two': { baseUrl: 'https://reg.test/v2', source },
      } as unknown as Record<string, ProviderConfig>,
      onEditKey,
    });
    component.handleInput('e');
    expect(onEditKey).toHaveBeenCalledWith(['reg-one', 'reg-two'], 'reg.test/api.json');
  });

  it('ignores the E key on [ Add New Platform ]', () => {
    const onEditKey = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
      onEditKey,
    });
    component.handleInput(DOWN);
    component.handleInput('E');
    expect(onEditKey).not.toHaveBeenCalled();
  });

  it('selects the highlighted provider on Enter', () => {
    const onSelectSource = vi.fn();
    const onAdd = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
      onSelectSource,
      onAdd,
    });
    component.handleInput(ENTER);
    expect(onSelectSource).toHaveBeenCalledWith(['acme'], 'acme');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('passes every provider of a grouped custom-registry row to onSelectSource', () => {
    // One row covers the whole `{url, apiKey}` source, so the picker must be
    // scoped to all of its providers, not just the first.
    const source = { kind: 'apiJson', url: 'https://reg.test/api.json', apiKey: 'k' };
    const onSelectSource = vi.fn();
    const component = makeComponent({
      providers: {
        'reg-one': { baseUrl: 'https://reg.test/v1', source },
        'reg-two': { baseUrl: 'https://reg.test/v2', source },
      } as unknown as Record<string, ProviderConfig>,
      onSelectSource,
    });
    expect(rendered(component)).not.toContain('reg-one');
    component.handleInput(ENTER);
    expect(onSelectSource).toHaveBeenCalledWith(
      ['reg-one', 'reg-two'],
      'reg.test/api.json',
    );
  });

  it('still opens the add flow when Enter lands on [ Add New Platform ]', () => {
    const onAdd = vi.fn();
    const onSelectSource = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      activeProviderId: 'acme',
      onAdd,
      onSelectSource,
    });
    component.handleInput(DOWN);
    component.handleInput(ENTER);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onSelectSource).not.toHaveBeenCalled();
  });

  it('closes on Esc', () => {
    const onClose = vi.fn();
    const component = makeComponent({
      providers: {
        acme: { baseUrl: 'https://acme.test' },
      } as unknown as Record<string, ProviderConfig>,
      onClose,
    });
    component.handleInput(ESC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
