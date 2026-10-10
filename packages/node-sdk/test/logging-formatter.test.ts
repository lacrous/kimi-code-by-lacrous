import { describe, expect, it } from 'vitest';

import { formatEntry, redactCtx } from '#/logging/formatter';
import type { LogEntry } from '#/logging/types';

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345';

function entry(overrides: Partial<LogEntry>): LogEntry {
  return {
    t: Date.UTC(2026, 0, 1),
    level: 'info',
    msg: 'hello',
    ...overrides,
  };
}

describe('formatEntry redaction', () => {
  it('masks a vendor key pasted into the log message', () => {
    const { text } = formatEntry(entry({ msg: `calling the provider with ${SECRET}` }));

    expect(text).not.toContain(SECRET);
    expect(text).toContain('sk-');
    expect(text).toMatch(/sk-\*+2345/);
  });

  it('masks an assigned secret in the log message', () => {
    const { text } = formatEntry(entry({ msg: 'api_key=sk-abcdefghijklmnopqrstuvwxyz012345' }));

    expect(text).toContain('api_key=[REDACTED]');
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('masks a bearer token in the log message', () => {
    const { text } = formatEntry(entry({ msg: 'Authorization: Bearer abcdefghijklmnop' }));

    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).toContain('Bearer ');
  });

  it('masks a vendor key in the error stack', () => {
    const { text } = formatEntry(entry({
      msg: 'request failed',
      error: { message: 'boom', stack: `Error: boom\n    at send (${SECRET})` },
    }));

    expect(text).not.toContain(SECRET);
  });

  it('masks a vendor key hidden inside a non-secret context value', () => {
    const { text } = formatEntry(entry({
      msg: 'done',
      ctx: { note: `retrying with ${SECRET}` },
    }));

    expect(text).not.toContain(SECRET);
  });

  it('redacts a context key that merely ends with a secret suffix', () => {
    expect(redactCtx({ myApiKey: 'anything' })).toEqual({ myApiKey: '[REDACTED]' });
  });

  it('leaves an ordinary message untouched', () => {
    const { text } = formatEntry(entry({ msg: 'session started for workspace example' }));

    expect(text).toContain('session started for workspace example');
  });
});
