# Authentication and credentials

[Providers and models](./providers.md) explains which protocol a provider speaks. This page covers the other half: how the CLI proves who you are to that endpoint, where the proof is kept on disk, and how to inspect or replace it without hand-editing TOML.

Two independent settings decide what a request carries. The **credential source** says where the secret comes from — an inline value, an environment variable, or an OAuth login. The **auth scheme** says how it is put on the wire — a `Bearer` header, a header you name, or nothing at all. The same provider can change either without touching the other.

## Credential sources

A provider resolves its credential by trying these in order and stopping at the first that yields a value:

| Source | Configuration | Notes |
| --- | --- | --- |
| Inline value | `api_key = "sk-…"` | Stored in `config.toml` in plaintext |
| Environment variable | `api_key_env = "OPENAI_API_KEY"` | Names the variable; the CLI does not read the secret from the config |
| Provider env table | `[providers.<id>.env]` | Used only when neither of the above is set |
| OAuth token | `[providers.<id>.oauth]` | Written and refreshed by `/login` |

Set exactly one of `api_key` and `api_key_env`. A provider that carries both is a configuration error rather than a silent preference for one — the ambiguity is what makes keys leak into the wrong place. If none of the four sources resolves, the CLI fails at startup instead of sending an unauthenticated request.

::: warning
Apart from the variable you name in `api_key_env`, the CLI never falls back to your shell environment for credentials. `export OPENAI_API_KEY=…` alone does nothing; the provider must reference it.
:::

The full priority rules, including project-level overrides, are in [Config overrides: provider credentials](./overrides.md#provider-credentials).

## Where credentials are stored

An inline `api_key` is written into `config.toml`, the same file that holds your models and permission settings. The CLI creates it with owner-only permissions (`0600`) inside a `0700` directory, so on a shared machine other users cannot read it — but the value is still plain text, and it travels with every backup of that file.

OAuth tokens are stored separately, as one JSON file per provider under `credentials/` in the data root, also `0600`. The default data root is `~/.kimi-code`, or whatever `KIMI_CODE_HOME` points at. [Data locations](./data-locations.md#directory-layout) maps the full directory tree.

If you would rather keep a key out of the config file entirely, give the provider an `api_key_env` instead and put the value in your shell profile or a secret manager. That is the recommended shape for shared machines and for CI.

::: warning
The `storage` field on `[providers.<id>.oauth]` accepts `"file"` and `"keyring"`, but only file storage is implemented today. Setting `"keyring"` is accepted without error and still writes the token to the credentials directory — do not rely on it to keep tokens out of the filesystem.
:::

## How the credential is sent

The `auth_scheme` table picks the header. `kind = "bearer"` sends `Authorization: Bearer <key>`, which is the default and what OpenAI-compatible endpoints expect. `kind = "custom-header"` sends the value in the header you name and omits `Authorization` entirely — the shape Anthropic and most self-hosted gateways want. `kind = "none"` sends nothing, for a local server that checks no credential at all.

`auth_scheme` changes where the value goes, not what it is: `api_key` or `api_key_env` still supplies it. The field applies to the `openai`, `openai_responses`, and `anthropic` types, and setting it on `google-genai` or `vertexai` is a configuration error. The full table and examples are in [Custom auth headers and anonymous access](./providers.md#custom-auth-headers-and-anonymous-access).

## Inspecting credentials

`kimi auth` answers "which providers can I actually use right now". Both read commands are strictly offline — they never contact a provider, never rotate a token, and never block on the network.

```sh
kimi auth list
kimi auth status <providerId>
```

```text
AUTHENTICATED kimi        PRESENT (oauth token cached, refreshable)  expires 2026-01-31T09:12:44.000Z
AUTHENTICATED openrouter  PRESENT (api_key from config.toml)
EXPIRED      deepseek    EXPIRED (cached token lapsed; the runtime refreshes it on the next request)
MISSING      anthropic   MISSING (api_key_env "ANTHROPIC_API_KEY" is not set or is empty)
NONE         local       PRESENT (auth_scheme = "none", no credential sent)
```

There are five states:

- `AUTHENTICATED` — a credential exists and will be sent.
- `EXPIRED` — an OAuth token exists but has lapsed; the runtime refreshes it on the next request, so this is not yet a failure.
- `REVOKED` — the server rejected the stored token; run `kimi auth login` again.
- `MISSING` — there is nothing to send, and requests will fail until you supply one. The detail names which of the four sources came up empty.
- `NONE` — deliberately distinct from `AUTHENTICATED`: the provider sets `auth_scheme = "none"` and its credential resolves successfully, but no secret is ever sent. Reporting that as signed in would be misleading.

Both commands accept `--json` for scripting. `kimi auth status <providerId>` reports a single provider as key/value lines instead of a table, and exits non-zero for a provider that is not configured.

## Replacing a credential

Rotating a key takes one command:

```sh
kimi auth login <providerId>
```

It prompts with the input hidden, writes the value to `api_key`, and clears any `api_key_env` the provider had, since keeping both is a configuration error. Because the value is read from the terminal rather than from an argument, it never appears in shell history or in the process list. The same operation is available in the [`/provider` manager](./providers.md#provider-—-interactive-provider-management): highlight a provider and press <kbd>E</kbd> to open the same hidden-input dialog. Deleting works the same way with <kbd>D</kbd>, which asks for confirmation first.

For scripts and unattended setup, [`kimi provider auth <providerId>`](../reference/kimi-command.md#kimi-provider-auth-providerid) takes the key as an argument instead. Prefer the hidden prompt by hand; the argument form puts the secret in your shell history and in `ps` output while it runs.

Providers that authenticate with OAuth refuse `kimi auth login` and point you at `kimi login` instead — their credential belongs to the login session and would be overwritten by it.

## Clearing a credential

Signing out and deleting a provider are different operations:

```sh
kimi auth logout <providerId>
```

This clears `api_key`, `api_key_env`, or the cached OAuth token, and leaves the provider entry, its model aliases, and `default_model` in place — so the configuration survives and only the secret is gone. To remove the provider itself, use `kimi provider remove <providerId>`, which drops the entry and everything pointing at it. If the provider had nothing stored, the command says so and exits successfully.

## Refreshing an OAuth token

Access tokens issued by `/login` are renewed automatically: the runtime refreshes one shortly before it lapses, so you never see an expired token fail a request. `kimi auth refresh <providerId>` forces that rotation immediately instead of at the next request.

The command only applies to OAuth providers. For a static API key it reports that the key does not expire, points at `kimi auth login`, and exits non-zero — because a static key is replaced, not refreshed.

## Next steps

- [Providers and models](./providers.md) — protocol types, the `/provider` manager, and the built-in provider catalog
- [Config overrides](./overrides.md) — the full credential priority order, including project-level overrides
- [Data locations](./data-locations.md) — every file the CLI writes, and how to relocate it
- [kimi command reference](../reference/kimi-command.md) — `kimi auth` and `kimi provider` in full