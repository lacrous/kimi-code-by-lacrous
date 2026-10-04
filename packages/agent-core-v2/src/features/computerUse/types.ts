import type { ActionFailureClass } from '#/features/computerUse/observation';

export interface ScreenGeometry {
  readonly width: number;
  readonly height: number;
}

export interface MonitorInfo {
  readonly index: number;
  readonly name: string;
  readonly geometry: ScreenGeometry;
  readonly primary: boolean;
}

export interface WindowInfo {
  readonly id: string;
  readonly title: string;
  readonly application: string;
  readonly geometry: ScreenGeometry;
  readonly x: number;
  readonly y: number;
  readonly focused: boolean;
  readonly minimized: boolean;
}

export interface Screenshot {
  readonly width: number;
  readonly height: number;
  readonly png: Uint8Array;
  readonly capturedAt: number;
  readonly activeWindow: WindowInfo | undefined;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface ScrollDelta {
  readonly x: number;
  readonly y: number;
}

export interface ComputerEnvironment {
  readonly os: string;
  readonly platform: 'linux' | 'darwin' | 'win32';
  readonly displayServer: 'x11' | 'wayland' | 'unknown';
}

export interface ApplicationInfo {
  readonly name: string;
  readonly pid: number;
  readonly active: boolean;
}

export interface ComputerCapabilities {
  readonly screen: boolean;
  readonly mouse: boolean;
  readonly keyboard: boolean;
  readonly windows: boolean;
  readonly applications: boolean;
  readonly missingDependencies: readonly string[];
}

export interface ComputerBackend {
  environment(): Promise<ComputerEnvironment>;
  capabilities(): Promise<ComputerCapabilities>;
  screenSize(): Promise<ScreenGeometry>;
  listMonitors(): Promise<readonly MonitorInfo[]>;
  screenshot(target?: WindowInfo | 'screen'): Promise<Screenshot>;
  activeWindow(): Promise<WindowInfo | undefined>;
  listWindows(): Promise<readonly WindowInfo[]>;
  moveMouse(point: Point): Promise<void>;
  mousePosition(): Promise<Point>;
  click(point: Point, button: MouseButton): Promise<void>;
  doubleClick(point: Point): Promise<void>;
  drag(from: Point, to: Point): Promise<void>;
  scroll(delta: ScrollDelta): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  hotkey(keys: readonly string[]): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  listApplications(): Promise<readonly ApplicationInfo[]>;
  openApplication(name: string): Promise<void>;
  closeApplication(name: string): Promise<void>;
  focusWindow(id: string): Promise<void>;
  minimizeWindow(id: string): Promise<void>;
  maximizeWindow(id: string): Promise<void>;
  moveWindow(id: string, point: Point): Promise<void>;
  resizeWindow(id: string, geometry: ScreenGeometry): Promise<void>;
}

export type MouseButton = 'left' | 'right' | 'middle';

export class ComputerControlError extends Error {
  readonly failureClass: ActionFailureClass;
  readonly dependency: string | undefined;

  constructor(
    message: string,
    failureClass: ActionFailureClass,
    dependency?: string,
  ) {
    super(message);
    this.name = 'ComputerControlError';
    this.failureClass = failureClass;
    this.dependency = dependency;
  }
}

export function missingDependencyError(dependency: string): ComputerControlError {
  return new ComputerControlError(
    `Computer control requires "${dependency}", which is not installed. Install it and retry.`,
    'environment',
    dependency,
  );
}

export function unsupportedOperationError(operation: string): ComputerControlError {
  return new ComputerControlError(
    `The active display server does not support "${operation}".`,
    'environment',
  );
}