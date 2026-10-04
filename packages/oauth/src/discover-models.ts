/**
 * Model discovery for hand-written OpenAI-compatible providers.
 *
 * Author: lacrous (fork of MoonshotAI/kimi-code).
 *
 * A provider the user typed into `config.toml` by hand (`type: 'openai'` plus
 * `base_url`, no registry `source`) has no metadata source of its own, so its
 * model list must be read from the endpoint. This is the same `GET {baseUrl}/models`
 * probe the managed-endpoint branch uses, generalized to any host the user
 * declared — with the auth-error wording rewritten, because "your OAuth
 * credentials were rejected" is wrong for a user-supplied API key.
 *
 * Metadata the endpoint does not declare (context window, capabilities) is
 * filled with the same conservative defaults the custom-registry import uses,
 * so a discovered alias is always usable even when `/models` returns bare ids.
 */

import { readApiErrorMessage } from './api-error';
import {
  CUSTOM_REGISTRY_DEFAULT_CAPABILITIES,
  CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT,
} from './custom-registry';
import type { ManagedKimiModelAlias } from './managed-kimi-code';
import { CUSTOM_REGISTRY_MODEL_FIELDS, mergeRefreshedModelAlias } from './model-alias-merge';
import { isRecord } from './utils';

/**
 * One model as reported by an OpenAI-compatible `/models` endpoint. Every
 * field except `id` is optional: a bare `{ id }` row is the common case, and
 * callers must fill the gaps with defaults rather than reject the entry.
 */
export interface DiscoveredModelInfo {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly maxContextSize?: number | undefined;
  readonly capabilities?: readonly string[] | undefined;
}

/**
 * The Anthropic API requires this on every request, `/models` included; it is
 * the API-version pin, not a model id.
 */
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * How a vendor authenticates its `/models` route. Most speak plain
 * OpenAI-compatible Bearer, but three do not, and sending them a Bearer header
 * gets a 401 that looks identical to a bad key:
 *
 * - `anthropic` — `x-api-key` plus the required `anthropic-version` header.
 * - `gemini` — `x-goog-api-key` (equivalently `?key=` on the query string).
 * - `bearer` — everything else.
 */
export type DiscoveryAuthStyle = 'bearer' | 'x-api-key' | 'x-goog-api-key';

export interface FetchDiscoveredModelsOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly userAgent?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Auth style for the `/models` route; defaults to `bearer`. */
  readonly authStyle?: DiscoveryAuthStyle | undefined;
  /**
   * Version segment to insert before `/models` for vendors whose base is a
   * bare host (Anthropic: `{base}/v1/models`). Omitted for OpenAI-compatible
   * gateways, whose configured base already ends in `/v1`.
   */
  readonly versionSegment?: string | undefined;
}

export class DiscoveredModelsAuthError extends Error {
  readonly status: number;
  readonly baseUrl: string;

  constructor(message: string, status: number, baseUrl: string) {
    super(message);
    this.name = 'DiscoveredModelsAuthError';
    this.status = status;
    this.baseUrl = baseUrl;
  }
}

/**
 * Normalizes a user-supplied base URL: no trailing slash, and no
 * `/chat/completions` suffix. A user who pasted the full completions endpoint
 * (a common copy-paste) must not get a 404 from `…/chat/completions/models`.
 */
export function normalizeDiscoveryBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/chat\/completions$/i, '');
}

/**
 * Builds the `/models` URL for a base, honouring the vendor's version
 * convention.
 *
 * The chat path and the model-list path disagree for exactly one vendor:
 * Anthropic's SDK posts to `{base}/v1/messages` (so its configured base is a
 * bare host) while its model list lives at `{base}/v1/models`. Probing the bare
 * host returns a 404 that reads like a dead endpoint. `versionSegment` names
 * the segment to insert for such vendors; OpenAI-compatible gateways already
 * carry `/v1` in their configured base and pass none.
 */
export function buildModelsUrl(raw: string, versionSegment?: string): string {
  const base = normalizeDiscoveryBaseUrl(raw);
  if (versionSegment === undefined) return `${base}/models`;
  if (base.endsWith(`/${versionSegment}`)) return `${base}/models`;
  return `${base}/${versionSegment}/models`;
}

/**
 * Fetches the model list from a vendor endpoint.
 *
 * Handles the three auth styles above and both response shapes: the
 * OpenAI-style `{ data: [{ id }] }` (also accepted as a bare array) and
 * Google's `{ models: [{ name }] }`, whose ids arrive as `models/gemini-…`.
 *
 * Skips entries without a usable string id rather than failing the whole
 * fetch: gateways routinely mix embedding or fine-tune entries into the list,
 * and one odd row must not cost the user every model. Throws only when the
 * request itself fails.
 */
export async function fetchDiscoveredModels(
  options: FetchDiscoveredModelsOptions,
): Promise<DiscoveredModelInfo[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeDiscoveryBaseUrl(options.baseUrl);
  const authStyle = options.authStyle ?? 'bearer';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.userAgent !== undefined) headers['User-Agent'] = options.userAgent;
  const key = options.apiKey;
  if (key !== undefined && key.length > 0) {
    switch (authStyle) {
      case 'x-api-key':
        headers['x-api-key'] = key;
        headers['anthropic-version'] = ANTHROPIC_VERSION;
        break;
      case 'x-goog-api-key':
        headers['x-goog-api-key'] = key;
        break;
      default:
        headers['Authorization'] = `Bearer ${key}`;
        break;
    }
  }

  const init: RequestInit = { headers };
  if (options.signal !== undefined) init.signal = options.signal;

  const response = await fetchImpl(buildModelsUrl(baseUrl, options.versionSegment), init);
  if (!response.ok) {
    const message = await readApiErrorMessage(
      response,
      `Failed to list models at ${baseUrl} (HTTP ${response.status}).`,
    );
    if (response.status === 401 || response.status === 403) {
      throw new DiscoveredModelsAuthError(message, response.status, baseUrl);
    }
    throw new Error(message);
  }

  const payload: unknown = await response.json();
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload['data'])
      ? (payload['data'] as unknown[])
      : // Google's Generative Language API answers with `{ models: [{ name }] }`
        // rather than the OpenAI `{ data: [{ id }] }`, and requires no `object`
        // discriminator on the rows.
        isRecord(payload) && Array.isArray(payload['models'])
        ? (payload['models'] as unknown[])
        : undefined;
  if (rows === undefined) {
    throw new Error(
      `Unexpected models response at ${baseUrl}: expected a { "data": [...] } or { "models": [...] } object.`,
    );
  }

  const seen = new Set<string>();
  const out: DiscoveredModelInfo[] = [];
  for (const row of rows) {
    const info = toDiscoveredModel(row);
    if (info === undefined || seen.has(info.id)) continue;
    seen.add(info.id);
    out.push(info);
  }
  return out;
}

/**
 * Strips a resource-collection prefix from a model id. Google's API returns
 * ids as `models/gemini-2.5-pro`, but the id used in a request (and stored in
 * config) is the bare `gemini-2.5-pro`. A model id that legitimately contains a
 * slash — `anthropic/claude-…`, `Qwen/Qwen3-8B` — is left alone: only the known
 * collection names are removed.
 */
function stripResourcePrefix(id: string): string {
  const slash = id.indexOf('/');
  if (slash < 0) return id;
  const head = id.slice(0, slash);
  if (head === 'models' || head === 'model') return id.slice(slash + 1);
  return id;
}

function toDiscoveredModel(row: unknown): DiscoveredModelInfo | undefined {
  if (typeof row === 'string') {
    const id = row.trim();
    return id.length > 0 ? { id } : undefined;
  }
  if (!isRecord(row)) return undefined;
  // Google rows carry the id in `name` (`models/gemini-…`) instead of `id`.
  const rawId = row['id'] ?? row['name'];
  if (typeof rawId !== 'string' || rawId.trim().length === 0) return undefined;
  const id = stripResourcePrefix(rawId.trim());

  const contextLength = positiveInt(row['context_length'] ?? row['context_window']);
  const maxContextSize =
    contextLength ?? positiveInt(row['max_output_tokens']) ?? positiveInt(row['max_context_size']);
  const rawName = row['name'] ?? row['display_name'];

  const capabilities: string[] = [];
  // OpenAI exposes `object: 'model'` for chat models and `'embedding'` for
  // embeddings; an embedding entry cannot drive a chat turn, so skip it rather
  // than offering a model that will fail on first use. Google's list marks
  // embeddings the same way, under `supportedGenerationMethods`.
  const object = row['object'];
  if (typeof object === 'string' && object.toLowerCase().includes('embedding')) return undefined;
  if (row['supports_tools'] === true || row['tool_call'] === true) capabilities.push('tool_use');
  if (row['supports_reasoning'] === true || row['reasoning'] === true) {
    capabilities.push('thinking');
  }
  if (row['supports_image_input'] === true) capabilities.push('image_in');

  const displayName =
    typeof rawName === 'string' && rawName.trim().length > 0 && rawName.trim() !== rawId.trim()
      ? stripResourcePrefix(rawName.trim())
      : undefined;

  return {
    id,
    displayName,
    maxContextSize,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
  };
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

/**
 * Writes discovered models into `config` as `${providerId}/${id}` aliases,
 * merging onto any existing alias so hand-added fields survive. Aliases the
 * endpoint no longer lists are removed — the caller restores user-owned ones
 * outside the refresh prefix.
 */
export function applyDiscoveredModels(
  config: { models?: Record<string, unknown> | undefined },
  providerId: string,
  models: readonly DiscoveredModelInfo[],
  aliasPrefix: string = `${providerId}/`,
): void {
  const existingModels = config.models ?? {};
  const upstreamKeys = new Set(models.map((m) => `${aliasPrefix}${m.id}`));
  for (const [key, model] of Object.entries(existingModels)) {
    if (isRecord(model) && model['provider'] === providerId && !upstreamKeys.has(key)) {
      delete existingModels[key];
    }
  }
  for (const model of models) {
    const key = `${aliasPrefix}${model.id}`;
    const existing = isRecord(existingModels[key]) ? existingModels[key] : {};
    const alias: ManagedKimiModelAlias = {
      provider: providerId,
      model: model.id,
      maxContextSize: model.maxContextSize ?? CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT,
      capabilities: [...(model.capabilities ?? CUSTOM_REGISTRY_DEFAULT_CAPABILITIES)],
      displayName: model.displayName ?? model.id,
    };
    existingModels[key] = mergeRefreshedModelAlias(existing, alias, CUSTOM_REGISTRY_MODEL_FIELDS);
  }
  config.models = existingModels;
}
