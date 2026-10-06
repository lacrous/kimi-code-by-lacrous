import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  captureScreen,
  captureStrategies,
  type CaptureStrategy,
} from '#/features/computerUse/capture';
import {
  ComputerControlError,
  missingDependencyError,
  unsupportedOperationError,
  type ApplicationInfo,
  type ComputerBackend,
  type ComputerCapabilities,
  type ComputerEnvironment,
  type MonitorInfo,
  type MouseButton,
  type Point,
  type ScreenGeometry,
  type Screenshot,
  type WindowInfo,
} from '#/features/computerUse/types';

const execFileAsync = promisify(execFile);

export interface UbuntuBackendOptions {
  readonly display?: string;
  readonly screenshotCommand?: readonly string[];
  readonly timeoutMs?: number;
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'BackSpace',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  super: 'super',
  cmd: 'super',
  delete: 'Delete',
  space: 'space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
};

export function normalizeKey(key: string): string {
  const lower = key.trim().toLowerCase();
  return KEY_ALIASES[lower] ?? key.trim();
}

function parseGeometry(spec: string): ScreenGeometry {
  const spec_ = spec.trim();
  const match =
    /(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(spec_) ?? /^(\d+)\s+(\d+)$/.exec(spec_);
  if (match === null) {
    throw new Error(`cannot parse geometry "${spec}"`);
  }
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function parseWindows(blocks: readonly string[]): WindowInfo[] {
  const windows: WindowInfo[] = [];
  let current: {
    id?: string;
    client?: string;
    title?: string;
    desktop?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  } = {};
  const flush = (): void => {
    if (current.id !== undefined && current.title !== undefined) {
      windows.push({
        id: current.id,
        title: current.title,
        application: current.client ?? '',
        geometry: { width: current.w ?? 0, height: current.h ?? 0 },
        x: current.x ?? 0,
        y: current.y ?? 0,
        focused: false,
        minimized: false,
      });
    }
    current = {};
  };
  for (const line of blocks) {
    if (line.startsWith('Window id:')) {
      flush();
      current.id = line.slice('Window id:'.length).trim().replace(/:$/, '');
    } else if (line.startsWith('  Client Name:')) {
      current.client = line.slice('  Client Name:'.length).trim();
    } else if (line.startsWith('  Window Name:')) {
      current.title = line.slice('  Window Name:'.length).trim();
    } else if (line.startsWith('  Absolute upper-left X:')) {
      current.x = Number(line.split(':')[1]?.trim() ?? 0);
    } else if (line.startsWith('  Absolute upper-left Y:')) {
      current.y = Number(line.split(':')[1]?.trim() ?? 0);
    } else if (line.startsWith('  Width:')) {
      current.w = Number(line.split(':')[1]?.trim() ?? 0);
    } else if (line.startsWith('  Height:')) {
      current.h = Number(line.split(':')[1]?.trim() ?? 0);
    }
  }
  flush();
  return windows;
}

export function classifyToolFailure(detail: string) {
  if (/BadMatch|BadWindow|badmatch/i.test(detail)) return 'environment' as const;
  if (/not found|no such window/i.test(detail)) return 'invalid_action' as const;
  if (/permission denied|not authorized|refused/i.test(detail)) return 'authentication' as const;
  return 'environment' as const;
}

export function parseMonitors(query: string): MonitorInfo[] {
  const monitors: MonitorInfo[] = [];
  for (const line of query.split('\n')) {
    const match = /^(.+?) connected (primary )?(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(line);
    if (match === null) continue;
    monitors.push({
      index: monitors.length,
      name: (match[1] ?? '').trim(),
      geometry: { width: Number(match[3]), height: Number(match[4]) },
      primary: match[2] !== undefined,
    });
  }
  return monitors;
}

export class UbuntuBackend implements ComputerBackend {
  private readonly _display: string | undefined;
  private readonly _screenshotCommand: readonly string[] | undefined;
  private readonly _timeoutMs: number;
  private _frameDir: string | undefined;

  constructor(options: UbuntuBackendOptions = {}) {
    this._display = options.display ?? process.env['DISPLAY'];
    this._screenshotCommand = options.screenshotCommand;
    this._timeoutMs = options.timeoutMs ?? 10_000;
  }

  private _env(): NodeJS.ProcessEnv {
    return this._display === undefined ? process.env : { ...process.env, DISPLAY: this._display };
  }

  private async _run(
    command: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(command, [...args], {
        env: this._env(),
        timeout: this._timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout, stderr };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        throw missingDependencyError(command);
      }
      const detail = ((err as { stderr?: string }).stderr ?? err.message ?? '').toString().trim();
      throw new ComputerControlError(
        detail.length > 0
          ? `${command} failed: ${detail.split('\n')[0]}`
          : `${command} exited with ${String(err.code ?? 'an error')}`,
        classifyToolFailure(detail),
        command,
      );
    }
  }

  private async _try(
    command: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string } | undefined> {
    try {
      return await this._run(command, args);
    } catch {
      return undefined;
    }
  }

  async environment(): Promise<ComputerEnvironment> {
    const osRelease = await this._try('uname', ['-s']);
    return {
      os: osRelease?.stdout.trim() ?? 'Linux',
      platform: 'linux',
      displayServer: this._display === undefined ? 'unknown' : 'x11',
    };
  }

  async capabilities(): Promise<ComputerCapabilities> {
    const probe = async (command: string): Promise<boolean> =>
      (await this._try('sh', ['-c', `command -v ${command}`])) !== undefined;

    const [xdotool, importer] = await Promise.all([probe('xdotool'), probe('import')]);
    const missing: string[] = [];
    if (!xdotool) missing.push('xdotool');
    if (!importer) missing.push('imagemagick (import)');

    return {
      screen: importer,
      mouse: xdotool,
      keyboard: xdotool,
      windows: xdotool,
      applications: xdotool,
      missingDependencies: missing,
    };
  }

  async screenSize(): Promise<ScreenGeometry> {
    const result = await this._run('xdotool', ['getdisplaygeometry']);
    return parseGeometry(result.stdout.trim());
  }

  private async _captureFrame(
    target: WindowInfo | 'screen' | undefined,
  ): Promise<Uint8Array> {
    const path = join(
      this._frameDir ?? (this._frameDir = await mkdtemp(join(tmpdir(), 'kimi-frame-'))),
      'frame.png',
    );
    try {
      const outcome = await captureScreen(path, this._captureAttempts(path));
      if (outcome !== undefined) {
        return await readFile(path);
      }

      if (target !== undefined && target !== 'screen') {
        const result = await this._try('import', ['-window', target.id, path]);
        if (result !== undefined) {
          return await readFile(path);
        }
      }

      throw new ComputerControlError(
        'Screen capture is unavailable on this display. On a Wayland desktop, GNOME Shell ' +
          'refuses D-Bus screenshots for sandboxed clients; check that the agent runs inside ' +
          'the desktop session, or switch the session to X11.',
        'environment',
      );
    } finally {
      await rm(path, { force: true });
    }
  }

  private _captureAttempts(path: string): readonly CaptureStrategy[] {
    if (this._screenshotCommand !== undefined) {
      const command = this._screenshotCommand;
      return [
        {
          name: 'configured',
          attempt: async () => {
            await this._run(command[0] as string, [...command.slice(1), path]);
            return { path, width: 0, height: 0 };
          },
        },
      ];
    }
    return captureStrategies(path);
  }

  async listMonitors() {
    const result = await this._try('xrandr', ['--query']);
    if (result === undefined) {
      return [{ index: 0, name: 'default', geometry: await this.screenSize(), primary: true }];
    }
    return parseMonitors(result.stdout);
  }

  async screenshot(target?: WindowInfo | 'screen'): Promise<Screenshot> {
    const geometry = await this.screenSize();
    const captured = await this._captureFrame(target);
    return {
      width: geometry.width,
      height: geometry.height,
      png: captured,
      capturedAt: Date.now(),
      activeWindow: await this.activeWindow(),
    };
  }

  async activeWindow(): Promise<WindowInfo | undefined> {
    const focused = await this._try('xdotool', ['getactivewindow']);
    if (focused === undefined) return undefined;
    const id = focused.stdout.trim();
    if (id.length === 0) return undefined;
    return this._windowById(id);
  }

  private async _windowById(id: string): Promise<WindowInfo | undefined> {
    const name = await this._try('xdotool', ['getwindowname', id]);
    const geometry = await this._try('xdotool', ['getwindowgeometry', '--shell', id]);
    if (geometry === undefined) return undefined;
    const read = (key: string): number =>
      Number(new RegExp(`^${key}=(\\d+)$`, 'm').exec(geometry.stdout)?.[1] ?? 0);
    return {
      id,
      title: name?.stdout.trim() ?? '',
      application: '',
      geometry: { width: read('WIDTH'), height: read('HEIGHT') },
      x: read('X'),
      y: read('Y'),
      focused: true,
      minimized: false,
    };
  }

  async listWindows(): Promise<readonly WindowInfo[]> {
    const result = await this._run('xdotool', ['search', '--onlyvisible', '--name', '.']);
    const ids = result.stdout.trim().split('\n').filter((line) => line.trim().length > 0);
    const windows = await Promise.all(ids.map((id) => this._windowById(id.trim())));
    return windows.filter((w): w is WindowInfo => w !== undefined);
  }

  async moveMouse(point: Point): Promise<void> {
    await this._run('xdotool', ['mousemove', String(point.x), String(point.y)]);
  }

  async mousePosition(): Promise<Point> {
    const result = await this._run('xdotool', ['getmouselocation', '--shell']);
    const read = (key: string): number =>
      Number(new RegExp(`^${key}=(\\d+)$`, 'm').exec(result.stdout)?.[1] ?? 0);
    return { x: read('X'), y: read('Y') };
  }

  async click(point: Point, button: MouseButton): Promise<void> {
    const buttonNumber = button === 'right' ? 3 : button === 'middle' ? 2 : 1;
    await this._run('xdotool', [
      'mousemove',
      String(point.x),
      String(point.y),
      'click',
      String(buttonNumber),
    ]);
  }

  async doubleClick(point: Point): Promise<void> {
    await this._run('xdotool', [
      'mousemove',
      String(point.x),
      String(point.y),
      'click',
      '--repeat',
      '2',
      '1',
    ]);
  }

  async drag(from: Point, to: Point): Promise<void> {
    await this._run('xdotool', [
      'mousemove',
      String(from.x),
      String(from.y),
      'mousedown',
      '1',
      'mousemove',
      String(to.x),
      String(to.y),
      'mouseup',
      '1',
    ]);
  }

  async scroll(delta: { x: number; y: number }): Promise<void> {
    await this._run('xdotool', [
      'mousemove_relative',
      '--',
      String(delta.x),
      String(delta.y),
      'click',
      String(delta.y >= 0 ? 5 : 4),
    ]);
  }

  async typeText(text: string): Promise<void> {
    await this._run('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--', text]);
  }

  async pressKey(key: string): Promise<void> {
    await this._run('xdotool', ['key', '--clearmodifiers', normalizeKey(key)]);
  }

  async hotkey(keys: readonly string[]): Promise<void> {
    const combo = keys.map(normalizeKey).join('+');
    await this._run('xdotool', ['key', '--clearmodifiers', combo]);
  }

  async keyDown(key: string): Promise<void> {
    await this._run('xdotool', ['keydown', normalizeKey(key)]);
  }

  async keyUp(key: string): Promise<void> {
    await this._run('xdotool', ['keyup', normalizeKey(key)]);
  }

  async listApplications(): Promise<readonly ApplicationInfo[]> {
    const result = await this._try('wmctrl', ['-lp']);
    if (result === undefined) {
      throw unsupportedOperationError('listApplications');
    }
    const active = await this.activeWindow();
    const apps = result.stdout
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({
        name: (m[4] ?? '').trim(),
        pid: Number(m[2]),
        active: active?.application === (m[4] ?? '').trim(),
      }));
    return apps;
  }

  async openApplication(name: string): Promise<void> {
    await this._run('xdg-open', [name]);
  }

  async closeApplication(name: string): Promise<void> {
    const result = await this._try('pkill', ['-f', name]);
    if (result === undefined) {
      throw unsupportedOperationError('closeApplication');
    }
  }

  async focusWindow(id: string): Promise<void> {
    await this._run('xdotool', ['windowactivate', '--sync', id]);
  }

  async minimizeWindow(id: string): Promise<void> {
    const done = await this._try('wmctrl', ['-i', '-r', id, '-b', 'add,hidden']);
    if (done === undefined) {
      await this._run('xdotool', ['windowminimize', id]);
    }
  }

  async maximizeWindow(id: string): Promise<void> {
    const done = await this._try('wmctrl', ['-i', '-r', id, '-b', 'add,maximized_vert,maximized_horz']);
    if (done === undefined) {
      await this._run('xdotool', ['windowsize', id, '100%', '100%']);
    }
  }

  moveWindow = async (id: string, point: Point): Promise<void> => {
    await this._run('xdotool', ['windowmove', id, String(point.x), String(point.y)]);
  };

  resizeWindow = async (id: string, geometry: ScreenGeometry): Promise<void> => {
    await this._run('xdotool', [
      'windowsize',
      id,
      String(geometry.width),
      String(geometry.height),
    ]);
  };
}

export { parseGeometry, parseWindows };
