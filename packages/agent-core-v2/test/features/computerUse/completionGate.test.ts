import { describe, expect, it } from 'vitest';

import { buildGoalCriteria, gateCompletion } from '#/features/computerUse/completionGate';
import type { CheckContext, Check } from '#/features/computerUse/goalVerifier';

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    evidence: [],
    run: async () => 0,
    readFile: async () => undefined,
    fileExists: async () => false,
    fetchText: async () => undefined,
    ...overrides,
  };
}

const fileCheck: Check = { kind: 'file_exists', path: 'report.md' };

describe('gateCompletion — verified goals pass', () => {
  it('allows a completion the checks prove', async () => {
    const result = await gateCompletion({
      criteria: [{ id: 'c', description: 'report.md exists', check: fileCheck }],
      evidence: [],
      facts: {},
      context: context({ fileExists: async () => true }),
      enforce: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('verified');
    expect(result.feedback).toBeUndefined();
  });
});

describe('gateCompletion — the deadlock case', () => {
  it('allows a goal whose criteria cannot be machine-checked', async () => {
    const result = await gateCompletion({
      criteria: [
        {
          id: 'taste',
          description: 'the copy reads well',
          undecidable: true,
          reason: 'writing quality is subjective',
        },
      ],
      evidence: [],
      facts: {},
      context: context(),
      enforce: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('verified');
  });

  it('allows a goal defined with no criteria at all', async () => {
    const criteria = buildGoalCriteria({ description: 'improve the onboarding copy' }, []);

    expect(criteria).toHaveLength(1);
    const result = await gateCompletion({
      criteria,
      evidence: [],
      facts: {},
      context: context(),
      enforce: true,
    });

    expect(result.allowed).toBe(true);
  });

  it('would have deadlocked if undecidable meant refuse', async () => {
    const result = await gateCompletion({
      criteria: [
        { id: 'a', description: 'subjective', undecidable: true, reason: 'no script can decide' },
      ],
      evidence: [],
      facts: {},
      context: context(),
      enforce: true,
    });

    expect(result.verification.verdict).toBe('insufficient_evidence');
    expect(result.allowed).toBe(true);
  });
});

describe('gateCompletion — refused completions', () => {
  it('refuses when a check ran and did not hold', async () => {
    const result = await gateCompletion({
      criteria: [{ id: 'c', description: 'report.md exists', check: fileCheck }],
      evidence: [],
      facts: {},
      context: context({ fileExists: async () => false }),
      enforce: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('refused');
    expect(result.feedback).toContain('refused');
  });

  it('refuses when the record contradicts a threshold', async () => {
    const result = await gateCompletion({
      criteria: [
        {
          id: 'rows',
          description: 'enough rows written',
          check: { kind: 'fact_at_least', key: 'rows', value: 10 },
        },
      ],
      evidence: [],
      facts: { rows: 2 },
      context: context(),
      enforce: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.feedback).toContain('contradicts');
  });

  it('refuses when a command the goal required failed', async () => {
    const result = await gateCompletion({
      criteria: [
        {
          id: 'tests',
          description: 'the tests pass',
          check: { kind: 'command_succeeded', command: 'pnpm test' },
        },
      ],
      evidence: [],
      facts: {},
      context: context({ run: async () => 1 }),
      enforce: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.feedback).toContain('exited 1');
  });

  it('names the failing criterion so the model can act on it', async () => {
    const result = await gateCompletion({
      criteria: [{ id: 'report', description: 'report.md exists', check: fileCheck }],
      evidence: [],
      facts: {},
      context: context(),
      enforce: true,
    });

    expect(result.feedback).toContain('report');
  });
});

describe('gateCompletion — defaults', () => {
  it('allows everything when enforcement is off', async () => {
    const result = await gateCompletion({
      criteria: [{ id: 'c', description: 'report.md exists', check: fileCheck }],
      evidence: [],
      facts: {},
      context: context(),
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('not_enforced');
  });

  it('still verifies even when enforcement is off, so the result is reportable', async () => {
    const result = await gateCompletion({
      criteria: [{ id: 'c', description: 'report.md exists', check: fileCheck }],
      evidence: [],
      facts: {},
      context: context({ fileExists: async () => false }),
    });

    expect(result.reason).toBe('not_enforced');
    expect(result.verification.verdict).toBe('unverified');
  });

  it('lets a user override an unproven completion', async () => {
    const result = await gateCompletion({
      criteria: [{ id: 'c', description: 'report.md exists', check: fileCheck }],
      evidence: [],
      facts: {},
      context: context({ fileExists: async () => false }),
      enforce: true,
      fromUser: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('user_override');
  });
});

describe('buildGoalCriteria', () => {
  it('maps declared checks into criteria', () => {
    const criteria = buildGoalCriteria({ description: 'ship it' }, [
      { id: 'a', description: 'build passes', check: { kind: 'command_succeeded', command: 'pnpm build' } },
    ]);

    expect(criteria).toEqual([
      { id: 'a', description: 'build passes', check: { kind: 'command_succeeded', command: 'pnpm build' } },
    ]);
  });

  it('turns a goal with no checks into one undecidable criterion', () => {
    const criteria = buildGoalCriteria({ description: 'make it better' }, []);

    expect(criteria[0]).toMatchObject({ id: 'objective', undecidable: true });
    const only = criteria[0];
    expect(only !== undefined && 'reason' in only).toBe(true);
    expect(only !== undefined && 'reason' in only ? only.reason : '').toContain(
      'no machine-checkable criteria',
    );
  });
});
