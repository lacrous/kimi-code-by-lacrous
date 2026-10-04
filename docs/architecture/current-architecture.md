# Current architecture

Author: lacrous. Written for the computer-control work, as Phase 0 of that
plan requires — understand the existing seams before adding a subsystem that
sits beside them.

This documents the code as it is, not as it should be. Every claim below is
anchored to a file that exists in this tree.

## The loop

```
User
  |
  v
CLI / TUI  (apps/kimi-code)
  |
  v
HumanTurn (packages/agent-core-v2/src/human/agent/turn.ts)
  |
  +--> ToolRegistry  (agent/toolRegistry/)
  |       resolves a ToolDefinition, checks approval, runs it
  |
  +--> LLmAdapter    (agent-core-v2/src/llm-adapter/)
          sends messages, returns tool calls
```

A turn ends when the model stops calling tools. There is no outer supervisory
loop above it today — see "What this means for autonomous runs" below.

## Four lifecycle scopes

`app/scopes.ts` defines the DI tiers. A unit is constructed inside exactly one:

| Scope | Lives for | Holds |
|---|---|---|
| `App` | process | feature registry, config, flags |
| `Workspace` | a workspace | workspace services |
| `Session` | one conversation | goals, todos, plans |
| `Agent` | one agent instance | tool-bound services |

`Feature` (`features/feature.ts`) is the contribution surface: a feature
declares services, tools, config and commands, and the framework instantiates
them in the right scope. `registerFeature` appends to a module-level list that
`featureAssembly` walks at startup.

## Tools

Two shapes exist, and the distinction matters.

**`defineTool`** (`human/tool/tool.ts`) — a plain object with
`execute({ toolCall })`. Used for the older tools.

**`AgentTool`** (`tool/toolContract.ts`) — `resolveExecution(args)` returning a
`ToolExecution`. The args are already parsed and validated against a zod schema,
so a handler never sees raw JSON. This is the current shape and the one new
tools should use.

A worked example, `TodoListTool`:

1. zod schema in `features/todo/tools/todo-list/todo-list.ts` describing `todos`
2. `resolveExecution` maps args to a human `description` and a `display` payload
3. `execute` does the work and returns `{ isError, output }`

Feature registration (`features/todo/todoFeature.ts`) is three lines: declare the
service, declare the tool with a name and domain, done. The framework handles
scoping, approval and disposal.

## Vision is already wired

This was the load-bearing question for computer control, and the answer is yes.

- `kosong` carries an `image_url` content part across all four provider wires
  (`providers/openai-legacy.ts`, `openai-responses.ts`, `anthropic.ts`,
  `google-genai.ts`).
- `human/media/tool.ts` (`ReadMediaFile`) already reads an image off disk and
  returns it to the model as a proper content part, gated on
  `capability.image_in`.
- `MediaStore` (`human/llm/media/store.ts`) is content-addressed: identical
  bytes collapse to one ref.

So a captured frame does not need new plumbing to reach the model. It needs to be
written to a `MediaStore` and returned as an `image_url` part — which is exactly
what `ComputerScreenshotTool` does.

## Already built, contrary to the plan's assumptions

The computer-control plan treats a large amount of this as greenfield. It isn't.

| Plan phase | Existing implementation |
|---|---|
| 14 — goal state, budget, deadline | `features/goal/` — 1,800 lines. Status machine (`active`/`paused`/`blocked`), `budgetLimits`, a deadline scheduler, and a hard budget that blocks tool calls once exhausted. |
| 15 — task manager | `features/todo/`, `features/plan/` |
| 16 — planning and replanning | `features/plan/` |
| 17 — failure recovery | retry and backoff in the turn loop |
| 21 — permission system | approval rules on every `ToolExecution`; CLI approval prompts |
| 29 — goal verification | the `complete` tool requires a completion audit and explicitly tells the model not to mark complete because a budget is nearly spent |
| 9, 10 — filesystem, terminal | `packages/kaos` |
| 2 — screenshot to model | `human/media/tool.ts` |
| 28 — scheduler | `features/cron/` |

The genuinely new ground is the `ComputerController` abstraction and its
platform adapters. That is the right place to start: it is the only part with no
existing owner, and everything else in the plan plugs into it.

## What this means for autonomous runs

Two gaps are structural, not missing features, and they should be closed before
the system is given long-running autonomy.

**No supervisory loop.** A turn runs until the model stops calling tools. Goal
budget enforcement, the deadline scheduler and completion verification all live
*inside* a turn. Nothing today re-enters the loop on a schedule or after a crash,
so "run until a deadline" needs a runtime above the turn, not a new tool.

**No observation policy.** Every tool result lands in context verbatim. A
computer-use loop produces a screenshot per action; at full resolution that
fills a context window in a few dozen actions. The policy has to decide which
actions earn a frame, which is `observationPolicy` in
`features/computerUse/observation.ts`.

## Environment reality

Checked on the dev machine, not assumed:

- Ubuntu 26.04.1, display on `:0`, X11 sockets present
- screen 1366x768, single `eDP-1` primary monitor (verified via `xrandr`)
- `xrandr` installed
- `xdotool`, `wmctrl`, `scrot`, `import` **not installed**

`UbuntuBackend` therefore shells out to the tool that owns each capability and
reports a specific, actionable error when one is absent — a missing binary
becomes `ComputerControlError` with class `environment` and the dependency name,
not a crash at import time.