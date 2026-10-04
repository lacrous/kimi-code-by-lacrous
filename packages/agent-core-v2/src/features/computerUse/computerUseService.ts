import { Service } from '#/_base/di/service';
import { createDecorator } from '#/_base/di/instantiation';
import type { MediaStore } from '#/human/llm/media/store';

import {
  ComputerController,
  type ComputerControllerOptions,
} from '#/features/computerUse/computerController';
import type {
  ComputerBackend,
  ComputerCapabilities,
  ComputerEnvironment,
  Screenshot,
  WindowInfo,
} from '#/features/computerUse/types';
import type { ComputerState } from '#/features/computerUse/observation';
import { ComputerControlError } from '#/features/computerUse/types';
import { UbuntuBackend } from '#/features/computerUse/ubuntuBackend';

export interface ComputerUseOptions {
  readonly backend?: ComputerBackend;
  readonly controller?: Omit<ComputerControllerOptions, 'backend'>;
  readonly mediaStore?: MediaStore;
}

export class AgentComputerUseService extends Service {
  private _controller: ComputerController | undefined;
  private readonly _backendOverride: ComputerBackend | undefined;
  private readonly _controllerOptions: Omit<ComputerControllerOptions, 'backend'>;
  private readonly _mediaStore: MediaStore | undefined;

  constructor(options?: ComputerUseOptions) {
    super();
    this._backendOverride = options?.backend;
    this._controllerOptions = options?.controller ?? {};
    this._mediaStore = options?.mediaStore;
  }

  get backend(): ComputerBackend {
    return this._backendOverride ?? new UbuntuBackend();
  }

  get controller(): ComputerController {
    this._controller ??= new ComputerController({
      backend: this.backend,
      ...this._controllerOptions,
    });
    return this._controller;
  }

  environment(): Promise<ComputerEnvironment> {
    return this.controller.environment();
  }

  capabilities(): Promise<ComputerCapabilities> {
    return this.controller.capabilities();
  }

  computerState(): Promise<ComputerState> {
    return this.controller.state();
  }

  screenshot(): Promise<Screenshot> {
    return this.controller.screenshot();
  }

  windows(): Promise<readonly WindowInfo[]> {
    return this.backend.listWindows();
  }

  async putScreenshot(bytes: Uint8Array): Promise<string> {
    const store = this._mediaStore;
    if (store === undefined) {
      throw new ComputerControlError(
        'Computer use needs a media store to deliver a screenshot to the model.',
        'environment',
      );
    }
    return store.put({ bytes, mimeType: 'image/png', filename: 'screenshot.png' });
  }
}

export interface IAgentComputerUseService {
  readonly _serviceBrand: undefined;
  readonly backend: ComputerBackend;
  readonly controller: ComputerController;
  environment(): Promise<ComputerEnvironment>;
  capabilities(): Promise<ComputerCapabilities>;
  computerState(): Promise<ComputerState>;
  screenshot(): Promise<Screenshot>;
  windows(): Promise<readonly WindowInfo[]>;
  putScreenshot(bytes: Uint8Array): Promise<string>;
}

export const IAgentComputerUseService = createDecorator<IAgentComputerUseService>(
  'agentComputerUseService',
);
