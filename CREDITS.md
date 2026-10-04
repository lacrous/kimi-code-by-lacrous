# Credits

This fork exists because of two projects and two people.

## Upstream

**Kimi Code CLI** — Moonshot AI · MIT License
<https://github.com/MoonshotAI/kimi-code> · <https://moonshotai.github.io/kimi-code/en/>

Everything in this repository that is not listed under "Fork changes" below is upstream
work, Copyright (c) 2026 Moonshot AI, and remains under the MIT License in [LICENSE](LICENSE).
The fork is based on upstream commit `21406fb4c` (kimi-code 2.1.1).

Upstream documentation, issue tracker and the maintained, signed release channel all live in
that repository — see the fork's [README](README.md#provenance) for links.

## Fork changes by lacrous

**Author: lacrous** · <https://github.com/lacrous>

### Files authored in this fork

These are new; the whole file is the fork's work and carries an author line in its header.

| File | What it does |
|---|---|
| `packages/oauth/src/discover-models.ts` | Model discovery for hand-written providers — fetches `{base_url}/models`, handles Bearer / `x-api-key` / `x-goog-api-key` auth, and both the OpenAI (`data[].id`) and Google (`models[].name`) response shapes. |
| `apps/kimi-code/src/utils/built-in-providers.ts` | The 17 built-in vendor endpoints, their wire, display name, key-prefix hint and discovery auth style. Shared by the CLI and the TUI so an endpoint cannot differ between them. |
| `scripts/kimi-dev.mjs` | `pnpm run kimi` — runs the CLI from this checkout against an isolated `KIMI_CODE_HOME`, so a dev run never touches an installed `kimi`'s config. |

### Upstream files modified

These are upstream's files. The upstream copyright notice is left intact, as the MIT License
requires; the fork's edits to them are recorded here instead of by rewriting their headers.

| File | Change |
|---|---|
| `packages/oauth/src/refreshProviderModels.ts` | New discovery branch: populates model aliases for a provider that has a declared base URL, no oauth ref and no registry source. Also the per-wire auth/version profile used by that branch. |
| `packages/oauth/src/index.ts` | Exports the new discovery module. |
| `packages/agent-core-v2/test/app/kosongConfig/discovery.test.ts` | Tests for the discovery branch, including the exclusions (managed endpoint, `__kimi_env__`). |
| `apps/kimi-code/src/cli/sub/provider.ts` | `kimi provider add-manual` and `kimi provider add-builtin`. |
| `apps/kimi-code/src/tui/commands/provider.ts` | The `/provider` built-in flow: key prompt, discovery, default-model picker. |
| `apps/kimi-code/src/tui/components/dialogs/model-selector.ts` | Model search now matches the alias and model id, not only the display label. |
| `apps/kimi-code/test/cli/provider.test.ts` | Tests for the new commands and the vendor table. |
| `apps/kimi-code/test/tui/components/dialogs/model-selector.test.ts` | Test that search matches a gateway model id. |
| `apps/kimi-code/package.json`, `package.json` | The `kimi` / `dev:local` script entries. |
| `.gitignore` | Ignores the dev runner's isolated config home. |
| `README.md` | Fork documentation. |

### Workflows removed from this fork

Upstream's nine GitHub Actions workflows are intentionally **not** present here. `release.yml`
publishes to npm via OIDC trusted publishing, `vscode-publish.yml` publishes to the VS Code and
Open VSX marketplaces, and the native-build workflows require Apple signing certificates —
none of which should or can run under a personal account. Nothing in this fork is published to
any package registry; build from source.

## Acknowledgements

- **Moonshot AI** for Kimi Code CLI, the foundation of this fork.
- [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui) — upstream's TUI
  layer, used under its original license.
- The vendors behind the built-in providers (Cline, OpenRouter, OpenCode, NVIDIA, NaraRouter,
  Token Harbor, OpenAI, Anthropic, Google, xAI, Groq, Alibaba, MiniMax, DeepSeek, Mistral,
  Hugging Face), whose public APIs the discovery path reads.
