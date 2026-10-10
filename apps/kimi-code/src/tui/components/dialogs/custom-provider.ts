/**
 * CustomProviderDialog — blue rounded box that collects a base URL, an
 * optional API key, and an authentication scheme for a provider the user
 * points at by hand.
 *
 * Geometry mirrors `CustomRegistryImportDialogComponent` so the chrome stays
 * consistent with the registry-import and API-key login flows. Three fields,
 * switched with Tab / Shift-Tab / Up / Down; Enter advances to the next field
 * (and submits on the last one), Esc cancels. The base URL is validated as it
 * is typed, so a typo is corrected in place instead of surfacing as an error
 * after the dialog has closed. Only the URL is required — a local server needs
 * no credential, and the scheme defaults to `none` when the key is empty.
 */

import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { parseProviderBaseUrl } from '#/utils/custom-provider';

export interface CustomProviderValue {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly authScheme?: { readonly kind: 'bearer' | 'api-key' | 'custom-header' | 'none'; readonly header?: string };
}

export type CustomProviderResult =
  | { readonly kind: 'ok'; readonly value: CustomProviderValue }
  | { readonly kind: 'cancel' };

const TITLE = 'Add a custom provider';
const SUBTITLE_DEFAULT =
  'Any OpenAI-compatible endpoint. Models are read from its /models route.';
const FOOTER_NOT_LAST = 'Tab / ↑↓ to switch  ·  Enter for next field  ·  Esc to cancel';
const FOOTER_LAST = 'Tab / ↑↓ to switch  ·  Enter to submit  ·  Esc to cancel';

const URL_LABEL = 'Base URL';
const KEY_LABEL = 'API key (optional)';
const AUTH_LABEL = 'Authentication';

type FieldId = 'url' | 'key' | 'auth';

type AuthKind = 'bearer' | 'api-key' | 'custom-header' | 'none';

const AUTH_OPTIONS: readonly {
  readonly kind: AuthKind;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    kind: 'bearer',
    label: 'Bearer token',
    description: 'Sends Authorization: Bearer <key>.',
  },
  {
    kind: 'api-key',
    label: 'API key',
    description: 'Sends the key in the x-api-key header.',
  },
  {
    kind: 'custom-header',
    label: 'Custom header',
    description: 'Sends the key in a header you name.',
  },
  {
    kind: 'none',
    label: 'None',
    description: 'Sends no credential.',
  },
];

export class CustomProviderDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly urlInput = new Input();
  private readonly keyInput = new Input();
  private readonly onDone: (result: CustomProviderResult) => void;
  private activeField: FieldId = 'url';
  private done = false;
  private urlHint: string | undefined;
  private authIndex = 0;
  private authHeader = '';

  constructor(onDone: (result: CustomProviderResult) => void, defaultBaseUrl: string = '') {
    super();
    this.onDone = onDone;
    if (defaultBaseUrl.length > 0) this.urlInput.setValue(defaultBaseUrl);
    this.urlInput.onSubmit = () => {
      this.focusNextField(1);
    };
    this.keyInput.onSubmit = () => {
      this.focusNextField(1);
    };
    // The auth row is not an Input; Enter on it submits the dialog.
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
      this.toggleField();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.focusNextField(1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.focusNextField(-1);
      return;
    }
    if (this.activeField === 'auth' && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
      this.cycleAuth(matchesKey(data, Key.right) ? 1 : -1);
      return;
    }
    if (this.activeField === 'auth' && matchesKey(data, Key.enter)) {
      this.handleSubmit();
      return;
    }

    this.urlHint = undefined;

    if (this.activeField === 'url') {
      this.urlInput.handleInput(data);
    } else if (this.activeField === 'key') {
      this.keyInput.handleInput(data);
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.urlInput.invalidate();
    this.keyInput.invalidate();
  }

  override render(width: number): string[] {
    const dialogActive = this.focused && !this.done;
    this.urlInput.focused = dialogActive && this.activeField === 'url';
    this.keyInput.focused = dialogActive && this.activeField === 'key';

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('primary', s);
    const titleStyled = currentTheme.boldFg('textStrong', TITLE);
    const subtitleText = this.subtitle();
    const subtitleStyled = currentTheme.fg('textDim', subtitleText);
    const footerStyled = currentTheme.fg(
      'textDim',
      this.activeField === 'url' ? FOOTER_NOT_LAST : FOOTER_LAST,
    );

    const urlLabelStyled = this.labelFor(URL_LABEL, this.activeField === 'url');
    const keyLabelStyled = this.labelFor(KEY_LABEL, this.activeField === 'key');
    const authLabelStyled = this.labelFor(AUTH_LABEL, this.activeField === 'auth');

    const titleLine = truncateToWidth(titleStyled, innerWidth, '…');
    const subtitleLine = truncateToWidth(subtitleStyled, innerWidth, '…');
    const footerLine = truncateToWidth(footerStyled, innerWidth, '…');
    const urlLabelLine = truncateToWidth(urlLabelStyled, innerWidth, '…');
    const keyLabelLine = truncateToWidth(keyLabelStyled, innerWidth, '…');
    const authLabelLine = truncateToWidth(authLabelStyled, innerWidth, '…');
    const urlInputLine = this.urlInput.render(innerWidth)[0] ?? '> ';
    const rawKeyInputLine = this.keyInput.render(innerWidth)[0] ?? '> ';
    const keyInputLine = maskInputLine(rawKeyInputLine);
    const authInputLine = this.renderAuthLine(innerWidth);

    const contentLines: string[] = [
      titleLine,
      '',
      subtitleLine,
      '',
      urlLabelLine,
      urlInputLine,
      '',
      keyLabelLine,
      keyInputLine,
      '',
      authLabelLine,
      authInputLine,
      '',
      footerLine,
    ];

    if (safeWidth < 4) {
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '…'))];
    }

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      const vis = visibleWidth(content);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private subtitle(): string {
    if (this.urlHint !== undefined) return `Base URL ${this.urlHint}`;
    return SUBTITLE_DEFAULT;
  }

  private labelFor(label: string, active: boolean): string {
    return active ? currentTheme.boldFg('accent', label) : currentTheme.fg('textDim', label);
  }

  private toggleField(): void {
    this.focusNextField(this.activeField === 'url' ? 1 : -1);
  }

  private focusNextField(direction: 1 | -1): void {
    const order: FieldId[] = ['url', 'key', 'auth'];
    const idx = order.indexOf(this.activeField);
    if (idx === -1) return;
    const next = idx + direction;
    if (next < 0 || next >= order.length) return;
    this.urlHint = undefined;
    this.activeField = order[next]!;
  }

  private cycleAuth(direction: 1 | -1): void {
    const next = this.authIndex + direction;
    if (next < 0 || next >= AUTH_OPTIONS.length) return;
    this.authIndex = next;
  }

  private renderAuthLine(width: number): string {
    const active = this.activeField === 'auth';
    const prefix = active ? '> ' : '  ';
    const item = AUTH_OPTIONS[this.authIndex];
    if (!item) return prefix;
    const label = `${item.label} — ${item.description}`;
    const line = prefix + label;
    return truncateToWidth(
      active ? currentTheme.boldFg('accent', line) : currentTheme.fg('textDim', line),
      width,
      '…',
    );
  }

  private handleSubmit(): void {
    if (this.done) return;

    const check = parseProviderBaseUrl(this.urlInput.getValue());
    if (!check.ok) {
      this.urlHint = check.reason;
      this.activeField = 'url';
      return;
    }

    const key = this.keyInput.getValue().trim();
    const chosen = AUTH_OPTIONS[this.authIndex];
    if (!chosen) return;
    const scheme =
      chosen.kind === 'none' || key.length === 0
        ? { kind: 'none' as const }
        : chosen.kind === 'custom-header'
          ? { kind: 'custom-header' as const, header: this.authHeader.trim() || 'x-api-key' }
          : { kind: chosen.kind };
    this.done = true;
    this.onDone({
      kind: 'ok',
      value: {
        baseUrl: check.baseUrl,
        apiKey: key.length > 0 ? key : undefined,
        authScheme: scheme,
      },
    });
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}

/**
 * Renders an `Input` line with every visible character replaced by `•`, so a
 * pasted key is never readable on screen. Trailing padding stays a space (it
 * is the visible gutter of the row, not content), and ANSI escape sequences —
 * the reverse-video cursor above the caret above all — pass through untouched
 * so masking cannot corrupt the line.
 */
function maskInputLine(raw: string): string {
  const prefix = '> ';
  if (!raw.startsWith(prefix)) return raw;

  let end = raw.length;
  while (end > prefix.length && raw[end - 1] === ' ') {
    end--;
  }
  const padding = raw.slice(end);
  const content = raw.slice(prefix.length, end);

  const parts = content.split(/(\u001B(?:\[[0-9;]*m|_pi:c\u0007))/);
  const maskedContent = parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replaceAll(/[^ ]/g, '•');
    })
    .join('');

  return prefix + maskedContent + padding;
}