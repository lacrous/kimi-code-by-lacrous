import type { ActionFailureClass } from '#/features/computerUse/observation';
import {
  DEFAULT_SUPERVISOR_LIMITS,
  decideNext,
  emptySupervisorState,
  failureCountFor,
  recordAction,
  type SupervisorDecision,
  type SupervisorLimits,
  type SupervisorState,
} from '#/features/computerUse/supervisor';

export interface RunSupervisorOptions {
  readonly limits?: Partial<SupervisorLimits>;
  readonly now?: () => number;
}

export interface RunCheckpoint {
  readonly goalId: string;
  readonly turn: number;
  readonly decision: SupervisorDecision;
  readonly reason: string;
  readonly actions: number;
}

export interface IAgentRunSupervisor {
  readonly _serviceBrand: undefined;
  begin(goalId: string): void;
  afterTurn(input: {
    readonly goalId: string;
    readonly action: string;
    readonly fingerprint: string;
    readonly failureClass?: ActionFailureClass;
    readonly goalComplete: boolean;
    readonly blockedReason?: string;
  }): RunCheckpoint;
  complete(goalId: string): void;
  checkpoint(goalId: string): RunCheckpoint | undefined;
  state(goalId: string): SupervisorState | undefined;
}

export class AgentRunSupervisor implements IAgentRunSupervisor {
  declare readonly _serviceBrand: undefined;

  private readonly _limits: SupervisorLimits;
  private readonly _now: () => number;
  private readonly _states = new Map<string, SupervisorState>();
  private readonly _turns = new Map<string, number>();
  private readonly _checkpoints = new Map<string, RunCheckpoint>();

  constructor(options: RunSupervisorOptions = {}) {
    this._limits = { ...DEFAULT_SUPERVISOR_LIMITS, ...options.limits };
    this._now = options.now ?? Date.now;
  }

  begin(goalId: string): void {
    this._states.set(goalId, emptySupervisorState());
    this._turns.set(goalId, 0);
    this._checkpoints.delete(goalId);
  }

  afterTurn(input: {
    readonly goalId: string;
    readonly action: string;
    readonly fingerprint: string;
    readonly failureClass?: ActionFailureClass;
    readonly goalComplete: boolean;
    readonly blockedReason?: string;
  }): RunCheckpoint {
    const previous = this._states.get(input.goalId) ?? emptySupervisorState();
    const turn = (this._turns.get(input.goalId) ?? 0) + 1;
    this._turns.set(input.goalId, turn);

    const withCompletion: SupervisorState = {
      ...recordAction(previous, input.fingerprint, input.failureClass),
      completed: input.goalComplete,
      blockedReason: input.blockedReason,
    };
    this._states.set(input.goalId, withCompletion);

    const outcome = decideNext({
      ...this._limits,
      state: withCompletion,
      action: input.action,
      fingerprint: input.fingerprint,
      failureClass: input.failureClass,
      repeatedCount: input.failureClass === undefined
        ? 0
        : failureCountFor(withCompletion, input.fingerprint),
      now: this._now(),
    });

    const checkpoint: RunCheckpoint = {
      goalId: input.goalId,
      turn,
      decision: outcome.decision,
      reason: outcome.reason,
      actions: withCompletion.actions,
    };
    this._checkpoints.set(input.goalId, checkpoint);
    return checkpoint;
  }

  complete(goalId: string): void {
    const state = this._states.get(goalId) ?? emptySupervisorState();
    this._states.set(goalId, { ...state, completed: true });
    const checkpoint = this._checkpoints.get(goalId);
    if (checkpoint !== undefined) {
      this._checkpoints.set(goalId, { ...checkpoint, decision: 'goal_complete', reason: 'marked complete' });
    }
  }

  checkpoint(goalId: string): RunCheckpoint | undefined {
    return this._checkpoints.get(goalId);
  }

  state(goalId: string): SupervisorState | undefined {
    return this._states.get(goalId);
  }

  static shouldContinue(checkpoint: RunCheckpoint | undefined): boolean {
    return checkpoint === undefined || checkpoint.decision === 'continue';
  }
}

export function runSummary(checkpoint: RunCheckpoint): string {
  const status = checkpoint.decision === 'continue' ? 'running' : 'stopped';
  return `goal ${checkpoint.goalId} ${status} after ${String(checkpoint.turn)} turns (${String(checkpoint.actions)} actions): ${checkpoint.reason}`;
}
