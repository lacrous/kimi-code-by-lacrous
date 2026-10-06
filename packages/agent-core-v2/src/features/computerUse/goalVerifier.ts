export const VERDICTS = ['verified', 'unverified', 'contradicted', 'insufficient_evidence'] as const;

export type Verdict = (typeof VERDICTS)[number];

export interface Evidence {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly observedAt: number;
  readonly beforeClaim: boolean;
  readonly source?: string;
}

export interface CheckContext {
  readonly evidence: readonly Evidence[];
  readonly run: (command: string) => Promise<number>;
  readonly readFile: (path: string) => Promise<string | undefined>;
  readonly fileExists: (path: string) => Promise<boolean>;
  readonly fetchText: (url: string) => Promise<string | undefined>;
}

export interface CheckOutcome {
  readonly satisfied: boolean;
  readonly detail: string;
}

export type Check =
  | { readonly kind: 'file_exists'; readonly path: string }
  | { readonly kind: 'file_contains'; readonly path: string; readonly pattern: string }
  | { readonly kind: 'command_succeeded'; readonly command: string }
  | { readonly kind: 'url_contains'; readonly url: string; readonly pattern: string }
  | { readonly kind: 'evidence_exists'; readonly kindOf: string }
  | { readonly kind: 'evidence_before'; readonly kindOf: string }
  | { readonly kind: 'fact_at_least'; readonly key: string; readonly value: number }
  | { readonly kind: 'fact_at_most'; readonly key: string; readonly value: number }
  | { readonly kind: 'fact_equals'; readonly key: string; readonly value: number }
  | { readonly kind: 'all_of'; readonly checks: readonly Check[] }
  | { readonly kind: 'any_of'; readonly checks: readonly Check[] }
  | { readonly kind: 'not'; readonly check: Check };

export type Criterion =
  | { readonly id: string; readonly description: string; readonly check: Check }
  | { readonly id: string; readonly description: string; readonly undecidable: true; readonly reason: string };

export interface CriterionResult {
  readonly criterionId: string;
  readonly satisfied: boolean;
  readonly undecidable: boolean;
  readonly detail: string;
}

export interface VerificationInput {
  readonly criteria: readonly Criterion[];
  readonly evidence: readonly Evidence[];
  readonly facts: Readonly<Record<string, number>>;
  readonly context: CheckContext;
  readonly claimedFacts?: Readonly<Record<string, number>>;
}

export interface VerificationResult {
  readonly verdict: Verdict;
  readonly criteria: readonly CriterionResult[];
  readonly summary: string;
}

async function runCheck(
  check: Check,
  context: CheckContext,
  facts: Readonly<Record<string, number>>,
): Promise<CheckOutcome> {
  switch (check.kind) {
    case 'file_exists': {
      const exists = await context.fileExists(check.path);
      return {
        satisfied: exists,
        detail: exists ? `${check.path} exists` : `${check.path} is missing`,
      };
    }
    case 'file_contains': {
      const text = await context.readFile(check.path);
      if (text === undefined) {
        return { satisfied: false, detail: `${check.path} could not be read` };
      }
      const found = text.includes(check.pattern);
      return {
        satisfied: found,
        detail: found
          ? `${check.path} contains "${check.pattern}"`
          : `${check.path} does not contain "${check.pattern}"`,
      };
    }
    case 'command_succeeded': {
      const code = await context.run(check.command);
      return {
        satisfied: code === 0,
        detail: `${check.command} exited ${String(code)}`,
      };
    }
    case 'url_contains': {
      const text = await context.fetchText(check.url);
      if (text === undefined) {
        return { satisfied: false, detail: `${check.url} could not be fetched` };
      }
      const found = text.includes(check.pattern);
      return {
        satisfied: found,
        detail: found
          ? `${check.url} contains "${check.pattern}"`
          : `${check.url} does not contain "${check.pattern}"`,
      };
    }
    case 'evidence_exists': {
      const found = context.evidence.some((e) => e.kind === check.kindOf);
      return {
        satisfied: found,
        detail: found ? `found ${check.kindOf} evidence` : `no ${check.kindOf} evidence`,
      };
    }
    case 'evidence_before': {
      const found = context.evidence.some((e) => e.kind === check.kindOf && e.beforeClaim);
      return {
        satisfied: found,
        detail: found
          ? `${check.kindOf} evidence predates the claim`
          : `no ${check.kindOf} evidence from before the claim`,
      };
    }
    case 'fact_at_least': {
      const actual = facts[check.key];
      const ok = actual !== undefined && actual >= check.value;
      return {
        satisfied: ok,
        detail: `${check.key}=${String(actual ?? 'missing')} needs >= ${String(check.value)}`,
      };
    }
    case 'fact_at_most': {
      const actual = facts[check.key];
      const ok = actual !== undefined && actual <= check.value;
      return {
        satisfied: ok,
        detail: `${check.key}=${String(actual ?? 'missing')} needs <= ${String(check.value)}`,
      };
    }
    case 'fact_equals': {
      const actual = facts[check.key];
      const ok = actual === check.value;
      return {
        satisfied: ok,
        detail: `${check.key}=${String(actual ?? 'missing')} needs = ${String(check.value)}`,
      };
    }
    case 'all_of': {
      const results = await Promise.all(check.checks.map((c) => runCheck(c, context, facts)));
      const ok = results.every((r) => r.satisfied);
      return {
        satisfied: ok,
        detail: results.map((r) => `${r.satisfied ? '' : 'failed: '}${r.detail}`).join('; '),
      };
    }
    case 'any_of': {
      const results = await Promise.all(check.checks.map((c) => runCheck(c, context, facts)));
      const ok = results.some((r) => r.satisfied);
      return {
        satisfied: ok,
        detail: ok
          ? (results.find((r) => r.satisfied)?.detail ?? 'a condition held')
          : `none held: ${results.map((r) => r.detail).join('; ')}`,
      };
    }
    case 'not': {
      const inner = await runCheck(check.check, context, facts);
      return { satisfied: !inner.satisfied, detail: `not (${inner.detail})` };
    }
    default:
      return { satisfied: false, detail: 'unknown check' };
  }
}

export async function verifyGoal(input: VerificationInput): Promise<VerificationResult> {
  const results: CriterionResult[] = [];

  for (const criterion of input.criteria) {
    if ('undecidable' in criterion) {
      results.push({
        criterionId: criterion.id,
        satisfied: false,
        undecidable: true,
        detail: `${criterion.description}: ${criterion.reason}`,
      });
      continue;
    }
    const outcome = await runCheck(criterion.check, input.context, input.facts);
    results.push({
      criterionId: criterion.id,
      satisfied: outcome.satisfied,
      undecidable: false,
      detail: `${criterion.description}: ${outcome.detail}`,
    });
  }

  const unmet = results.filter((r) => !r.satisfied);
  const undecidable = results.filter((r) => r.undecidable);

  if (results.length > 0 && unmet.length === 0) {
    return {
      verdict: 'verified',
      criteria: results,
      summary: `All ${String(results.length)} criteria are satisfied by recorded evidence.`,
    };
  }

  if (undecidable.length > 0) {
    return {
      verdict: 'insufficient_evidence',
      criteria: results,
      summary: `${String(undecidable.length)} of ${String(results.length)} criteria cannot be checked automatically: ${undecidable.map((c) => `${c.criterionId} (${c.detail})`).join('; ')}.`,
    };
  }

  const numericMisses = unmet.filter((r) => /needs [<>=]/.test(r.detail));
  if (numericMisses.length > 0) {
    return {
      verdict: 'contradicted',
      criteria: results,
      summary: `Recorded evidence contradicts the goal: ${numericMisses.map((r) => `${r.criterionId} (${r.detail})`).join(', ')}.`,
    };
  }

  return {
    verdict: 'unverified',
    criteria: results,
    summary: `${String(unmet.length)} criteria are not satisfied: ${unmet.map((r) => `${r.criterionId} (${r.detail})`).join('; ')}.`,
  };
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
