import {
  REDACT_MAX_DEPTH,
  redactSecretString,
  redactSecrets,
} from '#/human/credentials/redaction';

import type { LogContext, LogEntry, LogEntryError } from './log';

export const MSG_MAX_CHARS = 200;
export const CTX_VALUE_MAX_CHARS = 2048;
export const STACK_MAX_BYTES = 2048;
export const ENTRY_MAX_BYTES = 4096;
export { REDACT_MAX_DEPTH };

const SAFE_KEY_RE = /^[\w.-]+$/;
const ELLIPSIS = '…';
const TRUNCATED_TAIL = ` …truncated`;

const LEVEL_LABEL: Record<Exclude<LogEntry['level'], never>, string> = {
  error: 'ERROR',
  warn: 'WARN ',
  info: 'INFO ',
  debug: 'DEBUG',
};

const ANSI_LEVEL: Record<Exclude<LogEntry['level'], never>, string> = {
  error: '[31m',
  warn: '[33m',
  info: '[36m',
  debug: '[90m',
};
const ANSI_RESET = '[0m';

export function redactCtx(ctx: LogContext): LogContext {
  return redactSecrets(ctx) as LogContext;
}

export interface FormatOptions {
  readonly ansi?: boolean;
  readonly omitContextKeys?: readonly string[];
}

export interface FormattedEntry {
  readonly text: string;
  readonly dropped: boolean;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + ELLIPSIS;
}

function serializeValue(raw: unknown): string {
  if (typeof raw === 'string') return redactSecretString(raw);
  if (raw === undefined) return 'undefined';
  if (raw === null) return 'null';
  if (
    typeof raw === 'number' ||
    typeof raw === 'boolean' ||
    typeof raw === 'bigint' ||
    typeof raw === 'symbol'
  ) {
    return String(raw);
  }
  try {
    const json = JSON.stringify(raw);
    if (json !== undefined) return json;
  } catch {
  }
  if (typeof raw === 'function') return raw.name === '' ? '[Function]' : `[Function: ${raw.name}]`;
  return Object.prototype.toString.call(raw);
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

function formatPair(key: string, raw: unknown): string {
  const limited = truncate(serializeValue(raw), CTX_VALUE_MAX_CHARS);
  const renderedKey = SAFE_KEY_RE.test(key) ? key : quote(key);
  const renderedVal = /[\s="\\]/.test(limited) || limited.length === 0 ? quote(limited) : limited;
  return `${renderedKey}=${renderedVal}`;
}

function clipBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (
      Buffer.byteLength(text.slice(0, mid), 'utf-8') <=
      maxBytes - Buffer.byteLength(TRUNCATED_TAIL, 'utf-8')
    ) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + TRUNCATED_TAIL;
}

function clipStack(stack: string): string {
  if (Buffer.byteLength(stack, 'utf-8') <= STACK_MAX_BYTES) return stack;
  return clipBytes(stack, STACK_MAX_BYTES);
}

function indentStack(stack: string): string {
  return stack
    .split('\n')
    .map((line, i) => (i === 0 ? `  ${line}` : `    ${line.trimStart()}`))
    .join('\n');
}

export function formatEntry(entry: LogEntry, options: FormatOptions = {}): FormattedEntry {
  const ctx = entry.ctx ? redactCtx(entry.ctx) : undefined;
  const omitContextKeys = new Set(options.omitContextKeys ?? []);
  const msg = truncate(redactSecretString(entry.msg), MSG_MAX_CHARS);
  const pairs: string[] = [];
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      if (omitContextKeys.has(k)) continue;
      if (v !== undefined) pairs.push(formatPair(k, v));
    }
  }

  const time = new Date(entry.t).toISOString();
  const label = LEVEL_LABEL[entry.level];
  const rendered = pairs.length === 0
    ? `${time} ${label} ${msg}`
    : `${time} ${label} ${msg}  ${pairs.join(' ')}`;

  let head = Buffer.byteLength(rendered, 'utf-8') > ENTRY_MAX_BYTES
    ? clipBytes(rendered, ENTRY_MAX_BYTES)
    : rendered;

  if (options.ansi === true) {
    head = `${ANSI_LEVEL[entry.level]}${head}${ANSI_RESET}`;
  }

  if (entry.error?.stack) {
    head = `${head}\n${indentStack(clipStack(redactSecretString(entry.error.stack)))}`;
  } else if (entry.error?.message) {
    head = `${head}\n  Error: ${redactSecretString(entry.error.message)}`;
  }

  return { text: head, dropped: false };
}

export function extractError(value: Error): LogEntryError {
  return typeof value.stack === 'string'
    ? { message: value.message, stack: value.stack }
    : { message: value.message };
}
