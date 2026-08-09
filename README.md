# pi-memory

A persistent, file-based memory architecture for the pi coding agent.

The extension is intentionally small and keeps its behavior documented in
source comments and executable tests.

## What it does

Three retrieval tiers:

| Tier | Trigger | Content |
|---|---|---|
| pinned | every turn, unconditional | files with `metadata.pinned: true` |
| selected | every user message, LLM selector | <= 5 files chosen from name + type + description |
| on-demand | the model's own judgement | any file, via the `read` tool |

Two scopes: `~/.pi/agent/memory/` (private) and `<project>/.pi/memory/` (team,
git-tracked). One `MEMORY.md` in the private dir indexes both, `team/`-prefixed
for project entries.

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
```

## Tests

```
node test/run.ts
```

No dependencies, no network, no model calls. The headless suite covers the
pure extension modules; interactive pi behavior still needs to be checked in pi.
