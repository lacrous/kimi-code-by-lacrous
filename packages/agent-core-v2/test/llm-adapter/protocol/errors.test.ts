import { describe, expect, it } from 'vitest';

import { errorInfo, isErrorCode } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderOverloadedError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  createAbortError,
} from '#/llm-adapter/contract/errors';
import {
  AuthError2,
  authErrorKindFor,
  ProtocolErrors,
  sanitizeStatusErrorMessage,
  translateProviderError,
} from '#/llm-adapter/protocol/errors';

class APIUserAbortError extends Error {
  constructor(message = 'Request was aborted.') {
    super(message);
  }
}

function catchThrown(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('ProtocolErrors domain', () => {
  it('registers its codes at import time', () => {
    for (const code of Object.values(ProtocolErrors.codes)) {
      expect(isErrorCode(code)).toBe(true);
    }
    expect(errorInfo('provider.rate_limit').retryable).toBe(true);
    expect(errorInfo('provider.filtered').title).toBe('Provider filtered response');
  });
});

const AUTH_KINDS = [
  ['not_authenticated', ProtocolErrors.codes.AUTH_NOT_AUTHENTICATED],
  ['auth_failed', ProtocolErrors.codes.AUTH_FAILED],
  ['expired', ProtocolErrors.codes.AUTH_EXPIRED],
  ['refresh_failed', ProtocolErrors.codes.AUTH_REFRESH_FAILED],
  ['credential_not_found', ProtocolErrors.codes.CREDENTIAL_NOT_FOUND],
  ['credential_invalid', ProtocolErrors.codes.CREDENTIAL_INVALID],
  ['authorization_denied', ProtocolErrors.codes.AUTHORIZATION_DENIED],
] as const;

describe('auth error taxonomy', () => {
  it('registers every auth kind as a non-retryable provider code', () => {
    expect(AUTH_KINDS.map(([, code]) => code)).toEqual([
      'provider.auth_not_authenticated',
      'provider.auth_failed',
      'provider.auth_expired',
      'provider.auth_refresh_failed',
      'provider.credential_not_found',
      'provider.credential_invalid',
      'provider.authorization_denied',
    ]);
    for (const [kind, code] of AUTH_KINDS) {
      expect(isErrorCode(code)).toBe(true);
      expect(code).not.toBe('provider.auth_error');
      expect(errorInfo(code).retryable).toBe(false);
      expect(errorInfo(code).title.length).toBeGreaterThan(0);
      expect(errorInfo(code).action?.length ?? 0).toBeGreaterThan(0);
      expect(Object.values(ProtocolErrors.codes)).toContain(code);
    }
  });

  it('builds an AuthError2 whose code, kind and details agree', () => {
    for (const [kind, code] of AUTH_KINDS) {
      const error = new AuthError2(kind, 'boom', { details: { provider: 'standard' } });
      expect(error).toBeInstanceOf(Error2);
      expect(error.code).toBe(code);
      expect(error.authKind).toBe(kind);
      expect(error.name).toBe('AuthError2');
      expect(error.message).toBe('boom');
      expect(error.details).toEqual({ provider: 'standard', authKind: kind });
      expect(authErrorKindFor(error)).toBe(kind);
      expect(translateProviderError(error)).toBe(error);
    }
  });

  it('classifies provider status errors by auth kind', () => {
    expect(authErrorKindFor(new APIStatusError(401, 'invalid api key'))).toBe('auth_failed');
    expect(authErrorKindFor(new APIStatusError(403, 'forbidden'))).toBe('authorization_denied');
    expect(authErrorKindFor(new APIStatusError(401, 'The access token has expired'))).toBe(
      'expired',
    );
    expect(authErrorKindFor(new APIStatusError(401, 'refresh token is invalid_grant'))).toBe(
      'refresh_failed',
    );
    expect(
      authErrorKindFor(new APIStatusError(403, 'expired refresh token')),
    ).toBe('refresh_failed');
  });

  it('reads the status off plain provider-shaped objects', () => {
    expect(authErrorKindFor({ status: 401, message: 'no' })).toBe('auth_failed');
    expect(authErrorKindFor({ statusCode: 403, message: 'no' })).toBe('authorization_denied');
  });

  it('leaves api, model and network failures outside the taxonomy', () => {
    expect(authErrorKindFor(new APIStatusError(429, 'too many requests'))).toBeUndefined();
    expect(authErrorKindFor(new APIStatusError(500, 'boom'))).toBeUndefined();
    expect(authErrorKindFor(new APIConnectionError('down'))).toBeUndefined();
    expect(authErrorKindFor(new ChatProviderError('weird'))).toBeUndefined();
    expect(authErrorKindFor(new Error('boom'))).toBeUndefined();
    expect(authErrorKindFor('boom')).toBeUndefined();
    expect(authErrorKindFor(new Error2('config.invalid', 'missing api key'))).toBeUndefined();
  });

  it('keeps provider.auth_error as the code for status auth failures', () => {
    const expired = new APIStatusError(401, 'The access token has expired');
    expect(translateProviderError(expired).code).toBe('provider.auth_error');
    expect(authErrorKindFor(expired)).toBe('expired');
  });
});

describe('translateProviderError — abort guard', () => {
  it('throws the standard abort DOMException for every abort shape', () => {
    for (const abort of [
      createAbortError(),
      Object.assign(new Error('Aborted'), { name: 'AbortError' }),
      new APIUserAbortError(),
    ]) {
      const thrown = catchThrown(() => translateProviderError(abort));
      expect(thrown).toBeInstanceOf(DOMException);
      expect((thrown as DOMException).name).toBe('AbortError');
    }
  });

  it('never converts an abort into a retryable provider Error2', () => {
    const thrown = catchThrown(() => translateProviderError(new APIUserAbortError()));
    expect(thrown).not.toBeInstanceOf(Error2);
  });
});

describe('translateProviderError — classification', () => {
  it('passes an Error2 through unchanged', () => {
    const original = new Error2('provider.rate_limit', 'slow down');
    expect(translateProviderError(original)).toBe(original);
  });

  it('maps status errors to their codes at birth and preserves wire details', () => {
    const cases: ReadonlyArray<[APIStatusError, string]> = [
      [new APIStatusError(429, 'too many requests'), 'provider.rate_limit'],
      [new APIStatusError(529, 'overloaded'), 'provider.overloaded'],
      [new APIProviderOverloadedError(503, 'overloaded'), 'provider.overloaded'],
      [new APIContextOverflowError(400, 'context length exceeded'), 'context.overflow'],
      [new APIStatusError(401, 'bad key'), 'provider.auth_error'],
      [new APIStatusError(403, 'forbidden'), 'provider.auth_error'],
      [new APIStatusError(500, 'boom'), 'provider.api_error'],
    ];
    for (const [error, code] of cases) {
      const translated = translateProviderError(error);
      expect(translated).toBe(error);
      expect(translated.code).toBe(code);
      expect(translated.details?.['statusCode']).toBe(error.statusCode);
    }
  });

  it('keeps requestId and traceId in the details', () => {
    const translated = translateProviderError(
      new APIStatusError(429, 'too many requests', 'req-1', null, 'trace-1'),
    );
    expect(translated.details).toMatchObject({
      statusCode: 429,
      requestId: 'req-1',
      traceId: 'trace-1',
    });
  });

  it('maps connection and timeout errors to the connection code', () => {
    expect(translateProviderError(new APIConnectionError('down')).code).toBe(
      'provider.connection_error',
    );
    expect(translateProviderError(new APITimeoutError('slow')).code).toBe(
      'provider.connection_error',
    );
  });

  it('maps an empty filtered response to the filtered code', () => {
    const filtered = new APIEmptyResponseError('empty', {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    const translated = translateProviderError(filtered);
    expect(translated.code).toBe('provider.filtered');
    expect(translated.details).toMatchObject({
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });

    const other = new APIEmptyResponseError('empty', { finishReason: 'completed' });
    expect(translateProviderError(other).code).toBe('provider.api_error');
  });

  it('maps a plain provider error to the generic api code', () => {
    expect(translateProviderError(new ChatProviderError('weird')).code).toBe('provider.api_error');
  });

  it('maps unknown errors and non-errors to internal', () => {
    expect(translateProviderError(new Error('boom')).code).toBe('internal');
    expect(translateProviderError('boom').code).toBe('internal');
    expect(translateProviderError('boom').message).toBe('boom');
  });
});

describe('sanitizeStatusErrorMessage', () => {
  it('extracts the title text from an HTML error page', () => {
    const html = '<html>\r\n<head><title>429 Too Many Requests</title></head>\r\n<body>...</body></html>';
    expect(sanitizeStatusErrorMessage(html)).toBe('429 Too Many Requests');
  });

  it('strips carriage returns from plain messages', () => {
    expect(sanitizeStatusErrorMessage('line one\r\nline two\r')).toBe('line one\nline two');
  });

  it('keeps the original message when the title is empty or absent', () => {
    expect(sanitizeStatusErrorMessage('<title>   </title>fallback')).toBe(
      '<title>   </title>fallback',
    );
    expect(sanitizeStatusErrorMessage('plain')).toBe('plain');
  });
});
