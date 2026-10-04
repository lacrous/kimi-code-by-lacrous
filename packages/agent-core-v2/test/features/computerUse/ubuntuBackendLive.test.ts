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
      expect(error.message).toMatch(/not installed|does not support|Could not|failed/i);
    }
  }, 30_000);
});