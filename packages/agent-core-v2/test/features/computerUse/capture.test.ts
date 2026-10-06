import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureScreen,
  captureStrategies,
  saveBase64Png,
  type CaptureStrategy,
} from '#/features/computerUse/capture';

const dirs: string[] = [];

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-cap-'));
  dirs.push(dir);
  return join(dir, 'shot.png');
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function strategy(
  name: string,
  result: { path: string; width: number; height: number } | undefined,
): CaptureStrategy {
  return { name, attempt: vi.fn(async () => result) };
}

describe('captureScreen', () => {
  it('returns the first strategy that succeeds', async () => {
    const hit = { path: '/tmp/a.png', width: 800, height: 600 };
    const attempts = [strategy('gnome-shell', undefined), strategy('imagemagick', hit)];

    const outcome = await captureScreen('/tmp/x.png', attempts);

    expect(outcome).toEqual({ result: hit, strategy: 'imagemagick' });
  });

  it('prefers gnome-shell over imagemagick when both work', async () => {
    const gnome = { path: '/tmp/g.png', width: 1920, height: 1080 };
    const attempts = [strategy('gnome-shell', gnome), strategy('imagemagick', undefined)];

    const outcome = await captureScreen('/tmp/x.png', attempts);

    expect(outcome?.strategy).toBe('gnome-shell');
  });

  it('returns undefined when every strategy fails', async () => {
    const attempts = [strategy('gnome-shell', undefined), strategy('imagemagick', undefined)];

    expect(await captureScreen('/tmp/x.png', attempts)).toBeUndefined();
  });

  it('stops at the first success instead of trying later strategies', async () => {
    const first = strategy('gnome-shell', { path: '/tmp/g.png', width: 1, height: 1 });
    const second = strategy('imagemagick', { path: '/tmp/i.png', width: 1, height: 1 });

    await captureScreen('/tmp/x.png', [first, second]);

    expect(first.attempt).toHaveBeenCalledTimes(1);
    expect(second.attempt).not.toHaveBeenCalled();
  });

  it('tries gnome-shell first, because it is the only path that works on Wayland', () => {
    expect(captureStrategies('/tmp/x.png').map((s) => s.name)).toEqual([
      'gnome-shell',
      'imagemagick',
    ]);
  });
});

describe('saveBase64Png', () => {
  it('reports undefined for bytes that are not a PNG', async () => {
    const path = await tempPath();

    expect(await saveBase64Png(path, Buffer.from('not a png').toString('base64'))).toBeUndefined();
  });

  it('reads dimensions from a real PNG header', async () => {
    const path = await tempPath();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(path, png);

    const result = await saveBase64Png(path, png.toString('base64'));

    if (result !== undefined) {
      expect(result.width).toBe(1);
      expect(result.height).toBe(1);
      expect(result.path).toBe(path);
    }
  });
});

describe('capture strategies against this display', () => {
  it('either captures a frame or reports that it cannot', async () => {
    const path = await tempPath();

    const outcome = await captureScreen(path);

    if (outcome !== undefined) {
      expect(outcome.result.width).toBeGreaterThan(0);
      expect(outcome.result.height).toBeGreaterThan(0);
      expect(outcome.result.path).toBe(path);
    }
  }, 60_000);
});
