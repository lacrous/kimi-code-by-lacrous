import { describe, expect, it } from 'vitest';

import {
  AgentRunSupervisor,
  runSummary,
  type RunSupervisorOptions,
} from '#/features/computerUse/runSupervisor';

function supervisor(options: RunSupervisorOptions = {}): AgentRunSupervisor {
  return new AgentRunSupervisor(options);
}

function turn(
  overrides: Partial<Parameters<AgentRunSupervisor['afterTurn']>[0]> = {},
): Parameters<AgentRunSupervisor['afterTurn']>[0] {
  return {
    goalId: 'g1',
    action: 'browser.click',
    fingerprint: 'browser.click:#submit',
    goalComplete: false,
    ...overrides,
  };
}

describe('AgentRunSupervisor', () => {
  it('continues a healthy run', () => {
    const run = supervisor();
    run.begin('g1');

    const checkpoint = run.afterTurn(turn());

    expect(checkpoint.decision).toBe('continue');
    expect(checkpoint.turn).toBe(1);
  });

  it('counts turns and actions across turns', () => {
    const run = supervisor();
    run.begin('g1');
    run.afterTurn(turn({ fingerprint: 'a' }));
    run.afterTurn(turn({ fingerprint: 'b' }));
    const checkpoint = run.afterTurn(turn({ fingerprint: 'c' }));

    expect(checkpoint.turn).toBe(3);
    expect(checkpoint.actions).toBe(3);
  });

  it('stops when the goal reports complete', () => {
    const run = supervisor();
    run.begin('g1');

    const checkpoint = run.afterTurn(turn({ goalComplete: true }));

    expect(checkpoint.decision).toBe('goal_complete');
    expect(AgentRunSupervisor.shouldContinue(checkpoint)).toBe(false);
  });

  it('stops when the goal is blocked and names the reason', () => {
    const run = supervisor();
    run.begin('g1');

    const checkpoint = run.afterTurn(turn({ blockedReason: 'needs an account' }));

    expect(checkpoint.decision).toBe('goal_blocked');
    expect(checkpoint.reason).toBe('needs an account');
  });

  it('stops at the action limit set at construction', () => {
    const run = supervisor({ limits: { maxActions: 3 } });
    run.begin('g1');
    run.afterTurn(turn({ fingerprint: 'a' }));
    run.afterTurn(turn({ fingerprint: 'b' }));
    const checkpoint = run.afterTurn(turn({ fingerprint: 'c' }));

    expect(checkpoint.decision).toBe('stop_max_actions');
  });

  it('honours a deadline measured from the wall clock', () => {
    let now = 1_000;
    const run = supervisor({ limits: { deadline: 1_500 }, now: () => now });
    run.begin('g1');
    expect(run.afterTurn(turn()).decision).toBe('continue');

    now = 2_000;
    expect(run.afterTurn(turn()).decision).toBe('stop_deadline');
  });

  it('stops a loop that keeps failing the same action', () => {
    const run = supervisor({ limits: { maxRetries: 2 } });
    run.begin('g1');
    run.afterTurn(turn({ failureClass: 'environment' }));
    run.afterTurn(turn({ failureClass: 'environment' }));
    const checkpoint = run.afterTurn(turn({ failureClass: 'environment' }));

    expect(checkpoint.decision).toBe('stop_loop');
    expect(checkpoint.reason).toContain('3 times');
  });

  it('does not stop when different actions fail', () => {
    const run = supervisor({ limits: { maxRetries: 2 } });
    run.begin('g1');
    run.afterTurn(turn({ fingerprint: 'a', failureClass: 'environment' }));
    run.afterTurn(turn({ fingerprint: 'b', failureClass: 'environment' }));
    const checkpoint = run.afterTurn(turn({ fingerprint: 'c', failureClass: 'environment' }));

    expect(checkpoint.decision).toBe('continue');
  });

  it('resets the failure count when the action finally succeeds', () => {
    const run = supervisor({ limits: { maxRetries: 2 } });
    run.begin('g1');
    run.afterTurn(turn({ failureClass: 'environment' }));
    run.afterTurn(turn({ failureClass: 'environment' }));
    run.afterTurn(turn());
    const checkpoint = run.afterTurn(turn({ failureClass: 'environment' }));

    expect(checkpoint.decision).toBe('continue');
  });

  it('keeps separate state per goal', () => {
    const run = supervisor({ limits: { maxActions: 2 } });
    run.begin('g1');
    run.begin('g2');
    run.afterTurn(turn({ goalId: 'g1', fingerprint: 'a' }));
    run.afterTurn(turn({ goalId: 'g1', fingerprint: 'b' }));
    const g1 = run.afterTurn(turn({ goalId: 'g1', fingerprint: 'c' }));
    const g2 = run.afterTurn(turn({ goalId: 'g2', fingerprint: 'a' }));

    expect(g1.decision).toBe('stop_max_actions');
    expect(g2.decision).toBe('continue');
  });

  it('starts fresh when a goal is begun again', () => {
    const run = supervisor({ limits: { maxActions: 2 } });
    run.begin('g1');
    run.afterTurn(turn({ fingerprint: 'a' }));
    run.afterTurn(turn({ fingerprint: 'b' }));
    expect(run.checkpoint('g1')?.decision).toBe('stop_max_actions');

    run.begin('g1');

    const checkpoint = run.afterTurn(turn({ fingerprint: 'a' }));
    expect(checkpoint.turn).toBe(1);
    expect(checkpoint.actions).toBe(1);
    expect(checkpoint.decision).toBe('continue');
  });

  it('stops exactly at the limit, not one past it', () => {
    const run = supervisor({ limits: { maxActions: 1 } });
    run.begin('g1');

    expect(run.afterTurn(turn()).decision).toBe('stop_max_actions');
  });

  it('reports no checkpoint before the first turn', () => {
    const run = supervisor();
    run.begin('g1');

    expect(run.checkpoint('g1')).toBeUndefined();
    expect(run.state('g1')?.actions).toBe(0);
  });

  it('marks a goal complete out of band', () => {
    const run = supervisor();
    run.begin('g1');
    run.afterTurn(turn());

    run.complete('g1');

    expect(run.checkpoint('g1')?.decision).toBe('goal_complete');
    expect(run.state('g1')?.completed).toBe(true);
  });

  it('treats an unknown goal as runnable rather than stopped', () => {
    expect(AgentRunSupervisor.shouldContinue(undefined)).toBe(true);
  });

  it('formats a checkpoint as one readable line', () => {
    const run = supervisor();
    run.begin('g1');
    const checkpoint = run.afterTurn(turn());

    expect(runSummary(checkpoint)).toBe('goal g1 running after 1 turns (1 actions): proceeding');
  });
});
