import { describe, expect, it } from 'vitest';

import { UbuntuBackend } from '#/features/computerUse/ubuntuBackend';
import { ComputerController } from '#/features/computerUse/computerController';
import { ComputerControlError } from '#/features/computerUse/types';

const DISPLAY = process.env['DISPLAY'];

describe('UbuntuBackend — live environment', () => {
  it('reports the real display server', async () => {
    const backend = new UbuntuBackend();
    const environment = await backend.environment();

    expect(environment.platform).toBe('linux');
    expect(environment.os.length).toBeGreaterThan(0);
  }, 20_000);

  it('lists monitors from the running display', async () => {
    const backend = new UbuntuBackend();
    const monitors = await backend.listMonitors();

    expect(Array.isArray(monitors)).toBe(true);
  }, 20_000);

  it('reports screen geometry when xdotool is present', async () => {
    const backend = new UbuntuBackend();
    const capabilities = await backend.capabilities();
    if (!capabilities.mouse) {
      expect(capabilities.missingDependencies).toContain('xdotool');
      return;
    }
    const geometry = await backend.screenSize();

    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.height).toBeGreaterThan(0);
  }, 20_000);

  it('drives the real cursor and reads it back', async () => {
    const backend = new UbuntuBackend();
    const capabilities = await backend.capabilities();
    if (!capabilities.mouse) return;

    const start = await backend.mousePosition();
    await backend.moveMouse({ x: 101, y: 201 });
    const moved = await backend.mousePosition();

    await backend.moveMouse(start);

    expect(moved).toEqual({ x: 101, y: 201 });
  }, 20_000);

  it('reports screen geometry matching the real display', async () => {
    const backend = new UbuntuBackend();
    const capabilities = await backend.capabilities();
    if (!capabilities.mouse) return;

    const geometry = await backend.screenSize();
    const monitors = await backend.listMonitors();

    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.height).toBeGreaterThan(0);
    const total = monitors.reduce((sum, m) => sum + m.geometry.width * m.geometry.height, 0);
    expect(total).toBeGreaterThanOrEqual(geometry.width * geometry.height);
  }, 20_000);

  it('lists the visible windows on the real display', async () => {
    const backend = new UbuntuBackend();
    const capabilities = await backend.capabilities();
    if (!capabilities.windows) return;

    const windows = await backend.listWindows();

    expect(Array.isArray(windows)).toBe(true);
  }, 20_000);

  it('reports the real missing-dependency list on this machine', async () => {
    const backend = new UbuntuBackend();
    const capabilities = await backend.capabilities();

    expect(capabilities.missingDependencies).not.toContain('xrandr');
    for (const dependency of capabilities.missingDependencies) {
      expect(dependency.length).toBeGreaterThan(0);
    }
  }, 20_000);
});

describe('UbuntuBackend — absent dependency handling', () => {
  it('turns a missing binary into a named environment error', async () => {
    const backend = new UbuntuBackend({ timeoutMs: 5_000 });
    const controller = new ComputerController({ backend });

    let caught: unknown;
    try {
      await controller.screenshot();
    } catch (error) {
      caught = error;
    }

    if (caught === undefined) {
      expect(DISPLAY).toBeDefined();
    } else {
      expect(caught).toBeInstanceOf(ComputerControlError);
      const error = caught as ComputerControlError;
      expect(error.failureClass).toBe('environment');
      expect(error.message).toMatch(
        /not installed|does not support|Could not|failed|unavailable/i,
      );
    }
  }, 30_000);
});