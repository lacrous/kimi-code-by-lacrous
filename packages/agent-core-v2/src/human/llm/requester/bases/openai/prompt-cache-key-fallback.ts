import { APIError as RawOpenAISDKAPIError } from 'openai';

const PROMPT_CACHE_KEY_PARAM = 'prompt_cache_key';

const REJECTION_PATTERNS = [
  /unsupported parameter/,
  /unknown parameter/,
  /unrecognized request argument/,
  /extra inputs are not permitted/,
] as const;

export function isPromptCacheKeyRejection(error: unknown): boolean {
  if (!(error instanceof RawOpenAISDKAPIError)) return false;
  if (error.status !== 400) return false;
  const message = error.message.toLowerCase();
  if (!message.includes(PROMPT_CACHE_KEY_PARAM)) return false;
  return REJECTION_PATTERNS.some((pattern) => pattern.test(message));
}

export class PromptCacheKeyRejections {
  private readonly rejected = new Set<string>();

  has(modelKey: string): boolean {
    return this.rejected.has(modelKey);
  }

  mark(modelKey: string): void {
    this.rejected.add(modelKey);
  }
}
