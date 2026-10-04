import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

import { COMPUTER_USE_FLAG_ID } from './computerUse';
import { isComputerUseFeatureAssembled } from './computerUseFeature';

export const COMPUTER_USE_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_COMPUTER_USE';

export const computerUseFlag: FlagDefinitionInput = {
  id: COMPUTER_USE_FLAG_ID,
  title: 'Computer use',
  description:
    'Enable the computer-control tools: capture the screen, click, type, press keys and launch applications on the local desktop.',
  env: COMPUTER_USE_FLAG_ENV,
  default: false,
  surface: 'both',
  isExposed: (flags) => isComputerUseFeatureAssembled(flags),
};

registerFlagDefinition(computerUseFlag);