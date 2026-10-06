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

A criterion names how it is checked without asking the model. The set is
deliberately broad, because a goal is not always a number:

```ts
{ kind: 'file_exists', path: 'dist/main.mjs' }
{ kind: 'file_contains', path: 'report.md', pattern: '# done' }
{ kind: 'command_succeeded', command: 'pnpm test' }
{ kind: 'url_contains', url: 'https://…', pattern: 'Order confirmed' }
{ kind: 'evidence_exists', kindOf: 'screenshot' }
{ kind: 'evidence_before', kindOf: 'screenshot' }
{ kind: 'fact_at_least', key: 'rows', value: 10 }
{ kind: 'fact_at_most', key: 'cost', value: 5 }
{ kind: 'fact_equals', key: 'state', value: 2 }
{ kind: 'all_of', checks: [ … ] }
{ kind: 'any_of', checks: [ … ] }
{ kind: 'not', check: { … } }
```

`all_of` / `any_of` / `not` nest, so a real goal composes:

```ts
{
  id: 'shipped',
  description: 'the build ships and nothing is left over',
  check: {
    kind: 'all_of',
    checks: [
      { kind: 'command_succeeded', command: 'pnpm build' },
      { kind: 'file_exists', path: 'dist/main.mjs' },
      { kind: 'not', check: { kind: 'file_exists', path: 'dist/main.mjs.map' } },
    ],
  },
}
```

Evidence carries a timestamp and `beforeClaim`, so a frame captured *after* the
claim cannot retroactively justify it.

A criterion the runtime genuinely cannot decide is written as
`{ undecidable: true, reason }`. That counts as **unproven**, never as
satisfied — "the writing is good" is not something a script can settle, and the
verifier says so rather than guessing.

## The checks actually run

`createNodeCheckContext` (`nodeCheckContext.ts`) wires the checks to the real
machine: `stat` for files, `readFile` with a byte cap, `/bin/sh -c` for commands
with a timeout, and `fetch` for URLs. So a criterion is decided by what happened,
not by what the model says happened.

Everything is bounded — a command timeout, a read cap, a fetch timeout — because
a verifier that can hang is worse than one that reports nothing.

## Claims versus the record

`claimsMatchFacts` compares what the model said against what the run recorded:

```
revenue: claimed 100, recorded 0
```

A model reporting 120 when the log holds 0 has claimed success it did not
achieve. That gap is worth surfacing on its own, and it is not the same thing as
having no evidence at all.

## What is verified

| Test file | Covers |
|---|---|
| `goalVerifier.test.ts` | every check kind, nesting, `beforeClaim`, numeric floors and ceilings, undecidable criteria, empty goals |
| `nodeCheckContext.test.ts` | the checks against the **real** filesystem and shell: relative paths, byte caps, exit codes, pipelines, missing binaries |

The numeric threshold in the plan was only an example, and the design does not
depend on it: a goal about a build passing, a file's contents, a page's text, a
budget ceiling or a set of conditions combining all of those is verified the
same way.

One judgement call worth noting: `fact_at_most` **contradicts** as loudly as
`fact_at_least`. Spending past a ceiling is as much a failure as falling short of
a floor, and an earlier version only flagged the floor.

## Not wired into the goal tools yet

`verifyGoal` is complete and tested, but `markComplete` in `features/goal/` does
not call it. Wiring it in means deciding whether an unverified `complete` should
be rejected outright or downgraded to a continuation with the shortfall fed back
to the model — a policy question, not a mechanical one.