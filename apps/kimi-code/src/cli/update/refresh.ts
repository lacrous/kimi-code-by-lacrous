import { NPM_PACKAGE_NAME } from '#/constant/app';

import { writeUpdateCache } from './cache';
import { fetchLatestFromCdn, type FetchLatestResult } from './cdn';
import { type UpdateCache } from './types';

/**
 * Whether this build may self-update from the upstream CDN.
 *
 * This package is a fork published under its own npm name. The version
 * manifest (`/latest`, `/latest.json`) and the native binaries
 * (`/binaries/<version>`) are served by Moonshot's CDN and describe
 * `@moonshot-ai/kimi-code`, not this package — so a "newer version" found
 * there is a version of a package that is not installed here. Acting on it
 * runs `npm install -g @lacrous/kimi-code@<upstream version>`, which 404s
 * until our version happens to match upstream's, and silently means nothing
 * once it does not. `refreshAndMaybeInstallInBackground` can do that without
 * asking, so the channel is off here rather than merely un-advertised.
 *
 * The gate lives in this module, not in `cdn.ts`, so the CDN transport keeps
 * being exercised by its own tests while the policy has exactly one home.
 */
const SELF_UPDATE_ENABLED = false;

/**
 * The user-facing explanation for a disabled self-update channel, or null
 * when the channel is enabled. Single source for both the thrown error and
 * `kimi upgrade`'s message, so the two can never disagree.
 *
 * The `?? 'Self-update is disabled'` fallback inside `SelfUpdateDisabledError`
 * is unreachable while `SELF_UPDATE_ENABLED` is false: the gate only throws
 * when this returns non-null. It exists so flipping the flag to true cannot
 * produce an error whose message contradicts the branch that reported it.
 */
export function selfUpdateDisabledMessage(): string | null {
  if (SELF_UPDATE_ENABLED) return null;
  return (
    `${NPM_PACKAGE_NAME} does not self-update: the upstream CDN publishes version and ` +
    'binary manifests for @moonshot-ai/kimi-code, which this fork does not ship.\n' +
    `Upgrade manually: npm install -g ${NPM_PACKAGE_NAME}@latest`
  );
}

/**
 * Distinguishes "this build does not self-update" from every other refresh
 * failure. A caller that reports a disabled channel must key off the error's
 * identity, not off `selfUpdateDisabledMessage()`: a transient network
 * failure must still surface as a failed check, or the user loses the signal
 * that something actually went wrong.
 */
export class SelfUpdateDisabledError extends Error {
  constructor() {
    super(selfUpdateDisabledMessage() ?? 'Self-update is disabled');
    this.name = 'SelfUpdateDisabledError';
  }
}

export function isSelfUpdateDisabled(error: unknown): boolean {
  return error instanceof SelfUpdateDisabledError;
}

export interface RefreshUpdateCacheDeps {
  /** Resolves with the latest version + rollout manifest. **Throws** on any
   * failure — callers (including the default background invocation in
   * preflight) must catch. Errors intentionally skip `writeCache` so a
   * transient CDN blip does not overwrite a previously known `latest` with
   * `null`. */
  readonly fetchLatest: () => Promise<FetchLatestResult>;
  readonly writeCache: (cache: UpdateCache) => Promise<void>;
  readonly now: () => Date;
  readonly timeoutMs?: number;
}

export async function refreshUpdateCache(
  overrides: Partial<RefreshUpdateCacheDeps> = {},
): Promise<UpdateCache> {
  const resolved: RefreshUpdateCacheDeps = {
    fetchLatest:
      overrides.fetchLatest ?? (() => fetchLatestFromCdn(undefined, overrides.timeoutMs)),
    writeCache: overrides.writeCache ?? writeUpdateCache,
    now: overrides.now ?? (() => new Date()),
  };

  // The gate sits on the real CDN path, not ahead of dependency resolution:
  // an explicitly injected `fetchLatest` is that caller's own channel, so it
  // runs. Gating before resolution would make this function untestable past
  // the gate and would hide the injected path from the one contract that
  // matters — that a non-gate failure still surfaces as a failure.
  if (overrides.fetchLatest === undefined) {
    const disabled = selfUpdateDisabledMessage();
    if (disabled !== null) {
      throw new SelfUpdateDisabledError();
    }
  }

  const { latest, manifest } = await resolved.fetchLatest();
  const cache: UpdateCache = {
    source: 'cdn',
    checkedAt: resolved.now().toISOString(),
    latest,
    manifest,
  };
  await resolved.writeCache(cache);
  return cache;
}