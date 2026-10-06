import { describe, expect, it, vi } from 'vitest';

import {
  isSelfUpdateDisabled,
  refreshUpdateCache,
  selfUpdateDisabledMessage,
} from '#/cli/update/refresh';
import type { UpdateManifest } from '#/cli/update/types';

const MANIFEST: UpdateManifest = {
  version: '0.5.0',
  publishedAt: '2026-05-20T12:00:00.000Z',
  rollout: [
    { percent: 30, delaySeconds: 0 },
    { percent: 30, delaySeconds: 43_200 },
    { percent: 40, delaySeconds: 86_400 },
  ],
};

describe('refreshUpdateCache', () => {
  it('rejects with the self-update explanation when using the real CDN channel', async () => {
    // No overrides: this is the production path, and self-update is off in
    // this fork because the upstream CDN describes @moonshot-ai/kimi-code,
    // so a version found there is not a version of this package.
    const writeCache = vi.fn(async () => {});

    const error = await refreshUpdateCache({ writeCache }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/does not self-update/);
    expect(isSelfUpdateDisabled(error)).toBe(true);
    expect(writeCache).not.toHaveBeenCalled();
  });

  it('names the package and the manual upgrade command in the rejection', async () => {
    await expect(refreshUpdateCache()).rejects.toThrow(
      /npm install -g @lacrous\/kimi-code@latest/,
    );
  });

  it('runs an injected fetchLatest instead of gating it', async () => {
    const fetchLatest = vi.fn(async () => ({ latest: '0.5.0', manifest: MANIFEST }));
    const writeCache = vi.fn(async () => {});

    const result = await refreshUpdateCache({
      fetchLatest,
      writeCache,
      now: () => new Date('2026-05-20T12:34:56.000Z'),
    });

    expect(result).toEqual({
      source: 'cdn',
      checkedAt: '2026-05-20T12:34:56.000Z',
      latest: '0.5.0',
      manifest: MANIFEST,
    });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(writeCache).toHaveBeenCalledWith(result);
  });

  it('propagates an injected fetch failure and skips writeCache', async () => {
    const writeCache = vi.fn(async () => {});
    await expect(
      refreshUpdateCache({
        writeCache,
        fetchLatest: async () => {
          throw new Error('network down');
        },
      }),
    ).rejects.toThrow(/network down/);
    expect(writeCache).not.toHaveBeenCalled();
  });

  it('writes a null manifest when the injected fetch reports a fallback', async () => {
    const writeCache = vi.fn(async () => {});
    const result = await refreshUpdateCache({
      writeCache,
      fetchLatest: async () => ({ latest: '0.5.0', manifest: null }),
      now: () => new Date('2026-05-20T12:34:56.000Z'),
    });
    expect(result.manifest).toBeNull();
    expect(writeCache).toHaveBeenCalledWith(result);
  });
});

describe('isSelfUpdateDisabled', () => {
  it('recognizes the gate rejection', async () => {
    const error = await refreshUpdateCache().catch((e: unknown) => e);
    expect(isSelfUpdateDisabled(error)).toBe(true);
  });

  it('does not claim a network failure is a disabled channel', async () => {
    // The failure mode this guards: keying the "disabled" branch off whether
    // the channel happens to be off would misreport a real network error as a
    // design decision, and the user would never learn their check failed.
    const error = await refreshUpdateCache({
      fetchLatest: async () => {
        throw new Error('network down');
      },
    }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/network down/);
    expect(isSelfUpdateDisabled(error)).toBe(false);
  });

  it('returns false for values that are not errors', () => {
    expect(isSelfUpdateDisabled(undefined)).toBe(false);
    expect(isSelfUpdateDisabled('nope')).toBe(false);
  });
});

describe('selfUpdateDisabledMessage', () => {
  it('explains why, and not as a network failure', () => {
    const message = selfUpdateDisabledMessage();
    expect(message).not.toBeNull();
    expect(message).toMatch(/@moonshot-ai\/kimi-code/);
    expect(message).toMatch(/Upgrade manually/);
    expect(message).not.toMatch(/network|HTTP|timeout/i);
  });

  it('returns null when the channel is enabled so callers skip the branch', () => {
    // Guard the helper's contract rather than the current value: callers
    // branch on `!== null`, so a non-null message must always carry the
    // manual-upgrade instruction they print in place of an error.
    const message = selfUpdateDisabledMessage();
    if (message !== null) {
      expect(message).toMatch(/Upgrade manually: npm install -g @\w+\/[\w-]+@latest/);
    }
  });
});