---
"@lacrous/kimi-code": minor
---

Stop accepting a plaintext `http://` provider base URL unless the host is the local machine or a private network; a remote HTTP provider can no longer be added without `KIMI_CODE_ALLOW_INSECURE_PROVIDER_HTTP=1`.