export const VERDICTS = ['verified', 'unverified', 'contradicted', 'insufficient_evidence'] as const;

export type Verdict = (typeof VERDICTS)[number];

export interface Evidence {
  readonly id: string;
  readonly kind: 'screenshot' | 'file' | 'terminal' | 'browser' | 'external';
  readonly summary: string;
  readonly observedAt: number;
  readonly beforeClaim: boolean;
}

export interface Criterion {
  readonly id: string;
  readonly description: string;
  readonly check: CriterionCheck;
}

export type CriterionCheck =
  | { readonly kind: 'file_exists'; readonly path: string }
  | { readonly kind: 'file_contains'; readonly path: string; readonly pattern: string }
  | { readonly kind: 'command_succeeded'; readonly command: string }
  | { readonly kind: 'evidence_exists'; readonly kindOf: Evidence['kind'] }
  | { readonly kind: 'manual' };

export interface CriterionResult {
  readonly criterionId: string;
  readonly satisfied: boolean;
  readonly detail: string;
}

export interface VerificationInput {
  readonly criteria: readonly Criterion[];
  readonly evidence: readonly Evidence[];
  readonly facts: Readonly<Record<string, number>>;
  readonly claimedFacts?: Readonly<Record<string, number>>;
  readonly requiredFacts?: Readonly<Record<string, number>>;
}

export interface VerificationResult {
  readonly verdict: Verdict;
  readonly criteria: readonly CriterionResult[];
  readonly factChecks: readonly { readonly key: string; readonly required: number; readonly actual: number | undefined; readonly ok: boolean }[];
  readonly summary: string;
}

function checkSatisfied(
  check: CriterionCheck,
  evidence: readonly Evidence[],
): CriterionResult | undefined {
  switch (check.kind) {
    case 'evidence_exists':
      return {
        criterionId: '',
        satisfied: evidence.some((e) => e.kind === check.kindOf),
        detail: `evidence of kind ${check.kindOf}`,
      };
    case 'manual':
      return undefined;
    case 'file_exists':
    case 'file_contains':
    case 'command_succeeded':
      return undefined;
    default:
      return undefined;
  }
}

export function verifyGoal(input: VerificationInput): VerificationResult {
  const criteria: CriterionResult[] = [];
  let uncheckable = 0;

  for (const criterion of input.criteria) {
    const resolved = checkSatisfied(criterion.check, input.evidence);
    if (resolved === undefined) {
      uncheckable += 1;
      criteria.push({
        criterionId: criterion.id,
        satisfied: false,
        detail: `no automatic check for "${criterion.description}"`,
      });
      continue;
    }
    criteria.push({ ...resolved, criterionId: criterion.id, detail: `${criterion.description}: ${resolved.detail}` });
  }

  const factChecks = Object.entries(input.requiredFacts ?? {}).map(([key, required]) => {
    const actual = input.facts[key];
    return { key, required, actual, ok: actual !== undefined && actual >= required };
  });

  const unsatisfied = criteria.filter((c) => !c.satisfied);
  const badFacts = factChecks.filter((f) => !f.ok);

  if (unsatisfied.length === 0 && badFacts.length === 0 && criteria.length > 0) {
    return {
      verdict: 'verified',
      criteria,
      factChecks,
      summary: `All ${String(criteria.length)} criteria and ${String(factChecks.length)} thresholds are satisfied.`,
    };
  }

  const contradicted = badFacts.some((f) => f.actual !== undefined && f.actual < f.required);
  if (contradicted) {
    const offenders = badFacts
      .map((f) => `${f.key}=${String(f.actual ?? 'missing')} (needs ${String(f.required)})`)
      .join(', ');
    return {
      verdict: 'contradicted',
      criteria,
      factChecks,
      summary: `Recorded evidence contradicts the goal: ${offenders}.`,
    };
  }

  if (uncheckable > 0) {
    return {
      verdict: 'insufficient_evidence',
      criteria,
      factChecks,
      summary: `${String(uncheckable)} criteria cannot be checked automatically, so completion is unproven.`,
    };
  }

  if (badFacts.length > 0) {
    const missing = badFacts.map((f) => `${f.key} (needs ${String(f.required)})`).join(', ');
    return {
      verdict: 'insufficient_evidence',
      criteria,
      factChecks,
      summary: `No evidence was recorded for: ${missing}.`,
    };
  }

  return {
    verdict: 'unverified',
    criteria,
    factChecks,
    summary: `${String(unsatisfied.length)} criteria are not satisfied.`,
  } satisfies VerificationResult;
}

export function isProven(result: VerificationResult): boolean {
  return result.verdict === 'verified';
}

export function claimsMatchFacts(
  claimed: Readonly<Record<string, number>> | undefined,
  facts: Readonly<Record<string, number>>,
): readonly string[] {
  if (claimed === undefined) return [];
  const mismatches: string[] = [];
  for (const [key, value] of Object.entries(claimed)) {
    const actual = facts[key];
    if (actual === undefined || actual !== value) {
      mismatches.push(`${key}: claimed ${String(value)}, recorded ${String(actual ?? 'nothing')}`);
    }
  }
  return mismatches;
}
