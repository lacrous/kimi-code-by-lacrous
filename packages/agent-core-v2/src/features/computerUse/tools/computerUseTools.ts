import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';

import {
  IAgentComputerUseService,
  type AgentComputerUseService,
} from '#/features/computerUse/computerUseService';
import type { Screenshot } from '#/features/computerUse/types';

import {
  ComputerApplicationInputSchema,
  ComputerClickInputSchema,
  ComputerKeyInputSchema,
  ComputerScreenshotInputSchema,
  ComputerTypeInputSchema,
  describeFailure,
  formatScreenshot,
  IComputerApplicationTool,
  IComputerClickTool,
  IComputerKeyTool,
  IComputerScreenshotTool,
  IComputerTypeTool,
  type ComputerApplicationInput,
  type ComputerClickInput,
  type ComputerKeyInput,
  type ComputerScreenshotInput,
  type ComputerTypeInput,
} from './computer-use';

import SCREENSHOT_DESCRIPTION from './computer-screenshot.md?raw';
import CLICK_DESCRIPTION from './computer-click.md?raw';
import TYPE_DESCRIPTION from './computer-type.md?raw';
import KEY_DESCRIPTION from './computer-key.md?raw';
import APPLICATION_DESCRIPTION from './computer-application.md?raw';

export const COMPUTER_SCREENSHOT_TOOL_NAME = 'ComputerScreenshot';
export const COMPUTER_CLICK_TOOL_NAME = 'ComputerClick';
export const COMPUTER_TYPE_TOOL_NAME = 'ComputerType';
export const COMPUTER_KEY_TOOL_NAME = 'ComputerKey';
export const COMPUTER_APPLICATION_TOOL_NAME = 'ComputerApplication';

export class ComputerScreenshotTool implements IComputerScreenshotTool {
  declare readonly _serviceBrand: undefined;
  readonly name = COMPUTER_SCREENSHOT_TOOL_NAME;
  readonly description: string = SCREENSHOT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ComputerScreenshotInputSchema);

  constructor(@IAgentComputerUseService private readonly computer: AgentComputerUseService) {}

  private get controller(): AgentComputerUseService['controller'] {
    return this.computer.controller;
  }

  private async _put(bytes: Uint8Array): Promise<string> {
    return this.computer.putScreenshot(bytes);
  }

  resolveExecution(args: ComputerScreenshotInput): ToolExecution {
    return {
      description: 'Capturing the screen',
      approvalRule: this.name,
      execute: async () => {
        const shot = await this._capture(args.target ?? 'screen');
        const url = await this._put(shot.png);
        return {
          isError: false as const,
          output: [
            { type: 'text' as const, text: `<screenshot>\n${formatScreenshot(shot)}\n</screenshot>` },
            { type: 'image_url' as const, imageUrl: { url } },
          ],
        };
      },
    };
  }

  private async _capture(target: 'screen' | 'active_window'): Promise<Screenshot> {
    if (target === 'screen') {
      return this.controller.screenshot();
    }
    const active = await this.controller.screenshot();
    return active;
  }
}

export class ComputerClickTool implements IComputerClickTool {
  declare readonly _serviceBrand: undefined;
  readonly name = COMPUTER_CLICK_TOOL_NAME;
  readonly description: string = CLICK_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ComputerClickInputSchema);

  constructor(@IAgentComputerUseService private readonly computer: AgentComputerUseService) {}

  private get controller(): AgentComputerUseService['controller'] {
    return this.computer.controller;
  }

  resolveExecution(args: ComputerClickInput): ToolExecution {
    const point = { x: args.x, y: args.y };
    const button = args.button ?? 'left';
    return {
      description: `${args.double === true ? 'Double-clicking' : 'Clicking'} at (${String(args.x)}, ${String(args.y)})`,
      approvalRule: this.name,
      execute: async () => {
        try {
          if (args.double === true) {
            await this.controller.doubleClick(point);
          } else {
            await this.controller.click(point, button);
          }
          return { isError: false, output: `Clicked (${String(args.x)}, ${String(args.y)}) with the ${button} button.` };
        } catch (error) {
          return { isError: true, output: describeFailure(error) };
        }
      },
    };
  }
}

export class ComputerTypeTool implements IComputerTypeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = COMPUTER_TYPE_TOOL_NAME;
  readonly description: string = TYPE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ComputerTypeInputSchema);

  constructor(@IAgentComputerUseService private readonly computer: AgentComputerUseService) {}

  private get controller(): AgentComputerUseService['controller'] {
    return this.computer.controller;
  }

  resolveExecution(args: ComputerTypeInput): ToolExecution {
    return {
      description: `Typing ${String(args.text.length)} characters`,
      approvalRule: this.name,
      execute: async () => {
        try {
          await this.controller.typeText(args.text);
          return { isError: false, output: `Typed ${String(args.text.length)} characters.` };
        } catch (error) {
          return { isError: true, output: describeFailure(error) };
        }
      },
    };
  }
}

export class ComputerKeyTool implements IComputerKeyTool {
  declare readonly _serviceBrand: undefined;
  readonly name = COMPUTER_KEY_TOOL_NAME;
  readonly description: string = KEY_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ComputerKeyInputSchema);

  constructor(@IAgentComputerUseService private readonly computer: AgentComputerUseService) {}

  private get controller(): AgentComputerUseService['controller'] {
    return this.computer.controller;
  }

  resolveExecution(args: ComputerKeyInput): ToolExecution {
    const combo = args.keys.join('+');
    return {
      description: `Pressing ${combo}`,
      approvalRule: this.name,
      execute: async () => {
        try {
          if (args.keys.length === 1) {
            await this.controller.pressKey(args.keys[0] as string);
          } else {
            await this.controller.hotkey(args.keys);
          }
          return { isError: false, output: `Pressed ${combo}.` };
        } catch (error) {
          return { isError: true, output: describeFailure(error) };
        }
      },
    };
  }
}

export class ComputerApplicationTool implements IComputerApplicationTool {
  declare readonly _serviceBrand: undefined;
  readonly name = COMPUTER_APPLICATION_TOOL_NAME;
  readonly description: string = APPLICATION_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ComputerApplicationInputSchema);

  constructor(@IAgentComputerUseService private readonly computer: AgentComputerUseService) {}

  private get controller(): AgentComputerUseService['controller'] {
    return this.computer.controller;
  }

  resolveExecution(args: ComputerApplicationInput): ToolExecution {
    return {
      description: `Opening ${args.name}`,
      approvalRule: this.name,
      execute: async () => {
        try {
          await this.controller.openApplication(args.name);
          return { isError: false, output: `Opened ${args.name}.` };
        } catch (error) {
          return { isError: true, output: describeFailure(error) };
        }
      },
    };
  }
}
