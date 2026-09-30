/**
 * Model discovery for hand-written OpenAI-compatible providers.
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

export interface FetchDiscoveredModelsOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly userAgent?: string | undefined;
  readonly signal?: AbortSignal | undefined;
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
 * Normalizes a user-supplied base URL to the form the OpenAI SDK appends
 * `/models` to: no trailing slash, and no `/chat/completions` suffix. A user
 * who pasted the full completions endpoint (a common copy-paste) must not get
 * a 404 from `…/chat/completions/models`.
 */
export function normalizeDiscoveryBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/chat\/completions$/i, '');
}

/**
 * Fetches the model list from an OpenAI-compatible endpoint.
 *
 * Skips entries without a usable string `id` rather than failing the whole
 * fetch: gateways routinely mix embedding or fine-tune entries into `data`,
 * and one odd row must not cost the user every model. Throws only when the
 * request itself fails.
 */
export async function fetchDiscoveredModels(
  options: FetchDiscoveredModelsOptions,
): Promise<DiscoveredModelInfo[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeDiscoveryBaseUrl(options.baseUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.userAgent !== undefined) headers['User-Agent'] = options.userAgent;
  if (options.apiKey !== undefined && options.apiKey.length > 0) {
    headers['Authorization'] = `Bearer ${options.apiKey}`;
  }

  const init: RequestInit = { headers };
  if (options.signal !== undefined) init.signal = options.signal;

  const response = await fetchImpl(`${baseUrl}/models`, init);
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
      : undefined;
  if (rows === undefined) {
    throw new Error(
      `Unexpected models response at ${baseUrl}: expected an OpenAI-style { "data": [...] } object.`,
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

function toDiscoveredModel(row: unknown): DiscoveredModelInfo | undefined {
  if (typeof row === 'string') {
    const id = row.trim();
    return id.length > 0 ? { id } : undefined;
  }
  if (!isRecord(row)) return undefined;
  const id = row['id'];
  if (typeof id !== 'string' || id.trim().length === 0) return undefined;

  const contextLength = positiveInt(row['context_length'] ?? row['context_window']);
  const maxContextSize =
    contextLength ?? positiveInt(row['max_context_tokens']) ?? positiveInt(row['max_context_size']);
  const name = row['name'] ?? row['display_name'];

  const capabilities: string[] = [];
  // OpenAI exposes `object: 'model'` for chat models and `'embedding'` for
  // embeddings; an embedding entry cannot drive a chat turn, so skip it rather
  // than offering a model that will fail on first use.
  const object = row['object'];
  if (typeof object === 'string' && object.toLowerCase().includes('embedding')) return undefined;
  if (row['supports_tools'] === true || row['tool_call'] === true) capabilities.push('tool_use');
  if (row['supports_reasoning'] === true || row['reasoning'] === true) {
    capabilities.push('thinking');
  }
  if (row['supports_image_input'] === true) capabilities.push('image_in');

  return {
    id: id.trim(),
    displayName: typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined,
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
