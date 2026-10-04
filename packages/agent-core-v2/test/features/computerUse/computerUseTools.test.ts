import { describe, expect, it, vi } from 'vitest';

import type { ToolExecution } from '#/tool/toolContract';
import { ComputerController } from '#/features/computerUse/computerController';
import type { AgentComputerUseService } from '#/features/computerUse/computerUseService';
import {
  ComputerClickTool,
  ComputerKeyTool,
  ComputerScreenshotTool,
  ComputerTypeTool,
} from '#/features/computerUse/tools/computerUseTools';
import { ComputerControlError } from '#/features/computerUse/types';

const CONTEXT = {
  turnId: 1,
  toolCallId: 'call-1',
  signal: new AbortController().signal,
} as const;

const GEOMETRY = { width: 1920, height: 1080 };

function makeBackend(): AgentComputerUseService['backend'] {
  return {
    environment: async () => ({ os: 'Ubuntu', platform: 'linux' as const, displayServer: 'x11' as const }),
    capabilities: async () => ({
      screen: true,
      mouse: true,
      keyboard: true,
      windows: true,
      applications: true,
      missingDependencies: [],
    }),
    screenSize: async () => GEOMETRY,
    listMonitors: async () => [],
    screenshot: async () => ({
      width: GEOMETRY.width,
      height: GEOMETRY.height,
      png: new Uint8Array([0x89, 0x50]),
      capturedAt: 1_700_000_000_000,
      activeWindow: { id: 'w1', title: 'Chromium', application: 'chromium', geometry: { width: 800, height: 600 }, x: 0, y: 0, focused: true, minimized: false },
    }),
    activeWindow: async () => undefined,
    listWindows: async () => [],
    moveMouse: async () => {},
    mousePosition: async () => ({ x: 0, y: 0 }),
    click: async () => {},
    doubleClick: async () => {},
    drag: async () => {},
    scroll: async () => {},
    typeText: async () => {},
    pressKey: async () => {},
    hotkey: async () => {},
    keyDown: async () => {},
    keyUp: async () => {},
    listApplications: async () => [],
    openApplication: async () => {},
    closeApplication: async () => {},
    focusWindow: async () => {},
    minimizeWindow: async () => {},
    maximizeWindow: async () => {},
    moveWindow: async () => {},
    resizeWindow: async () => {},
  } as unknown as AgentComputerUseService['backend'];
}

interface ServiceOverrides {
  readonly backend?: AgentComputerUseService['backend'];
  readonly putScreenshot?: (bytes: Uint8Array) => Promise<string>;
}

function makeService(overrides: ServiceOverrides = {}): AgentComputerUseService {
  const backend = overrides.backend ?? makeBackend();
  const controller = new ComputerController({ backend });
  return {
    controller,
    backend,
    environment: () => controller.environment(),
    capabilities: () => controller.capabilities(),
    computerState: () => controller.state(),
    screenshot: () => controller.screenshot(),
    windows: () => backend.listWindows(),
    putScreenshot: overrides.putScreenshot ?? (async () => 'media:screenshot-hash'),
  } as unknown as AgentComputerUseService;
}

async function run(
  tool: { resolveExecution(input: unknown): ToolExecution },
  input: unknown,
): Promise<{ isError: boolean; output: unknown }> {
  const execution = tool.resolveExecution(input);
  if (!('execute' in execution)) return execution as { isError: boolean; output: unknown };
  return (await execution.execute(CONTEXT)) as { isError: boolean; output: unknown };
}

describe('ComputerScreenshotTool', () => {
  it('returns the frame as an image_url part plus a text summary', async () => {
    const service = makeService();
    const tool = new ComputerScreenshotTool(service);

    const result = await run(tool, { target: 'screen' });

    expect(result.isError).toBeFalsy();
    const parts = result.output as { type: string; text?: string; imageUrl?: { url: string } }[];
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url']);
    expect(parts[0]?.text).toContain('1920x1080');
    expect(parts[1]?.imageUrl?.url).toBe('media:screenshot-hash');
  });

  it('reports the geometry even when no window is focused', async () => {
    const backend = makeBackend();
    backend.screenshot = async () => ({
      width: GEOMETRY.width,
      height: GEOMETRY.height,
      png: new Uint8Array([0x89, 0x50]),
      capturedAt: 1_700_000_000_000,
      activeWindow: undefined,
    });
    const service = makeService({ backend });

    const result = await run(new ComputerScreenshotTool(service), {});
    const parts = result.output as { type: string; text?: string }[];

    expect(parts[0]?.text).toContain('Captured 1920x1080');
    expect(parts[0]?.text).not.toContain('Active window');
  });

  it('surfaces a missing dependency as an error result', async () => {
    const service = makeService({
      putScreenshot: async () => {
        throw new ComputerControlError('requires "import"', 'environment', 'import');
      },
    });
    const tool = new ComputerScreenshotTool(service);

    await expect(run(tool, {})).rejects.toThrow(/requires "import"/);
  });

  it('names the tool so approval rules can match it', () => {
    const tool = new ComputerScreenshotTool(makeService());
    const execution = tool.resolveExecution({});

    expect(tool.name).toBe('ComputerScreenshot');
    if ('execute' in execution) {
      expect(execution.approvalRule).toBe('ComputerScreenshot');
    }
  });
});

describe('ComputerClickTool', () => {
  it('confirms a click with its coordinates', async () => {
    const tool = new ComputerClickTool(makeService());
    const result = await run(tool, { x: 100, y: 200, button: 'left' });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('(100, 200)');
  });

  it('reports an out-of-bounds click as an error result, not a throw', async () => {
    const tool = new ComputerClickTool(makeService());
    const result = await run(tool, { x: 5000, y: 200, button: 'left' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('outside the screen');
  });

  it('defaults the button to left', async () => {
    const click = vi.fn();
    const backend = makeBackend();
    backend.click = click;
    const service = makeService({ backend });

    await run(new ComputerClickTool(service), { x: 10, y: 10, button: undefined as never });

    expect(click).toHaveBeenCalledWith({ x: 10, y: 10 }, 'left');
  });
});

describe('ComputerTypeTool', () => {
  it('confirms how much was typed without echoing the text', async () => {
    const tool = new ComputerTypeTool(makeService());
    const result = await run(tool, { text: 'hello world' });

    expect(result.output).toContain('Typed 11 characters');
    expect(result.output).not.toContain('hello world');
  });

  it('reports a typing failure', async () => {
    const backend = makeBackend();
    backend.typeText = async () => {
      throw new ComputerControlError('xdotool missing', 'environment', 'xdotool');
    };
    const service = makeService({ backend });

    const result = await run(new ComputerTypeTool(service), { text: 'x' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('(environment)');
  });
});

describe('ComputerKeyTool', () => {
  it('sends a single key through pressKey', async () => {
    const pressKey = vi.fn();
    const hotkey = vi.fn();
    const backend = makeBackend();
    backend.pressKey = pressKey;
    backend.hotkey = hotkey;
    const service = makeService({ backend });

    await run(new ComputerKeyTool(service), { keys: ['Return'] });

    expect(pressKey).toHaveBeenCalledWith('Return');
    expect(hotkey).not.toHaveBeenCalled();
  });

  it('sends a combination through hotkey in order', async () => {
    const hotkey = vi.fn();
    const backend = makeBackend();
    backend.hotkey = hotkey;
    const service = makeService({ backend });

    await run(new ComputerKeyTool(service), { keys: ['ctrl', 'shift', 't'] });

    expect(hotkey).toHaveBeenCalledWith(['ctrl', 'shift', 't']);
  });
});

describe('tool schemas', () => {
  it('exposes an object schema for the model', () => {
    for (const tool of [
      new ComputerScreenshotTool(makeService()),
      new ComputerClickTool(makeService()),
      new ComputerTypeTool(makeService()),
      new ComputerKeyTool(makeService()),
    ]) {
      expect(tool.parameters).toMatchObject({ type: 'object' });
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('describes x and y as integers so the model does not send floats', () => {
    const schema = new ComputerClickTool(makeService()).parameters as {
      properties: { x: { type: string }; y: { type: string } };
    };

    expect(schema.properties.x.type).toBe('integer');
    expect(schema.properties.y.type).toBe('integer');
  });
});
