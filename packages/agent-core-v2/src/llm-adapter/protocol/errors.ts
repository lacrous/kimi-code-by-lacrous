import { CoreErrors, registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, isError2, type Error2Options } from '#/_base/errors/errors';
import { errorStatusCode } from '#human/llm/errors';
import {
  authErrorKindForStatus,
  LLM_AUTH_ERROR_KINDS,
  type LlmAuthErrorKind,
} from '#human/llm/requester/auth-errors';
import {
  CONTEXT_OVERFLOW_ERROR_CODE,
  PROVIDER_API_ERROR_CODE,
  PROVIDER_AUTH_ERROR_CODE,
  PROVIDER_CONNECTION_ERROR_CODE,
  PROVIDER_FILTERED_ERROR_CODE,
  PROVIDER_OVERLOADED_ERROR_CODE,
  PROVIDER_RATE_LIMIT_ERROR_CODE,
  throwIfAbortError,
} from '../contract/errors';

export { sanitizeStatusErrorMessage } from '../contract/errors';

export const PROVIDER_AUTH_NOT_AUTHENTICATED_ERROR_CODE = 'provider.auth_not_authenticated';
export const PROVIDER_AUTH_FAILED_ERROR_CODE = 'provider.auth_failed';
export const PROVIDER_AUTH_EXPIRED_ERROR_CODE = 'provider.auth_expired';
export const PROVIDER_AUTH_REFRESH_FAILED_ERROR_CODE = 'provider.auth_refresh_failed';
export const PROVIDER_CREDENTIAL_NOT_FOUND_ERROR_CODE = 'provider.credential_not_found';
export const PROVIDER_CREDENTIAL_INVALID_ERROR_CODE = 'provider.credential_invalid';
export const PROVIDER_AUTHORIZATION_DENIED_ERROR_CODE = 'provider.authorization_denied';

export const ProtocolErrors = {
  codes: {
    PROVIDER_API_ERROR: PROVIDER_API_ERROR_CODE,
    PROVIDER_FILTERED: PROVIDER_FILTERED_ERROR_CODE,
    PROVIDER_RATE_LIMIT: PROVIDER_RATE_LIMIT_ERROR_CODE,
    PROVIDER_AUTH_ERROR: PROVIDER_AUTH_ERROR_CODE,
    PROVIDER_CONNECTION_ERROR: PROVIDER_CONNECTION_ERROR_CODE,
    PROVIDER_OVERLOADED: PROVIDER_OVERLOADED_ERROR_CODE,
    CONTEXT_OVERFLOW: CONTEXT_OVERFLOW_ERROR_CODE,
    AUTH_NOT_AUTHENTICATED: PROVIDER_AUTH_NOT_AUTHENTICATED_ERROR_CODE,
    AUTH_FAILED: PROVIDER_AUTH_FAILED_ERROR_CODE,
    AUTH_EXPIRED: PROVIDER_AUTH_EXPIRED_ERROR_CODE,
    AUTH_REFRESH_FAILED: PROVIDER_AUTH_REFRESH_FAILED_ERROR_CODE,
    CREDENTIAL_NOT_FOUND: PROVIDER_CREDENTIAL_NOT_FOUND_ERROR_CODE,
    CREDENTIAL_INVALID: PROVIDER_CREDENTIAL_INVALID_ERROR_CODE,
    AUTHORIZATION_DENIED: PROVIDER_AUTHORIZATION_DENIED_ERROR_CODE,
  },
  retryable: [
    'provider.rate_limit',
    'provider.connection_error',
    'provider.overloaded',
    'context.overflow',
  ],
  info: {
    'provider.rate_limit': {
      title: 'Provider rate limit',
      retryable: true,
      public: true,
      action: 'Retry after the provider rate limit resets.',
    },
    'provider.filtered': {
      title: 'Provider filtered response',
      retryable: false,
      public: true,
      action: 'Revise the prompt or model configuration to avoid provider safety filtering.',
    },
    'provider.auth_error': {
      title: 'Provider authentication failed',
      retryable: false,
      public: true,
      action: 'Check provider credentials and authentication configuration.',
    },
    'provider.auth_not_authenticated': {
      title: 'Provider not authenticated',
      retryable: false,
      public: true,
      action: 'Sign in or configure an API key for the provider before retrying.',
    },
    'provider.auth_failed': {
      title: 'Provider authentication failed',
      retryable: false,
      public: true,
      action: 'Replace the provider credential with a valid API key or token.',
    },
    'provider.auth_expired': {
      title: 'Provider authentication expired',
      retryable: false,
      public: true,
      action: 'Refresh the provider credential or sign in again.',
    },
    'provider.auth_refresh_failed': {
      title: 'Provider token refresh failed',
      retryable: false,
      public: true,
      action: 'Re-authenticate with the provider; the stored refresh token is no longer usable.',
    },
    'provider.credential_not_found': {
      title: 'Provider credential not found',
      retryable: false,
      public: true,
      action: 'Set the configured credential environment variable or complete provider login.',
    },
    'provider.credential_invalid': {
      title: 'Provider credential invalid',
      retryable: false,
      public: true,
      action: 'Correct the configured credential; it is malformed or rejected by the provider.',
    },
    'provider.authorization_denied': {
      title: 'Provider authorization denied',
      retryable: false,
      public: true,
      action: 'Grant the credential access to the requested model or resource.',
    },
    'provider.overloaded': {
      title: 'Provider overloaded',
      retryable: true,
      public: true,
      action: 'Retry after the provider recovers from overload.',
    },
    'context.overflow': {
      title: 'Context overflow',
      retryable: true,
      public: true,
      action: 'Compact the conversation or retry with fewer tokens.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ProtocolErrors);

const AUTH_ERROR_CODE_BY_KIND = {
  not_authenticated: ProtocolErrors.codes.AUTH_NOT_AUTHENTICATED,
  auth_failed: ProtocolErrors.codes.AUTH_FAILED,
  expired: ProtocolErrors.codes.AUTH_EXPIRED,
  refresh_failed: ProtocolErrors.codes.AUTH_REFRESH_FAILED,
  credential_not_found: ProtocolErrors.codes.CREDENTIAL_NOT_FOUND,
  credential_invalid: ProtocolErrors.codes.CREDENTIAL_INVALID,
  authorization_denied: ProtocolErrors.codes.AUTHORIZATION_DENIED,
} as const satisfies Record<LlmAuthErrorKind, string>;

export class AuthError2 extends Error2 {
  readonly authKind: LlmAuthErrorKind;

  constructor(kind: LlmAuthErrorKind, message: string, options?: Error2Options) {
    super(AUTH_ERROR_CODE_BY_KIND[kind], message, {
      ...options,
      name: 'AuthError2',
      details: { ...options?.details, authKind: kind },
    });
    this.authKind = kind;
  }
}

export function authErrorKindFor(error: unknown): LlmAuthErrorKind | undefined {
  if (error instanceof Error2) {
    const coded = LLM_AUTH_ERROR_KINDS.find((kind) => error.code === AUTH_ERROR_CODE_BY_KIND[kind]);
    if (coded !== undefined) return coded;
  }
  const statusCode = errorStatusCode(error);
  if (statusCode === undefined) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  return authErrorKindForStatus(statusCode, message);
}

export function translateProviderError(error: unknown): Error2 {
  throwIfAbortError(error);
  if (isError2(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new Error2(CoreErrors.codes.INTERNAL, error.message, {
      name: error.name,
      cause: error,
    });
  }
  return new Error2(CoreErrors.codes.INTERNAL, String(error), { cause: error });
}
