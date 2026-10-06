import type { ActionFailureClass } from '#/features/computerUse/observation';
import type { RunCheckpoint } from '#/features/computerUse/runSupervisor';
import type { SupervisorDecision } from '#/features/computerUse/supervisor';

export const STOP_DECISIONS: readonly SupervisorDecision[] = [
  'goal_complete',
  'goal_blocked',
  'stop_max_actions',
  'stop_deadline',
  'stop_budget',
  'stop_loop',
];

export function isStop(decision: SupervisorDecision): boolean {
  return STOP_DECISIONS.includes(decision);
}

export interface TurnOutcome {
  readonly turnId: number;
  readonly goalId: string;
  readonly action: string;
  readonly fingerprint: string;
  readonly failureClass?: ActionFailureClass;
  readonly goalComplete: boolean;
  readonly blockedReason?: string;
}

export interface ContinuationPolicy {
  readonly continueRun: boolean;
  readonly stopTurn: boolean;
  readonly terminalReason: string | undefined;
  readonly notification: string | undefined;
}

export function continuationPolicyFor(checkpoint: RunCheckpoint | undefined): ContinuationPolicy {
  if (checkpoint === undefined) {
    return {
      continueRun: true,
      stopTurn: false,
      terminalReason: undefined,
      notification: undefined,
    };
  }

  switch (checkpoint.decision) {
    case 'continue':
      return {
        continueRun: true,
        stopTurn: false,
        terminalReason: undefined,
        notification: undefined,
      };
    case 'goal_complete':
      return {
        continueRun: false,
        stopTurn: true,
        terminalReason: undefined,
        notification: undefined,
      };
    case 'goal_blocked':
      return {
        continueRun: false,
        stopTurn: true,
        terminalReason: undefined,
        notification: undefined,
      };
    default:
      return {
        continueRun: false,
        stopTurn: true,
        terminalReason: `run stopped: ${checkpoint.reason}`,
        notification: `The run stopped after ${String(checkpoint.turn)} turns: ${checkpoint.reason}`,
      };
  }
}

export function fingerprintOf(action: string, args: Record<string, unknown>): string {
  const sorted = Object.entries(args).toSorted(([a], [b]) => (a < b ? -1 : 1));
  return `${action}:${JSON.stringify(Object.fromEntries(sorted))}`;
}
