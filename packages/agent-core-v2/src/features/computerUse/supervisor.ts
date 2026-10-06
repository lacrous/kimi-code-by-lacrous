import type { ActionFailureClass } from '#/features/computerUse/observation';

export const SUPERVISOR_DECISIONS = [
  'continue',
  'goal_complete',
  'goal_blocked',
  'stop_max_actions',
  'stop_deadline',
  'stop_budget',
  'stop_loop',
] as const;

export type SupervisorDecision = (typeof SUPERVISOR_DECISIONS)[number];

export const MAX_RETRY_CLASSES: readonly ActionFailureClass[] = [
  'transient',
  'network',
  'tool',
];

export function isRetryable(classification: ActionFailureClass): boolean {
  return MAX_RETRY_CLASSES.includes(classification);
}

export interface SupervisorLimits {
  readonly maxActions: number;
  readonly maxRetries: number;
  readonly deadline: number | undefined;
  readonly spentUnits: number;
  readonly budgetUnits: number | undefined;
}

export const DEFAULT_SUPERVISOR_LIMITS: SupervisorLimits = {
  maxActions: 500,
  maxRetries: 8,
  deadline: undefined,
  spentUnits: 0,
  budgetUnits: undefined,
};

export interface SupervisorState {
  readonly actions: number;
  readonly failures: Map<string, number>;
  readonly lastAction: string | undefined;
  readonly completed: boolean;
  readonly blockedReason: string | undefined;
}

export interface SupervisorInput extends SupervisorLimits {
  readonly state: SupervisorState;
  readonly action: string;
  readonly fingerprint: string;
  readonly failureClass: ActionFailureClass | undefined;
  readonly repeatedCount: number;
}

export interface SupervisorOutcome {
  readonly decision: SupervisorDecision;
  readonly reason: string;
}

export function decideNext(input: SupervisorInput): SupervisorOutcome {
  if (input.state.completed) {
    return { decision: 'goal_complete', reason: 'the goal was already marked complete' };
  }

  if (input.state.blockedReason !== undefined) {
    return { decision: 'goal_blocked', reason: input.state.blockedReason };
  }

  if (input.deadline !== undefined && Date.now() >= input.deadline) {
    return { decision: 'stop_deadline', reason: 'the deadline has passed' };
  }

  if (input.budgetUnits !== undefined && input.spentUnits >= input.budgetUnits) {
    return { decision: 'stop_budget', reason: 'the budget is exhausted' };
  }

  if (input.state.actions >= input.maxActions) {
    return {
      decision: 'stop_max_actions',
      reason: `reached the limit of ${String(input.maxActions)} actions`,
    };
  }

  if (input.failureClass !== undefined && input.repeatedCount > input.maxRetries) {
    return {
      decision: 'stop_loop',
      reason: `the same action failed ${String(input.repeatedCount)} times`,
    };
  }

  return { decision: 'continue', reason: 'proceeding' };
}

export function shouldRetry(classification: ActionFailureClass, attempts: number, maxRetries: number): boolean {
  return isRetryable(classification) && attempts <= maxRetries;
}

export function backoffDelayMs(attempts: number, baseMs = 500, maxMs = 30_000): number {
  const exponential = baseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(exponential, maxMs);
}

export function emptySupervisorState(): SupervisorState {
  return { actions: 0, failures: new Map(), lastAction: undefined, completed: false, blockedReason: undefined };
}

export function recordAction(
  state: SupervisorState,
  fingerprint: string,
  failureClass: ActionFailureClass | undefined,
): SupervisorState {
  const failures = new Map(state.failures);
  if (failureClass === undefined) {
    failures.delete(fingerprint);
  } else {
    failures.set(fingerprint, (failures.get(fingerprint) ?? 0) + 1);
  }
  return {
    actions: state.actions + 1,
    failures,
    lastAction: fingerprint,
    completed: state.completed,
    blockedReason: state.blockedReason,
  };
}

export function failureCountFor(state: SupervisorState, fingerprint: string): number {
  return state.failures.get(fingerprint) ?? 0;
}
