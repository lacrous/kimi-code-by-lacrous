export const REDACTED = '[REDACTED]';
export const REDACT_MAX_DEPTH = 10;

const MASK_CHAR = '*';
const VISIBLE_TAIL_CHARS = 4;
const REDACTED_DEPTH = '[REDACTED:depth]';
const REDACTED_CYCLE = '[REDACTED:cycle]';

const SECRET_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'proxyauthorization',
  'apikey',
  'xapikey',
  'apisecret',
  'secretkey',
  'clientsecret',
  'privatekey',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'sessiontoken',
  'bearer',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'credential',
  'credentials',
]);

const SECRET_KEY_SUFFIXES: readonly string[] = [
  'apikey',
  'authorization',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'sessiontoken',
  'clientsecret',
  'apisecret',
  'secretkey',
  'privatekey',
  'password',
  'cookie',
];

const ASSIGNED_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(authorization\s*[:=]\s*bearer\s+)[^\s"'`]+/gi,
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret|client[_-]?secret)\s*[:=]\s*)[^\s"'`]+/gi,
  /\b(cookie\s*[:=]\s*)[^\r\n]+/gi,
];

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b((?:sk|pk|ak|xai)-)([A-Za-z0-9_-]{16,})/g,
  /\b((?:gh[pousr]|gsk)_)([A-Za-z0-9]{16,})/g,
  /\b(github_pat_)([A-Za-z0-9_]{16,})/g,
  /\b(xox[baprs]-)([A-Za-z0-9-]{10,})/g,
  /\b(AIza)([A-Za-z0-9_-]{20,})/g,
  /\b(eyJ)([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,})/g,
];

const BEARER_VALUE_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[_\-.]/g, '');
}

function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SECRET_KEYS.has(normalized) || SECRET_KEY_SUFFIXES.some((s) => normalized.endsWith(s));
}

function maskSecretValue(value: string): string {
  const hidden = Math.max(value.length - VISIBLE_TAIL_CHARS, 0);
  return MASK_CHAR.repeat(hidden) + value.slice(-VISIBLE_TAIL_CHARS);
}

export function redactSecretString(value: string): string {
  let out = value;
  for (const pattern of ASSIGNED_SECRET_PATTERNS) {
    out = out.replace(pattern, `$1${REDACTED}`);
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(
      pattern,
      (_match, prefix: string, secret: string) => `${prefix}${maskSecretValue(secret)}`,
    );
  }
  return out.replace(
    BEARER_VALUE_PATTERN,
    (_match, prefix: string, secret: string) => `${prefix}${maskSecretValue(secret)}`,
  );
}

export function redactSecrets(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (current: unknown, depth: number): unknown => {
    if (depth > REDACT_MAX_DEPTH) return REDACTED_DEPTH;
    if (current === null || typeof current !== 'object') {
      return typeof current === 'string' ? redactSecretString(current) : current;
    }
    if (seen.has(current)) return REDACTED_CYCLE;
    seen.add(current);
    if (Array.isArray(current)) {
      return current.map((item) => walk(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(current)) {
      out[key] = isSecretKey(key) ? REDACTED : walk(nested, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}