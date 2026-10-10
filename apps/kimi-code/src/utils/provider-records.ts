/**
 * Provider records as they cross the two boundaries where they are easy to get
 * wrong: being written to config.toml, and being printed to stdout.
 *
 * Both hazards come from the same shape. A provider record mixes ordinary
 * settings with the one field that must never leave the machine, and every
 * mutation of it — replacing a key, pointing at an env var, signing out — is
 * written as a *full* record rather than a field, because the surrounding
 * record has to survive intact.
 *
 *   Writing: `harness.setConfig` deep-merges, so a key absent from the patch
 *   keeps whatever the file already holds. A record rebuilt without the field it
 *   is dropping therefore goes back to disk unchanged, and the runtime rejects a
 *   provider carrying both `api_key` and `api_key_env`
 *   (`provider-credential.ts` → `kind: 'conflict'`). The command prints
 *   "Updated", and the provider stops working. Writing needs REPLACE semantics.
 *
 *   Printing: `kimi provider list --json` serialises the records as stored, so
 *   the inline key lands in a terminal scrollback buffer, a pipe, a CI log, and
 *   a shell redirect that outlives the session.
 *
 * Author: lacrous (fork of MoonshotAI/kimi-code).
 */

import type { KimiConfig, KimiHarness } from '@moonshot-ai/kimi-code-sdk';

/**
 * Writes the complete `providers` map with replace semantics.
 *
 * Pass the whole map, not just the record that changed: the section is replaced
 * wholesale, so a partial map would drop every provider it omits.
 */
export async function writeProviderRecords(
  harness: KimiHarness,
  providers: KimiConfig['providers'],
): Promise<void> {
  await harness.replaceConfigSections({ providers });
}

/**
 * Field names whose string value is a secret, compared after folding `_` and
 * `-` out so `api_key`, `apiKey` and `api-key` are one rule rather than three.
 * Deliberately narrower than "anything that looks long": a provider record also
 * carries base URLs and model ids, and blanking those would make the output
 * useless for its actual job.
 */
const SECRET_FIELD = new Set(['apikey', 'token', 'accesstoken', 'refreshtoken', 'secret', 'password']);

/** Header maps carry credentials under whatever name the vendor chose. */
const SECRET_CONTAINER = new Set(['customheaders', 'headers']);

/**
 * Masks a secret for display: the shape stays recognisable, the value does not.
 * Short values are starred whole — a mask that reveals 7 of an 8-character
 * secret reveals the secret.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(Math.max(value.length, 4));
  return `${value.slice(0, 3)}${'*'.repeat(8)}${value.slice(-4)}`;
}

/**
 * Deep-copies provider records with every secret masked.
 *
 * Walks the whole record rather than a fixed field list because `source` is
 * `record<string, any>`: an imported registry document nests its key at a depth
 * this module cannot know in advance.
 */
export function redactProviderSecrets<T>(value: T): T {
  return redactValue(value, undefined) as T;
}

function redactValue(value: unknown, fieldName: string | undefined): unknown {
  if (typeof value === 'string') {
    if (fieldName === undefined) return value;
    const folded = fieldName.replaceAll(/[_-]/g, '').toLowerCase();
    return SECRET_FIELD.has(folded) ? maskSecret(value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, fieldName));
  if (value === null || typeof value !== 'object') return value;

  const container = fieldName !== undefined && SECRET_CONTAINER.has(
    fieldName.replaceAll(/[_-]/g, '').toLowerCase(),
  );
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = container ? maskIfString(entry) : redactValue(entry, key);
  }
  return out;
}

/** Under a header map every string is a header value, and any of them may be the credential. */
function maskIfString(value: unknown): unknown {
  return typeof value === 'string' ? maskSecret(value) : redactValue(value, undefined);
}