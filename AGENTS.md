# Repository Guide

## Runtime And Checks

- Use Node >= 22.18: the repo executes `.ts` files directly via native type stripping. Keep TypeScript erasable and relative imports explicit (`./module.ts`); there is no compile step.
- Run the complete headless suite with `npm test` (equivalent to `node test/run.ts`). It uses no network or model calls.
- Do not use `devbox run test`; `devbox.json` contains only the generated failing placeholder. There are no configured lint, formatter, typecheck, or CI commands.
- The custom runner imports every suite and has no test-name/file filter. Running a `*.test.ts` file directly only registers cases and reports nothing.

## Architecture

- `extension/index.ts` is the pi entrypoint and the only module that should import pi/pi-ai at runtime. It owns hooks, `/memory`, model lookup, and provider wiring.
- Keep `extension/runtime.ts` and its dependencies limited to plain data and `node:*`; tests drive this boundary with mocked `CompleteFn` providers. `runtime.ts` orchestrates config, scan, selection, injection, session state, and command rendering.
- `prompt/*.md` files are runtime inputs loaded by `extension/prompts.ts` and `extension/inject.ts`, not documentation. Edit prompt prose there rather than duplicating it in TypeScript.
- When changing policy placeholders or project-conditional blocks, keep `prompt/*.md` synchronized with `renderPolicyTemplate` in `extension/prompts.ts`; pipeline tests assert rendered prompt text and section order.
- Defaults and limits live together in `extension/config.ts`. Config is read from `<PI_AGENT_DIR>/memory-config.json` (normally `~/.pi/agent/memory-config.json`); memory data is stored outside the repo in user and project-scoped directories.

## Integration Boundary

- Headless tests do not exercise pi hook registration, UI notifications, real model credentials, or installation. For those changes, symlink `extension/` into `~/.pi/agent/extensions/memory`, run `/reload` in pi, and check behavior interactively.
