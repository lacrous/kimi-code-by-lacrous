import {
  ComputerControlError,
  type ComputerBackend,
  type ComputerCapabilities,
  type ComputerEnvironment,
  type MouseButton,
  type Point,
  type ScreenGeometry,
  type Screenshot,
  type WindowInfo,
} from '#/features/computerUse/types';
import {
  LoopDetector,
  type ActionRecord,
  type ActionFailureClass,
  type ComputerState,
} from '#/features/computerUse/observation';

export interface ComputerControllerOptions {
  readonly backend: ComputerBackend;
  readonly loopThreshold?: number;
  readonly onAction?: (record: ActionRecord) => void;
  readonly now?: () => number;
}

export interface ActionOutcome {
  readonly success: boolean;
  readonly action: string;
  readonly failureClass: ActionFailureClass | undefined;
  readonly error: string | undefined;
  readonly observation: {
    readonly screenshot: Screenshot | undefined;
    readonly state: ComputerState | undefined;
    readonly loopDetected: boolean;
  };
}

export class ComputerController {
  private readonly _backend: ComputerBackend;
  private readonly _loopDetector: LoopDetector;
  private readonly _onAction: ((record: ActionRecord) => void) | undefined;
  private readonly _now: () => number;
  private _lastAction: string | undefined;
  private _lastFailure: { action: string; message: string } | undefined;

  constructor(options: ComputerControllerOptions) {
    this._backend = options.backend;
    this._loopDetector = new LoopDetector(options.loopThreshold ?? 5);
    this._onAction = options.onAction;
    this._now = options.now ?? Date.now;
  }

  environment(): Promise<ComputerEnvironment> {
    return this._backend.environment();
  }

  capabilities(): Promise<ComputerCapabilities> {
    return this._backend.capabilities();
  }

  async screenSize(): Promise<ScreenGeometry> {
    return this._backend.screenSize();
  }

  async screenshot(target?: WindowInfo | 'screen'): Promise<Screenshot> {
    return this._run('screenshot', {}, () => this._backend.screenshot(target));
  }

  async click(point: Point, button: MouseButton = 'left'): Promise<void> {
    const checked = await this._validatePoint(point);
    return this._run('click', { ...point, button }, () => this._backend.click(checked, button));
  }

  async doubleClick(point: Point): Promise<void> {
    const checked = await this._validatePoint(point);
    return this._run('double_click', { ...point }, () => this._backend.doubleClick(checked));
  }

  async drag(from: Point, to: Point): Promise<void> {
    const start = await this._validatePoint(from);
    const end = await this._validatePoint(to);
    return this._run('drag', { from, to }, () => this._backend.drag(start, end));
  }

  async scroll(delta: { x: number; y: number }): Promise<void> {
    return this._run('scroll', delta, () => this._backend.scroll(delta));
  }

  async typeText(text: string): Promise<void> {
    return this._run('type', { length: text.length }, () => this._backend.typeText(text));
  }

  async pressKey(key: string): Promise<void> {
    return this._run('press_key', { key }, () => this._backend.pressKey(key));
  }

  async hotkey(keys: readonly string[]): Promise<void> {
    return this._run('hotkey', { keys }, () => this._backend.hotkey(keys));
  }

  async openApplication(name: string): Promise<void> {
    return this._run('open_application', { name }, () => this._backend.openApplication(name));
  }

  async state(): Promise<ComputerState> {
    const [environment, geometry, activeWindow, applications, cursor] = await Promise.all([
      this._backend.environment(),
      this._backend.screenSize(),
      this._backend.activeWindow(),
      this._backend.listApplications(),
      this._backend.mousePosition(),
    ]);
    return {
      os: `${environment.os} (${environment.displayServer})`,
      screen: geometry,
      activeWindow: activeWindow?.title,
      openApplications: applications.map((a) => a.name),
      cursor,
      lastAction: this._lastAction,
      lastFailure: this._lastFailure,
    };
  }

  private async _validatePoint(point: Point): Promise<Point> {
    if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) {
      throw new ComputerControlError(
        `Point (${String(point.x)}, ${String(point.y)}) must use integer pixel coordinates.`,
        'invalid_action',
      );
    }
    const geometry = await this._backend.screenSize();
    if (point.x < 0 || point.y < 0 || point.x >= geometry.width || point.y >= geometry.height) {
      throw new ComputerControlError(
        `Point (${String(point.x)}, ${String(point.y)}) is outside the screen, which is ` +
          `${String(geometry.width)}x${String(geometry.height)}.`,
        'invalid_action',
      );
    }
    return point;
  }

  private async _run<T>(
    action: string,
    args: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = this._now();
    try {
      const result = await fn();
      this._lastAction = action;
      this._lastFailure = undefined;
      this._report(action, args, startedAt, true);
      return result;
    } catch (error) {
      const failureClass =
        error instanceof ComputerControlError ? error.failureClass : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      this._lastAction = action;
      this._lastFailure = { action, message };
      this._report(action, args, startedAt, false, failureClass, message);
      throw error;
    }
  }

  private _report(
    action: string,
    args: Record<string, unknown>,
    startedAt: number,
    success: boolean,
    failureClass?: ActionFailureClass,
    error?: string,
  ): void {
    this._onAction?.({
      action,
      arguments: args,
      startedAt,
      durationMs: this._now() - startedAt,
      success,
      failureClass,
      error,
    });
  }

  detectLoop(action: string, args: Record<string, unknown>): boolean {
    return this._loopDetector.record(action, args);
  }
}
