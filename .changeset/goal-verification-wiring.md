---
"@moonshot-ai/agent-core-v2": minor
---

Verify a goal's completion before accepting it, behind the `KIMI_CODE_EXPERIMENTAL_GOAL_VERIFICATION` flag: an `UpdateGoal` claiming `complete` is checked against criteria the goal declares, and a claim the machine can disprove is refused so the model can fix it.