export const ACTION_FAILURE_CLASSES = [
  'transient',
  'environment',
  'invalid_action',
  'authentication',
  'network',
  'application',
  'tool',
  'model',
  'unknown',
] as const;

export type ActionFailureClass = (typeof ACTION_FAILURE_CLASSES)[number];

export interface ActionRecord {
  readonly action: string;
  readonly arguments: Record<string, unknown>;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly success: boolean;
  readonly failureClass: ActionFailureClass | undefined;
  readonly error: string | undefined;
}

export interface ObservationRequest {
  readonly screenshot: boolean;
  readonly state: boolean;
  readonly reason: ObservationReason;
}

export type ObservationReason =
  | 'after_navigation'
  | 'after_major_change'
  | 'after_click'
  | 'after_typing'
  | 'after_failure'
  | 'before_important_action'
  | 'manual';

export interface ComputerState {
  readonly os: string;
  readonly screen: { readonly width: number; readonly height: number };
  readonly activeWindow: string | undefined;
  readonly openApplications: readonly string[];
  readonly cursor: { readonly x: number; readonly y: number };
  readonly lastAction: string | undefined;
  readonly lastFailure: { readonly action: string; readonly message: string } | undefined;
}

const AFTER_NAVIGATION = new Set<ObservationReason>(['after_navigation', 'after_major_change']);

export function observationPolicy(reason: ObservationReason): ObservationRequest {
  if (reason === 'after_failure') {
    return { screenshot: true, state: true, reason };
  }
  if (AFTER_NAVIGATION.has(reason)) {
    return { screenshot: true, state: true, reason };
  }
  if (reason === 'before_important_action') {
    return { screenshot: true, state: true, reason };
  }
  if (reason === 'after_click') {
    return { screenshot: true, state: false, reason };
  }
  if (reason === 'after_typing') {
    return { screenshot: false, state: false, reason };
  }
  return { screenshot: true, state: true, reason };
}

export class LoopDetector {
  private readonly _seen = new Map<string, number>();
  private readonly _threshold: number;

  constructor(threshold = 5) {
    this._threshold = threshold;
  }

  record(action: string, arguments_: Record<string, unknown>): boolean {
    const key = `${action}:${JSON.stringify(sortKeys(arguments_))}`;
    const count = (this._seen.get(key) ?? 0) + 1;
    this._seen.set(key, count);
    return count > this._threshold;
  }

  reset(): void {
    this._seen.clear();
  }
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : 1)));
}
