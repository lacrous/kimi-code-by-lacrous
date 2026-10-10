import type { LlmModel } from '#/llm/model';
import {
  applyAuthScheme,
  DEFAULT_SUPPRESSED_HEADERS,
  suppressDefaultAuthHeaders,
} from '#/llm/requester/auth-strategy';

export type AuthSchemeHeaders = Record<string, string | null> | undefined;

export function resolveAuthSchemeHeaders(
  model: LlmModel,
  headers: Record<string, string> | undefined,
  suppressed: readonly string[] = DEFAULT_SUPPRESSED_HEADERS,
): AuthSchemeHeaders {
  if (model.authScheme === undefined) return headers;
  return {
    ...headers,
    ...suppressDefaultAuthHeaders(suppressed),
    ...applyAuthScheme(model),
  };
}
