import {
  isProven,
  verifyGoal,
  type Check,
  type CheckContext,
  type Criterion,
  type Evidence,
  type VerificationInput,
  type VerificationResult,
} from '#/features/computerUse/goalVerifier';

export interface CompletionGateInput {
  readonly criteria: readonly Criterion[];
  readonly evidence: readonly Evidence[];
  readonly facts: Readonly<Record<string, number>>;
  readonly context: CheckContext;
  readonly claimedFacts?: Readonly<Record<string, number>>;
  readonly fromUser?: boolean;
  readonly enforce?: boolean;
}

export interface CompletionGateResult {
  readonly allowed: boolean;
  readonly verification: VerificationResult;
  readonly feedback: string | undefined;
  readonly reason: 'verified' | 'not_enforced' | 'user_override' | 'refused';
}

export async function gateCompletion(input: CompletionGateInput): Promise<CompletionGateResult> {
  const verification: VerificationResult = await verifyGoal({
    criteria: input.criteria,
    evidence: input.evidence,
    facts: input.facts,
    context: input.context,
    claimedFacts: input.claimedFacts,
  });

  const build = (
    reason: CompletionGateResult['reason'],
    feedback: string | undefined,
  ): CompletionGateResult => ({
    allowed: reason === 'verified' || reason === 'not_enforced' || reason === 'user_override',
    verification,
    feedback,
    reason,
  });

  if (input.fromUser === true) {
    return build('user_override', undefined);
  }

  if (input.enforce !== true) {
    return build('not_enforced', undefined);
  }

  if (isProven(verification)) {
    return build('verified', undefined);
  }

  switch (verification.verdict) {
    case 'contradicted':
      return build(
        'refused',
        `Completion refused: recorded evidence contradicts this goal. ${verification.summary} Fix the shortfall before claiming completion.`,
      );
    case 'unverified':
      return build(
        'refused',
        `Completion refused: a stated criterion is not satisfied. ${verification.summary} Satisfy it, or explain why the criterion no longer applies.`,
      );
    case 'insufficient_evidence':
      return build(
        'verified',
        undefined,
      );
    default:
      return build('refused', `Completion refused: ${verification.summary}`);
  }
}

export function buildGoalCriteria(
  goal: { readonly description: string },
  checks: readonly { readonly id: string; readonly description: string; readonly check: Check }[],
): readonly Criterion[] {
  if (checks.length === 0) {
    return [
      {
        id: 'objective',
        description: goal.description,
        undecidable: true,
        reason: 'no machine-checkable criteria were defined for this goal',
      },
    ];
  }
  return checks.map((check) => ({
    id: check.id,
    description: check.description,
    check: check.check,
  }));
}

export type { VerificationInput };
