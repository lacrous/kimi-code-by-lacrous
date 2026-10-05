import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface BrowserLaunchOptions {
  readonly executablePath?: string;
  readonly port?: number;
  readonly headless?: boolean;
  readonly userDataDir?: string;
  readonly extraArgs?: readonly string[];
  readonly startupTimeoutMs?: number;
  readonly sandbox?: boolean;
}

export interface LaunchedBrowser {
  readonly endpoint: string;
  readonly userDataDir: string;
  readonly owned: boolean;
  close(): Promise<void>;
}

const CANDIDATE_ROOTS = [
  join(process.env['HOME'] ?? '', '.cache', 'ms-playwright'),
  '/root/.cache/ms-playwright',
  '/usr/lib/chromium',
];

const BINARY_NAMES = [
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome',
  'headless_shell',
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findChromium(
  explicitPath?: string,
): Promise<string | undefined> {
  if (explicitPath !== undefined) {
    return (await exists(explicitPath)) ? explicitPath : undefined;
  }
  for (const root of CANDIDATE_ROOTS) {
    for (const name of BINARY_NAMES) {
      const direct = join(root, name);
      if (await exists(direct)) return direct;
    }
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.toSorted().toReversed()) {
      for (const name of BINARY_NAMES) {
        const candidate = join(root, entry, name);
        if (await exists(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

async function waitForEndpoint(
  port: number,
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return true;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function launchBrowser(
  options: BrowserLaunchOptions = {},
): Promise<LaunchedBrowser> {
  const executable = await findChromium(options.executablePath);
  if (executable === undefined) {
    throw new BrowserLaunchError(
      'No Chromium binary found. Install one, or pass executablePath.',
      'environment',
    );
  }
  const port = options.port ?? 9222;
  const userDataDir =
    options.userDataDir ?? (await mkdtemp(join(tmpdir(), 'kimi-browser-')));
  const headless = options.headless ?? true;

  const args = [
    `--remote-debugging-port=${String(port)}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    ...(options.sandbox === true ? [] : ['--no-sandbox']),
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    ...(options.extraArgs ?? []),
    'about:blank',
  ];

  const child: ChildProcess = spawn(executable, args, {
    stdio: 'ignore',
    detached: false,
  });

  const deadline = Date.now() + (options.startupTimeoutMs ?? 20_000);
  if (!(await waitForEndpoint(port, deadline))) {
    child.kill('SIGKILL');
    await rm(userDataDir, { recursive: true, force: true });
    throw new BrowserLaunchError(
      `Chromium did not expose a CDP endpoint on port ${String(port)} within the timeout.`,
      'transient',
    );
  }

  let closed = false;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    userDataDir,
    owned: true,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
      });
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
      await exited;
      clearTimeout(force);
      try {
        await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
      }
    },
  };
}

export class BrowserLaunchError extends Error {
  readonly failureClass: 'environment' | 'transient';

  constructor(message: string, failureClass: 'environment' | 'transient') {
    super(message);
    this.name = 'BrowserLaunchError';
    this.failureClass = failureClass;
  }
}

export async function firstPageWebSocket(
  endpoint: string,
): Promise<string | undefined> {
  const response = await fetch(`${endpoint}/json/list`, {
    signal: AbortSignal.timeout(5_000),
  });
  const targets = (await response.json()) as { webSocketDebuggerUrl?: string }[];
  return targets.find((t) => t.webSocketDebuggerUrl !== undefined)
    ?.webSocketDebuggerUrl;
}
