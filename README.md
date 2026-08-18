# pi-memory

A persistent, file-based memory architecture for the pi coding agent.

The extension is intentionally small and keeps its behavior documented in
source comments and executable tests.

## What it does

Three retrieval tiers:

| Tier      | Trigger                          | Content                                          |
| --------- | -------------------------------- | ------------------------------------------------ |
| pinned    | every turn, unconditional        | files with `metadata.pinned: true`               |
| selected  | every user message, LLM selector | <= 5 files chosen from name + type + description |
| on-demand | the model's own judgement        | any file, via the `read` tool                    |

Two scopes, both private to the user — nothing is shared and nothing is written
into the project itself:

| Scope   | Directory                                         | Holds                                |
| ------- | ------------------------------------------------- | ------------------------------------ |
| user    | `~/.pi/agent/memory/`                             | what stays true across every project |
| project | `~/.pi/agent/project-memory/<project-path-slug>/` | what is true of this project only    |

The project is identified by the nearest ancestor of the cwd containing `.git`,
falling back to the cwd, so a subdirectory of a repo reaches the same memory as
its root. Each scope has its own `MEMORY.md`; both are injected. Project entries
are shown as `project/file.md` in `/memory list` and the selector listing.

## Install

Symlink the extension directory into pi's global extension path:

```
ln -s ~/src/pi-memory/extension ~/.pi/agent/extensions/memory
```

Then `/reload` in pi. Configure via `~/.pi/agent/memory-config.json`; every key
is optional; omitted keys use the built-in defaults.

## Commands

```
/memory list             scanned memories: scope, type, pinned state, size, age
/memory why              what the last turn injected and why
/memory budget           session byte budget and whether recall is still live
/memory dry-run <query>  run the selector without spending a turn
/memory doctor           write-path invariants: scope routing, index drift, names, duplicates
```

## Tests

```
node test/run.ts
```

No dependencies, no network, no model calls. The headless suite covers the
pure extension modules; interactive pi behavior still needs to be checked in pi.
