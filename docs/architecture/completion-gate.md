# The completion gate

Author: lacrous.

`completionGate.ts` decides whether a completion claim may be accepted. It is
the answer to a question this plan asked and I deliberately did not answer
until the verifier existed.

## The rule

> Reject an unproven completion, **but only when the goal is actually
> checkable.**

## Why not the strict version

The obvious implementation — reject anything `verifyGoal` cannot prove — is a
deadlock generator, and I want to be explicit about that because the failure
mode is worse than the one it prevents.

Consider "improve the onboarding copy". No script can decide whether the copy is
good. Under the strict rule the model would be refused forever and the run
would burn its entire budget re-attempting the same completion. Every attempt
costs a model call and a screenshot; the goal never advances and never stops on
its own terms.

So the gate separates two failures that look similar and are not:

| Verdict | What happened | Decision |
|---|---|---|
| `contradicted` | the run **recorded** something on the wrong side of a stated threshold | **refuse** |
| `unverified` | a check ran and did not hold | **refuse** |
| `insufficient_evidence` | some criteria could not be checked; nothing was disproved | **allow** |

`insufficient_evidence` passing through is not a loophole. It means the goal is
not machine-checkable, and the honest response to that is to allow the
completion and record *why* it could not be verified — not to block forever.

## Two other escapes

- `enforce` defaults to **off**. No existing goal flow changes behaviour by
  accident; the gate reports a verdict either way, so the result is available
  even when nothing is blocked.
- `fromUser` **outranks every check.** A person saying "this is done" is not
  something to second-guess with a script.

## What a refusal says

Refusals carry feedback the model can act on, naming the criterion and the
reason:

```
Completion refused: recorded evidence contradicts this goal.
report.md is missing. Fix the shortfall before claiming completion.
```

A refusal that only said "no" would burn the same budget as the deadlock.

## `buildGoalCriteria`

A goal with no declared checks becomes a single criterion marked
`undecidable`, carrying the goal's own description. That keeps the gate
uniform — every goal has at least one criterion — while making "not
checkable" an explicit, visible state rather than an implicit pass.

## Not called from `markComplete` yet

`features/goal/goalService.ts` does not call `gateCompletion`. Wiring it means
answering what a refusal *does*: the completion is rejected and the model gets
another turn, which is the obvious behaviour, but it interacts with the
existing blocked-audit rule (three consecutive turns before `blocked`) and with
budget enforcement. That interaction is worth getting right in the goal service
rather than bolting on from outside it.

## Tests

`completionGate.test.ts` — 13 cases, including the deadlock case stated as its
own test: a goal whose only criterion is `undecidable` is allowed through, with
the verdict still reported as `insufficient_evidence`. If someone later "fixes"
that by refusing, the test says exactly what broke.