export type LlmAuthErrorKind =
  | 'not_authenticated'
  | 'auth_failed'
  | 'expired'
  | 'refresh_failed'
  | 'credential_not_found'
  | 'credential_invalid'
  | 'authorization_denied';

export const LLM_AUTH_ERROR_KINDS = [
  'not_authenticated',
  'auth_failed',
  'expired',
  'refresh_failed',
  'credential_not_found',
  'credential_invalid',
  'authorization_denied',
] as const satisfies readonly LlmAuthErrorKind[];

const AUTH_REFRESH_MESSAGE_PATTERNS = [
  /refresh[\s_-]?token/,
  /token[\s_-]?refresh/,
  /(?:fail\w*|error|invalid|revoked|expired|missing|denied)[\s\w]{0,24}refresh/,
  /refresh[\s\w]{0,24}(?:fail\w*|error|invalid|revoked|expired|missing|denied)/,
] as const;

const AUTH_EXPIRED_MESSAGE_PATTERNS = [
  /\bexpired\b/,
  /\bexpiration\b/,
  /invalid_grant/,
  /no longer valid/,
] as const;

export function authErrorKindForStatus(
  statusCode: number,
  message: string,
): LlmAuthErrorKind | undefined {
  if (statusCode !== 401 && statusCode !== 403) return undefined;
  const lowerMessage = message.toLowerCase();
  if (AUTH_REFRESH_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage))) {
    return 'refresh_failed';
  }
  if (AUTH_EXPIRED_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage))) {
    return 'expired';
  }
  return statusCode === 403 ? 'authorization_denied' : 'auth_failed';
}