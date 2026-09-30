<div align="center">

# Kimi Code CLI — lacrous fork

**Bring-your-own-provider builds for Kimi Code CLI.**

[![Upstream](https://img.shields.io/badge/upstream-MoonshotAI%2Fkimi--code-8A8A8A?style=flat-square)](https://github.com/MoonshotAI/kimi-code)
[![License](https://img.shields.io/badge/license-MIT-C06014?style=flat-square)](LICENSE)
[![Fork of](https://img.shields.io/badge/fork%20of-21406fb4c-8250DF?style=flat-square)](#provenance)

A fork of [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) focused on making
**any OpenAI-compatible endpoint a first-class provider**, without a registry, without a
catalog entry, and without hand-writing model metadata.

</div>

---

## What this fork changes

Upstream already supports importing providers from a **custom registry** (`api.json`) and from
the public **models.dev catalog**. Both require a registry document to exist somewhere. This
fork adds the missing third path: **you type the endpoint, it discovers the models itself.**

| | Upstream | This fork |
|---|---|---|
| Import from `api.json` registry | ✅ | ✅ |
| Import from models.dev catalog | ✅ | ✅ |
| **Add a provider by hand** (`--type` + `--base-url` + key) | ❌ | ✅ `kimi provider add-manual` |
| **Models auto-discovered from the endpoint** | ❌ | ✅ `GET {baseUrl}/models` |
| **Cline as a built-in** (`kimi provider add-builtin cline`) | ❌ | ✅ |

### `kimi provider add-manual`

Configure any OpenAI-compatible endpoint and discover its models in one step:

```sh
kimi provider add-manual my-gateway \
  --type openai \
  --base-url https://gateway.example.com/v1 \
  --api-key "$MY_GATEWAY_KEY"
```

```
Added provider "my-gateway" (type=openai, base_url=https://gateway.example.com/v1).
Discovering models from the endpoint…
  - my-gateway/llama-4-70b
  - my-gateway/qwen3-max
  - my-gateway/mistral-large-2

Set a default with: kimi --model my-gateway/llama-4-70b
```

To keep the key out of `config.toml`, bind it to an environment variable instead:

```sh
kimi provider add-manual my-gateway \
  --type openai \
  --base-url https://gateway.example.com/v1 \
  --api-key-env MY_GATEWAY_KEY
```

#### Options

| Flag | Required | Description |
|---|---|---|
| `--type <type>` | yes | Wire protocol: `openai`, `openai_responses`, or `kimi` |
| `--base-url <url>` | yes | Base URL, e.g. `https://gateway.example.com/v1` |
| `--api-key <key>` | one of | Inline key. Falls back to `KIMI_REGISTRY_API_KEY` |
| `--api-key-env <VAR>` | one of | Read the key from this environment variable |

`anthropic` is intentionally rejected: the Anthropic Messages API has no model-list route, so
there is nothing to discover and models must be declared by hand.

**Discovery is best-effort, never silent.** If `{baseUrl}/models` is unreachable or returns
401, the provider is still saved and the command exits non-zero with instructions for
declaring models manually. You are never left with a provider that looks configured but
cannot resolve a model.

### `kimi provider add-builtin cline`

Cline pre-configured — endpoint and protocol already set:

```sh
kimi provider add-builtin cline --api-key "$CLINE_API_KEY"
```

This is the same OpenAI-compatible path with the base URL filled in
(`https://api.cline.bot/api/v1`). Models are still read live from the endpoint, never from a
hardcoded list, so the provider tracks Cline's current catalog. Cline is also available
through the catalog path (`kimi provider catalog add cline-pass`) when you prefer upstream's
metadata.

---

## How discovery works

Upstream's refresh orchestrator had four branches for maintaining a provider's model list:
managed OAuth, first-party platforms, managed-endpoint API keys, and custom registries. A
provider you typed in by hand matched none of them — `model_source = "discover"` existed in
the config schema but no code path ever acted on it.

This fork adds a fifth branch. For any provider with a declared `base_url`, no `oauth`
reference, and no registry `source`, it fetches `{base_url}/models` and writes one alias per
model.

**Design decisions worth knowing:**

- **One implementation, not two.** The CLI command does not reimplement discovery — it writes
  the provider record and delegates to the same engine refresh the TUI uses. A provider added
  from the CLI refreshes identically to one added from the TUI.
- **The provider record is user-owned.** Discovery rewrites *only* model aliases. It never
  touches the `base_url` or the credential you configured.
- **Declared-but-absent metadata gets conservative defaults.** Many OpenAI-compatible servers
  return bare `{ id }` rows. Those models still become usable aliases rather than being
  rejected.
- **Providers that other branches already own are excluded.** The managed Kimi endpoint and
  the synthetic `__kimi_env__` provider (injected by the `KIMI_MODEL_*` env overlay) are
  explicitly skipped, so discovery never double-fetches or clobbers them.
- **Embedding entries are dropped.** Endpoints routinely mix embedding and fine-tune models
  into `/models`; those cannot drive a chat turn and are skipped rather than offered.

### Discovery payload shapes accepted

| Endpoint returns | Handling |
|---|---|
| `{ "data": [{ "id": "..." }] }` | ✅ OpenAI standard |
| `[{ "id": "..." }]` | ✅ bare array |
| `{ "id": "...", "context_length": 200000 }` | context window read from the row |
| `object: "embedding"` rows | skipped — not usable for chat |

---

## Install

This fork is **not published to npm or the VS Code marketplace** — upstream's publishing
pipelines were intentionally removed from this repository so that nothing attempts to publish
under your account. Build and run it from source:

```sh
git clone https://github.com/lacrous/kimi-code-by-lacrous.git
cd kimi-code-by-lacrous
pnpm install
pnpm build
node apps/kimi-code/dist/main.mjs --version
```

For the **official, signed release**, use upstream's installer — it is the maintained
distribution channel and is unaffected by this fork:

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

Requires Node.js ≥ 24.15.0 and pnpm 10.33.0.

---

## Develop

```sh
pnpm dev:cli     # run the CLI in dev mode
pnpm test        # run tests
pnpm typecheck   # TypeScript check
pnpm lint        # oxlint (includes the no-comments guard)
pnpm build       # build all packages
```

Run the provider tests specifically:

```sh
npx vitest run apps/kimi-code/test/cli/provider.test.ts
npx vitest run packages/agent-core-v2/test/app/kosongConfig/discovery.test.ts
```

Architecture, coding rules, and contribution guidance live in [AGENTS.md](AGENTS.md) and
[CONTRIBUTING.md](CONTRIBUTING.md) — both inherited from upstream and still accurate for this
fork.

---

## Provenance

This repository is a fork of **[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)**,
an AI coding agent that runs in your terminal.

- **Upstream:** Moonshot AI · MIT License · [upstream repo](https://github.com/MoonshotAI/kimi-code) ·
  [upstream issues](https://github.com/MoonshotAI/kimi-code/issues)
- **Fork base commit:** `21406fb4c`
- **Changes in this fork:** model discovery for hand-written providers, `kimi provider
  add-manual`, `kimi provider add-builtin cline`, and removal of upstream's release/publish
  workflows.
- **This fork is not affiliated with or endorsed by Moonshot AI.** Kimi, Kimi Code, and
  related names and marks are the property of their respective owner.

All upstream code remains under the MIT License; see [LICENSE](LICENSE). Upstream
documentation is at
[moonshotai.github.io/kimi-code](https://moonshotai.github.io/kimi-code/en/).

To pull upstream changes in, add the upstream remote and merge:

```sh
git remote add upstream https://github.com/MoonshotAI/kimi-code.git
git fetch upstream && git merge upstream/main
```

## Acknowledgements

- **Moonshot AI** for Kimi Code CLI, the foundation of this fork.
- [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui) — upstream's
  TUI layer, used under its original license.

## License

MIT, unchanged from upstream. Copyright (c) 2026 Moonshot AI. See [LICENSE](LICENSE).
