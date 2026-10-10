# Providers and models

Lacrous Kimi Code CLI supports connecting to multiple LLM platforms simultaneously: one-click login via the Lacrous Kimi Code managed service, connecting Claude with an Anthropic API key, or connecting third-party inference services via the OpenAI-compatible protocol. Each provider corresponds to a specific API protocol; models are declared on top of providers with their own name, context length, and capabilities. This page explains how to configure each type of provider in `config.toml`.

## Supported provider types

The `type` field in the `providers` table determines which protocol implementation to use:

| Type | Protocol | Typical use |
| --- | --- | --- |
| [`kimi`](#kimi) | OpenAI-compatible | Lacrous Kimi Code managed service, Kimi Platform API key |
| [`anthropic`](#anthropic) | Anthropic Messages | Claude model family |
| [`openai`](#openai) | OpenAI Chat Completions | OpenAI and compatible services, DeepSeek, Qwen, etc. |
| [`openai_responses`](#openai_responses) | OpenAI Responses API | OpenAI's newer Responses interface |
| [`google-genai`](#google-genai) | Google GenAI | Gemini API |
| [`vertexai`](#vertexai) | Google GenAI on Vertex | Google Cloud Vertex AI |

All providers communicate with models in streaming mode by default. Capabilities such as thinking, vision, and tool use are matched automatically by model name prefix, so you typically do not need to declare them manually.

**Endpoint rules**: `base_url` must be `http(s)` and must not embed a username or password — put the key in `api_key` / `api_key_env` instead, so it never lands in the config file, a backup, or a debug dump. Plain `http://` is accepted only for hosts that cannot be reached from the public internet: `localhost`, `*.localhost`, `127.0.0.1`, `::1`, and the private ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `fc00::/7` and `fe80::/10`. A gateway on a public host must use `https`.

**Credential priority**: `api_key` or `api_key_env` (mutually exclusive alternatives — set exactly one) > `[providers.<name>.env]` sub-table key (only when neither is present) > if all are absent, startup fails with an error. Except for the explicitly declared `api_key_env`, the CLI does not fall back to shell environment variables for credentials. See [Config overrides: provider credentials](./overrides.md#provider-credentials).

## `/provider` — interactive provider management

Prefer not to edit TOML by hand? Type `/provider` in the TUI to open the **provider manager**, where you can interactively add or remove providers.

![The /provider provider manager](../../media/provider-manager.jpg)

The manager displays providers as a list of entries grouped by source. Navigation:

- ↑/↓ to move the cursor, ←/→ to page
- `e` to replace the API key saved for the current provider, then `Enter` to confirm — the key is never shown on screen, and the provider's models are refreshed with it
- `d` to delete the current provider (with `[y/N]` confirmation)
- Press Enter on the `[ Add New Platform ]` row to add a new provider

Entries that authenticate with an account rather than an API key — OAuth platforms from `/login` — refuse the edit and point you at `/login` instead. Their credential comes from the login session, so a key you typed here would be overwritten the next time the session refreshes. Kimi Platform entries do hold a real API key, so their key is editable here exactly like any other provider's.

Two paths when adding:

- **Known third-party provider**: fetches the model catalog from [models.dev](https://models.dev/), select a provider → enter an API key → select a default model. Vendors whose protocol the catalog does not declare (e.g. xai, openrouter, and other vendor-specific SDKs) are imported as OpenAI-compatible with a "guessed" note; when the catalog provides no usable endpoint, a base URL prompt appears first; proprietary protocols (Amazon Bedrock, Cohere) and unrecognized explicit protocols are refused. Deprecated and alpha-status models are excluded from the import list. If the public catalog is unreachable, the CLI falls back to a built-in snapshot of the catalog, so the import still works offline or in blocked networks
- **Custom registry (api.json)**: paste a custom registry URL and, for private registries, a Bearer token; the CLI automatically creates the `providers` / `models` entries. When a registry entry declares the `env` field (the name of the environment variable holding the API key), the CLI prints it as a hint — set `api_key_env` in `config.toml` yourself to use it. The binding is never automatic: the registry chooses both the variable name and the endpoint the credential is sent to, so it must not decide which of your secrets is read. For private registries the Bearer token itself is still stored as `source.apiKey` so the registry can be refetched on refresh. On later startup, providers from the same registry URL are refreshed together, so upstream provider additions, removals, and model metadata changes are synced.

::: warning
Lacrous Kimi Code OAuth managed accounts logged in via `/login` do not appear in `/provider`. Use `/login` and `/logout` to manage them.
:::

The same operations are also available in non-interactive environments via the shell command: [`kimi provider`](../reference/kimi-command.md#kimi-provider).

## Built-in providers

The `/provider` manager's "known third-party provider" path fetches a public catalog and adapts it, which works for vendors the catalog describes. For the vendors below, the CLI ships the endpoint, protocol, and key prefix as data, so you can add one by id without the catalog being reachable:

```sh
kimi provider add-builtin <providerId>
```

This writes a complete provider entry for you — protocol, `base_url`, and the API key you enter at the prompt — then refreshes its model list. Afterwards it is an ordinary provider: edit it, re-key it, or delete it like any other.

| Id | Name | Protocol | Key prefix | What it serves |
| --- | --- | --- | --- | --- |
| `cline` | Cline | OpenAI-compatible | — | One key for Anthropic, OpenAI, Google and more |
| `openrouter` | OpenRouter | OpenAI-compatible | — | One key for 400+ models across many providers |
| `opencode-zen` | OpenCode Zen | OpenAI-compatible | — | Curated models tested by the OpenCode team |
| `opencode-go` | OpenCode Go | OpenAI-compatible | — | OpenCode Zen models on the Go plan |
| `nvidia` | NVIDIA | OpenAI-compatible | `nvapi-` | NVIDIA-hosted open models, free developer tier |
| `nara` | NaraRouter | OpenAI-compatible | `sk-nry-` | Affordable multi-model gateway |
| `tokenharbor` | Token Harbor | OpenAI-compatible | `thk_live_` | One universal key for many AI providers |
| `openai` | OpenAI | OpenAI-compatible | `sk-` | GPT, o-series and Codex models |
| `anthropic` | Anthropic | Anthropic Messages | `sk-ant-` | Claude models |
| `gemini` | Google Gemini | Google GenAI | `AIza` | Gemini models |
| `grok` | xAI Grok | OpenAI-compatible | `xai-` | Grok models |
| `groq` | Groq | OpenAI-compatible | `gsk_` | Fast open models on Groq hardware |
| `qwen` | Qwen | OpenAI-compatible | `sk-` | Alibaba Qwen models |
| `minimax` | MiniMax | OpenAI-compatible | — | MiniMax models |
| `deepseek` | DeepSeek | OpenAI-compatible | `sk-` | DeepSeek chat and reasoning models |
| `mistral` | Mistral | OpenAI-compatible | — | Mistral and Magistral models |
| `huggingface` | Hugging Face | OpenAI-compatible | `hf_` | Open models via the Hugging Face router |

The key prefix is a hint shown at the prompt, not a validation rule — vendors change prefixes without notice, and rejecting a working key would be worse than showing no hint.

Two entries carry more than the table shows. `anthropic` and `gemini` do not accept a `Bearer` header, so `add-builtin` writes the `auth_scheme` each one expects; a `Bearer` there returns a 401 that looks identical to a bad key. `opencode-zen` lists Claude models on an OpenAI-compatible `/models` route but serves them over the Anthropic Messages API, so the entry pins `claude-*` to that protocol — without the pin those models list successfully and then fail on first use.

For how a key reaches any of these endpoints, see [Authentication and credentials](./authentication.md).

## `kimi`

For connecting to Moonshot AI's OpenAI-compatible interface, including the Lacrous Kimi Code managed service and Kimi Platform API keys.

- Default `base_url`: `https://api.moonshot.ai/v1`
- Credential key names: `KIMI_API_KEY`, `KIMI_BASE_URL`
- Additional capability: supports video upload

```toml
[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "sk-xxxxx"
```

> When using the Lacrous Kimi Code managed service, running `/login` automatically configures `base_url` and credentials, so no manual setup is needed.

## `anthropic`

For connecting to the Claude API. Standard Claude models automatically enable vision, tool use, and Thinking (where supported); custom or uncovered models need `capabilities` declared explicitly on `[models.<alias>]`.

- Default `base_url`: follows Anthropic SDK default
- Credential key names: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`
- Default `max_tokens`: inferred per model. To override, set `max_output_size` on the model alias

```toml
[providers.anthropic]
type = "anthropic"
api_key = "sk-ant-xxxxx"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
# max_output_size = 32000  # optional; omit to use the model-inferred default
```

## `openai`

For connecting to the OpenAI Chat Completions protocol, as well as any third-party service compatible with that protocol (override `base_url` as needed).

Third-party reasoning models (DeepSeek, Qwen, One API, etc.) work out of the box: the CLI automatically handles the `reasoning_content` field and `reasoning_effort` injection. If your gateway returns reasoning content under a non-standard field name, set `reasoning_key` on the model alias to override.

- Default `base_url`: `https://api.openai.com/v1`
- Credential key names: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

```toml
[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

### Custom auth headers and anonymous access

This subsection covers where an `openai` provider puts the API key, and how to turn the credential off. By default the key travels as `Authorization: Bearer <key>`, which is what OpenAI itself expects. Local servers and third-party gateways often disagree: some read the key from a header you name, and some check nothing at all. The `auth_scheme` table selects between those cases.

- `kind = "bearer"` — send the API key as `Authorization: Bearer <key>`, the default behavior; name it explicitly when you want the intent written down in the config
- `kind = "custom-header"` — send the API key in the header named by `header`, and send no `Authorization` header
- `kind = "none"` — send no credential at all, for a local or self-hosted server that does not check one

```toml
[providers.local-gateway]
type = "openai"
base_url = "http://localhost:8080/v1"

[providers.local-gateway.auth_scheme]
kind = "custom-header"
header = "x-api-key"
```

`api_key` or `api_key_env` still supplies the value that lands in that header — `auth_scheme` only changes where the credential goes, not what it is. A `custom-header` scheme without `header` is a configuration error.

`auth_scheme` also applies to the `anthropic` type, where it replaces the SDK's default `x-api-key` header the same way.

::: warning
`auth_scheme` applies to the `openai`, `openai_responses` and `anthropic` types only. Setting it on `google-genai` or `vertexai` fails with a configuration error instead of being silently ignored.
:::

## `openai_responses`

Corresponds to OpenAI's newer Responses API, always operating in streaming mode. Configuration is the same as `openai`, including [custom auth headers and anonymous access](#custom-auth-headers-and-anonymous-access).

- Default `base_url`: `https://api.openai.com/v1`
- Credential key names: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

```toml
[providers.openai-responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxxxx"
```

## `google-genai`

For connecting directly to the Google Gemini API. Thinking, vision, and multimodal capabilities are auto-detected by model name.

- Credential key name: `GOOGLE_API_KEY`

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
```

To route through a Gemini-compatible proxy or gateway, set `base_url` (or the `GOOGLE_GEMINI_BASE_URL` env var); when omitted, the SDK default `https://generativelanguage.googleapis.com` is used.

> Give the **host root only**. The Google GenAI SDK appends the API version and path itself (e.g. `/v1beta/models/<model>:generateContent`), so a trailing `/v1beta` would produce a doubled `/v1beta/v1beta/…`.

```toml
[providers.gemini]
type = "google-genai"
api_key = "xxxxx"
base_url = "https://your-gateway.example"
```

## `vertexai`

Shares the same implementation as `google-genai`; setting `type = "vertexai"` switches to the Vertex AI access path.

Authentication follows the standard Google Cloud ADC flow (`gcloud auth application-default login` or a `GOOGLE_APPLICATION_CREDENTIALS` service account JSON); this part is unrelated to Lacrous Kimi Code. **The project ID and region must be written in the `[providers.vertexai.env]` sub-table**. Simply `export GOOGLE_CLOUD_PROJECT` in the shell will not be read by the CLI.

```toml
[providers.vertexai]
type = "vertexai"

[providers.vertexai.env]
GOOGLE_CLOUD_PROJECT = "my-gcp-project"
GOOGLE_CLOUD_LOCATION = "us-central1"
```

```sh
gcloud auth application-default login   # one-time authentication
kimi
```

To route Vertex requests through a custom (e.g. proxied) endpoint, set `base_url` (or the `GOOGLE_VERTEX_BASE_URL` env var); when omitted, the SDK default regional `*-aiplatform.googleapis.com` host is used. As with `google-genai`, give the host root only. The SDK appends `/v1beta1/publishers/google/models/…` itself.

## OAuth and credential injection

The Lacrous Kimi Code managed service uses OAuth rather than static API keys. After running `/login`, the built-in authentication toolchain automatically writes and refreshes credentials, so no manual configuration is needed in `config.toml` for this.

## Next steps

- [Configuration files](./config-files.md) — full field reference for the `providers` and `models` tables
- [Config overrides](./overrides.md) — credential resolution priority rules for providers
- [Environment variables](./env-vars.md) — credential key names per provider type
