import type { ServiceIdentifier } from '#/_base/di/instantiation';
import type { AgentToolCtor, AnyAgentTool } from '#/agent/toolRegistry/toolContribution';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { AgentComputerUseService, IAgentComputerUseService } from '#/features/computerUse/computerUseService';
import { COMPUTER_USE_FLAG_ID } from './computerUse';
import {
  IComputerApplicationTool,
  IComputerClickTool,
  IComputerKeyTool,
  IComputerScreenshotTool,
  IComputerTypeTool,
} from './tools/computer-use';
import {
  ComputerApplicationTool,
  ComputerClickTool,
  ComputerKeyTool,
  ComputerScreenshotTool,
  ComputerTypeTool,
} from './tools/computerUseTools';

interface ComputerToolContribution {
  readonly id: ServiceIdentifier<AnyAgentTool>;
  readonly ctor: AgentToolCtor;
  readonly name: string;
}

export const COMPUTER_TOOL_CONTRIBUTIONS: readonly ComputerToolContribution[] = [
  { id: IComputerScreenshotTool, ctor: ComputerScreenshotTool, name: 'ComputerScreenshot' },
  { id: IComputerClickTool, ctor: ComputerClickTool, name: 'ComputerClick' },
  { id: IComputerTypeTool, ctor: ComputerTypeTool, name: 'ComputerType' },
  { id: IComputerKeyTool, ctor: ComputerKeyTool, name: 'ComputerKey' },
  { id: IComputerApplicationTool, ctor: ComputerApplicationTool, name: 'ComputerApplication' },
];

export class ComputerUseFeature extends Feature {
  static override readonly name = 'computerUse';

  constructor(@IFlagService flags: IFlagService) {
    super();
    if (!flags.enabled(COMPUTER_USE_FLAG_ID)) return;
    assembledFlagServices.add(flags);
    this.onDispose(() => {
      assembledFlagServices.delete(flags);
    });
    this.contributeService(LifecycleScope.Agent, IAgentComputerUseService, AgentComputerUseService);
    for (const tool of COMPUTER_TOOL_CONTRIBUTIONS) {
      this.contributeTool(tool.id, tool.ctor, { name: tool.name, domain: 'computer' });
    }
  }
}

const assembledFlagServices = new WeakSet<IFlagService>();
let assembledOverrideForTests: boolean | undefined;

export function isComputerUseFeatureAssembled(flags: IFlagService): boolean {
  return assembledOverrideForTests ?? assembledFlagServices.has(flags);
}

export function _setComputerUseFeatureAssembledForTests(value: boolean | undefined): void {
  assembledOverrideForTests = value;
}

registerFeature(ComputerUseFeature);