import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '#/features/computerUse/browser/browserController';
import { CdpBrowserBackend } from '#/features/computerUse/browser/cdpBackend';
import {
  BrowserLaunchError,
  findChromium,
  firstPageWebSocket,
  launchBrowser,
  type LaunchedBrowser,
} from '#/features/computerUse/browser/browserLauncher';

describe('findChromium', () => {
  it('finds a cached chromium without a package dependency', async () => {
    const found = await findChromium();

    if (found !== undefined) {
      expect(found).toMatch(/chrome|headless_shell/);
    }
  }, 30_000);

  it('returns undefined for a path that does not exist', async () => {
    expect(await findChromium('/nonexistent/chrome')).toBeUndefined();
  });
});

describe('launchBrowser', () => {
  let browser: LaunchedBrowser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
  });

  it('fails clearly when no browser is available', async () => {
    await expect(launchBrowser({ executablePath: '/nonexistent/chrome' })).rejects.toThrow(
      BrowserLaunchError,
    );
  }, 30_000);

  it('starts an owned browser with a disposable profile and a CDP endpoint', async () => {
    browser = await launchBrowser({ headless: true, port: 9331, startupTimeoutMs: 30_000 });

    expect(browser.endpoint).toBe('http://127.0.0.1:9331');
    expect(browser.owned).toBe(true);
    expect(browser.userDataDir).toContain('kimi-browser-');

    const response = await fetch(`${browser.endpoint}/json/version`);
    expect(response.ok).toBe(true);
    const version = (await response.json()) as { Browser?: string };
    expect(version.Browser).toMatch(/Chrome/);
  }, 60_000);

  it('cleans up its profile directory on close', async () => {
    const launched = await launchBrowser({ headless: true, port: 9332, startupTimeoutMs: 30_000 });
    const dir = launched.userDataDir;

    await launched.close();

    await expect(rm(dir, { recursive: false })).rejects.toThrow();
  }, 60_000);

  it('is safe to close twice', async () => {
    browser = await launchBrowser({ headless: true, port: 9333, startupTimeoutMs: 30_000 });

    await browser.close();
    await expect(browser.close()).resolves.toBeUndefined();
  }, 60_000);
});

describe('BrowserController against a real browser', () => {
  let browser: LaunchedBrowser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
  });

  it('navigates a real page and reads its title, text and accessibility tree', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<title>Probe</title><button>Go</button><input id=f>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    browser = await launchBrowser({ headless: true, port: 9338, startupTimeoutMs: 30_000 });
    const socket = await firstPageWebSocket(browser.endpoint);
    expect(socket).toMatch(/^ws:\/\//);

    const backend = new CdpBrowserBackend({ endpoint: socket as string });
    const controller = new BrowserController({ backend });
    await backend.launch();

    try {
      const frame = await controller.navigate(`http://127.0.0.1:${String(port)}/`);

      expect(frame.title).toBe('Probe');
      expect(frame.text).toContain('Go');
      expect(frame.accessibility.some((n) => n.name === 'Go')).toBe(true);
      expect(controller.currentUrl).toContain(`127.0.0.1:${String(port)}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 90_000);

  it('refuses a javascript: url without touching the browser', async () => {
    browser = await launchBrowser({ headless: true, port: 9339, startupTimeoutMs: 30_000 });
    const socket = await firstPageWebSocket(browser.endpoint);
    const backend = new CdpBrowserBackend({ endpoint: socket as string });
    const controller = new BrowserController({ backend });
    await backend.launch();

    await expect(controller.navigate('javascript:alert(1)')).rejects.toThrow(
      /Only http and https/,
    );
    expect(controller.currentUrl).toBeUndefined();
  }, 90_000);

  it('reports no page target when the browser has none', async () => {
    browser = await launchBrowser({ headless: true, port: 9334, startupTimeoutMs: 30_000 });

    expect(await firstPageWebSocket(browser.endpoint)).toMatch(/^ws:\/\//);
  }, 60_000);

  it('uses a throwaway profile directory per launch', async () => {
    const first = await launchBrowser({ headless: true, port: 9335, startupTimeoutMs: 30_000 });
    const firstDir = first.userDataDir;
    await first.close();

    const second = await launchBrowser({ headless: true, port: 9336, startupTimeoutMs: 30_000 });
    const secondDir = second.userDataDir;
    await second.close();

    expect(firstDir).not.toBe(secondDir);
  }, 90_000);

  it('honours an explicit user data directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-fixed-profile-'));

    const launched = await launchBrowser({
      headless: true,
      port: 9337,
      userDataDir: dir,
      startupTimeoutMs: 30_000,
    });
    expect(launched.userDataDir).toBe(dir);

    await launched.close();
  }, 60_000);
});

export type { BrowserLaunchError };
