/**
 * Masked single-line reader for secrets typed at a terminal.
 *
 * `kimi auth login` exists so a key never has to travel through argv, which
 * means it is read from the TTY instead. Raw mode is required rather than
 * optional: with the line discipline still on, the terminal echoes the key as
 * it is typed and also keeps it in its own scrollback, so masking only the
 * characters this process writes would still leak it into the place the user
 * copies keys from.
 */

interface SecretInputStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  setEncoding(encoding: BufferEncoding): void;
  on(event: 'data', listener: (chunk: string) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  off(event: 'data', listener: (chunk: string) => void): void;
  off(event: 'end', listener: () => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
}

export interface SecretPromptOutput {
  write(chunk: string): unknown;
}

export interface SecretPromptOptions {
  readonly prompt: string;
  readonly input?: SecretInputStream;
  readonly output?: SecretPromptOutput;
}

// Spelled as char codes so the control bytes stay visible in the source rather
// than sitting in the file as invisible characters.
const CTRL_C = String.fromCodePoint(3);
const CTRL_D = String.fromCodePoint(4);
const CTRL_H = String.fromCodePoint(8);
const BACKSPACE = String.fromCodePoint(127);
const SUBMIT_KEYS = new Set(['\r', '\n']);

function isSubmitKey(char: string): boolean {
  return SUBMIT_KEYS.has(char);
}

function isBackspaceKey(char: string): boolean {
  return char === BACKSPACE || char === CTRL_H;
}

/**
 * Reads one secret, echoing `*` per character. Resolves `undefined` when the
 * user aborts with Ctrl-C/Ctrl-D or closes the stream, so the caller can exit
 * quietly instead of storing an empty key that would read as "credential
 * present but wrong" at request time.
 */
export function readSecretFromTerminal(options: SecretPromptOptions): Promise<string | undefined> {
  const input = options.input ?? (process.stdin as SecretInputStream);
  const output = options.output ?? process.stdout;

  return new Promise((resolve) => {
    let value = '';
    let done = false;

    const finish = (result: string | undefined): void => {
      if (done) return;
      done = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      if (input.isTTY === true) input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      resolve(result);
    };

    function onData(chunk: string): void {
      for (const char of chunk) {
        if (isSubmitKey(char)) {
          finish(value);
          return;
        }
        if (char === CTRL_C || char === CTRL_D) {
          finish(undefined);
          return;
        }
        if (isBackspaceKey(char)) {
          if (value.length === 0) continue;
          value = value.slice(0, -1);
          // Echoed one `*` per accepted character, so erasing needs the same
          // back-space-then-overwrite dance a terminal would do itself.
          output.write('\b \b');
          continue;
        }
        value += char;
        output.write('*');
      }
    }

    function onEnd(): void {
      finish(value);
    }

    function onError(): void {
      finish(undefined);
    }

    output.write(options.prompt);
    input.setEncoding('utf-8');
    if (input.isTTY === true) input.setRawMode?.(true);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume();
  });
}