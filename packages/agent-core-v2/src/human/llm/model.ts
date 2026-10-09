import type { ModelCapability } from '#/llm/capability';

export interface LlmConnection {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly defaultHeaders?: Record<string, string>;
  readonly betaApi?: boolean;
  readonly vertexai?: boolean;
}

export type LlmAuthSchemeKind = 'custom-header' | 'none';

export interface LlmAuthScheme {
  kind: LlmAuthSchemeKind;
  header?: string;
}

export interface LlmModel extends LlmConnection {
  readonly provider: string;
  readonly model: string;
  readonly capability: ModelCapability;
  readonly maxContextSize?: number;
  readonly maxInputSize?: number;
  readonly promptCacheKey?: boolean;
  readonly authScheme?: LlmAuthScheme;
}

export function modelKey(model: LlmModel): string {
  return model.baseUrl === undefined ? model.model : `${model.baseUrl}#${model.model}`;
}
