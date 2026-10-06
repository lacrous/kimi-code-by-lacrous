# Goal verification

Author: lacrous.

`packages/agent-core-v2/src/features/computerUse/goalVerifier.ts` answers the
question the computer-control plan puts plainly: **never trust the model's claim
that a goal was completed.**

## What exists already

The `complete` outcome of the goal tools carries a thorough audit instruction
(`features/goal/goalService.ts`):

> Completion audit: before calling `complete`, verify the current state against
> the actual objective and every explicit requirement. Treat weak or indirect
> evidence as not complete. Do not mark complete merely because a budget is
> nearly exhausted or you want to stop.

That is good instruction. It is still the model's own word, and nothing checks
it. `verifyGoal` is the part that does not take the model's word.

## Verdicts

| Verdict | Meaning |
|---|---|
| `verified` | every criterion and every threshold satisfied by recorded evidence |
| `unverified` | criteria exist and were checked, but some are not satisfied |
| `contradicted` | the run **recorded** a value below a required threshold |
| `insufficient_evidence` | a criterion cannot be checked, or nothing was recorded |

`contradicted` is separate from `insufficient_evidence` on purpose. "I saw no
evidence of revenue" and "the recorded revenue is 0 when 100 was required" are
different failures, and the second is much more informative.

## The default is refusal

`verified` requires **all** criteria satisfied **and** all thresholds met. A
criterion with no automatic check resolves to unsatisfied, never to whatever the
model implied. A goal with zero criteria is never verified. Every missing piece
of evidence produces a verdict that is not `verified`, so an unproven goal
cannot be reported as done.

## Evidence, not assertions

Each criterion names how it is checked without asking the model:

```ts
{ kind: 'evidence_exists', kindOf: 'screenshot' }
{ kind: 'file_exists', path: '…' }
{ kind: 'file_contains', path: '…', pattern: '…' }
{ kind: 'command_succeeded', command: '…' }
{ kind: 'manual' }
```

Evidence carries a timestamp and `beforeClaim`, so a frame captured *after* the
claim cannot retroactively justify it.

## Claims versus the record

`claimsMatchFacts` compares what the model said against what the run recorded:

```
revenue: claimed 100, recorded 0
```

A model reporting 120 when the log holds 0 has claimed success it did not
achieve. That gap is worth surfacing on its own, and it is not the same thing as
having no evidence at all.

## The benchmark scenario is a test

`goalVerifierBenchmark.test.ts` pins the $100 experiment from the plan: a claim
of 100 with 0 recorded returns `contradicted`, `isProven` is `false`, and the
summary names the shortfall. The paired test verifies the goal once a statement
screenshot exists and the recorded revenue agrees.

So the first time an agent is asked to prove it made money, the code that
answers is already tested against exactly that question.

## Not wired into the goal tools yet

`verifyGoal` is complete and tested, but `markComplete` in `features/goal/` does
not call it. Wiring it in means deciding whether an unverified `complete` should
be rejected outright or downgraded to a continuation with the shortfall fed back
to the model — a policy question, not a mechanical one.