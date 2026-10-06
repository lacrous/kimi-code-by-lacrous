---
"@moonshot-ai/agent-core-v2": minor
---

Add the layer that supervises an autonomous run between turns: decide whether to continue, complete, block or stop on deadline, budget, action limit or a repeating failure; classify which failures are worth retrying; and record every action to an append-only log.