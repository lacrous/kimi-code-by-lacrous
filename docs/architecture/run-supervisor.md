# Supervising an autonomous run

Author: lacrous.

`packages/agent-core-v2/src/features/computerUse/supervisor.ts` is the layer that
decides whether a long autonomous run should take another action. It exists
because of a structural gap, not a missing feature.

## The gap

In this codebase a **turn** runs until the model stops calling tools. Goal
budget enforcement, the deadline scheduler and completion verification all run
*inside* a single turn. Nothing sits above that to:

- stop a run when a deadline passes,
- keep going after the model returns control,
- notice that the same action keeps failing,
- cap total actions across many turns.

`decideNext` is that missing layer. It is a **pure function** on purpose: every
rule is testable with no browser, no display and no model, which is why the
suite runs in milliseconds.

## Decisions

```ts
type SupervisorDecision =
  | 'continue' | 'goal_complete' | 'goal_blocked'
  | 'stop_max_actions' | 'stop_deadline' | 'stop_budget' | 'stop_loop';
```

The order of the checks is load-bearing:

1. already complete → `goal_complete`
2. blocked → `goal_blocked`
3. deadline passed → `stop_deadline`
4. budget spent → `stop_budget`
5. action cap reached → `stop_max_actions`
6. the same action failed past the retry limit → `stop_loop`
7. otherwise → `continue`

**Limits are checked before anything reports success.** "Stopped because the
deadline passed" and "finished the task" are different outcomes, and collapsing
them is how an autonomous run reports success it never verified. A test pins
that the two outcomes stay distinguishable.

## Two different loop detectors

The turn loop already has a cap — `MaxStepsExceededError` from
`loop_control.max_steps_per_turn`. That counts *steps within one turn*, so it
cannot see a loop that keeps each step small. `LoopDetector` (see
`../computer-control.md`) fingerprints the action and its arguments, and
`decideNext` stops a fingerprint that has failed more than `maxRetries` times.

Both are needed: one bounds a single turn, the other bounds the run.

## Retry policy

Only three of the nine failure classes are worth retrying:

| Retry | Not retry |
|---|---|
| `transient` | `authentication` — retrying a bad key is pointless |
| `network` | `invalid_action` — the action itself is wrong |
| `tool` | `application`, `model`, `unknown` |

`backoffDelayMs` grows exponentially and caps at 30 s, so a long run never waits
minutes on one stubborn call.

## Failures are counted per fingerprint

`recordAction` tracks failures keyed by the action fingerprint, not globally.
Three *different* transient failures are normal background noise; the same one
three times means the approach is wrong and the run should replan. A success
clears that fingerprint's count, and `recordAction` never mutates the state it
was given.

## Action log

`actionLog.ts` records every action as JSON lines: timestamp, action,
arguments, duration, success, failure class, and a reference to the frame
captured afterwards.

It is **append-only** because a log that can be rewritten is not evidence. When
a multi-day run goes wrong, the only question that matters is what it did and
what it saw at the time.

Reading tolerates damage: a truncated final line — normal after a crash — is
skipped rather than thrown on. Refusing to read the log at the moment it is most
needed would be the worst possible response.

`format()` renders the timeline you actually read after a failure:

```
2026-10-06 09:14:22  OK    browser.navigate
2026-10-06 09:14:25  FAIL  browser.click invalid_action: no such node
```

## Not wired into the agent yet

`decideNext`, `recordAction` and `ActionLog` are complete and tested, but no
runtime drives them yet. A caller has to invoke `decideNext` between turns,
apply the outcome, and feed results back through `recordAction`. That wiring
needs a place to live above `HumanTurn`, which does not exist yet.