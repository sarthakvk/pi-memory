/**
 * pi-memory — a three-tier memory architecture for pi.
 *
 * This is the only module that imports pi or pi-ai. It owns the hooks, the
 * `/memory` command, and the provider wiring; everything else lives in
 * `runtime.ts` and its dependencies, which import nothing but `node:*` so the
 * whole pipeline stays headlessly testable.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  attachSelector,
  initSession,
  renderBudget,
  renderDoctor,
  renderDryRun,
  renderList,
  renderWhy,
  rescan,
  runTurn,
  USAGE,
  type SessionState,
} from "./runtime.ts";
import type { CompleteArgs, CompleteFn, SelectorResponse } from "./selector.ts";

let state: SessionState | undefined;

/**
 * Equivalent of pi's `findExactModelReferenceMatch`, which is not exported to
 * extensions. Accepts `provider/modelId` or a bare `modelId`;
 * an ambiguous bare id is rejected rather than guessed at.
 */
export function findModel(reference: string, available: Model<Api>[]): Model<Api> | undefined {
  const canonical = available.find((m) => `${m.provider}/${m.id}` === reference);
  if (canonical) return canonical;
  const bare = available.filter((m) => m.id === reference);
  return bare.length === 1 ? bare[0] : undefined;
}

/**
 * Build the `CompleteFn` the selector drives, or explain why we cannot.
 * Uses the pattern from pi's own `examples/extensions/summarize.ts`.
 */
async function makeCompleteFn(
  ctx: ExtensionContext,
  modelReference: string,
): Promise<{ fn: CompleteFn } | { error: string }> {
  const model = findModel(modelReference, ctx.modelRegistry.getAvailable());
  if (!model) return { error: `selector model "${modelReference}" not found in the model registry` };

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return { error: `selector model "${modelReference}": ${auth.error}` };
  if (!auth.apiKey) return { error: `selector model "${modelReference}": no API key configured` };

  const fn: CompleteFn = async (args: CompleteArgs): Promise<SelectorResponse> => {
    const context = {
      systemPrompt: args.systemPrompt,
      messages: args.messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp ?? Date.now(),
      })),
      tools: args.tools,
    };
    const response = await complete(model, context as never, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      maxTokens: args.maxTokens,
      signal: args.signal,
      // pi-ai places Anthropic-style cache markers itself.
      cacheRetention: "short",
      // Honoured by providers that support it; ignored by the rest, which then
      // fall through to the selector's defensive text-parsing path.
      toolChoice: "required",
    });
    return {
      content: response.content as SelectorResponse["content"],
      stopReason: response.stopReason,
    };
  };

  return { fn };
}

/** Lazily wire the selector on first use so a silent session pays nothing. */
async function ensureSelector(s: SessionState, ctx: ExtensionContext): Promise<void> {
  if (!s.config.selector.enabled || s.selectorDisabledReason || s.selector) return;
  const built = await makeCompleteFn(ctx, s.config.selector.model);
  if ("error" in built) {
    s.selectorDisabledReason = built.error;
    if (ctx.hasUI) ctx.ui.notify(`memory: ${built.error}; recall disabled`, "warning");
    return;
  }
  attachSelector(s, built.fn);
}

async function show(ctx: ExtensionContext, lines: string[]): Promise<void> {
  if (!ctx.hasUI) {
    console.log(lines.join("\n"));
    return;
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

export default function memoryExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    try {
      state = initSession(ctx.cwd);
    } catch {
      state = undefined;
    }
  });

  pi.on("session_shutdown", () => {
    state = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const s = state;
    if (!s) return;
    try {
      await ensureSelector(s, ctx);
      const next = await runTurn(s, event.systemPrompt, event.prompt, ctx.signal);
      return next === undefined ? undefined : { systemPrompt: next };
    } catch {
      return; // Leave the system prompt exactly as it arrived.
    }
  });

  pi.registerCommand("memory", {
    description: "Inspect the memory system (list, why, budget, dry-run, doctor)",
    getArgumentCompletions: (prefix) => {
      const subs = ["list", "why", "budget", "dry-run", "doctor"];
      const hits = subs.filter((sub) => sub.startsWith(prefix));
      return hits.length > 0 ? hits.map((sub) => ({ value: sub, label: sub })) : null;
    },
    handler: async (args, ctx) => {
      const s = state;
      if (!s) {
        await show(ctx, ["Memory is disabled (config `enabled: false` or PI_MEMORY_DISABLED)."]);
        return;
      }
      const trimmed = args.trim();
      const sub = trimmed.split(/\s+/)[0] ?? "";
      const rest = trimmed.slice(sub.length).trim();
      switch (sub) {
        case "list":
          rescan(s);
          await show(ctx, renderList(s));
          return;
        case "why":
          await show(ctx, renderWhy(s));
          return;
        case "budget":
          rescan(s);
          await show(ctx, renderBudget(s));
          return;
        case "dry-run":
          await ensureSelector(s, ctx);
          await show(ctx, await renderDryRun(s, rest, ctx.signal));
          return;
        case "doctor":
          await show(ctx, renderDoctor(s));
          return;
        default:
          await show(ctx, USAGE);
      }
    },
  });
}
