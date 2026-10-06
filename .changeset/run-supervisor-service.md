---
"@moonshot-ai/agent-core-v2": minor
---

Add a run supervisor that decides whether an autonomous goal continues after each turn: it tracks actions across turns, checks a deadline, and notices when the same action has failed repeatedly.