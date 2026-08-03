# pi-memory

A persistent, file-based memory architecture for the pi coding agent.

`SPEC.md` is the source of truth. It is written before the code, carries a
stable `REQ-<AREA>-<n>` id for every requirement, and gives the rationale for
every prompt, constant, and routing rule. Every test names the requirements it
covers.

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
is optional (defaults and their rationale are in SPEC.md section 3).

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

No dependencies, no network, no model calls. The runner prints the REQ ids
covered by passing tests. SPEC.md section 11 lists what the headless suite
cannot verify and has to be checked interactively.

## Requirement coverage

`node test/run.ts` prints the REQ ids covered by passing tests and the runner
cross-checks against SPEC.md. 156 cases, 85/85 requirements covered.
