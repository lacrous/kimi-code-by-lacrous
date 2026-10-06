import { describe, expect, it } from 'vitest';

import {
  backoffDelayMs,
  decideNext,
  DEFAULT_SUPERVISOR_LIMITS,
  emptySupervisorState,
  failureCountFor,
  isRetryable,
  recordAction,
  shouldRetry,
  type SupervisorInput,
} from '#/features/computerUse/supervisor';

function input(overrides: Partial<SupervisorInput> = {}): SupervisorInput {
  return {
    ...DEFAULT_SUPERVISOR_LIMITS,
    state: emptySupervisorState(),
    action: 'browser.click',
    fingerprint: 'browser.click:#submit',
    failureClass: undefined,
    repeatedCount: 0,
    ...overrides,
  };
}

describe('decideNext', () => {
  it('continues while nothing is wrong', () => {
    expect(decideNext(input()).decision).toBe('continue');
  });

  it('stops once the goal is complete', () => {
    const outcome = decideNext(
      input({ state: { ...emptySupervisorState(), completed: true } }),
    );

    expect(outcome.decision).toBe('goal_complete');
  });

  it('stops when the goal is blocked', () => {
    const outcome = decideNext(
      input({ state: { ...emptySupervisorState(), blockedReason: 'needs an account' } }),
    );

    expect(outcome.decision).toBe('goal_blocked');
    expect(outcome.reason).toBe('needs an account');
  });

  it('stops at the action limit', () => {
    const outcome = decideNext(
      input({
        maxActions: 5,
        state: { ...emptySupervisorState(), actions: 5 },
      }),
    );

    expect(outcome.decision).toBe('stop_max_actions');
    expect(outcome.reason).toContain('5 actions');
  });

  it('continues one action below the limit', () => {
    const outcome = decideNext(
      input({
        maxActions: 5,
        state: { ...emptySupervisorState(), actions: 4 },
      }),
    );

    expect(outcome.decision).toBe('continue');
  });

  it('reads the action count from state, not from a field that does not exist', () => {
    const raw = input({
      maxActions: 2,
      state: { ...emptySupervisorState(), actions: 9 },
    }) as unknown as Record<string, unknown>;

    expect(raw['actions']).toBeUndefined();
    expect(decideNext(input({ maxActions: 2, state: { ...emptySupervisorState(), actions: 9 } })).decision).toBe(
      'stop_max_actions',
    );
  });

  it('stops once the deadline passes', () => {
    const outcome = decideNext(input({ deadline: Date.now() - 1 }));

    expect(outcome.decision).toBe('stop_deadline');
  });

  it('continues before the deadline', () => {
    const outcome = decideNext(input({ deadline: Date.now() + 60_000 }));

    expect(outcome.decision).toBe('continue');
  });

  it('stops when the budget is spent', () => {
    const outcome = decideNext(input({ spentUnits: 10, budgetUnits: 10 }));

    expect(outcome.decision).toBe('stop_budget');
  });

  it('continues while budget remains', () => {
    expect(decideNext(input({ spentUnits: 9, budgetUnits: 10 })).decision).toBe('continue');
  });

  it('ignores the budget when none is configured', () => {
    expect(decideNext(input({ spentUnits: 1_000_000 })).decision).toBe('continue');
  });

  it('checks the deadline before the budget, so the reason is accurate', () => {
    const outcome = decideNext(
      input({ deadline: Date.now() - 1, spentUnits: 10, budgetUnits: 10 }),
    );

    expect(outcome.decision).toBe('stop_deadline');
  });

  it('reports a completed goal even when the deadline has passed', () => {
    const outcome = decideNext(
      input({
        deadline: Date.now() - 1,
        state: { ...emptySupervisorState(), completed: true },
      }),
    );

    expect(outcome.decision).toBe('goal_complete');
  });

  it('distinguishes a stopped run from a finished one', () => {
    const stopped = decideNext(input({ deadline: Date.now() - 1 }));
    const finished = decideNext(
      input({ state: { ...emptySupervisorState(), completed: true } }),
    );

    expect(stopped.decision).not.toBe(finished.decision);
  });

  it('stops a loop that keeps failing the same way', () => {
    const outcome = decideNext(
      input({ failureClass: 'environment', repeatedCount: 9, maxRetries: 8 }),
    );

    expect(outcome.decision).toBe('stop_loop');
    expect(outcome.reason).toContain('9 times');
  });

  it('allows a failure inside the retry budget', () => {
    const outcome = decideNext(
      input({ failureClass: 'transient', repeatedCount: 3, maxRetries: 8 }),
    );

    expect(outcome.decision).toBe('continue');
  });

  it('does not stop for repeated successes', () => {
    const outcome = decideNext(input({ repeatedCount: 99 }));

    expect(outcome.decision).toBe('continue');
  });
});

describe('retry classification', () => {
  it('retries transient, network and tool failures', () => {
    expect(isRetryable('transient')).toBe(true);
    expect(isRetryable('network')).toBe(true);
    expect(isRetryable('tool')).toBe(true);
  });

  it('does not retry a failure that retrying cannot fix', () => {
    for (const classification of [
      'authentication',
      'invalid_action',
      'application',
      'model',
      'unknown',
    ] as const) {
      expect(isRetryable(classification)).toBe(false);
    }
  });

  it('allows a retry below the limit and refuses at it', () => {
    expect(shouldRetry('transient', 1, 3)).toBe(true);
    expect(shouldRetry('transient', 3, 3)).toBe(true);
    expect(shouldRetry('transient', 4, 3)).toBe(false);
  });

  it('never retries a non-retryable class, however many attempts', () => {
    expect(shouldRetry('authentication', 1, 10)).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially', () => {
    expect(backoffDelayMs(1, 500)).toBe(500);
    expect(backoffDelayMs(2, 500)).toBe(1000);
    expect(backoffDelayMs(3, 500)).toBe(2000);
  });

  it('caps so a long run does not wait minutes', () => {
    expect(backoffDelayMs(50, 500)).toBe(30_000);
  });

  it('treats a zero attempt count as the first attempt', () => {
    expect(backoffDelayMs(0, 500)).toBe(500);
  });
});

describe('recordAction', () => {
  it('counts every action', () => {
    const state = recordAction(emptySupervisorState(), 'click', undefined);

    expect(state.actions).toBe(1);
  });

  it('counts failures per fingerprint, not globally', () => {
    let state = emptySupervisorState();
    state = recordAction(state, 'click', 'transient');
    state = recordAction(state, 'click', 'transient');
    state = recordAction(state, 'type', 'network');

    expect(failureCountFor(state, 'click')).toBe(2);
    expect(failureCountFor(state, 'type')).toBe(1);
  });

  it('clears the count when the action succeeds', () => {
    let state = emptySupervisorState();
    state = recordAction(state, 'click', 'transient');
    state = recordAction(state, 'click', undefined);

    expect(failureCountFor(state, 'click')).toBe(0);
  });

  it('does not mutate the previous state', () => {
    const first = emptySupervisorState();
    recordAction(first, 'click', 'transient');

    expect(first.actions).toBe(0);
    expect(failureCountFor(first, 'click')).toBe(0);
  });

  it('preserves completion across an action', () => {
    const completed = { ...emptySupervisorState(), completed: true };
    const next = recordAction(completed, 'click', undefined);

    expect(next.completed).toBe(true);
  });
});
