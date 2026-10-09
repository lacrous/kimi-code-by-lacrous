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

/**
 * Validates a user-entered base URL.
 *
 * Rejects anything that is not http(s) and any URL carrying credentials — a
 * key pasted as `https://user:key@host` would otherwise be written verbatim
 * into config.toml and into every debug dump of it, which is strictly worse
 * than making the user paste it into the key field where it gets masked.
 */
export function parseProviderBaseUrl(raw: string): ProviderBaseUrlCheck {
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