---
"@lacrous/kimi-code": minor
---

Add a per-provider auth scheme for OpenAI-compatible endpoints: send the key in a header you name, or send no credential at all for local servers. Set `[providers.<id>.auth_scheme]` with `kind = "custom-header"` and `header = "x-api-key"`, or with `kind = "none"`.