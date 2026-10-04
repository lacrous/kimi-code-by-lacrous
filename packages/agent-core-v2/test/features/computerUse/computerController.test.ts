import { describe, expect, it, vi } from 'vitest';

import { ComputerController } from '#/features/computerUse/computerController';
import { LoopDetector, observationPolicy } from '#/features/computerUse/observation';
import {
  ComputerControlError,
  type ComputerBackend,
  type MonitorInfo,
  type Point,
  type ScreenGeometry,
  type Screenshot,
  type WindowInfo,
} from '#/features/computerUse/types';

const GEOMETRY: ScreenGeometry = { width: 1920, height: 1080 };

const WINDOW: WindowInfo = {
  id: 'w1',
  title: 'Chromium',
  application: 'chromium',
  geometry: { width: 800, height: 600 },
  x: 0,
  y: 0,
  focused: true,
  minimized: false,
};

const MONITORS: readonly MonitorInfo[] = [
  { index: 0, name: 'eDP-1', geometry: GEOMETRY, primary: true },
];

function png(): Screenshot {
  return {
    width: GEOMETRY.width,
    height: GEOMETRY.height,
    png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    capturedAt: 1_700_000_000_000,
    activeWindow: WINDOW,
  };
}

interface FakeOptions {
  readonly geometry?: ScreenGeometry;
  readonly focusedWindow?: WindowInfo | undefined;
  readonly cursor?: Point;
}

function fakeBackend(options: FakeOptions = {}): ComputerBackend & { calls: string[] } {
  const geometry = options.geometry ?? GEOMETRY;
  const calls: string[] = [];
  const record = (name: string): void => {
    calls.push(name);
  };
  return {
    calls,
    environment: async () => ({ os: 'Ubuntu', platform: 'linux', displayServer: 'x11' }),
    capabilities: async () => ({
      screen: true,
      mouse: true,
      keyboard: true,
      windows: true,
      applications: true,
      missingDependencies: [],
    }),
    screenSize: async () => geometry,
    listMonitors: async () => MONITORS,
    screenshot: async () => {
      record('screenshot');
      return png();
    },
    activeWindow: async () => options.focusedWindow,
    listWindows: async () => (options.focusedWindow === undefined ? [] : [options.focusedWindow]),
    moveMouse: async () => {
      record('moveMouse');
    },
    mousePosition: async () => options.cursor ?? { x: 0, y: 0 },
    click: async (point: Point) => {
      record(`click:${String(point.x)},${String(point.y)}`);
    },
    doubleClick: async (point: Point) => {
      record(`doubleClick:${String(point.x)},${String(point.y)}`);
    },
    drag: async (from: Point, to: Point) => {
      record(`drag:${String(from.x)},${String(from.y)}->${String(to.x)},${String(to.y)}`);
    },
    scroll: async (delta) => {
      record(`scroll:${String(delta.y)}`);
    },
    typeText: async (text) => {
      record(`type:${text}`);
    },
    pressKey: async (key) => {
      record(`press:${key}`);
    },
    hotkey: async (keys) => {
      record(`hotkey:${keys.join('+')}`);
    },
    keyDown: async () => {},
    keyUp: async () => {},
    listApplications: async () => [{ name: 'chromium', pid: 42, active: true }],
    openApplication: async (name) => {
      record(`open:${name}`);
    },
    closeApplication: async (name) => {
      record(`close:${name}`);
    },
    focusWindow: async (id) => {
      record(`focus:${id}`);
    },
    minimizeWindow: async (id) => {
      record(`minimize:${id}`);
    },
    maximizeWindow: async (id) => {
      record(`maximize:${id}`);
    },
    moveWindow: async () => {},
    resizeWindow: async () => {},
  };
}

describe('ComputerController', () => {
  it('returns a screenshot with geometry and the active window', async () => {
    const backend = fakeBackend({ focusedWindow: WINDOW });
    const controller = new ComputerController({ backend });

    const shot = await controller.screenshot();

    expect(shot.width).toBe(1920);
    expect(shot.height).toBe(1080);
    expect(shot.activeWindow?.title).toBe('Chromium');
    expect(shot.capturedAt).toBeGreaterThan(0);
  });

  it('routes a click through to the backend', async () => {
    const backend = fakeBackend();
    const controller = new ComputerController({ backend });

    await controller.click({ x: 850, y: 420 });

    expect(backend.calls).toContain('click:850,420');
  });

  it('rejects a click outside the screen before it reaches the backend', async () => {
    const backend = fakeBackend();
    const controller = new ComputerController({ backend });

    await expect(controller.click({ x: 5000, y: 10 })).rejects.toThrow(
      /outside the screen, which is 1920x1080/,
    );
    expect(backend.calls).toHaveLength(0);
  });

  it('rejects a negative coordinate', async () => {
    const backend = fakeBackend();
    const controller = new ComputerController({ backend });

    await expect(controller.click({ x: -1, y: 0 })).rejects.toThrow(ComputerControlError);
  });

  it('rejects non-integer coordinates', async () => {
    const backend = fakeBackend();
    const controller = new ComputerController({ backend });

    await expect(controller.click({ x: 10.5, y: 20 })).rejects.toThrow(/integer pixel/);
  });

  it('validates both ends of a drag', async () => {
    const backend = fakeBackend();
    const controller = new ComputerController({ backend });

    await expect(controller.drag({ x: 10, y: 10 }, { x: 99999, y: 10 })).rejects.toThrow(
      /outside the screen/,
    );
    expect(backend.calls).toHaveLength(0);
  });

  it('records every action with a duration', async () => {
    const records: { action: string; success: boolean }[] = [];
    const backend = fakeBackend();
    const controller = new ComputerController({
      backend,
      onAction: (record) => records.push({ action: record.action, success: record.success }),
    });

    await controller.click({ x: 5, y: 5 });
    await controller.typeText('hello');

    expect(records.map((r) => r.action)).toEqual(['click', 'type']);
    expect(records.every((r) => r.success)).toBe(true);
  });

  it('reports the failure class when the backend throws', async () => {
    const records: { success: boolean; failureClass: string | undefined }[] = [];
    const backend = fakeBackend();
    backend.typeText = async () => {
      throw new ComputerControlError('no display', 'environment', 'xdotool');
    };
    const controller = new ComputerController({
      backend,
      onAction: (record) =>
        records.push({ success: record.success, failureClass: record.failureClass }),
    });

    await expect(controller.typeText('hi')).rejects.toThrow('no display');
    expect(records[0]?.success).toBe(false);
    expect(records[0]?.failureClass).toBe('environment');
  });

  it('builds a computer state snapshot', async () => {
    const backend = fakeBackend({ focusedWindow: WINDOW, cursor: { x: 12, y: 34 } });
    const controller = new ComputerController({ backend });

    const state = await controller.state();

    expect(state.os).toContain('Ubuntu');
    expect(state.screen).toEqual(GEOMETRY);
    expect(state.activeWindow).toBe('Chromium');
    expect(state.openApplications).toEqual(['chromium']);
    expect(state.cursor).toEqual({ x: 12, y: 34 });
  });

  it('surfaces the last failure in the state snapshot', async () => {
    const backend = fakeBackend();
    backend.openApplication = async () => {
      throw new ComputerControlError('no such app', 'application');
    };
    const controller = new ComputerController({ backend });

    await expect(controller.openApplication('nope')).rejects.toThrow();
    const state = await controller.state();

    expect(state.lastFailure).toEqual({ action: 'open_application', message: 'no such app' });
  });

  it('presses and releases hotkeys through the backend', async () => {
    const backend = fakeBackend();
    const controller = new ComputerController({ backend });

    await controller.hotkey(['ctrl', 'shift', 't']);

    expect(backend.calls).toContain('hotkey:ctrl+shift+t');
  });

  it('honours a smaller screen geometry', async () => {
    const backend = fakeBackend({ geometry: { width: 800, height: 600 } });
    const controller = new ComputerController({ backend });

    await expect(controller.click({ x: 800, y: 600 })).rejects.toThrow(/outside the screen/);
    await expect(controller.click({ x: 799, y: 599 })).resolves.toBeUndefined();
  });
});

describe('observationPolicy', () => {
  it('always captures after a failure', () => {
    expect(observationPolicy('after_failure').screenshot).toBe(true);
  });

  it('captures after navigation and major change', () => {
    expect(observationPolicy('after_navigation').screenshot).toBe(true);
    expect(observationPolicy('after_major_change').screenshot).toBe(true);
  });

  it('skips the screenshot after typing to conserve context', () => {
    expect(observationPolicy('after_typing').screenshot).toBe(false);
  });

  it('captures a click but does not re-read state', () => {
    const request = observationPolicy('after_click');
    expect(request.screenshot).toBe(true);
    expect(request.state).toBe(false);
  });
});

describe('LoopDetector', () => {
  it('flags a repeated action past the threshold', () => {
    const detector = new LoopDetector(3);

    expect(detector.record('click', { x: 1, y: 1 })).toBe(false);
    expect(detector.record('click', { x: 1, y: 1 })).toBe(false);
    expect(detector.record('click', { x: 1, y: 1 })).toBe(false);
    expect(detector.record('click', { x: 1, y: 1 })).toBe(true);
  });

  it('treats different coordinates as different actions', () => {
    const detector = new LoopDetector(1);

    detector.record('click', { x: 1, y: 1 });
    expect(detector.record('click', { x: 2, y: 2 })).toBe(false);
  });

  it('ignores key order when fingerprinting arguments', () => {
    const detector = new LoopDetector(1);

    detector.record('hotkey', { keys: ['ctrl', 'c'], x: 1 });
    expect(detector.record('hotkey', { x: 1, keys: ['ctrl', 'c'] })).toBe(true);
  });
});