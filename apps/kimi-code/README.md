# @lacrous/kimi-code

> The Starting Point for Next-Gen Agents

[![npm](https://img.shields.io/npm/v/@lacrous/kimi-code)](https://www.npmjs.com/package/@lacrous/kimi-code) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)  [![Docs](https://img.shields.io/badge/docs-online-blue)](https://moonshotai.github.io/kimi-code/en/)

> **This is a fork, not the official package.** It is published by
> [lacrous](https://github.com/lacrous) under a different npm name than
> Moonshot AI's [`@moonshot-ai/kimi-code`](https://www.npmjs.com/package/@moonshot-ai/kimi-code),
> from source at [lacrous/kimi-code-by-lacrous](https://github.com/lacrous/kimi-code-by-lacrous).
> It is not affiliated with or endorsed by Moonshot AI. Kimi, Lacrous Kimi Code and
> related names and marks are the property of their respective owner.
>
> What this fork changes: model discovery for hand-written providers, 17
> built-in vendor endpoints, `kimi provider add-manual` / `add-builtin`, the
> `/provider` built-in flow, and model-id search in the picker. Upstream's
> release and publish workflows are intentionally absent — nothing here is
> published by upstream's pipeline.
>
> One deliberate difference: **this package does not self-update.** The version
> and native-binary manifests live on Moonshot's CDN and describe
> `@moonshot-ai/kimi-code`, so consulting them here would try to install this
> package at a version that does not exist. Upgrade with
> `npm install -g @lacrous/kimi-code@latest`.

## What is Lacrous Kimi Code CLI

Lacrous Kimi Code CLI is an AI coding agent that runs in your terminal. It can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

## Install

This is a fork of [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) published
under a different npm name. Install it from npm — the `install.sh` / `install.ps1` scripts
linked below belong to the upstream project and install `@moonshot-ai/kimi-code`, not this
package.

```sh
npm install -g @lacrous/kimi-code
```

Or with pnpm:

```sh
pnpm add -g @lacrous/kimi-code
```

Requires Node.js 22.19.0 or later.

On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because Lacrous Kimi Code CLI uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIMI_SHELL_PATH` to the absolute path of `bash.exe`.

Then run it with a new Terminal session:

```sh
kimi --version
```

> Upstream's install scripts (for `@moonshot-ai/kimi-code`): macOS / Linux
> `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`, Windows
> `irm https://code.kimi.com/kimi-code/install.ps1 | iex`.

For upgrade and uninstall instructions, see the [Getting Started guide](https://moonshotai.github.io/kimi-code/en/guides/getting-started).

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
kimi
```

On first launch, run `/login` inside Lacrous Kimi Code CLI and choose either Lacrous Kimi Code OAuth or a Kimi Platform API key. After login, try a first task:

```
Take a look at this project and explain the main directories.
```

## Key Features

- **Single-binary distribution.** Install with one command — no Node.js setup, no PATH gymnastics, no global module conflicts.
- **Blazing-fast startup.** The TUI is ready in milliseconds, so opening a session never feels heavy.
- **Polished TUI.** A carefully tuned interface designed for long, focused agent sessions.
- **Video input.** Drop a screen recording or demo clip into the chat — let the agent watch instead of typing out what's hard to describe in words.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally via `/mcp-config` — no hand-editing JSON.
- **Subagents for focused, parallel work.** Dispatch built-in `coder`, `explore`, and `plan` subagents in isolated context windows; the main conversation stays clean.
- **Lifecycle hooks.** Run local commands at key points — gate risky tool calls, audit decisions, fire desktop notifications, wire into your own automation.

## Documentation

- Full docs: https://moonshotai.github.io/kimi-code/en/
- 中文文档: https://moonshotai.github.io/kimi-code/zh/
- Getting Started: https://moonshotai.github.io/kimi-code/en/guides/getting-started

## Repository & Issues

- Source: https://github.com/MoonshotAI/kimi-code
- Issues: https://github.com/MoonshotAI/kimi-code/issues
- Security: see SECURITY.md in the main repository

## License

MIT
