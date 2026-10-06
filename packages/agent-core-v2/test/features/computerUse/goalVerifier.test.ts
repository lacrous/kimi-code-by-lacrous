import { describe, expect, it } from 'vitest';

import {
  claimsMatchFacts,
  isProven,
  verifyGoal,
  type Criterion,
  type Evidence,
} from '#/features/computerUse/goalVerifier';

const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: 'e1',
  kind: 'screenshot',
  summary: 'dashboard shows the balance',
  observedAt: 1_700_000_000_000,
  beforeClaim: true,
  ...overrides,
});

const criterion = (overrides: Partial<Criterion> = {}): Criterion => ({
  id: 'c1',
  description: 'a screenshot proves the balance is displayed',
  check: { kind: 'evidence_exists', kindOf: 'screenshot' },
  ...overrides,
});

describe('verifyGoal', () => {
  it('verifies when every criterion is met by recorded evidence', () => {
    const result = verifyGoal({
      criteria: [criterion()],
      evidence: [evidence()],
      facts: {},
    });

    expect(result.verdict).toBe('verified');
    expect(isProven(result)).toBe(true);
  });

  it('refuses to verify when there is no evidence at all', () => {
    const result = verifyGoal({ criteria: [criterion()], evidence: [], facts: {} });

    expect(isProven(result)).toBe(false);
    expect(result.verdict).toBe('unverified');
  });

  it('refuses to verify a goal with no criteria', () => {
    const result = verifyGoal({ criteria: [], evidence: [evidence()], facts: {} });

    expect(result.verdict).not.toBe('verified');
  });

  it('treats an uncheckable criterion as unproven rather than satisfied', () => {
    const result = verifyGoal({
      criteria: [criterion({ check: { kind: 'manual' } })],
      evidence: [evidence()],
      facts: {},
    });

    expect(result.verdict).toBe('insufficient_evidence');
    expect(isProven(result)).toBe(false);
  });

  it('reports insufficient evidence when a criterion needs one kind and another exists', () => {
    const result = verifyGoal({
      criteria: [criterion({ check: { kind: 'evidence_exists', kindOf: 'terminal' } })],
      evidence: [evidence({ kind: 'screenshot' })],
      facts: {},
    });

    expect(isProven(result)).toBe(false);
  });

  it('contradicts a claim when the recorded number is below the threshold', () => {
    const result = verifyGoal({
      criteria: [criterion({ check: { kind: 'manual' } })],
      evidence: [],
      facts: { revenue: 40 },
      requiredFacts: { revenue: 100 },
    });

    expect(result.verdict).toBe('contradicted');
    expect(result.summary).toContain('revenue=40');
    expect(result.summary).toContain('needs 100');
  });

  it('contradicts nothing when the recorded number meets the threshold', () => {
    const result = verifyGoal({
      criteria: [criterion()],
      evidence: [evidence()],
      facts: { revenue: 120 },
      requiredFacts: { revenue: 100 },
    });

    expect(result.verdict).toBe('verified');
    expect(result.factChecks[0]?.ok).toBe(true);
  });

  it('reports insufficient evidence when a required fact was never recorded', () => {
    const result = verifyGoal({
      criteria: [criterion()],
      evidence: [evidence()],
      facts: {},
      requiredFacts: { revenue: 100 },
    });

    expect(isProven(result)).toBe(false);
  });

  it('accepts a fact that exactly meets the threshold', () => {
    const result = verifyGoal({
      criteria: [criterion()],
      evidence: [evidence()],
      facts: { revenue: 100 },
      requiredFacts: { revenue: 100 },
    });

    expect(result.verdict).toBe('verified');
  });

  it('fails when one of several criteria is unmet', () => {
    const result = verifyGoal({
      criteria: [
        criterion({ id: 'c1' }),
        criterion({ id: 'c2', check: { kind: 'evidence_exists', kindOf: 'terminal' } }),
      ],
      evidence: [evidence()],
      facts: {},
    });

    expect(isProven(result)).toBe(false);
    expect(result.criteria.find((c) => c.criterionId === 'c2')?.satisfied).toBe(false);
    expect(result.criteria.find((c) => c.criterionId === 'c1')?.satisfied).toBe(true);
  });

  it('prefers contradicted over insufficient when a fact is actually wrong', () => {
    const result = verifyGoal({
      criteria: [criterion({ check: { kind: 'manual' } })],
      evidence: [],
      facts: { revenue: 0 },
      requiredFacts: { revenue: 100 },
    });

    expect(result.verdict).toBe('contradicted');
  });
});

describe('claimsMatchFacts', () => {
  it('finds no mismatch when the claim matches the record', () => {
    expect(claimsMatchFacts({ revenue: 120 }, { revenue: 120 })).toEqual([]);
  });

  it('catches a model claiming success the run never recorded', () => {
    const mismatches = claimsMatchFacts({ revenue: 120 }, { revenue: 0 });

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('claimed 120');
    expect(mismatches[0]).toContain('recorded 0');
  });

  it('flags a claim about something that was never recorded', () => {
    const mismatches = claimsMatchFacts({ signups: 50 }, {});

    expect(mismatches[0]).toContain('recorded nothing');
  });

  it('ignores facts the model did not claim', () => {
    expect(claimsMatchFacts({ revenue: 120 }, { revenue: 120, signups: 3 })).toEqual([]);
  });

  it('returns nothing when the model made no claims', () => {
    expect(claimsMatchFacts(undefined, { revenue: 120 })).toEqual([]);
  });
});
