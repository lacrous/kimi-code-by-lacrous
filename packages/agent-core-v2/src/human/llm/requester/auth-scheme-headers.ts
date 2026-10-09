import type { LlmModel } from '#/llm/model';

export type AuthSchemeHeaders = Record<string, string | null> | undefined;

export function resolveAuthSchemeHeaders(
  model: LlmModel,
  headers: Record<string, string> | undefined,
): AuthSchemeHeaders {
  const scheme = model.authScheme;
  if (scheme === undefined) return headers;
  const next: Record<string, string | null> = { ...headers, Authorization: null };
  if (scheme.kind === 'none') return next;
  const header = scheme.header;
  const apiKey = model.apiKey;
  if (header !== undefined && apiKey !== undefined) next[header] = apiKey;
  return next;
}
