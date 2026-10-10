import type { LlmAuthScheme, LlmAuthSchemeKind, LlmModel } from '#/llm/model';

export const DEFAULT_SUPPRESSED_HEADERS: readonly string[] = ['Authorization'];

export interface AuthStrategyInput {
  readonly scheme: LlmAuthScheme;
  readonly apiKey: string | undefined;
}

export interface AuthStrategy {
  readonly id: LlmAuthSchemeKind;
  apply(input: AuthStrategyInput): Readonly<Record<string, string>> | undefined;
}

const strategies = new Map<LlmAuthSchemeKind, AuthStrategy>();

export function registerAuthStrategy(strategy: AuthStrategy): void {
  strategies.set(strategy.id, strategy);
}

export function getAuthStrategy(id: LlmAuthSchemeKind): AuthStrategy | undefined {
  return strategies.get(id);
}

export function listAuthStrategies(): readonly AuthStrategy[] {
  return [...strategies.values()];
}

export function suppressDefaultAuthHeaders(
  names: readonly string[],
): Record<string, null> {
  const next: Record<string, null> = {};
  for (const name of names) next[name] = null;
  return next;
}

export function applyAuthScheme(
  model: LlmModel,
): Readonly<Record<string, string>> | undefined {
  const scheme = model.authScheme;
  if (scheme === undefined) return undefined;
  const strategy = getAuthStrategy(scheme.kind);
  if (strategy === undefined) {
    throw new Error(`No auth strategy is registered for kind "${scheme.kind}".`);
  }
  return strategy.apply({ scheme, apiKey: model.apiKey });
}

registerAuthStrategy({
  id: 'bearer',
  apply: ({ scheme, apiKey }) =>
    apiKey === undefined ? undefined : { [scheme.header ?? 'Authorization']: `Bearer ${apiKey}` },
});

registerAuthStrategy({
  id: 'custom-header',
  apply: ({ scheme, apiKey }) => {
    const header = scheme.header;
    if (header === undefined || apiKey === undefined) return undefined;
    return { [header]: apiKey };
  },
});

registerAuthStrategy({
  id: 'none',
  apply: () => undefined,
});