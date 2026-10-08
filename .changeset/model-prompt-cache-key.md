---
"@lacrous/kimi-code": minor
---

Stop sending `prompt_cache_key` to OpenAI-compatible gateways that reject it: the CLI retries once without it and remembers the rejection for the session. Set `prompt_cache_key = false` under a model's entry in `config.toml` to turn it off from the start.
