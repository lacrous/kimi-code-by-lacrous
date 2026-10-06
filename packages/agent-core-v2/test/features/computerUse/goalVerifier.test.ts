import { describe, expect, it } from 'vitest';

import {
  claimsMatchFacts,
  isProven,
  verifyGoal,
  type CheckContext,
  type Criterion,
  type Evidence,
} from '#/features/computerUse/goalVerifier';

function context(overrides: Partial<CheckContext> = {}, evidence: readonly Evidence[] = []): CheckContext {
  return {
    evidence,
    run: async () => 0,
    readFile: async () => undefined,
    fileExists: async () => false,
    fetchText: async () => undefined,
    ...overrides,
  };
}

const shot = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: 'e1',
  kind: 'screenshot',
  summary: 'the dashboard',
  observedAt: 1_700_000_000_000,
  beforeClaim: true,
  ...overrides,
});

const criteria = (overrides: Partial<Criterion> = {}): Criterion => ({
  id: 'c1',
  description: 'the build passes',
  check: { kind: 'command_succeeded', command: 'pnpm build' },
  ...overrides,
});

describe('verifyGoal — file checks', () => {
  it('verifies a file that exists', async () => {
    const result = await verifyGoal({
      criteria: [criteria({ check: { kind: 'file_exists', path: 'dist/main.mjs' } })],
      evidence: [],
      facts: {},
      context: context({ fileExists: async () => true }),
    });

    expect(result.verdict).toBe('verified');
  });

  it('fails when the file is missing', async () => {
    const result = await verifyGoal({
      criteria: [criteria({ check: { kind: 'file_exists', path: 'nope.txt' } })],
      evidence: [],
      facts: {},
      context: context(),
    });

    expect(result.verdict).toBe('unverified');
    expect(result.criteria[0]?.detail).toContain('is missing');
  });

  it('fails when a file cannot be read', async () => {
    const result = await verifyGoal({
      criteria: [criteria({ check: { kind: 'file_contains', path: 'a.txt', pattern: 'x' } })],
      evidence: [],
      facts: {},
      context: context(),
    });

    expect(result.verdict).toBe('unverified');
    expect(result.criteria[0]?.detail).toContain('could not be read');
  });

  it('matches file content as literal text, not a regex', async () => {
    const result = await verifyGoal({
      criteria: [criteria({ check: { kind: 'file_contains', path: 'a.txt', pattern: 'a.b' } })],
      evidence: [],
      facts: {},
      context: context({ readFile: async () => 'axb' }),
    });

    expect(result.verdict).toBe('unverified');
  });
});

describe('verifyGoal — command checks', () => {
  it('verifies a command that exits zero', async () => {
    const result = await verifyGoal({
      criteria: [criteria()],
      evidence: [],
      facts: {},
      context: context({ run: async () => 0 }),
    });

    expect(result.verdict).toBe('verified');
    expect(result.criteria[0]?.detail).toContain('exited 0');
  });

  it('fails a command that exits non-zero', async () => {
    const result = await verifyGoal({
      criteria: [criteria()],
      evidence: [],
      facts: {},
      context: context({ run: async () => 1 }),
    });

    expect(result.verdict).toBe('unverified');
    expect(result.criteria[0]?.detail).toContain('exited 1');
  });

  it('passes the command through unchanged, so a pipeline works', async () => {
    const seen: string[] = [];
    await verifyGoal({
      criteria: [criteria({ check: { kind: 'command_succeeded', command: 'test -f a && echo ok' } })],
      evidence: [],
      facts: {},
      context: context({
        run: async (command) => {
          seen.push(command);
          return 0;
        },
      }),
    });

    expect(seen).toEqual(['test -f a && echo ok']);
  });
});

describe('verifyGoal — url and evidence checks', () => {
  it('verifies a url that contains the text', async () => {
    const result = await verifyGoal({
      criteria: [
        criteria({ check: { kind: 'url_contains', url: 'https://x.test', pattern: 'Done' } }),
      ],
      evidence: [],
      facts: {},
      context: context({ fetchText: async () => '<title>Done</title>' }),
    });

    expect(result.verdict).toBe('verified');
  });

  it('fails a url that cannot be fetched', async () => {
    const result = await verifyGoal({
      criteria: [
        criteria({ check: { kind: 'url_contains', url: 'https://x.test', pattern: 'Done' } }),
      ],
      evidence: [],
      facts: {},
      context: context(),
    });

    expect(result.verdict).toBe('unverified');
    expect(result.criteria[0]?.detail).toContain('could not be fetched');
  });

  it('accepts evidence captured before the claim but not after', async () => {
    const before = await verifyGoal({
      criteria: [criteria({ check: { kind: 'evidence_before', kindOf: 'screenshot' } })],
      evidence: [shot({ beforeClaim: true })],
      facts: {},
      context: context({}, [shot({ beforeClaim: true })]),
    });
    const after = await verifyGoal({
      criteria: [criteria({ check: { kind: 'evidence_before', kindOf: 'screenshot' } })],
      evidence: [shot({ beforeClaim: false })],
      facts: {},
      context: context({}, [shot({ beforeClaim: false })]),
    });

    expect(before.verdict).toBe('verified');
    expect(after.verdict).toBe('unverified');
  });

  it('does not confuse one evidence kind for another', async () => {
    const result = await verifyGoal({
      criteria: [criteria({ check: { kind: 'evidence_exists', kindOf: 'terminal' } })],
      evidence: [shot({ kind: 'screenshot' })],
      facts: {},
      context: context({}, [shot({ kind: 'screenshot' })]),
    });

    expect(isProven(result)).toBe(false);
  });
});

describe('verifyGoal — numeric facts', () => {
  const base = { evidence: [], context: context() };

  it('checks at-least, at-most and equals independently', async () => {
    expect(
      (
        await verifyGoal({
          ...base,
          criteria: [criteria({ check: { kind: 'fact_at_least', key: 'count', value: 3 } })],
          facts: { count: 5 },
        })
      ).verdict,
    ).toBe('verified');
    expect(
      (
        await verifyGoal({
          ...base,
          criteria: [criteria({ check: { kind: 'fact_at_most', key: 'errors', value: 3 } })],
          facts: { errors: 1 },
        })
      ).verdict,
    ).toBe('verified');
    expect(
      (
        await verifyGoal({
          ...base,
          criteria: [criteria({ check: { kind: 'fact_equals', key: 'state', value: 2 } })],
          facts: { state: 2 },
        })
      ).verdict,
    ).toBe('verified');
  });

  it('contradicts when a recorded value is below a required floor', async () => {
    const result = await verifyGoal({
      criteria: [
        criteria({
          id: 'enough',
          description: 'enough rows',
          check: { kind: 'fact_at_least', key: 'rows', value: 10 },
        }),
      ],
      evidence: [],
      facts: { rows: 2 },
      context: context(),
    });

    expect(result.verdict).toBe('contradicted');
    expect(result.summary).toContain('rows=2');
    expect(result.summary).toContain('>= 10');
  });

  it('contradicts an exceeded ceiling, not only a missed floor', async () => {
    const result = await verifyGoal({
      criteria: [
        criteria({
          id: 'cheap',
          description: 'under budget',
          check: { kind: 'fact_at_most', key: 'cost', value: 5 },
        }),
      ],
      evidence: [],
      facts: { cost: 50 },
      context: context(),
    });

    expect(result.verdict).toBe('contradicted');
    expect(result.summary).toContain('<= 5');
  });

  it('treats a fact that was never recorded as unproven, not as zero', async () => {
    const result = await verifyGoal({
      criteria: [
        criteria({ id: 'k', description: 'k recorded', check: { kind: 'fact_at_least', key: 'k', value: 0 } }),
      ],
      evidence: [],
      facts: {},
      context: context(),
    });

    expect(result.verdict).toBe('contradicted');
    expect(result.summary).toContain('missing');
  });
});

describe('verifyGoal — composition', () => {
  it('all_of requires every nested check', async () => {
    const result = await verifyGoal({
      criteria: [
        criteria({
          check: {
            kind: 'all_of',
            checks: [
              { kind: 'file_exists', path: 'a' },
              { kind: 'file_exists', path: 'b' },
            ],
          },
        }),
      ],
      evidence: [],
      facts: {},
      context: context({ fileExists: async (p) => p === 'a' }),
    });

    expect(result.verdict).toBe('unverified');
    expect(result.criteria[0]?.detail).toContain('b is missing');
  });

  it('any_of passes when one nested check holds', async () => {
    const result = await verifyGoal({
      criteria: [
        criteria({
          check: {
            kind: 'any_of',
            checks: [
              { kind: 'file_exists', path: 'a' },
              { kind: 'file_exists', path: 'b' },
            ],
          },
        }),
      ],
      evidence: [],
      facts: {},
      context: context({ fileExists: async (p) => p === 'b' }),
    });

    expect(result.verdict).toBe('verified');
  });

  it('not inverts a check', async () => {
    const result = await verifyGoal({
      criteria: [
        criteria({ check: { kind: 'not', check: { kind: 'file_exists', path: 'secrets.txt' } } }),
      ],
      evidence: [],
      facts: {},
      context: context({ fileExists: async () => false }),
    });

    expect(result.verdict).toBe('verified');
  });

  it('handles a deeply nested tree', async () => {
    const result = await verifyGoal({
      criteria: [
        criteria({
          check: {
            kind: 'all_of',
            checks: [
              {
                kind: 'any_of',
                checks: [
                  { kind: 'file_exists', path: 'x' },
                  { kind: 'file_exists', path: 'report.pdf' },
                ],
              },
              { kind: 'not', check: { kind: 'file_exists', path: 'tmp' } },
            ],
          },
        }),
      ],
      evidence: [],
      facts: {},
      context: context({ fileExists: async (p) => p === 'report.pdf' }),
    });

    expect(result.verdict).toBe('verified');
  });
});

describe('verifyGoal — undecidable criteria', () => {
  it('reports an undecidable criterion as unproven', async () => {
    const result = await verifyGoal({
      criteria: [
        {
          id: 'taste',
          description: 'the writing is good',
          undecidable: true as const,
          reason: 'quality is not machine-checkable',
        },
      ],
      evidence: [],
      facts: {},
      context: context(),
    });

    expect(result.verdict).toBe('insufficient_evidence');
    expect(result.criteria[0]?.undecidable).toBe(true);
  });

  it('prefers insufficient_evidence when one criterion is undecidable and another fails', async () => {
    const result = await verifyGoal({
      criteria: [
        { id: 'a', description: 'quality', undecidable: true as const, reason: 'subjective' },
        criteria({ id: 'b', description: 'build passes' }),
      ],
      evidence: [],
      facts: {},
      context: context({ run: async () => 1 }),
    });

    expect(result.verdict).toBe('insufficient_evidence');
  });

  it('never verifies a goal with no criteria', async () => {
    const result = await verifyGoal({ criteria: [], evidence: [], facts: {}, context: context() });

    expect(isProven(result)).toBe(false);
  });

  it('verifies a multi-part goal when every part holds', async () => {
    const result = await verifyGoal({
      criteria: [
        criteria({ id: 'build', description: 'the build passes' }),
        criteria({
          id: 'shipped',
          description: 'a screenshot exists',
          check: { kind: 'evidence_exists', kindOf: 'screenshot' },
        }),
        criteria({
          id: 'cheap',
          description: 'under budget',
          check: { kind: 'fact_at_most', key: 'cost', value: 5 },
        }),
      ],
      evidence: [shot()],
      facts: { cost: 2 },
      context: context({ run: async () => 0 }, [shot()]),
    });

    expect(result.verdict).toBe('verified');
    expect(result.criteria).toHaveLength(3);
  });
});

describe('claimsMatchFacts', () => {
  it('finds no mismatch when the claim matches the record', () => {
    expect(claimsMatchFacts({ count: 7 }, { count: 7 })).toEqual([]);
  });

  it('catches a claim the run never recorded', () => {
    expect(claimsMatchFacts({ count: 7 }, { count: 0 })).toEqual([
      'count: claimed 7, recorded 0',
    ]);
  });

  it('flags a claim about something with no record at all', () => {
    expect(claimsMatchFacts({ signups: 50 }, {})[0]).toContain('recorded nothing');
  });

  it('ignores recorded values the model did not claim', () => {
    expect(claimsMatchFacts({ count: 7 }, { count: 7, cost: 1 })).toEqual([]);
  });

  it('returns nothing when nothing was claimed', () => {
    expect(claimsMatchFacts(undefined, { count: 7 })).toEqual([]);
  });
});
