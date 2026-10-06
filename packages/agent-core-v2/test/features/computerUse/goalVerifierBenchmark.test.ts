import { describe, expect, it } from 'vitest';

import {
  claimsMatchFacts,
  isProven,
  verifyGoal,
} from '#/features/computerUse/goalVerifier';

describe('the $100 benchmark scenario', () => {
  it('refuses a completion claim the run cannot back', () => {
    const claim = { revenue: 100 };
    const recorded = { revenue: 0 };

    const result = verifyGoal({
      criteria: [
        {
          id: 'money',
          description: 'a statement screenshot shows the revenue',
          check: { kind: 'evidence_exists', kindOf: 'screenshot' },
        },
      ],
      evidence: [],
      facts: recorded,
      requiredFacts: { revenue: 100 },
      claimedFacts: claim,
    });

    expect(result.verdict).toBe('contradicted');
    expect(isProven(result)).toBe(false);
    expect(result.summary).toContain('revenue=0');
    expect(claimsMatchFacts(claim, recorded)).toEqual([
      'revenue: claimed 100, recorded 0',
    ]);
  });

  it('verifies once a statement screenshot and the recorded revenue agree', () => {
    const result = verifyGoal({
      criteria: [
        {
          id: 'money',
          description: 'a statement screenshot shows the revenue',
          check: { kind: 'evidence_exists', kindOf: 'screenshot' },
        },
      ],
      evidence: [
        {
          id: 'shot-1',
          kind: 'screenshot',
          summary: 'statement shows 100.00 received',
          observedAt: 1_700_000_000_000,
          beforeClaim: true,
        },
      ],
      facts: { revenue: 100 },
      requiredFacts: { revenue: 100 },
      claimedFacts: { revenue: 100 },
    });

    expect(result.verdict).toBe('verified');
    expect(isProven(result)).toBe(true);
    expect(claimsMatchFacts({ revenue: 100 }, { revenue: 100 })).toEqual([]);
  });
});
