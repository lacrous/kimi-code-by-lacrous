import { Error2 } from '#/_base/errors/errors';

import { CONFIG_INVALID_ERROR_CODE } from '../contract/errors';

export type ProviderBaseUrlCheck =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly reason: string };

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
  '[::]',
]);

function isIpv4Literal(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function isPrivateIpv4(hostname: string): boolean {
  if (!isIpv4Literal(hostname)) return false;
  const [a, b] = hostname.split('.').map((part) => Number.parseInt(part, 10));
  if (a === undefined || b === undefined) return false;
  if (a === 10) return true;
  if (a === 172) return b >= 16 && b <= 31;
  if (a === 192) return b === 168;
  if (a === 169) return b === 254;
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = host.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const head = lower.split(':')[0] ?? '';
  if (head === '') return false;
  const group = Number.parseInt(head, 16);
  if (Number.isNaN(group)) return false;
  if ((group & 0xfe00) === 0xfc00) return true;
  return (group & 0xffc0) === 0xfe80;
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOCAL_HOSTNAMES.has(host) || host.endsWith('.localhost')) return true;
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}

export function checkProviderBaseUrl(raw: string): ProviderBaseUrlCheck {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'cannot be empty.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: `"${trimmed}" is not a valid URL.` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `must be http(s), got "${parsed.protocol}".` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      ok: false,
      reason: 'must not embed a username or password; put the key in api_key instead.',
    };
  }
  if (parsed.protocol === 'http:' && !isLocalHostname(parsed.hostname)) {
    return {
      ok: false,
      reason:
        'must use https for a non-local host; plain http is only allowed for loopback and private-network hosts such as localhost, 127.0.0.1 or 192.168.x.x.',
    };
  }

  return { ok: true, baseUrl: trimmed };
}

export function assertProviderBaseUrl(raw: string, field: string): string {
  const check = checkProviderBaseUrl(raw);
  if (!check.ok) {
    throw new Error2(CONFIG_INVALID_ERROR_CODE, `${field} ${check.reason}`);
  }
  return check.baseUrl;
}