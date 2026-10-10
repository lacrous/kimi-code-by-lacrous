/**
 * Masked terminal reader.
 *
 * The value of masking is entirely in what it never emits, so most cases assert
 * on the written output rather than the returned string: a reader that echoed
 * the key once would pass a return-value-only test.
 */

import { describe, expect, it } from 'vitest';

import { readSecretFromTerminal } from '#/utils/process/secret-input';

interface FakeStream {
  readonly isTTY: boolean;
  readonly chunks: string[];
  readonly rawMode: boolean[];
  readonly listeners: Map<string, Set<(...args: never[]) => void>>;
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
  setEncoding(encoding: BufferEncoding): void;
  on(event: string, listener: (...args: never[]) => void): void;
  off(event: string, listener: (...args: never[]) => void): void;
  emit(event: string, ...args: never[]): void;
  readonly listenerCount: number;
}

function makeStream(isTTY = true): FakeStream {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const rawMode: boolean[] = [];
  const stream: FakeStream = {
    isTTY,
    rawMode,
    listeners,
    chunks: [],
    get listenerCount() {
      return [...listeners.values()].reduce((total, set) => total + set.size, 0);
    },
    setRawMode: (mode) => rawMode.push(mode),
    resume: () => {},
    pause: () => {},
    setEncoding: () => {},
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
    emit: (event, ...args) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
  };
  return stream;
}

const CTRL_C = String.fromCodePoint(3);
const CTRL_D = String.fromCodePoint(4);
const BACKSPACE = String.fromCodePoint(127);

describe('readSecretFromTerminal', () => {
  it('returns the typed value and echoes only one mask per character', async () => {
    const input = makeStream();
    const output = { chunks: [] as string[], write: (chunk: string) => output.chunks.push(chunk) };

    const pending = readSecretFromTerminal({ prompt: 'key: ', input, output });
    input.emit('data', 'sk-1234' as never);
    input.emit('data', '\n' as never);

    await expect(pending).resolves.toBe('sk-1234');
    expect(output.chunks).toEqual(['key: ', '*', '*', '*', '*', '*', '*', '*', '\n']);
  });

  it('restores the line discipline and detaches every listener', async () => {
    const input = makeStream();
    const output = { write: () => true };

    const pending = readSecretFromTerminal({ prompt: '', input, output });
    input.emit('data', 'x\n' as never);
    await pending;

    expect(input.rawMode).toEqual([true, false]);
    expect(input.listenerCount).toBe(0);
  });

  it('never leaves the terminal in raw mode when the stream is not a TTY', async () => {
    const input = makeStream(false);
    const output = { write: () => true };

    const pending = readSecretFromTerminal({ prompt: '', input, output });
    input.emit('data', 'x\n' as never);

    await expect(pending).resolves.toBe('x');
    expect(input.rawMode).toEqual([]);
  });

  it('erases the mask when a backspace arrives', async () => {
    const input = makeStream();
    const output = { chunks: [] as string[], write: (chunk: string) => output.chunks.push(chunk) };

    const pending = readSecretFromTerminal({ prompt: '', input, output });
    input.emit('data', 'abc' as never);
    input.emit('data', BACKSPACE as never);
    input.emit('data', String.fromCodePoint(8) as never);
    input.emit('data', '\n' as never);

    await expect(pending).resolves.toBe('a');
    expect(output.chunks).toEqual(['', '*', '*', '*', '\b \b', '\b \b', '\n']);
  });

  it('ignores a backspace on an empty value instead of slicing past the start', async () => {
    const input = makeStream();
    const output = { chunks: [] as string[], write: (chunk: string) => output.chunks.push(chunk) };

    const pending = readSecretFromTerminal({ prompt: '', input, output });
    input.emit('data', BACKSPACE as never);
    input.emit('data', 'a\n' as never);

    await expect(pending).resolves.toBe('a');
    expect(output.chunks).toEqual(['', '*', '\n']);
  });

  it.each([CTRL_C, CTRL_D])('resolves undefined when the user aborts', async (control) => {
    const input = makeStream();
    const output = { write: () => true };

    const pending = readSecretFromTerminal({ prompt: '', input, output });
    input.emit('data', 'secret' as never);
    input.emit('data', control as never);
    input.emit('data', 'ignored' as never);

    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves undefined when the input errors', async () => {
    const input = makeStream();
    const output = { write: () => true };

    const pending = readSecretFromTerminal({ prompt: '', input, output });
    input.emit('error', new Error('EIO') as never);

    await expect(pending).resolves.toBeUndefined();
    expect(input.listenerCount).toBe(0);
  });

  it('keeps what was typed when the stream closes without a newline', async () => {
    const input = makeStream();
    const output = { write: () => true };

    const pending = readSecretFromTerminal({ prompt: '', input, output });
    input.emit('data', 'partial' as never);
    input.emit('end');

    await expect(pending).resolves.toBe('partial');
  });

  it('settles once even if the stream keeps emitting', async () => {
    const input = makeStream();
    const output = { write: () => true };

    const pending = readSecretFromTerminal({ prompt: '', input, output });
    input.emit('data', 'first\n' as never);
    input.emit('end');
    input.emit('data', 'second\n' as never);

    await expect(pending).resolves.toBe('first');
    expect(input.listenerCount).toBe(0);
  });
});