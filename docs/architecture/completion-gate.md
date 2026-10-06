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

## Where it is wired in

`UpdateGoalTool` calls the gate before `markComplete`, so an `UpdateGoal`
with `status: complete` is checked first. Three details matter:

**A refusal does not end the turn.** The success path returns
`stopTurn: true`. A refusal returns a plain error result instead, which leaves
the turn running so the model can fix the shortfall. Returning `stopTurn` on a
refusal would end the turn with the goal still `active` and nothing scheduled to
continue it — the run would stop on a goal whose work it had actually finished,
which is a worse outcome than the false completion the gate prevents.

Because the turn stays open, the existing goal budget remains the backstop for a
model that cannot satisfy the criteria: it retries, reaches `max_steps_per_turn`
or a budget limit, and the run ends through the path that already handles that.

**It is opt-in.** `KIMI_CODE_EXPERIMENTAL_GOAL_VERIFICATION` must be set, so no
existing goal flow changes behaviour by default.

**Criteria come from the goal, not the model.** `CompletionCriteriaService`
reads `<workspace>/.kimi/goals/<goalId>/criteria.json`. A goal that declares
nothing yields one undecidable criterion, which the gate allows — a goal nobody
defined checks for is not one the machine can adjudicate.

## A bug worth recording

The criteria service was first registered inside the computer-use flag guard,
which produced `updateGoalTool depends on completionCriteriaService which is NOT
registered`. The DI container resolves every declared decorator and throws when
one is unregistered — making the constructor parameter optional does not help,
because the resolution happens before the value is bound.

So a service injected into a tool that is always active must be registered
unconditionally, regardless of the flag that gates its own feature. It now is,
before the guard, and it is inert without the env var. A test pins that the
service exists with the flag off.

## Tests

`completionGate.test.ts` — 13 cases, including the deadlock case stated as its
own test: a goal whose only criterion is `undecidable` is allowed through, with
the verdict still reported as `insufficient_evidence`. If someone later "fixes"
that by refusing, the test says exactly what broke.