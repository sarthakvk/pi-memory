# pi-memory

Persistent, file-based memory for the [pi coding agent](https://pi.dev).

`pi-memory` gives pi durable context across conversations without writing memory files into your repositories. It keeps global user preferences separate from project-specific knowledge, injects essential memories automatically, and uses a configurable model to recall relevant details when needed.

## Features

- **Persistent Markdown storage** that is easy to inspect, edit, and back up
- **User and project scopes** so unrelated projects do not share context
- **Three retrieval tiers:** pinned, model-selected, and on-demand
- **Session budgets and file limits** to keep prompt growth controlled
- **Staleness reminders** for memories that may no longer be accurate
- **Diagnostic commands** for inspecting retrieval and finding malformed memories
- **Graceful failure:** memory or selector errors never block the main agent turn

## Requirements

- [pi](https://pi.dev) installed and configured
- Access to a pi model for relevance-based memory selection
- Node.js 22.18 or newer when running the test suite locally

## Installation

Install directly from GitHub as a global pi package:

```bash
pi install git:github.com/sarthakvk/pi-memory
```

Start pi, then verify the extension is loaded:

```text
/memory list
```

The user and project memory directories are created automatically on the first session.

To update or remove the package later:

```bash
pi update --extensions
pi remove git:github.com/sarthakvk/pi-memory
```

> pi extensions run with your system permissions. Review third-party extension source before installing it.

## Getting started

Ask pi to remember something naturally:

```text
Remember that I prefer pytest and concise commit messages.
```

Project-specific facts are stored separately:

```text
Remember that this project deploys from the main branch using GitHub Actions.
```

Use the built-in commands to inspect the result:

```text
/memory list
/memory why
/memory doctor
```

Memory is stored in two locations:

| Scope | Default location | Intended content |
| --- | --- | --- |
| User | `~/.pi/agent/memory/` | Preferences and facts that apply across projects |
| Project | `~/.pi/agent/project-memory/<project-slug>/` | Decisions and context specific to the current project |

The project scope is keyed by the nearest parent containing `.git`, so starting pi from a repository subdirectory still uses the same project memory. Nothing is written into the repository itself.

## Memory format

Each memory is a focused Markdown file with YAML frontmatter:

```markdown
---
name: prefers-pytest
description: User prefers pytest for Python test suites
metadata:
  type: feedback
---

Use pytest for Python tests unless the project already uses another framework.
```

Supported memory types are `user`, `feedback`, `project`, and `reference`.

Each scope also has a `MEMORY.md` index containing short links to its unpinned memories:

```markdown
- [Python testing preference](prefers-pytest.md) — Use pytest for Python tests
```

Add `pinned: true` under `metadata` only when a memory must be present in every conversation. Pinned memories are injected directly and should not also appear in `MEMORY.md`.

You normally do not need to manage these files manually—the extension teaches pi how to create, update, route, and remove them. Never store secrets or credentials in memory.

## Configuration

Configuration is optional. Create `~/.pi/agent/memory-config.json` to override selected defaults:

```json
{
  "selector": {
    "model": "anthropic/claude-haiku-4-5",
    "maxSelected": 5,
    "timeoutMs": 5000
  },
  "maxPinned": 8,
  "maxSessionBytes": 61440
}
```

Replace `selector.model` with an authenticated `provider/model-id` available in your pi installation. Use `pi --list-models` to inspect available models. If the configured selector model or its credentials are unavailable, model-selected recall is disabled for that session; indexes and pinned memories still work.

All available settings:

| Setting | Default | Behavior |
| --- | ---: | --- |
| `enabled` | `true` | Enables the extension |
| `dir` | `~/.pi/agent/memory` | User memory directory |
| `projectMemoryRoot` | `~/.pi/agent/project-memory` | Parent directory for project memory; set to `""` to disable project memory |
| `selector.enabled` | `true` | Enables relevance-based recall |
| `selector.model` | `openai-codex/gpt-5.6-luna` | Exact pi model reference used by the selector |
| `selector.maxSelected` | `5` | Maximum memories selected for one query |
| `selector.timeoutMs` | `5000` | Selector timeout in milliseconds |
| `maxSessionBytes` | `61440` | Cumulative selected-memory budget per session; pinned memory is excluded |
| `maxFiles` | `200` | Maximum files scanned across both scopes, newest first |
| `scanMaxLines` | `30` | Lines read from each file while scanning metadata |
| `scanMaxBytes` | `65536` | Bytes read from each file while scanning metadata |
| `fileMaxLines` | `200` | Maximum lines injected from one memory file |
| `fileMaxBytes` | `4096` | Maximum bytes injected from one memory file |
| `indexMaxLines` | `200` | Maximum lines injected from each `MEMORY.md` |
| `indexMaxBytes` | `25000` | Maximum bytes injected from each `MEMORY.md` |
| `maxPinned` | `8` | Maximum pinned memories injected, newest first |

Set `PI_MEMORY_DISABLED=1` to disable the extension temporarily. Invalid configuration values are ignored in favor of their defaults.

## Commands

| Command | Description |
| --- | --- |
| `/memory list` | List scanned memories with scope, type, pinned state, size, and age |
| `/memory why` | Show what the previous turn injected and why |
| `/memory budget` | Show session recall usage and selector statistics |
| `/memory dry-run <query>` | Preview selection and injection without spending session budget |
| `/memory doctor` | Check scope routing, index links, names, descriptions, and duplicates |

## How it works

On every user turn, the extension:

1. Resolves the user and project memory directories and rescans their Markdown files.
2. Appends memory-writing policy, both `MEMORY.md` indexes, and pinned memories to pi's system prompt.
3. Sends the user query plus memory names, types, descriptions, and timestamps to the configured selector model.
4. Injects the bodies of relevant memories, up to the configured limits and session budget.
5. Marks selected memories as surfaced so they are not selected repeatedly in the same session.

The indexes give the main model a compact map of available knowledge. If additional detail is needed, pi can read the corresponding Markdown file on demand.

Memory files remain local, but model usage follows your normal provider data path: the selector receives the current query and memory metadata, while selected memory content is sent to the main model as part of its system prompt.

## Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/sarthakvk/pi-memory.git
cd pi-memory
npm install
```

Run the complete headless test suite:

```bash
npm test
```

The tests make no network or model calls. To test the extension interactively from the checkout:

```bash
pi -e ./extension/index.ts
```

## Contributing

Suggestions and improvements are welcome. Please feel free to [open an issue](https://github.com/sarthakvk/pi-memory/issues) for bugs or ideas, or create a pull request to contribute a change.
