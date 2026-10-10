/**
 * Custom endpoint provider helpers — the "paste a base URL and a key" path.
 *
 * Author: lacrous (fork of MoonshotAI/kimi-code).
 *
 * Shared by the CLI (`kimi provider add-manual`) and the TUI `/provider` menu,
 * for the same reason `built-in-providers.ts` is shared: the URL rules and the
 * id a base URL resolves to must never be able to differ between the two
 * surfaces. Pure functions with no TUI-state dependency, so this lives at app
 * level (`src/utils`, not `src/tui/utils`).
 *
 * A custom provider is not a special kind of provider. It is exactly a built-in
 * whose wire and credential were supplied by hand instead of looked up, so the
 * record built here is the same shape a `BUILT_IN_PROVIDERS` entry writes — no
 * second config dialect for the runtime to understand.
 */

import type { ProviderConfig } from '@moonshot-ai/kimi-code-sdk';

import { KIMI_CODE_ALLOW_INSECURE_PROVIDER_HTTP_ENV } from '#/constant/app';

/**
 * Wire protocol assumed for a pasted endpoint.
 *
 * OpenAI Chat Completions is what effectively every gateway and self-hosted
 * server speaks — Ollama, llama.cpp, vLLM, LM Studio, LiteLLM, OpenRouter and
 * the rest — and the alternative is asking a user who already knows their base
 * URL to also know the protocol name. The choice is not hidden: it lands in
 * `providers.<id>.type` in config.toml where it stays editable, `kimi provider
 * add-manual --type` still takes it explicitly, and a gateway that speaks
 * something else is served by the models.dev catalog path instead.
 */
export const CUSTOM_PROVIDER_WIRE = 'openai';

/**
 * Outcome of validating a base URL. `reason` is a sentence *fragment*: the
 * subject is supplied by the caller, so the CLI prints `--base-url <reason>`
 * and the dialog prints `Base URL <reason>` from one set of messages.
 */
export type ProviderBaseUrlCheck =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly reason: string };

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4) return false;
  const values = octets.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (values.some((n) => !Number.isInteger(n) || n > 255)) return false;
  const [a, b] = values as [number, number, number, number];
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Whether an IPv6 host is inside the ranges that cannot be routed off the local
 * link: unique-local `fc00::/7` and link-local `fe80::/10`.
 *
 * Only the first hextet is examined, because both prefixes live entirely in its
 * high bits (`fc..`/`fd..` for ULA, `fe8..`–`feb.` for link-local), so there is
 * no reason to expand the address. An IPv4-mapped address is handed back to the
 * IPv4 test so the two paths cannot disagree.
 */
function isPrivateIpv6(hostname: string): boolean {
  const hextets = hostname.split('%')[0]?.split(':') ?? [];
  if (hextets.length < 2) return false;

  // `new URL` rewrites `::ffff:10.0.0.1` into the hex form `::ffff:a00:1`
  // before this ever sees it, so the last two hextets are reassembled into the
  // dotted quad the IPv4 test expects instead of teaching it a second notation.
  if (hextets[0] === '' && hextets[1] === '' && hextets[2] === 'ffff') {
    const high = Number.parseInt(hextets.at(-2) ?? '', 16);
    const low = Number.parseInt(hextets.at(-1) ?? '', 16);
    if (Number.isInteger(high) && Number.isInteger(low)) {
      return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'));
    }
  }

  const first = hextets[0];
  if (first === undefined || !/^[0-9a-f]{1,4}$/.test(first)) return false;
  const bits = Number.parseInt(first, 16);
  if ((bits & 0xfe00) === 0xfc00) return true;
  return (bits & 0xffc0) === 0xfe80;
}

/**
 * Whether a host is one where plaintext HTTP cannot leave the machine or the
 * local network: loopback, an RFC1918 / unique-local / link-local address, or a
 * name that resolves only through mDNS or the `.localhost` special-use suffix.
 */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replaceAll(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === '::') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.includes(':')) return isPrivateIpv6(host);
  return isPrivateIpv4(host);
}

/**
 * Validates a user-entered base URL.
 *
 * Rejects anything that is not http(s) and any URL carrying credentials — a
 * key pasted as `https://user:key@host` would otherwise be written verbatim
 * into config.toml and into every debug dump of it, which is strictly worse
 * than making the user paste it into the key field where it gets masked.
 *
 * `http://` is accepted only for a local host. A remote endpoint over plaintext
 * sends the key in a form anyone on the path can read, and the user is never
 * told that happened; `KIMI_CODE_ALLOW_INSECURE_PROVIDER_HTTP=1` restores it for
 * a self-hosted server this check cannot classify.
 */
export function parseProviderBaseUrl(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderBaseUrlCheck {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'cannot be empty.' };

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
    return { ok: false, reason: 'must not embed a username or password.' };
  }
  if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname)) {
    if (env[KIMI_CODE_ALLOW_INSECURE_PROVIDER_HTTP_ENV] !== '1') {
      return {
        ok: false,
        reason:
          `must be https, or http on a local host (${parsed.hostname} is neither). ` +
          `Set ${KIMI_CODE_ALLOW_INSECURE_PROVIDER_HTTP_ENV}=1 to allow it anyway.`,
      };
    }
  }
  return { ok: true, baseUrl: trimmed };
}

/**
 * Derives a provider id from a base URL, without ever asking the user for one.
 *
 * The hostname is the only part of a URL that reliably identifies the vendor,
 * so the id is built from it: `www` is dropped, the public suffix goes when it
 * looks like one (`api.example.com` → `api-example`), a non-default port is
 * kept because `localhost:11434` and `localhost:8080` are different servers,
 * and anything left over collapses to `-`.
 *
 * `taken` covers the ids already in use — configured providers and the
 * built-in table — so a custom row can never shadow `openai` or `cline` and
 * make the two configurations fight over one id.
 */
export function deriveProviderId(baseUrl: string, taken: readonly string[]): string {
  const base = idSlug(baseUrl);
  if (!taken.includes(base)) return base;

  let suffix = 2;
  while (taken.includes(`${base}-${String(suffix)}`)) suffix++;
  return `${base}-${String(suffix)}`;
}

/**
 * Builds the config record for a custom endpoint.
 *
 * A keyless endpoint (a local server, a LAN box) must not send a credential at
 * all. Left unset, the OpenAI-compatible client substitutes the literal
 * `unused` as the key and sends `Authorization: Bearer unused`; the `none` auth
 * scheme suppresses that header instead.
 */
export function buildCustomProviderRecord(
  baseUrl: string,
  apiKey: string | undefined,
): ProviderConfig {
  return {
    type: CUSTOM_PROVIDER_WIRE,
    baseUrl,
    apiKey,
    authScheme: apiKey === undefined ? { kind: 'none' } : undefined,
  };
}

function idSlug(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return 'custom';
  }

  const labels = parsed.hostname.toLowerCase().split('.').filter((label) => label !== 'www');
  // `example.com` / `router.bynara.id` lose their last label: a trailing
  // alphabetic label is the public suffix, not part of the vendor's name. An
  // IP or a bare host has no such label and keeps everything — otherwise
  // `127.0.0.1` would collapse to `127`.
  const host =
    labels.length > 1 && /^[a-z]+$/.test(labels.at(-1) ?? '')
      ? labels.slice(0, -1)
      : labels;
  const parts = parsed.port === '' ? host : [...host, parsed.port];

  const slug = parts
    .join('-')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' ? 'custom' : slug;
}